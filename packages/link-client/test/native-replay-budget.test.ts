import { Duplex } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { knock } from '@latch/link-wire'
import { acceptNative, createTransportCertificate, nodeCrypto, type NativeHostOptions } from '../src/index.ts'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})
async function fixture(kind: 'pairing' | 'registered' = 'registered') {
  const directory = await mkdtemp(join(tmpdir(), 'latch-knock-budget-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
    keys = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)]
  const leaf = createTransportCertificate().cert
  let now = Date.now()
  const granted = vi.fn(),
    replay = new Map<string, number>()
  const options: NativeHostOptions = {
    tlsBinary: join(directory, 'missing-component'),
    certificate: createTransportCertificate(),
    identity: {
      publicKeySpki: root.publicKey.export({ format: 'der', type: 'spki' }),
      sign: input => sign('sha256', input, { key: root.privateKey, dsaEncoding: 'ieee-p1363' }),
    },
    devices: () =>
      keys.map((key, index) =>
        kind === 'pairing'
          ? { id: `identity-${index}`, knockKey: key, kind: 'pairing' as const }
          : { id: `identity-${index}`, knockKey: key, kind: 'registered' as const, certificate: leaf },
      ),
    isActive: () => true,
    now: () => now,
    replay,
    onKnock: granted,
  }
  const attempt = async (identity: number, nonce: number) => {
    const stream = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback()
      },
    })
    stream.on('error', () => {})
    stream.push(await knock(nodeCrypto, keys[identity]!, { path: 'direct' }, now, new Uint8Array(16).fill(nonce)))
    // The deliberate missing TLS component fails after nonce admission, without starting a process or TCP listener.
    await expect(acceptNative(stream, { path: 'direct' }, options)).rejects.toThrow('authentication failed')
  }
  return {
    attempt,
    granted,
    replay,
    advance() {
      now += 180001
    },
  }
}
it('prevents one valid identity from filling the global replay cache and admits a different identity', async () => {
  const f = await fixture()
  for (let nonce = 1; nonce <= 32; nonce++) await f.attempt(0, nonce)
  expect(f.replay.size).toBe(32)
  expect(f.granted).toHaveBeenCalledTimes(32)
  await f.attempt(0, 33)
  expect(f.replay.size).toBe(32)
  expect(f.granted).toHaveBeenCalledTimes(32)
  await f.attempt(1, 1)
  expect(f.replay.size).toBe(33)
  expect(f.granted).toHaveBeenLastCalledWith('identity-1')
  f.advance()
  await f.attempt(0, 34)
  expect(f.replay.size).toBe(1)
})
it('lets a pairing QR keep taking knocks, because its holder could otherwise lock the real phone out', async () => {
  const f = await fixture('pairing')
  for (let nonce = 1; nonce <= 40; nonce++) await f.attempt(0, nonce)
  expect(f.replay.size).toBe(32)
  expect(f.granted).toHaveBeenCalledTimes(40)
  await f.attempt(0, 40).catch(() => {})
  expect(f.granted).toHaveBeenCalledTimes(40)
})
it('does not retain nonces rejected by the Host admission slot callback', async () => {
  const f = await fixture()
  f.granted.mockImplementation(() => {
    throw new Error('fixture full')
  })
  for (let nonce = 1; nonce <= 40; nonce++) await f.attempt(0, nonce)
  expect(f.replay.size).toBe(0)
  f.granted.mockReset()
  await f.attempt(1, 1)
  expect(f.replay.size).toBe(1)
})
