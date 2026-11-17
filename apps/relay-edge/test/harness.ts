import { DatabaseSync } from 'node:sqlite'
import { webcrypto } from 'node:crypto'
import { decodeMessage, encodeMessage, type RelayMessage } from '@latch/link-wire'
import { EdgeNode } from '../src/node.ts'
import type {
  EdgeEnv,
  EdgeNamespace,
  EdgePlatform,
  EdgeRequest,
  EdgeResponse,
  EdgeSql,
  EdgeState,
  EdgeSubtle,
  EdgeWebSocket,
} from '../src/platform.ts'

/** A fake Workers platform: real WebCrypto and SQLite, a manual clock and manual timers. */
export class FakeClock {
  now = 1_800_000_000_000
  private timers = new Map<number, { at: number; every?: number; callback: () => void }>()
  private next = 0
  set(callback: () => void, ms: number, every?: number): number {
    const id = ++this.next
    this.timers.set(id, { at: this.now + ms, callback, ...(every === undefined ? {} : { every }) })
    return id
  }
  clear(id: unknown): void {
    this.timers.delete(id as number)
  }
  /** Advance time, firing due timers in order and letting promises settle between them. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [id, timer] = due
      this.now = Math.max(this.now, timer.at)
      if (timer.every === undefined) this.timers.delete(id)
      else timer.at += timer.every
      timer.callback()
      await settle()
    }
    this.now = end
    await settle()
  }
}
export async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve))
}

export class FakeResponse implements EdgeResponse {
  constructor(
    readonly status: number,
    readonly body?: string,
    readonly headers: Record<string, string> = {},
    readonly client?: ClientSocket,
  ) {}
  text(): Promise<string> {
    return Promise.resolve(this.body ?? '')
  }
}

/** The client half: what the edge would put on the wire, as decoded relay messages and close codes. */
export class ClientSocket {
  server!: ServerSocket
  readonly received: Uint8Array[] = []
  closed?: number
  private waiters: Array<() => void> = []
  deliver(payload: Uint8Array): void {
    this.received.push(payload)
    for (const waiter of this.waiters.splice(0)) waiter()
  }
  /** Sends one relay message to the node as a binary WebSocket message. */
  send(message: RelayMessage): void {
    this.raw(encodeMessage(message, 2))
  }
  raw(data: Uint8Array | string): void {
    if (this.closed !== undefined) return
    const value = typeof data === 'string' ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    void Promise.resolve().then(() => this.server.emit('message', { data: value }))
  }
  close(): void {
    if (this.closed !== undefined) return
    this.closed = 1000
    void Promise.resolve().then(() => this.server.emit('close'))
  }
  shut(code: number): void {
    if (this.closed !== undefined) return
    this.closed = code
    for (const waiter of this.waiters.splice(0)) waiter()
  }
  messages(): RelayMessage[] {
    return this.received.map(payload => decodeMessage(payload, 2))
  }
  /** The next non-PAD message, advancing the clock on the 40 ms padding grid while nothing has arrived. */
  async next(clock: FakeClock, skip = 0): Promise<RelayMessage> {
    for (let tries = 0; tries < 200; tries++) {
      const real = this.messages().filter(message => message.type !== 'pad')
      if (real.length > skip) return real[skip]!
      if (this.closed !== undefined) throw new Error(`closed ${this.closed}`)
      await clock.advance(40)
    }
    throw new Error('no message')
  }
}
export class ServerSocket implements EdgeWebSocket {
  accepted = false
  closeCode?: number
  private listeners = new Map<string, Array<(event: { data: unknown }) => void>>()
  constructor(readonly client: ClientSocket) {}
  accept(): void {
    this.accepted = true
  }
  send(data: ArrayBuffer | Uint8Array): void {
    if (this.closeCode !== undefined) throw new Error('closed')
    this.client.deliver(new Uint8Array(data instanceof Uint8Array ? data.slice() : data))
  }
  close(code?: number): void {
    if (this.closeCode !== undefined) return
    this.closeCode = code ?? 1000
    this.client.shut(this.closeCode)
    void Promise.resolve().then(() => this.emit('close'))
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  emit(type: string, event: { data: unknown } = { data: undefined }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

export function fakePlatform(clock: FakeClock): EdgePlatform {
  return {
    subtle: webcrypto.subtle as unknown as EdgeSubtle,
    random: size => webcrypto.getRandomValues(new Uint8Array(size)),
    now: () => clock.now,
    respond: (status, body, headers) => new FakeResponse(status, body, headers),
    pair() {
      const client = new ClientSocket(),
        server = new ServerSocket(client)
      client.server = server
      return [client, server]
    },
    upgrade: (client, protocol) => new FakeResponse(101, undefined, { 'Sec-WebSocket-Protocol': protocol }, client as ClientSocket),
    setTimeout: (callback, ms) => clock.set(callback, ms),
    clearTimeout: handle => clock.clear(handle),
    setInterval: (callback, ms) => clock.set(callback, ms, ms),
    clearInterval: handle => clock.clear(handle),
  }
}

/** One SQLite database per object name: a new EdgeNode on the same name is a restarted object. */
export function fakeSql(database: DatabaseSync): EdgeSql {
  return {
    exec(query, ...bindings) {
      const statement = database.prepare(query)
      const rows = /^\s*select/iu.test(query)
        ? (statement.all(...bindings) as Array<Record<string, unknown>>)
        : (statement.run(...bindings), [])
      return { toArray: () => rows }
    },
  }
}
export class FakeObjects {
  readonly databases = new Map<string, DatabaseSync>()
  readonly nodes = new Map<string, EdgeNode>()
  readonly alarms = new Map<string, number>()
  readonly requests: Array<{ name: string; url: string; headers: Record<string, string> }> = []
  readonly hints = new Map<string, string | undefined>()
  constructor(
    private readonly platform: EdgePlatform,
    private readonly env: () => EdgeEnv,
  ) {}
  async object(name: string): Promise<EdgeNode> {
    let node = this.nodes.get(name)
    if (!node) {
      let database = this.databases.get(name)
      if (!database) this.databases.set(name, (database = new DatabaseSync(':memory:')))
      let ready: Promise<unknown> = Promise.resolve()
      const state: EdgeState = {
        storage: {
          sql: fakeSql(database),
          setAlarm: async time => {
            this.alarms.set(name, time)
          },
        },
        blockConcurrencyWhile: callback => {
          const result = callback()
          ready = result
          return result
        },
      }
      node = new EdgeNode(state, this.env(), this.platform)
      await ready
      this.nodes.set(name, node)
    }
    return node
  }
  /** The runtime discarding an object (a deploy or a reset): sockets close, memory is gone, storage stays. */
  reset(name: string): void {
    this.nodes.get(name)?.dispose()
    this.nodes.delete(name)
  }
  namespace(): EdgeNamespace {
    return {
      idFromName: name => name,
      get: (id, options) => {
        this.hints.set(id as string, options?.locationHint)
        return {
          fetch: async (url, init) => {
            this.requests.push({ name: id as string, url, headers: init.headers })
            return (await this.object(id as string)).fetch(request(url, init.method, init.headers))
          },
        }
      },
    }
  }
}
export function request(
  url: string,
  method = 'GET',
  headers: Record<string, string> = {},
  body: Uint8Array = new Uint8Array(),
): EdgeRequest {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  return {
    method,
    url,
    headers: { get: name => lower.get(name.toLowerCase()) ?? null },
    arrayBuffer: () => Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer),
  }
}
