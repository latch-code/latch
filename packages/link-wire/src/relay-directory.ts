import { ascii, concat, equal, field, fixed, hex, Reader, uint } from './bytes.ts'
import type { LinkCrypto } from './crypto.ts'

const DAY = 86_400_000
export const DIRECTORY_LIMIT = 32_768
export interface RelayAuthorityNode {
  relayId: Uint8Array
  region: string
  spkiHashes: Uint8Array[]
  ports: number[]
}
export interface RelayAuthority {
  generation: number
  issuedAt: number
  expiresAt: number
  keys: Array<{ publicKey: Uint8Array; notBefore: number; notAfter: number }>
  revokedKeys: Uint8Array[]
  nodes: RelayAuthorityNode[]
}
export interface RelayDirectory {
  generation: number
  issuedAt: number
  expiresAt: number
  rootGeneration: number
  rootHash: Uint8Array
  key: Uint8Array
  nodes: Array<{ relayId: Uint8Array; host: string; port: number; addresses: string[] }>
}
export interface DirectoryCheckpoint {
  rootGeneration: number
  rootHash: Uint8Array
  generation: number
  hash: Uint8Array
}
export interface AuthorityCheckpoint {
  generation: number
  hash: Uint8Array
}
export interface SignedRelayDirectory {
  authority: Uint8Array
  rootSignature: Uint8Array
  directory: Uint8Array
  signature: Uint8Array
}
const unique = (values: readonly string[]) => new Set(values).size === values.length
function time(generation: number, issuedAt: number, expiresAt: number, ttl: number): void {
  if (
    ![generation, issuedAt, expiresAt].every(Number.isSafeInteger)
    || generation < 1
    || issuedAt < 0
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > ttl
  )
    throw new RangeError('Invalid directory lifetime')
}
function text(bytes: Uint8Array): string {
  if (bytes.some(byte => byte < 33 || byte > 126)) throw new RangeError('Invalid directory text')
  return String.fromCharCode(...bytes)
}
/** Literal public unicast only; DNS resolution and local-interface checks remain mandatory at the platform boundary. */
export function isPublicDirectoryAddress(value: string): boolean {
  if (/^(?:[0-9]+\.){3}[0-9]+$/u.test(value)) {
    const n = value.split('.').map(Number)
    if (n.some((part, index) => part > 255 || String(part) !== value.split('.')[index])) return false
    const [a = 0, b = 0, c = 0] = n
    return (
      a > 0
      && a < 224
      && a !== 10
      && a !== 127
      && !(a === 100 && b >= 64 && b < 128)
      && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b < 32)
      && !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      && !(a === 203 && b === 0 && c === 113)
    )
  }
  if (!/^[a-f0-9:]{2,39}$/u.test(value) || value.split('::').length > 2) return false
  const halves = value.split('::'),
    left = halves[0] ? halves[0].split(':') : [],
    right = halves[1] ? halves[1].split(':') : []
  if ([...left, ...right].some(part => !/^[a-f0-9]{1,4}$/u.test(part))) return false
  const gap = 8 - left.length - right.length
  if (halves.length === 1 ? gap !== 0 : gap < 1) return false
  const n = [...left, ...Array.from({ length: gap }, () => '0'), ...right].map(part => Number.parseInt(part, 16)),
    a = n[0]!,
    b = n[1]!
  return (a & 0xe000) === 0x2000 && !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) && a !== 0x2002 && !(a === 0x3fff && b < 0x1000)
}
export function directoryEndpoint(host: string, port: number): string {
  const ip = host.includes(':') || /^[0-9.]+$/u.test(host)
  if (
    !Number.isInteger(port)
    || port < 1
    || port > 65535
    || host.length > 253
    || (ip
      ? !isPublicDirectoryAddress(host)
      : !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host)
        || host.split('.').length < 2
        || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
        || /(?:^|\.)(?:localhost|local|invalid|test)$/u.test(host))
  )
    throw new RangeError('Invalid public directory endpoint')
  return `https://${host.includes(':') ? `[${host}]` : host}${port === 443 ? '' : `:${port}`}/`
}
export function encodeRelayAuthority(value: RelayAuthority): Uint8Array {
  time(value.generation, value.issuedAt, value.expiresAt, 365 * DAY)
  if (
    value.keys.length < 1
    || value.keys.length > 4
    || value.revokedKeys.length > 16
    || value.nodes.length > 4
    || !unique(value.keys.map(key => hex(key.publicKey)))
    || !unique(value.revokedKeys.map(hex))
    || !unique(value.nodes.map(node => hex(node.relayId)))
  )
    throw new RangeError('Invalid directory authority')
  const nodes = value.nodes.map(node => {
    if (
      !/^[\x21-\x7e]{1,64}$/u.test(node.region)
      || node.spkiHashes.length < 1
      || node.spkiHashes.length > 2
      || node.ports.length > 4
      || !unique(node.spkiHashes.map(hex))
      || !unique(node.ports.map(String))
      || node.ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)
    )
      throw new RangeError('Invalid directory node')
    return concat(
      fixed(node.relayId, 16),
      field(ascii(node.region)),
      uint(node.spkiHashes.length, 1),
      ...node.spkiHashes.map(pin => fixed(pin, 32)),
      uint(node.ports.length, 1),
      ...node.ports.map(port => uint(port, 2)),
    )
  })
  return concat(
    uint(1, 1),
    uint(value.generation, 8),
    uint(value.issuedAt, 8),
    uint(value.expiresAt, 8),
    uint(value.keys.length, 1),
    ...value.keys.map(key => {
      time(1, key.notBefore, key.notAfter, 365 * DAY)
      if (key.notBefore < value.issuedAt || key.notAfter > value.expiresAt) throw new RangeError('Invalid online delegation')
      return concat(fixed(key.publicKey, 32), uint(key.notBefore, 8), uint(key.notAfter, 8))
    }),
    uint(value.revokedKeys.length, 1),
    ...value.revokedKeys.map(key => fixed(key, 32)),
    uint(nodes.length, 1),
    ...nodes,
  )
}
export function decodeRelayAuthority(bytes: Uint8Array): RelayAuthority {
  const reader = new Reader(bytes, DIRECTORY_LIMIT / 2)
  if (reader.number(1) !== 1) throw new RangeError('Invalid directory version')
  const generation = reader.number(8),
    issuedAt = reader.number(8),
    expiresAt = reader.number(8),
    keyCount = reader.number(1)
  if (keyCount > 4) throw new RangeError('Directory key limit')
  const keys = Array.from({ length: keyCount }, () => ({
      publicKey: reader.take(32),
      notBefore: reader.number(8),
      notAfter: reader.number(8),
    })),
    revokedCount = reader.number(1)
  if (revokedCount > 16) throw new RangeError('Directory revocation limit')
  const revokedKeys = Array.from({ length: revokedCount }, () => reader.take(32)),
    count = reader.number(1)
  if (count > 4) throw new RangeError('Directory node limit')
  const nodes = Array.from({ length: count }, () => {
    const relayId = reader.take(16),
      region = text(reader.field(64)),
      pins = reader.number(1)
    if (pins > 2) throw new RangeError('Directory pin limit')
    const spkiHashes = Array.from({ length: pins }, () => reader.take(32)),
      portsCount = reader.number(1)
    if (portsCount > 4) throw new RangeError('Directory port limit')
    return { relayId, region, spkiHashes, ports: Array.from({ length: portsCount }, () => reader.number(2)) }
  })
  reader.done()
  const value = { generation, issuedAt, expiresAt, keys, revokedKeys, nodes }
  encodeRelayAuthority(value)
  return value
}
export function encodeRelayDirectory(value: RelayDirectory): Uint8Array {
  time(value.generation, value.issuedAt, value.expiresAt, 180 * DAY)
  if (
    !Number.isSafeInteger(value.rootGeneration)
    || value.rootGeneration < 1
    || value.nodes.length > 4
    || !unique(value.nodes.map(node => hex(node.relayId)))
  )
    throw new RangeError('Invalid relay directory')
  return concat(
    uint(1, 1),
    uint(value.generation, 8),
    uint(value.issuedAt, 8),
    uint(value.expiresAt, 8),
    uint(value.rootGeneration, 8),
    fixed(value.rootHash, 32),
    fixed(value.key, 32),
    uint(value.nodes.length, 1),
    ...value.nodes.map(node => {
      directoryEndpoint(node.host, node.port)
      if (
        node.addresses.length < 1
        || node.addresses.length > 8
        || !unique(node.addresses)
        || !node.addresses.every(isPublicDirectoryAddress)
        || ((node.host.includes(':') || /^[0-9.]+$/u.test(node.host)) && !node.addresses.includes(node.host))
      )
        throw new RangeError('Invalid directory addresses')
      return concat(
        fixed(node.relayId, 16),
        field(ascii(node.host)),
        uint(node.port, 2),
        uint(node.addresses.length, 1),
        ...node.addresses.map(address => field(ascii(address))),
      )
    }),
  )
}
export function decodeRelayDirectory(bytes: Uint8Array): RelayDirectory {
  const reader = new Reader(bytes, DIRECTORY_LIMIT / 2)
  if (reader.number(1) !== 1) throw new RangeError('Invalid directory version')
  const generation = reader.number(8),
    issuedAt = reader.number(8),
    expiresAt = reader.number(8),
    rootGeneration = reader.number(8),
    rootHash = reader.take(32),
    key = reader.take(32),
    count = reader.number(1)
  if (count > 4) throw new RangeError('Directory node limit')
  const nodes = Array.from({ length: count }, () => {
    const relayId = reader.take(16),
      host = text(reader.field(253)),
      port = reader.number(2),
      addresses = reader.number(1)
    if (addresses > 8) throw new RangeError('Directory address limit')
    return { relayId, host, port, addresses: Array.from({ length: addresses }, () => text(reader.field(45))) }
  })
  reader.done()
  const value = { generation, issuedAt, expiresAt, rootGeneration, rootHash, key, nodes }
  encodeRelayDirectory(value)
  return value
}
export const relayAuthorityInput = (payload: Uint8Array): Uint8Array => concat(ascii('latch-relay-authority-v1\0'), payload)
export const relayDirectoryInput = (payload: Uint8Array): Uint8Array => concat(ascii('latch-relay-addresses-v1\0'), payload)
export function encodeSignedRelayDirectory(value: SignedRelayDirectory): Uint8Array {
  decodeRelayAuthority(value.authority)
  decodeRelayDirectory(value.directory)
  const bytes = concat(field(value.authority), fixed(value.rootSignature, 64), field(value.directory), fixed(value.signature, 64))
  if (bytes.length > DIRECTORY_LIMIT) throw new RangeError('Directory bundle limit')
  return bytes
}
export function decodeSignedRelayDirectory(bytes: Uint8Array): SignedRelayDirectory {
  const reader = new Reader(bytes, DIRECTORY_LIMIT),
    authority = reader.field(DIRECTORY_LIMIT / 2),
    rootSignature = reader.take(64),
    directory = reader.field(DIRECTORY_LIMIT / 2),
    signature = reader.take(64)
  reader.done()
  const value = { authority, rootSignature, directory, signature }
  encodeSignedRelayDirectory(value)
  return value
}
/** Persist this floor before accepting online addresses: a revoked online key must not prevent a newer Root from sticking. */
export async function verifyRelayAuthority(
  crypto: LinkCrypto,
  encoded: Uint8Array,
  signature: Uint8Array,
  anchors: readonly Uint8Array[],
  now: number,
  prior?: AuthorityCheckpoint,
) {
  encoded = new Uint8Array(encoded)
  signature = new Uint8Array(fixed(signature, 64))
  anchors = anchors.map(anchor => new Uint8Array(fixed(anchor, 32)))
  if (prior) prior = { generation: prior.generation, hash: new Uint8Array(fixed(prior.hash, 32)) }
  if (anchors.length < 1 || anchors.length > 2 || !unique(anchors.map(hex))) throw new RangeError('Directory anchors required')
  if (!Number.isSafeInteger(now) || now < 0 || (prior && (!Number.isSafeInteger(prior.generation) || prior.generation < 1)))
    throw new RangeError('Invalid directory clock or checkpoint')
  const authority = decodeRelayAuthority(encoded)
  let rooted = false
  for (const anchor of anchors) if (await crypto.verify(anchor, relayAuthorityInput(encoded), signature)) rooted = true
  if (!rooted) throw new Error('Directory root mismatch')
  const hash = await crypto.hash(encoded)
  if (authority.issuedAt > now + 300000 || authority.expiresAt <= now) throw new Error('Directory authority lifetime rejected')
  if (prior && (authority.generation < prior.generation || (authority.generation === prior.generation && !equal(hash, prior.hash))))
    throw new Error('Directory authority rollback or conflict')
  return { authority, checkpoint: { generation: authority.generation, hash } }
}
export async function verifyRelayDirectory(
  crypto: LinkCrypto,
  bundle: SignedRelayDirectory,
  anchors: readonly Uint8Array[],
  now: number,
  prior?: DirectoryCheckpoint,
) {
  bundle = decodeSignedRelayDirectory(encodeSignedRelayDirectory(bundle))
  anchors = anchors.map(anchor => new Uint8Array(anchor))
  if (prior)
    prior = {
      rootGeneration: prior.rootGeneration,
      rootHash: new Uint8Array(prior.rootHash),
      generation: prior.generation,
      hash: new Uint8Array(prior.hash),
    }
  if (
    prior
    && (!Number.isSafeInteger(prior.rootGeneration)
      || prior.rootGeneration < 1
      || !Number.isSafeInteger(prior.generation)
      || prior.generation < 1)
  )
    throw new RangeError('Invalid directory checkpoint')
  if (prior) {
    fixed(prior.rootHash, 32)
    fixed(prior.hash, 32)
  }
  const rooted = await verifyRelayAuthority(
    crypto,
    bundle.authority,
    bundle.rootSignature,
    anchors,
    now,
    prior ? { generation: prior.rootGeneration, hash: prior.rootHash } : undefined,
  )
  const authority = rooted.authority,
    directory = decodeRelayDirectory(bundle.directory),
    rootHash = rooted.checkpoint.hash,
    hash = await crypto.hash(bundle.directory)
  if (
    !Number.isSafeInteger(now)
    || now < 0
    || authority.issuedAt > now + 300000
    || directory.issuedAt > now + 300000
    || authority.expiresAt <= now
    || directory.expiresAt <= now
    || directory.rootGeneration !== authority.generation
    || !equal(directory.rootHash, rootHash)
  )
    throw new Error('Directory lifetime or authority mismatch')
  if (
    prior
    && (authority.generation < prior.rootGeneration
      || (authority.generation === prior.rootGeneration && !equal(prior.rootHash, rootHash))
      || (authority.generation === prior.rootGeneration
        && (directory.generation < prior.generation || (directory.generation === prior.generation && !equal(prior.hash, hash)))))
  )
    throw new Error('Directory rollback or conflict')
  const key = authority.keys.find(item => equal(item.publicKey, directory.key))
  if (
    !key
    || authority.revokedKeys.some(revoked => equal(revoked, directory.key))
    || now < key.notBefore
    || now >= key.notAfter
    || directory.issuedAt < key.notBefore
    || directory.expiresAt > key.notAfter
    || directory.expiresAt > authority.expiresAt
    || !(await crypto.verify(directory.key, relayDirectoryInput(bundle.directory), bundle.signature))
  )
    throw new Error('Directory delegation rejected')
  for (const node of directory.nodes) {
    const granted = authority.nodes.find(item => equal(item.relayId, node.relayId))
    if (!granted || (node.port !== 443 && !granted.ports.includes(node.port))) throw new Error('Directory observation not authorized')
  }
  return { authority, directory, checkpoint: { rootGeneration: authority.generation, rootHash, generation: directory.generation, hash } }
}
