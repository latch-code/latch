import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createTransportCertificate, nodeCrypto } from '@latch/link-client'
import { createAcmeBootstrapCertificate, isAcmeBootstrapCertificate } from '../src/acme.ts'
import { createSelfSignedRelayCertificate } from '../src/self-tls.ts'
import { startRelay } from '../src/server.ts'
import { runLinuxAcceptance } from '../scripts/accept-linux.ts'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const gatewayBinary = resolve(fileURLToPath(new URL('../../../dist/relay/latch-relay-tls', import.meta.url)))

function der(tag: number, ...parts: readonly Uint8Array[]): Buffer {
  const value = Buffer.concat(parts),
    length = value.length
  const prefix = length < 128 ? [length] : length < 256 ? [0x81, length] : [0x82, length >> 8, length & 255]
  return Buffer.concat([Buffer.from([tag, ...prefix]), value])
}
const sequence = (...parts: readonly Uint8Array[]): Buffer => der(0x30, ...parts)
const set = (...parts: readonly Uint8Array[]): Buffer => der(0x31, ...parts)
const oid = (hex: string): Buffer => der(0x06, Buffer.from(hex, 'hex'))

/** Extracts the leaf public key SPKI from a PKCS#10 CSR and signs a real CA-issued X.509 certificate for `domain`. */
function createTestCa() {
  const { privateKey: caKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const caPub = createPublicKey(caKey)
  const caSpki = caPub.export({ type: 'spki', format: 'der' })
  const alg = sequence(oid('2a8648ce3d040302'))
  const issuer = sequence(set(sequence(oid('550403'), der(0x0c, Buffer.from('Latch Test ACME CA')))))
  const now = Date.now()
  const time = (d: Date) => der(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/gu, '').slice(2, 14)}Z`))
  const caExts = der(
    0xa3,
    sequence(
      sequence(oid('551d13'), der(0x01, Buffer.from([0xff])), der(0x04, sequence(der(0x01, Buffer.from([0xff]))))),
      sequence(oid('551d0f'), der(0x01, Buffer.from([0xff])), der(0x04, der(0x03, Buffer.from([1, 0x86])))),
    ),
  )
  const caSerial = Buffer.from([1])
  const caTbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, caSerial),
    alg,
    issuer,
    sequence(time(new Date(now - 60_000)), time(new Date(now + 86_400_000))),
    issuer,
    caSpki,
    caExts,
  )
  const caCertDer = sequence(caTbs, alg, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', caTbs, caKey)])))
  const caCertPem = `-----BEGIN CERTIFICATE-----\n${caCertDer
    .toString('base64')
    .match(/.{1,64}/gu)!
    .join('\n')}\n-----END CERTIFICATE-----\n`

  function readElement(buf: Buffer, offset: number): { tag: number; start: number; end: number } {
    const tag = buf[offset]!
    let len = buf[offset + 1]!,
      at = offset + 2
    if (len & 0x80) {
      const width = len & 0x7f
      len = 0
      for (let i = 0; i < width; i++) len = (len << 8) | buf[at + i]!
      at += width
    }
    return { tag, start: at, end: at + len }
  }

  function issueFromCsr(csrBase64Url: string, domain: string): string {
    const csr = Buffer.from(csrBase64Url, 'base64url')
    const outer = readElement(csr, 0)
    const cri = readElement(csr, outer.start)
    const ver = readElement(csr, cri.start)
    const subject = readElement(csr, ver.end)
    const spki = readElement(csr, subject.end)
    const subjectSpki = csr.subarray(spki.start - (spki.start - subject.end), spki.end)

    const leafExts = der(
      0xa3,
      sequence(
        sequence(oid('551d13'), der(0x01, Buffer.from([0xff])), der(0x04, sequence())),
        sequence(oid('551d11'), der(0x04, sequence(der(0x82, Buffer.from(domain, 'ascii'))))),
      ),
    )
    const serial = randomBytes(15)
    serial[0] = serial[0]! & 0x7f
    serial[14] = serial[14]! | 1
    const tbs = sequence(
      der(0xa0, der(0x02, Buffer.from([2]))),
      der(0x02, serial),
      alg,
      issuer,
      sequence(time(new Date(Date.now() - 60_000)), time(new Date(Date.now() + 90 * 86_400_000))),
      sequence(set(sequence(oid('550403'), der(0x0c, Buffer.from(domain, 'utf8'))))),
      subjectSpki,
      leafExts,
    )
    const leafDer = sequence(tbs, alg, der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, caKey)])))
    const leafPem = `-----BEGIN CERTIFICATE-----\n${leafDer
      .toString('base64')
      .match(/.{1,64}/gu)!
      .join('\n')}\n-----END CERTIFICATE-----\n`
    return `${leafPem}${caCertPem}`
  }

  return { caCertPem, issueFromCsr }
}

describe('Linux relay ACME auto-TLS, reverse-proxy mode and self-relay quota', () => {
  it('issues a real TLS-ALPN-01 certificate through the Go gateway, rotates keys cleanly and passes full acceptance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'latch-acme-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const domain = 'relay.example.com'
    const ca = createTestCa()
    const certFile = join(dir, 'cert.pem')
    const keyFile = join(dir, 'key.pem')
    const bootstrap = createAcmeBootstrapCertificate(domain)
    const { writePrivate } = await import('../src/private-store.ts')
    await writePrivate(certFile, bootstrap.cert)
    await writePrivate(keyFile, bootstrap.key)
    expect(isAcmeBootstrapCertificate(new X509Certificate(bootstrap.cert))).toBe(true)

    let relayPort = 0
    const token = 'acme_test_token_1234567890abcdef'
    let accountThumbprint = ''
    let authzStatus: 'pending' | 'valid' | 'invalid' = 'pending'
    let orderStatus: 'pending' | 'ready' | 'valid' = 'pending'
    let issuedChain = ''

    const acmeServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      const base = `http://127.0.0.1:${(acmeServer.address() as AddressInfo).port}`
      res.setHeader('Replay-Nonce', randomBytes(16).toString('base64url'))
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/directory') {
        res.end(JSON.stringify({ newNonce: `${base}/nonce`, newAccount: `${base}/acct`, newOrder: `${base}/order` }))
        return
      }
      if (req.url === '/nonce') {
        res.writeHead(200)
        res.end()
        return
      }
      let raw = ''
      for await (const chunk of req) raw += String(chunk)
      const jws = JSON.parse(raw) as { protected: string; payload: string; signature: string }
      const header = JSON.parse(Buffer.from(jws.protected, 'base64url').toString('utf8')) as {
        jwk?: { crv: string; kty: string; x: string; y: string }
      }
      const payload = jws.payload ? (JSON.parse(Buffer.from(jws.payload, 'base64url').toString('utf8')) as Record<string, unknown>) : null

      if (req.url === '/acct') {
        const jwk = header.jwk!
        accountThumbprint = createHash('sha256')
          .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
          .digest('base64url')
        res.setHeader('Location', `${base}/acct/1`)
        res.writeHead(201)
        res.end(JSON.stringify({ status: 'valid' }))
        return
      }
      if (req.url === '/order') {
        res.setHeader('Location', `${base}/order/1`)
        res.writeHead(201)
        res.end(JSON.stringify({ status: orderStatus, authorizations: [`${base}/authz/1`], finalize: `${base}/finalize/1` }))
        return
      }
      if (req.url === '/authz/1') {
        res.end(
          JSON.stringify({
            status: authzStatus,
            challenges: [{ type: 'tls-alpn-01', url: `${base}/chall/1`, token, status: authzStatus }],
          }),
        )
        return
      }
      if (req.url === '/chall/1') {
        // Real TLS-ALPN-01 probe against the Go gateway on `relayPort`!
        const expectedDigest = createHash('sha256').update(`${token}.${accountThumbprint}`, 'ascii').digest()
        const peerCertRaw = await new Promise<Buffer>((resolveCert, rejectCert) => {
          const sock = tlsConnect({
            host: '127.0.0.1',
            port: relayPort,
            servername: domain,
            ALPNProtocols: ['acme-tls/1'],
            rejectUnauthorized: false,
          })
          sock.once('secureConnect', () => {
            expect(sock.alpnProtocol).toBe('acme-tls/1')
            const peer = sock.getPeerCertificate()
            sock.end()
            resolveCert(peer.raw)
          })
          sock.once('error', rejectCert)
        })
        // OID 1.3.6.1.5.5.7.1.31 (06 08 2b 06 01 05 05 07 01 1f) + critical true (01 01 ff) + OCTET STRING (04 22 04 20 <digest>)
        const expectedExt = Buffer.concat([Buffer.from('06082b0601050507011f0101ff04220420', 'hex'), expectedDigest])
        expect(peerCertRaw.includes(expectedExt)).toBe(true)
        authzStatus = 'valid'
        orderStatus = 'ready'
        res.end(JSON.stringify({ status: 'valid' }))
        return
      }
      if (req.url === '/finalize/1') {
        issuedChain = ca.issueFromCsr(String(payload?.csr ?? ''), domain)
        orderStatus = 'valid'
        res.end(
          JSON.stringify({
            status: 'valid',
            authorizations: [`${base}/authz/1`],
            finalize: `${base}/finalize/1`,
            certificate: `${base}/cert/1`,
          }),
        )
        return
      }
      if (req.url === '/order/1') {
        res.end(
          JSON.stringify({
            status: orderStatus,
            authorizations: [`${base}/authz/1`],
            finalize: `${base}/finalize/1`,
            ...(issuedChain ? { certificate: `${base}/cert/1` } : {}),
          }),
        )
        return
      }
      if (req.url === '/cert/1') {
        res.setHeader('Content-Type', 'application/pem-certificate-chain')
        res.end(issuedChain)
        return
      }
      res.writeHead(404)
      res.end()
    })
    acmeServer.listen(0, '127.0.0.1')
    await once(acmeServer, 'listening')
    cleanup.push(() => new Promise<void>(r => acmeServer.close(() => r())))
    const acmePort = (acmeServer.address() as AddressInfo).port

    const relayId = randomBytes(16)
    const regToken = randomBytes(32)
    const signingSeed = randomBytes(32)
    const relayKey = Buffer.from(await nodeCrypto.publicKey(signingSeed)).toString('hex')

    const relay = await startRelay({
      dataDir: dir,
      relayId,
      registrationToken: regToken,
      edgeIdentity: { seed: signingSeed },
      host: '127.0.0.1',
      port: 0,
      cert: await readFile(certFile),
      key: await readFile(keyFile),
      tlsFiles: { certificateFile: certFile, keyFile: keyFile },
      gateway: { binary: gatewayBinary, maxHandshakes: 64, handshakesPerSecond: 100, handshakeBurst: 64, prefixFraction: 0.5 },
      acme: { domain, directoryUrl: `http://127.0.0.1:${acmePort}/directory`, email: 'ops@example.com' },
      acmeDeps: { sleep: async () => {} },
    })
    cleanup.push(() => relay.close())
    relayPort = relay.port

    await expect.poll(() => relay.status().ready, { timeout: 10_000 }).toBe(true)
    expect((await stat(certFile)).mode & 0o777).toBe(0o600)
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600)
    expect(isAcmeBootstrapCertificate(new X509Certificate(await readFile(certFile)))).toBe(false)
    // Confirm the private key was rotated away from the bootstrap key without breaking reloadTls or relayKey!
    expect(createPublicKey(createPrivateKey(await readFile(keyFile))).export({ type: 'spki', format: 'der' })).not.toEqual(
      createPublicKey(createPrivateKey(bootstrap.key)).export({ type: 'spki', format: 'der' }),
    )

    const results = await runLinuxAcceptance(
      {
        relayId: relayId.toString('hex'),
        url: `https://${domain}:${relayPort}/`,
        kind: 'edge',
        relayKey,
        registrationKey: `lrt1.${regToken.toString('base64url')}`,
      },
      { ca: ca.caCertPem, address: '127.0.0.1' },
    )
    expect(results).toEqual([
      { name: 'healthz', result: 'pass', detail: 'HTTP 200' },
      { name: 'wrong-credentials', result: 'pass', detail: '错误密钥已拒，错误令牌已拒' },
      { name: 'register-and-splice', result: 'pass', detail: '登记与双向端到端字节拼接正常' },
    ])

    // Legacy v1 SPKI-pinned clients (`/v1/{h,d,c}`) remain 100% compatible on the same dual-stack relay:
    const activeSpkiHash = createHash('sha256')
      .update(new X509Certificate(await readFile(certFile)).publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex')
    const legacyResults = await runLinuxAcceptance(
      {
        relayId: relayId.toString('hex'),
        url: `https://${domain}:${relayPort}/`,
        spkiHash: activeSpkiHash,
        registrationKey: `lrt1.${regToken.toString('base64url')}`,
      },
      { ca: ca.caCertPem, address: '127.0.0.1' },
    )
    expect(legacyResults.every(item => item.result === 'pass')).toBe(true)
  })

  it('starts behind a reverse proxy with self-calibrated relay quota and survives proxy certificate rotation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'latch-proxy-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const adminDir = await mkdtemp('/tmp/latch-proxy-adm-')
    cleanup.push(() => rm(adminDir, { recursive: true, force: true }))

    const domain = 'relay.example.com'
    const relayId = randomBytes(16)
    const regToken = randomBytes(32)
    const signingSeed = randomBytes(32)
    const relayKey = Buffer.from(await nodeCrypto.publicKey(signingSeed)).toString('hex')

    const relay = await startRelay({
      dataDir: dir,
      adminSocket: join(adminDir, 'admin.sock'),
      relayId,
      registrationToken: regToken,
      edgeIdentity: { seed: signingSeed },
      behindProxy: true,
      host: '127.0.0.1',
      port: 0,
      maxStateBytes: 1024 * 1024,
      registrationWork: { softRoutesPerPrefix: 8, minBits: 0, maxBits: 16, maxConcurrent: 1 },
      quota: {
        monthlyBytes: 500 * 1024 ** 3,
        resetDay: 1,
        timezone: 'UTC',
        count: 'in+out',
        source: 'relay',
        burstBytes: 64 * 1024 * 1024,
        stopRatio: 0.9,
      },
      fairness: { prefixDailyShare: 0.5, overageFactor: 0.1 },
      memory: { bufferBytes: 16 * 1024 * 1024, limitBytes: 512 * 1024 * 1024 },
    })
    cleanup.push(() => relay.close())

    // Immediately ready and calibrated at 0 without manual `quota set-used`!
    expect(relay.status().ready).toBe(true)
    expect(relay.status().quota).toMatchObject({ calibrated: true, admission: true, monthlyUsed: 0 })

    // Simulate Caddy/Nginx terminating TLS on public port and forwarding HTTP/1.1 + WebSocket with `Connection: keep-alive, Upgrade`.
    let certPair = createTransportCertificate(Date.now(), 3_600_000, domain)
    const proxy = createHttpsServer(
      { cert: certPair.cert, key: certPair.key, minVersion: 'TLSv1.3', ALPNProtocols: ['http/1.1'] },
      (req, res) => {
        void fetch(`http://127.0.0.1:${relay.port}${req.url ?? '/'}`, { method: req.method }).then(async upstream => {
          res.writeHead(upstream.status)
          res.end(await upstream.text())
        })
      },
    )
    const proxySockets = new Set<import('node:stream').Duplex>()
    proxy.on('connection', sock => {
      proxySockets.add(sock)
      sock.once('close', () => proxySockets.delete(sock))
    })
    proxy.on('upgrade', (req, clientSocket, head) => {
      proxySockets.add(clientSocket)
      clientSocket.once('close', () => proxySockets.delete(clientSocket))
      import('node:net').then(({ connect }) => {
        const upstream = connect(relay.port, '127.0.0.1', () => {
          const lines = [
            `GET ${req.url} HTTP/1.1`,
            `Host: ${req.headers.host}`,
            'Upgrade: websocket',
            'Connection: keep-alive, Upgrade',
            `Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}`,
            `Sec-WebSocket-Version: ${req.headers['sec-websocket-version']}`,
            `Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}`,
            'X-Forwarded-For: 198.51.100.1, 203.0.113.42',
            'X-Forwarded-Proto: https',
          ]
          upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
          if (head.length) upstream.write(head)
          clientSocket.pipe(upstream)
          upstream.pipe(clientSocket)
        })
        proxySockets.add(upstream)
        upstream.once('close', () => proxySockets.delete(upstream))
        upstream.on('error', () => clientSocket.destroy())
        clientSocket.on('error', () => upstream.destroy())
      })
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    cleanup.push(
      () =>
        new Promise<void>(r => {
          proxy.closeAllConnections()
          for (const sock of proxySockets) sock.destroy()
          proxy.close(() => r())
        }),
    )
    const proxyPort = (proxy.address() as AddressInfo).port

    const profile = {
      relayId: relayId.toString('hex'),
      url: `https://${domain}:${proxyPort}/`,
      kind: 'edge' as const,
      relayKey,
      registrationKey: `lrt1.${regToken.toString('base64url')}`,
    }
    const firstRun = await runLinuxAcceptance(profile, { ca: certPair.cert, address: '127.0.0.1' })
    expect(firstRun.every(item => item.result === 'pass')).toBe(true)

    // Rotate the reverse proxy's TLS certificate to a brand-new keypair (simulating 60-day Certbot/Caddy renewal):
    certPair = createTransportCertificate(Date.now(), 3_600_000, domain)
    proxy.setSecureContext({ cert: certPair.cert, key: certPair.key })

    // Same relay profile (`relayKey`) continues to pass without re-exporting!
    const afterRotation = await runLinuxAcceptance(profile, { ca: certPair.cert, address: '127.0.0.1' })
    expect(afterRotation.every(item => item.result === 'pass')).toBe(true)
  })

  it('runs zero-domain bare-IP mode with SPKI-pinned self-signed TLS, no custom CA, and key-preserving auto-renewal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'latch-bare-ip-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const certFile = join(dir, 'cert.pem')
    const keyFile = join(dir, 'key.pem')

    // Start with a 10-day self-signed IP SAN certificate (< 30-day renewal threshold) so `startRelay` immediately renews it!
    const initial = createSelfSignedRelayCertificate('127.0.0.1', { lifetimeDays: 10 })
    const { writePrivate } = await import('../src/private-store.ts')
    await writePrivate(certFile, initial.cert)
    await writePrivate(keyFile, initial.key)

    const relayId = randomBytes(16)
    const regToken = randomBytes(32)
    const relay = await startRelay({
      dataDir: dir,
      relayId,
      registrationToken: regToken,
      host: '127.0.0.1',
      port: 0,
      cert: await readFile(certFile),
      key: await readFile(keyFile),
      tlsFiles: { certificateFile: certFile, keyFile: keyFile },
      selfSignedTls: { target: '127.0.0.1', renewBeforeDays: 30 },
      gateway: { binary: gatewayBinary, maxHandshakes: 64, handshakesPerSecond: 100, handshakeBurst: 64, prefixFraction: 0.5 },
    })
    cleanup.push(() => relay.close())

    // Wait for the background renewal loop to re-sign `certFile` out to ~365 days while keeping `spkiHash` identical!
    await expect.poll(() => relay.status().certificate?.daysRemaining ?? 0, { timeout: 5_000 }).toBeGreaterThan(300)
    const renewedSpkiHash = createHash('sha256')
      .update(new X509Certificate(await readFile(certFile)).publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex')
    expect(renewedSpkiHash).toBe(initial.spkiHash)

    // Full acceptance over `https://127.0.0.1:<port>/` with NO `ca` passed at all — only the pinned 256-bit `spkiHash`!
    const bareIpResults = await runLinuxAcceptance({
      relayId: relayId.toString('hex'),
      url: `https://127.0.0.1:${relay.port}/`,
      spkiHash: initial.spkiHash,
      registrationKey: `lrt1.${regToken.toString('base64url')}`,
    })
    expect(bareIpResults).toEqual([
      { name: 'healthz', result: 'pass', detail: 'HTTP 200' },
      { name: 'wrong-credentials', result: 'pass', detail: '错误密钥已拒，错误令牌已拒' },
      { name: 'register-and-splice', result: 'pass', detail: '登记与双向端到端字节拼接正常' },
    ])
  })
})
