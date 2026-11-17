import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { orderRelays, type NativeAddressBook } from '@latch/link-wire'
import { verifyAddressBook } from '@latch/link-client'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { HostAddressBooks } from '../src/relay/address-book.ts'
import { NativeSettings } from '../src/native-settings.ts'
import { classify } from '../src/relay/controller.ts'
import { RelayClosed } from '@latch/link-client'
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
const officialSelf = { relayId: hex(16), kind: 'self' as const, url: 'https://official.example/', spkiHash: hex(32) }
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
  return { directory, profiles, book, books, identity }
}
const ids = (book: NativeAddressBook) => book.relays.map(relay => Buffer.from(relay.relayId).toString('hex'))

it('keeps built-in Workers entries out of address books while the platform is unavailable', async () => {
  const t = await host('apac-se')
  await t.profiles.syncOfficial(official)
  const book = await t.book()
  expect(t.profiles.snapshot().profiles.map(profile => profile.relayId)).toEqual(official.map(profile => profile.relayId))
  expect(ids(book)).toEqual([])
  expect(book.hostRegion).toBeUndefined()
})

it('signs a self-hosted node with its pinned key and reports signing for that profile only', async () => {
  const self = await host()
  await self.profiles.replace([ownSelf])
  expect(self.books.bookIssuedAt(ownSelf.relayId)).toBeUndefined()
  const selfBook = await self.book()
  expect(selfBook.relays).toHaveLength(1)
  expect(selfBook.relays[0]!.edge).toBeUndefined()
  expect(Buffer.from(selfBook.relays[0]!.spkiHash).toString('hex')).toBe(ownSelf.spkiHash)
  expect(self.books.bookIssuedAt(ownSelf.relayId)).toEqual(expect.any(Number))
  await self.profiles.removeObserver(
    { relayId: ownSelf.relayId },
    () => {},
    async () => true,
  )
  await self.profiles.replace([ownSelf])
  expect(self.books.bookIssuedAt(ownSelf.relayId)).toBeUndefined()
})

it('follows the order of preference and the official switch, and drops a removed relay', async () => {
  const t = await host('apac-ne')
  await t.profiles.syncOfficial([officialSelf])
  await t.profiles.replace([ownSelf])
  const officialFirst = await t.book()
  expect(ids(officialFirst)).toEqual([officialSelf.relayId, ownSelf.relayId])
  const audited: unknown[] = []
  const record = async (detail: unknown) => {
    audited.push(detail)
    return true
  }
  await t.profiles.setOfficial({ ownFirst: true }, () => {}, record)
  const ownFirst = await t.book()
  expect(ids(ownFirst)).toEqual([ownSelf.relayId, officialSelf.relayId])
  // The Host region would put an official node ahead of the person's own: it is left out.
  expect(ownFirst.hostRegion).toBeUndefined()
  expect(Buffer.from(orderRelays(ownFirst)[0]!.relayId).toString('hex')).toBe(ownSelf.relayId)
  await t.profiles.setOfficial({ enabled: false }, () => {}, record)
  expect(ids(await t.book())).toEqual([ownSelf.relayId])
  await t.profiles.removeObserver({ relayId: ownSelf.relayId }, () => {}, record)
  expect(ids(await t.book())).toEqual([])
  await t.profiles.setOfficial({ enabled: true, ownFirst: false }, () => {}, record)
  expect(ids(await t.book())).toEqual([officialSelf.relayId])
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
  await t.profiles.syncOfficial([officialSelf])
  await t.profiles.addUnverified(ownSelf, t.profiles.configHash(), async () => {})
  expect(ids(await t.book())).toEqual([officialSelf.relayId])
  await t.profiles.markVerified(
    t.profiles.snapshot().profiles.find(profile => profile.relayId === ownSelf.relayId)!,
    () => {},
  )
  expect(ids(await t.book())).toEqual([officialSelf.relayId, ownSelf.relayId])
  expect(() => t.profiles.assertNewRelay({ relayId: official[0]!.relayId, url: 'https://other.example/' }, official)).toThrow(
    expect.objectContaining({ code: 'native-relay-official' }),
  )
})

it('rejects adding Workers, while a saved Workers profile remains removable and is never signed', async () => {
  const t = await host()
  await expect(t.profiles.addUnverified(ownEdge, t.profiles.configHash(), async () => {})).rejects.toMatchObject({
    code: 'native-relay-platform-unavailable',
  })
  const seed = () => `lrs1.${randomBytes(32).toString('base64url')}`
  const state = {
    ...t.profiles.snapshot(),
    profiles: [{ ...ownEdge, seeds: [seed(), seed()], activeSlot: 0, rotationDay: 0, rotations: 0 }],
  }
  await writeFile(join(t.directory, 'native/relays.json'), JSON.stringify(state), { mode: 0o600 })
  const loaded = await RelayProfiles.open(t.directory)
  expect(loaded.snapshot().profiles).toHaveLength(1)
  const books = new HostAddressBooks(loaded, t.identity, () => [])
  const book = verifyAddressBook(await books.issue(deviceId), t.identity.publicKeySpki, { hostId: t.identity.hostId, deviceId })
  expect(book.relays).toEqual([])
  expect(books.bookIssuedAt(ownEdge.relayId)).toBeUndefined()
  await loaded.setDisabled(
    ownEdge.relayId,
    true,
    () => {},
    async () => true,
  )
  await expect(
    loaded.setDisabled(
      ownEdge.relayId,
      false,
      () => {},
      async () => true,
    ),
  ).rejects.toMatchObject({
    code: 'native-relay-platform-unavailable',
  })
  await loaded.removeObserver(
    { relayId: ownEdge.relayId },
    () => {},
    async () => true,
  )
  expect(loaded.snapshot().profiles).toEqual([])
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

it('keeps a disabled relay out of books and turns it on again only once the audit is written', async () => {
  const t = await host()
  await t.profiles.replace([ownSelf])
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
  await settings.setDisabled(
    ownSelf.relayId,
    true,
    { listener: 'unix' },
    () => {},
    () => auditFailed++,
  )
  expect(auditFailed).toBe(1)
  expect(ids(await t.book())).toEqual([])
  await expect(settings.setDisabled(ownSelf.relayId, false, { listener: 'unix' }, () => {})).rejects.toMatchObject({
    code: 'audit-unavailable',
  })
  expect(t.profiles.snapshot().profiles.find(item => item.relayId === ownSelf.relayId)?.disabled).toBe(true)
})

it('names a failed dial by what went wrong: another key, a refused registration, or no answer', () => {
  expect(classify(new Error('Relay identity rejected'))).toBe('mismatch')
  expect(classify(new Error('Relay certificate identity mismatch'))).toBe('mismatch')
  expect(classify(new RelayClosed(4100))).toBe('refused')
  expect(classify(new Error('connect ECONNREFUSED'))).toBe('unreachable')
})
