import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs"

/** Read only the regular file we opened, without following a link, blocking on a pipe or allocating past the limit. */
export function readGitFile(path: string, maxBytes: number): Buffer | null {
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (!entry) return null
  const invalid = `${path} must be a regular file of at most ${maxBytes} bytes`
  if (!entry.isFile() || entry.size > maxBytes) throw new Error(invalid)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(invalid)
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      if (!count) throw new Error(`${path} changed during inspection`)
      offset += count
    }
    return bytes
  } finally {
    closeSync(fd)
  }
}
