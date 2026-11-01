import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rmdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { AppError } from '@latch/sdk'
import { sha256Hex, writeFileAtomic } from '@latch/core/node-kit'
import { z } from 'zod'
import { codeOf } from './http-util.ts'
import { canonicalPath } from './paths.ts'

/**
 * Folders of their own for Agent sessions outside a saved project, while the Host uses its default start directory:
 * `<start directory>/<yyyymmdd>-<4 hex>`, made 0700 when the session starts and never an entry that already exists.
 * Each is a directory directly inside the start directory, which every session there could already use, so listing it
 * for the drivers grants nothing new. Latch never removes one that a session was created in; deleting the session
 * keeps its folder and the files in it.
 */

export const SESSION_FOLDER_NAME = /^\d{8}-[0-9a-f]{4}$/u

/** How long a folder made for a start that has not created its session yet (an L3 start waiting for its confirmation) is kept. */
const PENDING_TTL_MS = 10 * 60_000
/** The in-memory cache lifetime; started requests retain their durable mapping. */
const CREATED_TTL_MS = 60 * 60_000
const REQUEST_LIMIT = 512
const ATTEMPTS = 16
const RECORD_FILE = 'session-folders.json'
const storedFolderSchema = z.object({ name: z.string().regex(SESSION_FOLDER_NAME), rootHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
const recordsSchema = z
  .object({ version: z.literal(1), folders: z.record(z.string().regex(/^[a-f0-9]{64}$/u), storedFolderSchema) })
  .strict()

/** The folder's name: the Host's local date and four hex characters. */
export function sessionFolderName(at: Date, suffix: string): string {
  const pad = (value: number, width: number) => String(value).padStart(width, '0')
  return `${pad(at.getFullYear(), 4)}${pad(at.getMonth() + 1, 2)}${pad(at.getDate(), 2)}-${suffix}`
}

function unavailable(): AppError {
  return new AppError(409, 'session-folder-unavailable', '没能在默认文件夹中为这个会话新建文件夹，会话没有开始。请重试。')
}

interface RequestFolder {
  at: number
  /** Settles once the folder exists; a failed make leaves the map. */
  made: Promise<{ name: string; path: string }>
  path?: string
  created: boolean
  /** A driver is creating the session in it now; it never expires meanwhile. */
  starting?: boolean
}

export interface SessionFolderOptions {
  /** Private data directory for durable request-to-folder mappings. */
  dataDir?: string
  /** The start directory as the Host was given it. */
  root: string
  /** Its `canonicalPath` at startup: a folder is made only while the start directory is still there. */
  canonicalRoot: string
  /** The date in the name. */
  clock: () => number
  /** Expiry of requests' folders. */
  now: () => number
  /** Tests: the four hex characters; default random. */
  suffix?: () => string
  log: (text: string) => void
}

export class SessionFolders {
  /** By request ID: a retried request, and the second request of an L3 start after its confirmation, get the same folder. */
  private readonly requests = new Map<string, RequestFolder>()
  /** Folders sessions were created in during this run, listed even when the session metadata could not be written. */
  private readonly made = new Set<string>()
  private recorded = new Map<string, z.infer<typeof storedFolderSchema>>()
  private loading?: Promise<void>
  private writes = Promise.resolve()

  constructor(private readonly options: SessionFolderOptions) {}

  start(): Promise<void> {
    return (this.loading ??= (async () => {
      if (!this.options.dataDir) return
      let text: string
      try {
        text = await readFile(join(this.options.dataDir, RECORD_FILE), 'utf8')
      } catch (error) {
        if (codeOf(error) === 'ENOENT') return
        throw error
      }
      try {
        const record = recordsSchema.parse(JSON.parse(text))
        this.recorded = new Map(Object.entries(record.folders))
      } catch {
        throw new AppError(500, 'config-corrupt', '会话文件夹的请求记录无法读取，原文件已保留。')
      }
    })())
  }

  /** The folder for a start request: made on the first ask, the same one for a retry with the same request ID. */
  async allocate(requestId: string): Promise<{ name: string; path: string }> {
    await this.start()
    // Expired requests leave the map before the lookup, which no await separates from the insertion below.
    const stale = this.expire()
    const removing = Promise.all(stale.map(path => rmdir(path).catch(() => {})))
    const known = this.requests.get(requestId)
    if (known) {
      await removing
      return known.made
    }
    const recorded = this.recorded.get(sha256Hex(requestId))
    if (recorded) {
      if (recorded.rootHash !== sha256Hex(this.options.canonicalRoot)) throw unavailable()
      const folder = { name: recorded.name, path: join(this.options.root, recorded.name) }
      await removing
      if (!(await this.verify(folder.path))) throw unavailable()
      this.made.add(folder.path)
      this.requests.set(requestId, { at: this.options.now(), made: Promise.resolve(folder), path: folder.path, created: true })
      return folder
    }
    const entry: RequestFolder = { at: this.options.now(), made: removing.then(() => this.make()), created: false }
    this.requests.set(requestId, entry)
    try {
      const folder = await entry.made
      entry.path = folder.path
      return folder
    } catch (error) {
      if (this.requests.get(requestId) === entry) this.requests.delete(requestId)
      throw error
    }
  }

  /** A driver is about to create the session in the request's folder. */
  async starting(requestId: string): Promise<void> {
    await this.start()
    const entry = this.requests.get(requestId)
    if (!entry?.path) throw unavailable()
    entry.starting = true
    const hash = sha256Hex(requestId)
    const name = basename(entry.path)
    const write = this.writes.then(async () => {
      if (this.recorded.has(hash)) return
      const next = new Map(this.recorded)
      next.set(hash, { name, rootHash: sha256Hex(this.options.canonicalRoot) })
      if (this.options.dataDir)
        await writeFileAtomic(
          join(this.options.dataDir, RECORD_FILE),
          `${JSON.stringify({ version: 1, folders: Object.fromEntries(next) })}\n`,
        )
      this.recorded = next
    })
    this.writes = write.catch(() => {})
    try {
      await write
    } catch (error) {
      entry.starting = false
      throw error
    }
  }

  /** The session was created in the request's folder: it stays, whatever happens to the request later. */
  created(requestId: string): void {
    const entry = this.requests.get(requestId)
    if (!entry?.path) return
    entry.starting = false
    entry.created = true
    entry.at = this.options.now()
    this.made.add(entry.path)
  }

  /** The start failed before any session was created in the request's folder: the folder goes if it is still empty. */
  async release(requestId: string, definitive = false): Promise<void> {
    const entry = this.requests.get(requestId)
    if (!entry || entry.created) return
    const hash = sha256Hex(requestId)
    if (this.recorded.has(hash)) {
      if (!definitive) {
        entry.starting = false
        entry.at = this.options.now()
        return
      }
      const write = this.writes.then(async () => {
        const next = new Map(this.recorded)
        next.delete(hash)
        if (this.options.dataDir)
          await writeFileAtomic(
            join(this.options.dataDir, RECORD_FILE),
            `${JSON.stringify({ version: 1, folders: Object.fromEntries(next) })}\n`,
          )
        this.recorded = next
      })
      this.writes = write.catch(() => {})
      await write
    }
    this.requests.delete(requestId)
    if (entry.path) await rmdir(entry.path).catch(() => {})
  }

  /** Directories a driver may accept as a new or existing session's `cwd`: the ones made here and those `recorded`. */
  paths(recorded: Iterable<string>): string[] {
    const paths = new Set<string>(this.made)
    for (const folder of this.recorded.values())
      if (folder.rootHash === sha256Hex(this.options.canonicalRoot)) paths.add(join(this.options.root, folder.name))
    for (const entry of this.requests.values()) if (entry.path) paths.add(entry.path)
    for (const name of recorded) if (SESSION_FOLDER_NAME.test(name)) paths.add(join(this.options.root, name))
    return [...paths]
  }

  /**
   * Whether `path` is, now, a session folder: named like one, a real directory (not a link) and directly inside the
   * start directory. A folder replaced by a link to somewhere else no longer counts.
   */
  async verify(path: string | undefined): Promise<boolean> {
    if (typeof path !== 'string' || !SESSION_FOLDER_NAME.test(basename(path))) return false
    try {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) return false
      return (await canonicalPath(dirname(await realpath(path)))) === this.options.canonicalRoot
    } catch {
      return false
    }
  }

  private async make(): Promise<{ name: string; path: string }> {
    const { root, canonicalRoot } = this.options
    try {
      // The default start directory is created on demand, as at startup.
      await mkdir(root, { recursive: true, mode: 0o700 })
    } catch (error) {
      this.options.log(`默认文件夹无法创建（${codeOf(error) ?? 'error'}），没有为会话新建文件夹。`)
      throw unavailable()
    }
    if ((await canonicalPath(root).catch(() => undefined)) !== canonicalRoot)
      throw new AppError(409, 'session-folder-unavailable', '默认文件夹已不在 Host 启动时的位置，没有为会话新建文件夹。请重启 Host。')
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const suffix = this.options.suffix?.() ?? randomBytes(2).toString('hex')
      const name = sessionFolderName(new Date(this.options.clock()), suffix)
      if (!SESSION_FOLDER_NAME.test(name)) throw unavailable()
      const path = join(root, name)
      try {
        // Without `recursive`: an entry of that name, whatever it is, is never reused.
        await mkdir(path, { mode: 0o700 })
      } catch (error) {
        if (codeOf(error) === 'EEXIST') continue
        this.options.log(`会话文件夹无法创建（${codeOf(error) ?? 'error'}）。`)
        throw unavailable()
      }
      // Exactly 0700 whatever the umask, on the directory just made: opened without following a link.
      const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        await handle.chmod(0o700)
      } finally {
        await handle.close()
      }
      return { name, path }
    }
    this.options.log('默认文件夹中的会话文件夹名称连续重复，没有为会话新建文件夹。')
    throw unavailable()
  }

  /**
   * Drops expired requests, oldest first while there are too many. Returns the folders of those no session was
   * created in, for the caller to remove if they are still empty.
   */
  private expire(): string[] {
    const now = this.options.now()
    const stale: string[] = []
    for (const [id, entry] of this.requests) {
      if (!entry.path || entry.starting) continue
      const expired = now - entry.at > (entry.created ? CREATED_TTL_MS : PENDING_TTL_MS)
      if (expired || this.requests.size > REQUEST_LIMIT) {
        this.requests.delete(id)
        if (!entry.created && !this.recorded.has(sha256Hex(id))) stale.push(entry.path)
      }
    }
    return stale
  }
}
