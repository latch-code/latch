import { createHash, createPublicKey, verify } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import { ADDRESS_BOOK_LIMIT, addressBookSigningInput, decodeAddressBook, encodeAddressBook, type NativeAddressBook } from '@latch/link-wire'

const PREFIX = 'LATCHBOOK1.'
interface BookSigner {
  sign(bytes: Uint8Array): Uint8Array
}
function open(encoded: string): { payload: Buffer; signature: Buffer } {
  if (!/^LATCHBOOK1\.[A-Za-z0-9_-]{1,90000}$/u.test(encoded)) throw new Error('Invalid native address book')
  const raw = encoded.slice(PREFIX.length),
    bytes = Buffer.from(raw, 'base64url')
  if (bytes.length < 65 || bytes.length > ADDRESS_BOOK_LIMIT + 64 || bytes.toString('base64url') !== raw)
    throw new Error('Invalid native address book')
  return { payload: bytes.subarray(0, -64), signature: bytes.subarray(-64) }
}
export function signAddressBook(book: NativeAddressBook, signer: BookSigner): string {
  const payload = encodeAddressBook(book),
    signature = signer.sign(addressBookSigningInput(payload))
  if (signature.length !== 64) throw new Error('Invalid address book signature')
  return `${PREFIX}${Buffer.concat([payload, signature]).toString('base64url')}`
}
export function verifyAddressBook(
  encoded: string,
  rootSpki: Uint8Array,
  expected: { hostId: string; deviceId: string },
): NativeAddressBook {
  try {
    if (rootSpki.length > 256) throw new Error('Invalid address book root')
    const { payload, signature } = open(encoded)
    const key = createPublicKey({ key: Buffer.from(rootSpki), format: 'der', type: 'spki' })
    if (
      key.asymmetricKeyType !== 'ec'
      || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
      || !verify('sha256', addressBookSigningInput(payload), { key, dsaEncoding: 'ieee-p1363' }, signature)
    )
      throw new Error('Address book signature failed')
    const book = decodeAddressBook(new Uint8Array(payload)),
      now = Date.now()
    if (book.hostId !== expected.hostId || book.deviceId !== expected.deviceId || book.issuedAt > now + 60_000 || book.expiresAt <= now)
      throw new Error('Address book identity or deadline mismatch')
    for (const hint of book.lan) if (!isIP(hint.address)) throw new Error('Invalid LAN book address')
    for (const relay of book.relays) {
      const url = new URL(relay.url)
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
        throw new Error('Invalid relay book address')
    }
    return book
  } catch {
    throw new Error('Native address book verification failed')
  }
}
export interface AddressBookCursor {
  generation: number
  hash: string
}
/** Persist this cursor alongside the encrypted cache; a same-generation replacement is also a rollback. */
export class NativeAddressBookCache {
  private cursor?: AddressBookCursor
  constructor(cursor?: AddressBookCursor) {
    if (cursor) {
      const parsed = z.strictObject({ generation: z.int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/u) }).safeParse(cursor)
      if (!parsed.success) throw new Error('Invalid address book cache cursor')
      this.cursor = { ...parsed.data }
    }
  }
  current(): AddressBookCursor | undefined {
    return this.cursor ? { ...this.cursor } : undefined
  }
  accept(encoded: string, rootSpki: Uint8Array, expected: { hostId: string; deviceId: string }): NativeAddressBook {
    const book = verifyAddressBook(encoded, rootSpki, expected),
      { payload } = open(encoded)
    const hash = createHash('sha256').update(payload).digest('hex')
    if (
      this.cursor
      && (book.generation < this.cursor.generation || (book.generation === this.cursor.generation && hash !== this.cursor.hash))
    )
      throw new Error('Native address book rollback refused')
    this.cursor = { generation: book.generation, hash }
    return book
  }
}
