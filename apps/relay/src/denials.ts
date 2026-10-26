import { createHash } from 'node:crypto'
import { lstat, mkdir, opendir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { hex, unhex, UTC_DAY } from '@latch/link-wire'
import { readPrivate, writePrivate } from './private-store.ts'
const schema = z
  .object({
    version: z.literal(1),
    day: z.number().int().min(0).max(0xffffffff),
    tags: z.array(z.string().regex(/^[a-f0-9]{32}$/u)).max(8192),
  })
  .strict()
type Row = z.infer<typeof schema> & { bytes: number }
/** Only keyed route digests and revoked opaque tags persist; no IP, route ID, pass or resume token. */
export class DenialStore {
  private readonly rows = new Map<string, Row>()
  private readonly directory: string
  private readonly maxRoutes: number
  private readonly maxBytes: number
  private readonly now: () => number
  private queue: Promise<void> = Promise.resolve()
  private healthy = true
  private sweeping?: Promise<void>
  private closed = false
  private constructor(options: { dataDir: string; maxRoutes: number; maxBytes: number; now?: () => number }) {
    this.directory = join(options.dataDir, 'denials')
    this.maxRoutes = options.maxRoutes
    this.maxBytes = options.maxBytes
    this.now = options.now ?? Date.now
  }
  static async open(options: { dataDir: string; maxRoutes: number; maxBytes: number; now?: () => number }): Promise<DenialStore> {
    const root = await lstat(options.dataDir)
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0) throw new Error('Invalid relay state root')
    const store = new DenialStore(options)
    await mkdir(store.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(store.directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('Invalid denial directory')
    const directory = await opendir(store.directory)
    let total = 0
    for await (const entry of directory) {
      if (/^[a-f0-9]{64}\.json\.[a-f0-9]{16}\.tmp$/u.test(entry.name) && entry.isFile()) {
        await unlink(join(store.directory, entry.name))
        continue
      }
      if (!/^[a-f0-9]{64}\.json$/u.test(entry.name) || !entry.isFile() || store.rows.size >= store.maxRoutes)
        throw new Error('Invalid denial state directory')
      const text = await readPrivate(join(store.directory, entry.name), 300_000)
      if (text === undefined) throw new Error('Denial state changed')
      const row = schema.parse(JSON.parse(text) as unknown)
      if (new Set(row.tags).size !== row.tags.length) throw new Error('Invalid denial state')
      total += Buffer.byteLength(text)
      if (total > store.maxBytes) throw new Error('Denial state budget exceeded')
      store.rows.set(entry.name.slice(0, -5), { ...row, bytes: Buffer.byteLength(text) })
    }
    await store.sweep()
    return store
  }
  private key(route: Uint8Array): string {
    if (route.length !== 16) throw new Error('Invalid denial route')
    return createHash('sha256').update('latch-relay-deny-store-v1\0').update(route).digest('hex')
  }
  private expired(day: number): boolean {
    return this.now() > ((day + 1) * UTC_DAY + 900) * 1000
  }
  async get(route: Uint8Array, day: number): Promise<Uint8Array[]> {
    if (!this.healthy || this.closed) throw new Error('Denial state unavailable')
    const row = this.rows.get(this.key(route))
    if (!row || this.expired(row.day)) return []
    if (row.day !== day) throw new Error('Denial route date mismatch')
    return row.tags.map(tag => unhex(tag, 16))
  }
  add(route: Uint8Array, day: number, tags: readonly Uint8Array[]): Promise<number> {
    if (this.closed) return Promise.reject(new Error('Denial store closed'))
    if (tags.length > 1024) return Promise.reject(new Error('Denial batch limit'))
    const key = this.key(route),
      values = tags.map(tag => {
        if (tag.length !== 16) throw new Error('Invalid denial tag')
        return hex(tag)
      })
    let count = 0
    const work = this.queue.then(async () => {
      if (!this.healthy || this.expired(day)) throw new Error('Denial state unavailable')
      const old = this.rows.get(key),
        merged = new Set(old?.tags ?? [])
      if (old && old.day !== day) throw new Error('Denial route date mismatch')
      for (const tag of values) merged.add(tag)
      if (merged.size > 8192 || (!old && this.rows.size >= this.maxRoutes)) throw new RangeError('Denial capacity exceeded')
      count = merged.size
      const value = schema.parse({ version: 1, day, tags: [...merged].sort() }),
        text = `${JSON.stringify(value)}\n`,
        bytes = Buffer.byteLength(text)
      const used = [...this.rows.values()].reduce((sum, row) => sum + row.bytes, 0) - (old?.bytes ?? 0)
      if (used + bytes > this.maxBytes) throw new RangeError('Denial capacity exceeded')
      try {
        await writePrivate(join(this.directory, `${key}.json`), text)
      } catch {
        this.healthy = false
        throw new Error('Denial persistence failed')
      }
      this.rows.set(key, { ...value, bytes })
    })
    this.queue = work.catch(() => {})
    return work.then(() => count)
  }
  sweep(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.sweeping) return this.sweeping
    const work = this.queue.then(async () => {
      for (const [key, value] of this.rows)
        if (this.expired(value.day)) {
          await unlink(join(this.directory, `${key}.json`))
          this.rows.delete(key)
        }
    })
    this.queue = work.catch(() => {
      this.healthy = false
    })
    this.sweeping = work.finally(() => {
      this.sweeping = undefined
    })
    return this.sweeping
  }
  status(): { healthy: boolean; routes: number; tags: number; bytes: number } {
    return {
      healthy: this.healthy,
      routes: this.rows.size,
      tags: [...this.rows.values()].reduce((sum, row) => sum + row.tags.length, 0),
      bytes: [...this.rows.values()].reduce((sum, row) => sum + row.bytes, 0),
    }
  }
  async close(): Promise<void> {
    this.closed = true
    await this.queue
  }
}
