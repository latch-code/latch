import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { z } from 'zod'
import { parseIp } from '@latch/link-wire'

const execute = promisify(execFile)
const ip = z
  .string()
  .max(45)
  .refine(value => {
    try {
      parseIp(value)
      return true
    } catch {
      return false
    }
  })
export const networkSnapshotSchema = z.strictObject({
  epoch: z.uuid(),
  interfaces: z
    .array(
      z
        .strictObject({
          name: z.string().regex(/^[a-zA-Z0-9_.-]{1,32}$/u),
          index: z.int().min(1).max(0xffffffff),
          address: ip,
          prefixLength: z.int().min(1).max(128),
          kind: z.enum(['wifi', 'ethernet', 'tunnel']),
          gateway: ip.optional(),
          /** An iPhone or iPad sharing its connection over USB (Personal Hotspot on the cable); `kind` stays `ethernet`. */
          tether: z.literal(true).optional(),
        })
        .refine(
          value =>
            value.prefixLength <= parseIp(value.address).bytes.length * 8
            && (!value.gateway || parseIp(value.gateway).family === parseIp(value.address).family),
        ),
    )
    .max(16),
})
export type NativeNetworkSnapshot = z.infer<typeof networkSnapshotSchema>
export type NativeNetworkInterface = NativeNetworkSnapshot['interfaces'][number]
export interface NativeNetworkService {
  index: number
  port: number
  instance: string
  alternate: string
  addresses: string[]
}
const mac = z
  .string()
  .regex(/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u)
  .refine(value => value !== '00:00:00:00:00:00' && (Number.parseInt(value.slice(0, 2), 16) & 1) === 0)
const neighborsSchema = z.strictObject({ epoch: z.uuid(), peerMac: mac.nullable(), gatewayMac: mac.nullable(), gateway: ip.nullable() })
export type NativeNeighbors = z.infer<typeof neighborsSchema>
export type NativeNetworkStatus = 'off' | 'starting' | 'ready' | 'blocked' | 'conflict'
export interface NativeNetworkBackend {
  snapshot(): Promise<NativeNetworkSnapshot>
  publish(services: NativeNetworkService[], epoch: string): Promise<void>
  neighbors(index: number, source: string): Promise<NativeNeighbors>
  onChange(listener: (snapshot: NativeNetworkSnapshot) => void): () => void
  onStatus(listener: (status: NativeNetworkStatus) => void): () => void
  close(): Promise<void>
}
const eventSchema = z.discriminatedUnion('event', [
  z.strictObject({ version: z.literal(1), event: z.literal('result'), id: z.uuid(), data: z.unknown() }),
  networkSnapshotSchema.extend({ version: z.literal(1), event: z.literal('network') }),
  z.strictObject({
    version: z.literal(1),
    event: z.literal('status'),
    state: z.enum(['ready', 'blocked', 'conflict']),
    index: z.int().min(1).max(0xffffffff),
  }),
])

