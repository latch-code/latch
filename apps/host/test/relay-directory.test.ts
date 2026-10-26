import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nodeCrypto, verifyAddressBook } from '@latch/link-client'
import {
  encodeRelayAuthority,
  encodeRelayDirectory,
  encodeSignedRelayDirectory,
  relayAuthorityInput,
  relayDirectoryInput,
} from '@latch/link-wire'
import { RelayProfiles } from '../src/relay/profiles.ts'
import { HostRelayDirectory } from '../src/relay/directory.ts'
import { HostAddressBooks } from '../src/relay/address-book.ts'
import { loadOrCreateHostIdentity } from '../src/identity.ts'
import type { FetchLike } from '../src/egress.ts'
import type { NativeLinkInfo } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'

const failedStorage = vi.hoisted(() => ({ beforeCommit: false }))
vi.mock('@latch/core/node-kit', async original => {
  const actual = await original<typeof import('@latch/core/node-kit')>()
  return {
    ...actual,
    async writeFileAtomic(path: string, data: string, options?: Parameters<typeof actual.writeFileAtomic>[2]) {
      if (failedStorage.beforeCommit && path.endsWith('trust.json')) throw new Error('Fixture write failed before commit')
      return actual.writeFileAtomic(path, data, options)
    },
  }
})

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  failedStorage.beforeCommit = false
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).toReversed()) await close()
})

it('keeps an unknown higher Root through source replacement and disabling before the prior disk image can be reused', async () => {
  const f = await fixture()
  let now = Date.now(),
    payload = await f.signed()
  const fetch = vi.fn(async () => new Response(new Uint8Array(payload)))
  const service = await HostRelayDirectory.open({ ...f, now: () => now, fetch })
  cleanup.push(() => service.close())
  await service.refresh()
  failedStorage.beforeCommit = true
  f.root.generation = 2
  payload = await f.signed()
  now += 7 * 3600_000
  await service.refresh()
  expect(f.profiles.snapshot().directoryFloor?.minimum.generation).toBe(1)
  expect(service.status().rootGeneration).toBe(2)
  const changed = { ...f.config, mirrors: ['https://replacement-directory.example/addresses.bin'] }
  await f.profiles.configure(null, [], undefined, undefined, changed)
  await expect(service.configure()).rejects.toMatchObject({ code: 'native-directory-unavailable' })
  expect(() => service.sources()).toThrow()
  expect(service.candidates(f.relayId, f.spkiHash)).toEqual([])
  const fetchedBeforeFence = fetch.mock.calls.length
  now += 31_000
  await service.refresh()
  expect(fetch).toHaveBeenCalledTimes(fetchedBeforeFence)
  await f.profiles.configure(null, [], undefined, undefined, null)
  await service.configure()
  expect(service.sources()).toBeUndefined()
  expect(service.candidates(f.relayId, f.spkiHash)).toEqual([])
  await f.profiles.configure(null, [], undefined, undefined, changed)
  await expect(service.configure()).rejects.toMatchObject({ code: 'native-directory-unavailable' })
  now += 31_000
  await service.refresh()
  expect(fetch).toHaveBeenCalledTimes(fetchedBeforeFence)
  failedStorage.beforeCommit = false
  await service.configure()
  expect(service.sources()?.minimum?.generation).toBe(2)
  expect((await RelayProfiles.open(f.dataDir)).snapshot().directoryFloor?.minimum.generation).toBe(2)
})
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-host-directory-'))
  cleanup.push(() => rm(dataDir, { force: true, recursive: true }))
  const profiles = await RelayProfiles.open(dataDir),
    rootKey = new Uint8Array(32).fill(3),
    onlineKey = new Uint8Array(32).fill(4),
    now = Date.now()
  const relayId = new Uint8Array(16).fill(7),
    spkiHash = new Uint8Array(32).fill(8),
    publicKey = await nodeCrypto.publicKey(onlineKey)
  const root = {
    generation: 1,
    issuedAt: now - 1000,
    expiresAt: now + 86_400_000,
    keys: [{ publicKey, notBefore: now - 1000, notAfter: now + 86_400_000 }],
    revokedKeys: [] as Uint8Array[],
    nodes: [{ relayId, region: 'self-hosted', spkiHashes: [spkiHash], ports: [] }],
  }
  const online = {
    generation: 1,
    issuedAt: now - 1000,
    expiresAt: now + 3600_000,
    rootGeneration: 1,
    rootHash: new Uint8Array(32),
    key: publicKey,
    nodes: [{ relayId, host: 'relay.example', port: 443, addresses: ['8.8.8.8'] }],
  }
  const config = {
    anchors: [Buffer.from(await nodeCrypto.publicKey(rootKey)).toString('hex')],
    mirrors: ['https://directory.example/addresses.bin'],
  }
  await profiles.configure(null, [], undefined, undefined, config)
  async function signed() {
    const authority = encodeRelayAuthority(root)
    online.rootGeneration = root.generation
    online.rootHash = new Uint8Array(await nodeCrypto.hash(authority))
    const directory = encodeRelayDirectory(online)
    return encodeSignedRelayDirectory({
      authority,
      directory,
      rootSignature: await nodeCrypto.sign(rootKey, relayAuthorityInput(authority)),
      signature: await nodeCrypto.sign(onlineKey, relayDirectoryInput(directory)),
    })
  }
  return {
    dataDir,
    profiles,
    root,
    online,
    config,
    relayId: Buffer.from(relayId).toString('hex'),
    spkiHash: Buffer.from(spkiHash).toString('hex'),
    signed,
  }
}

