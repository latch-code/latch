import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto'
import { isIP } from 'node:net'
import { readPrivate, writePrivate } from './private-store.ts'

const DAY_MS = 86_400_000
const RENEW_CHECK_MS = 12 * 3_600_000

function der(tag: number, ...parts: readonly Uint8Array[]): Buffer {
  const value = Buffer.concat(parts),
    length = value.length
  const prefix = length < 128 ? [length] : length < 256 ? [0x81, length] : [0x82, length >> 8, length & 255]
  return Buffer.concat([Buffer.from([tag, ...prefix]), value])
}
const sequence = (...parts: readonly Uint8Array[]): Buffer => der(0x30, ...parts)
const set = (...parts: readonly Uint8Array[]): Buffer => der(0x31, ...parts)
const oid = (hex: string): Buffer => der(0x06, Buffer.from(hex, 'hex'))

function positiveInteger(bytes: Uint8Array): Buffer {
  let first = 0
  while (first < bytes.length - 1 && bytes[first] === 0) first++
  const value = bytes.slice(first)
  return der(0x02, ...(value[0]! & 0x80 ? [Buffer.from([0]), value] : [value]))
}

function generalizedTime(value: Date): Buffer {
  return der(0x18, Buffer.from(`${value.toISOString().replace(/[-:T]/gu, '').slice(0, 14)}Z`, 'ascii'))
}

function extension(idHex: string, value: Buffer, critical = false): Buffer {
  return sequence(oid(idHex), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value))
}

/** Canonical network-order IPv4 (4B) or IPv6 (16B) octets for X.509 `iPAddress` SubjectAltName (RFC 5280 §4.2.1.6). */
export function encodeIpSanBytes(rawAddress: string): Buffer {
  const address = rawAddress.replace(/^\[|\]$/gu, '').toLowerCase()
  const family = isIP(address)
  if (family === 4) return Buffer.from(address.split('.').map(part => Number.parseInt(part, 10)))
  if (family !== 6) throw new RangeError('Invalid IP address for certificate SAN')

  let v6 = address
  const v4Tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/u.exec(v6)
  if (v4Tail) {
    const octets = v4Tail[2]!.split('.').map(part => Number.parseInt(part, 10))
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16)
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16)
    v6 = `${v4Tail[1]!}${hi}:${lo}`
  }
  const [left = '', right = ''] = v6.split('::')
  const head = left ? left.split(':') : []
  const tail = right ? right.split(':') : []
  const groups = v6.includes('::') ? [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => '0'), ...tail] : head
  if (groups.length !== 8) throw new RangeError('Invalid IPv6 address groups')
  const out = Buffer.alloc(16)
  groups.forEach((group, index) => {
    out.writeUInt16BE(Number.parseInt(group, 16), index * 2)
  })
  return out
}

const SELF_ISSUER = sequence(set(sequence(oid('550403'), der(0x0c, Buffer.from('relay.latch.invalid', 'utf8')))))
const ECDSA_SHA256 = sequence(oid('2a8648ce3d040302'))

/**
 * Generates or renews a self-signed P-256 TLS certificate for a bare IPv4/IPv6 literal or hostname.
 * Reusing `existingKeyPem` keeps the exact SubjectPublicKeyInfo (`spkiHash`) unchanged across every renewal,
 * so SPKI-pinned clients (Mac Host and iOS) never need to re-import the relay profile.
 */
