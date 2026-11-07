import type { RpcId } from '../protocol.ts'
import type { ExitInfo } from './process.ts'

/** What the agent asks and tells the runtime, in ACP's terms whatever the wire speaks. */
export interface WireHandlers {
  /** Agent-to-client request. The returned value or error is always sent back. */
  request(method: string, params: unknown, id: RpcId): Promise<unknown>
  notification(method: string, params: unknown): void
  /** Called once, after pending requests were rejected. */
  exit(info: ExitInfo): void
}

/**
 * One agent process as the runtime drives it. The runtime speaks ACP's methods and reads ACP's session updates; a wire
 * either sends them as they are or translates them to the agent's own protocol. Failures use the errors of
 * `process.ts` and `RpcError`, so the runtime treats every wire alike.
 */
export interface AgentWire {
  readonly exited: Promise<ExitInfo>
  readonly closed: boolean
  /** Exited, being stopped, or no longer accepting input: hand no new work to it. */
  readonly stopping: boolean
  /** A timeout or an aborted `signal` withdraws the request; a late reply is dropped. */
  request(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown>
  notify(method: string, params: unknown): void
  /** `stop`: end stdin, then SIGTERM, then SIGKILL the group. `kill` skips stdin. Resolves once the process is gone. */
  stop(reason: 'stop' | 'kill', graceMs: number, cause?: string): Promise<ExitInfo>
  stderrTail(limit?: number): string
}
