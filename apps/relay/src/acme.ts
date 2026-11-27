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
import { join } from 'node:path'
import { z } from 'zod'
import { readPrivate, writePrivate } from './private-store.ts'

export const LETS_ENCRYPT_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory'
export const ACME_BOOTSTRAP_ISSUER = 'acme-bootstrap.latch.invalid'
const RENEW_BEFORE_MS = 30 * 86_400_000
const CHECK_INTERVAL_MS = 12 * 3_600_000

export interface AcmeConfig {
  domain: string
  directoryUrl?: string
  email?: string
}

function der(tag: number, ...parts: readonly Uint8Array[]): Buffer {
  const value = Buffer.concat(parts),
    length = value.length
  const prefix = length < 128 ? [length] : length < 256 ? [0x81, length] : [0x82, length >> 8, length & 255]
  return Buffer.concat([Buffer.from([tag, ...prefix]), value])
}
const sequence = (...parts: readonly Uint8Array[]): Buffer => der(0x30, ...parts)
const set = (...parts: readonly Uint8Array[]): Buffer => der(0x31, ...parts)
const oid = (hex: string): Buffer => der(0x06, Buffer.from(hex, 'hex'))
const ecdsaSha256 = sequence(oid('2a8648ce3d040302'))

function positiveInteger(bytes: Uint8Array): Buffer {
  let first = 0
  while (first < bytes.length - 1 && bytes[first] === 0) first++
  const value = bytes.slice(first)
  return der(0x02, ...(value[0]! & 0x80 ? [Buffer.from([0]), value] : [value]))
}
function x509Time(value: Date): Buffer {
  const iso = value.toISOString().replace(/[-:T]/gu, '')
  const year = value.getUTCFullYear()
  return year < 2050 ? der(0x17, Buffer.from(`${iso.slice(2, 14)}Z`)) : der(0x18, Buffer.from(`${iso.slice(0, 14)}Z`))
}
function commonName(cn: string): Buffer {
  return sequence(set(sequence(oid('550403'), der(0x0c, Buffer.from(cn, 'utf8')))))
}
function extension(idHex: string, value: Buffer, critical = false): Buffer {
  return sequence(oid(idHex), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value))
}
function toPem(label: string, derBytes: Buffer): string {
  return `-----BEGIN ${label}-----\n${derBytes
    .toString('base64')
    .match(/.{1,64}/gu)!
    .join('\n')}\n-----END ${label}-----\n`
}

function validDnsDomain(domain: string): void {
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(domain) || !domain.includes('.') || domain.includes('..'))
    throw new Error('ACME requires a public DNS domain name')
}

/**
 * Written by `relay init` before the process starts for the first time, so `check` and the Go gateway always find
 * private 0600 PEM files on disk. The relay stays not-ready (`/healthz` 503) until ACME replaces this certificate.
 */
export function createAcmeBootstrapCertificate(domain: string, now = Date.now()): { cert: string; key: string } {
  validDnsDomain(domain)
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicKey = createPublicKey(privateKey)
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const serial = randomBytes(16)
  serial[15] = serial[15]! | 1
  const extensions = der(
    0xa3,
    sequence(
      extension('551d13', sequence(), true),
      extension('551d0f', der(0x03, Buffer.from([7, 0x80])), true),
      extension('551d11', sequence(der(0x82, Buffer.from(domain, 'ascii')))),
    ),
  )
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    positiveInteger(serial),
    ecdsaSha256,
    commonName(ACME_BOOTSTRAP_ISSUER),
    sequence(x509Time(new Date(now - 60_000)), x509Time(new Date(now + 365 * 86_400_000))),
    commonName(domain),
    spki,
    extensions,
  )
  const certDer = sequence(tbs, ecdsaSha256, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])))
  const cert = toPem('CERTIFICATE', certDer)
  if (!new X509Certificate(cert).verify(publicKey)) throw new Error('Bootstrap certificate self-check failed')
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
}

export function isAcmeBootstrapCertificate(cert: X509Certificate): boolean {
  return cert.issuer === `CN=${ACME_BOOTSTRAP_ISSUER}` || cert.issuer.endsWith(`\nCN=${ACME_BOOTSTRAP_ISSUER}`)
}

