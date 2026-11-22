/** Access one merge destination relative to an open parent. A concurrent directory replacement must never redirect an operation. */
import { randomUUID } from "node:crypto"
import { dlopen } from "bun:ffi"
import { closeSync, constants as fs, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface FileVersion {
  readonly bytes: Uint8Array
  readonly mode: string
}

export function mergeComponents(path: string): string[] {
  const parts = path.split("/")
  if (parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || part.includes("\0")))
    throw new Error(`unsafe merge path ${JSON.stringify(path)}`)
  return parts
}

// Node has no dirfd-relative filesystem API. Only load libc when a merge actually needs it.
function directoryCalls() {
  return dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    openat: { args: ["i32", "cstring", "i32"], returns: "i32" },
    mkdirat: { args: ["i32", "cstring", "u32"], returns: "i32" },
    renameat: { args: ["i32", "cstring", "i32", "cstring"], returns: "i32" },
    unlinkat: { args: ["i32", "cstring", "i32"], returns: "i32" },
    symlinkat: { args: ["cstring", "i32", "cstring"], returns: "i32" },
    readlinkat: { args: ["i32", "cstring", "ptr", "usize"], returns: "i64" },
  }).symbols
}
let calls: ReturnType<typeof directoryCalls> | undefined
const nameOf = (path: string) => Buffer.from(path + "\0")
// Darwin fcntl.h: unlike O_NOFOLLOW, this also covers all ancestors in an absolute path.
const DARWIN_O_NOFOLLOW_ANY = 0x20000000
const directoryFlags = fs.O_RDONLY | fs.O_NOFOLLOW | fs.O_DIRECTORY

function withParent<T>(root: string, path: string, create: boolean, visit: (fd: number, name: string) => T): T | null {
  const parts = mergeComponents(path)
  const leaf = parts.pop()!
  const native = calls ??= directoryCalls()
  let fd = openSync(root, directoryFlags)
  let directory = root
  try {
    for (const part of parts) {
      directory = join(directory, part)
      const info = lstatSync(directory, { throwIfNoEntry: false })
      const name = nameOf(part)
      if (!info) {
        if (!create) return null
        native.mkdirat(fd, name, 0o777)
      } else if (!info.isDirectory()) throw new Error(`merge parent is not a directory: ${directory}`)
      const next = native.openat(fd, name, directoryFlags)
      if (next < 0) throw new Error(`cannot open merge parent without following links: ${directory}`)
      closeSync(fd)
      fd = next
    }
    return visit(fd, leaf)
  } finally {
    closeSync(fd)
  }
}

export function versionOnDisk(root: string, path: string): FileVersion | null {
  return withParent(root, path, false, (parent, leaf) => {
    const info = lstatSync(join(root, path), { throwIfNoEntry: false })
    if (!info) return null
    const name = nameOf(leaf)
    if (info.isSymbolicLink()) {
      const buf = Buffer.alloc(8192)
      const count = Number(calls!.readlinkat(parent, name, buf, buf.length))
      if (count < 0 || count >= buf.length) throw new Error(`cannot read merge symlink: ${path}`)
      return { bytes: buf.subarray(0, count), mode: "120000" }
    }
    if (!info.isFile()) throw new Error(`merge target is not a regular file: ${path}`)
    const fd = calls!.openat(parent, name, fs.O_RDONLY | fs.O_NOFOLLOW | fs.O_NONBLOCK)
    if (fd < 0) throw new Error(`cannot open merge target: ${path}`)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) throw new Error(`merge target changed: ${path}`)
      return { bytes: readFileSync(fd), mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644" }
    } finally {
      closeSync(fd)
    }
  })
}

export function writeVersion(root: string, path: string, previous: FileVersion | null, result: FileVersion | null): void {
  withParent(root, path, result !== null, (parent, leaf) => {
    const name = nameOf(leaf)
    if (result === null) {
      if (calls!.unlinkat(parent, name, 0) !== 0) throw new Error(`cannot remove merge target: ${path}`)
      return
    }
    // An existing file stays intact until its replacement has been written and its mode set.
    const output = previous === null ? leaf : `.merge-${randomUUID()}`
    const outName = nameOf(output)
    let created = false
    try {
      if (result.mode === "120000") {
        if (result.bytes.includes(0) || calls!.symlinkat(Buffer.concat([result.bytes, Buffer.from([0])]), parent, outName) !== 0)
          throw new Error(`cannot create merge symlink: ${path}`)
        created = true
      } else {
        // Darwin's O_NOFOLLOW_ANY rejects symlinks in every component. Linux resolves the leaf at our open parent.
        const darwin = process.platform === "darwin"
        const target = darwin ? join(root, dirname(path), output) : `/proc/self/fd/${parent}/${output}`
        const fd = openSync(target, fs.O_WRONLY | fs.O_CREAT | fs.O_EXCL | (darwin ? DARWIN_O_NOFOLLOW_ANY : fs.O_NOFOLLOW), 0o600)
        created = true
        try {
          writeFileSync(fd, result.bytes)
          fchmodSync(fd, result.mode === "100755" ? 0o755 : 0o644)
        } finally {
          closeSync(fd)
        }
      }
      if (previous && calls!.renameat(parent, outName, parent, name) !== 0) throw new Error(`cannot replace merge target: ${path}`)
      created = false
    } finally {
      if (created) calls!.unlinkat(parent, outName, 0)
    }
  })
}
