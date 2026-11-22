/**
 * A session's watch over a workspace's Git metadata, driven directly: what
 * the user changes is not undone, a command cannot switch the inspection
 * off, a slow inspection does not hold up the guard, and a looping process
 * cannot make unbounded copies or output. Starts Git (the inspection), so
 * this file is end-to-end; no sandbox is needed.
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import { gitLayout } from "../../src/sandbox/git.ts"
import { MAX_KEPT_RESTORES, MAX_LINES_PER_COMMAND, gitWatch } from "../../src/sandbox/git-audit.ts"
import { E2E_TIMEOUT_MS, waitFor } from "../../src/testing/wait.ts"
import { removeTempDirs, tempDir } from "./helpers.ts"

setDefaultTimeout(E2E_TIMEOUT_MS)
afterAll(removeTempDirs)

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
function git(cwd: string, ...args: string[]) {
  const done = Bun.spawnSync(["git", ...args], { cwd, env })
  if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`)
  return done.stdout.toString().trim()
}
function folder(label: string) {
  return realpathSync(tempDir(label))
}
function repository(label: string) {
  const dir = folder(label)
  git(dir, "init", "-q")
  writeFileSync(join(dir, "file"), "x")
  git(dir, "add", "file")
  git(dir, "commit", "-qm", "init")
  return dir
}
/** One command's whole check, with nothing done during it. */
async function command(watch: ReturnType<typeof gitWatch>) {
  return (await watch.begin())()
}
const reviewCopies = (dir: string) => readdirSync(dir).filter((name) => name.startsWith(`.${brand.directory}-review-`))

test("a repository the user creates between commands is taken as it is where nothing sandboxed outlives its command", async () => {
  const cwd = folder("watch-user-init")
  const watch = gitWatch(cwd, gitLayout(cwd), { survivors: false })
  expect(await command(watch)).toBeNull()
  git(cwd, "init", "-q")
  const next = await command(watch)
  expect(next).toMatchObject({ violation: false, message: expect.stringContaining("changed outside the sandbox") })
  expect(existsSync(join(cwd, ".git", "HEAD"))).toBe(true)
  expect(reviewCopies(cwd)).toEqual([])
  // It is the baseline now: the next command has nothing to say.
  expect(await command(watch)).toBeNull()
})

test("where a process can outlive its command, a valid new repository is reported, not moved; anything else is still undone", async () => {
  const cwd = folder("watch-survivors")
  const watch = gitWatch(cwd, gitLayout(cwd), { survivors: true })
  expect(await command(watch)).toBeNull()
  git(cwd, "init", "-q")
  expect(await command(watch)).toMatchObject({ violation: false, message: expect.stringContaining("Inspect .git") })
  expect(existsSync(join(cwd, ".git", "HEAD"))).toBe(true)
  // A gitfile naming another directory is no valid repository: it is set aside as before.
  const other = folder("watch-survivors-gitfile")
  const second = gitWatch(other, gitLayout(other), { survivors: true })
  expect(await command(second)).toBeNull()
  writeFileSync(join(other, ".git"), "gitdir: /elsewhere\n")
  expect(await command(second)).toMatchObject({ violation: true, message: expect.stringContaining("changed .git") })
  expect(existsSync(join(other, ".git"))).toBe(false)
})

test("while a command runs outside the sandbox nothing is undone, and what it changed is the baseline afterwards", async () => {
  const cwd = folder("watch-outside")
  const watch = gitWatch(cwd, gitLayout(cwd), { survivors: false })
  // A sandboxed command in the background, and an approved one outside the sandbox beside it.
  const background = await watch.begin()
  const outside = watch.outside()
  git(cwd, "init", "-q")
  expect(await background()).toBeNull()
  await outside()
  expect(existsSync(join(cwd, ".git", "HEAD"))).toBe(true)
  const next = await watch.begin()
  expect(await next()).toBeNull()
  expect(existsSync(join(cwd, ".git", "HEAD"))).toBe(true)
})

