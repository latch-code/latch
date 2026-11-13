import { AcpWire } from './acp.ts'
import { CODEX_APP_SERVER_ARGS, CodexWire } from './codex.ts'
import { GATE_FILE } from './pi-gate.ts'
import { PI_RPC_ARGS, PiWire } from './pi.ts'
import type { SpawnSpec } from './process.ts'
import type { AgentWire, WireHandlers } from './types.ts'

/** The protocol a harness speaks, by its profile: ACP unless it says otherwise. */
export type WireKind = 'acp' | 'pi' | 'codex'

/**
 * What a wire that chooses the model itself is told of a session on a route: the model it starts on and the only ones it
 * may offer, which the gateway forwards. A wire that speaks ACP leaves this to the agent.
 */
export interface WireOptions {
  route?: { model: string; models: readonly string[] }
}

export function openWire(kind: WireKind | undefined, spec: SpawnSpec, handlers: WireHandlers, options: WireOptions = {}): AgentWire {
  if (kind === 'pi') return PiWire.spawn(spec, handlers)
  if (kind === 'codex') return CodexWire.spawn(spec, handlers, options.route)
  return AcpWire.spawn(spec, handlers)
}

/** pi's gate is written into each process's own temporary directory, which a launch names in words. */
const PI_PREVIEW_ARGS: readonly string[] = ['-e', `<会话临时目录>/${GATE_FILE}`, ...PI_RPC_ARGS]

/** What a wire appends to the definition's arguments, as a launch shows them. */
export function wireArgs(kind: WireKind | undefined): readonly string[] {
  return kind === 'pi' ? PI_PREVIEW_ARGS : kind === 'codex' ? CODEX_APP_SERVER_ARGS : []
}