export function createSelfSignedRelayCertificate(
  rawTarget: string,
  options: { existingKeyPem?: string | Buffer; now?: number; lifetimeDays?: number } = {},
): { cert: string; key: string; spkiHash: string } {
  const target = rawTarget.replace(/^\[|\]$/gu, '').toLowerCase()
  const ipFamily = isIP(target)
  if (ipFamily === 0 && !/^[a-z0-9.-]{1,253}$/u.test(target)) throw new RangeError('Invalid self-signed certificate target')
  const lifetimeDays = options.lifetimeDays ?? 365
  if (lifetimeDays < 1 || lifetimeDays > 397) throw new RangeError('Invalid self-signed certificate lifetime')

  const privateKey: KeyObject = options.existingKeyPem
    ? createPrivateKey(options.existingKeyPem)
    : generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new RangeError('Invalid self-signed relay private key')

  const publicKey = createPublicKey(privateKey)
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const spkiHash = createHash('sha256').update(spki).digest('hex')

  const serial = randomBytes(16)
  serial[15] = serial[15]! | 1
  const now = options.now ?? Date.now()
  const sanEntry = ipFamily !== 0 ? der(0x87, encodeIpSanBytes(target)) : der(0x82, Buffer.from(target, 'ascii'))

  // Self-anchored root/leaf profile matching `createTransportCertificate`: accepted as a sole anchor by both OpenSSL 3 and Apple SecTrust.
  const extensions = der(
    0xa3,
    sequence(
      extension('551d13', sequence(der(0x01, Buffer.from([0xff]))), true),
      extension('551d0f', der(0x03, Buffer.from([1, 0x86])), true),
      extension('551d11', sequence(sanEntry)),
      extension('551d25', sequence(oid('2b06010505070301'))),
    ),
  )
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    positiveInteger(serial),
    ECDSA_SHA256,
    SELF_ISSUER,
    sequence(generalizedTime(new Date(now - 60_000)), generalizedTime(new Date(now + lifetimeDays * DAY_MS))),
    SELF_ISSUER,
    spki,
    extensions,
  )
  const derCert = sequence(tbs, ECDSA_SHA256, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])))
  const cert = `-----BEGIN CERTIFICATE-----\n${derCert
    .toString('base64')
    .match(/.{1,64}/gu)!
    .join('\n')}\n-----END CERTIFICATE-----\n`
  const parsed = new X509Certificate(cert)
  if (!parsed.verify(publicKey)) throw new Error('Self-signed relay certificate verification failed')
  if ((ipFamily !== 0 ? parsed.checkIP(target) : parsed.checkHost(target)) === undefined)
    throw new Error('Self-signed relay certificate SAN check failed')

  return {
    cert,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    spkiHash,
  }
}

export function startSelfSignedRenewalLoop(options: {
  target: string
  certificateFile: string
  keyFile: string
  currentLeaf?(): X509Certificate | undefined
  reloadTls(): Promise<void>
  renewBeforeDays?: number
  checkIntervalMs?: number
}): { stop(): Promise<void> } {
  const renewBeforeDays = options.renewBeforeDays ?? 30
  let stopped = false
  let activeTick: Promise<void> | undefined
  let reloadPending = false

  const tick = async () => {
    if (stopped) return
    try {
      const currentPem = await readPrivate(options.certificateFile, 65_536)
      if (!currentPem) return
      const current = new X509Certificate(currentPem)
      const daysRemaining = (Date.parse(current.validTo) - Date.now()) / DAY_MS
      if (daysRemaining > renewBeforeDays) {
        const active = options.currentLeaf?.()
        if ((reloadPending || (active !== undefined && !active.raw.equals(current.raw))) && !stopped) {
          await options.reloadTls()
          reloadPending = false
        }
        return
      }
      const existingKeyPem = await readPrivate(options.keyFile, 65_536)
      if (!existingKeyPem) return
      const renewed = createSelfSignedRelayCertificate(options.target, { existingKeyPem })
      await writePrivate(options.certificateFile, renewed.cert)
      reloadPending = true
      if (!stopped) {
        await options.reloadTls()
        reloadPending = false
      }
    } catch {
      // Next scheduled tick retries cleanly without crashing the relay worker.
    }
  }

  const runTick = () => {
    if (stopped || activeTick) return
    activeTick = tick().finally(() => {
      activeTick = undefined
    })
  }

  runTick()
  const timer = setInterval(runTick, options.checkIntervalMs ?? RENEW_CHECK_MS)
  timer.unref()

  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      await activeTick
    },
  }
}
