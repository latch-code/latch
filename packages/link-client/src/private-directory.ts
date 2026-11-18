import { lstat, mkdir } from 'node:fs/promises'

/** A directory this user owns: a real directory (not a link), owned by `uid`, with none of `mask`'s mode bits set. */
export async function ownedDirectory(path: string, uid: number, mask: number): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined)
  return !!info && info.isDirectory() && !info.isSymbolicLink() && info.uid === uid && (info.mode & mask) === 0
}

/** One level (never recursive), mode 0700. An existing entry is left for `ownedDirectory` to judge; false on any other failure. */
export async function makePrivateDirectory(path: string): Promise<boolean> {
  try {
    await mkdir(path, { mode: 0o700 })
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST'
  }
}
