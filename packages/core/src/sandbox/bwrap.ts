/**
 * Linux backend: bubblewrap. The command runs in new user, pid, ipc, uts and
 * cgroup namespaces (plus net when the network is off) on a read-only view of
 * the host, with the writable roots bound back read-write, a private /tmp, a
 * fresh /proc (only the sandbox's own processes) and a minimal /dev. With a
 * home of its own (`policy.home`) the command also writes under its home
 * directory, into a directory that is not the user's (`homeArgs`).
 *
 * Process lifetime:
 * - No `--new-session`: every sandboxed process stays in the caller's process
 *   group, so `kill(-pgid)` reaches all of them. The caller spawns detached
 *   (setsid), which also leaves the sandbox without a controlling terminal, so
 *   TIOCSTI injection (the reason `--new-session` exists) has no target.
 * - `--die-with-parent` and the pid namespace: when bwrap or its parent dies,
 *   or the command (pid 2 under bwrap's init) exits, the kernel SIGKILLs every
 *   process left in the namespace, including ones that called setsid.
 * - bwrap itself would die on SIGTERM and take the sandbox down at once, so it
 *   is started through `env --ignore-signal` and the command through
 *   `env --default-signal`: a group SIGTERM reaches only the command and its
 *   descendants, which get the caller's grace period before SIGKILL.
 */
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { brand } from "../brand.ts"
import type { SandboxHome, SandboxPolicy } from "./policy.ts"

export interface BwrapOptions {
  readonly bwrapPath: string
  /** GNU env supporting --ignore-signal/--default-signal, or null to skip the signal trampoline. */
  readonly envPath: string | null
  /** An empty file with mode 000 to bind over hidden files. Default: one per user under the temp directory. */
  readonly maskFile?: string
}

const TRAMPOLINE_SIGNALS = "TERM,INT,HUP"
/** Read-only system paths when `readRest` is false. */
const SYSTEM_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/opt", "/nix", "/run/systemd/resolve"]

/** The full argv (bwrap first, the command last) that runs `command` in `cwd` under `policy`. */
export function bwrapArgv(policy: SandboxPolicy, command: readonly string[], cwd: string, options: BwrapOptions): string[] {
  const hidden = outermost(policy.hiddenPaths.map(existingRealpath).filter((path) => path !== null))
  const args = [
    "--die-with-parent",
    "--unshare-user-try",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    ...(policy.network.mode === "off" ? ["--unshare-net"] : []),
    ...readArgs(policy),
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    // Before the writable roots, so roots under /tmp are bound on top of it.
    ...(policy.tempRoot ? ["--bind", existingRealpath(policy.tempRoot) ?? policy.tempRoot, "/tmp"] : ["--tmpfs", "/tmp"]),
    // Before the writable roots as well: a workspace inside the home is bound on top of it.
    ...(policy.home ? homeArgs(policy.home, hidden) : []),
    ...policy.writableRoots.flatMap((root) => {
      const real = existingRealpath(root)
      return real ? ["--bind", real, real] : []
    }),
    // After the writable roots, so they are read-only inside them. A file is bound too: replacing it by rename then fails.
    ...(policy.readOnlyPaths ?? []).flatMap((path) => {
      const real = existingRealpath(path)
      return real ? ["--ro-bind", real, real] : []
    }),
    // Last, so they cover anything above, including paths inside writable roots.
    ...hidden.flatMap((path) => hideArgs(path, options)),
    "--chdir",
    cwd,
  ]
  const inner = options.envPath ? [options.envPath, `--default-signal=${TRAMPOLINE_SIGNALS}`, ...command] : [...command]
  const outer = options.envPath ? [options.envPath, `--ignore-signal=${TRAMPOLINE_SIGNALS}`, options.bwrapPath] : [options.bwrapPath]
  return [...outer, ...args, "--", ...inner]
}