/** RFC 8737 §3: self-signed certificate carrying critical `id-pe-acmeIdentifier` (`1.3.6.1.5.5.7.1.31`) for `acme-tls/1`. */
export function createTlsAlpn01Certificate(domain: string, keyAuthorization: string, now = Date.now()): { cert: string; key: string } {
  validDnsDomain(domain)
  const digest = createHash('sha256').update(keyAuthorization, 'ascii').digest()
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicKey = createPublicKey(privateKey)
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const serial = randomBytes(16)
  serial[15] = serial[15]! | 1
  const extensions = der(
    0xa3,
    sequence(
      extension('551d13', sequence(), true),
      extension('551d11', sequence(der(0x82, Buffer.from(domain, 'ascii')))),
      extension('2b0601050507011f', der(0x04, digest), true),
    ),
  )
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    positiveInteger(serial),
    ecdsaSha256,
    commonName(domain),
    sequence(x509Time(new Date(now - 60_000)), x509Time(new Date(now + 3_600_000))),
    commonName(domain),
    spki,
    extensions,
  )
  const certDer = sequence(tbs, ecdsaSha256, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])))
  const cert = toPem('CERTIFICATE', certDer)
  if (!new X509Certificate(cert).verify(publicKey)) throw new Error('ACME validation certificate self-check failed')
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
}

/** PKCS#10 CSR (RFC 2986) for one DNS identifier with ECDSA P-256. */
export function createCertificateRequest(domain: string): { csrBase64Url: string; keyPem: string; publicKey: KeyObject } {
  validDnsDomain(domain)
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicKey = createPublicKey(privateKey)
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const san = extension('551d11', sequence(der(0x82, Buffer.from(domain, 'ascii'))))
  const extensionRequest = sequence(oid('2a864886f70d01090e'), set(sequence(san)))
  const cri = sequence(der(0x02, Buffer.from([0])), commonName(domain), spki, der(0xa0, extensionRequest))
  const signature = sign('sha256', cri, privateKey)
  const csrDer = sequence(cri, ecdsaSha256, der(0x03, Buffer.concat([Buffer.from([0]), signature])))
  return {
    csrBase64Url: csrDer.toString('base64url'),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey,
  }
}

function accountThumbprint(accountKey: KeyObject): { jwk: { crv: string; kty: string; x: string; y: string }; thumbprint: string } {
  const exported = createPublicKey(accountKey).export({ format: 'jwk' })
  if (exported.kty !== 'EC' || exported.crv !== 'P-256' || typeof exported.x !== 'string' || typeof exported.y !== 'string')
    throw new Error('Invalid ACME account key')
  const jwk = { crv: exported.crv, kty: exported.kty, x: exported.x, y: exported.y }
  const thumbprint = createHash('sha256').update(JSON.stringify(jwk), 'utf8').digest('base64url')
  return { jwk, thumbprint }
}

const directorySchema = z.object({
  newNonce: z.string().url(),
  newAccount: z.string().url(),
  newOrder: z.string().url(),
})
const orderSchema = z.object({
  status: z.enum(['pending', 'ready', 'processing', 'valid', 'invalid']),
  authorizations: z.array(z.string().url()).min(1).max(4),
  finalize: z.string().url(),
  certificate: z.string().url().optional(),
})
const authzSchema = z.object({
  status: z.enum(['pending', 'valid', 'invalid', 'deactivated', 'expired', 'revoked']),
  challenges: z.array(
    z.object({
      type: z.string(),
      url: z.string().url(),
      token: z
        .string()
        .regex(/^[A-Za-z0-9_-]{16,256}$/u)
        .optional(),
      status: z.string().optional(),
    }),
  ),
})

export interface AcmeDeps {
  fetchImpl?: typeof fetch
  sleep?(ms: number): Promise<void>
  now?(): number
}

