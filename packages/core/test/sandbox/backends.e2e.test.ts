/** The generated bwrap argv and Seatbelt profile, checked as text. No process is spawned. */
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type SandboxPolicy, defaultPolicy, sandboxCommand, seatbeltProfile } from "../../src/sandbox/index.ts"
import { HOME_BINDS, bwrapArgv } from "../../src/sandbox/bwrap.ts"
import { removeTempDirs, tempDir } from "./helpers.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

afterEach(removeTempDirs)

function layout() {
  const root = realpathSync(tempDir("args"))
  const workspace = join(root, "ws")
  mkdirSync(join(workspace, "secret-dir"), { recursive: true })
  writeFileSync(join(workspace, "secret-file"), "")
  symlinkSync(join(workspace, "secret-dir"), join(root, "link-to-secret"))
  const policy: SandboxPolicy = {
    writableRoots: [workspace, join(root, "missing")],
    readRest: true,
    hiddenPaths: [join(workspace, "secret-dir"), join(workspace, "secret-dir", "nested"), join(workspace, "secret-file"), join(root, "link-to-secret"), join(root, "absent")],
    network: { mode: "off" },
    env: { mode: "deny" },
  }
  return { root, workspace, policy }
}

const options = { bwrapPath: "/usr/bin/bwrap", envPath: "/usr/bin/env", maskFile: "/mask" }

describe("bwrap argv", () => {
  test("namespaces, mounts in order, hidden paths last, command behind the signal trampoline", () => {
    const l = layout()
    const argv = bwrapArgv(l.policy, ["bash", "-c", "make"], l.workspace, options)
    expect(argv).toEqual([
      "/usr/bin/env",
      "--ignore-signal=TERM,INT,HUP",
      "/usr/bin/bwrap",
      "--die-with-parent",
      "--unshare-user-try",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup-try",
      "--unshare-net",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--bind",
      l.workspace,
      l.workspace,
      // the symlinked duplicate and the nested path collapse into one mask; the missing paths are skipped
      "--perms",
      "0000",
      "--tmpfs",
      join(l.workspace, "secret-dir"),
      "--ro-bind",
      "/mask",
      join(l.workspace, "secret-file"),
      "--chdir",
      l.workspace,
      "--",
      "/usr/bin/env",
      "--default-signal=TERM,INT,HUP",
      "bash",
      "-c",
      "make",
    ])
    expect(argv).not.toContain("--new-session")
  })

  test("network on keeps the host network; a temp root replaces the private /tmp", () => {
    const l = layout()
    const tempRoot = join(l.root, "tmp")
    mkdirSync(tempRoot)
    const argv = bwrapArgv({ ...l.policy, network: { mode: "on" }, tempRoot }, ["true"], l.workspace, options)
    expect(argv).not.toContain("--unshare-net")
    expect(argv.join(" ")).toContain(`--bind ${tempRoot} /tmp`)
    expect(argv).not.toContain("--tmpfs /tmp")
  })

  test("without GNU env the command runs directly under bwrap", () => {
    const l = layout()
    const argv = bwrapArgv(l.policy, ["true"], l.workspace, { ...options, envPath: null })
    expect(argv[0]).toBe("/usr/bin/bwrap")
    expect(argv.slice(argv.indexOf("--"))).toEqual(["--", "true"])
  })

  test("readRest off binds only system paths and readable roots, keeping merged-/usr symlinks", () => {
    const l = layout()
    const argv = bwrapArgv({ ...l.policy, readRest: false, readableRoots: [l.root] }, ["true"], l.workspace, options)
    expect(argv.join(" ")).not.toContain("--ro-bind / /")
    expect(argv.join(" ")).toContain("--ro-bind /usr /usr")
    expect(argv.join(" ")).toContain(`--ro-bind ${l.root} ${l.root}`)
  })
})

