import { constants, type BigIntStats } from 'node:fs'
import { access, lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { codeOf } from './http-util.ts'

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return (
    after.isDirectory()
    && !after.isSymbolicLink()
    && before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.uid === after.uid
    && before.gid === after.gid
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs
  )
}

/** A failed Git layout read alone cannot distinguish an ordinary folder from rejected or damaged metadata. */
export async function isOrdinaryWorkbenchFolder(folder: string): Promise<boolean> {
  if (constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) return false
  if (!isAbsolute(folder) || Buffer.byteLength(folder) > 4096 || /[\u0000-\u001f\u007f]/u.test(folder)) return false
  try {
    const before = await lstat(folder, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink()) return false
    const root = await realpath(folder)
    if (root !== folder) return false
    const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!unchanged(before, await directory.stat({ bigint: true }))) return false
      const ancestors: Array<{ path: string; info: BigIntStats }> = []
      for (let path = root; ; path = dirname(path)) {
        const info = await lstat(path, { bigint: true })
        if (!info.isDirectory() || info.isSymbolicLink()) return false
        ancestors.push({ path, info })
        if (path === dirname(path)) break
      }
      await access(root, constants.R_OK | constants.X_OK)
      try {
        await lstat(join(root, '.git'))
        return false
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') return false
      }
      // A restored ancestor can leave the opened directory unchanged. Its parent's metadata still records the replacement.
      // Concurrent sibling changes conservatively keep the read error; this is not an atomic filesystem snapshot.
      for (const ancestor of ancestors) {
        if (!unchanged(ancestor.info, await lstat(ancestor.path, { bigint: true }))) return false
      }
      return (
        unchanged(before, await directory.stat({ bigint: true }))
        && unchanged(before, await lstat(root, { bigint: true }))
        && root === (await realpath(folder))
      )
    } finally {
      await directory.close()
    }
  } catch {
    return false
  }
}
