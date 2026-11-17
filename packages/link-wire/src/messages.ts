import { concat, fixed, Reader, uint } from './bytes.ts'
import type { AdmissionProof } from './pass.ts'
import { relayWireVersion, type RelayTransportProfile, type RelayWireVersion } from './relay-profile.ts'
export const MAX_DATA = 16_384
export const MAX_MESSAGE = 65_536
export const CLOSE = {
  protocol: 4400,
  admission: 4100,
  unavailable: 4101,
  limit: 4102,
  conflict: 4200,
  superseded: 4201,
  drain: 4300,
  overload: 4302,
  quota: 4304,
} as const
export type RelayMessage =
  | { type: 'data'; data: Uint8Array }
  | { type: 'pad'; data: Uint8Array }
  | { type: 'hello' }
  | { type: 'challenge'; relayId: Uint8Array; nonce: Uint8Array; timeMs: number; requiresToken: boolean }
  | {
      type: 'register'
      previous: Uint8Array
      day: number
      routePub: Uint8Array
      signature: Uint8Array
      regMac: Uint8Array
      alternate: boolean
    }
  | { type: 'registration-work'; routeId: Uint8Array; nonce: Uint8Array; bits: number }
  | { type: 'registration-proof'; routeId: Uint8Array; nonce: Uint8Array; solution: Uint8Array }
  | { type: 'registered'; token: Uint8Array; routeId: Uint8Array; status: 0 | 1 | 4 | 5 | 6 }
  | { type: 'admit'; proof: AdmissionProof }
  | { type: 'admitted' }
  | { type: 'open'; connection: Uint8Array; routeId: Uint8Array; profile?: RelayTransportProfile }
  | { type: 'attach'; routeId: Uint8Array; connection: Uint8Array; nonce: Uint8Array; mac: Uint8Array }
  | { type: 'attached' }
  | { type: 'spliced'; connection: Uint8Array; passTag: Uint8Array }
  | { type: 'deny'; routeId: Uint8Array; tags: Uint8Array[] }
  | { type: 'deny-ack'; routeId: Uint8Array; digest: Uint8Array; count: number }
  | { type: 'drop'; routeId: Uint8Array }
  | { type: 'depart'; state: 1 | 2 | 3 }
  | { type: 'unavailable'; state: number; since: number }
  | { type: 'goaway'; reason: 1 | 2 | 3; retryAfterMs: number }
  // Edge kind only (relay-identity.ts), and only on the v2 wire: a self-hosted node rejects them as unknown tags.
  | { type: 'edge-hello'; clientNonce: Uint8Array }
  | { type: 'edge-challenge'; relayId: Uint8Array; nonce: Uint8Array; timeMs: number; requiresToken: boolean; signature: Uint8Array }
  | { type: 'bound-admit'; proof: AdmissionProof }
  | { type: 'ping' }
  | { type: 'pong' }