export async function issueAcmeCertificate(input: {
  dataDir: string
  config: AcmeConfig
  certificateFile: string
  keyFile: string
  setAcmeTls(cert: string | null, key: string | null): Promise<void>
  reloadTls(): Promise<void>
  signal?: AbortSignal
  deps?: AcmeDeps
}): Promise<void> {
  const fetchFn = input.deps?.fetchImpl ?? fetch
  const sleep = input.deps?.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = input.deps?.now ?? Date.now
  validDnsDomain(input.config.domain)

  const accountPath = join(input.dataDir, 'acme-account.pem')
  const savedKey = await readPrivate(accountPath, 4096)
  const accountKey = savedKey
    ? createPrivateKey(savedKey)
    : (() => {
        const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        return privateKey
      })()
  if (!savedKey) await writePrivate(accountPath, accountKey.export({ type: 'pkcs8', format: 'pem' }).toString())
  const { jwk, thumbprint } = accountThumbprint(accountKey)

  const dirRes = await fetchFn(input.config.directoryUrl ?? LETS_ENCRYPT_DIRECTORY, {
    headers: { Accept: 'application/json' },
    signal: input.signal ?? AbortSignal.timeout(15_000),
  })
  if (!dirRes.ok) throw new Error('ACME directory unavailable')
  const directory = directorySchema.parse((await dirRes.json()) as unknown)

  let cachedNonce: string | undefined
  const freshNonce = async (): Promise<string> => {
    if (cachedNonce) {
      const value = cachedNonce
      cachedNonce = undefined
      return value
    }
    const res = await fetchFn(directory.newNonce, { method: 'HEAD', signal: input.signal ?? AbortSignal.timeout(10_000) })
    const nonce = res.headers.get('replay-nonce')
    if (!nonce || !/^[A-Za-z0-9_-]{8,256}$/u.test(nonce)) throw new Error('ACME nonce unavailable')
    return nonce
  }

  let kid: string | undefined
  const signedPost = async (
    url: string,
    payload: unknown | null,
    accept = 'application/json',
  ): Promise<{ res: Response; text: string }> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const nonce = await freshNonce()
      const header = kid ? { alg: 'ES256', kid, nonce, url } : { alg: 'ES256', jwk, nonce, url }
      const protectedB64 = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url')
      const payloadB64 = payload === null ? '' : Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
      const signature = sign('sha256', Buffer.from(`${protectedB64}.${payloadB64}`, 'ascii'), {
        key: accountKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url')
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/jose+json', Accept: accept },
        body: JSON.stringify({ protected: protectedB64, payload: payloadB64, signature }),
        signal: input.signal ?? AbortSignal.timeout(20_000),
      })
      const nextNonce = res.headers.get('replay-nonce')
      if (nextNonce && /^[A-Za-z0-9_-]{8,256}$/u.test(nextNonce)) cachedNonce = nextNonce
      const text = await res.text()
      if (text.length > 131_072) throw new Error('ACME response limit')
      if (res.status === 400 && attempt === 0 && text.includes('badNonce')) continue
      return { res, text }
    }
    throw new Error('ACME request failed')
  }

  const accountResp = await signedPost(directory.newAccount, {
    termsOfServiceAgreed: true,
    ...(input.config.email ? { contact: [`mailto:${input.config.email}`] } : {}),
  })
  const accountUrl = accountResp.res.headers.get('location')
  if ((accountResp.res.status !== 200 && accountResp.res.status !== 201) || !accountUrl) throw new Error('ACME account registration failed')
  kid = accountUrl

  const orderResp = await signedPost(directory.newOrder, { identifiers: [{ type: 'dns', value: input.config.domain }] })
  if (orderResp.res.status !== 201 && orderResp.res.status !== 200) throw new Error('ACME order creation failed')
  const orderUrl = orderResp.res.headers.get('location')
  let order = orderSchema.parse(JSON.parse(orderResp.text) as unknown)

  for (const authzUrl of order.authorizations) {
    const authzResp = await signedPost(authzUrl, null)
    if (!authzResp.res.ok) throw new Error('ACME authorization fetch failed')
    const authz = authzSchema.parse(JSON.parse(authzResp.text) as unknown)
    if (authz.status === 'valid') continue
    if (authz.status !== 'pending') throw new Error('ACME authorization not pending')
    const challenge = authz.challenges.find(item => item.type === 'tls-alpn-01' && item.token)
    if (!challenge?.token) throw new Error('ACME CA did not offer tls-alpn-01')
    const validation = createTlsAlpn01Certificate(input.config.domain, `${challenge.token}.${thumbprint}`, now())
    await input.setAcmeTls(validation.cert, validation.key)
    try {
      const trigger = await signedPost(challenge.url, {})
      if (!trigger.res.ok) throw new Error('ACME challenge trigger failed')
      let validated = false
      for (let poll = 0; poll < 30; poll++) {
        await sleep(500)
        const checkResp = await signedPost(authzUrl, null)
        if (!checkResp.res.ok) throw new Error('ACME authorization poll failed')
        const state = authzSchema.parse(JSON.parse(checkResp.text) as unknown)
        if (state.status === 'valid') {
          validated = true
          break
        }
        if (state.status !== 'pending') throw new Error('ACME challenge validation rejected')
      }
      if (!validated) throw new Error('ACME challenge validation timed out')
    } finally {
      await input.setAcmeTls(null, null).catch(() => {})
    }
  }

  const { csrBase64Url, keyPem, publicKey } = createCertificateRequest(input.config.domain)
  const finalResp = await signedPost(order.finalize, { csr: csrBase64Url })
  if (!finalResp.res.ok) throw new Error('ACME order finalize failed')
  order = orderSchema.parse(JSON.parse(finalResp.text) as unknown)
  for (let poll = 0; poll < 30 && order.status !== 'valid'; poll++) {
    if (order.status === 'invalid') throw new Error('ACME order invalid')
    if (!orderUrl) break
    await sleep(500)
    const polled = await signedPost(orderUrl, null)
    if (!polled.res.ok) throw new Error('ACME order poll failed')
    order = orderSchema.parse(JSON.parse(polled.text) as unknown)
  }
  if (order.status !== 'valid' || !order.certificate) throw new Error('ACME certificate not issued')

  const certResp = await signedPost(order.certificate, null, 'application/pem-certificate-chain')
  if (!certResp.res.ok || !certResp.text.includes('-----BEGIN CERTIFICATE-----')) throw new Error('ACME certificate download failed')
  const leaf = new X509Certificate(certResp.text)
  if (
    !leaf.checkHost(input.config.domain)
    || isAcmeBootstrapCertificate(leaf)
    || !leaf.publicKey.export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))
    || Date.parse(leaf.validTo) <= now()
  )
    throw new Error('Issued ACME certificate failed verification')

  await writePrivate(input.keyFile, keyPem)
  await writePrivate(input.certificateFile, certResp.text.endsWith('\n') ? certResp.text : `${certResp.text}\n`)
  await input.reloadTls()
}