/** The helper has no discovery key or Host identity; only anonymous labels and private OS metadata cross this pipe. */
export class MacNetworkBackend implements NativeNetworkBackend {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    string,
    { resolve(data: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  private readonly changes = new Set<(snapshot: NativeNetworkSnapshot) => void>()
  private readonly statuses = new Set<(status: NativeNetworkStatus) => void>()
  private readonly exited: Promise<void>
  private ended = false
  private stopping = false
  private failed = false
  private tail = ''
  private constructor(binary: string) {
    this.child = spawn(binary, [], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.resume()
    this.exited = new Promise(resolve => {
      const end = () => {
        if (this.ended) return
        this.ended = true
        this.fail()
        resolve()
      }
      this.child.once('exit', end)
      this.child.once('error', () => {
        if (!this.child.pid) end()
        else this.fail()
      })
    })
    this.child.stdin.on('error', () => this.fail())
    this.child.stdout.on('error', () => this.fail())
    this.child.stdout.on('data', (bytes: Buffer) => this.read(bytes))
  }
  static async open(binary: string): Promise<MacNetworkBackend> {
    if (process.platform !== 'darwin' || !isAbsolute(binary)) throw new Error('Native network component unavailable')
    try {
      const stat = await lstat(binary)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o6022 || !(stat.mode & 0o111)) throw new Error('Invalid component')
      await execute('/usr/bin/codesign', ['--verify', '--strict', binary], { env: {}, timeout: 3000, maxBuffer: 4096 })
      return new MacNetworkBackend(binary)
    } catch {
      throw new Error('Native network component unavailable')
    }
  }
  private fail(): void {
    if (this.failed) return
    this.failed = true
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error('Native network component unavailable'))
    }
    this.pending.clear()
    if (!this.ended) this.child.kill('SIGKILL')
    this.child.stdin.destroy()
    this.child.stdout.destroy()
    this.child.stderr.destroy()
    for (const listener of this.statuses) {
      try {
        listener('blocked')
      } catch {
        /* Observer failures cannot hold a helper open. */
      }
    }
  }
  private read(bytes: Buffer): void {
    if (this.ended || this.stopping || this.failed) return
    this.tail += bytes.toString('utf8')
    if (Buffer.byteLength(this.tail) > 65536) {
      this.fail()
      return
    }
    for (;;) {
      const end = this.tail.indexOf('\n')
      if (end < 0) return
      const line = this.tail.slice(0, end)
      this.tail = this.tail.slice(end + 1)
      if (Buffer.byteLength(line) > 32768) {
        this.fail()
        return
      }
      try {
        const event = eventSchema.parse(JSON.parse(line) as unknown)
        if (event.event === 'result') {
          const pending = this.pending.get(event.id)
          if (!pending) throw new Error('Unexpected result')
          this.pending.delete(event.id)
          clearTimeout(pending.timer)
          pending.resolve(event.data)
        } else if (event.event === 'network') {
          const snapshot = networkSnapshotSchema.parse({ epoch: event.epoch, interfaces: event.interfaces })
          for (const listener of this.changes) {
            try {
              listener(snapshot)
            } catch {
              /* A subscriber cannot change another subscriber's network epoch. */
            }
          }
        } else
          for (const listener of this.statuses) {
            try {
              listener(event.state)
            } catch {
              /* Keep the transport owner independent of observers. */
            }
          }
      } catch {
        this.fail()
        return
      }
    }
  }
  private request(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (this.ended || this.stopping || this.failed) return Promise.reject(new Error('Native network component unavailable'))
    if (this.pending.size >= 8) return Promise.reject(new Error('Native network component busy'))
    const id = randomUUID(),
      data = Buffer.from(`${JSON.stringify({ version: 1, id, method, ...payload })}\n`)
    if (data.length > 16384) return Promise.reject(new Error('Native network request limit'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), 3000)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(data, error => {
        if (error) this.fail()
      })
    })
  }
  async snapshot(): Promise<NativeNetworkSnapshot> {
    return networkSnapshotSchema.parse(await this.request('snapshot'))
  }
  async publish(services: NativeNetworkService[], epoch: string): Promise<void> {
    z.strictObject({ state: z.enum(['off', 'starting']) }).parse(await this.request('publish', { services, epoch }))
  }
  async neighbors(index: number, source: string): Promise<NativeNeighbors> {
    return neighborsSchema.parse(await this.request('neighbors', { index, source }))
  }
  onChange(listener: (snapshot: NativeNetworkSnapshot) => void): () => void {
    if (this.changes.size >= 8) throw new Error('Native network observer limit')
    this.changes.add(listener)
    return () => {
      this.changes.delete(listener)
    }
  }
  onStatus(listener: (status: NativeNetworkStatus) => void): () => void {
    if (this.statuses.size >= 8) throw new Error('Native network observer limit')
    this.statuses.add(listener)
    return () => {
      this.statuses.delete(listener)
    }
  }
  async close(): Promise<void> {
    if (this.stopping) return this.exited
    this.stopping = true
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error('Native network component stopped'))
    }
    this.pending.clear()
    this.child.stdin.end()
    const timer = setTimeout(() => {
      if (!this.ended) this.child.kill('SIGKILL')
    }, 1000)
    timer.unref()
    try {
      await this.exited
    } finally {
      clearTimeout(timer)
      this.changes.clear()
      this.statuses.clear()
    }
  }
}
