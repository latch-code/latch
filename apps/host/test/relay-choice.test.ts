import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { orderRelays, relayUrls, type NativeAddressBook } from '@latch/link-wire'
import { verifyAddressBook } from '@latch/link-client'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { HostAddressBooks } from '../src/relay/address-book.ts'
import { NativeSettings } from '../src/native-settings.ts'
import { RelayProfiles } from '../src/relay/profiles.ts'
import type { OfficialRelay } from '../src/relay/official.ts'
import { loadOrCreateHostIdentity } from '../src/identity.ts'
import { readRelayFile, relayFacts } from '../scripts/latch-relay.ts'

const folders: string[] = []
afterEach(async () => {
  for (const directory of folders.splice(0)) await rm(directory, { recursive: true, force: true })
})
const hex = (size: number) => randomBytes(size).toString('hex')
const deviceId = `dev_${'A'.repeat(22)}`
const official: Array<Extract<OfficialRelay, { kind: 'edge' }>> = [
  { relayId: hex(16), kind: 'edge', urls: ['https://latch-relay-ne.example.workers.dev/'], relayKey: hex(32), region: 'apac-ne' },
  {
    relayId: hex(16),
    kind: 'edge',
    urls: ['https://latch-relay-se.example.workers.dev/', 'https://se.relay.example/'],
    relayKey: hex(32),
    region: 'apac-se',
  },
]
const ownSelf = { relayId: hex(16), url: 'https://home.example/', spkiHash: hex(32) }
const ownEdge = {
  relayId: hex(16),
  url: 'https://latch-relay-ne.mine.workers.dev/',
  kind: 'edge' as const,
  relayKey: hex(32),
  extraUrls: ['https://relay.mine.example/'],
  registrationKey: `lrt1.${randomBytes(32).toString('base64url')}`,
}

async function host(region?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'latch-relay-choice-'))
  folders.push(directory)
  const identity = await loadOrCreateHostIdentity(directory)
  const profiles = await RelayProfiles.open(directory)
  const books = new HostAddressBooks(
    profiles,
    identity,
    () => [],
    undefined,
    () => region,
  )
  const book = async (): Promise<NativeAddressBook> =>
    verifyAddressBook(await books.issue(deviceId), identity.publicKeySpki, { hostId: identity.hostId, deviceId })
  return { directory, profiles, book }
}
const ids = (book: NativeAddressBook) => book.relays.map(relay => Buffer.from(relay.relayId).toString('hex'))
const id = (value: string) => value

it('(a) offers only the official nodes, edge-identified, nearest region first for the client', async () => {
  const t = await host('apac-se')
  await t.profiles.syncOfficial(official)
  const book = await t.book()
  expect(ids(book)).toEqual(official.map(item => id(item.relayId)))
  expect(book.relays.every(relay => relay.edge && relay.profile === 'outer-pad-v2' && relay.spkiHash.every(byte => byte === 0))).toBe(true)
  expect(Buffer.from(book.relays[1]!.edge!.relayKey).toString('hex')).toBe(official[1]!.relayKey)
  expect(relayUrls(book.relays[1]!)).toEqual(official[1]!.urls)
  expect(book.hostRegion).toBe('apac-se')
  expect(orderRelays(book).map(relay => relay.region)).toEqual(['apac-se', 'apac-ne'])
})

it('(b, c) offers a person’s own self-hosted or edge relay alone, with the identity of its kind', async () => {
  const self = await host()
  await self.profiles.replace([ownSelf])
  const selfBook = await self.book()
  expect(selfBook.relays).toHaveLength(1)
  expect(selfBook.relays[0]!.edge).toBeUndefined()
  expect(Buffer.from(selfBook.relays[0]!.spkiHash).toString('hex')).toBe(ownSelf.spkiHash)
  const edge = await host()
  await edge.profiles.replace([ownEdge])
  const edgeBook = await edge.book()
  expect(Buffer.from(edgeBook.relays[0]!.edge!.relayKey).toString('hex')).toBe(ownEdge.relayKey)
  expect(relayUrls(edgeBook.relays[0]!)).toEqual([ownEdge.url, ...ownEdge.extraUrls])
  expect(edgeBook.hostRegion).toBeUndefined()
})

