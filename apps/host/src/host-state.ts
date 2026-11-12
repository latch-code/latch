import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants, readFileSync, unlinkSync } from 'node:fs'
import { request } from 'node:http'
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { uptime } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { writeFileAtomic } from '@latch/core/node-kit'

/** `<data>/host.json`: how local tools find a running Host. It holds no credential. */
export const hostStateSchema = z
  .object({
    version: z.literal(2),
    pid: z.number().int().positive(),
    hostId: z.string().regex(/^[a-z2-7]{52}$/),
    instanceId: z.string().uuid(),
    socketPath: z.string(),
    loopbackOrigin: z.string().url(),
    tlsOrigin: z.string().url().nullable(),
    startedAt: z.string(),
    dataDir: z.string(),
  })
  .strict()
export type HostState = z.infer<typeof hostStateSchema>

const HOST_FILE = 'host.json'

/** Atomic 0600 write: unique temp file, fsync, rename, fsync of the directory. */
export async function writeHostState(dataDir: string, state: HostState): Promise<void> {
  const value = hostStateSchema.parse(state)
  await writeFileAtomic(join(dataDir, HOST_FILE), JSON.stringify(value) + '\n', { prefix: '.host-' })
}

/** Missing, unreadable and older-format files read as absent. */
export async function readHostState(dataDir: string): Promise<HostState | undefined> {
  try {
    return hostStateSchema.parse(JSON.parse(await readFile(join(dataDir, HOST_FILE), 'utf8')))
  } catch {
    return undefined
  }
}

/**
 * For a host.json that readHostState reads as absent (an older build's format, or a damaged file): the pid it records,
 * if any. `present: false` only when there is no file at all.
 */
export async function readRecordedPid(dataDir: string): Promise<{ present: false } | { present: true; pid?: number }> {
  let text: string
  try {
    text = await readFile(join(dataDir, HOST_FILE), 'utf8')
  } catch (error) {
    return codeOf(error) === 'ENOENT' ? { present: false } : { present: true }
  }
  try {
    const pid = (JSON.parse(text) as { pid?: unknown } | null)?.pid
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? { present: true, pid } : { present: true }
  } catch {
    return { present: true }
  }
}

/** Removes host.json only while it still describes this instance, so a newer Host's record survives. */
export async function removeHostState(dataDir: string, instanceId: string): Promise<void> {
  const current = await readHostState(dataDir)
  if (current?.instanceId === instanceId) await unlink(join(dataDir, HOST_FILE)).catch(() => {})
}

const LOCK_FILE = 'host.lock'
const lockSchema = z
  .object({
    pid: z.number().int().positive(),
    instanceId: z.string().uuid(),
    role: z.enum(['host', 'cli']),
    /** Seconds since the epoch at which the machine booted. Locks written without it are judged by their pid alone. */
    bootTime: z.number().int().positive().optional(),
  })
  .strict()
export type DataDirLockHolder = z.infer<typeof lockSchema>

export interface DataDirLock {
  readonly instanceId: string
  /** Removes the lock while it still holds this record; a no-op after the first call. */
  release(): Promise<void>
  /** The same, for a process 'exit' handler. */
  releaseSync(): void
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

const run = promisify(execFile)
/** Two reads of the boot time in one boot can differ when the clock is set; a reboot moves it by far more. */
const BOOT_TIME_TOLERANCE_SECONDS = 30
let bootTimeRead: Promise<number> | undefined

async function readBootTime(): Promise<number> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await run('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { env: {}, timeout: 2_000 })
      const seconds = /\bsec = (\d+)/u.exec(stdout)?.[1]
      if (seconds) return Number(seconds)
    } else if (process.platform === 'linux') {
      const seconds = /^btime (\d+)$/mu.exec(await readFile('/proc/stat', 'utf8'))?.[1]
      if (seconds) return Number(seconds)
    }
  } catch {
    /* fall back to the uptime */
  }
  return Math.round(Date.now() / 1000 - uptime())
}

/** Seconds since the epoch at which this machine booted: kern.boottime on macOS, btime on Linux, else from the uptime. */
export function bootTime(): Promise<number> {
  bootTimeRead ??= readBootTime()
  return bootTimeRead
}

/** A lock is held while its pid is alive and it was written in this boot: after a reboot the pid may belong to another process. */
async function holds(holder: DataDirLockHolder): Promise<boolean> {
  if (!processAlive(holder.pid)) return false
  return holder.bootTime === undefined || Math.abs(holder.bootTime - (await bootTime())) <= BOOT_TIME_TOLERANCE_SECONDS
}

