/**
 * A git worktree for a subagent that must not edit the files its parent (or
 * its siblings) are editing, and the merge of what it did back into the
 * parent's workspace.
 *
 * What is done to the user's repository, and what is not:
 *
 * - The worktree starts from the parent's workspace as it is now, uncommitted
 *   changes and untracked files included (not ignored ones): that state is
 *   written as one commit on a new branch, built with a private index, so
 *   the user's index, branches, HEAD and stash are not touched. The branch
 *   (`<binary>/subagent-<id>`) and the worktree directory (outside the
 *   repository) are the harness's own.
 * - The merge back changes files in the parent's working directory and
 *   nothing else: no commit, no index change, no branch moved. Every file the
 *   child changed is merged three ways (the branch's start, the child's
 *   result, the file as it is now in the parent's workspace). All results are
 *   computed first; if one file conflicts nothing is written, the branch is
 *   kept, and the conflict is reported with what to do. So the workspace is
 *   either merged or exactly as it was, never half merged.
 * - No hook of the repository runs for any of it (`core.hooksPath` is
 *   overridden per command), and nothing is signed or pushed.
 * - When the work is merged, or had nothing to merge, the worktree and the
 *   branch are removed. After a conflict or a failure the worktree is removed
 *   and the branch stays, with the child's work committed on it.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { brand } from "../brand.ts"
import { type GitLayout, gitLayout, validGitLayout } from "../sandbox/git.ts"
import { copyGitIndex, repositoryEntries } from "../sandbox/git-inspect.ts"
import { type FileVersion, mergeComponents, versionOnDisk, writeVersion } from "./merge-files.ts"
import type { WorktreeRecord } from "../event/durable.ts"

export interface GitResult {
  readonly code: number
  readonly stdout: Uint8Array
  readonly stderr: string
}

export interface Repository extends GitLayout {
  readonly identity: string
}

/** The repository a session actually opened. Never run discovery through Git or accept a different directory later. */
export function repositoryAt(cwd: string): Repository | null {
  const layout = gitLayout(cwd)
  if (!layout || !validGitLayout(layout)) return null
  try {
    const identity = [join(layout.workTree, ".git"), layout.gitDir, layout.commonDir].map((path) => {
      const { dev, ino } = lstatSync(path, { bigint: true })
      return `${dev}:${ino}`
    }).join("/")
    return { ...layout, identity }
  } catch {
    return null
  }
}

const GIT_OPTIONS = [
  "core.hooksPath=/dev/null", "core.fsmonitor=false", "core.sshCommand=false", "diff.external=",
  "protocol.allow=never", "submodule.recurse=false", "commit.gpgsign=false", "tag.gpgsign=false",
  `user.name=${brand.name}`, "user.email=subagent@localhost", "core.quotePath=false", "gc.auto=0", "maintenance.auto=false",
  "diff.ignoreSubmodules=all", "status.submoduleSummary=false",
].flatMap((value) => ["-c", value])

/**
 * How long one Git command of Windlass's own may run. Staging a large
 * workspace takes seconds; a command that takes minutes is waiting on
 * something (a lock, a stalled filesystem) and is stopped, with the reason.
 */
export const gitLimits = { timeoutMs: 5 * 60 * 1000 }

const unsafeKey = /^(?:filter\.|diff\..+\.(?:textconv|command)$|merge\..+\.driver$|include(?:if)?\.|core\.(?:worktree|alternaterefscommand)$)/is

const changedRepository = "the repository's git directory or its pointers changed; check .git and commondir before using this worktree"
const stillPinned = (repo: Repository) => repositoryAt(repo.workTree)?.identity === repo.identity
const refused = (stderr: string): GitResult => ({ code: 128, stderr, stdout: new Uint8Array() })

