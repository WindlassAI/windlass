/** Names Git reads as `.git`, and the inspection's walk (which can start Git, so this file is end-to-end). */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { repositoryEntries } from "../../src/sandbox/git-inspect.ts"
import { isDotGit, reservedName } from "../../src/sandbox/git-name.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"
import { removeTempDirs, tempDir } from "./helpers.ts"

setDefaultTimeout(E2E_TIMEOUT_MS)
afterAll(removeTempDirs)

test.each([".git", ".GIT", ".Git", ".git.", ".git ", ".git. .", "git~1", "GIT~1", "git~1.", ".git:stream", ".git\\x", ".g‌it", ".git﻿", "‎.git", ".g⁪it"])("%j is .git to some filesystem", (name) => {
  expect(isDotGit(name)).toBe(true)
})

test.each([".gitignore", ".gitmodules", ".github", "git", "git~2", "x.git", ".gi", ".git~1", ".gît"])("%j is an ordinary name", (name) => {
  expect(isDotGit(name)).toBe(false)
})

test("the project directory is matched in any case, with ignored code points and trailing dots", () => {
  for (const name of [".windlass", ".Windlass", ".windlass.", ".wind‌lass"]) expect(reservedName(name, ".windlass")).toBe(true)
  expect(reservedName(".windlass-old", ".windlass")).toBe(false)
})

test("a nested repository under a lookalike .git name is found", async () => {
  const root = tempDir("git-name")
  mkdirSync(join(root, "vendor", ".git﻿"), { recursive: true })
  mkdirSync(join(root, "other", "GIT~1"), { recursive: true })
  writeFileSync(join(root, "plain"), "")
  expect([...(await repositoryEntries(root))].sort()).toEqual(['nested repository "other"', 'nested repository "vendor"'])
})

test("the walk of untracked directories is bounded", async () => {
  const root = tempDir("git-walk")
  for (const name of ["a", "b", "c", "d", "e"]) mkdirSync(join(root, name, "deeper"), { recursive: true })
  await expect(repositoryEntries(root, undefined, undefined, { maxDirectories: 4 })).rejects.toThrow("more than 4 untracked directories")
  expect((await repositoryEntries(root, undefined, undefined, { maxDirectories: 100 })).size).toBe(0)
})
