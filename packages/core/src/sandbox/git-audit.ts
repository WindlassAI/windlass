/**
 * The check of a workspace's Git metadata around sandboxed commands.
 *
 * One baseline per session and workspace, taken before the session's first
 * sandboxed command and carried across all later ones: a process that
 * outlived its command (one that left its process group) cannot make its
 * changes part of the next command's starting point. The baseline is checked
 * again before every command, every `GUARD_INTERVAL_MS` while any command of
 * the session runs (a background one included), at once when Git's
 * `commondir` pointer appears beside a common directory that had none, and
 * after every command.
 *
 * What the mounts or Seatbelt could not stop is undone where it can be: a
 * replaced `.git` gets its original back and a new `commondir` is set aside,
 * both kept for inspection. New nested repositories and gitlinks are only
 * reported, once each.
 */
import { lstatSync, mkdtempSync, readdirSync, realpathSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs"
import { dirname, join } from "node:path"
import { brand } from "../brand.ts"
import { type GitLayout, gitLayout, validGitLayout } from "./git.ts"
import { readGitFile } from "./git-file.ts"
import { repositoryEntries } from "./git-inspect.ts"

export interface GitFinding {
  readonly message: string
  readonly violation: boolean
}

/** A session's watch over one workspace's Git metadata. */
export interface GitWatch {
  /** Checks the baseline again and guards it while the command runs. Returns the check for when the command has ended. */
  readonly begin: () => Promise<() => Promise<GitFinding | null>>
}

/** How often the metadata is checked while a command runs. */
export const GUARD_INTERVAL_MS = 250

interface Line {
  readonly text: string
  readonly violation: boolean
}

interface Baseline {
  readonly root: string
  readonly rootId: string | null
  readonly entry: string
  /** Updated when Windlass itself writes the entry back. */
  entryId: string | null
  readonly valid: boolean
  readonly pointer: Buffer | null
  readonly common: string | null
  readonly checkCommon: boolean
  readonly commonId: string | null
  readonly index: string | undefined
  /** What was there when last checked; `null` until an inspection succeeded. */
  nested: Set<string> | null
}

function identity(path: string) {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false })
  return stat ? `${stat.dev}:${stat.ino}` : null
}

/** Move an unexpected entry intact, on its own filesystem, without following it or deleting its contents. */
function setAside(path: string) {
  const saved = join(mkdtempSync(join(dirname(path), `.${brand.directory}-review-`)), "metadata")
  renameSync(path, saved)
  return saved
}

/** One at a time across every watch of this process: two sessions of one workspace must not both restore the same entry. */
let serial: Promise<unknown> = Promise.resolve()
function serialized<T>(work: () => T | Promise<T>): Promise<T> {
  const next = serial.then(work, work)
  serial = next.catch(() => {})
  return next
}

function capture(cwd: string, layout: GitLayout | null): Baseline {
  const root = layout?.workTree ?? realpathSync(cwd)
  const entry = join(root, ".git")
  const valid = layout !== null && validGitLayout(layout)
  const common = valid ? join(layout.commonDir, "commondir") : null
  return {
    root,
    rootId: identity(root),
    entry,
    entryId: identity(entry),
    valid,
    pointer: valid && layout.gitDir !== entry ? readGitFile(entry, 65536) : null,
    common,
    checkCommon: common !== null && identity(common) === null,
    commonId: valid ? identity(layout.commonDir) : null,
    index: valid ? join(layout.gitDir, "index") : undefined,
    nested: null,
  }
}

/**
 * The structural part of the check: cheap enough to run while a command
 * runs. Restores what it can and says so; throws for what it cannot.
 */
function checkStructure(base: Baseline, layout: GitLayout | null): Line[] {
  const lines: Line[] = []
  const { root, entry } = base
  if (identity(root) !== base.rootId || realpathSync(root) !== root) throw new Error("the workspace directory changed. Inspect its original location")
  const replaced = identity(entry) !== base.entryId
  let samePointer = true
  if (!replaced && base.pointer !== null) {
    try {
      samePointer = base.pointer.equals(readGitFile(entry, 65536) ?? Buffer.alloc(0))
    } catch {
      samePointer = false
    }
  }
  if (replaced || !samePointer) {
    // Mounts and Seatbelt protect existing entries. Also recover a moved original if the backend failed to pin it.
    const moved = !replaced || base.entryId === null ? undefined : readdirSync(root).find((name) => identity(join(root, name)) === base.entryId)
    const saved = identity(entry) === null ? null : setAside(entry)
    if (moved !== undefined) renameSync(join(root, moved), entry)
    else if (base.pointer !== null) writeFileSync(entry, base.pointer, { flag: "wx" })
    else if (base.entryId !== null) throw new Error(`the original .git could not be located${saved ? `. Replacement saved at ${saved}` : ""}`)
    base.entryId = identity(entry)
    lines.push({
      violation: true,
      text: `Sandbox violation: a sandboxed command changed .git. Restored its original ${base.entryId === null ? "absence" : "location"}.${saved ? ` Inspect the metadata saved at ${saved} before using Git.` : ""}`,
    })
  }
  if (base.checkCommon && base.common !== null && layout) {
    if (realpathSync(layout.commonDir) !== layout.commonDir || identity(layout.commonDir) !== base.commonId)
      throw new Error("the Git common directory changed. Inspect the repository before using Git")
    if (identity(base.common) !== null) {
      const saved = setAside(base.common)
      lines.push({ violation: true, text: `Sandbox violation: a sandboxed command created Git's commondir pointer. Restored its absence. Inspect the entry saved at ${saved}.` })
    }
  }
  if (base.valid && layout && (!validGitLayout(layout) || gitLayout(root)?.gitDir !== layout.gitDir)) throw new Error("the Git metadata pointers changed. Inspect .git before using Git")
  return lines
}