it('fetches one bounded owner, persists both floors, signs them into a v2 book, and retains them after removal/restart', async () => {
  const f = await fixture(),
    bytes = await f.signed(),
    fetch = vi.fn<FetchLike>(async (_url, init) => {
      expect(init.redirect).toBe('error')
      expect(init.credentials).toBe('omit')
      return new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length) } })
    })
  const service = await HostRelayDirectory.open({ ...f, fetch })
  cleanup.push(() => service.close())
  await Promise.all([service.refresh(), service.refresh(), service.refresh()])
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(service.status()).toEqual({ ready: true, rootGeneration: 1, generation: 1 })
  expect(service.candidates(f.relayId, f.spkiHash)).toEqual([{ url: 'https://relay.example/', address: '8.8.8.8' }])
  expect(service.candidates('0'.repeat(32), f.spkiHash)).toEqual([])
  const identity = await loadOrCreateHostIdentity(f.dataDir),
    deviceId = `dev_${Buffer.alloc(16, 9).toString('base64url')}`
  const encoded = await new HostAddressBooks(
    f.profiles,
    identity,
    () => [],
    () => service.sources(),
  ).issue(deviceId)
  const book = verifyAddressBook(encoded, identity.publicKeySpki, { hostId: identity.hostId, deviceId })
  expect(book.directory?.minimum?.generation).toBe(1)
  expect(book.directory?.minimumOnline?.generation).toBe(1)
  const folder = join(f.dataDir, 'native/directories'),
    file = join(folder, (await readdir(folder))[0]!)
  expect((await stat(folder)).mode & 0o077).toBe(0)
  expect((await stat(file)).mode & 0o077).toBe(0)
  await f.profiles.configure(null, [], undefined, undefined, null)
  await service.configure()
  expect(service.sources()).toBeUndefined()
  expect(f.profiles.snapshot().directoryFloor?.minimumOnline?.generation).toBe(1)
  await service.close()
  const reopened = await RelayProfiles.open(f.dataDir)
  await reopened.configure(null, [], undefined, undefined, f.config)
  const restored = await HostRelayDirectory.open({
    dataDir: f.dataDir,
    profiles: reopened,
    fetch: async () => {
      throw new Error('offline fixture')
    },
  })
  cleanup.push(() => restored.close())
  expect(restored.sources()?.minimumOnline?.generation).toBe(1)
  expect(restored.candidates(f.relayId, f.spkiHash)).toHaveLength(1)
  await restored.close()
  await chmod(file, 0o644)
  await expect(HostRelayDirectory.open({ dataDir: f.dataDir, profiles: reopened, fetch })).rejects.toMatchObject({
    code: 'native-directory-unavailable',
  })
})

