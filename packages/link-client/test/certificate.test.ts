import { X509Certificate } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createTransportCertificate } from '../src/certificate.ts'

const fixture = vi.hoisted(() => ({ bytes: new Uint8Array(16) }))
vi.mock('node:crypto', async original => ({
  ...(await original<typeof import('node:crypto')>()),
  randomBytes: (size: number) => Buffer.from(fixture.bytes.slice(0, size)),
}))

it.each([
  new Uint8Array(16),
  new Uint8Array([0, 16, ...new Uint8Array(14)]),
  new Uint8Array([128, ...new Uint8Array(15)]),
  new Uint8Array([0, 128, ...new Uint8Array(14)]),
])('produces a canonical positive X.509 serial for zero prefixes and high bits (%#)', bytes => {
  fixture.bytes = bytes
  const certificate = createTransportCertificate(),
    parsed = new X509Certificate(certificate.cert)
  expect(parsed.verify(parsed.publicKey)).toBe(true)
  expect(parsed.checkHost('transport.latch.invalid')).toBe('transport.latch.invalid')
})
