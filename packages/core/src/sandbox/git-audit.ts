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
 *
 * What is not a sandboxed command's is not undone. The baseline is taken
 * again when a command of the session that ran outside the sandbox has
 * ended, and nothing is checked while one runs. A change found before a
 * command while no sandboxed command runs is the user's where nothing
 * sandboxed outlives its command (Linux): it becomes the baseline, with a
 * note. Where a process can (macOS), a valid repository is not moved but
 * reported, and anything else is undone as before.
 */
import { lstatSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs"
import { dirname, join } from "node:path"
import { brand } from "../brand.ts"
import { type GitLayout, gitLayout, validGitLayout } from "./git.ts"
import { readGitFile } from "./git-file.ts"
import { type Inspection, inspectRepository } from "./git-inspect.ts"

export interface GitFinding {
  readonly message: string
  readonly violation: boolean
}

/** A session's watch over one workspace's Git metadata. */
export interface GitWatch {
  /** Checks the baseline again and guards it while the command runs. Returns the check for when the command has ended. */
  readonly begin: () => Promise<() => Promise<GitFinding | null>>
  /** Whether a sandboxed command of this watch runs now. */
  readonly busy: () => boolean
  /**
   * A command of the session runs outside the sandbox from now: nothing is
   * checked or restored while it runs, and the baseline is taken again once
   * it has ended. Call the returned function then.
   */
  readonly outside: () => () => Promise<void>
}

export interface GitWatchOptions {
  /** How often the metadata is checked while a command runs. Default `GUARD_INTERVAL_MS`. */
  readonly intervalMs?: number
  /** Whether a sandboxed process can outlive its command here (macOS, through `setsid`). Default: everywhere but Linux. */
  readonly survivors?: boolean
  /** Whether a sandboxed command that is not this watch's runs now: one of another working directory or session. */
  readonly othersRunning?: () => boolean
  /** Instead of `MAX_SCANNED_DIRECTORIES`, for a test. */
  readonly maxDirectories?: number
}

/** How often the metadata is checked while a command runs. */
export const GUARD_INTERVAL_MS = 250
/** How many replaced entries are kept for inspection while commands run. Later ones are still undone, but removed. */
export const MAX_KEPT_RESTORES = 8
/** How many findings one command's output lists. */
export const MAX_LINES_PER_COMMAND = 12

const STILL_HAPPENING = `Sandbox violation: a sandboxed command keeps changing Git's metadata. ${brand.name} still undoes each change, but after the first ${MAX_KEPT_RESTORES}, kept for inspection, it removes the replacements instead of keeping them. Stop the session's background commands and inspect .git before using Git.`
const UNLISTED = "Further Git findings for this command are not listed."

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
function keptAside(path: string) {
  const saved = join(mkdtempSync(join(dirname(path), `.${brand.directory}-review-`)), "metadata")
  renameSync(path, saved)
  return saved
}

/** A chain that runs its work one at a time. */
function chain() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(work: () => T | Promise<T>): Promise<T> => {
    const next = tail.then(work, work)
    tail = next.catch(() => {})
    return next
  }
}

/**
 * One check or restore at a time for each workspace, across every watch of this process: two sessions of one
 * workspace must not both restore the same entry. Only the structural check holds it, never an inspection.
 */
const workspaces = new Map<string, ReturnType<typeof chain>>()
function lockedWorkspace<T>(root: string, work: () => T | Promise<T>): Promise<T> {
  let lock = workspaces.get(root)
  if (lock === undefined) workspaces.set(root, (lock = chain()))
  return lock(work)
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

/** Whether the metadata is not what the baseline holds, by anything. Checks only, changes nothing. */
function drifted(base: Baseline, layout: GitLayout | null, now: GitLayout | null): boolean {
  if (now?.workTree !== layout?.workTree || now?.gitDir !== layout?.gitDir || now?.commonDir !== layout?.commonDir) return true
  if (identity(base.root) !== base.rootId || identity(base.entry) !== base.entryId) return true
  if (base.checkCommon && base.common !== null && identity(base.common) !== null) return true
  if (base.pointer === null) return false
  try {
    return !base.pointer.equals(readGitFile(base.entry, 65536) ?? Buffer.alloc(0))
  } catch {
    return true
  }
}

/**
 * The structural part of the check: cheap enough to run while a command
 * runs. Restores what it can and says so; throws for what it cannot. With
 * `keep` false a replaced entry is removed instead of kept, and not listed.
 */
function checkStructure(base: Baseline, layout: GitLayout | null, keep: boolean): { readonly lines: Line[]; readonly restored: number } {
  const lines: Line[] = []
  let restored = 0
  const setAside = (path: string) => {
    if (keep) return keptAside(path)
    rmSync(path, { recursive: true, force: true })
    return null
  }
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
    restored++
    if (keep) lines.push({
      violation: true,
      text: `Sandbox violation: a sandboxed command changed .git. Restored its original ${base.entryId === null ? "absence" : "location"}.${saved ? ` Inspect the metadata saved at ${saved} before using Git.` : ""}`,
    })
  }
  if (base.checkCommon && base.common !== null && layout) {
    if (realpathSync(layout.commonDir) !== layout.commonDir || identity(layout.commonDir) !== base.commonId)
      throw new Error("the Git common directory changed. Inspect the repository before using Git")
    if (identity(base.common) !== null) {
      const saved = setAside(base.common)
      restored++
      if (saved !== null) lines.push({ violation: true, text: `Sandbox violation: a sandboxed command created Git's commondir pointer. Restored its absence. Inspect the entry saved at ${saved}.` })
    }
  }
  if (base.valid && layout && (!validGitLayout(layout) || gitLayout(root)?.gitDir !== layout.gitDir)) throw new Error("the Git metadata pointers changed. Inspect .git before using Git")
  return { lines, restored }
}