/** `checked`, for a test: called after the checks, right before Git runs, as something running beside it could act there. */
async function git(repo: Repository, args: readonly string[], options: { readonly index?: string; readonly checked?: () => void } = {}): Promise<GitResult> {
  if (!stillPinned(repo)) return refused(changedRepository)
  const env = {
    PATH: process.env.PATH, LC_ALL: "C", HOME: "/dev/null", XDG_CONFIG_HOME: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_DIR: repo.gitDir, GIT_COMMON_DIR: repo.commonDir, GIT_WORK_TREE: repo.workTree, GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", ...(options.index ? { GIT_INDEX_FILE: options.index } : {}),
  }
  try {
    // Read the keys as Git parses them, without expanding includes. A driver named in attributes can have any name.
    const keys = await run(["config", "--no-includes", "--null", "--name-only", "--list"])
    if (keys.code !== 0) return refused("git could not read the repository configuration")
    if (new TextDecoder().decode(keys.stdout).split("\0").some((key) => unsafeKey.test(key)))
      return refused("the repository config names an include, external driver or work tree; run the subagent in the shared workspace")
    if (["add", "status", "commit"].includes(args[0]!)) {
      const nested = await repositoryEntries(repo.workTree, options.index ?? join(repo.gitDir, "index"), repo.gitDir)
      if (nested.size) return refused(`the workspace contains ${[...nested].join(", ")}. Inspect it before using a subagent worktree.`)
    }
    options.checked?.()
    return await run(args)
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error))
  }

  async function run(command: readonly string[]): Promise<GitResult> {
    // Its own process group, so that a stop reaches whatever Git started and nothing keeps the pipes open.
    const child = Bun.spawn(["git", ...GIT_OPTIONS, ...command], { cwd: repo.workTree, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true })
    const seconds = gitLimits.timeoutMs / 1000
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }, gitLimits.timeoutMs)
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited])
      if (timedOut) throw new Error(`git ${command[0]} did not finish within ${seconds} seconds and was stopped. Check for a stale lock in the repository or a slow filesystem, then try again`)
      return { code, stdout: new Uint8Array(stdout), stderr }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * After staging: a nested repository that appeared between the check and the
 * staging became a gitlink. Staging a new one runs nothing in it, but every
 * later Git command that compares the work tree would ask it for its status.
 */
async function stagedGitlinks(repo: Repository, index: string): Promise<string | null> {
  const listed = await git(repo, ["ls-files", "--stage", "-z"], { index })
  if (listed.code !== 0) return lastLine(listed)
  const links = new TextDecoder().decode(listed.stdout).split("\0").filter((entry) => entry.startsWith("160000 ")).map((entry) => entry.slice(entry.indexOf("\t") + 1))
  return links.length === 0 ? null : `the workspace contains ${links.slice(0, 8).map((path) => `gitlink ${JSON.stringify(path)}`).join(", ")}. Inspect it before using a subagent worktree.`
}

const text = (result: GitResult) => new TextDecoder().decode(result.stdout).trim()
const lastLine = (result: GitResult) => result.stderr.trim().split("\n").at(-1) ?? `git exited with ${result.code}`

/** The branch a subagent's worktree is on. */
export function worktreeBranch(childId: string): string {
  return `${brand.binary}/subagent-${childId.replace(/[^A-Za-z0-9_-]/g, "").slice(-12)}`
}

/**
 * Creates the worktree at `directory` on a new branch that starts from the
 * workspace as it stands. Returns the record, with `path` the directory in
 * the worktree that corresponds to `cwd`, or why there is none.
 */
