// Writes and removes files inside a session folder for undo and discard. Every directory on the way must be a real
// directory inside the folder (never a symlink) and stay the same one until the change lands: a write goes through a
// new temporary file next to the target and a rename, and a removal checks the file first.
import { randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { isFileMention } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { syncDirectory } from '@latch/core/node-kit'
import type { FileRoot } from '../files/resolve.ts'
import { isInsidePath } from '../paths.ts'
import type { ProtectedIndex } from './walk.ts'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const CHUNK = 1024 * 1024
const codeOf = (error: unknown) => (error instanceof Error && 'code' in error ? error.code : undefined)
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino

const refused = () => new AppError(409, 'change-path-refused', '这个文件的位置变了，没有写入。')

interface Chain {
  directory: string
  ids: Array<{ path: string; info: BigIntStats }>
}

/** The target's directories from the folder down, each a real, unprotected directory; created when `create`. */
async function walkDown(root: FileRoot, parts: readonly string[], guard: ProtectedIndex, create: boolean): Promise<Chain | undefined> {
  const top = await lstat(root.path, { bigint: true }).catch(() => undefined)
  if (!top?.isDirectory() || top.isSymbolicLink()) throw refused()
  const ids = [{ path: root.path, info: top }]
  let directory = root.path
  for (const part of parts) {
    directory = join(directory, part)
    let info = await lstat(directory, { bigint: true }).catch((error: unknown) => {
      if (codeOf(error) === 'ENOENT') return undefined
      throw error
    })
    if (!info) {
      if (!create) return undefined
      await mkdir(directory, { mode: 0o755 }).catch((error: unknown) => {
        if (codeOf(error) !== 'EEXIST') throw error
      })
      info = await lstat(directory, { bigint: true })
    }
    if (!info.isDirectory() || info.isSymbolicLink() || guard.has(directory, info)) throw refused()
    ids.push({ path: directory, info })
  }
  return { directory, ids }
}

/** Every directory of the chain is still the one walked, and `file` still resolves inside the folder. */
async function unchanged(root: FileRoot, chain: Chain, file: string): Promise<void> {
  for (const { path, info } of chain.ids) {
    const now = await lstat(path, { bigint: true }).catch(() => undefined)
    if (!now?.isDirectory() || now.isSymbolicLink() || !same(now, info)) throw refused()
  }
  const real = await realpath(file).catch(() => undefined)
  if (!real || !isInsidePath(real, root.path)) throw refused()
}

function split(path: string, rootId: string): { parts: string[]; name: string } {
  if (!isFileMention({ root: rootId, path })) throw refused()
  const parts = path.split('/')
  return { parts: parts.slice(0, -1), name: parts.at(-1)! }
}

/** Content to write: bytes in memory, or a kept file opened (and checked) only when it is written. */
export type Source = Uint8Array | (() => Promise<FileHandle>)

async function copyInto(target: FileHandle, source: Source): Promise<void> {
  if (source instanceof Uint8Array) {
    await target.writeFile(source)
    return
  }
  const input = await source()
  try {
    const buffer = Buffer.alloc(CHUNK)
    for (let position = 0; ;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      await target.write(buffer, 0, bytesRead)
      position += bytesRead
    }
  } finally {
    await input.close()
  }
}

/** Puts `source` at `path` in the folder with permission bits `mode`, replacing what is there; parents are created. */
export async function writeInto(root: FileRoot, path: string, source: Source, mode: number, guard: ProtectedIndex): Promise<void> {
  const { parts, name } = split(path, root.id)
  const chain = (await walkDown(root, parts, guard, true))!
  const target = join(chain.directory, name)
  const existing = await lstat(target, { bigint: true }).catch(() => undefined)
  if (existing?.isDirectory() || (existing && guard.has(target, existing)) || (await guard.paths.contains(target))) throw refused()
  const temp = join(chain.directory, `.latch-restore-${randomUUID()}.tmp`)
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
  try {
    const created = await handle.stat({ bigint: true })
    // Nothing is written into a directory that was swapped after the walk.
    await unchanged(root, chain, temp)
    if (!same(await lstat(temp, { bigint: true }), created)) throw refused()
    await copyInto(handle, source)
    await handle.chmod(mode & 0o777)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(temp).catch(() => {})
    throw error
  }
  try {
    await handle.close()
    await unchanged(root, chain, temp)
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
  await syncDirectory(chain.directory).catch(() => {})
}

/** Removes the regular file at `path` when `check` accepts it, read through its own handle. Missing counts as removed. */
export async function removeFrom(
  root: FileRoot,
  path: string,
  guard: ProtectedIndex,
  check: (handle: FileHandle, info: BigIntStats) => Promise<boolean>,
): Promise<void> {
  const { parts, name } = split(path, root.id)
  const chain = await walkDown(root, parts, guard, false)
  if (!chain) return
  const target = join(chain.directory, name)
  const before = await lstat(target, { bigint: true }).catch(() => undefined)
  if (!before) return
  if (!before.isFile() || guard.has(target, before) || (await guard.paths.contains(target))) throw refused()
  const handle = await open(target, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw refused()
  })
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile() || !same(info, before) || !(await check(handle, info))) throw refused()
  } finally {
    await handle.close()
  }
  await unchanged(root, chain, target)
  const now = await lstat(target, { bigint: true }).catch(() => undefined)
  if (!now) return
  if (!same(now, before)) throw refused()
  await unlink(target)
  await syncDirectory(chain.directory).catch(() => {})
}
