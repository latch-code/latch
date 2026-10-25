import { expect, it } from 'vitest'
import { concat, decodeAddressBook, encodeAddressBook, encodePass, uint, type NativeAddressBook } from '../src/index.ts'

function book(): NativeAddressBook {
  return {
    hostId: 'a'.repeat(52),
    deviceId: `dev_${'D'.repeat(22)}`,
    generation: 1,
    issuedAt: 1,
    expiresAt: 1000,
    discoveryKey: new Uint8Array(32),
    lan: [{ address: '192.168.1.2', port: 4319, prefixLength: 24, kind: 'wifi', gatewayHash: new Uint8Array(32) }],
    relays: [
      {
        relayId: new Uint8Array(16),
        url: 'https://relay.example/',
        spkiHash: new Uint8Array(32),
        passes: [
          {
            holderSeed: new Uint8Array(32),
            pass: encodePass({
              pairing: false,
              relayId: new Uint8Array(16),
              day: 1,
              notBefore: 86400,
              notAfter: 172800,
              routePub: new Uint8Array(32),
              holderPub: new Uint8Array(32),
              tag: new Uint8Array(16),
              signature: new Uint8Array(64),
            }),
          },
        ],
      },
    ],
  }
}
it('round trips bounded ordered hints without treating addresses as authority', () => {
  const value = book(),
    bytes = encodeAddressBook(value)
  expect(decodeAddressBook(bytes)).toEqual(value)
  expect(() => decodeAddressBook(concat(bytes, uint(0, 1)))).toThrow()
  expect(() => decodeAddressBook(bytes.subarray(0, -1))).toThrow()
  const reserved = bytes.slice()
  reserved[1] = 1
  expect(() => decodeAddressBook(reserved)).toThrow()
})
it('rejects oversized, duplicate, cross-node and credential-bearing address hints', () => {
  const value = book()
  expect(() => encodeAddressBook({ ...value, lan: Array.from({ length: 9 }, () => value.lan[0]!) })).toThrow()
  expect(() => encodeAddressBook({ ...value, lan: [value.lan[0]!, value.lan[0]!] })).toThrow()
  for (const url of [
    'https://user:secret@relay.example/',
    'https://relay.example/?pass=x',
    'http://relay.example/',
    'https://relay.example/path',
    'https://relay.example:0/',
  ])
    expect(() => encodeAddressBook({ ...value, relays: [{ ...value.relays[0]!, url }] })).toThrow()
  expect(() => encodeAddressBook({ ...value, relays: [{ ...value.relays[0]!, relayId: new Uint8Array(16).fill(1) }] })).toThrow()
  expect(() =>
    encodeAddressBook({
      ...value,
      relays: [{ ...value.relays[0]!, passes: Array.from({ length: 65 }, () => value.relays[0]!.passes[0]!) }],
    }),
  ).toThrow()
})
