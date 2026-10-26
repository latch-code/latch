import { ascii, concat, equal, field, fixed, hex, Reader, uint } from './bytes.ts'
import { decodePass } from './pass.ts'
import { decodeDirectorySource, encodeDirectorySource, type NativeDirectorySource } from './directory-source.ts'
import { relayWireVersion, type RelayTransportProfile } from './relay-profile.ts'

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
  spkiHash: Uint8Array
  passes: NativeRelayPass[]
  profile?: RelayTransportProfile
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
  for (const relay of book.relays) {
    relayWireVersion(relay.profile)
    fixed(relay.relayId, 16)
    fixed(relay.spkiHash, 32)
    endpoint(relay.url)
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
  const version = book.relays.some(relay => relay.profile !== undefined) ? 3 : book.directory ? 2 : 1
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
        fixed(relay.spkiHash, 32),
        ...(version === 3 ? [uint(relayWireVersion(relay.profile) - 1, 1)] : []),
        uint(relay.passes.length, 1),
        ...relay.passes.map(entry => concat(fixed(entry.pass, 174), fixed(entry.holderSeed, 32))),
      ),
    ),
    ...(version >= 2 ? [field(book.directory ? encodeDirectorySource(book.directory) : new Uint8Array())] : []),
  )
  if (bytes.length > ADDRESS_BOOK_LIMIT) throw new RangeError('Address book too large')
  return bytes
}
export function decodeAddressBook(bytes: Uint8Array): NativeAddressBook {
  const reader = new Reader(bytes, ADDRESS_BOOK_LIMIT)
  const version = reader.number(1)
  if (![1, 2, 3].includes(version) || reader.number(1) !== 0) throw new RangeError('Unsupported address book version')
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
      spkiHash = reader.take(32),
      profile = version === 3 ? reader.number(1) : 0,
      count = reader.number(1)
    if (profile > 1 || count < 1 || count > 64) throw new RangeError('Address book relay profile or pass count')
    book.relays.push({
      relayId,
      url,
      spkiHash,
      ...(profile === 1 ? { profile: 'outer-pad-v2' as const } : {}),
      passes: Array.from({ length: count }, () => ({ pass: reader.take(174), holderSeed: reader.take(32) })),
    })
  }
  if (version >= 2) {
    const source = reader.field(2240)
    if (source.length) book.directory = decodeDirectorySource(source)
    else if (version === 2) throw new RangeError('Missing directory source')
  }
  reader.done()
  validate(book)
  if (version === 3 && !book.relays.some(relay => relay.profile === 'outer-pad-v2')) throw new RangeError('Missing v3 relay profile')
  return book
}
export function addressBookSigningInput(bytes: Uint8Array): Uint8Array {
  if (bytes.length > ADDRESS_BOOK_LIMIT) throw new RangeError('Address book too large')
  return concat(ascii('latch-address-book-v1\0'), bytes)
}
