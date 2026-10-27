import { z } from 'zod'
import { count, hex64 } from './fields.ts'

/** Phone connections: the relay and network state, the native entry's settings and the global input pause. */
export const NATIVE_ACTIONS = {
  'native.relay.conflict': z.strictObject({ relayHash: hex64 }),
  'native.network.remembered': z.strictObject({ networkHash: hex64 }),
  'native.config.changed': z.strictObject({ before: hex64, after: hex64, lowering: z.boolean(), direct: z.boolean(), relayCount: count }),
  'native.inputs.paused': z.strictObject({}),
  'native.inputs.resumed': z.strictObject({}),
} as const