/** Adds `line` to one command's findings: once, and at most `MAX_LINES_PER_COMMAND` of them, the last saying that more were not listed. */
function report(sink: Line[], line: Line) {
  if (sink.some((other) => other.text === line.text)) return
  if (sink.length < MAX_LINES_PER_COMMAND - 1) return void sink.push(line)
  const unlisted = sink.findIndex((other) => other.text === UNLISTED)
  if (unlisted === -1) sink.push({ text: UNLISTED, violation: line.violation })
  else if (line.violation) sink[unlisted] = { text: UNLISTED, violation: true }
}

/**
 * The watch of one session over the workspace at `cwd`, whose repository
 * is `layout` when the watch is made. Its baseline is taken by the first
 * `begin`.
 */
export function gitWatch(cwd: string, initial: GitLayout | null, options: GitWatchOptions = {}): GitWatch {
  const survivors = options.survivors ?? process.platform !== "linux"
  const limits = options.maxDirectories === undefined ? {} : { maxDirectories: options.maxDirectories }
  let layout = initial
  let base: Baseline | null = null
  let broken: string | null = null
  /** Whether the user was told that the last inspection was not complete, and none has been since. */
  let incompleteTold = false
  /** Replaced entries undone since nothing of the session last ran. */
  let restores = 0
  /** Commands of the session that run outside the sandbox now. */
  let outsideRunning = 0
  const running = new Set<Line[]>()
  let guard: { readonly timer: ReturnType<typeof setInterval>; readonly watcher: FSWatcher | null } | null = null
  /** The inspection is read-only and can take a while: it runs on a chain of its own, and never holds up the guard. */
  const inspecting = chain()
  const workspace = () => base?.root ?? cwd

  /** Every check reports to each command running when it ran. A change that cannot be undone is reported once, and the baseline taken again. */
  const structure = (sinks: readonly Line[][]) =>
    lockedWorkspace(workspace(), () => {
      if (base === null || outsideRunning > 0) return
      let found: Line[]
      try {
        const keep = restores < MAX_KEPT_RESTORES
        const checked = checkStructure(base, layout, keep)
        restores += checked.restored
        found = !keep && checked.restored > 0 ? [...checked.lines, { violation: true, text: STILL_HAPPENING }] : checked.lines
      } catch (error) {
        found = [{ violation: true, text: `Git safety check failed: ${error instanceof Error ? error.message : String(error)}.` }]
        broken = found[0]!.text
      }
      for (const sink of sinks) for (const line of found) report(sink, line)
    })

  /** Once per stretch of inspections that were not complete: each command still tries again, and reports what it found. */
  const incomplete = (sinks: readonly Line[][], text: string) => {
    if (incompleteTold) return
    incompleteTold = true
    for (const sink of sinks) report(sink, { violation: false, text })
  }

  /**
   * `baseline`: what is there now is the starting point. `idle`: before a command, while nothing sandboxed ran
   * since the last check. `command`: a sandboxed command ran, or runs.
   */
  const inspect = (sinks: readonly Line[][], mode: "baseline" | "idle" | "command") =>
    inspecting(async () => {
      const taken = base
      if (taken === null || outsideRunning > 0) return
      let now: Inspection
      try {
        now = await inspectRepository(taken.root, taken.index, undefined, limits)
      } catch (error) {
        // The commands still run: a check that cannot be made is said once, not turned into a failure of every command.
        incomplete(sinks, `Git warning: ${brand.name} could not inspect this workspace for nested repositories and gitlinks (${error instanceof Error ? error.message : String(error)}). It tries again with every command. Inspect any new nested repository before running Git.`)
        return
      }
      if (now.partial === null) incompleteTold = false
      else
        incomplete(sinks, `Git warning: ${brand.name} inspected this workspace for nested repositories only in part (${now.partial}). It still reports every gitlink in the index and the nested repositories it reached, and tries again with every command; a command can cause this by creating many directories. Inspect any new nested repository before running Git.`)
      const before = taken.nested
      // A partial result forgets nothing: what the walk did not reach this time is not reported again when it does.
      taken.nested = now.partial === null || before === null ? now.entries : new Set([...before, ...now.entries])
      if (before === null || mode === "baseline" || (mode === "idle" && !survivors)) return
      const added = [...now.entries].filter((entry) => !before.has(entry))
      if (added.length === 0) return
      const entries = added.slice(0, 8).join(", ") + (added.length > 8 ? ` and ${added.length - 8} more` : "")
      const cause = mode === "idle" ? `${entries} appeared since the session's last command ended (a process a sandboxed command left running may have made it, or you did)` : `a sandboxed command introduced ${entries}`
      const warning = `Git warning: ${cause}. Your own root git status can execute configuration from a nested repository outside the sandbox. Inspect its Git metadata before running Git.`
      for (const sink of sinks) report(sink, { violation: false, text: warning })
    })

  /**
   * Before a command, while nothing sandboxed runs: a change since the last check is the user's where nothing
   * sandboxed outlives its command, and becomes the baseline. Elsewhere only a valid repository does, with a
   * warning; anything else is left to the structural check, which undoes it.
   */
  const between = (lines: Line[]) =>
    lockedWorkspace(workspace(), () => {
      if (base === null) return
      const now = gitLayout(cwd)
      if (!drifted(base, layout, now)) return
      if (survivors && (now === null || !validGitLayout(now))) return
      let fresh: Baseline
      try {
        fresh = capture(cwd, now)
      } catch {
        return
      }
      fresh.nested = base.nested
      base = fresh
      layout = now
      report(lines, {
        violation: false,
        text: survivors
          ? `Git warning: the workspace's Git repository changed since the session's last command ended. A process a sandboxed command left running may have done it, or you did: ${brand.name} keeps it as it is. Inspect .git before using Git if you did not make this change.`
          : `Git note: the workspace's Git metadata changed outside the sandbox since the session's last command. ${brand.name} now checks commands against it as it is.`,
      })
    })

  /** After a command outside the sandbox: what is there now is the starting point. */
  const rebaseline = async () => {
    if (base === null && broken === null) return
    await lockedWorkspace(workspace(), () => {
      layout = gitLayout(cwd)
      try {
        base = capture(cwd, layout)
        broken = null
      } catch (error) {
        broken = `Git safety check failed: ${error instanceof Error ? error.message : String(error)}.`
      }
    })
    // The pointers to watch may be others now.
    if (guard !== null) {
      stopGuard()
      startGuard()
    }
    await inspect([], "baseline")
  }

  let ticking = false
  const startGuard = () => {
    if (guard !== null || base === null) return
    const tick = () => {
      // One check at a time: a tick that finds one still running skips.
      if (ticking) return
      ticking = true
      void structure([...running]).finally(() => (ticking = false))
    }
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
    busy: () => running.size > 0,
    outside: () => {
      outsideRunning++
      let ended = false
      return async () => {
        if (ended) return
        ended = true
        if (--outsideRunning === 0) await rebaseline()
      }
    },
    begin: async () => {
      const lines: Line[] = []
      const idle = running.size === 0 && outsideRunning === 0 && !(options.othersRunning?.() ?? false)
      if (idle) restores = 0
      if (base === null || broken !== null) {
        // After a change that could not be undone and was reported, the workspace as it is now is the baseline.
        if (broken !== null) layout = gitLayout(cwd)
        try {
          base = capture(cwd, layout)
        } catch (error) {
          report(lines, { violation: true, text: `Git safety check failed: ${error instanceof Error ? error.message : String(error)}.` })
        }
        broken = null
        await inspect([lines], "baseline")
      } else {
        // What changed since the last command ended, by anything: a process that outlived its command included.
        if (idle) await between(lines)
        await structure([lines])
        await inspect([lines], idle ? "idle" : "command")
      }
      running.add(lines)
      startGuard()
      return async () => {
        running.delete(lines)
        if (running.size === 0) stopGuard()
        await structure([lines])
        await inspect([lines], "command")
        return finding(lines)
      }
    },
  }
}

/** One command's check with a baseline of its own, taken now. */
export function auditGit(cwd: string, layout: GitLayout | null): Promise<() => Promise<GitFinding | null>> {
  return gitWatch(cwd, layout).begin()
}