/** undefined: no lock file. `holder` is missing when the file cannot be trusted (partly written, corrupt or not a regular file). */
async function readLockFile(path: string): Promise<{ text: string; holder?: DataDirLockHolder } | undefined> {
  let text: string
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!(await handle.stat()).isFile()) return { text: '' }
      text = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined
    return { text: '' }
  }
  try {
    return { text, holder: lockSchema.parse(JSON.parse(text)) }
  } catch {
    return { text }
  }
}

function lockedError(path: string, holder: DataDirLockHolder): AppError {
  const message =
    holder.role === 'host'
      ? `这个数据目录已有 Host 在运行或正在启动（进程 ${holder.pid}）。请先停止它（pnpm stop），或使用其他 --data-dir；如果确认没有 Host 在运行，删除锁文件 ${path} 后重试。`
      : `另一个 latch 命令正在使用这个数据目录（进程 ${holder.pid}），请等它结束后重试；如果确认没有 latch 命令或 Host 在运行，删除锁文件 ${path} 后重试。`
  return new AppError(409, 'data-dir-locked', message, { pid: holder.pid, role: holder.role, path })
}

/** Creates a 0600 file only if nothing is at the path. false: something is. */
async function createExclusive(path: string, content: string): Promise<boolean> {
  let handle
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return false
    throw error
  }
  let written = false
  try {
    await handle.writeFile(content)
    await handle.sync()
    written = true
  } finally {
    await handle.close()
    if (!written) await unlink(path).catch(() => {})
  }
  return true
}

/**
 * Creates host.lock only if there is none. It appears with its record already written (a hard link to a synced temp
 * file), so a process killed part-way never leaves an empty lock that would need deleting by hand. false: a lock exists.
 */
