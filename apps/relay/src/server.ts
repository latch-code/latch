import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises'
import { totalmem, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { FairScheduler } from './fairness.ts'
import { QuotaMeter, type QuotaConfig, type NetworkCounter, type QuotaSnapshot } from './quota.ts'
import { MemoryGuard, type MemorySample } from './memory.ts'
import { RegistrationWorkPool, REGISTRATION_WORK_MEMORY, type RegistrationWorkPolicy } from './registration-work.ts'
import { z } from 'zod'
import { readRelayTls } from './config.ts'
import { DenialStore } from './denials.ts'
import { constants, createHash, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createHttpServer, type RequestListener } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { startGateway, type GatewayOptions } from './gateway.ts'
import { listenPrivateBackend } from './proxy.ts'
import { isIP } from 'node:net'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { EDGE_RELAY } from '@latch/link-wire'
import { acceptKey, RelaySocket } from '@latch/link-client/websocket'
import { nodeCrypto } from '@latch/link-client/crypto'
import { RelayCore, type RelayCoreOptions } from './core.ts'
import { isAcmeBootstrapCertificate, startAcmeLoop, type AcmeConfig, type AcmeDeps } from './acme.ts'
import { startSelfSignedRenewalLoop } from './self-tls.ts'

const PING_MIN_MS = 15_000
const PROXY_HEADERS = new Set(['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'forwarded'])

export function addressPrefix(input: string): string {
  let address = input.toLowerCase()
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7)
  if (isIP(address) === 4) return `${address.split('.').slice(0, 3).join('.')}.0/24`
  if (isIP(address) !== 6) throw new RangeError('Invalid peer address')
  const [left = '', right = ''] = address.split('::'),
    head = left ? left.split(':') : [],
    tail = right ? right.split(':') : []
  const parts = address.includes('::') ? [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => '0'), ...tail] : head
  return `${parts
    .slice(0, 3)
    .map(value => Number.parseInt(value, 16).toString(16))
    .join(':')}::/48`
}

/** Rightmost valid IP added by the local reverse proxy on loopback; folded immediately into a /24 or /48 prefix. */
function forwardedSource(rawHeaders: readonly string[], fallback: string | undefined): string | undefined {
  let lastForwarded: string | undefined, lastRealIp: string | undefined
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!.toLowerCase(),
      value = rawHeaders[index + 1]!
    if (name === 'x-forwarded-for') lastForwarded = value
    else if (name === 'x-real-ip') lastRealIp = value
  }
  if (lastForwarded) {
    const parts = lastForwarded
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
    for (let index = parts.length - 1; index >= 0; index--) {
      if (isIP(parts[index]!) !== 0) return parts[index]!
    }
  }
  if (lastRealIp && isIP(lastRealIp.trim()) !== 0) return lastRealIp.trim()
  return fallback && isIP(fallback) !== 0 ? fallback : undefined
}

export interface StartRelayOptions extends Omit<RelayCoreOptions, 'crypto' | 'now' | 'registrationWork'> {
  registrationWork?: RegistrationWorkPolicy
  dataDir?: string
  maxStateBytes?: number
  gateway?: GatewayOptions
  behindProxy?: boolean
  acme?: AcmeConfig
  acmeDeps?: AcmeDeps
  selfSignedTls?: { target: string; renewBeforeDays?: number; checkIntervalMs?: number }
  tlsFiles?: { certificateFile: string; keyFile: string }
  quota?: QuotaConfig
  fairness?: { prefixDailyShare: number; overageFactor: number }
  memory?: { bufferBytes: number; limitBytes: number }
  networkCounter?(): Promise<NetworkCounter>
  memoryReader?(): Promise<MemorySample>
  cert?: string | Buffer
  key?: string | Buffer
  host: string
  port: number
  adminSocket?: string
  adminPort?: number
}

