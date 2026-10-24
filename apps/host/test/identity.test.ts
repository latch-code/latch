import { createPrivateKey, generateKeyPairSync, verify } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256Hex } from '@latch/core/node-kit'
import { P256_VECTOR } from '@latch/testkit'
import { base32 } from '../src/crypto.ts'
import { hostIdFromSpki, loadOrCreateHostIdentity } from '../src/identity.ts'

const cleanups: string[] = []
afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true })
})

function dataDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'harness-link-identity-'))
  cleanups.push(path)
  return path
}

describe('host identity', () => {
  it('creates a private P-256 key once and derives a stable host ID', async () => {
    const dir = dataDir()
    const first = await loadOrCreateHostIdentity(dir)
    expect(first.hostId).toMatch(/^[a-z2-7]{52}$/u)
    expect(first.hostId8).toBe(first.hostId.slice(0, 8))
    expect(first.hostId).toBe(base32(Buffer.from(sha256Hex(first.publicKeySpki), 'hex')))
    expect(statSync(join(dir, 'identity')).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'identity', 'host-key.pem')).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dir, 'identity'))).toEqual(['host-key.pem'])
    const again = await loadOrCreateHostIdentity(dir)
    expect(again.hostId).toBe(first.hostId)
    expect(again.publicKeySpki.equals(first.publicKeySpki)).toBe(true)
    const signature = again.sign(Buffer.from('hello'))
    expect(signature).toHaveLength(64)
    expect(
      verify(
        'sha256',
        Buffer.from('hello'),
        { key: first.publicKeySpki, format: 'der', type: 'spki', dsaEncoding: 'ieee-p1363' },
        signature,
      ),
    ).toBe(true)
  })

  it('matches the shared host ID vector', () => {
    expect(hostIdFromSpki(Buffer.from(P256_VECTOR.spki, 'base64url'))).toBe(P256_VECTOR.hostId)
  })

  it('loads an existing key and tightens a loose mode', async () => {
    const dir = dataDir()
    mkdirSync(join(dir, 'identity'), { mode: 0o700 })
    const pem = createPrivateKey({ key: P256_VECTOR.privateJwk, format: 'jwk' }).export({ format: 'pem', type: 'pkcs8' }) as string
    writeFileSync(join(dir, 'identity', 'host-key.pem'), pem, { mode: 0o644 })
    chmodSync(join(dir, 'identity', 'host-key.pem'), 0o644)
    const identity = await loadOrCreateHostIdentity(dir)
    expect(identity.hostId).toBe(P256_VECTOR.hostId)
    expect(statSync(join(dir, 'identity', 'host-key.pem')).mode & 0o777).toBe(0o600)
  })

  it('refuses a corrupt, wrong-curve or symlinked key without replacing it', async () => {
    const invalid = expect.objectContaining({ status: 500, code: 'identity-invalid' })
    const corrupt = dataDir()
    mkdirSync(join(corrupt, 'identity'), { mode: 0o700 })
    writeFileSync(join(corrupt, 'identity', 'host-key.pem'), 'not a key', { mode: 0o600 })
    await expect(loadOrCreateHostIdentity(corrupt)).rejects.toEqual(invalid)
    expect(readFileSync(join(corrupt, 'identity', 'host-key.pem'), 'utf8')).toBe('not a key')

    const curve = dataDir()
    mkdirSync(join(curve, 'identity'), { mode: 0o700 })
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
    writeFileSync(join(curve, 'identity', 'host-key.pem'), p384, { mode: 0o600 })
    await expect(loadOrCreateHostIdentity(curve)).rejects.toEqual(invalid)

    const ed = dataDir()
    mkdirSync(join(ed, 'identity'), { mode: 0o700 })
    writeFileSync(
      join(ed, 'identity', 'host-key.pem'),
      generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
      { mode: 0o600 },
    )
    await expect(loadOrCreateHostIdentity(ed)).rejects.toEqual(invalid)

    const linked = dataDir()
    mkdirSync(join(linked, 'identity'), { mode: 0o700 })
    const elsewhere = join(dataDir(), 'key.pem')
    writeFileSync(elsewhere, p384, { mode: 0o600 })
    symlinkSync(elsewhere, join(linked, 'identity', 'host-key.pem'))
    await expect(loadOrCreateHostIdentity(linked)).rejects.toEqual(invalid)
  })
})
