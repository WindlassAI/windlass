import { lstatSync, mkdtempSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { brand } from "../brand.ts"
import { type GitLayout, gitLayout, validGitLayout } from "./git.ts"
import { readGitFile } from "./git-file.ts"
import { repositoryEntries } from "./git-inspect.ts"

export interface GitFinding {
  readonly message: string
  readonly violation: boolean
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

/** Capture pointer identity before spawning. Inspect the original paths before allowing Git to read an index afterwards. */
export async function auditGit(cwd: string, layout: GitLayout | null): Promise<() => Promise<GitFinding | null>> {
  const root = layout?.workTree ?? realpathSync(cwd)
  const rootId = identity(root)
  const entry = join(root, ".git")
  const entryId = identity(entry)
  const valid = layout !== null && validGitLayout(layout)
  const pointer = valid && layout.gitDir !== entry ? readGitFile(entry, 65536) : null
  const common = valid ? join(layout.commonDir, "commondir") : null
  const checkCommon = common !== null && identity(common) === null
  const commonId = valid ? identity(layout.commonDir) : null
  const index = valid ? join(layout.gitDir, "index") : undefined
  const before = await repositoryEntries(root, index).catch(() => new Set<string>())
  return async () => {
    const messages: string[] = []
    try {
      if (identity(root) !== rootId || realpathSync(root) !== root)
        throw new Error("the workspace directory changed. Inspect its original location")
      const replaced = identity(entry) !== entryId
      let samePointer = true
      if (!replaced && pointer !== null) {
        try {
          samePointer = pointer.equals(readGitFile(entry, 65536) ?? Buffer.alloc(0))
        } catch {
          samePointer = false
        }
      }
      if (replaced || !samePointer) {
        // Mounts and Seatbelt protect existing entries. Also recover a moved original if the backend failed to pin it.
        const moved = !replaced || entryId === null ? undefined : readdirSync(root).find((name) => identity(join(root, name)) === entryId)
        const saved = identity(entry) === null ? null : setAside(entry)
        if (moved !== undefined) renameSync(join(root, moved), entry)
        else if (pointer !== null) writeFileSync(entry, pointer, { flag: "wx" })
        else if (entryId !== null) throw new Error(`the original .git could not be located${saved ? `. Replacement saved at ${saved}` : ""}`)
        messages.push(`Sandbox violation: the command changed .git. Restored its original ${entryId === null ? "absence" : "location"}.${saved ? ` Inspect the metadata saved at ${saved} before using Git.` : ""}`)
      }
      if (checkCommon && common !== null && layout) {
        if (realpathSync(layout.commonDir) !== layout.commonDir || identity(layout.commonDir) !== commonId)
          throw new Error("the Git common directory changed. Inspect the repository before using Git")
        if (identity(common) !== null) {
          const saved = setAside(common)
          messages.push(`Sandbox violation: the command created Git's commondir pointer. Restored its absence. Inspect the entry saved at ${saved}.`)
        }
      }
      if (valid && (!validGitLayout(layout) || gitLayout(root)?.gitDir !== layout.gitDir))
        throw new Error("the Git metadata pointers changed. Inspect .git before using Git")
      const after = await repositoryEntries(root, index)
      const added = [...after].filter((entry) => !before.has(entry))
      const violation = messages.length > 0
      if (added.length) {
        const entries = added.slice(0, 8).join(", ") + (added.length > 8 ? ` and ${added.length - 8} more` : "")
        messages.push(`Git warning: this command introduced ${entries}. Your own root git status can execute configuration from a nested repository outside the sandbox. Inspect its Git metadata before running Git.`)
      }
      return messages.length ? { violation, message: messages.join("\n") } : null
    } catch (error) {
      messages.push(`Git safety check failed: ${error instanceof Error ? error.message : String(error)}.`)
      return { violation: true, message: messages.join("\n") }
    }
  }
}
