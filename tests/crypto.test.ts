import { createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, sign, webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  BASE32_ALPHABET, base32, canonicalJson, constantTimeEqualHex, deviceFingerprint, hashDisplay, parseP256Spki,
  randomCode, randomId, randomNonce, sha256Hex, verifyP256,
} from '../src/host/crypto.ts'
import {
  BASE32_VECTORS, CANONICAL_JSON_CASES, CANONICAL_JSON_VECTOR, ENROLL_SIGNING_VECTOR, HASH_DISPLAY_VECTORS, P256_VECTOR, RENEW_SIGNING_VECTOR,
  SECURITY_VECTORS, enrollSigningText, renewSigningText, testDeviceKey,
} from './helpers/crypto.ts'

describe('shared vectors', () => {
  it('encodes base32 like RFC 4648, lowercase without padding', () => {
    expect(SECURITY_VECTORS.base32.alphabet).toBe(BASE32_ALPHABET)
    expect(base32(Buffer.from('foobar'))).toBe('mzxw6ytboi')
    for (const vector of BASE32_VECTORS) expect(base32(Buffer.from(vector.utf8, 'utf8'))).toBe(vector.base32)
  })

  it('derives the host ID and device fingerprint from the P-256 SPKI', () => {
    const der = Buffer.from(P256_VECTOR.spki, 'base64url')
    expect(createPublicKey({ key: P256_VECTOR.jwk, format: 'jwk' }).export({ format: 'der', type: 'spki' }).toString('base64url')).toBe(P256_VECTOR.spki)
    expect(sha256Hex(der)).toBe(P256_VECTOR.sha256)
    const hostId = base32(Buffer.from(sha256Hex(der), 'hex'))
    expect(hostId).toBe(P256_VECTOR.hostId)
    expect(hostId).toHaveLength(52)
    expect(hostId.slice(0, 8)).toBe(P256_VECTOR.hostId8)
    expect(deviceFingerprint(der)).toBe(P256_VECTOR.fingerprint)
    expect(P256_VECTOR.fingerprint).toBe('FPI3 WDCE VCL4 GCT2 UCMR')
  })

  it('produces canonical JSON with a raw U+202E and the documented hash', () => {
    const input = { b: [2, 'x'], a: { z: 'é', y: null }, c: 'line‮end' }
    expect(CANONICAL_JSON_VECTOR.input).toEqual(input)
    const output = canonicalJson(input)
    expect(output).toBe('{"a":{"y":null,"z":"é"},"b":[2,"x"],"c":"line‮end"}')
    expect(output).toBe(CANONICAL_JSON_VECTOR.output)
    expect(sha256Hex(output)).toBe('a1cf7306dd48049d32637f397c1b63bbebd18bcd49e4b05c35ecad97bb6382c7')
    expect(sha256Hex(output)).toBe(CANONICAL_JSON_VECTOR.sha256)
  })

  it('matches the extra canonical JSON cases, including lone surrogates and C0 escapes', () => {
    expect(CANONICAL_JSON_CASES.length).toBeGreaterThanOrEqual(3)
    for (const vector of CANONICAL_JSON_CASES) {
      expect(canonicalJson(vector.input)).toBe(vector.output)
      expect(sha256Hex(canonicalJson(vector.input))).toBe(vector.sha256)
    }
    expect(CANONICAL_JSON_CASES[1]!.output).toContain('"\\ud800"')
    expect(CANONICAL_JSON_CASES[1]!.output).toContain('\\u0001\\u001f')
  })

  it('formats hash display codes', () => {
    for (const vector of HASH_DISPLAY_VECTORS) expect(hashDisplay(vector.hex)).toBe(vector.display)
    expect(() => hashDisplay('xyz')).toThrow()
  })

  it('documents the exact signing texts, and the example signatures verify', () => {
    const { key } = parseP256Spki(P256_VECTOR.spki)
    const enroll = ENROLL_SIGNING_VECTOR.example
    expect(enrollSigningText(enroll.hostId, enroll.enrollmentId, enroll.nonce)).toBe(enroll.text)
    expect(enroll.text).toBe(`latch-enroll-v1\n${P256_VECTOR.hostId}\n${enroll.enrollmentId}\n${enroll.nonce}`)
    expect(verifyP256(key, enroll.text, enroll.signature)).toBe(true)
    expect(verifyP256(key, `${enroll.text}\n`, enroll.signature)).toBe(false)
    const renew = RENEW_SIGNING_VECTOR.example
    expect(renewSigningText(renew.hostId, renew.deviceId, renew.nonce)).toBe(renew.text)
    expect(verifyP256(key, renew.text, renew.signature)).toBe(true)
    expect(verifyP256(key, renew.text, enroll.signature)).toBe(false)
  })
})

describe('canonicalJson', () => {
  it('sorts keys recursively by code unit and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [true, null, 'é'] }, A: 0 })).toBe('{"A":0,"a":{"c":[true,null,"é"]},"b":1}')
    // Code-unit order puts U+FF5E after an astral character's high surrogate (U+D83D).
    expect(canonicalJson({ '～': 1, '😀': 2, z: 3 })).toBe('{"z":3,"😀":2,"～":1}')
    expect(canonicalJson([])).toBe('[]')
    expect(canonicalJson('x')).toBe('"x"')
    expect(canonicalJson(-0.5)).toBe('-0.5')
  })

  it('rejects values JSON cannot represent', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow()
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow()
    expect(() => canonicalJson([undefined])).toThrow()
    expect(() => canonicalJson(10n)).toThrow()
    expect(() => canonicalJson(undefined)).toThrow()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => canonicalJson(circular)).toThrow()
  })
})