async function createLockFile(dataDir: string, path: string, content: string): Promise<boolean> {
  const temporary = join(dataDir, `.host-lock-${randomUUID()}.new`)
  await createExclusive(temporary, content)
  try {
    await link(temporary, path)
    return true
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return false
    // A file system without hard links: the lock is written in place, and readers wait out the moment it is empty.
    return await createExclusive(path, content)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/**
 * `<data>/.host-lock-takeover`: a directory that exists while one process replaces a stale host.lock, holding a single
 * marker file named by that process's token. It is only ever put in place whole, by renaming a prepared directory, and
 * rename() fails while the target holds a marker, so it never holds two. A marker is removed by its own name, and the
 * directory only while it is empty, so clearing a stale guard can never remove one taken meanwhile.
 */
const TAKEOVER_DIR = '.host-lock-takeover'
/** A takeover takes milliseconds. A marker this old belongs to a process that died or hung part-way. */
const TAKEOVER_STALE_MS = 30_000
/** The holder abandons a takeover it has not finished by then, well before anyone may count its marker as stale. */
const TAKEOVER_BUDGET_MS = 10_000
const takeoverMarkerSchema = z.object({ pid: z.number().int().positive() }).strict()
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

interface TakeoverGuard {
  /** The marker is still in place and the takeover is within its budget. */
  current(): Promise<boolean>
  release(): Promise<void>
}

/** undefined: another process holds the guard (a stale one is cleared on the way, for the next attempt). */
async function enterTakeover(dataDir: string): Promise<TakeoverGuard | undefined> {
  const guard = join(dataDir, TAKEOVER_DIR)
  const token = randomUUID()
  const prepared = join(dataDir, `.host-lock-${token}.claim`)
  const started = performance.now()
  await mkdir(prepared, { mode: 0o700 })
  try {
    await writeFile(join(prepared, token), JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' })
    await rename(prepared, guard)
  } catch (error) {
    await rm(prepared, { recursive: true, force: true })
    // EPERM: Windows will not rename onto an existing directory, even an empty one.
    if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EPERM'].includes(codeOf(error) ?? '')) throw error
    await clearStaleTakeover(guard)
    return undefined
  }
  const marker = join(guard, token)
  return {
    async current() {
      if (performance.now() - started > TAKEOVER_BUDGET_MS) return false
      return lstat(marker).then(
        stats => stats.isFile(),
        () => false,
      )
    },
    async release() {
      await unlink(marker).catch(() => {})
      await rmdir(guard).catch(() => {})
    },
  }
}

async function takeoverMarkerStale(path: string): Promise<boolean> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) return false
      if (Math.abs(Date.now() - stats.mtimeMs) > TAKEOVER_STALE_MS) return true
      const marker = takeoverMarkerSchema.safeParse(JSON.parse(await handle.readFile('utf8')))
      return marker.success && !processAlive(marker.data.pid)
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

async function clearStaleTakeover(guard: string): Promise<void> {
  let stats
  try {
    stats = await lstat(guard)
  } catch {
    return
  }
  if (!stats.isDirectory()) {
    // Never one of ours, and unlink() cannot remove a guard directory put in its place meanwhile.
    if (Math.abs(Date.now() - stats.mtimeMs) > TAKEOVER_STALE_MS) await unlink(guard).catch(() => {})
    return
  }
  for (const name of await readdir(guard).catch(() => [])) {
    if (TOKEN.test(name) && (await takeoverMarkerStale(join(guard, name)))) await unlink(join(guard, name)).catch(() => {})
  }
  // Fails while a marker is in place, including one renamed in since the check.
  await rmdir(guard).catch(() => {})
}

/**
 * Replaces a stale host.lock, serialised by the takeover guard. Inside it nothing else can change an existing lock file:
 * creation needs the path to be free, a release removes only its own record, and a live holder's record is not stale.
 */
async function takeOver(dataDir: string, path: string, content: string): Promise<'acquired' | 'retry'> {
  const guard = await enterTakeover(dataDir)
  if (!guard) return 'retry'
  try {
    const current = await readLockFile(path)
    if (!current) return (await createLockFile(dataDir, path, content)) ? 'acquired' : 'retry'
    if (!current.holder) return 'retry'
    if (await holds(current.holder)) throw lockedError(path, current.holder)
    if (!(await guard.current())) return 'retry'
    const aside = join(dataDir, `.host-lock-${randomUUID()}.stale`)
    try {
      await rename(path, aside)
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return 'retry'
      throw error
    }
    const moved = await readFile(aside, 'utf8').catch(() => '')
    // Only if the clock jumped or this process hung past its budget; the record goes back and is read again.
    if (moved !== current.text) await link(aside, path).catch(() => {})
    await unlink(aside).catch(() => {})
    if (moved !== current.text) return 'retry'
    // A process that found the path free in between holds the lock instead, and the next attempt reports it.
    return (await createLockFile(dataDir, path, content)) ? 'acquired' : 'retry'
  } finally {
    await guard.release()
  }
}

const LEFTOVER = /^\.host-lock-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:new|claim|stale)$/u

/** Entries a process killed part-way through creating or taking over the lock left behind; those in use are milliseconds old. */
async function sweepLeftovers(dataDir: string): Promise<void> {
  await clearStaleTakeover(join(dataDir, TAKEOVER_DIR))
  const names = await readdir(dataDir).catch(() => [] as string[])
  await Promise.all(
    names
      .filter(name => LEFTOVER.test(name))
      .map(async name => {
        const path = join(dataDir, name)
        const stats = await lstat(path).catch(() => undefined)
        if (stats && Math.abs(Date.now() - stats.mtimeMs) > TAKEOVER_STALE_MS)
          await rm(path, { recursive: true, force: true }).catch(() => {})
      }),
  )
}

/**
 * `<data>/host.lock`: one holder per data directory among the processes that take it. start.ts holds it for the life of
 * the Host, offline CLI commands while they run. A lock whose process is gone, or that was written before the last
 * reboot, is taken over (one process at a time, see takeOver); a lock that cannot be read is never guessed at.
 * startServer itself does not take it, so tests can run in-process Hosts.
 */
export async function acquireDataDirLock(dataDir: string, role: DataDirLockHolder['role']): Promise<DataDirLock> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const path = join(dataDir, LOCK_FILE)
  const instanceId = randomUUID()
  const content = `${JSON.stringify({ pid: process.pid, instanceId, role, bootTime: await bootTime() } satisfies DataDirLockHolder)}\n`
  const acquired = async () => {
    await sweepLeftovers(dataDir)
    return lockHandle(path, content, instanceId)
  }
  let unreadable = false
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await delay(20 * attempt)
    if (await createLockFile(dataDir, path, content)) return acquired()
    const current = await readLockFile(path)
    if (!current) continue
    // A lock written in place (no hard links) is empty for a moment, so an unreadable one is read again first.
    unreadable = !current.holder
    if (!current.holder) continue
    if (await holds(current.holder)) throw lockedError(path, current.holder)
    if ((await takeOver(dataDir, path, content)) === 'acquired') return acquired()
  }
  if (unreadable) {
    throw new AppError(
      409,
      'data-dir-lock-invalid',
      `数据目录锁 ${path} 无法读取。请先停止 Host（pnpm stop）；如果确认没有 Host 或 latch 命令在使用这个目录，删除该文件后重试。`,
      { path },
    )
  }
  throw new AppError(
    409,
    'data-dir-locked',
    `无法取得数据目录锁 ${path}，请稍后重试。仍然失败时，先停止 Host（pnpm stop）；如果确认没有 Host 或 latch 命令在使用这个目录，删除该文件后重试。`,
    { path },
  )
}

