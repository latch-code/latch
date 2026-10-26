import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
/** Private relay state never follows links or substitutes a fresh empty ledger for a corrupt one. */
export async function readPrivate(path: string, maximum: number): Promise<string | undefined> {
  if (!isAbsolute(path)) throw new Error('Private state path must be absolute')
  const info = await lstat(path).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
  if (!info) return
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > maximum)
    throw new Error('Invalid private relay state')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const actual = await file.stat()
    if (!actual.isFile() || actual.dev !== info.dev || actual.ino !== info.ino || (actual.mode & 0o077) !== 0 || actual.size > maximum)
      throw new Error('Private relay state changed')
    const bytes = Buffer.alloc(maximum + 1)
    let size = 0
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    const after = await file.stat()
    if (size > maximum || after.size !== size || after.mtimeMs !== actual.mtimeMs || (after.mode & 0o077) !== 0)
      throw new Error('Private relay state changed')
    return bytes.subarray(0, size).toString('utf8')
  } finally {
    await file.close()
  }
}
export async function writePrivate(path: string, content: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('Private state path must be absolute')
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directoryInfo = await lstat(parent)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077) !== 0)
    throw new Error('Invalid relay state directory')
  const target = await lstat(path).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
  if (target && (!target.isFile() || target.isSymbolicLink() || (target.mode & 0o077) !== 0)) throw new Error('Invalid relay state target')
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    await file.writeFile(content)
    await file.sync()
    await file.close()
    file = undefined
    await rename(temporary, path)
    const directory = await open(parent, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch (error) {
    await file?.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
}
