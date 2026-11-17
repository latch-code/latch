import { createEdgeWorker } from './edge.ts'
import { EdgeNode } from './node.ts'
import type { EdgeEnv, EdgePlatform, EdgeRequest, EdgeResponse, EdgeState, EdgeSubtle, EdgeWebSocket } from './platform.ts'

/**
 * The deploy entry (`main` in deploy/wrangler.jsonc). The only file that touches the runtime's globals: everything else
 * receives them through `EdgePlatform`, which the tests replace.
 */
interface RuntimeGlobals {
  crypto: { subtle: EdgeSubtle; getRandomValues(array: Uint8Array): Uint8Array }
  Response: new (body: string | null, init: { status: number; headers?: Record<string, string>; webSocket?: unknown }) => EdgeResponse
  WebSocketPair: new () => Record<'0' | '1', unknown>
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}
const runtime = globalThis as unknown as RuntimeGlobals

const platform: EdgePlatform = {
  subtle: runtime.crypto.subtle,
  random: size => runtime.crypto.getRandomValues(new Uint8Array(size)),
  now: () => Date.now(),
  respond: (status, body, headers) => new runtime.Response(body ?? null, { status, ...(headers ? { headers } : {}) }),
  pair() {
    const pair = new runtime.WebSocketPair()
    return [pair[0], pair[1] as EdgeWebSocket]
  },
  upgrade: (client, protocol) =>
    new runtime.Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': protocol } }),
  setTimeout: (callback, ms) => runtime.setTimeout(callback, ms),
  clearTimeout: handle => runtime.clearTimeout(handle),
  setInterval: (callback, ms) => runtime.setInterval(callback, ms),
  clearInterval: handle => runtime.clearInterval(handle),
}

export default createEdgeWorker(platform)

/** The node object class bound as `NODE`. Plain fetch and alarm handlers: no RPC, no hibernation API. */
export class RelayNode {
  private readonly node: EdgeNode
  constructor(state: EdgeState, env: EdgeEnv) {
    this.node = new EdgeNode(state, env, platform)
  }
  fetch(request: EdgeRequest): Promise<EdgeResponse> {
    return this.node.fetch(request)
  }
  alarm(): Promise<void> {
    return this.node.alarm()
  }
}
