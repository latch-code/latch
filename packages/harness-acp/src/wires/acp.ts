import { RPC, RpcError, type RpcId } from '../protocol.ts'
import { AgentProcess, ConnectionClosed, ConnectionStopping, isRecord, RequestTimeout, type ExitInfo, type SpawnSpec } from './process.ts'
import type { AgentWire, WireHandlers } from './types.ts'

interface Pending {
  onResult?: (result: unknown) => void
  resolve(value: unknown): void
  reject(error: Error): void
  cleanup(): void
}

/** How long a stop waits for `beforeStop`. */
const BEFORE_STOP_MS = 3000

function rpcError(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof RpcError)
    return { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
  return { code: RPC.internal, message: 'Internal error' }
}

/** One agent process speaking newline-delimited JSON-RPC 2.0 over stdio: ACP, or the app-server Codex lists models with. */
export class AcpWire implements AgentWire {
  readonly exited: Promise<ExitInfo>
  private readonly process: AgentProcess
  private nextId = 0
  private readonly pending = new Map<RpcId, Pending>()
  beforeStop?: ((send: (method: string, params: unknown) => Promise<unknown>) => Promise<void>) | undefined
  /** A graceful stop running `beforeStop`: nothing else is taken meanwhile. */
  private draining?: Promise<ExitInfo>

  private constructor(
    spec: SpawnSpec,
    private readonly handlers: WireHandlers,
  ) {
    this.process = AgentProcess.spawn(spec, {
      record: message => this.onMessage(message),
      closed: info => this.onClosed(info),
    })
    this.exited = this.process.exited
  }

  /** Throws only for invalid arguments; launch failures such as ENOENT arrive as an exit with `reason: 'spawn'`. */
  static spawn(spec: SpawnSpec, handlers: WireHandlers): AcpWire {
    return new AcpWire(spec, handlers)
  }

  get closed(): boolean {
    return this.process.closed
  }
  get stopping(): boolean {
    return this.draining !== undefined || this.process.stopping
  }

  /** A timeout or an aborted `signal` withdraws the request with `$/cancel_request`; a late reply is dropped. */
  request(
    method: string,
    params: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
    onResult?: (result: unknown) => void,
  ): Promise<unknown> {
    // Once stdin ends the line would be dropped silently and the caller would wait for the exit instead.
    if (!this.process.exit && this.stopping) return Promise.reject(new ConnectionStopping())
    return this.send(method, params, timeoutMs, signal, onResult)
  }

  private send(
    method: string,
    params: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
    onResult?: (result: unknown) => void,
  ): Promise<unknown> {
    const exit = this.process.exit
    if (exit) return Promise.reject(new ConnectionClosed(exit))
    if (this.process.stopping) return Promise.reject(new ConnectionStopping())
    if (signal?.aborted) return Promise.reject(new RpcError(RPC.cancelled, 'Request cancelled'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const withdraw = (error: Error): void => {
        if (!this.pending.delete(id)) return
        cleanup()
        this.notify('$/cancel_request', { requestId: id })
        reject(error)
      }
      const onAbort = (): void => withdraw(new RpcError(RPC.cancelled, 'Request cancelled'))
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      if (timeoutMs) {
        timer = setTimeout(() => withdraw(new RequestTimeout(method)), timeoutMs)
        timer.unref()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { resolve, reject, cleanup, ...(onResult ? { onResult } : {}) })
      this.process.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.process.write({ jsonrpc: '2.0', method, params })
  }

  stop(reason: 'stop' | 'kill', graceMs: number, cause?: string): Promise<ExitInfo> {
    if (reason === 'stop' && this.draining) return this.draining
    const hook = this.beforeStop
    this.beforeStop = undefined
    if (!hook || reason !== 'stop' || this.process.exit || this.process.stopping) return this.process.stop(reason, graceMs, cause)
    const draining = (async () => {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        hook((method, params) => this.send(method, params, BEFORE_STOP_MS)).catch(() => {}),
        new Promise(resolve => {
          timer = setTimeout(resolve, BEFORE_STOP_MS)
          timer.unref()
        }),
      ])
      clearTimeout(timer)
      return this.process.stop(reason, graceMs, cause)
    })()
    this.draining = draining
    return draining
  }

  stderrTail(limit?: number): string {
    return this.process.stderrTail(limit)
  }

  private onMessage(message: Record<string, unknown>): void {
    const id = message.id
    // Request IDs from the two directions overlap, so the presence of `method` decides the direction.
    if (typeof message.method === 'string') {
      const method = message.method
      if (id === undefined || id === null) {
        try {
          this.handlers.notification(method, message.params)
        } catch {
          this.process.noise++
        }
        return
      }
      if (typeof id !== 'string' && typeof id !== 'number') {
        this.process.noise++
        return
      }
      let reply: Promise<unknown>
      try {
        reply = this.handlers.request(method, message.params, id)
      } catch (error) {
        reply = Promise.reject(error)
      }
      reply.then(
        result => this.process.write({ jsonrpc: '2.0', id, result: result ?? {} }),
        error => this.process.write({ jsonrpc: '2.0', id, error: rpcError(error) }),
      )
      return
    }
    if (typeof id !== 'string' && typeof id !== 'number') {
      this.process.noise++
      return
    }
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    entry.cleanup()
    if (isRecord(message.error)) {
      const code = typeof message.error.code === 'number' ? message.error.code : RPC.internal
      const text = typeof message.error.message === 'string' ? message.error.message : 'Agent error'
      entry.reject(new RpcError(code, text.slice(0, 4000), message.error.data))
    } else {
      try {
        entry.onResult?.(message.result)
      } catch {
        this.process.noise++
      }
      entry.resolve(message.result)
    }
  }

  private onClosed(info: ExitInfo): void {
    const closed = new ConnectionClosed(info)
    for (const entry of this.pending.values()) {
      entry.cleanup()
      entry.reject(closed)
    }
    this.pending.clear()
    this.handlers.exit(info)
  }
}
