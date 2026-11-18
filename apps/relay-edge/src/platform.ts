/**
 * The few Cloudflare Workers shapes the adapter uses, written by hand (no vendor type package). Everything the runtime
 * provides reaches the adapter through these interfaces, so the tests run the same code in Node against a fake.
 *
 * Shapes taken from the Workers runtime documentation and not yet exercised on the platform are marked "unverified":
 * the deploy README lists them among the questions the staging run settles.
 */
export interface EdgeHeaders {
  get(name: string): string | null
}
export interface EdgeRequest {
  readonly method: string
  readonly url: string
  readonly headers: EdgeHeaders
  arrayBuffer(): Promise<ArrayBuffer>
}
/** The runtime's Response; the adapter never reads one back except through `status` in tests. */
export interface EdgeResponse {
  readonly status: number
  text(): Promise<string>
}
/** The server half of a WebSocketPair, used with accept() (never the hibernation API). */
export interface EdgeWebSocket {
  /**
   * Since workerd v1.20261117.1; a probe on the platform read a number. Used only to close a socket earlier, never to
   * release budget, so a missing or wrong value cannot widen a bound.
   */
  readonly bufferedAmount?: number
  binaryType: 'arraybuffer' | 'blob'
  accept(): void
  send(data: ArrayBuffer | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close' | 'error', listener: () => void): void
}
/** SQLite-backed Durable Object storage: `sql.exec` is synchronous (unverified on the platform for this adapter). */
export interface EdgeSql {
  exec(query: string, ...bindings: Array<string | number>): { toArray(): Array<Record<string, unknown>> }
}
export interface EdgeStorage {
  readonly sql: EdgeSql
  /** Unverified on the platform for this adapter: one pending alarm per object, `alarm()` called at or after it. */
  setAlarm(scheduledTime: number): Promise<void>
}
export interface EdgeState {
  readonly storage: EdgeStorage
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
}
export interface EdgeObjectStub {
  fetch(url: string, init: { method: string; headers: Record<string, string> }): Promise<EdgeResponse>
}
export interface EdgeNamespace {
  idFromName(name: string): unknown
  get(id: unknown, options?: { locationHint?: string }): EdgeObjectStub
}
/** A service binding to the stateless registration-work Worker (unverified on the platform for this adapter). */
export interface EdgeService {
  fetch(url: string, init: { method: 'POST'; body: Uint8Array }): Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer> }>
}
export interface EdgeSubtle {
  importKey(format: string, key: unknown, algorithm: unknown, extractable: boolean, usages: string[]): Promise<unknown>
  exportKey(format: 'jwk', key: unknown): Promise<{ x?: string }>
  sign(algorithm: unknown, key: unknown, data: Uint8Array): Promise<ArrayBuffer>
  verify(algorithm: unknown, key: unknown, signature: Uint8Array, data: Uint8Array): Promise<boolean>
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>
  deriveBits(algorithm: unknown, key: unknown, length: number): Promise<ArrayBuffer>
}
export interface EdgeTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}
export interface EdgePlatform extends EdgeTimers {
  subtle: EdgeSubtle
  random(size: number): Uint8Array
  now(): number
  /** `new Response(body, { status, headers })`. */
  respond(status: number, body?: string, headers?: Record<string, string>): EdgeResponse
  /** `new WebSocketPair()`: [client, server]. */
  pair(): [unknown, EdgeWebSocket]
  /** `new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': protocol } })`. */
  upgrade(client: unknown, protocol: string): EdgeResponse
}

/** Worker variables (wrangler.jsonc `vars`) and secrets. Every value arrives as a string. */
export interface EdgeEnv {
  NODE?: EdgeNamespace
  WORK?: EdgeService
  /**
   * The hostnames this Worker answers on, comma-separated: its `workers.dev` name and any custom domain. They are only
   * addresses; a client binds a connection to the node by the relay-key signature, never by the hostname.
   */
  NODE_HOSTS?: string
  /** A Durable Object location hint, e.g. `apac-ne`. */
  LOCATION_HINT?: string
  /** 32 hex characters, public. */
  RELAY_ID?: string
  /** Number of node objects (1–16); every role of a route dials the same one. */
  SHARDS?: string
  /** Changing it starts fresh objects (old ones keep their storage until removed). */
  OBJECT_EPOCH?: string
  /** Optional JSON with numeric limits; see `limits()` in node.ts. */
  LIMITS?: string
  /** Secret: the relay key's 32-byte Ed25519 seed, 64 hex characters. */
  RELAY_SIGNING_SEED?: string
  /** Secret: the bearer token of the admin routes, at least 32 characters. */
  ADMIN_TOKEN?: string
  /** Secret: a 32-byte registration token (64 hex), the one in the relay file. Only Hosts holding it may register. */
  REGISTRATION_TOKEN?: string
  /**
   * `true` admits any Host (with the work challenge above the soft threshold), as the official relay does. Without a
   * registration token and without this, the node refuses to serve: open registration is never a default.
   */
  OPEN_REGISTRATION?: string
}
