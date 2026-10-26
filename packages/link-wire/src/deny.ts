import { ascii, concat, fixed, hex, uint } from './bytes.ts'
import type { LinkCrypto } from './crypto.ts'

/** Acknowledgements bind exactly the normalized batch, independent of the relay's cumulative set order. */
export function denyBatchInput(routeId: Uint8Array, tags: readonly Uint8Array[]): Uint8Array {
  if (tags.length > 1024) throw new RangeError('DENY too large')
  const unique = new Map<string, Uint8Array>()
  for (const tag of tags) unique.set(hex(fixed(tag, 16)), tag)
  const ordered = [...unique].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, tag]) => tag)
  return concat(ascii('latch-deny-batch-v1\0'), fixed(routeId, 16), uint(ordered.length, 2), ...ordered)
}
export async function denyBatchDigest(crypto: LinkCrypto, routeId: Uint8Array, tags: readonly Uint8Array[]): Promise<Uint8Array> {
  return fixed(await crypto.hash(denyBatchInput(routeId, tags)), 32)
}
