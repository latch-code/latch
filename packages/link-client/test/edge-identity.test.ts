import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { nodeCrypto } from '../src/crypto.ts'
import {
  boundProofInput,
  decodeAddressBook,
  decodeMessage,
  decodePass,
  edgeChallengeInput,
  edgeRelayPath,
  encodeAddressBook,
  encodeMessage,
  hex,
  makeProof,
  orderRelays,
  relayUrls,
  signEdgeChallenge,
  unhex,
  verifyEdgeChallenge,
  verifyProof,
  type NativeAddressBook,
} from '@latch/link-wire'

const vectors = JSON.parse(await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8')) as Record<
  string,
  unknown
> & {
  relayId: string
  pass: string
  holderSeed: string
  timeMs: number
  edgeRelay: Record<string, string>
  addressBookV4: { payload: string }
}
const e = vectors.edgeRelay
const fields = () => ({
  relayId: unhex(vectors.relayId),
  role: 'client' as const,
  clientNonce: unhex(e.clientNonce!),
  relayNonce: unhex(e.relayNonce!),
  timeMs: Number(vectors.timeMs),
  requiresToken: false,
})

it('signs the edge challenge text of the shared vector and refuses every substituted field', async () => {
  expect(hex(edgeChallengeInput(fields()))).toBe(e.challengeInput)
  expect(hex(await nodeCrypto.publicKey(unhex(e.relaySeed!)))).toBe(e.relayKey)
  expect(hex(await signEdgeChallenge(nodeCrypto, unhex(e.relaySeed!), fields()))).toBe(e.challengeSignature)
  const key = unhex(e.relayKey!),
    signature = unhex(e.challengeSignature!)
  expect(await verifyEdgeChallenge(nodeCrypto, key, fields(), signature)).toBe(true)
  for (const changed of [
    { ...fields(), role: 'host' as const },
    { ...fields(), clientNonce: new Uint8Array(32) },
    { ...fields(), relayNonce: new Uint8Array(32) },
    { ...fields(), timeMs: fields().timeMs + 1 },
    { ...fields(), requiresToken: true },
    { ...fields(), relayId: new Uint8Array(16) },
  ])
    expect(await verifyEdgeChallenge(nodeCrypto, key, changed, signature)).toBe(false)
  expect(await verifyEdgeChallenge(nodeCrypto, await nodeCrypto.publicKey(new Uint8Array(32).fill(1)), fields(), signature)).toBe(false)
  expect(await verifyEdgeChallenge(nodeCrypto, key.subarray(1), fields(), signature)).toBe(false)
})

it('binds the v2 admission proof to the relay nonce and never accepts a proof of the other version', async () => {
  const crypto = { ...nodeCrypto, random: (size: number) => new Uint8Array(size).fill(85) }
  const pass = unhex(vectors.pass),
    relayNonce = unhex(e.relayNonce!),
    timeMs = Number(vectors.timeMs)
  const bound = await makeProof(crypto, unhex(vectors.holderSeed), pass, timeMs, relayNonce)
  expect(hex(bound.nonce)).toBe(e.proofNonce)
  expect(hex(await boundProofInput(nodeCrypto, decodePass(pass), timeMs, bound.nonce, relayNonce))).toBe(e.boundProofInput)
  expect(hex(bound.signature)).toBe(e.boundProof)
  const relayId = unhex(vectors.relayId)
  expect(await verifyProof(nodeCrypto, relayId, bound, timeMs, relayNonce)).toEqual(decodePass(pass))
  // Another connection's nonce, the v1 check, and a v1 proof against a nonce all fail.
  expect(await verifyProof(nodeCrypto, relayId, bound, timeMs, new Uint8Array(32).fill(1))).toBeNull()
  expect(await verifyProof(nodeCrypto, relayId, bound, timeMs)).toBeNull()
  const unbound = await makeProof(crypto, unhex(vectors.holderSeed), pass, timeMs)
  expect(await verifyProof(nodeCrypto, relayId, unbound, timeMs, relayNonce)).toBeNull()
  expect(await verifyProof(nodeCrypto, relayId, unbound, timeMs, relayNonce.subarray(1))).toBeNull()
})

it('encodes the edge messages of the shared vector on the v2 wire only', () => {
  for (const name of ['edgeHello', 'edgeChallenge', 'boundAdmit', 'ping', 'pong']) {
    const bytes = unhex(e[name]!)
    expect(hex(encodeMessage(decodeMessage(bytes, 2), 2))).toBe(e[name])
    expect(() => decodeMessage(bytes, 1)).toThrow()
    expect(() => encodeMessage(decodeMessage(bytes, 2), 1)).toThrow()
  }
  const challenge = decodeMessage(unhex(e.edgeChallenge!), 2)
  expect(challenge).toMatchObject({ type: 'edge-challenge', requiresToken: false })
  const reserved = unhex(e.edgeChallenge!)
  reserved[1 + 16 + 32 + 8] = 2
  expect(() => decodeMessage(reserved, 2)).toThrow()
  expect(() => decodeMessage(Uint8Array.of(40, 0), 2)).toThrow()
  expect(decodeMessage(unhex(e.boundAdmit!), 2).type).toBe('bound-admit')
})

it('round trips the signed v4 book with edge identity, origins, shard and region', () => {
  const book = decodeAddressBook(unhex(vectors.addressBookV4.payload))
  expect(hex(encodeAddressBook(book))).toBe(vectors.addressBookV4.payload)
  const [edge, self] = book.relays
  expect(edge?.edge).toEqual({ relayKey: unhex(e.relayKey!), shard: 0 })
  expect(edge?.spkiHash).toEqual(new Uint8Array(32))
  expect(edge && relayUrls(edge)).toEqual(['https://latch-relay-ne.example.workers.dev/', 'https://ne.relay.example/'])
  expect(edge?.region).toBe('apac-ne')
  expect(self?.edge).toBeUndefined()
  expect(book.hostRegion).toBe('apac-ne')
})

it('refuses malformed edge entries and keeps self-only books on their older versions', () => {
  const book = decodeAddressBook(unhex(vectors.addressBookV4.payload))
  const edge = book.relays[0]!,
    self = book.relays[1]!
  const variant = (relay: Partial<typeof edge>, extra: Partial<NativeAddressBook> = {}) =>
    encodeAddressBook({ ...book, ...extra, relays: [{ ...edge, ...relay }] })
  expect(() => variant({ profile: undefined })).toThrow()
  expect(() => variant({ spkiHash: new Uint8Array(32).fill(1) })).toThrow()
  expect(() => variant({ edge: { relayKey: new Uint8Array(32), shard: 0 } })).toThrow()
  expect(() => variant({ edge: { relayKey: edge.edge!.relayKey, shard: 16 } })).toThrow()
  expect(() => variant({ extraUrls: [edge.url] })).toThrow()
  expect(() => variant({ extraUrls: ['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/'] })).toThrow()
  expect(() => variant({ extraUrls: ['https://a.example/path'] })).toThrow()
  expect(() => variant({ region: 'Tokyo' })).toThrow()
  expect(() => encodeAddressBook({ ...book, relays: [{ ...self, extraUrls: ['https://a.example/'] }] })).toThrow()
  expect(() => variant({}, { hostRegion: 'x'.repeat(17) })).toThrow()
  const selfOnly = { ...book, hostRegion: undefined, relays: [self] }
  delete selfOnly.hostRegion
  expect(encodeAddressBook(selfOnly)[0]).toBe(3)
  const forced = encodeAddressBook(selfOnly)
  // The same self-only content written as v4 is not canonical.
  const v4 = encodeAddressBook({ ...selfOnly, hostRegion: 'apac-se' })
  expect(v4[0]).toBe(4)
  const stripped = v4.slice(0, -('apac-se'.length + 2))
  const unneeded = new Uint8Array(stripped.length + 2)
  unneeded.set(stripped)
  expect(() => decodeAddressBook(unneeded)).toThrow()
  expect(forced[0]).toBe(3)
})

it('orders relays by the Host region and builds per-shard role paths', () => {
  const book = decodeAddressBook(unhex(vectors.addressBookV4.payload))
  const se = { ...book.relays[0]!, region: 'apac-se' }
  expect(orderRelays({ relays: [book.relays[1]!, se, book.relays[0]!], hostRegion: 'apac-ne' }).map(relay => relay.region)).toEqual([
    'apac-ne',
    undefined,
    'apac-se',
  ])
  expect(orderRelays({ relays: [se, book.relays[0]!] }).map(relay => relay.region)).toEqual(['apac-se', 'apac-ne'])
  expect(edgeRelayPath('client', 3)).toBe('/v1/c/3')
  expect(edgeRelayPath('host', 0)).toBe('/v1/h/0')
  expect(() => edgeRelayPath('data', 16)).toThrow()
})
