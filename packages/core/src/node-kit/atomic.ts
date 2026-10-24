import { randomUUID } from 'node:crypto'
import { open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** The file operations `writeFileAtomic` goes through; tests pass their own to inject crashes. */
export interface AtomicWriteFs {
  open(path: string, flags: string, mode?: number): Promise<FileHandle>
  rename(from: string, to: string): Promise<void>
}

export interface AtomicWriteOptions {
  /**
   * Start of the temporary file's name, `.<file name>-` by default; a random UUID and `.tmp` follow. Callers whose
   * temporary names other code recognises pass the prefix it expects.
   */
  prefix?: string
  fs?: AtomicWriteFs
}

const nodeFs: AtomicWriteFs = { open: (path, flags, mode) => open(path, flags, mode), rename }

/** Makes renames in `directory` durable. Windows cannot fsync a directory; there the file fsync before the rename remains. */
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Replaces `path` so a reader sees either the old or the new content, never part of it: writes a new 0600 file next to
 * it (created exclusively under a unique name), fsyncs it, renames it over `path` and fsyncs the directory. The rename
 * replaces a symlink at `path` instead of following it. The temporary file is removed when a step up to the rename fails.
 */
export async function writeFileAtomic(path: string, data: string, options: AtomicWriteOptions = {}): Promise<void> {
  const { prefix = `.${basename(path)}-`, fs = nodeFs } = options
  const directory = dirname(path)
  const temporary = join(directory, `${prefix}${randomUUID()}.tmp`)
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
  try {
    await handle.close()
    await fs.rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
  await syncDirectory(directory)
}
