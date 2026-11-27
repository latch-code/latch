import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectRelayTunnel, createTransportCertificate, nodeCrypto, RelayControl } from '@latch/link-client'
import { holder, issuePass, routeKey, UTC_DAY } from '@latch/link-wire'
import { createAcmeBootstrapCertificate, isAcmeBootstrapCertificate, issueAcmeCertificate } from '../src/acme.ts'
import { requestPrivateAdmin } from '../src/admin.ts'
import * as memory from '../src/memory.ts'
import { writePrivate } from '../src/private-store.ts'
import { createSelfSignedRelayCertificate, startSelfSignedRenewalLoop } from '../src/self-tls.ts'
import { startRelay } from '../src/server.ts'
import { runLinuxAcceptance } from '../scripts/accept-linux.ts'
import { buildTestGateway } from './build-gateway.ts'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

let gatewayDirectory: string, gatewayBinary: string
beforeAll(async () => {
  gatewayDirectory = await mkdtemp(join(tmpdir(), 'latch-acme-gateway-'))
  gatewayBinary = await buildTestGateway(gatewayDirectory)
}, 65_000)
afterAll(async () => {
  if (gatewayDirectory) await rm(gatewayDirectory, { recursive: true, force: true })
})

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
  it('issues and renews a TLS-ALPN-01 certificate through the Go gateway while preserving the legacy pin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'latch-acme-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const domain = 'relay.example.com'
    const ca = createTestCa()
    const certFile = join(dir, 'cert.pem')
    const keyFile = join(dir, 'key.pem')
    const bootstrap = createAcmeBootstrapCertificate(domain)
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

    let simulatedNow = Date.now()
    const relay = await startRelay({
      dataDir: dir,
      adminSocket: join(dir, 'admin.sock'),
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
      acmeDeps: { sleep: async () => {}, now: () => simulatedNow },
    })
    cleanup.push(() => relay.close())
    relayPort = relay.port

    await expect.poll(() => relay.status().ready, { timeout: 10_000 }).toBe(true)
    expect((await stat(certFile)).mode & 0o777).toBe(0o600)
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600)
    expect(isAcmeBootstrapCertificate(new X509Certificate(await readFile(certFile)))).toBe(false)
    const fetchUnexpectedOrder = vi.fn<typeof fetch>()
    await expect(
      issueAcmeCertificate({
        dataDir: dir,
        config: { domain },
        certificateFile: certFile,
        keyFile,
        setAcmeTls: async () => {},
        reloadTls: async () => {
          throw new Error('gateway busy')
        },
        deps: { fetchImpl: fetchUnexpectedOrder },
      }),
    ).rejects.toThrow('gateway busy')
    expect(fetchUnexpectedOrder).not.toHaveBeenCalled()
    // Confirm the private key was preserved from `init` so `keyFile` is never rewritten and `--legacy-spki` stays stable!
    const bootstrapSpki = createPublicKey(createPrivateKey(bootstrap.key)).export({ type: 'spki', format: 'der' })
    expect(createPublicKey(createPrivateKey(await readFile(keyFile))).export({ type: 'spki', format: 'der' })).toEqual(bootstrapSpki)

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

    // Legacy v1 SPKI-pinned clients (`/v1/{h,d,c}`) remain 100% compatible before AND after ACME renewal:
    const activeSpkiHash = createHash('sha256')
      .update(new X509Certificate(await readFile(certFile)).publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex')
    const firstCertSerial = new X509Certificate(await readFile(certFile)).serialNumber
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

    // Trigger a normal 60-day ACME renewal (`issueAcmeCertificate`) and verify `spkiHash` stays identical!
    authzStatus = 'pending'
    orderStatus = 'pending'
    issuedChain = ''
    simulatedNow = Date.now() + 70 * 86_400_000
    await issueAcmeCertificate({
      dataDir: dir,
      config: { domain, directoryUrl: `http://127.0.0.1:${acmePort}/directory`, email: 'ops@example.com' },
      certificateFile: certFile,
      keyFile: keyFile,
      setAcmeTls: async (cert, key) => {
        // Forward challenge cert to the running relay's gateway via temporary re-issue not needed if authz is valid,
        // so mark authz valid when setAcmeTls is called.
        if (cert && key) {
          authzStatus = 'valid'
          orderStatus = 'ready'
        }
      },
      reloadTls: async () => {
        await requestPrivateAdmin(dir, '/reload')
      },
      deps: {
        sleep: async () => {},
        now: () => simulatedNow,
        fetchImpl: async (inputUrl, init) => {
          const u = String(inputUrl)
          if (u.endsWith('/chall/1')) {
            return new Response(JSON.stringify({ status: 'valid' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json', 'Replay-Nonce': randomBytes(16).toString('base64url') },
            })
          }
          return fetch(inputUrl, init)
        },
      },
    })
    const renewedCert = new X509Certificate(await readFile(certFile))
    expect(renewedCert.serialNumber).not.toBe(firstCertSerial)
    const servedCert = await new Promise<X509Certificate>((resolveCert, rejectCert) => {
      const socket = tlsConnect({ host: '127.0.0.1', servername: domain, port: relayPort, ca: ca.caCertPem })
      socket.once('error', rejectCert)
      socket.once('secureConnect', () => {
        resolveCert(new X509Certificate(socket.getPeerCertificate().raw))
        socket.destroy()
      })
    })
    expect(servedCert.raw).toEqual(renewedCert.raw)
    const renewedSpkiHash = createHash('sha256')
      .update(renewedCert.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex')
    expect(renewedSpkiHash).toBe(activeSpkiHash)
    const afterRenewalLegacy = await runLinuxAcceptance(
      {
        relayId: relayId.toString('hex'),
        url: `https://${domain}:${relayPort}/`,
        spkiHash: activeSpkiHash,
        registrationKey: `lrt1.${regToken.toString('base64url')}`,
      },
      { ca: ca.caCertPem, address: '127.0.0.1' },
    )
    expect(afterRenewalLegacy.every(item => item.result === 'pass')).toBe(true)
  })

  it('keeps a deadline on directory requests alongside the shutdown signal and refuses a missing pinned key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'latch-acme-deadline-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const domain = 'relay.example.com'
    const identity = createAcmeBootstrapCertificate(domain)
    const certificateFile = join(dir, 'cert.pem')
    const keyFile = join(dir, 'key.pem')
    await writePrivate(certificateFile, identity.cert)
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    try {
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        deadline.abort(new Error('directory timed out'))
        init?.signal?.throwIfAborted()
        throw new Error('deadline ignored')
      })
      const options = {
        dataDir: dir,
        config: { domain },
        certificateFile,
        keyFile,
        signal: new AbortController().signal,
        deps: { fetchImpl },
        setAcmeTls: async () => {},
        reloadTls: async () => {},
      }
      await expect(issueAcmeCertificate(options)).rejects.toThrow('Missing ACME TLS identity')
      expect(fetchImpl).not.toHaveBeenCalled()
      await writePrivate(keyFile, identity.key)
      await expect(issueAcmeCertificate(options)).rejects.toThrow('directory timed out')
      expect(timeout).toHaveBeenCalledWith(15_000)
      const oversized = () => new Response('x'.repeat(131_073))
      await expect(issueAcmeCertificate({ ...options, deps: { fetchImpl: async () => oversized() } })).rejects.toThrow(
        'ACME response limit',
      )
    } finally {
      timeout.mockRestore()
    }
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

    // A hosted runner shares its cgroup with other jobs; model the memory of a dedicated relay service here.
    const measuredMemory = { used: 32 * 1024 * 1024, limit: 512 * 1024 * 1024, includesSockets: true }
    class FixtureMemoryGuard extends memory.MemoryGuard {
      constructor(options: ConstructorParameters<typeof memory.MemoryGuard>[0]) {
        super({ ...options, read: async () => ({ ...measuredMemory }) })
      }
    }
    const sampler = vi.spyOn(memory, 'MemoryGuard').mockImplementation(FixtureMemoryGuard)
    cleanup.push(() => {
      sampler.mockRestore()
    })
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
    measuredMemory.includesSockets = false
    await expect.poll(() => relay.status().ready, { timeout: 3_000 }).toBe(false)
    expect((await fetch(`http://127.0.0.1:${relay.port}/healthz`)).status).toBe(503)
  })

  it('runs zero-domain bare-IP mode with SPKI-pinned self-signed TLS, no custom CA, and key-preserving auto-renewal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'latch-bare-ip-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const certFile = join(dir, 'cert.pem')
    const keyFile = join(dir, 'key.pem')

    // Start with a 10-day self-signed IP SAN certificate (< 30-day renewal threshold) so `startRelay` immediately renews it!
    const initial = createSelfSignedRelayCertificate('127.0.0.1', { lifetimeDays: 10 })
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

  it('keeps v2 Host control connections alive across multiple application-ping heartbeat cycles without disconnecting', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      const certPair = createTransportCertificate(Date.now(), 3_600_000, 'relay.example.com')
      const relayId = randomBytes(16)
      const regToken = randomBytes(32)
      const signingSeed = randomBytes(32)
      const relayKey = await nodeCrypto.publicKey(signingSeed)

      const relay = await startRelay({
        relayId,
        registrationToken: regToken,
        edgeIdentity: { seed: signingSeed },
        host: '127.0.0.1',
        port: 0,
        cert: certPair.cert,
        key: certPair.key,
      })
      cleanup.push(() => relay.close())

      const endpoint = {
        url: new URL(`https://relay.example.com:${relay.port}/`),
        relayId,
        edge: { relayKey, shard: 0 },
        profile: 'outer-pad-v2' as const,
        ca: certPair.cert,
        resolveAddress: async () => '127.0.0.1',
      }
      const control = await RelayControl.connect({ ...endpoint, registrationToken: regToken })
      cleanup.push(() => control.close())

      const nowSec = Math.floor(Date.now() / 1000)
      const day = Math.floor(nowSec / UTC_DAY)
      const seed = randomBytes(32)
      const rKey = await routeKey(nodeCrypto, seed, relayId, day)
      await control.register({ routeKey: rKey, day, alternate: false })

      // Advance across 2.5 full heartbeat cycles (50s > 45s clientDeadAfterMs), flushing real socket I/O after each tick!
      for (const stepMs of [21_000, 21_000, 8_000]) {
        await vi.advanceTimersByTimeAsync(stepMs)
        await new Promise(resolveTick => setTimeout(resolveTick, 30))
      }
      expect(control.isClosed()).toBe(false)
      expect(relay.status().controls).toBe(1)

      // Prove the registered control connection still accepts and splices a live tunnel after >2 heartbeats!
      const device = await holder(nodeCrypto, seed, relayId, Buffer.from('hb'), day)
      const pass = await issuePass(nodeCrypto, rKey, {
        pairing: false,
        relayId,
        day,
        notBefore: day * UTC_DAY,
        notAfter: (day + 1) * UTC_DAY,
        routePub: await nodeCrypto.publicKey(rKey),
        holderPub: await nodeCrypto.publicKey(device.seed),
        tag: device.tag,
      })
      const pendingAccept = control.accept()
      const clientTunnel = await connectRelayTunnel({ ...endpoint, pass, holderKey: device.seed })
      const accepted = await pendingAccept
      accepted.finishSetup()
      clientTunnel.destroy()
      accepted.stream.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses new admissions on token-gated relays when full socket memory accounting is lost while keeping active tunnels', async () => {
    const certPair = createTransportCertificate(Date.now(), 3_600_000, 'relay.example.com')
    const relayId = randomBytes(16)
    const regToken = randomBytes(32)
    let includesSockets = true

    const relay = await startRelay({
      relayId,
      registrationToken: regToken,
      host: '127.0.0.1',
      port: 0,
      cert: certPair.cert,
      key: certPair.key,
      memoryReader: async () => ({ used: 16 * 1024 * 1024, limit: 256 * 1024 * 1024, includesSockets }),
    })
    cleanup.push(() => relay.close())
    expect(relay.status().ready).toBe(true)

    const endpoint = {
      url: new URL(`https://relay.example.com:${relay.port}/`),
      relayId,
      spki: createHash('sha256').update(certPair.spki).digest(),
      ca: certPair.cert,
      resolveAddress: async () => '127.0.0.1',
    }
    const control = await RelayControl.connect({ ...endpoint, registrationToken: regToken })
    cleanup.push(() => control.close())
    const day = Math.floor(Date.now() / 1000 / UTC_DAY)
    const seed = randomBytes(32)
    const rKey = await routeKey(nodeCrypto, seed, relayId, day)
    await control.register({ routeKey: rKey, day, alternate: false })
    const device = await holder(nodeCrypto, seed, relayId, Buffer.from('mem'), day)
    const pass = await issuePass(nodeCrypto, rKey, {
      pairing: false,
      relayId,
      day,
      notBefore: day * UTC_DAY,
      notAfter: (day + 1) * UTC_DAY,
      routePub: await nodeCrypto.publicKey(rKey),
      holderPub: await nodeCrypto.publicKey(device.seed),
      tag: device.tag,
    })
    const pendingAccept = control.accept()
    const clientTunnel = await connectRelayTunnel({ ...endpoint, pass, holderKey: device.seed })
    const accepted = await pendingAccept
    accepted.finishSetup()
    cleanup.push(() => {
      clientTunnel.destroy()
      accepted.stream.destroy()
    })

    // Simulate cgroup read failure falling back to Node-only RSS (`includesSockets: false`):
    includesSockets = false
    await expect.poll(() => relay.status().ready, { timeout: 3_000 }).toBe(false)

    // New control and client connections are rejected before registration token verification:
    await expect(RelayControl.connect({ ...endpoint, registrationToken: regToken })).rejects.toThrow()
    await expect(connectRelayTunnel({ ...endpoint, pass, holderKey: device.seed })).rejects.toThrow()

    // Already-spliced tunnel stays alive and continues forwarding DATA payloads!
    const payload = Buffer.from('still-alive-while-admission-paused')
    const received = new Promise<Buffer>(resolveChunk => {
      accepted.stream.once('data', (chunk: Buffer) => resolveChunk(chunk))
    })
    clientTunnel.write(payload)
    expect(await received).toEqual(payload)
  })

  it('retries reloadTls on the next self-signed renewal tick when hot-reload fails after writing the renewed certificate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'latch-self-retry-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const certFile = join(dir, 'cert.pem')
    const keyFile = join(dir, 'key.pem')
    const initial = createSelfSignedRelayCertificate('203.0.113.10', { lifetimeDays: 5 })
    await writePrivate(certFile, initial.cert)
    await writePrivate(keyFile, initial.key)

    let activeLeaf: X509Certificate | undefined = new X509Certificate(initial.cert)
    let reloadCalls = 0
    const loop = startSelfSignedRenewalLoop({
      target: '203.0.113.10',
      certificateFile: certFile,
      keyFile: keyFile,
      currentLeaf: () => activeLeaf,
      renewBeforeDays: 30,
      checkIntervalMs: 40,
      async reloadTls() {
        reloadCalls++
        if (reloadCalls === 1) throw new Error('simulated transient gateway reload failure')
        activeLeaf = new X509Certificate(await readFile(certFile))
      },
    })
    cleanup.push(() => loop.stop())

    await expect.poll(() => reloadCalls, { timeout: 3_000 }).toBeGreaterThanOrEqual(2)
    expect(Math.ceil((Date.parse(activeLeaf.validTo) - Date.now()) / 86_400_000)).toBeGreaterThan(300)
  })
})
