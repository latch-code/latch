import { ascii, concat, equal, field, fixed, uint } from './bytes.ts'
import { relayWireVersion, type RelayTransportProfile } from './relay-profile.ts'

/** Cryptography is injected; this module never reaches a platform global or implements a primitive. */
export interface LinkCrypto {
  random(size: number): Uint8Array
  hash(input: Uint8Array): Promise<Uint8Array>
  hmac(key: Uint8Array, input: Uint8Array): Promise<Uint8Array>
  derive(seed: Uint8Array, salt: Uint8Array, info: Uint8Array, size: number): Promise<Uint8Array>
  publicKey(seed: Uint8Array): Promise<Uint8Array>
  sign(seed: Uint8Array, input: Uint8Array): Promise<Uint8Array>
  verify(publicKey: Uint8Array, input: Uint8Array, signature: Uint8Array): Promise<boolean>
}
export const UTC_DAY = 86_400
export async function routeKey(crypto: LinkCrypto, seed: Uint8Array, relayId: Uint8Array, day: number): Promise<Uint8Array> {
  return crypto.derive(fixed(seed, 32), fixed(relayId, 16), concat(ascii('latch-route-key-v1\0'), uint(day, 4)), 32)
}
export async function routeId(crypto: LinkCrypto, publicKey: Uint8Array): Promise<Uint8Array> {
  return (await crypto.hash(concat(ascii('latch-route-id-v1\0'), fixed(publicKey, 32)))).slice(0, 16)
}
export async function holder(
  crypto: LinkCrypto,
  seed: Uint8Array,
  relayId: Uint8Array,
  deviceId: Uint8Array,
  day: number,
): Promise<{ seed: Uint8Array; tag: Uint8Array }> {
  if (deviceId.length > 128) throw new RangeError('Invalid device id')
  return {
    seed: await crypto.derive(
      fixed(seed, 32),
      fixed(relayId, 16),
      concat(ascii('latch-holder-key-v1\0'), field(deviceId), uint(day, 4)),
      32,
    ),
    tag: await crypto.derive(seed, relayId, concat(ascii('latch-pass-tag-v1\0'), field(deviceId), uint(day, 4)), 16),
  }
}
export interface KnockBinding {
  path: 'direct' | 'relay' | 'carrier'
  relayId?: Uint8Array
  routeId?: Uint8Array
  driverId?: string
  descriptorHash?: Uint8Array
  profile?: RelayTransportProfile
}
export function bindingBytes(binding: KnockBinding): Uint8Array {
  const version = relayWireVersion(binding.profile)
  if (binding.profile !== undefined && binding.path !== 'relay') throw new RangeError('Invalid relay profile binding')
  if (binding.path === 'carrier') {
    if (!binding.driverId || !/^[A-Za-z0-9_-]{1,64}$/u.test(binding.driverId)) throw new RangeError('Invalid carrier binding')
    return concat(field(ascii('carrier-v1')), field(concat(field(ascii(binding.driverId)), fixed(binding.descriptorHash!, 32))))
  }
  return binding.path === 'direct'
    ? concat(field(ascii('direct')), field(new Uint8Array()))
    : concat(
        field(ascii(version === 2 ? 'relay-pad-v2' : 'relay')),
        field(concat(fixed(binding.relayId!, 16), fixed(binding.routeId!, 16))),
      )
}
export async function knock(
  crypto: LinkCrypto,
  key: Uint8Array,
  binding: KnockBinding,
  timeMs: number,
  nonce = crypto.random(16),
): Promise<Uint8Array> {
  const input = concat(ascii('latch-knock-v1\0'), bindingBytes(binding), uint(Math.floor(timeMs / 60_000), 4), fixed(nonce, 16))
  return concat(nonce, (await crypto.hmac(fixed(key, 32), input)).slice(0, 16))
}
export async function verifyKnock(
  crypto: LinkCrypto,
  key: Uint8Array,
  binding: KnockBinding,
  timeMs: number,
  value: Uint8Array,
): Promise<boolean> {
  if (value.length !== 32) return false
  let valid = false
  for (const offset of [-60_000, 0, 60_000])
    valid = equal(await knock(crypto, key, binding, timeMs + offset, value.slice(0, 16)), value) || valid
  return valid
}
export async function serverBinding(
  crypto: LinkCrypto,
  key: Uint8Array,
  binding: KnockBinding,
  nonce: Uint8Array,
  certificate: Uint8Array,
): Promise<Uint8Array> {
  return crypto.hmac(
    fixed(key, 32),
    concat(ascii('latch-server-bind-v1\0'), bindingBytes(binding), fixed(nonce, 16), await crypto.hash(certificate)),
  )
}
