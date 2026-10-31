import { ascii, concat, field, fixed, Reader, uint } from './bytes.ts'
import type { LinkCrypto } from './crypto.ts'
import { parseIp } from './discovery.ts'

/** The in-app scanner's form of a pairing QR. */
export const PAIRING_QR_PREFIX = 'LATCHPAIR2.'
/**
 * The universal-link form is `${PAIRING_LINK_BASE}#2.<base64url>`, for example `https://<official-domain>/pair`. Empty
 * until the official domain exists, and then neither produced nor accepted. Keep it equal to `pairingLinkBase` in
 * native/ios/Sources/LatchNativeCore/Pairing.swift.
 */
export const PAIRING_LINK_BASE: string = ''
export const PAIRING_ROOT_SIZE = 91
export const PAIRING_SECRET_SIZE = 16
export const PAIRING_MAX_ENDPOINTS = 2
const PAIRING_MAX_TEXT = 512

export interface PairingEndpoint {
  address: string
  port: number
}
/** What the Mac's sheet shows. No relays, scopes or names; `expiresAt` is seconds since the epoch. */
export interface PairingQr {
  rootSpki: Uint8Array
  secret: Uint8Array
  expiresAt: number
  lan: PairingEndpoint[]
}

function ipText(family: 4 | 6, bytes: Uint8Array): string {
  if (family === 4) return Array.from(bytes).join('.')
  const groups: string[] = []
  for (let at = 0; at < 16; at += 2) groups.push(((bytes[at]! << 8) | bytes[at + 1]!).toString(16))
  return groups.join(':')
}

export function encodePairingQr(qr: PairingQr): Uint8Array {
  if (qr.lan.length < 1 || qr.lan.length > PAIRING_MAX_ENDPOINTS) throw new RangeError('Invalid pairing endpoint count')
  return concat(
    uint(2, 1),
    fixed(qr.rootSpki, PAIRING_ROOT_SIZE),
    fixed(qr.secret, PAIRING_SECRET_SIZE),
    uint(qr.expiresAt, 4),
    uint(qr.lan.length, 1),
    ...qr.lan.map(endpoint => {
      if (endpoint.port < 1) throw new RangeError('Invalid pairing endpoint port')
      const ip = parseIp(endpoint.address)
      return concat(uint(ip.family, 1), ip.bytes, uint(endpoint.port, 2))
    }),
  )
}

export function decodePairingQr(bytes: Uint8Array): PairingQr {
  const reader = new Reader(bytes, 256)
  if (reader.number(1) !== 2) throw new RangeError('Unsupported pairing QR')
  const rootSpki = reader.take(PAIRING_ROOT_SIZE),
    secret = reader.take(PAIRING_SECRET_SIZE),
    expiresAt = reader.number(4),
    count = reader.number(1)
  if (count < 1 || count > PAIRING_MAX_ENDPOINTS) throw new RangeError('Invalid pairing endpoint count')
  const lan: PairingEndpoint[] = []
  for (let index = 0; index < count; index++) {
    const family = reader.number(1)
    if (family !== 4 && family !== 6) throw new RangeError('Invalid pairing endpoint family')
    const address = ipText(family, reader.take(family === 4 ? 4 : 16)),
      port = reader.number(2)
    if (port < 1) throw new RangeError('Invalid pairing endpoint port')
    lan.push({ address, port })
  }
  reader.done()
  return { rootSpki, secret, expiresAt, lan }
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function base64url(bytes: Uint8Array): string {
  let out = ''
  for (let at = 0; at < bytes.length; at += 3) {
    const a = bytes[at]!,
      b = bytes[at + 1],
      c = bytes[at + 2]
    out += BASE64URL[a >> 2]! + BASE64URL[((a & 3) << 4) | ((b ?? 0) >> 4)]!
    if (b !== undefined) out += BASE64URL[((b & 15) << 2) | ((c ?? 0) >> 6)]!
    if (c !== undefined) out += BASE64URL[c & 63]!
  }
  return out
}

function unbase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(text) || text.length % 4 === 1) throw new RangeError('Invalid pairing encoding')
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let buffer = 0,
    bits = 0,
    at = 0
  for (const char of text) {
    buffer = (buffer << 6) | BASE64URL.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[at++] = (buffer >> bits) & 255
      buffer &= (1 << bits) - 1
    }
  }
  if (buffer !== 0) throw new RangeError('Invalid pairing encoding')
  return out
}

