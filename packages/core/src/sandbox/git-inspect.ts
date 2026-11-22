/** Inspect a workspace without asking its repository, submodules or configured drivers to run anything. */
import { type Stats, lstatSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { brand } from "../brand.ts"
import { readGitFile } from "./git-file.ts"
import { isDotGit } from "./git-name.ts"
import { runGit } from "../snapshot/git.ts"

const MAX_INDEX_BYTES = 64 * 1024 * 1024
/** How many untracked directories one inspection walks before it gives up: a check after every command must stay cheap. */
export const MAX_SCANNED_DIRECTORIES = 20_000

/** Snapshot ls-files lists an untracked repository as a directory, without visiting its work tree. */
export const nestedDirectories = (entries: readonly string[]) => entries.filter((name) => name.endsWith("/")).map((name) => name.slice(0, -1))

/**
 * Git replaces an index atomically. Copy just the regular file we opened, even if the name changes again.
 * The copy keeps the index's modification time: Git compares it with each entry's to tell which entries it
 * must hash again (a file rewritten in the second it was staged, with the same size). A fresh time would make
 * Git trust those entries and miss the change.
 */
export function copyGitIndex(source: string, target: string): void {
  const read: { stat?: Stats } = {}
  const bytes = readGitFile(source, MAX_INDEX_BYTES, (stat) => (read.stat = stat))
  if (bytes === null) return
  writeFileSync(target, bytes)
  // Milliseconds: never later than the original, so Git hashes again at least the entries it would have.
  if (read.stat) utimesSync(target, read.stat.atime, read.stat.mtime)
}

/** What one inspection found, and why it is not complete when it is not. */
export interface Inspection {
  readonly entries: Set<string>
  /**
   * `null`: every untracked directory was walked. Otherwise why the walk
   * stopped. The gitlinks are always all there (they come from the index),
   * and so are the nested repositories the walk reached before it stopped.
   */
  readonly partial: string | null
}

/**
 * The nested repositories and gitlinks of a workspace, or an error when not
 * all could be checked. For a caller that must refuse what it cannot check.
 */
export async function repositoryEntries(
  workTree: string,
  sourceIndex?: string,
  indexDirectory = sourceIndex && dirname(sourceIndex),
  limits: { readonly maxDirectories?: number } = {},
): Promise<Set<string>> {
  const found = await inspectRepository(workTree, sourceIndex, indexDirectory, limits)
  if (found.partial !== null) throw new Error(found.partial)
  return found.entries
}

/**
 * The private repository keeps ls-files away from the workspace's config, attributes and hooks.
 * Throws only when the index cannot be listed at all; a walk that runs out of budget is a partial result.
 */
export async function inspectRepository(
  workTree: string,
  sourceIndex?: string,
  indexDirectory = sourceIndex && dirname(sourceIndex),
  limits: { readonly maxDirectories?: number } = {},
): Promise<Inspection> {
  const nested = new Set<string>()
  const max = limits.maxDirectories ?? MAX_SCANNED_DIRECTORIES
  let budget = max
  let partial: string | null = null
  /**
   * Walk only real directories, breadth first across all the starting points: a deep or wide directory cannot
   * keep the walk from the shallow ones. Treat both a gitfile and a .git directory as a repository boundary,
   * under any name a filesystem reads as .git.
   */
  async function scan(starts: readonly string[]): Promise<void> {
    const pending = [...starts]
    for (let next = 0; next < pending.length; next++) {
      if (--budget < 0) {
        partial = `the workspace has more than ${max} untracked directories to inspect`
        return
      }
      const dir = pending[next]!
      const entries = await readdir(join(workTree, dir), { withFileTypes: true })
      if (dir !== "." && (lstatSync(join(workTree, dir, ".git"), { throwIfNoEntry: false }) || entries.some((entry) => isDotGit(entry.name)))) {
        nested.add(`nested repository ${JSON.stringify(dir)}`)
        continue
      }
      for (const entry of entries) if (entry.isDirectory() && !isDotGit(entry.name)) pending.push(join(dir, entry.name))
    }
  }
  if (!sourceIndex) {
    await scan(["."])
    return { entries: nested, partial }
  }
  const gitDir = mkdtempSync(join(tmpdir(), `${brand.directory}-inspect-`))
  try {
    mkdirSync(join(gitDir, "objects"))
    mkdirSync(join(gitDir, "refs"))
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/inspection\n")
    copyGitIndex(sourceIndex, join(gitDir, "index"))
    const context = { git: "git", gitDir, baseEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }
    const read = () => runGit(context, ["ls-files", "-z", "-t", "--stage", "--others", "--directory", "--exclude-standard"], {
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
    // The staged entries first: what they say is in hand whatever the walk below costs.
    const checked = new Set<string>(["."])
    for (const entry of entries) {
      const staged = /^[A-Z] (\d{6}) [0-9a-f]+ [0-3]\t([\s\S]+)$/.exec(entry)
      if (!staged) continue
      const path = staged[2]!
      const components = path.split("/")
      if (components.some((name) => !name || name === "." || name === ".." || isDotGit(name))) {
        // Git refuses to check such a path out; on another filesystem it would write into .git.
        nested.add(`unsafe index path ${JSON.stringify(path)}`)
        continue
      }
      if (staged[1] === "160000") nested.add(`gitlink ${JSON.stringify(path)}`)
      else components.pop()
      // Tracked directories do not appear in the collapsed untracked listing.
      let dir = "."
      for (const part of components) {
        dir = join(dir, part)
        if (checked.has(dir)) continue
        if (!lstatSync(join(workTree, dir), { throwIfNoEntry: false })?.isDirectory()) break
        checked.add(dir)
        if (lstatSync(join(workTree, dir, ".git"), { throwIfNoEntry: false })) nested.add(`nested repository ${JSON.stringify(dir)}`)
      }
    }
    const untracked = entries.filter((entry) => entry.startsWith("? ")).map((entry) => entry.slice(2))
    await scan(nestedDirectories(untracked))
    return { entries: nested, partial }
  } finally {
    rmSync(gitDir, { recursive: true, force: true })
  }
}
