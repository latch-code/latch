import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Shared conformance data; client and native implementations test against the same file. */
export interface SecurityVectors {
  version: 1
  base32: { alphabet: string; cases: Array<{ utf8: string; base32: string }> }
  p256: {
    jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
    privateJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string; d: string }
    spki: string
    sha256: string
    hostId: string
    hostId8: string
    fingerprint: string
  }
  canonicalJson: { input: unknown; output: string; sha256: string }
  /** Extra cases: code-unit key order, C0 escapes, lone surrogates, integers. */
  canonicalJsonCases: Array<{ input: unknown; output: string; sha256: string }>
  /** Full confirmation previews and the hash the Host and the macOS helper must both compute. */
  previewHash: Array<{ preview: Record<string, unknown>; previewHash: string; hashDisplay: string }>
  hashDisplay: Array<{ hex: string; display: string }>
  escapePreviewText: Array<{ input: string; output: string }>
  signing: {
    enroll: { format: string; example: { hostId: string; enrollmentId: string; nonce: string; text: string; signature: string } }
    renew: { format: string; example: { hostId: string; deviceId: string; nonce: string; text: string; signature: string } }
  }
}

/** The vectors file itself, for readers with their own types and for the macOS helper's `--self-test`. */
export const SECURITY_VECTORS_FILE: string = fileURLToPath(new URL('../vectors/security-v1.json', import.meta.url))

export const SECURITY_VECTORS: SecurityVectors = JSON.parse(readFileSync(SECURITY_VECTORS_FILE, 'utf8'))

export const BASE32_VECTORS = SECURITY_VECTORS.base32.cases
export const P256_VECTOR = SECURITY_VECTORS.p256
export const CANONICAL_JSON_VECTOR = SECURITY_VECTORS.canonicalJson
export const CANONICAL_JSON_CASES = SECURITY_VECTORS.canonicalJsonCases
export const PREVIEW_HASH_VECTORS = SECURITY_VECTORS.previewHash
export const HASH_DISPLAY_VECTORS = SECURITY_VECTORS.hashDisplay
export const ESCAPE_PREVIEW_VECTORS = SECURITY_VECTORS.escapePreviewText
export const ENROLL_SIGNING_VECTOR = SECURITY_VECTORS.signing.enroll
export const RENEW_SIGNING_VECTOR = SECURITY_VECTORS.signing.renew

export function enrollSigningText(hostId: string, enrollmentId: string, nonce: string): string {
  return `latch-enroll-v1\n${hostId}\n${enrollmentId}\n${nonce}`
}

export function renewSigningText(hostId: string, deviceId: string, nonce: string): string {
  return `latch-renew-v1\n${hostId}\n${deviceId}\n${nonce}`
}

export interface TestDeviceKey {
  privateKey: KeyObject
  /** base64url SPKI DER, as a client sends it. */
  spki: string
  /** base64url IEEE P1363 signature over the UTF-8 text. */
  sign(text: string): string
}

/** A fresh P-256 device key, signing the way WebCrypto does. */
export function testDeviceKey(): TestDeviceKey {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    privateKey,
    spki: createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64url'),
    sign: text => sign('sha256', Buffer.from(text, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
  }
}