function readArgs(policy: SandboxPolicy) {
  if (policy.readRest) return ["--ro-bind", "/", "/"]
  return [...SYSTEM_PATHS, ...(policy.readableRoots ?? [])].flatMap((path) => {
    const stat = lstatOrNull(path)
    if (!stat) return []
    // Merged-/usr systems: /bin -> usr/bin must stay a symlink, or binaries resolve twice.
    if (stat.isSymbolicLink() && SYSTEM_PATHS.includes(path)) return ["--symlink", readlinkSync(path), path]
    const real = existingRealpath(path)
    return real ? ["--ro-bind", real, real] : []
  })
}

/**
 * How many of the user's entries the command's home shows, each by a bind of
 * its own. bwrap reads the whole mount table after every bind, so its start
 * takes time with the square of their number: about 50 ms more for 130
 * entries and 0.1 s for this many, measured with bubblewrap 0.9.0.
 */
export const HOME_BINDS = 200

/**
 * The command's own home. A directory of `home.root` is bound at the home's
 * path, and every entry of the user's home is bound read-only at its own name
 * inside it: the command reads what the user has there as before and can
 * change none of it, and what it adds beside those entries is written to
 * `home.root`. A shared directory (`.config`, `.cache`) is a directory of
 * `home.root` as well, bound at its place whether or not the user has one,
 * with the user's entries bound one level down, because a directory bound
 * read-only as a whole takes no new entry.
 *
 * Each of these directories is kept apart in `home.root` (`home`, and
 * `shared/<its path>`) and is a mount of its own in the sandbox. A command
 * can therefore not rename or replace one, in its own sandbox or in another
 * of the same session that is running, and `home.root` itself is mounted
 * nowhere. So the mount points and the copies of the user's symbolic links,
 * which are made here and not by bwrap, are always made in a directory whose
 * path a command had no part in: a link a command planted cannot send them
 * elsewhere. Only binds are used, so this works with a bubblewrap that has no
 * overlay options. A hidden entry gets its mount point and no bind:
 * `hideArgs` then covers an empty stand-in, not the user's entry.
 *
 * The home's own entries come first, then the shared directories. One whose
 * entries no longer fit in `HOME_BINDS` stays the user's, read-only as a
 * whole; a home whose own entries do not fit is left as it is, and the
 * command gets no home of its own.
 */
function homeArgs(home: SandboxHome, hidden: readonly string[]): string[] {
  const path = existingRealpath(home.path)
  const root = existingRealpath(home.root)
  // `/` as a home, or one that holds a directory mounted above, cannot be replaced without replacing that as well.
  if (path === null || root === null || ["/tmp", "/dev", "/proc"].some((mounted) => mounted === path || mounted.startsWith(path === "/" ? "/" : `${path}/`))) return []
  const args: string[] = []
  let shown = 0
  const layered = [""]
  for (const directory of layered) {
    const names = namesIn(join(path, directory))
    if (shown + names.length > HOME_BINDS) {
      if (directory === "") return []
      args.push("--ro-bind", join(path, directory), join(path, directory))
      shown += 1
      continue
    }
    const own = directory === "" ? join(root, "home") : join(root, "shared", encodeURIComponent(directory))
    mkdirSync(own, { recursive: true })
    args.push("--bind", own, join(path, directory))
    const shared = home.shared.filter((entry) => dirname(entry) === (directory === "" ? "." : directory))
    for (const name of names) {
      const entry = join(directory, name)
      const source = join(path, entry)
      const info = lstatOrNull(source)
      if (info === null || (info.isDirectory() && shared.includes(entry))) continue
      if (info.isSymbolicLink()) copyLink(source, join(own, name))
      else if (hidden.includes(source)) standIn(join(own, name), info.isDirectory())
      else if (mountPoint(join(own, name), info.isDirectory())) {
        args.push("--ro-bind", source, source)
        shown += 1
      }
    }
    for (const entry of shared) {
      // The user's directory of that name, or none: a link or a file of that name was an entry like any other above.
      if (lstatOrNull(join(path, entry))?.isDirectory() !== false && mountPoint(join(own, basename(entry)), true)) layered.push(entry)
    }
  }
  return args
}

