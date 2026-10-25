import { generateKeyPairSync } from 'node:crypto'
import { expect, it } from 'vitest'
import { createTransportCertificate, renewDeviceCertificate } from '@latch/link-client'
import { validateNativeIdentity } from '../src/native-identity.ts'

it('requires the registered certificate key and a distinct verification key without echoing invalid input', () => {
  const certificate = createTransportCertificate(),
    verification = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64url')
  expect(validateNativeIdentity({ certificate: certificate.cert, verificationKey: verification }, certificate.spki).verificationKey).toBe(
    verification,
  )
  const renewed = renewDeviceCertificate(certificate.key)
  expect(validateNativeIdentity({ certificate: renewed.cert, verificationKey: verification }, certificate.spki).verificationKey).toBe(
    verification,
  )
  expect(() =>
    validateNativeIdentity({ certificate: certificate.cert, verificationKey: certificate.spki.toString('base64url') }, certificate.spki),
  ).toThrow('原生设备')
  expect(() => validateNativeIdentity({ certificate: certificate.cert, verificationKey: verification }, new Uint8Array(91))).toThrow(
    '原生设备',
  )
  const invalid = { certificate: 'invalid-private-input', verificationKey: verification }
  expect(() => validateNativeIdentity(invalid, certificate.spki)).toThrow('原生设备的连接密钥、证书或验证密钥无效')
  const future = createTransportCertificate(Date.now() + 120_000)
  expect(() => validateNativeIdentity({ certificate: future.cert, verificationKey: verification }, future.spki)).toThrow('原生设备')
  const expired = createTransportCertificate(Date.now() - 7_200_000)
  expect(() => validateNativeIdentity({ certificate: expired.cert, verificationKey: verification }, expired.spki)).toThrow('原生设备')
  expect(validateNativeIdentity({ certificate: expired.cert, verificationKey: verification }, expired.spki, true).verificationKey).toBe(
    verification,
  )
})
