import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { RelayDirectoryCache, type DirectoryStorage } from '@latch/link-client'
import { directoryEpochInput, type NativeDirectorySource } from '@latch/link-wire'
import { sha256Hex, writeFileAtomic } from '@latch/core/node-kit'
import { AppError } from '@latch/sdk'
import type { FetchLike } from '../egress.ts'
import type { RelayProfiles } from './profiles.ts'
import { directoryConfigHash, directorySource } from './directory-config.ts'

const unavailable = () => new AppError(503, 'native-directory-unavailable', '连接地址更新暂时不可用，请稍后重试')
interface DirectoryOptions {
  dataDir: string
  profiles: RelayProfiles
  fetch: FetchLike
  changed?(): void
  now?: () => number
  random?: () => number
}

async function storage(dataDir: string): Promise<DirectoryStorage> {
  const folder = join(dataDir, 'native', 'directories'),
    path = join(folder, 'trust.json'),
    uid = process.getuid?.()
  await mkdir(folder, { mode: 0o700, recursive: true })
  const info = await lstat(folder)
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || (uid !== undefined && info.uid !== uid)) throw unavailable()
  return {
    async read() {
      let handle
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw unavailable()
      }
      try {
        const file = await handle.stat()
        if (!file.isFile() || file.size > 98_304 || file.mode & 0o077 || (uid !== undefined && file.uid !== uid)) throw unavailable()
        return await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
    },
    async write(value) {
      await writeFileAtomic(path, value)
    },
  }
}