/** A mount point for a hidden entry. What the command made under a credential store's name gives way to it. */
function standIn(path: string, directory: boolean) {
  if (mountPoint(path, directory)) return
  rmSync(path, { recursive: true, force: true })
  mountPoint(path, directory)
}

/**
 * Makes `path` what a directory or a file can be mounted on, and says whether
 * it is. Something else of the command's own under that name stays (the
 * user's entry is then not shown), unless it is empty: a mount point left
 * from an entry the user has since replaced by one of the other kind.
 */
function mountPoint(path: string, directory: boolean): boolean {
  const info = lstatOrNull(path)
  if (info !== null && (directory ? info.isDirectory() : info.isFile())) return true
  try {
    if (info?.isDirectory()) rmdirSync(path)
    else if (info?.isFile() && info.size === 0) unlinkSync(path)
    else if (info !== null) return false
    if (directory) mkdirSync(path)
    else writeFileSync(path, "", { flag: "wx" })
    return true
  } catch {
    return false
  }
}

/** The user's symbolic link `source` as the same link at `own`, unless the command put something there that is not a link. */
function copyLink(source: string, own: string) {
  try {
    const target = readlinkSync(source)
    const info = lstatOrNull(own)
    if (info?.isSymbolicLink() && readlinkSync(own) !== target) unlinkSync(own)
    else if (info !== null) return
    symlinkSync(target, own)
  } catch {
    // The link is then missing in the command's home, as an entry that could not be read is.
  }
}

function namesIn(directory: string): string[] {
  try {
    return readdirSync(directory).sort()
  } catch {
    return []
  }
}

/** A directory becomes an empty mode-000 tmpfs; anything else (file, socket) is covered by the mode-000 mask file. */
function hideArgs(real: string, options: BwrapOptions) {
  if (statSync(real).isDirectory()) return ["--perms", "0000", "--tmpfs", real]
  return ["--ro-bind", options.maskFile ?? processMaskFile(), real]
}

/** Drops duplicates and paths inside another hidden path: mounting them would recreate their parents inside the mask. */
function outermost(paths: string[]) {
  const unique = [...new Set(paths)]
  return unique.filter((path) => !unique.some((other) => other !== path && (path.startsWith(`${other}/`) || other === "/")))
}

let maskFile: string | null = null

/**
 * bwrap can only create files inside the sandbox from a file descriptor, so a
 * hidden file is covered by binding this host file over it. Mode 000 and no
 * capabilities inside the sandbox make every open fail with EACCES (a
 * /dev/null bind would read as empty instead of failing).
 *
 * One stable file per user (`<tmp>/<brand>-sandbox-<uid>/hidden`), so nothing
 * accumulates and nothing needs cleaning up. The directory is only trusted
 * when it is ours, a real directory and private; otherwise a fresh private
 * directory is used.
 */
function processMaskFile() {
  if (maskFile && isMask(maskFile)) return maskFile
  const uid = process.getuid?.() ?? 0
  const stable = join(tmpdir(), `${brand.directory}-sandbox-${uid}`)
  ignoreExists(() => mkdirSync(stable, { mode: 0o700 }))
  const dirStat = lstatOrNull(stable)
  const dir = dirStat?.isDirectory() && dirStat.uid === uid && (dirStat.mode & 0o077) === 0 ? stable : mkdtempSync(join(tmpdir(), `${brand.directory}-sandbox-`))
  const file = join(dir, "hidden")
  if (lstatOrNull(file) && !isMask(file)) rmSync(file, { force: true })
  // Mode 0 at creation (the umask can only remove bits), so the file is never readable, even briefly.
  ignoreExists(() => writeFileSync(file, "", { mode: 0o000, flag: "wx" }))
  maskFile = file
  return file
}

function isMask(path: string) {
  const stat = lstatOrNull(path)
  return stat !== null && stat.isFile() && stat.size === 0 && (stat.mode & 0o777) === 0 && stat.uid === (process.getuid?.() ?? 0)
}

function ignoreExists(create: () => void) {
  try {
    create()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
}

function existingRealpath(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}
