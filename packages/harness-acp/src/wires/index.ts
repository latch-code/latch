import { AcpWire } from './acp.ts'
import { PI_RPC_ARGS, PiWire } from './pi.ts'
import type { SpawnSpec } from './process.ts'
import type { AgentWire, WireHandlers } from './types.ts'

/** The protocol a harness speaks, by its profile: ACP unless it says otherwise. */
export type WireKind = 'acp' | 'pi'

export function openWire(kind: WireKind | undefined, spec: SpawnSpec, handlers: WireHandlers): AgentWire {
  return kind === 'pi' ? PiWire.spawn(spec, handlers) : AcpWire.spawn(spec, handlers)
}

/** What a wire appends to the definition's arguments, as a launch shows them. */
export function wireArgs(kind: WireKind | undefined): readonly string[] {
  return kind === 'pi' ? PI_RPC_ARGS : []
}
