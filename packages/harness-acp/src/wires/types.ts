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
  /**
   * A timeout or an aborted `signal` withdraws the request; a late reply is dropped. A wire that calls `onResult` does
   * so before it handles anything the agent wrote after the result, which awaiting the promise does not ensure; one that
   * holds those records until the caller has acted on the result may leave it out.
   */
  request(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal, onResult?: (result: unknown) => void): Promise<unknown>
  notify(method: string, params: unknown): void
  /** `stop`: end stdin, then SIGTERM, then SIGKILL the group. `kill` skips stdin. Resolves once the process is gone. */
  stop(reason: 'stop' | 'kill', graceMs: number, cause?: string): Promise<ExitInfo>
  stderrTail(limit?: number): string
  /** Commands the wire runs itself when a prompt is one of them, never sent as text, and only between turns. */
  readonly idleCommands?: ReadonlySet<string>
  /** Commands from this wire's current native catalog that accept no separate one-time message context. */
  readonly commandsWithoutContext?: ReadonlySet<string>
  /** It answers `FORK_METHOD`. */
  readonly forks?: true
}

/** The agent cannot fork its own record of that session, and the process has no session of Latch's open: why, in Chinese. */
export class ForkRefused extends Error {}
