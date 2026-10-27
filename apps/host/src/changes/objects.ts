// A project's retained file contents, each stored once under the SHA-256 of its bytes, in private 0600 files.
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rename, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const HASH = /^[0-9a-f]{64}$/u
const CHUNK = 1024 * 1024
const CP = '/bin/cp'
const execute = promisify(execFile)

/** Makes an APFS clone of `source` at `target`; rejects when the volume cannot clone. A test seam. */
export type CloneFile = (source: string, target: string) => Promise<void>
/** `/bin/cp -c` is clonefile(2), and fails instead of copying when the volume cannot clone. Node's copyFile never clones on macOS. */
const cloneWithCp: CloneFile = async (source, target) => {
  await execute(CP, ['-c', '--', source, target], { env: {}, timeout: 30_000, maxBuffer: 64 * 1024 })
}

export const isObjectHash = (value: string) => HASH.test(value)

/** SHA-256 of a file's bytes, read through its handle. */
export async function hashHandle(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256'),
    buffer = Buffer.alloc(CHUNK)
  for (let position = 0; ;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    if (!bytesRead) break
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return hash.digest('hex')
}

export class ObjectStore {
  constructor(
    readonly directory: string,
    private readonly clone: CloneFile = process.platform === 'darwin' ? cloneWithCp : () => Promise.reject(new Error('no-clone')),
  ) {}

  pathOf(hash: string): string {
    if (!isObjectHash(hash)) throw new Error('object-hash-invalid')
    return join(this.directory, hash.slice(0, 2), hash)
  }

  /** Fan-out directories known to exist, so each object costs no extra mkdir. */
  private readonly fanouts = new Set<string>()

  private async kept(hash: string, size: number): Promise<boolean> {
    const existing = await lstat(this.pathOf(hash)).catch(() => undefined)
    return existing?.isFile() === true && existing.size === size
  }

  private async place(temp: string, hash: string): Promise<void> {
    const fanout = hash.slice(0, 2)
    if (!this.fanouts.has(fanout)) {
      await mkdir(join(this.directory, fanout), { mode: 0o700 }).catch((error: unknown) => {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      })
      this.fanouts.add(fanout)
    }
    await rename(temp, this.pathOf(hash))
  }

  /** Stores bytes the Host has read; `added` is false when the same content was already kept. */
  async putBytes(bytes: Uint8Array): Promise<{ hash: string; added: boolean }> {
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (await this.kept(hash, bytes.length)) return { hash, added: false }
    const temp = join(this.directory, `.${randomUUID()}.tmp`)
    try {
      await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' })
      await this.place(temp, hash)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
    return { hash, added: true }
  }

  /**
   * Clones the file at `source`, which `handle` holds open, and keeps the clone only when its bytes hash the same as
   * the handle's: the copy goes by path, which a swapped directory could point elsewhere. Undefined when the volume
   * cannot clone or the file changed.
   */
  async putClone(source: string, handle: FileHandle, size: number): Promise<string | undefined> {
    const temp = join(this.directory, `.${randomUUID()}.tmp`)
    try {
      await this.clone(source, temp)
      await chmod(temp, 0o600)
      const copy = await open(temp, constants.O_RDONLY | NOFOLLOW)
      let cloned: string
      try {
        const info = await copy.stat()
        if (!info.isFile() || info.size !== size) throw new Error('clone-size')
        cloned = await hashHandle(copy)
      } finally {
        await copy.close()
      }
      if (cloned !== (await hashHandle(handle))) throw new Error('clone-changed')
      if (await this.kept(cloned, size)) await unlink(temp)
      else await this.place(temp, cloned)
      return cloned
    } catch {
      await unlink(temp).catch(() => {})
      return undefined
    }
  }

  /** The bytes of an object, checked against its hash; a damaged object is removed so the next capture stores it again. */
  async read(hash: string, limit: number): Promise<Uint8Array | undefined> {
    let handle: FileHandle
    try {
      handle = await open(this.pathOf(hash), constants.O_RDONLY | NOFOLLOW)
    } catch {
      return undefined
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > limit) return undefined
      const bytes = await handle.readFile()
      if (createHash('sha256').update(bytes).digest('hex') === hash) return bytes
    } catch {
      return undefined
    } finally {
      await handle.close()
    }
    await unlink(this.pathOf(hash)).catch(() => {})
    return undefined
  }

  /** An object to stream from, checked against its hash first; undefined when it is missing or damaged. */
  async openChecked(hash: string): Promise<FileHandle | undefined> {
    const handle = await open(this.pathOf(hash), constants.O_RDONLY | NOFOLLOW).catch(() => undefined)
    if (!handle) return undefined
    const info = await handle.stat().catch(() => undefined)
    if (info?.isFile() && (await hashHandle(handle).catch(() => undefined)) === hash) return handle
    await handle.close()
    return undefined
  }

  /** Every object on disk, and the temporary files a stopped write left behind. */
  async list(): Promise<{ objects: Set<string>; leftovers: string[] }> {
    const objects = new Set<string>(),
      leftovers: string[] = []
    const top = await readdir(this.directory, { withFileTypes: true }).catch(() => [])
    for (const entry of top) {
      if (entry.isFile() && entry.name.endsWith('.tmp')) leftovers.push(join(this.directory, entry.name))
      if (!entry.isDirectory() || !/^[0-9a-f]{2}$/u.test(entry.name)) continue
      for (const name of await readdir(join(this.directory, entry.name)).catch(() => [])) {
        if (isObjectHash(name) && name.startsWith(entry.name)) objects.add(name)
        else if (name.endsWith('.tmp')) leftovers.push(join(this.directory, entry.name, name))
      }
    }
    return { objects, leftovers }
  }

  async remove(hash: string): Promise<void> {
    await unlink(this.pathOf(hash)).catch(() => {})
  }
}
