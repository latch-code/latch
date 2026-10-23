import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from 'node:crypto'
import { AppError } from '../core/errors.ts'

/** RFC 4648 base32 alphabet, lowercase, used without padding. */
export const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

export function base32(data: Uint8Array): string {
  let output = ''
  let buffer = 0
  let bits = 0
  for (const byte of data) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31]
  return output
}

/** Strings are hashed as UTF-8. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex')
}

/**
 * Deterministic JSON: object keys sorted recursively by UTF-16 code unit, no whitespace, primitives as
 * `JSON.stringify` writes them (so U+202E and other non-ASCII characters stay raw). Undefined object members
 * are dropped; anything JSON cannot represent unambiguously throws.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set())
}

function encode(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false'
    case 'string': return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number')
      return JSON.stringify(value)
    case 'object': break
    default: throw new TypeError(`canonicalJson: unsupported ${typeof value}`)
  }
  const object = value as object
  if (seen.has(object)) throw new TypeError('canonicalJson: circular structure')
  seen.add(object)
  try {
    if (Array.isArray(object)) {
      return `[${object.map(item => {
        if (item === undefined) throw new TypeError('canonicalJson: undefined array element')
        return encode(item, seen)
      }).join(',')}]`
    }
    const withJson = object as { toJSON?: () => unknown }
    if (typeof withJson.toJSON === 'function') return encode(withJson.toJSON(), seen)
    const record = object as Record<string, unknown>
    const members = Object.keys(record).sort().flatMap(key => record[key] === undefined ? [] : [`${JSON.stringify(key)}:${encode(record[key], seen)}`])
    return `{${members.join(',')}}`
  } finally {
    seen.delete(object)
  }
}

export function randomId(prefix: 'dev' | 'enr' | 'cfm' | 'inv' | 'chl'): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`
}

export function randomNonce(): string {
  return randomBytes(16).toString('base64url')
}

export function randomCode(prefix: 'lpi1' | 'lpo1'): string {
  return `${prefix}-${base32(randomBytes(16)).toUpperCase()}`
}

const BASE64URL = /^[A-Za-z0-9_-]*$/u

/** Strict base64url (no padding, canonical trailing bits); undefined otherwise. */
export function decodeBase64url(text: string): Buffer | undefined {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return undefined
  const decoded = Buffer.from(text, 'base64url')
  return decoded.toString('base64url') === text ? decoded : undefined
}

/** SubjectPublicKeyInfo header for id-ecPublicKey / prime256v1 followed by the uncompressed-point marker 0x04. */
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d03010703420004', 'hex')

function invalidPublicKey(): AppError {
  return new AppError(400, 'invalid-public-key', '设备公钥无效，仅支持 P-256')
}

/** Accepts only an uncompressed P-256 SPKI whose DER re-export is byte-identical to the input. */
export function parseP256Spki(spkiBase64url: string): { key: KeyObject; der: Buffer } {
  if (typeof spkiBase64url !== 'string' || spkiBase64url.length > 256) throw invalidPublicKey()
  const der = decodeBase64url(spkiBase64url)
  // Only the uncompressed form WebCrypto exports; OpenSSL would otherwise accept and re-export compressed points.
  if (!der || der.length !== 91 || !der.subarray(0, P256_SPKI_PREFIX.length).equals(P256_SPKI_PREFIX)) throw invalidPublicKey()
  let key: KeyObject
  try { key = createPublicKey({ key: der, format: 'der', type: 'spki' }) }
  catch { throw invalidPublicKey() }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw invalidPublicKey()
  const exported = key.export({ format: 'der', type: 'spki' })
  if (!exported.equals(der)) throw invalidPublicKey()
  return { key, der }
}

/** 20 base32 characters of sha256(SPKI) in groups of four: 'ABCD EFGH IJKL MNOP QRST'. */
export function deviceFingerprint(spkiDer: Uint8Array): string {
  const head = base32(createHash('sha256').update(spkiDer).digest()).toUpperCase().slice(0, 20)
  return head.match(/.{4}/gu)!.join(' ')
}

/** First 16 hex characters as 'xxxx-xxxx-xxxx-xxxx'. */
export function hashDisplay(hexHash: string): string {
  if (!/^[0-9a-f]{16,}$/u.test(hexHash)) throw new TypeError('hashDisplay: expected lowercase hex')
  return hexHash.slice(0, 16).match(/.{4}/gu)!.join('-')
}

/** ECDSA P-256 / SHA-256 over the UTF-8 text; only 64-byte IEEE P1363 signatures (WebCrypto's format). */
export function verifyP256(key: KeyObject, text: string, signatureBase64url: string): boolean {
  if (typeof signatureBase64url !== 'string') return false
  const signature = decodeBase64url(signatureBase64url)
  if (!signature || signature.length !== 64) return false
  try { return verify('sha256', Buffer.from(text, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, signature) }
  catch { return false }
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (!/^[0-9a-fA-F]*$/u.test(a) || !/^[0-9a-fA-F]*$/u.test(b)) return false
  const left = Buffer.from(a.toLowerCase(), 'utf8')
  const right = Buffer.from(b.toLowerCase(), 'utf8')
  if (left.length !== right.length) {
    // Still spend one comparison so length is the only thing a timing observer learns.
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}
