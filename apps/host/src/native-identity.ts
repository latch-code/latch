import { X509Certificate } from 'node:crypto'
import { AppError } from '@latch/sdk'
import { parseP256Spki } from './crypto.ts'

export interface NativeIdentityInput {
  certificate: string
  verificationKey: string
}
export interface NativeRegistrationIdentity extends NativeIdentityInput {
  knockHash: string
}
export function validateNativeIdentity(input: NativeIdentityInput, connectionSpki: Uint8Array, allowExpired = false): NativeIdentityInput {
  try {
    if (
      typeof input.certificate !== 'string'
      || input.certificate.length > 8192
      || typeof input.verificationKey !== 'string'
      || input.verificationKey.length > 256
    )
      throw new Error('Invalid native identity')
    const certificate = new X509Certificate(input.certificate),
      spki = certificate.publicKey.export({ format: 'der', type: 'spki' })
    const connection = parseP256Spki(spki.toString('base64url')),
      verification = parseP256Spki(input.verificationKey)
    if (
      !certificate.verify(certificate.publicKey)
      || !spki.equals(connectionSpki)
      || !['CN=transport.latch.invalid', 'CN=connection.latch.invalid'].includes(certificate.subject)
      || certificate.issuer !== 'CN=transport.latch.invalid'
      || connection.der.equals(verification.der)
      || !Number.isFinite(Date.parse(certificate.validFrom))
      || !Number.isFinite(Date.parse(certificate.validTo))
      || (!allowExpired && (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()))
    )
      throw new Error('Invalid native identity')
    return { certificate: certificate.toString(), verificationKey: verification.der.toString('base64url') }
  } catch {
    throw new AppError(400, 'native-identity-invalid', '原生设备的连接密钥、证书或验证密钥无效')
  }
}
