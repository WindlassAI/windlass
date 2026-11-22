/** Names Git reads as `.git`, and the inspection's walk (which can start Git, so this file is end-to-end). */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import { copyGitIndex, inspectRepository, repositoryEntries } from "../../src/sandbox/git-inspect.ts"
import { isDotGit, reservedName } from "../../src/sandbox/git-name.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"
import { removeTempDirs, tempDir } from "./helpers.ts"

setDefaultTimeout(E2E_TIMEOUT_MS)
afterAll(removeTempDirs)

test.each([".git", ".GIT", ".Git", ".git.", ".git ", ".git. .", "git~1", "GIT~1", "git~1.", ".git:stream", ".git\\x", ".g‌it", ".git﻿", "‎.git", ".g⁪it", "a\\.git", "a\\b\\GIT~1\\c", "x\\.Git. \\y", "x\\.git:stream"])("%j is .git to some filesystem", (name) => {
  expect(isDotGit(name)).toBe(true)
})

test.each([".gitignore", ".gitmodules", ".github", "git", "git~2", "x.git", ".gi", ".git~1", ".gît", "a\\.gitignore", "x\\git"])("%j is an ordinary name", (name) => {
  expect(isDotGit(name)).toBe(false)
})

test("the project directory is matched in any case, with ignored code points and trailing dots", () => {
  for (const name of [".windlass", ".Windlass", ".windlass.", ".wind‌lass"]) expect(reservedName(name, ".windlass")).toBe(true)
  expect(reservedName(".windlass-old", ".windlass")).toBe(false)
})

test("the project directory is matched as NTFS reads it: after a backslash, with a stream, and by its short name", () => {
  const reserved = `.${brand.directory}`
  const short = brand.directory.slice(0, 6)
  for (const name of [`${reserved}:stream`, `${reserved}. :x`, `a\\${reserved}`, `${short}~1`, `${short.toUpperCase()}~4.`, `a\\${short}~2\\b`]) expect([name, reservedName(name, reserved)]).toEqual([name, true])
  for (const name of [`${short}~5`, `${short}~1x`, `${reserved}-old:x`, `a\\${brand.directory}`]) expect([name, reservedName(name, reserved)]).toEqual([name, false])
})

test("a nested repository under a lookalike .git name is found", async () => {
  const root = tempDir("git-name")
  mkdirSync(join(root, "vendor", ".git﻿"), { recursive: true })
  mkdirSync(join(root, "other", "GIT~1"), { recursive: true })
  writeFileSync(join(root, "plain"), "")
  expect([...(await repositoryEntries(root))].sort()).toEqual(['nested repository "other"', 'nested repository "vendor"'])
})

test("a copied index keeps the modification time Git's racy-entry check compares with", () => {
  const root = tempDir("git-index")
  const source = join(root, "index")
  writeFileSync(source, "DIRC")
  const then = new Date("2026-01-02T03:04:05.678Z")
  utimesSync(source, then, then)
  copyGitIndex(source, join(root, "copy"))
  expect(statSync(join(root, "copy")).mtimeMs).toBe(statSync(source).mtimeMs)
})

test("the walk of untracked directories is bounded", async () => {
  const root = tempDir("git-walk")
  for (const name of ["a", "b", "c", "d", "e"]) mkdirSync(join(root, name, "deeper"), { recursive: true })
  await expect(repositoryEntries(root, undefined, undefined, { maxDirectories: 4 })).rejects.toThrow("more than 4 untracked directories")
  expect((await repositoryEntries(root, undefined, undefined, { maxDirectories: 100 })).size).toBe(0)
})

test("a walk that runs out of budget still reports every gitlink, and the shallow repositories before the deep directories", async () => {
  const root = tempDir("git-partial")
  const git = (...args: string[]) => {
    const done = Bun.spawnSync(["git", ...args], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } })
    expect(done.exitCode).toBe(0)
    return done.stdout.toString().trim()
  }
  git("init", "-q")
  for (let n = 0; n < 12; n++) mkdirSync(join(root, "junk", String(n)), { recursive: true })
  // After the wide directory, in the listing's order.
  git("init", "-q", "zz")
  git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},evil`)
  const found = await inspectRepository(root, join(root, ".git", "index"), undefined, { maxDirectories: 6 })
  expect(found.partial).toContain("more than 6 untracked directories")
  expect([...found.entries].sort()).toEqual(['gitlink "evil"', 'nested repository "zz"'])
  // A caller that must refuse what it cannot check still gets an error.
  await expect(repositoryEntries(root, join(root, ".git", "index"), undefined, { maxDirectories: 6 })).rejects.toThrow("more than 6")
})
