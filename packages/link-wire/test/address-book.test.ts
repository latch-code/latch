import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  concat,
  decodeAddressBook,
  encodeAddressBook,
  encodePass,
  uint,
  directoryMirror,
  decodeDirectorySource,
  encodeDirectorySource,
  directoryEpochInput,
  hex,
  type NativeAddressBook,
} from '../src/index.ts'

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
it('opts into v2 only for explicitly configured fixed directory roots, mirrors and an offline floor', () => {
  const original = book(),
    directory = {
      anchors: [new Uint8Array(32).fill(4)],
      mirrors: ['https://directory.example/relays-v1.bin'],
      minimum: { generation: 7, hash: new Uint8Array(32).fill(5) },
    }
  expect(encodeAddressBook(original)[0]).toBe(1)
  const bytes = encodeAddressBook({ ...original, directory })
  expect(bytes[0]).toBe(2)
  expect(decodeAddressBook(bytes)).toEqual({ ...original, directory })
  for (const bad of [
    { ...directory, anchors: [] },
    { ...directory, anchors: [directory.anchors[0]!, directory.anchors[0]!] },
    { ...directory, minimum: { generation: 0, hash: new Uint8Array(32) } },
  ])
    expect(() => encodeAddressBook({ ...original, directory: bad })).toThrow()
  for (const mirror of [
    'https://127.0.0.1/dir',
    'https://169.254.169.254/dir',
    'https://user@public.example/dir',
    'https://public.example/../dir',
    'https://public.example//dir',
    'https://public.example/dir?key=x',
    'http://public.example/dir',
  ]) {
    expect(() => directoryMirror(mirror)).toThrow()
    expect(() => encodeAddressBook({ ...original, directory: { ...directory, mirrors: [mirror] } })).toThrow()
  }
})
it('matches the shared v2 bytes while preserving the original v1 vector byte for byte', async () => {
  const vectors = JSON.parse(await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8')) as {
    addressBook: { payload: string }
    addressBookV2: { payload: string }
    addressBookV2Online: { payload: string }
    directorySource: { bytes: string }
    directorySourceOnline: { bytes: string }
  }
  for (const fixture of [vectors.addressBook, vectors.addressBookV2, vectors.addressBookV2Online])
    expect(hex(encodeAddressBook(decodeAddressBook(Buffer.from(fixture.payload, 'hex'))))).toBe(fixture.payload)
  for (const source of [vectors.directorySource, vectors.directorySourceOnline])
    expect(hex(encodeDirectorySource(decodeDirectorySource(Buffer.from(source.bytes, 'hex'))))).toBe(source.bytes)
})
it('binds the directory cache hint to the complete fixed source and both floors', async () => {
  const { directoryEpoch: vector } = JSON.parse(await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8')) as {
    directoryEpoch: { source: string; input: string }
  }
  const source = decodeDirectorySource(Buffer.from(vector.source, 'hex'))
  expect(hex(directoryEpochInput(source))).toBe(vector.input)
  expect(hex(directoryEpochInput({ ...source, minimumOnline: undefined }))).not.toBe(vector.input)
})