it('(d, e) follows the order of preference and the official switch, and drops a removed relay', async () => {
  const t = await host('apac-ne')
  await t.profiles.syncOfficial(official)
  await t.profiles.replace([ownSelf, ownEdge])
  const officialFirst = await t.book()
  expect(ids(officialFirst)).toEqual([...official.map(item => id(item.relayId)), id(ownSelf.relayId), id(ownEdge.relayId)])
  expect(officialFirst.hostRegion).toBe('apac-ne')
  const audited: unknown[] = []
  const record = async (detail: unknown) => {
    audited.push(detail)
    return true
  }
  await t.profiles.setOfficial({ ownFirst: true }, () => {}, record)
  const ownFirst = await t.book()
  expect(ids(ownFirst)).toEqual([id(ownSelf.relayId), id(ownEdge.relayId), ...official.map(item => id(item.relayId))])
  // The Host region would put an official node ahead of the person's own: it is left out.
  expect(ownFirst.hostRegion).toBeUndefined()
  expect(Buffer.from(orderRelays(ownFirst)[0]!.relayId).toString('hex')).toBe(ownSelf.relayId)
  await t.profiles.setOfficial({ enabled: false }, () => {}, record)
  expect(ids(await t.book())).toEqual([id(ownSelf.relayId), id(ownEdge.relayId)])
  await t.profiles.removeObserver({ relayId: ownSelf.relayId }, () => {}, record)
  expect(ids(await t.book())).toEqual([id(ownEdge.relayId)])
  await t.profiles.setOfficial({ enabled: true, ownFirst: false }, () => {}, record)
  expect(ids(await t.book())).toEqual([...official.map(item => id(item.relayId)), id(ownEdge.relayId)])
  expect(audited).toHaveLength(4)
})

it('reads a relays.json written before the edge kind unchanged, with the same configuration hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'latch-relay-choice-'))
  folders.push(directory)
  const seed = () => `lrs1.${randomBytes(32).toString('base64url')}`
  const old = {
    version: 1,
    generation: 3,
    configRevision: 2,
    discoveryKey: `lnd1.${randomBytes(32).toString('base64url')}`,
    profiles: [{ ...ownSelf, seeds: [seed(), seed()], activeSlot: 0, rotationDay: 0, rotations: 0 }],
  }
  await mkdir(join(directory, 'native'), { mode: 0o700 })
  await writeFile(join(directory, 'native/relays.json'), JSON.stringify(old), { mode: 0o600 })
  const profiles = await RelayProfiles.open(directory)
  expect(profiles.snapshot()).toEqual(old)
  expect(profiles.configHash()).toBe(
    sha256Hex(canonicalJson({ direct: null, directory: null, profiles: old.profiles, revision: old.configRevision })),
  )
})

it('imports relay files of both kinds, the self-hosted one as written before the edge kind', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'latch-relay-choice-'))
  folders.push(directory)
  const write = async (name: string, value: unknown) => {
    await writeFile(join(directory, name), JSON.stringify(value), { mode: 0o600 })
    return join(directory, name)
  }
  const selfFile = await write('self.json', { version: 1, profile: ownSelf })
  expect(await readRelayFile(selfFile)).toEqual(ownSelf)
  const { kind: _kind, ...edgeFields } = ownEdge
  const edgeFile = await write('edge.json', { version: 2, profile: ownEdge })
  expect(await readRelayFile(edgeFile)).toEqual(ownEdge)
  const facts = relayFacts(ownEdge)
  expect(facts).toContain(`中继公钥：${ownEdge.relayKey}`)
  expect(facts).toContain(`地址：${ownEdge.extraUrls[0]}`)
  expect(facts.join('\n')).not.toContain(ownEdge.registrationKey)
  for (const [name, value] of [
    ['v1-edge.json', { version: 1, profile: ownEdge }],
    ['v2-self.json', { version: 2, profile: ownSelf }],
    ['v2-nokind.json', { version: 2, profile: edgeFields }],
    ['v3.json', { version: 3, profile: ownEdge }],
    ['repeat.json', { version: 2, profile: { ...ownEdge, extraUrls: [ownEdge.url] } }],
  ] as const)
    await expect(readRelayFile(await write(name, value))).rejects.toThrow()
})

it('keeps a relay added with the Host stopped out of books until its node is verified, and refuses an official ID', async () => {
  const t = await host()
  await t.profiles.syncOfficial(official)
  await t.profiles.addUnverified(ownEdge, t.profiles.configHash())
  expect(ids(await t.book())).toEqual(official.map(item => item.relayId))
  await t.profiles.markVerified(ownEdge.relayId)
  expect(ids(await t.book())).toEqual([...official.map(item => item.relayId), ownEdge.relayId])
  expect(() => t.profiles.assertNewRelay({ relayId: official[0]!.relayId, url: 'https://other.example/' }, official)).toThrow(
    expect.objectContaining({ code: 'native-relay-official' }),
  )
})

it('turns the official relay on only once the audit is written; turning it off never waits', async () => {
  const t = await host()
  await t.profiles.syncOfficial(official)
  const failing = { append: async () => Promise.reject(new Error('disk full')) }
  const settings = new NativeSettings({
    profiles: t.profiles,
    native: {} as never,
    controller: { reconcile() {} } as never,
    audit: failing as never,
    pairing: () => false,
    reachable: () => false,
  })
  let auditFailed = 0
  await settings.setOfficial(
    { enabled: false },
    { listener: 'unix' },
    () => {},
    () => auditFailed++,
  )
  expect(t.profiles.snapshot().officialOff).toBe(true)
  expect(auditFailed).toBe(1)
  await expect(settings.setOfficial({ enabled: true }, { listener: 'unix' }, () => {})).rejects.toMatchObject({ code: 'audit-unavailable' })
  expect(t.profiles.snapshot().officialOff).toBe(true)
})