type RelayStatus = ReturnType<RelayCore['status']> & {
  ready: boolean
  runtime: { node: string; protocol: 2 }
  certificate?: { daysRemaining: number; renewalWarning: boolean }
  denials: ReturnType<DenialStore['status']>
  memory: ReturnType<MemoryGuard['status']>
  quota?: QuotaSnapshot
  forwarding?: ReturnType<FairScheduler['status']>
  gateway?: { healthy: boolean; connections: number; handshakes: number; rejected: number; forwardedBytes: number }
  registrationWork?: ReturnType<RegistrationWorkPool['status']>
  webSockets: {
    receivedBytes: number
    writtenBytes: number
    paddingReceivedBytes: number
    paddingWrittenBytes: number
    coverBatches: number
  }
}
export async function startRelay(
  options: StartRelayOptions,
): Promise<{ port: number; adminPort: number; status(): RelayStatus; drain(): void; close(): Promise<void> }> {
  const isLoopback = ['127.0.0.1', '::1'].includes(options.host)
  const isPublic = !isLoopback
  const isProduction = isPublic || Boolean(options.behindProxy)
  if (!options.gateway && isPublic) throw new Error('Public relay requires the ticket-free gateway')
  if (options.behindProxy && (!isLoopback || options.gateway || !options.edgeIdentity))
    throw new Error('Behind-proxy relay requires loopback host and an Ed25519 relay identity')
  if (!options.behindProxy && (!options.cert || !options.key)) throw new Error('TLS certificate and key required')
  if (
    isProduction
    && (!options.dataDir
      || !options.quota
      || !options.fairness
      || !options.adminSocket
      || !options.memory
      || !options.registrationWork
      || (isPublic && process.platform !== 'linux')
      || options.networkCounter
      || options.memoryReader)
  )
    throw new Error('Public relay requires measured Linux quota and memory configuration')
  if (options.registrationWork) {
    const hardRoutes = options.gateway
      ? Math.floor((options.maxRoutes ?? 512) * options.gateway.prefixFraction)
      : (options.maxRoutesPerPrefix ?? options.maxRoutes ?? 512)
    if (options.registrationWork.softRoutesPerPrefix >= hardRoutes)
      throw new Error('Registration soft limit must leave room within the prefix resource share')
    if (
      options.memory
      && options.memory.bufferBytes + options.registrationWork.maxConcurrent * REGISTRATION_WORK_MEMORY >= options.memory.limitBytes / 2
    )
      throw new Error('Registration work must fit the measured memory budget')
  }
  const registrationWork = options.registrationWork ? new RegistrationWorkPool(options.registrationWork) : undefined
  const temporary = options.dataDir ? undefined : await mkdtemp(join(tmpdir(), 'latch-relay-'))
  const denials = await DenialStore.open({
    dataDir: options.dataDir ?? temporary!,
    maxRoutes: options.maxRoutes ?? 512,
    maxBytes: options.maxStateBytes ?? 16 * 1024 * 1024,
  })
  const peers = new Set<RelaySocket>()
  const closedTraffic = { receivedBytes: 0, writtenBytes: 0, paddingReceivedBytes: 0, paddingWrittenBytes: 0, coverBatches: 0 }
  const addTraffic = (sum: typeof closedTraffic, peer: RelaySocket) => {
    const metrics = peer.metrics()
    sum.receivedBytes += metrics.readWireBytes
    sum.writtenBytes += metrics.writtenBytes
    sum.paddingReceivedBytes += metrics.readPaddingBytes
    sum.paddingWrittenBytes += metrics.paddingWrittenBytes
    sum.coverBatches += metrics.coverBatches
    return sum
  }
  const processBoot = createHash('sha256').update(randomBytes(32)).digest('hex')
  const relayTrafficCounter = async (): Promise<NetworkCounter> => {
    const sum = [...peers].reduce(addTraffic, { ...closedTraffic })
    return { boot: processBoot, rx: sum.receivedBytes, tx: sum.writtenBytes }
  }
  const quota = options.quota
    ? await QuotaMeter.open({
        dataDir: options.dataDir ?? temporary!,
        config: options.quota,
        ...(options.networkCounter
          ? { counter: options.networkCounter }
          : options.quota.source === 'relay'
            ? { counter: relayTrafficCounter }
            : {}),
      })
    : undefined
  const memory = new MemoryGuard({
    bufferBudget: options.memory?.bufferBytes ?? (options.maxConnections ?? 1024) * 64 * 1024,
    memoryLimit: options.memory?.limitBytes ?? Math.floor(totalmem() * 0.75),
    ...(options.memoryReader ? { read: options.memoryReader } : {}),
  })
  await memory.sample([])
  const scheduler = quota
    ? new FairScheduler({
        quota: () => quota.snapshot(),
        count: options.quota!.count,
        maxQueuedBytes: options.memory?.bufferBytes ?? (options.maxConnections ?? 1024) * 64 * 1024,
        maxConnections: (options.maxConnections ?? 1024) * 2,
        prefixDailyShare: options.fairness?.prefixDailyShare ?? 0.01,
        overageFactor: options.fairness?.overageFactor ?? 0.1,
      })
    : undefined
  quota?.start()
  scheduler?.start()

  let activeLeaf = options.cert ? new X509Certificate(options.cert) : undefined
  const initialSpki = activeLeaf?.publicKey.export({ type: 'spki', format: 'der' })
  const certificateReady = () => !options.acme || (activeLeaf !== undefined && !isAcmeBootstrapCertificate(activeLeaf))
  // Open-registration public nodes require kernel socket cgroup accounting; token-gated self-hosted nodes tolerate hosts without it.
  const strictSocketMemory = isPublic && Boolean(options.openRegistration)
  const ready = () =>
    certificateReady()
    && denials.status().healthy
    && memory.status().healthy
    && memory.status().used < memory.status().limit * 0.8
    && (!strictSocketMemory || memory.status().includesSockets)

  const core = new RelayCore({
    ...options,
    registrationWork: registrationWork ? { ...options.registrationWork!, verify: request => registrationWork.verify(request) } : undefined,
    ...(options.gateway
      ? {
          maxPrefixFraction: options.gateway.prefixFraction,
          maxPerPrefix: Math.floor((options.maxConnections ?? 1024) * options.gateway.prefixFraction),
          maxRoutesPerPrefix: Math.max(1, Math.floor((options.maxRoutes ?? 512) * options.gateway.prefixFraction)),
        }
      : {}),
    denials,
    serviceReady: ready,
    canAdmit: () => ready() && (!quota || quota.snapshot().admission),
    ...(scheduler
      ? {
          waitBytes: (id: number, prefixes: readonly string[], route: string, bytes: number) =>
            scheduler.wait(id * 2, prefixes, route, bytes),
          waitWire: (id: number, prefixes: readonly string[], route: string, bytes: number, direction: 'in' | 'out') =>
            direction === 'in' && options.quota!.count === 'out'
              ? Promise.resolve(true)
              : scheduler.wait(id * 2 + (direction === 'out' ? 1 : 0), prefixes, route, bytes, true),
          cancelWait: (id: number) => {
            scheduler.cancel(id * 2)
            scheduler.cancel(id * 2 + 1)
          },
        }
      : {}),
    crypto: nodeCrypto,
    now: Date.now,
  })
  const raw = new Set<import('node:stream').Duplex>()
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined
  let backend: Awaited<ReturnType<typeof listenPrivateBackend>> | undefined
  let backendDirectory: string | undefined
  let acmeLoop: ReturnType<typeof startAcmeLoop> | undefined
  let selfSignedLoop: ReturnType<typeof startSelfSignedRenewalLoop> | undefined
  const sources = new WeakMap<import('node:net').Socket, string>()
  const respond: RequestListener = (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(
        core.status().draining || !ready() || (quota && !quota.snapshot().admission) || (gateway && !gateway.healthy()) ? 503 : 200,
      )
      res.end('ok\n')
    } else {
      res.writeHead(404)
      res.end()
    }
  }
  const server =
    options.gateway || options.behindProxy
      ? createHttpServer({ maxHeaderSize: options.behindProxy ? 8192 : 4096 }, respond)
      : createHttpsServer(
          {
            cert: options.cert!,
            key: options.key!,
            minVersion: 'TLSv1.3',
            maxVersion: 'TLSv1.3',
            ALPNProtocols: ['http/1.1'],
            secureOptions: constants.SSL_OP_NO_TICKET,
            sessionIdContext: randomBytes(16).toString('hex'),
            maxHeaderSize: 4096,
          },
          respond,
        )
  server.headersTimeout = 5000
  server.requestTimeout = 5000
  server.maxRequestsPerSocket = 1
  server.on('connection', socket => {
    raw.add(socket)
    socket.once('close', () => raw.delete(socket))
    if (raw.size > (options.maxConnections ?? 1024) + 32) socket.destroy()
  })
  server.on('tlsClientError', () => {})
  server.on('secureConnection', (socket: TLSSocket) => {
    if (socket.isSessionReused()) socket.destroy()
  })
  server.on('resumeSession', (_id: Buffer, done: (error: Error | null, session: Buffer | null) => void) => done(null, null))
  let sequence = 0
  server.on('upgrade', (request, rawSocket, head) => {
    const socket = rawSocket as import('node:net').Socket
    const source = options.gateway
      ? sources.get(socket)
      : options.behindProxy
        ? forwardedSource(request.rawHeaders, socket.remoteAddress)
        : socket.remoteAddress
    const headers = request.headers,
      key = headers['sec-websocket-key'],
      urlPath = request.url ?? ''
    const isEdgePath = Boolean(options.edgeIdentity) && ['/v1/h/0', '/v1/d/0', '/v1/c/0'].includes(urlPath)
    const isLegacyPath = !options.behindProxy && ['/v1/h', '/v1/d', '/v1/c'].includes(urlPath)
    const names = request.rawHeaders
      .filter((_, index) => index % 2 === 0)
      .map(value => value.toLowerCase())
      .filter(name => !options.behindProxy || !PROXY_HEADERS.has(name))
    const connectionTokens = String(headers.connection ?? '')
      .toLowerCase()
      .split(',')
      .map(token => token.trim())
    const valid =
      request.method === 'GET'
      && (isEdgePath || isLegacyPath)
      && request.httpVersion === '1.1'
      && typeof key === 'string'
      && /^[A-Za-z0-9+/]{22}==$/u.test(key)
      && Buffer.from(key, 'base64').length === 16
      && headers['sec-websocket-version'] === '13'
      && (isEdgePath
        ? headers['sec-websocket-protocol'] === 'latch-relay.2'
        : ['latch-relay.1', 'latch-relay.2'].includes(String(headers['sec-websocket-protocol'])))
      && headers.upgrade?.toLowerCase() === 'websocket'
      && connectionTokens.includes('upgrade')
      && !headers.origin
      && !headers['content-length']
      && !headers['transfer-encoding']
      && !headers['sec-websocket-extensions']
      && new Set(names).size === names.length
    if (!valid || !source) {
      socket.destroy()
      return
    }
    const roleChar = urlPath.slice(4, 5)
    const id = ++sequence,
      role = roleChar === 'h' ? 'host' : roleChar === 'd' ? 'data' : 'client',
      version = headers['sec-websocket-protocol'] === 'latch-relay.2' ? 2 : 1
    let upgraded: RelaySocket | undefined
    socket.once('close', () => {
      core.disconnect(id)
    })
    if (
      !core.connect(
        {
          id,
          prefix: addressPrefix(source),
          edge: isEdgePath,
          ...(version === 2 ? { profile: 'outer-pad-v2' as const } : {}),
          send: message => upgraded?.send(message) ?? Promise.reject(new Error('Relay upgrade incomplete')),
          close: code => {
            if (upgraded) upgraded.close(code)
            else {
              socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
              const timer = setTimeout(() => socket.destroy(), 1000)
              timer.unref()
              socket.once('close', () => clearTimeout(timer))
            }
          },
          markSpliced: () => upgraded?.markSpliced(),
          metrics: () => {
            const stats = upgraded?.metrics() ?? { bufferedBytes: 0, pendingWriteBytes: 0, writtenBytes: 0 }
            return {
              ...stats,
              bufferedBytes: stats.bufferedBytes + (scheduler?.buffered(id * 2) ?? 0) + (scheduler?.buffered(id * 2 + 1) ?? 0),
            }
          },
        },
        role,
      )
    )
      return
    const peer = new RelaySocket(socket, false, head, {
      sendHighWaterMark: () => memory.highWaterMark(),
      receiveHighWaterMark: () => memory.highWaterMark(),
      sendTimeoutMs: 60_000,
      pingIntervalMs: isEdgePath ? EDGE_RELAY.pingIntervalMs : 25_000,
      deadAfterMs: isEdgePath ? EDGE_RELAY.nodeDeadAfterMs : 75_000,
      applicationPing: isEdgePath,
      version,
      outerPadding: version === 2 && role !== 'host',
      ...(version === 2 && role !== 'host'
        ? {
            beforeReceive: (bytes: number) => core.reserveWire(id, bytes, 'in'),
            beforeWrite: (bytes: number) => core.reserveWire(id, bytes, 'out'),
          }
        : {}),
    })
    upgraded = peer
    peers.add(peer)
    void peer.closed.then(() => {
      addTraffic(closedTraffic, peer)
      peers.delete(peer)
    })
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\nSec-WebSocket-Protocol: latch-relay.${version}\r\n\r\n`,
    )
    void (async () => {
      let lastPing = 0
      try {
        for (;;) {
          const message = await peer.receive(0)
          if (isEdgePath && message.type === 'ping') {
            const now = Date.now()
            if (now - lastPing < PING_MIN_MS) {
              peer.close(4400)
              return
            }
            lastPing = now
            await peer.send({ type: 'pong' })
            continue
          }
          await core.receive(id, message)
        }
      } catch {
        core.disconnect(id)
        peer.close()
      }
    })()
  })
  const allowKeyRotation = Boolean(options.edgeIdentity)
  const reloadTls = async () => {
    if (!options.tlsFiles) throw new Error('TLS files unavailable')
    const { cert, key } = await readRelayTls(options.tlsFiles.certificateFile, options.tlsFiles.keyFile),
      next = new X509Certificate(cert)
    const nextSpki = next.publicKey.export({ type: 'spki', format: 'der' })
    if (
      (!allowKeyRotation && (!initialSpki || initialSpki.length !== nextSpki.length || !timingSafeEqual(initialSpki, nextSpki)))
      || Date.parse(next.validTo) <= Date.now()
      || Date.parse(next.validFrom) > Date.now()
    )
      throw new Error('TLS certificate identity or validity mismatch')
    if (gateway) await gateway.reloadTls(cert, key)
    else if ('setSecureContext' in server && typeof server.setSecureContext === 'function') server.setSecureContext({ cert, key })
    activeLeaf = next
  }
  const status = (): RelayStatus => ({
    ...core.status(),
    runtime: { node: process.versions.node, protocol: 2 as const },
    ...(activeLeaf
      ? {
          certificate: {
            daysRemaining: isAcmeBootstrapCertificate(activeLeaf) ? 0 : Math.ceil((Date.parse(activeLeaf.validTo) - Date.now()) / 86400000),
            renewalWarning: isAcmeBootstrapCertificate(activeLeaf) || Date.parse(activeLeaf.validTo) - Date.now() < 10 * 86400000,
          },
        }
      : {}),
    ready: !core.status().draining && ready() && (!quota || quota.snapshot().admission) && (!gateway || gateway.healthy()),
    denials: denials.status(),
    memory: memory.status(),
    webSockets: [...peers].reduce(addTraffic, { ...closedTraffic }),
    ...(quota ? { quota: quota.snapshot() } : {}),
    ...(registrationWork ? { registrationWork: registrationWork.status() } : {}),
    ...(scheduler ? { forwarding: scheduler.status() } : {}),
    ...(gateway ? { gateway: { healthy: gateway.healthy(), ...gateway.stats() } } : {}),
  })
  const admin = createHttpServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'application/json')
    const address = admin.address() as AddressInfo | null
    if (
      (!options.adminSocket && (!address || req.headers.host !== `127.0.0.1:${address.port}`))
      || (options.adminSocket && req.headers.host !== 'latch-relay-admin')
      || req.headers.origin
      || req.headers['sec-fetch-site']
    ) {
      res.writeHead(403)
      res.end('{}')
      return
    }
    if (req.method === 'GET' && req.url === '/status') {
      res.end(JSON.stringify(status()))
      return
    }
    if (
      req.method === 'POST'
      && req.url === '/reload'
      && req.headers['x-latch-relay-admin'] === '1'
      && !req.headers['transfer-encoding']
      && (!req.headers['content-length'] || req.headers['content-length'] === '0')
      && options.tlsFiles
    ) {
      void reloadTls()
        .then(() => res.end('{"reloaded":true}'))
        .catch(() => {
          res.writeHead(409)
          res.end('{"error":"TLS reload refused or result unknown; inspect status"}')
        })
      return
    }
    if (
      req.method === 'POST'
      && req.url === '/quota'
      && req.headers['x-latch-relay-admin'] === '1'
      && req.headers['content-type'] === 'application/json'
      && !req.headers['transfer-encoding']
      && /^\d{1,3}$/u.test(req.headers['content-length'] ?? '')
      && Number(req.headers['content-length']) <= 128
      && quota
    ) {
      void (async () => {
        try {
          let body = ''
          for await (const chunk of req) {
            body += String(chunk)
            if (Buffer.byteLength(body) > 128) throw new Error('Quota input limit')
          }
          const value = z
            .object({ usedBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })
            .strict()
            .parse(JSON.parse(body) as unknown)
          await quota.setUsed(value.usedBytes)
          res.end(JSON.stringify({ quota: quota.snapshot() }))
        } catch {
          res.writeHead(400)
          res.end('{"error":"Quota calibration failed"}')
        }
      })()
      return
    }
    if (
      req.method === 'POST'
      && req.url === '/drain'
      && req.headers['x-latch-relay-admin'] === '1'
      && !req.headers['transfer-encoding']
      && (!req.headers['content-length'] || req.headers['content-length'] === '0')
    ) {
      core.drain()
      res.end('{"draining":true}')
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  let sampling = false,
    quotaMode: string | undefined
  const timer = setInterval(() => {
    core.sweep()
    void denials.sweep().catch(() => {})
    if (!sampling) {
      sampling = true
      void memory
        .sample(core.resources())
        .then(result => {
          for (const id of result.stalled) core.evict(id, 2)
          if (result.evict !== undefined) core.evict(result.evict, 2)
        })
        .finally(() => {
          sampling = false
        })
        .catch(() => {})
    }
    const state = quota?.snapshot()
    if (state?.mode !== quotaMode) {
      quotaMode = state?.mode
      if (state?.mode === 'evicting') core.notify(3, Math.min(6 * 3600_000, Math.max(0, state.resetAt - Date.now())))
      if (state?.mode === 'monthly-protection') for (const peer of core.resources()) if (peer.spliced) core.evict(peer.id, 3)
    }
  }, 1000)
  timer.unref()
  try {
    if (options.adminSocket) {
      const parent = await lstat(join(options.adminSocket, '..'))
      if (
        !isAbsolute(options.adminSocket)
        || !parent.isDirectory()
        || parent.isSymbolicLink()
        || parent.mode & 0o077
        || options.adminSocket.length > 100
      )
        throw new Error('Invalid private admin socket')
      admin.listen(options.adminSocket)
      await once(admin, 'listening')
      await chmod(options.adminSocket, 0o600)
    } else {
      admin.listen(options.adminPort ?? 0, '127.0.0.1')
      await once(admin, 'listening')
    }
    if (options.gateway) {
      backendDirectory = await mkdtemp('/tmp/latch-tls-')
      const path = join(backendDirectory, 'backend.sock')
      backend = await listenPrivateBackend(path, (socket, address) => {
        sources.set(socket, address)
        server.emit('connection', socket)
      })
      gateway = await startGateway({
        ...options.gateway,
        backend: path,
        host: options.host,
        port: options.port,
        cert: options.cert!,
        key: options.key!,
        allowKeyRotation,
        maxConnections: options.maxConnections ?? 1024,
      })
      if (options.acme && options.dataDir && options.tlsFiles) {
        const activeGateway = gateway
        acmeLoop = startAcmeLoop({
          dataDir: options.dataDir,
          config: options.acme,
          certificateFile: options.tlsFiles.certificateFile,
          keyFile: options.tlsFiles.keyFile,
          currentLeaf: () => activeLeaf,
          setAcmeTls: (cert, key) => activeGateway.setAcmeTls(cert, key),
          reloadTls,
          deps: options.acmeDeps,
        })
      }
    } else {
      server.listen(options.port, options.host)
      await once(server, 'listening')
    }
    if (options.selfSignedTls && options.tlsFiles) {
      selfSignedLoop = startSelfSignedRenewalLoop({
        target: options.selfSignedTls.target,
        certificateFile: options.tlsFiles.certificateFile,
        keyFile: options.tlsFiles.keyFile,
        reloadTls,
        ...(options.selfSignedTls.renewBeforeDays === undefined ? {} : { renewBeforeDays: options.selfSignedTls.renewBeforeDays }),
        ...(options.selfSignedTls.checkIntervalMs === undefined ? {} : { checkIntervalMs: options.selfSignedTls.checkIntervalMs }),
      })
    }
  } catch (error) {
    clearInterval(timer)
    await acmeLoop?.stop()
    await selfSignedLoop?.stop()
    admin.close()
    server.close()
    await gateway?.close()
    for (const socket of raw) socket.destroy()
    await backend?.close()
    if (backendDirectory) await rm(backendDirectory, { recursive: true, force: true })
    scheduler?.close()
    await registrationWork?.close()
    await quota?.close().catch(() => {})
    await denials.close()
    if (temporary) await rm(temporary, { recursive: true, force: true })
    throw error
  }
  return {
    port: gateway?.port ?? (server.address() as AddressInfo).port,
    adminPort: options.adminSocket ? 0 : (admin.address() as AddressInfo).port,
    status,
    drain() {
      core.drain()
    },
    async close() {
      clearInterval(timer)
      await acmeLoop?.stop()
      await selfSignedLoop?.stop()
      core.drain()
      for (const peer of peers) peer.close(4300)
      for (const socket of raw) socket.destroy()
      await gateway?.close()
      await backend?.close()
      if (backendDirectory) await rm(backendDirectory, { recursive: true, force: true })
      scheduler?.close()
      await registrationWork?.close()
      await quota?.close().catch(() => {})
      await denials.close()
      if (temporary) await rm(temporary, { recursive: true, force: true })
      await Promise.all([
        new Promise<void>(resolve => server.close(() => resolve())),
        new Promise<void>(resolve => admin.close(() => resolve())),
      ])
    },
  }
}