/** One bounded refresh owner. Network failures never reset durable trust or add an observer. */
export class HostRelayDirectory {
  private cache?: RelayDirectoryCache
  private sourceHash = ''
  private ready = false
  private closed = false
  private pending?: Promise<void>
  private loading = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private abort?: AbortController
  private nextAttempt = 0
  private constructor(private readonly options: DirectoryOptions) {}
  static async open(options: DirectoryOptions): Promise<HostRelayDirectory> {
    const service = new HostRelayDirectory(options)
    await service.configure()
    return service
  }
  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
  configure(): Promise<void> {
    const operation = this.loading
      .then(async () => {
        if (this.closed) return
        this.abort?.abort()
        clearTimeout(this.timer)
        await this.pending?.catch(() => {})
        this.ready = false
        const state = this.options.profiles.snapshot(),
          config = state.directory
        this.sourceHash = directoryConfigHash(config)
        if (!config) {
          await this.cache?.retryPersistence().catch(() => {})
          this.ready = true
          return
        }
        await this.cache?.retryPersistence()
        this.cache = await RelayDirectoryCache.open(
          directorySource(config, state.directoryFloor),
          await storage(this.options.dataDir),
          () => this.now(),
        )
        await this.persistFloors()
        this.ready = true
        this.nextAttempt = 0
        this.schedule(0)
      })
      .catch(() => {
        this.ready = false
        throw unavailable()
      })
    this.loading = operation.catch(() => {})
    return operation
  }
  private current(): boolean {
    return !this.closed && this.sourceHash === directoryConfigHash(this.options.profiles.snapshot().directory)
  }
  sources(): NativeDirectorySource | undefined {
    if (!this.options.profiles.snapshot().directory) return
    if (!this.ready || !this.current() || !this.cache) throw unavailable()
    try {
      return this.cache.sources()
    } catch {
      throw unavailable()
    }
  }
  epoch(): string {
    try {
      const source = this.sources()
      return sha256Hex(directoryEpochInput(source))
    } catch {
      return sha256Hex('directory-unavailable')
    }
  }
  status(): { ready: boolean; rootGeneration: number; generation: number } {
    return {
      ...(this.cache?.status() ?? { generation: 0, rootGeneration: 0, ready: false }),
      ready: Boolean(this.options.profiles.snapshot().directory && this.ready && this.current() && this.cache?.status().ready),
    }
  }
  candidates(relayId: string, spki: string): Array<{ url: string; address: string }> {
    if (!this.options.profiles.snapshot().directory || !this.ready || !this.current()) return []
    return this.cache?.candidates(Buffer.from(relayId, 'hex'), Buffer.from(spki, 'hex')) ?? []
  }
  private async persistFloors(): Promise<void> {
    const source = this.cache?.sources()
    if (source?.minimum)
      await this.options.profiles.saveDirectoryFloor(this.sourceHash, {
        minimum: { generation: source.minimum.generation, hash: Buffer.from(source.minimum.hash).toString('hex') },
        ...(source.minimumOnline
          ? { minimumOnline: { generation: source.minimumOnline.generation, hash: Buffer.from(source.minimumOnline.hash).toString('hex') } }
          : {}),
      })
  }
  private schedule(ms: number): void {
    clearTimeout(this.timer)
    if (this.closed) return
    this.timer = setTimeout(() => {
      void this.refresh().catch(() => {})
    }, ms)
    this.timer.unref()
  }
  refresh(): Promise<void> {
    if (this.pending) return this.pending
    if (!this.ready || !this.options.profiles.snapshot().directory || !this.cache || !this.current() || this.now() < this.nextAttempt)
      return Promise.resolve()
    const operation = this.update()
    this.pending = operation
    void operation
      .finally(() => {
        if (this.pending === operation) this.pending = undefined
      })
      .catch(() => {})
    return operation
  }
  private async update(): Promise<void> {
    const cache = this.cache!,
      mirrors = this.options.profiles.snapshot().directory?.mirrors ?? []
    this.nextAttempt = this.now() + 30_000
    let success = false
    try {
      for (const mirror of mirrors) {
        if (!this.current()) return
        const abort = new AbortController(),
          timeout = setTimeout(() => abort.abort(), 5000)
        timeout.unref()
        this.abort = abort
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        try {
          const response = await this.options.fetch(mirror, {
            method: 'GET',
            redirect: 'error',
            credentials: 'omit',
            signal: abort.signal,
            headers: { accept: 'application/octet-stream', 'cache-control': 'no-store' },
          })
          if (response.status !== 200 || response.redirected || !response.body) {
            await response.body?.cancel()
            throw unavailable()
          }
          const declared = response.headers.get('content-length')
          if (declared && (!/^[0-9]+$/u.test(declared) || Number(declared) > 32_768)) {
            await response.body.cancel()
            throw unavailable()
          }
          reader = response.body.getReader()
          const chunks: Uint8Array[] = []
          let count = 0
          for (;;) {
            const result = await reader.read()
            if (abort.signal.aborted || !this.current()) throw unavailable()
            if (result.done) break
            count += result.value.length
            if (count > 32_768) throw unavailable()
            chunks.push(result.value)
          }
          if (declared && count !== Number(declared)) throw unavailable()
          const before = this.epoch()
          try {
            await cache.adopt(Buffer.concat(chunks, count))
          } finally {
            // Root revocations commit even when the accompanying online addresses are rejected.
            this.ready = false
            await this.persistFloors()
            this.ready = true
            if (before !== this.epoch()) this.options.changed?.()
          }
          success = true
          break
        } catch {
          /* Mirrors are hints; a failed fetch or signature never replaces the fixed authority. */
        } finally {
          clearTimeout(timeout)
          await reader?.cancel().catch(() => {})
          if (this.abort === abort) this.abort = undefined
        }
      }
    } finally {
      if (this.current()) {
        const wait = success ? 6 * 3600_000 * (0.9 + (this.options.random?.() ?? Math.random()) * 0.2) : 30_000
        this.nextAttempt = this.now() + wait
        this.schedule(wait)
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.timer)
    this.abort?.abort()
    await this.loading
    await this.pending?.catch(() => {})
    await this.cache?.settled()
    await this.cache?.retryPersistence().catch(() => {})
  }
}