test("a change between commands is still undone while another sandboxed command runs", async () => {
  const cwd = folder("watch-busy")
  let others = false
  const watch = gitWatch(cwd, gitLayout(cwd), { survivors: false, othersRunning: () => others })
  expect(await command(watch)).toBeNull()
  others = true
  git(cwd, "init", "-q")
  expect(await command(watch)).toMatchObject({ violation: true, message: expect.stringContaining("changed .git") })
  expect(existsSync(join(cwd, ".git"))).toBe(false)
})

test("a command cannot switch off the nested-repository and gitlink check by exhausting the walk", async () => {
  const cwd = repository("watch-exhaust")
  const watch = gitWatch(cwd, gitLayout(cwd), { survivors: false, maxDirectories: 5 })
  expect(await command(watch)).toBeNull()
  // The command that makes more directories than one inspection walks.
  let end = await watch.begin()
  for (let n = 0; n < 10; n++) mkdirSync(join(cwd, "junk", String(n)), { recursive: true })
  expect(await end()).toMatchObject({ violation: false, message: expect.stringContaining("only in part") })
  // A later command plants a repository and stages a gitlink for it; the directories are still there.
  end = await watch.begin()
  git(cwd, "init", "-q", "evil")
  git(cwd, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},evil`)
  const found = await end()
  expect(found?.message).toContain('gitlink "evil"')
  expect(found?.message).toContain("git status")
  // Told once while it stays partial, and the gitlink once.
  expect(await command(watch)).toBeNull()
})

test("a slow inspection holds up neither another workspace's check nor this workspace's guard", async () => {
  const slow = repository("watch-slow")
  const quick = folder("watch-quick")
  const watch = gitWatch(slow, gitLayout(slow), { survivors: false, intervalMs: 10 })
  expect(await command(watch)).toBeNull()
  const running = await watch.begin()
  // From here every Git the inspection starts waits until released.
  const bin = folder("watch-slow-bin")
  const release = join(bin, "release")
  const real = Bun.which("git")!
  writeFileSync(join(bin, "git"), `#!/bin/sh\nwhile [ ! -e "${release}" ]; do sleep 0.02; done\nexec "${real}" "$@"\n`, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const held = watch.begin()
    // Another workspace's whole check (it needs no Git: there is no repository).
    const other = gitWatch(quick, gitLayout(quick), { survivors: false })
    expect(await command(other)).toBeNull()
    // The guard of the running command still sets a new commondir aside.
    const common = join(slow, ".git", "commondir")
    writeFileSync(common, "elsewhere\n")
    await waitFor(() => !existsSync(common), { what: "the guard to set commondir aside while an inspection waits" })
    writeFileSync(release, "")
    await (await held)()
  } finally {
    process.env.PATH = path
    writeFileSync(release, "")
  }
  expect(await running()).toMatchObject({ violation: true, message: expect.stringContaining("commondir") })
})

test("a process that keeps changing the metadata gets bounded copies and output, and is still undone", async () => {
  const cwd = repository("watch-loop")
  const watch = gitWatch(cwd, gitLayout(cwd), { survivors: false, intervalMs: 5 })
  expect(await command(watch)).toBeNull()
  const end = await watch.begin()
  const common = join(cwd, ".git", "commondir")
  for (let n = 0; n < MAX_KEPT_RESTORES + 6; n++) {
    writeFileSync(common, "elsewhere\n")
    await waitFor(() => !existsSync(common), { what: `the guard to undo change ${n + 1}` })
  }
  const found = await end()
  expect(found?.violation).toBe(true)
  const lines = found!.message.split("\n")
  expect(lines.length).toBeLessThanOrEqual(MAX_LINES_PER_COMMAND)
  expect(found!.message).toContain("keeps changing")
  expect(reviewCopies(join(cwd, ".git"))).toHaveLength(MAX_KEPT_RESTORES)
})
