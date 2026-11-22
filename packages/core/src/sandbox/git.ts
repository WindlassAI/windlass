/** Repository layout and the mounts needed to keep Git's metadata pointers stable during a command. */
import { linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { readGitFile } from "./git-file.ts"
import { brand } from "../brand.ts"

export interface GitLayout {
  readonly workTree: string
  /** The directory `.git` is, or points to (a linked worktree's own directory under the main repository's). */
  readonly gitDir: string
  /** Where objects, refs, hooks and the configuration are: `gitDir`, or the main repository's for a worktree. */
  readonly commonDir: string
}

/** The git directory of the repository `cwd` is in, found the way git finds it: `.git` here or in the nearest parent. */
export function gitLayout(cwd: string): GitLayout | null {
  for (let dir = canonicalDirectory(cwd); ; dir = dirname(dir)) {
    const entry = join(dir, ".git")
    const info = entryOrNull(entry)
    if (info && !info.isFile()) return { workTree: dir, gitDir: entry, commonDir: entry }
    if (info?.isFile()) {
      // A worktree or a submodule: `.git` is a file naming the real directory.
      const named = /^gitdir: ([^\r\n]+)$/.exec(readOrNull(entry)?.trimEnd() ?? "")?.[1]
      if (!named) return { workTree: dir, gitDir: entry, commonDir: entry }
      const gitDir = resolve(dir, named)
      const common = readOrNull(join(gitDir, "commondir"))?.trim()
      return { workTree: dir, gitDir, commonDir: common ? resolve(gitDir, common) : gitDir }
    }
    if (dirname(dir) === dir) return null
  }
}

/** True for an ordinary git directory or a linked worktree with Git's matching pair of pointers. */
export function validGitLayout(git: GitLayout): boolean {
  const entry = join(git.workTree, ".git")
  const commonFile = join(git.gitDir, "commondir")
  try {
    if (realpathSync(entry) !== entry || realpathSync(git.gitDir) !== git.gitDir || realpathSync(git.commonDir) !== git.commonDir) return false
    if (!lstatSync(git.gitDir).isDirectory() || !lstatSync(join(git.commonDir, "objects")).isDirectory() || !lstatSync(join(git.gitDir, "HEAD")).isFile()) return false
    for (const path of [join(git.commonDir, "config"), join(git.commonDir, "config.worktree"), join(git.gitDir, "config.worktree")]) {
      const file = lstatSync(path, { throwIfNoEntry: false })
      if (file && !file.isFile()) return false
    }
    const pointer = lstatSync(commonFile, { throwIfNoEntry: false })
    const common = pointer ? readOrNull(commonFile)?.trim() : null
    if (pointer && (!pointer.isFile() || !common || resolve(git.gitDir, common) !== git.commonDir)) return false
    if (entry !== git.gitDir && !lstatSync(entry).isFile()) return false
    if (git.gitDir === git.commonDir) return !pointer || common === "."
    const back = join(git.gitDir, "gitdir")
    return dirname(git.gitDir) === join(git.commonDir, "worktrees") && lstatSync(back).isFile() && resolve(git.gitDir, readOrNull(back)?.trim() ?? "") === entry
  } catch {
    return false
  }
}

/** Publish a complete bind target without truncating a file another session or Git already created. */
function reserveFile(path: string, contents: string) {
  if (lstatSync(path, { throwIfNoEntry: false })) return
  const scratch = mkdtempSync(join(dirname(path), `.${brand.directory}-bind-`))
  try {
    const file = join(scratch, "file")
    writeFileSync(file, contents)
    try {
      linkSync(file, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export function gitProtection(git: GitLayout): { directories: string[]; parents: string[]; files: string[] } {
  const entry = join(git.workTree, ".git")
  const directories = [...new Set([git.commonDir, git.gitDir])]
  // If metadata cannot be pinned, keep it read-only. Never widen access to a directory named by an invalid pointer.
  const closed = { directories: [], parents: [], files: [entry, ...directories] }
  if (!validGitLayout(git)) return { ...closed, files: [entryOrNull(entry)?.isSymbolicLink() ? git.workTree : entry] }
  // An uncorroborated gitfile may name another repository. Its contents alone cannot grant writes there.
  const fromTree = relative(git.workTree, git.gitDir)
  if (entry !== git.gitDir && git.commonDir === git.gitDir && (fromTree === ".." || fromTree.startsWith("../"))) return closed
  const hooks = directories.map((dir) => join(dir, "hooks"))
  const modules = join(git.commonDir, "modules")
  const registry = join(git.commonDir, "worktrees")
  const common = join(git.commonDir, "commondir")
  const configs = directories.flatMap((dir) => [join(dir, "config"), join(dir, "config.worktree")])
  try {
    // A missing directory could be created under another case of its name on a volume that ignores case (macOS):
    // these exist on every platform. Linux also needs every bind target to exist; Seatbelt denies a missing file by name.
    for (const dir of [...hooks, modules, registry]) mkdirSync(dir, { recursive: true })
    if (process.platform === "linux") for (const config of configs) reserveFile(config, "")
    const files = [...hooks, modules, ...configs, common]
    if (entry !== git.gitDir) files.push(entry)
    if (git.gitDir !== git.commonDir) files.push(join(git.gitDir, "commondir"), join(git.gitDir, "gitdir"))
    if (![...files, registry].every((path) => !lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) || !validGitLayout(git)) return closed
    return { directories, parents: [registry], files }
  } catch {
    return closed
  }
}

function entryOrNull(path: string) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function readOrNull(path: string) {
  try {
    return readGitFile(path, 65536)?.toString("utf8") ?? null
  } catch {
    return null
  }
}

function canonicalDirectory(cwd: string) {
  try {
    return realpathSync(cwd)
  } catch {
    return resolve(cwd)
  }
}
