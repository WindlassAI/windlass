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
  return reservedName(name, ".git", ["git~1"])
}

/**
 * Whether `name`, one path component, is `reserved` (an ASCII name that
 * starts with a dot) on a case-insensitive or HFS+ volume, or on NTFS:
 * where any piece between backslashes is the name, with trailing dots and
 * spaces or a `:` stream after it, or its short name. The short names are
 * `shortNames`, by default the first six letters after the dot with `~1`
 * to `~4` (the ones NTFS gives before it switches to hashed names, which
 * this does not compute).
 */
export function reservedName(name: string, reserved: string, shortNames: readonly string[] = ntfsShortNames(reserved)): boolean {
  return name.split(/[\\/]/).some((piece) => {
    const folded = piece.replace(HFS_IGNORED, "").replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    const stem = folded.replace(/:[\s\S]*$/, "").replace(/[. ]+$/, "")
    return folded === reserved || stem === reserved || shortNames.includes(stem)
  })
}

function ntfsShortNames(reserved: string): string[] {
  const letters = reserved.replace(/^\./, "").slice(0, 6)
  return [1, 2, 3, 4].map((n) => `${letters}~${n}`)
}
