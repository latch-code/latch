import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto'

function der(tag: number, ...parts: readonly Uint8Array[]): Buffer {
  const value = Buffer.concat(parts),
    length = value.length
  const prefix = length < 128 ? [length] : length < 256 ? [0x81, length] : [0x82, length >> 8, length & 255]
  return Buffer.concat([Buffer.from([tag, ...prefix]), value])
}
const sequence = (...parts: readonly Uint8Array[]): Buffer => der(0x30, ...parts)
function positiveInteger(bytes: Uint8Array): Buffer {
  let first = 0
  while (first < bytes.length - 1 && bytes[first] === 0) first++
  const value = bytes.slice(first)
  return der(2, ...(value[0]! & 0x80 ? [Buffer.from([0]), value] : [value]))
}
const oid = (hex: string): Buffer => der(6, Buffer.from(hex, 'hex'))
const algorithm = sequence(oid('2a8648ce3d040302'))
const name = sequence(der(0x31, sequence(oid('550403'), der(12, Buffer.from('transport.latch.invalid')))))
const authorityName = sequence(der(0x31, sequence(oid('550403'), der(12, Buffer.from('authority.latch.invalid')))))
const connectionName = sequence(der(0x31, sequence(oid('550403'), der(12, Buffer.from('connection.latch.invalid')))))
function time(value: Date): Buffer {
  return der(0x18, Buffer.from(`${value.toISOString().replace(/[-:T]/gu, '').slice(0, 14)}Z`))
}

/** X.509 encoding only; key generation and ECDSA use the platform crypto implementation. */
export function createTransportCertificate(
  now = Date.now(),
  lifetimeMs = 3_600_000,
  dnsName = 'transport.latch.invalid',
): { cert: string; key: string; der: Buffer; spki: Buffer } {
  return transportCertificate(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey, now, lifetimeMs, dnsName)
}

/** A certificate is renewable presentation; the enrolled connection public key remains the device identity. */
export function renewDeviceCertificate(
  key: string,
  now = Date.now(),
  lifetimeMs = 3_600_000,
): ReturnType<typeof createTransportCertificate> {
  return transportCertificate(createPrivateKey(key), now, lifetimeMs, 'transport.latch.invalid', true)
}

function transportCertificate(
  privateKey: KeyObject,
  now: number,
  lifetimeMs: number,
  dnsName: string,
  deviceLeaf = false,
): ReturnType<typeof createTransportCertificate> {
  if (lifetimeMs < 60_000 || lifetimeMs > 43_200_000) throw new RangeError('Invalid transport certificate lifetime')
  if (!/^[a-z0-9.-]{1,253}$/u.test(dnsName)) throw new RangeError('Invalid transport DNS name')
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new RangeError('Invalid transport key')
  const publicKey = createPublicKey(privateKey)
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const serial = randomBytes(16)
  serial[15] = serial[15]! | 1
  const extension = (id: string, value: Buffer, critical = false): Buffer =>
    sequence(oid(id), ...(critical ? [der(1, Buffer.from([255]))] : []), der(4, value))
  const extensions = der(
    0xa3,
    sequence(
      extension('551d13', deviceLeaf ? sequence() : sequence(der(1, Buffer.from([255]))), true),
      extension('551d0f', der(3, Buffer.from(deviceLeaf ? [7, 0x80] : [1, 0x86])), true),
      extension('551d11', sequence(der(0x82, Buffer.from(dnsName)))),
      extension('551d25', sequence(oid('2b06010505070301'), oid('2b06010505070302'))),
    ),
  )
  const tbs = sequence(
    der(0xa0, der(2, Buffer.from([2]))),
    positiveInteger(serial),
    algorithm,
    name,
    sequence(time(new Date(now - 60_000)), time(new Date(now + lifetimeMs))),
    deviceLeaf ? connectionName : name,
    spki,
    extensions,
  )
  const certificate = sequence(tbs, algorithm, der(3, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])))
  const cert = `-----BEGIN CERTIFICATE-----\n${certificate
    .toString('base64')
    .match(/.{1,64}/gu)!
    .join('\n')}\n-----END CERTIFICATE-----\n`
  const parsed = new X509Certificate(cert)
  if (!parsed.verify(publicKey)) throw new Error('Transport certificate self-check failed')
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), der: certificate, spki }
}

/** Local TLS trust anchor for exactly one enrolled SPKI. No device private key or relaxed TLS verification is needed. */
export function createDeviceTrustAnchor(
  spki: Uint8Array,
  issuer: { publicKeySpki: Uint8Array; sign(input: Uint8Array): Uint8Array },
  now = Date.now(),
): string {
  const publicKey = createPublicKey({ key: Buffer.from(spki), type: 'spki', format: 'der' })
  if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new RangeError('Invalid device anchor key')
  const serial = randomBytes(16)
  serial[15] = serial[15]! | 1
  const extensions = der(
    0xa3,
    sequence(
      sequence(oid('551d13'), der(1, Buffer.from([255])), der(4, sequence(der(1, Buffer.from([255]))))),
      sequence(oid('551d0f'), der(1, Buffer.from([255])), der(4, der(3, Buffer.from([1, 0x86])))),
    ),
  )
  const tbs = sequence(
    der(0xa0, der(2, Buffer.from([2]))),
    positiveInteger(serial),
    algorithm,
    authorityName,
    sequence(time(new Date(now - 60_000)), time(new Date(now + 3_600_000))),
    name,
    spki,
    extensions,
  )
  const signature = issuer.sign(tbs)
  if (signature.length !== 64) throw new RangeError('Invalid device anchor signature')
  const encodedSignature = sequence(positiveInteger(signature.slice(0, 32)), positiveInteger(signature.slice(32)))
  const certificate = sequence(tbs, algorithm, der(3, Buffer.concat([Buffer.from([0]), encodedSignature])))
  const parsed = new X509Certificate(certificate)
  if (!parsed.verify(createPublicKey({ key: Buffer.from(issuer.publicKeySpki), type: 'spki', format: 'der' })))
    throw new Error('Device trust anchor self-check failed')
  return parsed.toString()
}
