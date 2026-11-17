import { z } from 'zod'
import { count, hex64 } from './fields.ts'

/**
 * Phone connections: the relay and network state. The last three are no longer written; the log verifies every record
 * against these schemas when it opens, so a record already in a log needs its schema for good.
 */
export const NATIVE_ACTIONS = {
  'native.relay.conflict': z.strictObject({ relayHash: hex64 }),
  'native.relay.add.requested': z.strictObject({ base: hex64, profile: hex64 }),
  'native.relay.add.abandoned': z.strictObject({ profile: hex64 }),
  'native.relay.test': z.strictObject({ relayHash: hex64, profile: hex64 }),
  'native.network.remembered': z.strictObject({ networkHash: hex64 }),
  'native.config.changed': z.strictObject({ before: hex64, after: hex64, lowering: z.boolean(), direct: z.boolean(), relayCount: count }),
  'native.inputs.paused': z.strictObject({}),
  'native.inputs.resumed': z.strictObject({}),
} as const
