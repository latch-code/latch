/** An omitted profile is the frozen latch-relay.1 transport, never a negotiated fallback. */
export type RelayTransportProfile = 'outer-pad-v2'
export type RelayWireVersion = 1 | 2
export const OUTER_PADDING = {
  durationMs: 3000,
  tickMs: 40,
  bucketBytes: 4096,
  maximumTickBytes: 32_768,
  maximumQueueBytes: 65_536,
  maximumFramesPerTick: 7,
} as const
export function relayWireVersion(profile?: RelayTransportProfile): RelayWireVersion {
  if (profile !== undefined && profile !== 'outer-pad-v2') throw new RangeError('Unknown relay transport profile')
  return profile === 'outer-pad-v2' ? 2 : 1
}
