/**
 * Names a filesystem may treat as `.git`, as Git's own `verify_path` checks
 * them (`is_hfs_dotgit` and `is_ntfs_dotgit` in Git's path.c and utf8.c).
 *
 * - Any case: `.GIT` is `.git` on a case-insensitive volume.
 * - HFS+ ignores some code points in a name: `.g‌it` and `.git﻿`
 *   name the same directory as `.git` there.
 * - NTFS drops trailing dots and spaces, reads what follows `:` as a stream
 *   name and `\` as a separator, and gives `.git` the short name `git~1`.
 */

/** The code points HFS+ ignores when it compares names (Git's `next_hfs_char`). */
const HFS_IGNORED = /[‌-‏‪-‮⁪-⁯﻿]/g

/** Whether `name`, one path component, is `.git` to Git on any filesystem it protects. */
export function isDotGit(name: string): boolean {
  return reservedName(name, ".git") || /^(?:\.git|git~1)[. ]*(?:[\\:]|$)/i.test(name)
}

/**
 * Whether `name`, one path component, is `reserved` (an ASCII name) on a
 * case-insensitive or HFS+ volume, or on NTFS with trailing dots and spaces.
 */
export function reservedName(name: string, reserved: string): boolean {
  const folded = name.replace(HFS_IGNORED, "").replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  return folded === reserved || folded.replace(/[. ]+$/, "") === reserved
}
