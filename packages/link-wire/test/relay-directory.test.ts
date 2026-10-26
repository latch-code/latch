import { createHash, createPrivateKey, createPublicKey, sign, verify, randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  concat,
  encodeRelayAuthority,
  encodeRelayDirectory,
  relayAuthorityInput,
  relayDirectoryInput,
  verifyRelayDirectory,
  verifyRelayAuthority,
  isPublicDirectoryAddress,
  directoryEndpoint,
  type LinkCrypto,
  type RelayAuthority,
  type RelayDirectory,
  type SignedRelayDirectory,
} from '../src/index.ts'
const privateKey = (seed: Uint8Array) =>
  createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })
const crypto: LinkCrypto = {
  random: size => randomBytes(size),
  hash: async bytes => createHash('sha256').update(bytes).digest(),
  hmac: async () => {
    throw new Error('unused')
  },
  derive: async () => {
    throw new Error('unused')
  },
  publicKey: async seed => createPublicKey(privateKey(seed)).export({ format: 'der', type: 'spki' }).subarray(-32),
  sign: async (seed, bytes) => sign(null, bytes, privateKey(seed)),
  verify: async (key, bytes, signature) =>
    verify(
      null,
      bytes,
      createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key]), format: 'der', type: 'spki' }),
      signature,
    ),
}
async function fixture() {
  const offline = new Uint8Array(32).fill(3),
    online = new Uint8Array(32).fill(4),
    now = 1000000,
    anchor = await crypto.publicKey(offline),
    key = await crypto.publicKey(online),
    id = new Uint8Array(16).fill(9)
  const root: RelayAuthority = {
    generation: 1,
    issuedAt: now - 1000,
    expiresAt: now + 3000000,
    keys: [{ publicKey: key, notBefore: now - 1000, notAfter: now + 3000000 }],
    revokedKeys: [],
    nodes: [{ relayId: id, region: 'owner', spkiHashes: [new Uint8Array(32).fill(7)], ports: [8443] }],
  }
  const addresses: RelayDirectory = {
    generation: 1,
    issuedAt: now,
    expiresAt: now + 1000000,
    rootGeneration: 1,
    rootHash: new Uint8Array(32),
    key,
    nodes: [{ relayId: id, host: 'relay.example', port: 443, addresses: ['8.8.8.8'] }],
  }
  async function signed(): Promise<SignedRelayDirectory> {
    const authority = encodeRelayAuthority(root)
    addresses.rootHash = await crypto.hash(authority)
    addresses.rootGeneration = root.generation
    const directory = encodeRelayDirectory(addresses)
    return {
      authority,
      rootSignature: await crypto.sign(offline, relayAuthorityInput(authority)),
      directory,
      signature: await crypto.sign(online, relayDirectoryInput(directory)),
    }
  }
  return { root, addresses, signed, now, anchor }
}
it('accepts only offline-authorized identities and ports, with monotonic signed addresses and fixed root anchors', async () => {
  const f = await fixture(),
    first = await f.signed(),
    verified = await verifyRelayDirectory(crypto, first, [f.anchor], f.now)
  expect(verified.directory.nodes[0]?.addresses).toEqual(['8.8.8.8'])
  f.addresses.nodes[0]!.addresses = ['1.1.1.1']
  await expect(verifyRelayDirectory(crypto, await f.signed(), [f.anchor], f.now, verified.checkpoint)).rejects.toThrow('conflict')
  f.addresses.generation++
  const second = await verifyRelayDirectory(crypto, await f.signed(), [f.anchor], f.now, verified.checkpoint)
  await expect(verifyRelayDirectory(crypto, first, [f.anchor], f.now, second.checkpoint)).rejects.toThrow('rollback')
  f.addresses.nodes[0]!.relayId = new Uint8Array(16).fill(10)
  await expect(verifyRelayDirectory(crypto, await f.signed(), [f.anchor], f.now)).rejects.toThrow('observation')
  f.addresses.nodes[0]!.relayId = f.root.nodes[0]!.relayId
  f.addresses.nodes[0]!.port = 9443
  await expect(verifyRelayDirectory(crypto, await f.signed(), [f.anchor], f.now)).rejects.toThrow('observation')
  await expect(verifyRelayDirectory(crypto, first, [new Uint8Array(32)], f.now)).rejects.toThrow('root mismatch')
})
it('rejects revoked online keys, expired delegation, root substitutions and trailing bytes', async () => {
  const f = await fixture(),
    original = await f.signed()
  await expect(verifyRelayDirectory(crypto, original, [f.anchor], f.addresses.expiresAt)).rejects.toThrow('lifetime')
  f.root.revokedKeys = [f.addresses.key]
  f.root.generation++
  f.addresses.generation++
  await expect(verifyRelayDirectory(crypto, await f.signed(), [f.anchor], f.now)).rejects.toThrow('delegation')
  const changed = { ...original, authority: original.authority.slice() }
  changed.authority[1] = 2
  await expect(verifyRelayDirectory(crypto, changed, [f.anchor], f.now)).rejects.toThrow()
  await expect(
    verifyRelayDirectory(crypto, { ...original, directory: concat(original.directory, Uint8Array.of(0)) }, [f.anchor], f.now),
  ).rejects.toThrow()
})
it('advances the offline floor even when the accompanying online signer was revoked', async () => {
  const f = await fixture(),
    original = await f.signed()
  const first = await verifyRelayAuthority(crypto, original.authority, original.rootSignature, [f.anchor], f.now)
  f.root.generation++
  f.root.revokedKeys = [f.addresses.key]
  const revoked = await f.signed()
  const current = await verifyRelayAuthority(crypto, revoked.authority, revoked.rootSignature, [f.anchor], f.now, first.checkpoint)
  await expect(verifyRelayDirectory(crypto, revoked, [f.anchor], f.now)).rejects.toThrow('delegation')
  await expect(
    verifyRelayAuthority(crypto, original.authority, original.rootSignature, [f.anchor], f.now, current.checkpoint),
  ).rejects.toThrow('rollback')
  f.root.nodes[0]!.region = 'changed'
  const conflict = await f.signed()
  await expect(
    verifyRelayAuthority(crypto, conflict.authority, conflict.rootSignature, [f.anchor], f.now, current.checkpoint),
  ).rejects.toThrow('conflict')
})
it('rejects local, metadata, mapped, multicast, documentation and ambiguous addresses', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '224.1.2.3',
    '192.0.2.1',
    '8.008.8.8',
    '::1',
    '::ffff:8.8.8.8',
    '2001:db8::1',
    'fe80::1',
    'ff02::1',
    '3fff::1',
  ])
    expect(isPublicDirectoryAddress(address)).toBe(false)
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])
    expect(isPublicDirectoryAddress(address)).toBe(true)
  expect(() => directoryEndpoint('localhost', 443)).toThrow()
  expect(() => directoryEndpoint('127.0.0.1', 443)).toThrow()
})
it('freezes the entire transcript, anchors and checkpoint before asynchronous verification', async () => {
  const f = await fixture(),
    bundle = await f.signed(),
    anchor = f.anchor.slice()
  let altered = false
  const checked = await verifyRelayDirectory(
    {
      ...crypto,
      verify: async (...args) => {
        if (!altered) {
          altered = true
          bundle.directory.fill(0)
          anchor.fill(0)
        }
        return crypto.verify(...args)
      },
    },
    bundle,
    [anchor],
    f.now,
  )
  expect(checked.directory.nodes[0]?.host).toBe('relay.example')
})
