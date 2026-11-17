import { ascii, concat, equal, field, fixed, hex, Reader, uint } from './bytes.ts'
import { decodePass } from './pass.ts'
import { decodeDirectorySource, encodeDirectorySource, type NativeDirectorySource } from './directory-source.ts'
import { relayWireVersion, type RelayTransportProfile } from './relay-profile.ts'
import { EDGE_REGION, EDGE_RELAY } from './relay-identity.ts'

export const ADDRESS_BOOK_LIMIT = 65_536
export const ADDRESS_BOOK_TTL_MS = 31 * 86_400_000
export interface NativeLanAddress {
  address: string
  port: number
  kind: 'wifi' | 'ethernet' | 'tunnel'
  prefixLength: number
  gatewayHash: Uint8Array
}
export interface NativeRelayPass {
  pass: Uint8Array
  holderSeed: Uint8Array
}
export interface NativeRelayAddress {
  relayId: Uint8Array
  url: string
  /** The pinned TLS key of a self-hosted node; 32 zero bytes for an edge node, which no certificate can match. */
  spkiHash: Uint8Array
  passes: NativeRelayPass[]
  profile?: RelayTransportProfile
  /** Present only for the edge kind: the node's Ed25519 relay key and the shard every role of this route dials. */
  edge?: { relayKey: Uint8Array; shard: number }
  /** Where the node runs (`apac-ne`, `apac-se`); a hint for ordering, never an identity. */
  region?: string
  /**
   * Edge kind only: further origins of the same node (at most three), raced with `url`. Safe because the relay-key
   * signature, not the hostname, binds a connection to the node.
   */
  extraUrls?: string[]
}
export interface NativeAddressBook {
  hostId: string
  deviceId: string
  generation: number
  issuedAt: number
  expiresAt: number
  discoveryKey: Uint8Array
  lan: NativeLanAddress[]
  relays: NativeRelayAddress[]
  directory?: NativeDirectorySource
  /** The region of the node the Host measured as nearest; clients try relays in this region first. */
  hostRegion?: string
}
const KINDS = ['wifi', 'ethernet', 'tunnel'] as const
function text(bytes: Uint8Array): string {
  if (bytes.some(byte => byte < 33 || byte > 126)) throw new RangeError('Invalid address book text')
  return String.fromCharCode(...bytes)
}
function endpoint(value: string): void {
  const parsed = /^https:\/\/([a-z0-9.-]{1,253}|\[[a-f0-9:]{2,45}\])(?::([0-9]{1,5}))?\/?$/u.exec(value)
  if (!parsed || (parsed[2] !== undefined && (Number(parsed[2]) < 1 || Number(parsed[2]) > 65535)))
    throw new RangeError('Invalid relay book endpoint')
}
function address(value: NativeLanAddress): void {
  const v6 = value.address.includes(':')
  if (
    value.address.length > 45
    || (v6 ? !/^[a-f0-9:.]+$/u.test(value.address) : !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u.test(value.address))
    || (!v6 && value.address.split('.').some(part => String(Number(part)) !== part || Number(part) > 255))
    || !Number.isInteger(value.port)
    || value.port < 1
    || value.port > 65535
    || !KINDS.includes(value.kind)
    || !Number.isInteger(value.prefixLength)
    || value.prefixLength < 0
    || value.prefixLength > (v6 ? 128 : 32)
  )
    throw new RangeError('Invalid address book LAN hint')
  fixed(value.gatewayHash, 32)
}
function validate(book: NativeAddressBook): void {
  if (
    !/^[a-z2-7]{52}$/u.test(book.hostId)
    || !/^dev_[A-Za-z0-9_-]{22}$/u.test(book.deviceId)
    || !Number.isSafeInteger(book.generation)
    || book.generation < 1
    || !Number.isSafeInteger(book.issuedAt)
    || book.issuedAt < 0
    || !Number.isSafeInteger(book.expiresAt)
    || book.expiresAt <= book.issuedAt
    || book.expiresAt - book.issuedAt > ADDRESS_BOOK_TTL_MS
    || book.lan.length > 8
    || book.relays.length > 4
    || new Set(book.lan.map(item => `${item.address}:${item.port}`)).size !== book.lan.length
    || new Set(book.relays.map(item => hex(item.relayId))).size !== book.relays.length
  )
    throw new RangeError('Invalid native address book')
  fixed(book.discoveryKey, 32)
  for (const hint of book.lan) address(hint)
  if (book.hostRegion !== undefined && !EDGE_REGION.test(book.hostRegion)) throw new RangeError('Invalid address book region')
  for (const relay of book.relays) {
    relayWireVersion(relay.profile)
    fixed(relay.relayId, 16)
    fixed(relay.spkiHash, 32)
    endpoint(relay.url)
    if (relay.region !== undefined && !EDGE_REGION.test(relay.region)) throw new RangeError('Invalid address book region')
    if (
      relay.edge
      && (relay.profile !== 'outer-pad-v2'
        || relay.spkiHash.some(byte => byte !== 0)
        || fixed(relay.edge.relayKey, 32).every(byte => byte === 0)
        || !Number.isInteger(relay.edge.shard)
        || relay.edge.shard < 0
        || relay.edge.shard >= EDGE_RELAY.maxShards)
    )
      throw new RangeError('Invalid edge relay entry')
    if (relay.extraUrls !== undefined) {
      if (
        !relay.edge
        || relay.extraUrls.length < 1
        || relay.extraUrls.length > 3
        || new Set([relay.url, ...relay.extraUrls]).size !== relay.extraUrls.length + 1
      )
        throw new RangeError('Invalid edge relay addresses')
      for (const url of relay.extraUrls) endpoint(url)
    }
    if (relay.passes.length < 1 || relay.passes.length > 64) throw new RangeError('Invalid address book pass count')
    const seen = new Set<string>()
    for (const entry of relay.passes) {
      fixed(entry.holderSeed, 32)
      const pass = decodePass(entry.pass),
        key = `${pass.day}:${hex(pass.routePub)}`
      if (pass.pairing || !equal(pass.relayId, relay.relayId) || seen.has(key)) throw new RangeError('Invalid address book pass binding')
      seen.add(key)
    }
  }
}

