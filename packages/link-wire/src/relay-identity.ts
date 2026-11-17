import { ascii, concat, fixed, uint } from './bytes.ts'
import type { LinkCrypto } from './crypto.ts'

/**
 * Two relay kinds share one blind state machine and differ in how a client knows it reached the right node.
 *
 * - `self`: the operator's own TLS key is pinned by its SPKI hash (unchanged since v1).
 * - `edge`: TLS ends at a CDN with keys it controls, so the node proves its identity with its own Ed25519 key instead.
 *   The client sends a fresh 32-byte nonce, the node answers with its own fresh nonce and a signature over both
 *   (`edgeChallengeInput`), and an admission proof is then bound to the node's nonce (`boundProofInput` in pass.ts).
 *
 * The signature is not bound to the TLS session: a party that terminates TLS for the hostname can relay it live. It
 * proves the node's key took part in this connection and makes every admission proof single-use.
 */
export type RelayKind = 'self' | 'edge'
export type EdgeRole = 'host' | 'data' | 'client'
const ROLES = { host: 1, data: 2, client: 3 } as const

/**
 * Edge behaviour settled by measurement rather than by protocol. Everything that the platform probe may change lives here.
 * - Keep-alive: the edge answers WebSocket pings itself, so a node never sees them and a client's pong proves only that
 *   the edge is up. Edge sockets that are not yet spliced send an application PING every `pingIntervalMs`, the node
 *   answers PONG, and both sides close a socket silent for longer than their dead-peer limit. Spliced sockets carry the
 *   inner padding grid (a cell every 250 ms) and need nothing more.
 * - Shards: a node may run up to `maxShards` independent objects; every role of a route dials the same shard.
 */
export const EDGE_RELAY = Object.freeze({
  pingIntervalMs: 20_000,
  nodeDeadAfterMs: 75_000,
  clientDeadAfterMs: 60_000,
  maxShards: 16,
  /** The challenge clock may differ from the client's by this much, as for self-hosted nodes. */
  clockSkewMs: 86_400_000,
})

export interface EdgeChallengeFields {
  relayId: Uint8Array
  role: EdgeRole
  clientNonce: Uint8Array
  relayNonce: Uint8Array
  timeMs: number
  requiresToken: boolean
}

/**
 * The exact bytes the edge node signs (Ed25519, its relay key):
 *
 *   "latch-relay-edge-challenge-v1\0" || relayId[16] || role[1] (1 host, 2 data, 3 client)
 *     || clientNonce[32] || relayNonce[32] || timeMs[8, big-endian] || flags[1] (bit 0: registration token required)
 */
export function edgeChallengeInput(fields: EdgeChallengeFields): Uint8Array {
  return concat(
    ascii('latch-relay-edge-challenge-v1\0'),
    fixed(fields.relayId, 16),
    uint(ROLES[fields.role], 1),
    fixed(fields.clientNonce, 32),
    fixed(fields.relayNonce, 32),
    uint(fields.timeMs, 8),
    uint(fields.requiresToken ? 1 : 0, 1),
  )
}
export function signEdgeChallenge(crypto: LinkCrypto, relaySeed: Uint8Array, fields: EdgeChallengeFields): Promise<Uint8Array> {
  return crypto.sign(fixed(relaySeed, 32), edgeChallengeInput(fields))
}
export async function verifyEdgeChallenge(
  crypto: LinkCrypto,
  relayKey: Uint8Array,
  fields: EdgeChallengeFields,
  signature: Uint8Array,
): Promise<boolean> {
  if (relayKey.length !== 32 || signature.length !== 64) return false
  try {
    return await crypto.verify(relayKey, edgeChallengeInput(fields), signature)
  } catch {
    return false
  }
}
/** The URL path of one role on one shard. Self-hosted nodes keep the frozen `/v1/{h,d,c}`. */
export function edgeRelayPath(role: EdgeRole, shard: number): string {
  if (!Number.isInteger(shard) || shard < 0 || shard >= EDGE_RELAY.maxShards) throw new RangeError('Invalid relay shard')
  return `/v1/${role === 'host' ? 'h' : role === 'data' ? 'd' : 'c'}/${shard}`
}
export const EDGE_REGION = /^[a-z0-9-]{1,16}$/u