export async function createWorktree(input: { readonly cwd: string; readonly directory: string; readonly branch: string; readonly parent: Repository | null; readonly probe?: (point: "staging") => void }): Promise<{ readonly worktree: WorktreeRecord; readonly cwd: string } | { readonly error: string }> {
  const repository = input.parent
  if (!repository) return { error: "the working directory is not in a git repository, so a subagent cannot get a worktree of its own. Run it without `worktree`: it then shares this workspace." }
  const head = await git(repository, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
  if (head.code > 1) return { error: lastLine(head) }
  if (head.code !== 0) return { error: "the repository has no commit yet, so there is nothing a worktree could start from. Run the subagent without `worktree`." }
  // The workspace as it is now, as a tree, through an index of our own: the user's index is only copied, never written.
  const scratch = mkdtempSync(join(tmpdir(), `${brand.directory}-worktree-`))
  try {
    const index = join(scratch, "index")
    const source = join(repository.gitDir, "index")
    try {
      copyGitIndex(source, index)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
    const added = await git(repository, ["add", "-A", "--ignore-errors", "."], { index, checked: () => input.probe?.("staging") })
    if (added.code !== 0 && added.code !== 1) return { error: `the workspace could not be recorded for the worktree: ${lastLine(added)}` }
    const linked = await stagedGitlinks(repository, index)
    if (linked !== null) return { error: linked }
    const tree = await git(repository, ["write-tree"], { index })
    if (tree.code !== 0) return { error: `the workspace could not be recorded for the worktree: ${lastLine(tree)}` }
    const same = text(await git(repository, ["rev-parse", "HEAD^{tree}"])) === text(tree)
    const base = same ? head : await git(repository, ["commit-tree", text(tree), "-p", text(head), "-m", `${brand.name}: the workspace a subagent started from`])
    if (base.code !== 0) return { error: `the workspace could not be recorded for the worktree: ${lastLine(base)}` }
    mkdirSync(dirname(input.directory), { recursive: true })
    // What a failed or stopped `worktree add` may leave is removed, but never what was there before it.
    const branchBefore = (await git(repository, ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}`])).code === 0
    const directoryBefore = existsSync(input.directory)
    const made = await git(repository, ["worktree", "add", "--quiet", "-b", input.branch, input.directory, text(base)])
    if (made.code !== 0) {
      // A stop part way leaves a locked entry under .git/worktrees and the new branch: the next attempt would fail on both.
      if (!directoryBefore) {
        await git(repository, ["worktree", "remove", "--force", "--force", input.directory])
        rmSync(input.directory, { recursive: true, force: true })
        unlockAbandoned(repository, input.directory)
        await git(repository, ["worktree", "prune"])
      }
      if (!branchBefore) await git(repository, ["branch", "-D", "--quiet", input.branch])
      return { error: `git could not create the worktree: ${lastLine(made)}` }
    }
    const inside = relative(repository.workTree, await realPath(input.cwd))
    return {
      worktree: { path: input.directory, branch: input.branch, base: text(base), repository: repository.workTree },
      cwd: inside === "" || inside.startsWith("..") ? input.directory : join(input.directory, inside),
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * A `worktree add` stopped before it wrote the worktree's gitfile leaves its
 * entry locked, which `worktree prune` skips. Unlock the entry that names
 * `directory`, gone now, so that prune removes it.
 */
function unlockAbandoned(repository: Repository, directory: string) {
  const registry = join(repository.commonDir, "worktrees")
  const names = (() => {
    try {
      return readdirSync(registry)
    } catch {
      return []
    }
  })()
  for (const name of names) {
    try {
      const entry = join(registry, name)
      const named = readFileSync(join(entry, "gitdir"), "utf8").trim()
      if (resolve(named) === join(directory, ".git") && !existsSync(directory)) rmSync(join(entry, "locked"), { force: true })
    } catch {
      // An entry without a readable gitdir is not this one, or is left for the user: `git worktree prune` reports it.
    }
  }
}

async function realPath(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises")
  return realpath(path).catch(() => resolve(path))
}

export interface MergeOutcome {
  /** `merged`: the files were written. `conflicts`: nothing was written. `nothing`: the child changed no file. `failed`: git failed; nothing was written. */
  readonly status: "merged" | "conflicts" | "nothing" | "failed"
  readonly branch: string
  /** The commit the child's work is on, when there is one. */
  readonly commit: string | null
  /** Every file the child changed, relative to the repository. */
  readonly files: readonly string[]
  readonly conflicts: readonly string[]
  /** Whether the branch still exists: after a conflict or a failure, so the work is not lost. */
  readonly kept: boolean
  /** One or two sentences for the model: what happened and what it can do. */
  readonly message: string
}

/**
 * Commits whatever the worktree holds onto its branch. Returns the tip, or
 * `null` with the reason. It stages through a private copy of the worktree's
 * index: the index is checked for gitlinks, and nothing the subagent left
 * running can add one to the copy afterwards, which `git add` would then
 * ask for its status (running that repository's configured programs).
 */
async function commitWork(worktree: WorktreeRecord, parent: Repository, message: string, probe?: (point: "staging") => void): Promise<{ readonly tip: string } | { readonly error: string }> {
  if (!existsSync(worktree.path)) {
    const tip = await git(parent, ["rev-parse", "--verify", "--quiet", `refs/heads/${worktree.branch}`])
    return tip.code === 0 ? { tip: text(tip) } : { error: `the worktree ${worktree.path} and its branch are gone` }
  }
  const child = repositoryAt(worktree.path)
  if (!stillPinned(parent)) return { error: changedRepository }
  if (!child || child.commonDir !== parent.commonDir || child.gitDir === child.commonDir || child.gitDir === parent.gitDir || child.workTree !== await realPath(worktree.path))
    return { error: "the subagent's worktree no longer points back to its repository" }
  const scratch = mkdtempSync(join(tmpdir(), `${brand.directory}-commit-`))
  try {
    const index = join(scratch, "index")
    copyGitIndex(join(child.gitDir, "index"), index)
    const added = await git(child, ["add", "-A", "."], { index, checked: () => probe?.("staging") })
    if (added.code !== 0) return { error: lastLine(added) }
    const linked = await stagedGitlinks(child, index)
    if (linked !== null) return { error: linked }
    const tree = await git(child, ["write-tree"], { index })
    if (tree.code !== 0) return { error: lastLine(tree) }
    const head = await git(child, ["rev-parse", "--verify", "HEAD^{commit}"])
    if (head.code !== 0) return { error: lastLine(head) }
    const headTree = await git(child, ["rev-parse", "HEAD^{tree}"])
    if (headTree.code !== 0) return { error: lastLine(headTree) }
    if (text(headTree) === text(tree)) return { tip: text(head) }
    const commit = await git(child, ["commit-tree", text(tree), "-p", text(head), "-m", message])
    if (commit.code !== 0) return { error: lastLine(commit) }
    // HEAD is the worktree's branch: moved only from the commit it was on.
    const moved = await git(child, ["update-ref", "-m", message, "HEAD", text(commit), text(head)])
    return moved.code === 0 ? { tip: text(commit) } : { error: lastLine(moved) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Removes the worktree directory and, unless it is kept, its branch. Never throws: what cannot be removed is left. */
export async function removeWorktree(worktree: WorktreeRecord, parent: Repository, options: { readonly keepBranch: boolean }): Promise<void> {
  if (existsSync(worktree.path)) {
    const removed = await git(parent, ["worktree", "remove", "--force", worktree.path])
    if (removed.code !== 0) return
  }
  await git(parent, ["worktree", "prune"])
  if (!options.keepBranch) await git(parent, ["branch", "-D", "--quiet", worktree.branch])
}

/**
 * For a subagent that will not finish (it was lost to a restart, or
 * stopped): what it had done is committed onto its branch, the worktree is
 * removed, and the branch is kept when it holds work, so nothing is lost and
 * nothing is merged.
 */
export async function salvageWorktree(worktree: WorktreeRecord, parent: Repository, title: string): Promise<MergeOutcome> {
  const work = await commitWork(worktree, parent, `${brand.name} subagent (unfinished): ${title}`)
  if ("error" in work) throw new Error(work.error)
  const tip = work.tip
  const holdsWork = tip !== worktree.base
  await removeWorktree(worktree, parent, { keepBranch: holdsWork })
  return {
    status: "nothing",
    branch: worktree.branch,
    commit: holdsWork ? tip : null,
    files: [],
    conflicts: [],
    kept: holdsWork,
    message: holdsWork ? `What it had done so far is on branch ${worktree.branch} (commit ${tip.slice(0, 12)}); nothing was merged into this workspace.` : "It had changed no file.",
  }
}

/**
 * The file at `path` in `commit`, or `null` when there is none. A merge
 * writes regular files and symlinks only: a gitlink, a directory (a file
 * that became one) or any other entry is refused, never read as an absence.
 */
async function versionAt(repository: Repository, commit: string, path: string): Promise<FileVersion | null> {
  const listed = await git(repository, ["--literal-pathspecs", "ls-tree", "-z", commit, "--", path])
  if (listed.code !== 0) throw new Error(lastLine(listed))
  const entry = new TextDecoder().decode(listed.stdout).replace(/\0$/, "")
  if (entry === "") return null
  const match = /^(100644|100755|120000) blob ([0-9a-f]+)\t/.exec(entry)
  if (match === null) {
    const kind = entry.startsWith("160000 ") ? "a gitlink" : entry.startsWith("040000 ") ? "a directory" : `a Git entry of mode ${entry.slice(0, 6)}`
    throw new Error(`${JSON.stringify(path)} is ${kind} in commit ${commit.slice(0, 12)}; a merge writes only regular files and symlinks`)
  }
  const blob = await git(repository, ["cat-file", "blob", match[2]!])
  if (blob.code !== 0) throw new Error(lastLine(blob))
  return { bytes: blob.stdout, mode: match[1]! }
}

const same = (a: FileVersion | null, b: FileVersion | null) =>
  a === null || b === null ? a === b : a.mode === b.mode && a.bytes.length === b.bytes.length && Buffer.compare(a.bytes, b.bytes) === 0

/** The merges in progress, by repository: one at a time into one working tree. */
const merging = new Map<string, Promise<unknown>>()

/**
 * Merges the child's work into the parent's workspace and cleans up. `probe`
 * is called between computing the merge and writing the first file (a crash
 * test dies there, and after the first file).
 *
 * Merges into one repository run one after the other: each reads the working
 * tree as the one before it left it. Two subagents that finish at the same
 * moment would otherwise both merge against the same state, and the second
 * to write would undo the first.
 */
export function mergeWorktree(worktree: WorktreeRecord, parent: Repository, input: { readonly title: string; readonly probe?: (point: "staging" | "computed" | "writing") => void }): Promise<MergeOutcome> {
  const turn = (merging.get(worktree.repository) ?? Promise.resolve()).then(() => mergeNow(worktree, parent, input))
  const settled = turn.catch(() => {})
  merging.set(worktree.repository, settled)
  void settled.then(() => {
    if (merging.get(worktree.repository) === settled) merging.delete(worktree.repository)
  })
  return turn
}

async function mergeNow(worktree: WorktreeRecord, parent: Repository, input: { readonly title: string; readonly probe?: (point: "staging" | "computed" | "writing") => void }): Promise<MergeOutcome> {
  const base = { branch: worktree.branch, files: [] as string[], conflicts: [] as string[] }
  const failed = async (reason: string): Promise<MergeOutcome> => {
    await removeWorktree(worktree, parent, { keepBranch: true })
    return { ...base, status: "failed", commit: null, kept: true, message: `Its work could not be merged into this workspace (${reason}); nothing was changed here. It is on branch ${worktree.branch}.` }
  }
  const work = await commitWork(worktree, parent, `${brand.name} subagent: ${input.title}`, input.probe)
  if ("error" in work) throw new Error(work.error)
  const tip = work.tip
  if (tip === worktree.base) {
    await removeWorktree(worktree, parent, { keepBranch: false })
    return { ...base, status: "nothing", commit: null, kept: false, message: "It changed no file, so there was nothing to merge." }
  }
  const listed = await git(parent, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--no-renames", worktree.base, tip])
  if (listed.code !== 0) return failed(lastLine(listed))
  const files = new TextDecoder("utf-8", { fatal: true }).decode(listed.stdout).split("\0").filter((path) => path !== "")
  const writes: { readonly path: string; readonly previous: FileVersion | null; readonly result: FileVersion | null }[] = []
  const conflicts: string[] = []
  const scratch = mkdtempSync(join(tmpdir(), `${brand.directory}-merge-`))
  try {
    for (const path of files) mergeComponents(path)
    for (const path of files) {
      const [origin, theirs] = await Promise.all([versionAt(parent, worktree.base, path), versionAt(parent, tip, path)])
      const ours = versionOnDisk(parent.workTree, path)
      if (same(ours, theirs)) continue
      // The parent did not touch it since the branch started: the child's version is the result.
      if (same(ours, origin)) {
        writes.push({ path, previous: ours, result: theirs })
        continue
      }
      // Both changed it. Text merges line by line; a deletion on one side, a link, or a file with no common start does not.
      if (ours === null || theirs === null || origin === null || [ours, theirs, origin].some((version) => version.mode === "120000")) {
        conflicts.push(path)
        continue
      }
      const names = ["ours", "base", "theirs"].map((name) => join(scratch, name))
      ;[ours, origin, theirs].forEach((version, index) => writeFileSync(names[index]!, version.bytes))
      const merged = await git(parent, ["merge-file", "-p", names[0]!, names[1]!, names[2]!])
      if (merged.code !== 0) conflicts.push(path)
      else writes.push({ path, previous: ours, result: { bytes: merged.stdout, mode: theirs.mode === origin.mode ? ours.mode : theirs.mode } })
    }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  if (conflicts.length > 0) {
    await removeWorktree(worktree, parent, { keepBranch: true })
    return {
      ...base,
      status: "conflicts",
      commit: tip,
      files,
      conflicts,
      kept: true,
      message: `Its work was NOT merged: ${conflicts.length === 1 ? `${conflicts[0]} was` : `${conflicts.length} files were`} also changed in this workspace since it started, and the changes conflict (${conflicts.join(", ")}). Nothing was changed here. Its work is commit ${tip.slice(0, 12)} on branch ${worktree.branch}: look at it with \`git diff ${worktree.base.slice(0, 12)} ${tip.slice(0, 12)} -- <file>\` and apply what is needed by hand.`,
    }
  }
  input.probe?.("computed")
  let written = 0
  try {
    if (!stillPinned(parent)) return failed(changedRepository)
    for (const { path, previous } of writes) {
      if (!same(versionOnDisk(parent.workTree, path), previous)) return failed(`the merge target changed: ${path}`)
    }
    for (const { path, previous, result } of writes) {
      writeVersion(parent.workTree, path, previous, result)
      if (++written === 1) input.probe?.("writing")
    }
  } catch (error) {
    return {
      ...base, status: "failed", commit: tip, files, kept: true,
      message: `The merge stopped after ${written} completed writes (${error instanceof Error ? error.message : String(error)}). Inspect the workspace before retrying. Its work is on branch ${worktree.branch}.`,
    }
  }
  await removeWorktree(worktree, parent, { keepBranch: false })
  return {
    ...base,
    status: "merged",
    commit: tip,
    files,
    kept: false,
    message: `Its changes to ${files.length} file${files.length === 1 ? "" : "s"} were merged into this workspace (${files.slice(0, 8).join(", ")}${files.length > 8 ? ", ..." : ""}); nothing was committed.`,
  }
}