describe('P-256 keys and signatures', () => {
  it('verifies a WebCrypto P-256 signature (browser parity)', async () => {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
    const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', pair.publicKey)).toString('base64url')
    const text = renewSigningText(P256_VECTOR.hostId, 'dev_' + 'A'.repeat(22), randomNonce())
    const signature = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(text)))
    expect(signature).toHaveLength(64)
    const { key, der } = parseP256Spki(spki)
    expect(verifyP256(key, text, signature.toString('base64url'))).toBe(true)
    expect(verifyP256(key, text.replace('latch', 'latcH'), signature.toString('base64url'))).toBe(false)
    // The browser computes the fingerprint from the same SPKI with SubtleCrypto.
    const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', der))
    expect(deviceFingerprint(der)).toBe(base32(digest).toUpperCase().slice(0, 20).replace(/(.{4})(?!$)/gu, '$1 '))
  })

  it('accepts only 64-byte P1363 signatures', () => {
    const device = testDeviceKey()
    const { key } = parseP256Spki(device.spki)
    const der = sign('sha256', Buffer.from('hello'), { key: device.privateKey, dsaEncoding: 'der' }).toString('base64url')
    expect(verifyP256(key, 'hello', device.sign('hello'))).toBe(true)
    expect(verifyP256(key, 'hello', der)).toBe(false)
    expect(verifyP256(key, 'hello', device.sign('hello') + 'A')).toBe(false)
    expect(verifyP256(key, 'hello', '')).toBe(false)
    expect(verifyP256(key, 'hello', '!!!!')).toBe(false)
  })

  it('rejects P-384, Ed25519, RSA, compressed and non-canonical encodings', () => {
    const expectInvalid = (spki: string) => expect(() => parseP256Spki(spki)).toThrow(expect.objectContaining({ status: 400, code: 'invalid-public-key' }))
    const spkiOf = (type: 'ec' | 'ed25519' | 'rsa', options: object) =>
      (generateKeyPairSync as (type: string, options: object) => { publicKey: ReturnType<typeof createPublicKey> })(type, options)
        .publicKey.export({ format: 'der', type: 'spki' }) as Buffer
    expectInvalid(spkiOf('ec', { namedCurve: 'secp384r1' }).toString('base64url'))
    expectInvalid(spkiOf('ed25519', {}).toString('base64url'))
    expectInvalid(spkiOf('rsa', { modulusLength: 1024 }).toString('base64url'))

    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    const compressed = Buffer.concat([Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex'), ecdh.getPublicKey(undefined, 'compressed')])
    expect(() => createPublicKey({ key: compressed, format: 'der', type: 'spki' })).not.toThrow()
    expectInvalid(compressed.toString('base64url'))

    const canonical = Buffer.from(P256_VECTOR.spki, 'base64url')
    expectInvalid(Buffer.concat([canonical, Buffer.from([0])]).toString('base64url'))
    // Long-form DER length for the outer SEQUENCE: same key, non-canonical bytes.
    expectInvalid(Buffer.concat([Buffer.from([0x30, 0x81, 0x59]), canonical.subarray(2)]).toString('base64url'))
    expectInvalid(Buffer.from(P256_VECTOR.spki, 'base64url').toString('base64'))
    expectInvalid(`${P256_VECTOR.spki}=`)
    expectInvalid('')
    expectInvalid('A'.repeat(400))
    expect(parseP256Spki(P256_VECTOR.spki).der.toString('base64url')).toBe(P256_VECTOR.spki)
  })

  it('round-trips the vector private key', () => {
    const privateKey = createPrivateKey({ key: P256_VECTOR.privateJwk, format: 'jwk' })
    expect(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64url')).toBe(P256_VECTOR.spki)
  })
})

describe('random values', () => {
  it('uses the documented shapes', () => {
    for (const prefix of ['dev', 'enr', 'cfm', 'inv', 'chl'] as const) expect(randomId(prefix)).toMatch(new RegExp(`^${prefix}_[A-Za-z0-9_-]{22}$`, 'u'))
    expect(randomNonce()).toMatch(/^[A-Za-z0-9_-]{22}$/u)
    expect(randomCode('lpi1')).toMatch(/^lpi1-[A-Z2-7]{26}$/u)
    expect(randomCode('lpo1')).toMatch(/^lpo1-[A-Z2-7]{26}$/u)
    expect(randomId('dev')).not.toBe(randomId('dev'))
  })

  it('compares hex in constant time', () => {
    const a = sha256Hex('a')
    expect(constantTimeEqualHex(a, a)).toBe(true)
    expect(constantTimeEqualHex(a, a.toUpperCase())).toBe(true)
    expect(constantTimeEqualHex(a, sha256Hex('b'))).toBe(false)
    expect(constantTimeEqualHex(a, a.slice(1))).toBe(false)
    expect(constantTimeEqualHex(a, `${a.slice(1)}g`)).toBe(false)
  })
})