const EDGE_TYPES: ReadonlySet<RelayMessage['type']> = new Set(['edge-hello', 'edge-challenge', 'bound-admit', 'ping', 'pong'])
const tags = {
  data: 0,
  pad: 1,
  admit: 16,
  hello: 32,
  register: 33,
  'registration-proof': 34,
  deny: 36,
  drop: 37,
  depart: 38,
  attach: 48,
  challenge: 64,
  registered: 65,
  open: 66,
  'deny-ack': 67,
  goaway: 68,
  'registration-work': 69,
  attached: 80,
  spliced: 81,
  admitted: 96,
  unavailable: 98,
  'bound-admit': 17,
  'edge-hello': 39,
  ping: 40,
  'edge-challenge': 70,
  pong: 71,
} as const
export function encodeMessage(message: RelayMessage, version: RelayWireVersion = 1): Uint8Array {
  if (version !== 1 && version !== 2) throw new RangeError('Unsupported relay protocol')
  if (version !== 2 && EDGE_TYPES.has(message.type)) throw new RangeError('Edge relay messages need the v2 wire')
  let body: Uint8Array
  switch (message.type) {
    case 'data':
      if (message.data.length > MAX_DATA) throw new RangeError('DATA too large')
      body = message.data
      break
    case 'pad':
      if (version !== 2 || message.data.length > MAX_DATA) throw new RangeError('Invalid outer padding')
      body = message.data
      break
    case 'hello':
      body = uint(1, 1)
      break
    case 'challenge':
      body = concat(fixed(message.relayId, 16), fixed(message.nonce, 32), uint(message.timeMs, 8), uint(message.requiresToken ? 1 : 0, 1))
      break
    case 'register':
      body = concat(
        fixed(message.previous, 32),
        uint(message.day, 4),
        fixed(message.routePub, 32),
        fixed(message.signature, 64),
        fixed(message.regMac, 16),
        uint(message.alternate ? 1 : 0, 1),
      )
      break
    case 'registration-work':
      if (!Number.isInteger(message.bits) || message.bits < 0 || message.bits > 22) throw new RangeError('Invalid registration work bits')
      body = concat(fixed(message.routeId, 16), fixed(message.nonce, 32), uint(message.bits, 1))
      break
    case 'registration-proof':
      body = concat(fixed(message.routeId, 16), fixed(message.nonce, 32), fixed(message.solution, 8))
      break
    case 'registered':
      body = concat(fixed(message.token, 32), fixed(message.routeId, 16), uint(message.status, 1))
      break
    case 'edge-hello':
      body = fixed(message.clientNonce, 32)
      break
    case 'edge-challenge':
      body = concat(
        fixed(message.relayId, 16),
        fixed(message.nonce, 32),
        uint(message.timeMs, 8),
        uint(message.requiresToken ? 1 : 0, 1),
        fixed(message.signature, 64),
      )
      break
    case 'ping':
    case 'pong':
      body = new Uint8Array()
      break
    case 'admit':
    case 'bound-admit':
      body = concat(
        fixed(message.proof.pass, 174),
        uint(message.proof.timeMs, 8),
        fixed(message.proof.nonce, 16),
        fixed(message.proof.signature, 64),
      )
      break
    case 'admitted':
    case 'attached':
      body = new Uint8Array()
      break
    case 'open':
      if (version === 1 && message.profile !== undefined) throw new RangeError('Unsupported relay profile')
      body = concat(
        fixed(message.connection, 8),
        fixed(message.routeId, 16),
        ...(version === 2 ? [uint(relayWireVersion(message.profile) - 1, 1)] : []),
      )
      break
    case 'attach':
      body = concat(fixed(message.routeId, 16), fixed(message.connection, 8), fixed(message.nonce, 16), fixed(message.mac, 16))
      break
    case 'spliced':
      body = concat(fixed(message.connection, 8), fixed(message.passTag, 16))
      break
    case 'deny':
      if (message.tags.length > 1024) throw new RangeError('DENY too large')
      body = concat(fixed(message.routeId, 16), uint(message.tags.length, 2), ...message.tags.map(tag => fixed(tag, 16)))
      break
    case 'deny-ack':
      if (message.count > 8192) throw new RangeError('DENY count too large')
      body = concat(fixed(message.routeId, 16), fixed(message.digest, 32), uint(message.count, 2))
      break
    case 'depart':
      body = uint(message.state, 1)
      break
    case 'drop':
      body = fixed(message.routeId, 16)
      break
    case 'unavailable':
      body = concat(uint(message.state, 1), uint(message.since, 4))
      break
    case 'goaway':
      body = concat(uint(message.reason, 1), uint(message.retryAfterMs, 4))
      break
  }
  return concat(uint(tags[message.type], 1), body)
}
export function decodeMessage(bytes: Uint8Array, version: RelayWireVersion = 1): RelayMessage {
  if (version !== 1 && version !== 2) throw new RangeError('Unsupported relay protocol')
  const reader = new Reader(bytes, MAX_MESSAGE)
  const tag = reader.number(1)
  if (version !== 2 && [17, 39, 40, 70, 71].includes(tag)) throw new RangeError('Unknown relay tag')
  let value: RelayMessage
  switch (tag) {
    case 0:
      if (bytes.length > MAX_DATA + 1) throw new RangeError('DATA too large')
      return { type: 'data', data: bytes.slice(1) }
    case 1:
      if (version !== 2 || bytes.length > MAX_DATA + 1) throw new RangeError('Invalid outer padding')
      return { type: 'pad', data: bytes.slice(1) }
    case 32:
      if (reader.number(1) !== 1) throw new RangeError('Protocol version')
      value = { type: 'hello' }
      break
    case 64: {
      const relayId = reader.take(16),
        nonce = reader.take(32),
        timeMs = reader.number(8),
        flags = reader.number(1)
      if (flags > 1) throw new RangeError('Reserved flags')
      value = { type: 'challenge', relayId, nonce, timeMs, requiresToken: flags === 1 }
      break
    }
    case 33: {
      const previous = reader.take(32),
        day = reader.number(4),
        routePub = reader.take(32),
        signature = reader.take(64),
        regMac = reader.take(16),
        flags = reader.number(1)
      if (flags > 1) throw new RangeError('Reserved flags')
      value = { type: 'register', previous, day, routePub, signature, regMac, alternate: flags === 1 }
      break
    }
    case 69: {
      const routeId = reader.take(16),
        nonce = reader.take(32),
        bits = reader.number(1)
      if (bits > 22) throw new RangeError('Invalid registration work bits')
      value = { type: 'registration-work', routeId, nonce, bits }
      break
    }
    case 34:
      value = { type: 'registration-proof', routeId: reader.take(16), nonce: reader.take(32), solution: reader.take(8) }
      break
    case 65: {
      const token = reader.take(32),
        routeId = reader.take(16),
        status = reader.number(1)
      if (![0, 1, 4, 5, 6].includes(status)) throw new RangeError('Invalid route status')
      value = { type: 'registered', token, routeId, status: status as 0 | 1 | 4 | 5 | 6 }
      break
    }
    case 39:
      value = { type: 'edge-hello', clientNonce: reader.take(32) }
      break
    case 70: {
      const relayId = reader.take(16),
        nonce = reader.take(32),
        timeMs = reader.number(8),
        flags = reader.number(1)
      if (flags > 1) throw new RangeError('Reserved flags')
      value = { type: 'edge-challenge', relayId, nonce, timeMs, requiresToken: flags === 1, signature: reader.take(64) }
      break
    }
    case 40:
      value = { type: 'ping' }
      break
    case 71:
      value = { type: 'pong' }
      break
    case 16:
    case 17:
      value = {
        type: tag === 16 ? 'admit' : 'bound-admit',
        proof: { pass: reader.take(174), timeMs: reader.number(8), nonce: reader.take(16), signature: reader.take(64) },
      }
      break
    case 96:
      value = { type: 'admitted' }
      break
    case 66: {
      value = { type: 'open', connection: reader.take(8), routeId: reader.take(16) }
      if (version === 2) {
        const profile = reader.number(1)
        if (profile > 1) throw new RangeError('Unknown relay transport profile')
        if (profile === 1) value.profile = 'outer-pad-v2'
      }
      break
    }
    case 48:
      value = { type: 'attach', routeId: reader.take(16), connection: reader.take(8), nonce: reader.take(16), mac: reader.take(16) }
      break
    case 80:
      value = { type: 'attached' }
      break
    case 81:
      value = { type: 'spliced', connection: reader.take(8), passTag: reader.take(16) }
      break
    case 36: {
      const routeId = reader.take(16),
        size = reader.number(2)
      if (size > 1024) throw new RangeError('DENY too large')
      value = { type: 'deny', routeId, tags: Array.from({ length: size }, () => reader.take(16)) }
      break
    }
    case 67: {
      const routeId = reader.take(16),
        digest = reader.take(32),
        count = reader.number(2)
      if (count > 8192) throw new RangeError('DENY count too large')
      value = { type: 'deny-ack', routeId, digest, count }
      break
    }
    case 37:
      value = { type: 'drop', routeId: reader.take(16) }
      break
    case 38: {
      const state = reader.number(1)
      if (state < 1 || state > 3) throw new RangeError('Invalid departure')
      value = { type: 'depart', state: state as 1 | 2 | 3 }
      break
    }
    case 98:
      value = { type: 'unavailable', state: reader.number(1), since: reader.number(4) }
      break
    case 68: {
      const reason = reader.number(1)
      if (reason < 1 || reason > 3) throw new RangeError('Invalid GOAWAY')
      value = { type: 'goaway', reason: reason as 1 | 2 | 3, retryAfterMs: reader.number(4) }
      break
    }
    default:
      throw new RangeError('Unknown relay tag')
  }
  reader.done()
  return value
}
