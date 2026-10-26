import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { bindingBytes, decodeAddressBook, decodeMessage, encodeAddressBook, encodeMessage, hex, type RelayMessage } from '../src/index.ts'

it('keeps padding and the OPEN profile behind the explicit v2 wire grammar', () => {
  const open: RelayMessage = { type: 'open', connection: new Uint8Array(8), routeId: new Uint8Array(16), profile: 'outer-pad-v2' }
  const pad: RelayMessage = { type: 'pad', data: new Uint8Array(16_384) }
  for (const message of [open, pad]) {
    const encoded = encodeMessage(message, 2)
    expect(decodeMessage(encoded, 2)).toEqual(message)
    expect(() => encodeMessage(message)).toThrow()
    expect(() => decodeMessage(encoded)).toThrow()
  }
  const legacy = { ...open, profile: undefined }
  expect(encodeMessage(legacy)).toHaveLength(25)
  expect(encodeMessage(legacy, 2)).toHaveLength(26)
  expect(decodeMessage(encodeMessage(legacy, 2), 2)).toEqual(legacy)
  const reserved = encodeMessage(open, 2)
  reserved[reserved.length - 1] = 2
  expect(() => decodeMessage(reserved, 2)).toThrow()
  expect(() => decodeMessage(encodeMessage(legacy), 2)).toThrow()
  expect(() => encodeMessage({ type: 'pad', data: new Uint8Array(16_385) }, 2)).toThrow()
})

it('uses a separate authenticated binding and refuses profiles on direct or carrier paths', async () => {
  const {
    outerRelayV2: vector,
    relayId,
    routePub,
  } = JSON.parse(await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8')) as {
    outerRelayV2: { binding: string }
    relayId: string
    routePub: string
  }
  const relay = {
    path: 'relay' as const,
    relayId: Buffer.from(relayId, 'hex'),
    routeId: createHash('sha256').update('latch-route-id-v1\0').update(Buffer.from(routePub, 'hex')).digest().subarray(0, 16),
  }
  expect(hex(bindingBytes({ ...relay, profile: 'outer-pad-v2' }))).not.toBe(hex(bindingBytes(relay)))
  expect(hex(bindingBytes({ ...relay, profile: 'outer-pad-v2' }))).toBe(vector.binding)
  expect(() => bindingBytes({ path: 'direct', profile: 'outer-pad-v2' })).toThrow()
  expect(() =>
    bindingBytes({ path: 'carrier', driverId: 'fixture', descriptorHash: new Uint8Array(32), profile: 'outer-pad-v2' }),
  ).toThrow()
})

it('round trips the signed v3 profile without rewriting the frozen v1/v2 address-book payloads', async () => {
  const vectors = JSON.parse(await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8')) as Record<
    string,
    { payload: string }
  >
  for (const name of ['addressBook', 'addressBookV2', 'addressBookV2Online', 'addressBookV3']) {
    const payload = vectors[name]!.payload
    expect(hex(encodeAddressBook(decodeAddressBook(Buffer.from(payload, 'hex'))))).toBe(payload)
  }
  const book = decodeAddressBook(Buffer.from(vectors.addressBookV3!.payload, 'hex'))
  expect(book.relays[0]?.profile).toBe('outer-pad-v2')
  expect(book.directory).toBeUndefined()
  expect(encodeAddressBook(book)[0]).toBe(3)
  expect(
    encodeAddressBook({ ...book, directory: decodeAddressBook(Buffer.from(vectors.addressBookV2!.payload, 'hex')).directory })[0],
  ).toBe(3)
  const invalid = Buffer.from(vectors.addressBookV3!.payload, 'hex')
  invalid[invalid.length - 210] = 2
  expect(() => decodeAddressBook(invalid)).toThrow()
})
