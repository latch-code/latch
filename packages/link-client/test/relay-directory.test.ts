import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import {
  decodeRelayAuthority,
  decodeRelayDirectory,
  encodeRelayAuthority,
  encodeRelayDirectory,
  encodeSignedRelayDirectory,
  relayAuthorityInput,
  relayDirectoryInput,
  type NativeDirectorySource,
} from '@latch/link-wire'
import { nodeCrypto } from '../src/crypto.ts'
import { RelayDirectoryCache, type DirectoryStorage } from '../src/relay-directory.ts'

async function fixture() {
  const { directory: vector } = JSON.parse(await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8')) as {
    directory: { now: number; root: string; authority: string; addresses: string }
  }
  const root = decodeRelayAuthority(Buffer.from(vector.authority, 'hex')),
    online = decodeRelayDirectory(Buffer.from(vector.addresses, 'hex'))
  const source: NativeDirectorySource = { anchors: [Buffer.from(vector.root, 'hex')], mirrors: ['https://directory.example/relays-v1.bin'] }
  let time = vector.now,
    data: string | undefined
  const writes: string[] = []
  const storage: DirectoryStorage = {
    async read() {
      return data
    },
    async write(value) {
      data = value
      writes.push(value)
    },
  }
  async function signed(onlineSeed = new Uint8Array(32).fill(4)) {
    const authority = encodeRelayAuthority(root)
    online.rootGeneration = root.generation
    online.rootHash = await nodeCrypto.hash(authority)
    const directory = encodeRelayDirectory(online)
    return encodeSignedRelayDirectory({
      authority,
      directory,
      rootSignature: await nodeCrypto.sign(new Uint8Array(32).fill(3), relayAuthorityInput(authority)),
      signature: await nodeCrypto.sign(onlineSeed, relayDirectoryInput(directory)),
    })
  }
  return {
    root,
    online,
    source,
    storage,
    writes,
    signed,
    now: () => time,
    advance: (ms: number) => {
      time += ms
    },
  }
}
it('persists the offline Root before online addresses and refuses same-generation changes and rollback after restart', async () => {
  const f = await fixture(),
    original = await f.signed(),
    cache = await RelayDirectoryCache.open(f.source, f.storage, f.now)
  await cache.adopt(original)
  expect(JSON.parse(f.writes[0]!)).toHaveProperty('root')
  expect(JSON.parse(f.writes[0]!)).not.toHaveProperty('last')
  expect(JSON.parse(f.writes[1]!)).toHaveProperty('last')
  const node = f.root.nodes[0]!
  expect(cache.candidates(node.relayId, node.spkiHashes[0]!)).toEqual([{ url: 'https://relay.example/', address: '8.8.8.8' }])
  f.online.nodes[0]!.addresses = ['1.1.1.1']
  await expect(cache.adopt(await f.signed())).rejects.toThrow('conflict')
  f.online.generation++
  await cache.adopt(await f.signed())
  const restored = await RelayDirectoryCache.open(f.source, f.storage, f.now)
  expect(restored.candidates(node.relayId, node.spkiHashes[0]!)[0]?.address).toBe('1.1.1.1')
  await expect(restored.adopt(original)).rejects.toThrow('rollback')
  expect(restored.candidates(new Uint8Array(16), node.spkiHashes[0]!)).toEqual([])
  expect(restored.candidates(node.relayId, new Uint8Array(32))).toEqual([])
})
it('retains a newer Root revocation when online verification fails, including across restart and later reissue', async () => {
  const f = await fixture(),
    original = await f.signed(),
    cache = await RelayDirectoryCache.open(f.source, f.storage, f.now)
  await cache.adopt(original)
  f.root.generation++
  f.root.revokedKeys = [f.online.key]
  f.online.generation++
  await expect(cache.adopt(await f.signed())).rejects.toThrow('delegation')
  expect(cache.status()).toMatchObject({ rootGeneration: 2, ready: false })
  const restored = await RelayDirectoryCache.open(f.source, f.storage, f.now)
  expect(restored.sources().minimum?.generation).toBe(2)
  await expect(restored.adopt(original)).rejects.toThrow('rollback')
  const seed = new Uint8Array(32).fill(5),
    key = await nodeCrypto.publicKey(seed)
  // A revised delegation itself requires a new offline generation.
  f.root.generation++
  f.root.keys.push({ ...f.root.keys[0]!, publicKey: key })
  f.online.key = key
  f.online.generation = 1
  await restored.adopt(await f.signed(seed))
  expect(restored.status()).toEqual({ generation: 1, rootGeneration: 3, ready: true })
})
it('keeps both floors after expiry without dialing historical addresses and applies a Host-signed minimum', async () => {
  const f = await fixture(),
    cache = await RelayDirectoryCache.open(f.source, f.storage, f.now)
  await cache.adopt(await f.signed())
  f.advance(10_000_000)
  const expired = await RelayDirectoryCache.open(f.source, f.storage, f.now)
  expect(expired.status()).toEqual({ generation: 1, rootGeneration: 1, ready: false })
  expect(expired.candidates(f.root.nodes[0]!.relayId, f.root.nodes[0]!.spkiHashes[0]!)).toEqual([])
  const future = await RelayDirectoryCache.open({ ...f.source, minimum: { generation: 2, hash: new Uint8Array(32) } }, f.storage, f.now)
  expect(future.sources().minimum?.generation).toBe(2)
  expect(future.status().ready).toBe(false)
})
it('never republishes older online data after an uncertain atomic commit and retries the exact signed transcript', async () => {
  const f = await fixture()
  let fail = false
  const storage: DirectoryStorage = {
    read: f.storage.read,
    async write(value) {
      await f.storage.write(value)
      if (fail) {
        fail = false
        throw new Error('Injected unknown result')
      }
    },
  }
  const cache = await RelayDirectoryCache.open(f.source, storage, f.now),
    first = await f.signed()
  await cache.adopt(first)
  f.online.generation++
  const second = await f.signed()
  fail = true
  await expect(cache.adopt(second)).rejects.toThrow('unknown')
  expect(() => cache.sources()).toThrow('unknown')
  expect(cache.status().ready).toBe(false)
  await expect(cache.adopt(first)).rejects.toThrow('rollback')
  await cache.adopt(second)
  expect(cache.status()).toEqual({ generation: 2, rootGeneration: 1, ready: true })
})
it('rejects an offline replay on a fresh phone using both floors signed into the current Host book', async () => {
  const f = await fixture(),
    cache = await RelayDirectoryCache.open(f.source, f.storage, f.now),
    original = await f.signed()
  await cache.adopt(original)
  f.online.generation++
  const current = await f.signed()
  await cache.adopt(current)
  const source = cache.sources()
  expect(source.minimum?.generation).toBe(1)
  expect(source.minimumOnline?.generation).toBe(2)
  let data: string | undefined
  const storage: DirectoryStorage = {
    async read() {
      return data
    },
    async write(value) {
      data = value
    },
  }
  const phone = await RelayDirectoryCache.open(source, storage, f.now)
  await expect(phone.adopt(original)).rejects.toThrow('rollback')
  expect(phone.status().ready).toBe(false)
  const restored = await RelayDirectoryCache.open(source, storage, f.now)
  await expect(restored.adopt(original)).rejects.toThrow('rollback')
  await restored.adopt(current)
  expect(restored.status().ready).toBe(true)
  f.online.nodes[0]!.addresses = ['1.1.1.1']
  await expect(restored.adopt(await f.signed())).rejects.toThrow('conflict')
})
it('snapshots roots before storage awaits and snapshots a queued online transcript before the caller can mutate it', async () => {
  const f = await fixture(),
    cache = await RelayDirectoryCache.open(f.source, f.storage, f.now)
  await cache.adopt(await f.signed())
  let entered!: () => void, release!: () => void
  const arrived = new Promise<void>(resolve => {
      entered = resolve
    }),
    barrier = new Promise<void>(resolve => {
      release = resolve
    })
  const source = structuredClone(f.source)
  const pending = RelayDirectoryCache.open(
    source,
    {
      async read() {
        entered()
        await barrier
        return f.storage.read()
      },
      write: f.storage.write,
    },
    f.now,
  )
  await arrived
  source.anchors[0]!.fill(0)
  source.mirrors[0] = 'http://changed.invalid/'
  release()
  const restored = await pending
  expect(restored.status().ready).toBe(true)
  f.online.generation++
  const encoded = await f.signed(),
    accepted = restored.adopt(encoded)
  encoded.fill(0)
  await accepted
  const publicView = restored.sources()
  publicView.anchors[0]!.fill(0)
  publicView.minimumOnline!.hash.fill(0)
  expect(restored.status()).toEqual({ generation: 2, rootGeneration: 1, ready: true })
  await expect(restored.adopt(await f.signed())).resolves.toBeUndefined()
})
it('recovers from a capped compromised online counter only through a newer offline Root', async () => {
  const f = await fixture(),
    cache = await RelayDirectoryCache.open(f.source, f.storage, f.now)
  f.online.generation = Number.MAX_SAFE_INTEGER
  const capped = await f.signed()
  await cache.adopt(capped)
  const formerBookSource = cache.sources()
  const seed = new Uint8Array(32).fill(5),
    key = await nodeCrypto.publicKey(seed)
  f.root.generation++
  f.root.revokedKeys = [f.online.key]
  f.root.keys.push({ ...f.root.keys[0]!, publicKey: key })
  f.online.key = key
  f.online.generation = 1
  await cache.adopt(await f.signed(seed))
  expect(cache.status()).toEqual({ generation: 1, rootGeneration: 2, ready: true })
  const restarted = await RelayDirectoryCache.open(formerBookSource, f.storage, f.now)
  expect(restarted.status()).toEqual({ generation: 1, rootGeneration: 2, ready: true })
  expect(restarted.sources().minimumOnline?.generation).toBe(1)
  await expect(restarted.adopt(capped)).rejects.toThrow('rollback')
})