describe("bwrap argv for a home of the command's own", () => {
  /** A user's home with a credential store, settings, a cache and links, a workspace inside it, and the directory that takes the command's writes. */
  function homeLayout() {
    const root = realpathSync(tempDir("home-args"))
    const home = join(root, "home")
    const own = join(root, "session.home")
    const workspace = join(home, "work", "project")
    for (const dir of [workspace, own, join(home, ".ssh"), join(home, ".config", "git"), join(home, ".config", "gh"), join(home, ".cache", "pip"), join(home, ".local", "bin"), join(home, ".local", "share", "fonts")])
      mkdirSync(dir, { recursive: true })
    writeFileSync(join(home, ".gitconfig"), "[user]\n")
    writeFileSync(join(home, ".netrc"), "")
    symlinkSync(".gitconfig", join(home, "link"))
    symlinkSync("/nowhere", join(home, "dangling"))
    const policy: SandboxPolicy = {
      writableRoots: [workspace],
      readRest: true,
      home: { path: home, root: own, shared: [".cache", ".config", ".local", ".local/share", ".local/state"] },
      hiddenPaths: [join(home, ".ssh"), join(home, ".netrc"), join(home, ".config", "gh"), join(home, ".aws")],
      network: { mode: "off" },
      env: { mode: "deny" },
    }
    return { root, home, own, workspace, policy }
  }
  const mounts = (argv: string[]) => argv.slice(argv.indexOf("/tmp") + 1, argv.indexOf("--chdir"))
  const bind = (path: string) => ["--ro-bind", path, path]

  test("a directory of the session's at the home's path, the user's entries read-only in it, each shared directory a mount of its own with the user's entries one level down, then the workspace and the hidden paths", () => {
    const l = homeLayout()
    const own = (directory: string) => ["--bind", join(l.own, "shared", encodeURIComponent(directory)), join(l.home, directory)]
    expect(mounts(bwrapArgv(l.policy, ["true"], l.workspace, options))).toEqual([
      "--bind",
      join(l.own, "home"),
      l.home,
      // the home's own entries; the links are not mounts, and the credential stores are not bound at all
      ...bind(join(l.home, ".gitconfig")),
      ...bind(join(l.home, "work")),
      // the shared directories, each after the directory it is in, also the one the user does not have
      ...own(".cache"),
      ...bind(join(l.home, ".cache", "pip")),
      ...own(".config"),
      ...bind(join(l.home, ".config", "git")),
      ...own(".local"),
      ...bind(join(l.home, ".local", "bin")),
      ...own(".local/share"),
      ...bind(join(l.home, ".local", "share", "fonts")),
      ...own(".local/state"),
      "--bind",
      l.workspace,
      l.workspace,
      ...["--perms", "0000", "--tmpfs", join(l.home, ".ssh")],
      ...["--ro-bind", "/mask", join(l.home, ".netrc")],
      ...["--perms", "0000", "--tmpfs", join(l.home, ".config", "gh")],
    ])
    // What the mounts land on, and the user's links, were made in the session's directories; nothing in the user's home.
    expect(readdirSync(l.own).sort()).toEqual(["home", "shared"])
    expect(readdirSync(join(l.own, "shared")).sort()).toEqual([".cache", ".config", ".local", ".local%2Fshare", ".local%2Fstate"])
    expect(readdirSync(join(l.own, "home")).sort()).toEqual([".cache", ".config", ".gitconfig", ".local", ".netrc", ".ssh", "dangling", "link", "work"])
    expect(readlinkSync(join(l.own, "home", "link"))).toBe(".gitconfig")
    expect(readlinkSync(join(l.own, "home", "dangling"))).toBe("/nowhere")
    expect(lstatSync(join(l.own, "home", ".gitconfig")).size).toBe(0)
    expect(readdirSync(join(l.own, "shared", ".config")).sort()).toEqual(["gh", "git"])
    expect(readdirSync(join(l.own, "shared", ".local")).sort()).toEqual(["bin", "share", "state"])
    expect(readdirSync(join(l.own, "home", "work"))).toEqual([])
    expect(readdirSync(l.home).sort()).toEqual([".cache", ".config", ".gitconfig", ".local", ".netrc", ".ssh", "dangling", "link", "work"])
  })

  test("a shared directory that is a link or a file in the user's home is an entry like any other, and one the command made a link is left alone", () => {
    const l = homeLayout()
    rmSync(join(l.home, ".cache"), { recursive: true })
    symlinkSync("work", join(l.home, ".cache"))
    mkdirSync(join(l.own, "home"), { recursive: true })
    symlinkSync("/elsewhere", join(l.own, "home", ".config"))
    const argv = mounts(bwrapArgv(l.policy, ["true"], l.workspace, options))
    expect(argv.filter((arg) => arg.startsWith(join(l.home, ".cache")) || arg.startsWith(join(l.home, ".config")))).toEqual([join(l.home, ".config", "gh")])
    expect(readlinkSync(join(l.own, "home", ".cache"))).toBe("work")
    expect(readlinkSync(join(l.own, "home", ".config"))).toBe("/elsewhere")
    expect(readdirSync(join(l.own, "shared")).sort()).toEqual([".local", ".local%2Fshare", ".local%2Fstate"])
  })

  test("what the command made stays when the user's home gets an entry of that name and another kind, an empty left-over does not, and a link follows the user's", () => {
    const l = homeLayout()
    const own = join(l.own, "home")
    mkdirSync(join(own, ".toolrc"), { recursive: true })
    writeFileSync(join(own, ".toolrc", "state"), "the command's\n")
    writeFileSync(join(own, "notes"), "")
    symlinkSync("old-target", join(own, "link"))
    writeFileSync(join(own, "dangling"), "replaced by the command\n")
    writeFileSync(join(l.home, ".toolrc"), "the user's\n")
    mkdirSync(join(l.home, "notes"))
    const argv = mounts(bwrapArgv(l.policy, ["true"], l.workspace, options))
    expect(argv).not.toContain(join(l.home, ".toolrc"))
    expect(argv.join(" ")).toContain(bind(join(l.home, "notes")).join(" "))
    expect(lstatSync(join(own, "notes")).isDirectory()).toBe(true)
    expect(readlinkSync(join(own, "link"))).toBe(".gitconfig")
    expect(lstatSync(join(own, "dangling")).isFile()).toBe(true)
  })

  test("what the command made under a credential store's name gives way when the user has one there", () => {
    const l = homeLayout()
    mkdirSync(join(l.own, "home", ".netrc"), { recursive: true })
    writeFileSync(join(l.own, "home", ".netrc", "kept-here"), "the command's\n")
    symlinkSync("/elsewhere", join(l.own, "home", ".ssh"))
    const argv = mounts(bwrapArgv(l.policy, ["true"], l.workspace, options))
    expect(argv.join(" ")).toContain(`--ro-bind /mask ${join(l.home, ".netrc")}`)
    expect(lstatSync(join(l.own, "home", ".netrc")).isFile()).toBe(true)
    expect(lstatSync(join(l.own, "home", ".ssh")).isDirectory()).toBe(true)
  })

  test("more entries than are bound one by one: a shared directory stays the user's as a whole, and a home with too many of its own is left as it is", () => {
    const l = homeLayout()
    for (let index = 0; index < HOME_BINDS; index++) writeFileSync(join(l.home, ".cache", `entry-${index}`), "")
    const crowded = mounts(bwrapArgv(l.policy, ["true"], l.workspace, options))
    expect(crowded.join(" ")).toContain(bind(join(l.home, ".cache")).join(" "))
    expect(crowded).not.toContain(join(l.home, ".cache", "pip"))
    expect(crowded.join(" ")).toContain(bind(join(l.home, ".config", "git")).join(" "))

    for (let index = 0; index < HOME_BINDS; index++) writeFileSync(join(l.home, `entry-${index}`), "")
    expect(mounts(bwrapArgv(l.policy, ["true"], l.workspace, options)).slice(0, 3)).toEqual(["--bind", l.workspace, l.workspace])
  })

  test("no home of its own when the home or the session's directory is missing, or the home is the root or holds /tmp", () => {
    const l = homeLayout()
    const without = mounts(bwrapArgv({ ...l.policy, home: undefined }, ["true"], l.workspace, options))
    expect(without.slice(0, 3)).toEqual(["--bind", l.workspace, l.workspace])
    for (const home of [{ ...l.policy.home!, path: join(l.root, "absent") }, { ...l.policy.home!, root: join(l.root, "absent") }, { ...l.policy.home!, path: "/" }, { ...l.policy.home!, path: "/tmp" }])
      expect(mounts(bwrapArgv({ ...l.policy, home }, ["true"], l.workspace, options)), home.path).toEqual(without)
  })
})