export function startAcmeLoop(input: {
  dataDir: string
  config: AcmeConfig
  certificateFile: string
  keyFile: string
  currentLeaf(): X509Certificate | undefined
  setAcmeTls(cert: string | null, key: string | null): Promise<void>
  reloadTls(): Promise<void>
  deps?: AcmeDeps
}): { stop(): Promise<void> } {
  const abort = new AbortController()
  const now = input.deps?.now ?? Date.now
  let running: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let failures = 0

  const needsRenewal = () => {
    const leaf = input.currentLeaf()
    if (!leaf || isAcmeBootstrapCertificate(leaf)) return true
    return Date.parse(leaf.validTo) - now() < RENEW_BEFORE_MS
  }

  const schedule = (delayMs: number) => {
    if (abort.signal.aborted) return
    timer = setTimeout(() => {
      void tick()
    }, delayMs)
    timer.unref()
  }

  const tick = async () => {
    if (abort.signal.aborted || running) return
    if (!needsRenewal()) {
      failures = 0
      schedule(CHECK_INTERVAL_MS)
      return
    }
    const work = issueAcmeCertificate({
      dataDir: input.dataDir,
      config: input.config,
      certificateFile: input.certificateFile,
      keyFile: input.keyFile,
      setAcmeTls: input.setAcmeTls,
      reloadTls: input.reloadTls,
      signal: abort.signal,
      deps: input.deps,
    })
    running = work
      .then(() => {
        failures = 0
        schedule(CHECK_INTERVAL_MS)
      })
      .catch(() => {
        failures++
        const retryMs = Math.min(15 * 60_000, 2_000 * 2 ** Math.min(failures - 1, 8))
        schedule(retryMs)
      })
      .finally(() => {
        running = undefined
      })
    await running
  }

  void tick()
  return {
    async stop() {
      abort.abort()
      clearTimeout(timer)
      await running?.catch(() => {})
    },
  }
}
