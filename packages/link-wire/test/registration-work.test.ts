import { expect, it } from 'vitest'
import { concat, decodeMessage, encodeMessage, registrationWorkInput, workDigestMeetsBits } from '../src/index.ts'
const register = encodeMessage({
  type: 'register',
  previous: new Uint8Array(32),
  day: 20000,
  routePub: new Uint8Array(32),
  signature: new Uint8Array(64),
  regMac: new Uint8Array(16),
  alternate: false,
})
it('fixes and bounds challenge/proof messages and rejects extra, truncated or out-of-budget fields', () => {
  for (const message of [
    { type: 'registration-work' as const, routeId: new Uint8Array(16), nonce: new Uint8Array(32), bits: 22 },
    { type: 'registration-proof' as const, routeId: new Uint8Array(16), nonce: new Uint8Array(32), solution: new Uint8Array(8) },
  ]) {
    const encoded = encodeMessage(message)
    expect(decodeMessage(encoded)).toEqual(message)
    expect(() => decodeMessage(encoded.slice(0, -1))).toThrow()
    expect(() => decodeMessage(concat(encoded, new Uint8Array(1)))).toThrow()
  }
  expect(() => encodeMessage({ type: 'registration-work', routeId: new Uint8Array(16), nonce: new Uint8Array(32), bits: 23 })).toThrow()
  const bad = encodeMessage({ type: 'registration-work', routeId: new Uint8Array(16), nonce: new Uint8Array(32), bits: 0 })
  bad[bad.length - 1] = 23
  expect(() => decodeMessage(bad)).toThrow()
})
it('binds complete original registration, relay and both nonces, and rejects non-register records', () => {
  const input = registrationWorkInput(new Uint8Array(16), new Uint8Array(32), new Uint8Array(32), register, new Uint8Array(8))
  expect(register).toHaveLength(150)
  expect(input).toHaveLength(261)
  const changed = registrationWorkInput(new Uint8Array(16).fill(1), new Uint8Array(32), new Uint8Array(32), register, new Uint8Array(8))
  expect(changed).not.toEqual(input)
  const invalid = register.slice()
  invalid[0] = 0
  expect(() => registrationWorkInput(new Uint8Array(16), new Uint8Array(32), new Uint8Array(32), invalid, new Uint8Array(8))).toThrow()
})
it('checks exact leading bits, including the maximum and strict digest length', () => {
  const hash = new Uint8Array(32)
  hash[2] = 3
  expect(workDigestMeetsBits(hash, 22)).toBe(true)
  hash[2] = 4
  expect(workDigestMeetsBits(hash, 22)).toBe(false)
  expect(workDigestMeetsBits(new Uint8Array(32).fill(255), 0)).toBe(true)
  expect(() => workDigestMeetsBits(hash, 23)).toThrow()
  expect(() => workDigestMeetsBits(new Uint8Array(31), 0)).toThrow()
})