/**
 * The watch of one session over the workspace at `cwd`, whose repository
 * is `layout` when the watch is made. Its baseline is taken by the first
 * `begin`.
 */
export function gitWatch(cwd: string, initial: GitLayout | null, options: { readonly intervalMs?: number } = {}): GitWatch {
  let layout = initial
  let base: Baseline | null = null
  let broken: string | null = null
  let inspectionWarned = false
  const running = new Set<Line[]>()
  let guard: { readonly timer: ReturnType<typeof setInterval>; readonly watcher: FSWatcher | null } | null = null

  /** Every check reports to each command running when it ran. A change that cannot be undone is reported once, and the baseline taken again. */
  const structure = (lines: Line[][]) =>
    serialized(() => {
      if (base === null) return
      let found: Line[]
      try {
        found = checkStructure(base, layout)
      } catch (error) {
        found = [{ violation: true, text: `Git safety check failed: ${error instanceof Error ? error.message : String(error)}.` }]
        broken = found[0]!.text
      }
      for (const sink of lines) sink.push(...found)
    })

  const inspect = (lines: Line[][]) =>
    serialized(async () => {
      // Once it could not be made, it is not tried again for every command: the walk that failed is what costs.
      if (base === null || inspectionWarned) return
      let now: Set<string>
      try {
        now = await repositoryEntries(base.root, base.index)
      } catch (error) {
        // The commands still run: a check that cannot be made is said once, not turned into a failure of every command.
        inspectionWarned = true
        const warning = `Git warning: Windlass could not inspect this workspace for nested repositories and gitlinks (${error instanceof Error ? error.message : String(error)}), so it does not warn about new ones in this session. Inspect any new nested repository before running Git.`
        for (const sink of lines) sink.push({ violation: false, text: warning })
        return
      }
      const before = base.nested
      base.nested = now
      if (before === null) return
      const added = [...now].filter((entry) => !before.has(entry))
      if (added.length === 0) return
      const entries = added.slice(0, 8).join(", ") + (added.length > 8 ? ` and ${added.length - 8} more` : "")
      const warning = `Git warning: a sandboxed command introduced ${entries}. Your own root git status can execute configuration from a nested repository outside the sandbox. Inspect its Git metadata before running Git.`
      for (const sink of lines) sink.push({ violation: false, text: warning })
    })

  const startGuard = () => {
    if (guard !== null || base === null) return
    const tick = () => void structure([...running])
    const timer = setInterval(tick, options.intervalMs ?? GUARD_INTERVAL_MS)
    timer.unref?.()
    let watcher: FSWatcher | null = null
    // Linux cannot bind a file that does not exist: a new commondir is set aside the moment it appears.
    if (base.checkCommon && layout) {
      try {
        watcher = watch(layout.commonDir, { persistent: false }, (_event, name) => {
          if (name === "commondir") tick()
        })
        watcher.on("error", () => {})
      } catch {
        watcher = null
      }
    }
    guard = { timer, watcher }
  }
  const stopGuard = () => {
    if (guard === null) return
    clearInterval(guard.timer)
    guard.watcher?.close()
    guard = null
  }

  const finding = (lines: readonly Line[]): GitFinding | null => {
    const unique = lines.filter((line, index) => lines.findIndex((other) => other.text === line.text) === index)
    return unique.length === 0 ? null : { violation: unique.some((line) => line.violation), message: unique.map((line) => line.text).join("\n") }
  }

  return {
    begin: async () => {
      const lines: Line[] = []
      if (base === null || broken !== null) {
        // After a change that could not be undone and was reported, the workspace as it is now is the baseline.
        if (broken !== null) layout = gitLayout(cwd)
        try {
          base = capture(cwd, layout)
        } catch (error) {
          lines.push({ violation: true, text: `Git safety check failed: ${error instanceof Error ? error.message : String(error)}.` })
        }
        broken = null
        await inspect([lines])
      } else {
        // What changed since the last command ended, by anything: a process that outlived its command included.
        await structure([lines])
        await inspect([lines])
      }
      running.add(lines)
      startGuard()
      return async () => {
        running.delete(lines)
        if (running.size === 0) stopGuard()
        await structure([lines])
        await inspect([lines])
        return finding(lines)
      }
    },
  }
}

/** One command's check with a baseline of its own, taken now. */
export function auditGit(cwd: string, layout: GitLayout | null): Promise<() => Promise<GitFinding | null>> {
  return gitWatch(cwd, layout).begin()
}
