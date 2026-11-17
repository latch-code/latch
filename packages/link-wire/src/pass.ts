import { ascii, concat, fixed, Reader, uint } from './bytes.ts'
import { type LinkCrypto, routeId, UTC_DAY } from './crypto.ts'

export interface AdmissionPass {
  pairing: boolean
  relayId: Uint8Array
  day: number
  notBefore: number
  notAfter: number
  routePub: Uint8Array
  holderPub: Uint8Array
  tag: Uint8Array
  signature: Uint8Array
}
function unsigned(pass: Omit<AdmissionPass, 'signature'>): Uint8Array {
  return concat(
    uint(1, 1),
    uint(pass.pairing ? 1 : 0, 1),
    fixed(pass.relayId, 16),
    uint(pass.day, 4),
    uint(pass.notBefore, 4),
    uint(pass.notAfter, 4),
    fixed(pass.routePub, 32),
    fixed(pass.holderPub, 32),
    fixed(pass.tag, 16),
  )
}
export function encodePass(pass: AdmissionPass): Uint8Array {
  return concat(unsigned(pass), fixed(pass.signature, 64))
}
export function decodePass(bytes: Uint8Array): AdmissionPass {
  const reader = new Reader(bytes, 174)
  if (reader.number(1) !== 1) throw new RangeError('Unsupported pass version')
  const flags = reader.number(1)
  if (flags > 1) throw new RangeError('Reserved pass flags')
  const value: AdmissionPass = {
    pairing: flags === 1,
    relayId: reader.take(16),
    day: reader.number(4),
    notBefore: reader.number(4),
    notAfter: reader.number(4),
    routePub: reader.take(32),
    holderPub: reader.take(32),
    tag: reader.take(16),
    signature: reader.take(64),
  }
  reader.done()
  return value
}
export async function issuePass(crypto: LinkCrypto, key: Uint8Array, pass: Omit<AdmissionPass, 'signature'>): Promise<Uint8Array> {
  return encodePass({ ...pass, signature: await crypto.sign(key, concat(ascii('latch-relay-pass-v1\0'), unsigned(pass))) })
}
export interface AdmissionProof {
  pass: Uint8Array
  timeMs: number
  nonce: Uint8Array
  signature: Uint8Array
}
export async function proofInput(crypto: LinkCrypto, pass: AdmissionPass, timeMs: number, nonce: Uint8Array): Promise<Uint8Array> {
  return concat(
    ascii('latch-relay-proof-v1\0'),
    pass.relayId,
    await routeId(crypto, pass.routePub),
    pass.tag,
    uint(timeMs, 8),
    fixed(nonce, 16),
  )
}
/**
 * The edge kind's admission proof, bound to the node's per-connection challenge nonce so that it is single-use:
 *
 *   "latch-relay-proof-v2\0" || relayId[16] || routeId[16] || tag[16] || timeMs[8] || nonce[16] || relayNonce[32]
 *
 * Self-hosted nodes keep v1 (`proofInput`): deployed nodes and phones verify v1 only, and a client cannot tell an
 * upgraded self-hosted node from an old one, so binding there would need a negotiation that does not exist.
 */
export async function boundProofInput(
  crypto: LinkCrypto,
  pass: AdmissionPass,
  timeMs: number,
  nonce: Uint8Array,
  relayNonce: Uint8Array,
): Promise<Uint8Array> {
  return concat(
    ascii('latch-relay-proof-v2\0'),
    pass.relayId,
    await routeId(crypto, pass.routePub),
    pass.tag,
    uint(timeMs, 8),
    fixed(nonce, 16),
    fixed(relayNonce, 32),
  )
}
/** Without `relayNonce` the v1 proof of self-hosted nodes; with it the bound v2 proof of edge nodes. */
export async function makeProof(
  crypto: LinkCrypto,
  holderKey: Uint8Array,
  pass: Uint8Array,
  timeMs: number,
  relayNonce?: Uint8Array,
): Promise<AdmissionProof> {
  const nonce = crypto.random(16),
    decoded = decodePass(pass)
  const input = relayNonce
    ? await boundProofInput(crypto, decoded, timeMs, nonce, relayNonce)
    : await proofInput(crypto, decoded, timeMs, nonce)
  return { pass, timeMs, nonce, signature: await crypto.sign(holderKey, input) }
}
/** `relayNonce` selects the bound v2 proof; a v1 proof never verifies against it, and the reverse holds too. */
export async function verifyProof(
  crypto: LinkCrypto,
  relayId: Uint8Array,
  proof: AdmissionProof,
  timeMs: number,
  relayNonce?: Uint8Array,
): Promise<AdmissionPass | null> {
  let pass: AdmissionPass
  try {
    pass = decodePass(proof.pass)
  } catch {
    return null
  }
  const passValid = await crypto.verify(pass.routePub, concat(ascii('latch-relay-pass-v1\0'), proof.pass.slice(0, 110)), pass.signature)
  if (relayNonce && relayNonce.length !== 32) return null
  const input = relayNonce
    ? await boundProofInput(crypto, pass, proof.timeMs, proof.nonce, relayNonce)
    : await proofInput(crypto, pass, proof.timeMs, proof.nonce)
  const holderValid = await crypto.verify(pass.holderPub, input, proof.signature)
  const sameRelay = relayId.length === 16 && relayId.every((byte, index) => byte === pass.relayId[index])
  const now = Math.floor(timeMs / 1000)
  const window = pass.day * UTC_DAY
  const valid =
    passValid
    && holderValid
    && sameRelay
    && Number.isSafeInteger(proof.timeMs)
    && Math.abs(proof.timeMs - timeMs) <= 120_000
    && now >= pass.notBefore
    && now <= pass.notAfter
    && pass.notBefore >= window - 900
    && pass.notAfter <= window + UTC_DAY + 900
    && pass.notAfter > pass.notBefore
    && pass.notAfter - pass.notBefore <= (pass.pairing ? 600 : UTC_DAY + 1800)
  return valid ? pass : null
}
