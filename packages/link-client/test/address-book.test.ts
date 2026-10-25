import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeAddressBook } from '@latch/link-wire'
import { NativeAddressBookCache, signAddressBook, verifyAddressBook } from '../src/address-book.ts'

afterEach(() => vi.useRealTimers())
function fixture() {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
    root = key.publicKey.export({ type: 'spki', format: 'der' })
  const signer = { sign: (bytes: Uint8Array) => sign('sha256', bytes, { key: key.privateKey, dsaEncoding: 'ieee-p1363' }) }
  const book: NativeAddressBook = {
    hostId: 'a'.repeat(52),
    deviceId: `dev_${'D'.repeat(22)}`,
    generation: 1,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    discoveryKey: new Uint8Array(32),
    lan: [],
    relays: [],
  }
  return { root, signer, book }
}
it('verifies a pinned Root and device before accepting a connection book', () => {
  const { root, signer, book } = fixture(),
    encoded = signAddressBook(book, signer)
  expect(verifyAddressBook(encoded, root, book)).toEqual(book)
  const wrong = fixture().root
  expect(() => verifyAddressBook(encoded, wrong, book)).toThrow('verification failed')
  expect(() => verifyAddressBook(encoded, root, { ...book, deviceId: `dev_${'E'.repeat(22)}` })).toThrow('verification failed')
  const bytes = Buffer.from(encoded.slice('LATCHBOOK1.'.length), 'base64url')
  bytes[20] = bytes[20]! ^ 1
  expect(() => verifyAddressBook(`LATCHBOOK1.${bytes.toString('base64url')}`, root, book)).toThrow('verification failed')
  expect(() => verifyAddressBook(`${encoded}=`, root, book)).toThrow('verification failed')
})
it('rejects rollback and same-generation content changes without rejecting a fresh signature for unchanged bytes', () => {
  const { root, signer, book } = fixture(),
    cache = new NativeAddressBookCache()
  const original = signAddressBook(book, signer)
  cache.accept(original, root, book)
  const cursor = cache.current()
  cache.accept(signAddressBook(book, signer), root, book)
  expect(cache.current()).toEqual(cursor)
  const changed = { ...book, expiresAt: book.expiresAt + 1 }
  expect(() => cache.accept(signAddressBook(changed, signer), root, book)).toThrow('rollback')
  cache.accept(signAddressBook({ ...changed, generation: 2 }, signer), root, book)
  expect(() => cache.accept(original, root, book)).toThrow('rollback')
  const restored = new NativeAddressBookCache(cache.current())
  expect(() => restored.accept(original, root, book)).toThrow('rollback')
})
it('uses the client system clock for validity and rejects invalid IP hints', () => {
  vi.useFakeTimers()
  const { root, signer, book } = fixture(),
    encoded = signAddressBook(book, signer)
  vi.setSystemTime(book.expiresAt + 1)
  expect(() => verifyAddressBook(encoded, root, book)).toThrow('verification failed')
  vi.setSystemTime(book.issuedAt)
  const invalid = {
    ...book,
    lan: [{ address: '::::', port: 4319, kind: 'wifi' as const, prefixLength: 64, gatewayHash: new Uint8Array(32) }],
  }
  expect(() => verifyAddressBook(signAddressBook(invalid, signer), root, book)).toThrow('verification failed')
})