/** The signature covers these exact ordered bytes. URI parsing and network approval remain platform responsibilities. */
export function encodeAddressBook(book: NativeAddressBook): Uint8Array {
  validate(book)
  // Each version is emitted only when an entry needs it, so the bytes of older books never change.
  const version =
    book.hostRegion !== undefined || book.relays.some(relay => relay.edge || relay.region !== undefined)
      ? 4
      : book.relays.some(relay => relay.profile !== undefined)
        ? 3
        : book.directory
          ? 2
          : 1
  const bytes = concat(
    uint(version, 1),
    uint(0, 1),
    field(ascii(book.hostId)),
    field(ascii(book.deviceId)),
    uint(book.generation, 8),
    uint(book.issuedAt, 8),
    uint(book.expiresAt, 8),
    fixed(book.discoveryKey, 32),
    uint(book.lan.length, 1),
    ...book.lan.map(hint =>
      concat(
        field(ascii(hint.address)),
        uint(hint.port, 2),
        uint(KINDS.indexOf(hint.kind), 1),
        uint(hint.prefixLength, 1),
        fixed(hint.gatewayHash, 32),
      ),
    ),
    uint(book.relays.length, 1),
    ...book.relays.map(relay =>
      concat(
        fixed(relay.relayId, 16),
        field(ascii(relay.url)),
        // v4: kind[1] (0 self, 1 edge), then the 32-byte identity: the SPKI hash or the relay key.
        ...(version === 4 ? [uint(relay.edge ? 1 : 0, 1)] : []),
        relay.edge ? relay.edge.relayKey : fixed(relay.spkiHash, 32),
        ...(version >= 3 ? [uint(relayWireVersion(relay.profile) - 1, 1)] : []),
        ...(version === 4
          ? [
              uint(relay.edge?.shard ?? 0, 1),
              field(ascii(relay.region ?? '')),
              uint(relay.extraUrls?.length ?? 0, 1),
              ...(relay.extraUrls ?? []).map(url => field(ascii(url))),
            ]
          : []),
        uint(relay.passes.length, 1),
        ...relay.passes.map(entry => concat(fixed(entry.pass, 174), fixed(entry.holderSeed, 32))),
      ),
    ),
    ...(version >= 2 ? [field(book.directory ? encodeDirectorySource(book.directory) : new Uint8Array())] : []),
    ...(version === 4 ? [field(ascii(book.hostRegion ?? ''))] : []),
  )
  if (bytes.length > ADDRESS_BOOK_LIMIT) throw new RangeError('Address book too large')
  return bytes
}
export function decodeAddressBook(bytes: Uint8Array): NativeAddressBook {
  const reader = new Reader(bytes, ADDRESS_BOOK_LIMIT)
  const version = reader.number(1)
  if (![1, 2, 3, 4].includes(version) || reader.number(1) !== 0) throw new RangeError('Unsupported address book version')
  const book: NativeAddressBook = {
    hostId: text(reader.field(52)),
    deviceId: text(reader.field(26)),
    generation: reader.number(8),
    issuedAt: reader.number(8),
    expiresAt: reader.number(8),
    discoveryKey: reader.take(32),
    lan: [],
    relays: [],
  }
  const lanCount = reader.number(1)
  if (lanCount > 8) throw new RangeError('Address book LAN count')
  for (let index = 0; index < lanCount; index++) {
    const address = text(reader.field(45)),
      port = reader.number(2),
      kind = KINDS[reader.number(1)]
    if (kind === undefined) throw new RangeError('Unknown address book network kind')
    book.lan.push({ address, port, kind, prefixLength: reader.number(1), gatewayHash: reader.take(32) })
  }
  const relayCount = reader.number(1)
  if (relayCount > 4) throw new RangeError('Address book relay count')
  for (let index = 0; index < relayCount; index++) {
    const relayId = reader.take(16),
      url = text(reader.field(512)),
      kind = version === 4 ? reader.number(1) : 0,
      identity = reader.take(32),
      profile = version >= 3 ? reader.number(1) : 0,
      shard = version === 4 ? reader.number(1) : 0,
      region = version === 4 ? reader.field(16) : new Uint8Array(),
      extraCount = version === 4 ? reader.number(1) : 0
    if (extraCount > 3) throw new RangeError('Address book relay address count')
    const extraUrls = Array.from({ length: extraCount }, () => text(reader.field(512))),
      count = reader.number(1)
    if (kind > 1 || (kind === 0 && shard !== 0) || profile > 1 || count < 1 || count > 64)
      throw new RangeError('Address book relay kind, profile or pass count')
    book.relays.push({
      relayId,
      url,
      spkiHash: kind === 1 ? new Uint8Array(32) : identity,
      ...(profile === 1 ? { profile: 'outer-pad-v2' as const } : {}),
      passes: Array.from({ length: count }, () => ({ pass: reader.take(174), holderSeed: reader.take(32) })),
      ...(kind === 1 ? { edge: { relayKey: identity, shard } } : {}),
      ...(region.length ? { region: text(region) } : {}),
      ...(extraUrls.length ? { extraUrls } : {}),
    })
  }
  if (version >= 2) {
    const source = reader.field(2240)
    if (source.length) book.directory = decodeDirectorySource(source)
    else if (version === 2) throw new RangeError('Missing directory source')
  }
  if (version === 4) {
    const region = reader.field(16)
    if (region.length) book.hostRegion = text(region)
  }
  reader.done()
  validate(book)
  if (version === 3 && !book.relays.some(relay => relay.profile === 'outer-pad-v2')) throw new RangeError('Missing v3 relay profile')
  // Canonical: a v4 book must need v4, so one book has exactly one encoding.
  if (version === 4 && book.hostRegion === undefined && !book.relays.some(relay => relay.edge || relay.region !== undefined))
    throw new RangeError('Unneeded v4 address book')
  return book
}
export function addressBookSigningInput(bytes: Uint8Array): Uint8Array {
  if (bytes.length > ADDRESS_BOOK_LIMIT) throw new RangeError('Address book too large')
  return concat(ascii('latch-address-book-v1\0'), bytes)
}

/** Every origin of one node, in signed order. */
export function relayUrls(relay: Pick<NativeRelayAddress, 'url' | 'extraUrls'>): string[] {
  return [relay.url, ...(relay.extraUrls ?? [])]
}
/** Relays in the Host's measured region first, then the rest in the signed order. The order is a preference only. */
export function orderRelays(book: Pick<NativeAddressBook, 'relays' | 'hostRegion'>): NativeRelayAddress[] {
  const near = book.hostRegion
  return near === undefined
    ? [...book.relays]
    : [...book.relays.filter(relay => relay.region === near), ...book.relays.filter(relay => relay.region !== near)]
}
