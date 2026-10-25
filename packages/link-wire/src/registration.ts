import { ascii, concat, fixed, uint } from './bytes.ts'
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
