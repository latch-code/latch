import { ascii, concat, fixed, uint } from './bytes.ts'
import { decodeMessage } from './messages.ts'
import type { LinkCrypto } from './crypto.ts'

export function registrationInput(relayId: Uint8Array, challenge: Uint8Array, day: number, routePub: Uint8Array): Uint8Array {
  return concat(ascii('latch-relay-register-v1\0'), fixed(relayId, 16), fixed(challenge, 32), uint(day, 4), fixed(routePub, 32))
}
export async function registrationMac(crypto: LinkCrypto, token: Uint8Array, input: Uint8Array): Promise<Uint8Array> {
  return (await crypto.hmac(fixed(token, 32), concat(ascii('latch-relay-registration-token-v1\0'), input))).slice(0, 16)
}
export async function attachMac(
  crypto: LinkCrypto,
  token: Uint8Array,
  routeId: Uint8Array,
  connection: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  return (
    await crypto.hmac(
      fixed(token, 32),
      concat(ascii('latch-relay-attach-v1\0'), fixed(routeId, 16), fixed(connection, 8), fixed(nonce, 16)),
    )
  ).slice(0, 16)
}

export const REGISTRATION_WORK = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 32, maxMemory: 32 * 1024 * 1024, maxBits: 22 })
/** Every field is fixed length, including the original complete REGISTER; proofs cannot migrate to another control connection. */
export function registrationWorkInput(
  relayId: Uint8Array,
  helloNonce: Uint8Array,
  workNonce: Uint8Array,
  register: Uint8Array,
  solution: Uint8Array,
): Uint8Array {
  fixed(register, 150)
  if (decodeMessage(register).type !== 'register') throw new RangeError('Invalid registration work record')
  return concat(
    ascii('latch-register-work-v1\0'),
    fixed(relayId, 16),
    fixed(helloNonce, 32),
    fixed(workNonce, 32),
    register,
    fixed(solution, 8),
  )
}
export function workDigestMeetsBits(digest: Uint8Array, bits: number): boolean {
  fixed(digest, 32)
  if (!Number.isInteger(bits) || bits < 0 || bits > REGISTRATION_WORK.maxBits) throw new RangeError('Invalid registration work bits')
  const whole = Math.floor(bits / 8),
    remaining = bits % 8
  for (let index = 0; index < whole; index++) if (digest[index] !== 0) return false
  return remaining === 0 || digest[whole]! >>> (8 - remaining) === 0
}