/** The text a QR carries: the universal link once the official domain exists, the scanner's form until then. */
export function formatPairingPayload(qr: PairingQr): string {
  const body = base64url(encodePairingQr(qr))
  return PAIRING_LINK_BASE ? `${PAIRING_LINK_BASE}#2.${body}` : `${PAIRING_QR_PREFIX}${body}`
}

export function parsePairingPayload(text: string): PairingQr {
  if (text.length > PAIRING_MAX_TEXT) throw new RangeError('Pairing QR too large')
  const link = PAIRING_LINK_BASE ? `${PAIRING_LINK_BASE}#2.` : undefined
  if (text.startsWith(PAIRING_QR_PREFIX)) return decodePairingQr(unbase64url(text.slice(PAIRING_QR_PREFIX.length)))
  if (link && text.startsWith(link)) return decodePairingQr(unbase64url(text.slice(link.length)))
  throw new RangeError('Not a pairing QR')
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** The QR secret as the enrollment request names it. The knock key is the SHA-256 of this text. */
export function invitationCode(secret: Uint8Array): string {
  let buffer = 0,
    bits = 0,
    out = ''
  for (const byte of fixed(secret, PAIRING_SECRET_SIZE)) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32[(buffer >> bits) & 31]!
    }
    buffer &= (1 << bits) - 1
  }
  return `lpi1-${out}${BASE32[buffer << (5 - bits)]!}`
}

export function invitationSecret(code: string): Uint8Array {
  if (!/^lpi1-[A-Z2-7]{26}$/u.test(code)) throw new RangeError('Invalid invitation code')
  const out = new Uint8Array(PAIRING_SECRET_SIZE)
  let buffer = 0,
    bits = 0,
    at = 0
  for (const char of code.slice(5)) {
    buffer = (buffer << 5) | BASE32.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out[at++] = (buffer >> bits) & 255
      buffer &= (1 << bits) - 1
    }
  }
  if (buffer !== 0) throw new RangeError('Invalid invitation code')
  return out
}

export async function nativeKnockSecret(
  crypto: LinkCrypto,
  invitationHash: Uint8Array,
  connectionSpki: Uint8Array,
  verificationSpki: Uint8Array,
): Promise<Uint8Array> {
  if (connectionSpki.length > 256 || verificationSpki.length > 256) throw new RangeError('Pairing key too large')
  return crypto.derive(
    fixed(invitationHash, 32),
    await crypto.hash(connectionSpki),
    concat(ascii('latch-native-knock-key-v1\0'), field(verificationSpki)),
    32,
  )
}

export function nativeVerificationText(hostId: string, deviceId: string, nonce: string, expiresAt: number, appOpenId: string): string {
  if (
    !/^[a-z2-7]{52}$/u.test(hostId)
    || !/^dev_[A-Za-z0-9_-]{22}$/u.test(deviceId)
    || !/^[A-Za-z0-9_-]{16,80}$/u.test(nonce)
    || !/^[A-Za-z0-9_-]{16,80}$/u.test(appOpenId)
    || !Number.isSafeInteger(expiresAt)
    || expiresAt < 0
  )
    throw new RangeError('Invalid native verification statement')
  return `latch-native-verify-v1\n${hostId}\n${deviceId}\n${nonce}\n${expiresAt}\n${appOpenId}`
}

/** Derived before sending a verification, so a lost acknowledgement never requires a second signature. */
export async function nativeRecoverySecret(crypto: LinkCrypto, statement: string, signature: Uint8Array): Promise<Uint8Array> {
  if (statement.length > 512 || !statement.startsWith('latch-native-verify-v1\n'))
    throw new RangeError('Invalid native verification statement')
  return crypto.hash(concat(ascii('latch-native-recovery-v1\0'), field(ascii(statement)), fixed(signature, 64)))
}

/** The boot-only issuer key lets the Host reissue the same receipt while retaining only secret hashes. */
export async function nativeWindowSecret(crypto: LinkCrypto, issuerKey: Uint8Array, recoveryHash: Uint8Array): Promise<Uint8Array> {
  return crypto.hmac(fixed(issuerKey, 32), concat(ascii('latch-native-window-v1\0'), fixed(recoveryHash, 32)))
}