describe("seatbelt profile (generated on Linux; untested on a real Mac)", () => {
  const policy: SandboxPolicy = {
    writableRoots: ["/Users/u/project"],
    tempRoot: "/Users/u/.cache/session-tmp",
    readRest: true,
    hiddenPaths: ["/Users/u/.ssh", "/Users/u/Library/Keychains"],
    network: { mode: "off" },
    env: { mode: "deny" },
  }

  test("deny by default, read everything, write the roots, hidden denials last", () => {
    const generated = seatbeltProfile(policy)
    expect(generated.params).toEqual([
      ["WRITABLE_0", "/Users/u/project"],
      ["WRITABLE_1", "/Users/u/.cache/session-tmp"],
      ["HIDDEN_0", "/Users/u/.ssh"],
      ["HIDDEN_1", "/Users/u/Library/Keychains"],
    ])
    const text = generated.profile
    expect(text).toContain("UNTESTED ON A REAL MAC")
    expect(text).toStartWith("; Generated")
    expect(text).toContain("(version 1)\n(deny default)")
    expect(text).toContain("(allow file-read*)")
    expect(text).toContain('(allow file-read* file-write*\n  (subpath (param "WRITABLE_0"))\n  (subpath (param "WRITABLE_1")))')
    expect(text).toContain('(deny file-read* file-write*\n  (subpath (param "HIDDEN_0"))\n  (subpath (param "HIDDEN_1")))')
    expect(text.indexOf("(deny file-read* file-write*")).toBeGreaterThan(text.indexOf('(param "WRITABLE_1")'))
    expect(text).not.toContain("(allow network")
    expect(text).not.toContain("/Users/u")
    // balanced parentheses outside comments and strings
    const code = text.replace(/;.*$/gm, "").replace(/"[^"]*"/g, "")
    expect(code.split("(").length).toBe(code.split(")").length)
  })

  test("a home of the command's own is not in the profile: sandbox-exec cannot show another directory at the home's path", () => {
    const withHome = seatbeltProfile({ ...policy, home: { path: "/Users/u", root: "/Users/u/.cache/session.home", shared: [".config"] } })
    expect(withHome).toEqual(seatbeltProfile(policy))
  })

  test("network on allows the network and the DNS/TLS services", () => {
    const text = seatbeltProfile({ ...policy, network: { mode: "on" } }).profile
    expect(text).toContain("(allow network*)")
    expect(text).toContain('(global-name "com.apple.trustd.agent")')
  })

  test("readRest off lists readable locations instead of allowing all reads", () => {
    const generated = seatbeltProfile({ ...policy, readRest: false, readableRoots: ["/Users/u/shared"] })
    expect(generated.profile).not.toContain("(allow file-read*)\n")
    expect(generated.params).toEqual(expect.arrayContaining([["READABLE_0", "/usr"], ["READABLE_12", "/Users/u/shared"]]))
  })

  test("sandboxCommand builds the sandbox-exec argv and points TMPDIR at the temp root", () => {
    const result = sandboxCommand(policy, { shell: "make test", shellPath: "/bin/zsh", cwd: "/Users/u/project" }, {
      detection: { available: true, backend: "seatbelt", sandboxExecPath: "/usr/bin/sandbox-exec" },
      env: { PATH: "/usr/bin", OPENAI_API_KEY: "sk" },
    })
    if (result.kind !== "ready") throw new Error("expected ready")
    expect(result.argv.slice(0, 2)).toEqual(["/usr/bin/sandbox-exec", "-p"])
    expect(result.argv.slice(3)).toEqual([
      "-DWRITABLE_0=/Users/u/project",
      "-DWRITABLE_1=/Users/u/.cache/session-tmp",
      "-DHIDDEN_0=/Users/u/.ssh",
      "-DHIDDEN_1=/Users/u/Library/Keychains",
      "--",
      "/bin/zsh",
      "-c",
      "make test",
    ])
    expect(result.env).toEqual({ PATH: "/usr/bin", TMPDIR: "/Users/u/.cache/session-tmp" })
  })
})

test("defaultPolicy plans cleanly for both backends", () => {
  const policy = defaultPolicy({ workspace: "/w", home: "/h", env: {}, platform: "darwin" })
  expect(sandboxCommand(policy, { argv: ["true"], cwd: "/w" }, { detection: { available: true, backend: "seatbelt", sandboxExecPath: "/usr/bin/sandbox-exec" }, env: {} }).kind).toBe("ready")
})
