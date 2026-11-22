/** Inspect a workspace without asking its repository, submodules or configured drivers to run anything. */
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { brand } from "../brand.ts"
import { readGitFile } from "./git-file.ts"
import { runGit } from "../snapshot/git.ts"

const MAX_INDEX_BYTES = 64 * 1024 * 1024

/** Snapshot ls-files lists an untracked repository as a directory, without visiting its work tree. */
export const nestedDirectories = (entries: readonly string[]) => entries.filter((name) => name.endsWith("/")).map((name) => name.slice(0, -1))

/** Git replaces an index atomically. Copy just the regular file we opened, even if the name changes again. */
export function copyGitIndex(source: string, target: string): void {
  const bytes = readGitFile(source, MAX_INDEX_BYTES)
  if (bytes !== null) writeFileSync(target, bytes)
}

/** The private repository keeps ls-files away from the workspace's config, attributes and hooks. */
export async function repositoryEntries(workTree: string, sourceIndex?: string, indexDirectory = sourceIndex && dirname(sourceIndex)): Promise<Set<string>> {
  const nested = new Set<string>()
  // Walk only real directories. Treat both a gitfile and a .git directory as a repository boundary.
  async function scan(start: string): Promise<void> {
    const pending = [start]
    while (pending.length) {
      const dir = pending.pop()!
      const entries = await readdir(join(workTree, dir), { withFileTypes: true })
      if (dir !== "." && entries.some((entry) => entry.name.toLowerCase() === ".git")) {
        nested.add(`nested repository ${JSON.stringify(dir)}`)
        continue
      }
      for (const entry of entries) if (entry.isDirectory() && entry.name.toLowerCase() !== ".git") pending.push(join(dir, entry.name))
    }
  }
  if (!sourceIndex) {
    await scan(".")
    return nested
  }
  const gitDir = mkdtempSync(join(tmpdir(), `${brand.directory}-inspect-`))
  try {
    mkdirSync(join(gitDir, "objects"))
    mkdirSync(join(gitDir, "refs"))
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/inspection\n")
    copyGitIndex(sourceIndex, join(gitDir, "index"))
    const context = { git: "git", gitDir, baseEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }
    const read = () => runGit(context, ["ls-files", "-z", "-t", "--stage", "--others", "--directory"], {
      cwd: workTree, workTree, maxStdout: 64 * 1024 * 1024, okCodes: [0, 128],
    })
    async function list() {
      const found = await read()
      if (found.exitCode !== 0 && indexDirectory) {
        // A split index names a shared index by its content hash. Git looks beside the private copy.
        const missing = /\/sharedindex\.([0-9a-f]{40}|[0-9a-f]{64}): index file open failed/.exec(found.stderr)
        if (missing) {
          const name = `sharedindex.${missing[1]}`
          copyGitIndex(join(indexDirectory, name), join(gitDir, name))
          return read()
        }
      }
      return found
    }
    let found = await list()
    if (found.exitCode !== 0) {
      // The index has no field naming its hash algorithm. Let Git read a SHA-256 index in that format.
      writeFileSync(join(gitDir, "config"), "[core]\nrepositoryformatversion = 1\n[extensions]\nobjectFormat = sha256\n")
      found = await list()
    }
    if (found.truncated || found.exitCode !== 0) throw new Error("Git could not safely list the workspace index and untracked files")
    const entries = new TextDecoder("utf-8", { fatal: true }).decode(found.stdout).split("\0").filter(Boolean)
    const untracked = entries.filter((entry) => entry.startsWith("? ")).map((entry) => entry.slice(2))
    for (const directory of nestedDirectories(untracked)) await scan(directory)
    // Tracked directories do not appear in the collapsed untracked listing.
    const checked = new Set<string>(["."])
    for (const entry of entries) {
      const staged = /^[A-Z] (\d{6}) [0-9a-f]+ [0-3]\t([\s\S]+)$/.exec(entry)
      if (!staged) continue
      const path = staged[2]!
      const components = path.split("/")
      if (components.some((name) => !name || name === "." || name === ".." || name.toLowerCase() === ".git"))
        throw new Error("the Git index contains an unsafe path")
      if (staged[1] === "160000") nested.add(`gitlink ${JSON.stringify(path)}`)
      else components.pop()
      let dir = "."
      for (const part of components) {
        dir = join(dir, part)
        if (checked.has(dir)) continue
        if (!lstatSync(join(workTree, dir), { throwIfNoEntry: false })?.isDirectory()) break
        checked.add(dir)
        if (lstatSync(join(workTree, dir, ".git"), { throwIfNoEntry: false })) nested.add(`nested repository ${JSON.stringify(dir)}`)
      }
    }
    return nested
  } finally {
    rmSync(gitDir, { recursive: true, force: true })
  }
}