function lockHandle(path: string, content: string, instanceId: string): DataDirLock {
  let released = false
  return {
    instanceId,
    async release() {
      if (released) return
      released = true
      if ((await readFile(path, 'utf8').catch(() => '')) === content) await unlink(path).catch(() => {})
    },
    releaseSync() {
      if (released) return
      released = true
      try {
        if (readFileSync(path, 'utf8') === content) unlinkSync(path)
      } catch {
        /* already gone */
      }
    },
  }
}

export interface DataDirLockState {
  path: string
  /** Missing when the file cannot be read (partly written, corrupt or not a regular file). */
  holder?: DataDirLockHolder
  /** The holder's process is alive and the lock was written in this boot. */
  held: boolean
}

/** The lock file as it stands; undefined when there is none. */
export async function readDataDirLock(dataDir: string): Promise<DataDirLockState | undefined> {
  const path = join(dataDir, LOCK_FILE)
  const current = await readLockFile(path)
  if (!current) return undefined
  return current.holder ? { path, holder: current.holder, held: await holds(current.holder) } : { path, held: false }
}

export interface HostInfo {
  product: 'Latch'
  version: string
  hostId: string
  instanceId: string
  pid: number
  startedAt: string
  loopbackOrigin: string
  tlsOrigin: string | null
  devMode: boolean
  presence: { status: 'available' | 'unavailable'; message?: string }
  /** Sessions running or waiting for an approval. */
  activeSessions: number
  /** The same, split; absent from older Hosts. */
  activity?: { running: number; waiting: number }
  /** The Host API version the desktop app compares with an update's bundled Host (update-window.ts); absent from older Hosts. */
  protocol?: number
  /** The model gateway's loopback port, which the desktop app keeps its preview tabs from; absent from older Hosts. */
  modelGatewayPort?: number
}

const hostInfoSchema = z.object({
  product: z.literal('Latch'),
  version: z.string(),
  hostId: z.string(),
  instanceId: z.string(),
  pid: z.number().int(),
  startedAt: z.string(),
  loopbackOrigin: z.string(),
  tlsOrigin: z.string().nullable(),
  devMode: z.boolean(),
  presence: z.object({ status: z.enum(['available', 'unavailable']), message: z.string().optional() }),
  activeSessions: z.number().int().nonnegative(),
  activity: z.object({ running: z.number().int().nonnegative(), waiting: z.number().int().nonnegative() }).optional(),
  protocol: z.number().int().positive().optional(),
  modelGatewayPort: z.number().int().min(1).max(65_535).optional(),
})

const MAX_INFO_BYTES = 64 * 1024

/** One anonymous request over host.sock. Resolves with status and parsed JSON (or undefined). */
export function unixRequest(
  socketPath: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = init.body === undefined ? undefined : JSON.stringify(init.body)
    const req = request(
      {
        socketPath,
        path,
        method: init.method ?? 'GET',
        headers: {
          host: 'latch.unix',
          ...init.headers,
          ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) }),
        },
        timeout: init.timeoutMs ?? 2_000,
      },
      response => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > MAX_INFO_BYTES) {
            req.destroy(new Error('response too large'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body: unknown
          try {
            body = text ? JSON.parse(text) : undefined
          } catch {
            body = undefined
          }
          resolve({ status: response.statusCode ?? 0, body })
        })
        response.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(data)
  })
}

/** `GET /link/api/host-info` over the socket. */
export async function queryHostInfo(socketPath: string, timeoutMs = 2_000): Promise<HostInfo> {
  const response = await unixRequest(socketPath, '/link/api/host-info', { timeoutMs })
  if (response.status !== 200) throw new Error(`host-info returned ${response.status}`)
  return hostInfoSchema.parse(response.body)
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

/** A process another user owns (EPERM) counts as alive. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/**
 * Socket dir is a 0700 non-symlink dir owned by this uid, socket owned by this uid, pid alive,
 * host-info pid/hostId/instanceId match. Anything else is not this Host.
 */
export async function verifyHostState(state: HostState, timeoutMs = 2_000): Promise<HostInfo | undefined> {
  try {
    const uid = currentUid()
    const directory = await lstat(dirname(state.socketPath))
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) return
    if (uid !== undefined && directory.uid !== uid) return
    const socket = await lstat(state.socketPath)
    if (!socket.isSocket() || (uid !== undefined && socket.uid !== uid)) return
    if (!processAlive(state.pid)) return
    const info = await queryHostInfo(state.socketPath, timeoutMs)
    if (info.pid !== state.pid || info.hostId !== state.hostId || info.instanceId !== state.instanceId) return
    return info
  } catch {
    return undefined
  }
}