it('commits a new Root revocation even when online validation fails, and never permits an old first-phone floor', async () => {
  const f = await fixture()
  let now = Date.now(),
    payload = await f.signed()
  const service = await HostRelayDirectory.open({ ...f, now: () => now, fetch: async () => new Response(new Uint8Array(payload)) })
  cleanup.push(() => service.close())
  await service.refresh()
  f.root.generation = 2
  f.root.revokedKeys = [f.online.key]
  payload = await f.signed()
  now += 7 * 3600_000
  await service.refresh()
  expect(service.sources()?.minimum?.generation).toBe(2)
  expect(service.sources()?.minimumOnline).toBeUndefined()
  expect(service.candidates(f.relayId, f.spkiHash)).toEqual([])
  expect((await RelayProfiles.open(f.dataDir)).snapshot().directoryFloor?.minimum.generation).toBe(2)
  await expect(
    f.profiles.saveDirectoryFloor((await import('../src/relay/directory-config.ts')).directoryConfigHash(f.config), {
      minimum: { generation: 1, hash: '0'.repeat(64) },
    }),
  ).rejects.toThrow('rollback')
})

it('rejects oversized streaming mirrors, never follows redirects, and rate-limits failure wakeups', async () => {
  const f = await fixture(),
    fetch = vi.fn<FetchLike>(async () => new Response(new Uint8Array(32_769)))
  const service = await HostRelayDirectory.open({ ...f, fetch })
  cleanup.push(() => service.close())
  await service.refresh()
  await service.refresh()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(service.status().ready).toBe(false)
  expect(service.sources()?.minimum).toBeUndefined()
})

it('does not turn a replacement Root set into an empty cache or a reset of the prior floors', async () => {
  const f = await fixture(),
    payload = await f.signed()
  const service = await HostRelayDirectory.open({ ...f, fetch: async () => new Response(new Uint8Array(payload)) })
  cleanup.push(() => service.close())
  await service.refresh()
  await service.close()
  const roots = { ...f.config, anchors: [Buffer.from(await nodeCrypto.publicKey(new Uint8Array(32).fill(5))).toString('hex')] }
  await f.profiles.configure(null, [], undefined, undefined, roots)
  await expect(
    HostRelayDirectory.open({
      ...f,
      fetch: async () => {
        throw new Error('offline fixture')
      },
    }),
  ).rejects.toMatchObject({ code: 'native-directory-unavailable' })
  expect(f.profiles.snapshot().directoryFloor?.minimumOnline?.generation).toBe(1)
})

it('only accepts public roots/mirrors through Mac OS presence and never accepts user-supplied floors', async () => {
  const f = await fixture(),
    host = await startTestHost({
      nativeDirectoryFetch: async () => {
        throw new Error('offline fixture')
      },
    })
  cleanup.push(() => host.close())
  const desktop = await host.enroll({ listener: 'unix' }),
    browser = await host.enroll({ listener: 'loopback-tcp' })
  const initial = await desktop.json<NativeLinkInfo>('native/info'),
    body = {
      requestId: randomUUID(),
      configHash: initial.configHash,
      direct: initial.direct,
      relays: [],
      directory: { ...f.config, mirrors: [...f.config.mirrors, 'https://backup-directory.example/addresses.bin'] },
    }
  expect((await browser.request('native/config', { method: 'PUT', body })).status).toBe(403)
  expect(
    (
      await desktop.request('native/config', {
        method: 'PUT',
        body: { ...body, directory: { ...f.config, minimum: { generation: 1, hash: 'a'.repeat(64) } } },
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await desktop.request('native/config', {
        method: 'PUT',
        body: { ...body, directory: { ...f.config, mirrors: ['https://127.0.0.1/'] } },
      })
    ).status,
  ).toBe(400)
  const added = await desktop.confirmed('native/config', { method: 'PUT', body })
  expect(added.status).toBe(200)
  const preview = host.presence.requests.at(-1)!.preview
  expect(preview.subject?.form).toBe('policy.native-link')
  expect(preview.reason).toContain('地址目录 2 个镜像')
  expect(JSON.stringify(preview)).toContain(f.config.anchors[0])
  const info = (await added.json()) as NativeLinkInfo
  expect(info.directory?.anchors).toEqual(f.config.anchors)
  expect((await desktop.request('native/config', { method: 'PUT', body })).status).toBe(200)
  const count = host.presence.requests.length
  const reduced = await desktop.request('native/config', {
    method: 'PUT',
    body: { ...body, requestId: randomUUID(), configHash: info.configHash, directory: f.config },
  })
  expect(reduced.status).toBe(200)
  const reducedInfo = (await reduced.json()) as NativeLinkInfo
  expect(
    (
      await desktop.request('native/config', {
        method: 'PUT',
        body: { ...body, requestId: randomUUID(), configHash: reducedInfo.configHash, directory: null },
      })
    ).status,
  ).toBe(200)
  expect(host.presence.requests.length).toBe(count)
})
