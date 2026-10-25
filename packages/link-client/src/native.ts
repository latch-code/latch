import { createHash, createPublicKey, verify, X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import type { Duplex } from 'node:stream'
import { connect, createServer as createTlsServer, createSecureContext, type TLSSocket } from 'node:tls'
import { constants } from 'node:crypto'
import {
  ascii,
  concat,
  equal,
  field,
  fixed,
  hex,
  knock,
  Reader,
  serverBinding,
  uint,
  verifyKnock,
  type KnockBinding,
} from '@latch/link-wire'
import { nodeCrypto } from './crypto.ts'
import { createDeviceTrustAnchor } from './certificate.ts'

const PROTOCOL = 'h2'
function rootInput(spki: Uint8Array, nonce: Uint8Array, notBefore: number, notAfter: number): Uint8Array {
  return concat(ascii('latch-host-proof-v1\0'), field(spki), fixed(nonce, 16), uint(notBefore, 8), uint(notAfter, 8))
}
async function readExact(stream: Duplex, size: number, timeoutMs: number): Promise<Buffer> {
  const signal = AbortSignal.timeout(timeoutMs)
  for (;;) {
    const chunk = stream.read(size) as Buffer | null
    if (chunk) return chunk
    if (stream.destroyed || stream.readableEnded) throw new Error('Native transport closed')
    await once(stream, 'readable', { signal })
  }
}
async function record(stream: Duplex, timeoutMs = 3000): Promise<Buffer> {
  const header = await readExact(stream, 2, timeoutMs),
    size = header.readUInt16BE()
  if (size < 1 || size > 8192) throw new RangeError('Invalid native record size')
  return readExact(stream, size, timeoutMs)
}
async function writeRecord(stream: Duplex, bytes: Uint8Array): Promise<void> {
  if (bytes.length > 8192) throw new RangeError('Native record too large')
  await new Promise<void>((resolve, reject) =>
    stream.write(concat(uint(bytes.length, 2), bytes), error => (error ? reject(new Error('Native transport write failed')) : resolve())),
  )
}
function hash(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest()
}
export type NativeDevice = { id: string; knockKey: Uint8Array } & ({ kind: 'registered'; certificate: string } | { kind: 'pairing' })
export interface NativeHostOptions {
  certificate: { cert: string; key: string; der: Uint8Array; spki: Uint8Array }
  identity: { publicKeySpki: Uint8Array; sign(input: Uint8Array): Uint8Array }
  devices(): readonly NativeDevice[]
  isActive(id: string): boolean
  now?(): number
  replay: Map<string, number>
  onKnock?(deviceId: string): void
}

/** No application callback runs until the knock, platform mutual TLS and current device check pass. */
export async function acceptNative(
  stream: Duplex,
  binding: KnockBinding,
  options: NativeHostOptions,
): Promise<{ socket: TLSSocket; deviceId: string; pairing: boolean }> {
  let secure: TLSSocket | undefined
  try {
    const now = options.now?.() ?? Date.now(),
      devices = options.devices()
    if (devices.length > 128) throw new RangeError('Native device limit')
    const opening = await readExact(stream, 32, 3000)
    let device: NativeDevice | undefined
    for (const candidate of devices) if (await verifyKnock(nodeCrypto, candidate.knockKey, binding, now, opening)) device = candidate
    if (!device || !options.isActive(device.id)) throw new Error('Native authentication failed')
    for (const [key, expires] of options.replay) if (expires < now) options.replay.delete(key)
    const replayKey = `${device.id}:${hex(opening.slice(0, 16))}`
    if (options.replay.has(replayKey) || options.replay.size >= 4096) throw new Error('Native authentication failed')
    options.replay.set(replayKey, now + 180_000)
    options.onKnock?.(device.id)
    const mac = await serverBinding(nodeCrypto, device.knockKey, binding, opening.slice(0, 16), options.certificate.der)
    await writeRecord(stream, concat(field(options.certificate.der), mac))
    // tls.Server owns certificate-chain verification; a bare TLSSocket does not run that server hook.
    const tlsOptions = {
      cert: options.certificate.cert,
      key: options.certificate.key,
      ...(device.kind === 'registered'
        ? {
            ca: [
              createDeviceTrustAnchor(
                new X509Certificate(device.certificate).publicKey.export({ format: 'der', type: 'spki' }),
                options.identity,
              ),
              device.certificate,
            ],
            allowPartialTrustChain: true,
          }
        : {}),
      minVersion: 'TLSv1.3' as const,
      maxVersion: 'TLSv1.3' as const,
      secureOptions: constants.SSL_OP_NO_TICKET,
      requestCert: device.kind === 'registered',
      rejectUnauthorized: true,
      numTickets: 0,
      ALPNProtocols: [PROTOCOL],
    }
    // Node's Server.setSecureContext omits allowPartialTrustChain; an explicit SNI context retains that flag.
    const context = createSecureContext(tlsOptions)
    const tlsServer = createTlsServer({
      ...tlsOptions,
      ca: [],
      SNICallback(servername, callback) {
        callback(servername === 'transport.latch.invalid' ? null : new Error('Invalid native TLS name'), context)
      },
    })
    const handshake = once(tlsServer, 'secureConnection', { signal: AbortSignal.timeout(3000) })
    tlsServer.once('tlsClientError', () => tlsServer.emit('error', new Error('Native TLS failed')))
    tlsServer.emit('connection', stream)
    secure = (await handshake)[0] as TLSSocket
    secure.on('error', () => {})
    const peer = secure.getPeerCertificate(true)
    if (
      (device.kind === 'registered' && (!secure.authorized || !peer.raw))
      || secure.alpnProtocol !== PROTOCOL
      || secure.servername !== 'transport.latch.invalid'
      || secure.isSessionReused()
      || !options.isActive(device.id)
    )
      throw new Error('Native authentication failed')
    if (device.kind === 'registered') {
      const expected = new X509Certificate(device.certificate).publicKey.export({ format: 'der', type: 'spki' })
      const actual = new X509Certificate(peer.raw).publicKey.export({ format: 'der', type: 'spki' })
      if (!equal(expected, actual)) throw new Error('Native authentication failed')
      const presented = new X509Certificate(peer.raw)
      const validFrom = Date.parse(presented.validFrom),
        validTo = Date.parse(presented.validTo)
      if (
        !presented.verify(presented.publicKey)
        || !['CN=transport.latch.invalid', 'CN=connection.latch.invalid'].includes(presented.subject)
        || !Number.isFinite(validFrom)
        || !Number.isFinite(validTo)
        || validFrom > Date.now()
        || validTo <= Date.now()
      )
        throw new Error('Native authentication failed')
    }
    const before = now - 60_000,
      after = now + 300_000,
      root = options.identity.publicKeySpki
    const input = rootInput(options.certificate.spki, opening.slice(0, 16), before, after)
    const signature = options.identity.sign(input)
    await writeRecord(secure, concat(field(root), uint(before, 8), uint(after, 8), fixed(signature, 64)))
    return { socket: secure, deviceId: device.id, pairing: device.kind === 'pairing' }
  } catch {
    secure?.destroy()
    stream.destroy()
    throw new Error('Native authentication failed')
  }
}

export async function connectNative(
  stream: Duplex,
  binding: KnockBinding,
  options: { rootSpki: Uint8Array; knockKey: Uint8Array } & (
    | { pairing: true; certificate?: never; key?: never }
    | { pairing?: false; certificate: string; key: string }
  ),
): Promise<TLSSocket> {
  let secure: TLSSocket | undefined
  try {
    if (!options.pairing && (!options.certificate || !options.key)) throw new Error('Native device identity required')
    const now = Date.now(),
      opening = await knock(nodeCrypto, options.knockKey, binding, now)
    stream.write(opening)
    const preflight = new Reader(await record(stream)),
      certificate = preflight.field(4096),
      mac = preflight.take(32)
    preflight.done()
    const expected = await serverBinding(nodeCrypto, options.knockKey, binding, opening.slice(0, 16), certificate)
    if (!equal(mac, expected)) throw new Error('Native server binding failed')
    const parsed = new X509Certificate(certificate)
    secure = connect({
      socket: stream,
      ca: parsed.toString(),
      ...(options.pairing ? {} : { cert: options.certificate, key: options.key }),
      servername: 'transport.latch.invalid',
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      ALPNProtocols: [PROTOCOL],
      secureOptions: constants.SSL_OP_NO_TICKET,
    })
    await once(secure, 'secureConnect', { signal: AbortSignal.timeout(3000) })
    if (!secure.authorized || secure.alpnProtocol !== PROTOCOL) throw new Error('Native TLS failed')
    const proof = new Reader(await record(secure)),
      root = proof.field(256),
      before = proof.number(8),
      after = proof.number(8),
      signature = proof.take(64)
    proof.done()
    const transport = new X509Certificate(secure.getPeerCertificate(true).raw).publicKey.export({ format: 'der', type: 'spki' })
    if (
      !equal(hash(transport), hash(parsed.publicKey.export({ format: 'der', type: 'spki' })))
      || !equal(root, options.rootSpki)
      || now < before
      || now > after
      || after - before > 360_000
      || !verify(
        'sha256',
        rootInput(transport, opening.slice(0, 16), before, after),
        { key: createPublicKey({ key: Buffer.from(root), format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363' },
        signature,
      )
    )
      throw new Error('Native Host identity mismatch')
    return secure
  } catch {
    secure?.destroy()
    stream.destroy()
    throw new Error('Native Host authentication failed')
  }
}
