import { X509Certificate } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, isIP, type ListenOptions, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { chmod, lstat, readFile, unlink } from 'node:fs/promises'
import { AppError } from '../core/errors.ts'
import type { ListenerClass } from '../shared/types.ts'

export interface TlsListenerOptions {
  host: string; port: number; certPath: string; keyPath: string; publicOrigin: string
  /** Tests only: allow peers whose address is a local interface address (default false = reject). */
  allowLocalPeers?: boolean
}

/** What a request may know about where it arrived. It comes from the accepting listener only, never from headers. */
export interface ListenerContext {
  readonly listener: ListenerClass
  /** Origin credentials are bound to: `unix:`, the loopback origin or the TLS public origin. */
  readonly origin: string
  /** Exact `Host` header the listener accepts; absent on unix, where it is ignored. */
  readonly host?: string
  /** Loopback port, for redirects of `localhost:<port>` style addresses. */
  readonly port?: number
}

export type ListenerHandler = (req: IncomingMessage, res: ServerResponse, listener: ListenerContext) => void

export interface ValidatedTls {
  listener: 'lan-tls' | 'tailnet-tls'
  host: string
  port: number
  publicOrigin: string
  cert: Buffer
  key: Buffer
  notAfter: number
  allowLocalPeers: boolean
}

export interface ListenerSet {
  socketPath: string
  loopbackPort: number
  loopbackOrigin: string
  tlsOrigin?: string
  /** Drops open connections, including event streams, so `close` can finish. */
  closeAllConnections(): void
  close(): Promise<void>
}

const DAY_MS = 24 * 60 * 60 * 1000
const LOCAL_ADDRESS_TTL_MS = 30_000

/** IPv4-mapped IPv6 addresses compare as IPv4; IPv6 is lowercased without a zone. */
export function normalizeAddress(address: string): string {
  const plain = address.split('%')[0]!.toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(plain)
  return mapped ? mapped[1]! : plain
}

function ipv4Number(address: string): number | undefined {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return undefined
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!
}

function inIpv4Range(address: string, base: string, bits: number): boolean {
  const value = ipv4Number(address)
  const start = ipv4Number(base)
  if (value === undefined || start === undefined) return false
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return ((value & mask) >>> 0) === ((start & mask) >>> 0)
}

/** `tailnet-tls` for Tailscale's CGNAT and ULA ranges (IPv4-mapped CGNAT included), `lan-tls` otherwise. */
export function tlsListenerClass(host: string): 'lan-tls' | 'tailnet-tls' {
  let address: string
  try { address = canonicalBindAddress(host) } catch { return 'lan-tls' }
  const ipv4 = isIP(address) === 4 ? address : mappedIpv4(address)
  if (ipv4 !== undefined && inIpv4Range(ipv4, '100.64.0.0', 10)) return 'tailnet-tls'
  if (isIP(address) === 6 && /^fd7a:115c:a1e0:/u.test(expandIpv6(address))) return 'tailnet-tls'
  return 'lan-tls'
}

/** Eight four-digit groups; the input is a canonical (hex-only) IPv6 address. */
function expandIpv6(address: string): string {
  const [head = '', tail = ''] = address.split('::')
  const left = head ? head.split(':') : []
  const right = address.includes('::') ? (tail ? tail.split(':') : []) : []
  const missing = 8 - left.length - right.length
  const groups = address.includes('::') ? [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right] : left
  return groups.map(group => group.padStart(4, '0')).join(':')
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, in any spelling). */
function mappedIpv4(address: string): string | undefined {
  if (isIP(address) !== 6) return undefined
  const groups = expandIpv6(address).split(':')
  if (groups.slice(0, 5).some(group => group !== '0000') || groups[5] !== 'ffff') return undefined
  const value = (parseInt(groups[6]!, 16) << 16 | parseInt(groups[7]!, 16)) >>> 0
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

/**
 * The TLS bind address in one canonical spelling: an IPv4 dotted quad, or lowercase compressed IPv6 without brackets.
 * Host names, zone indexes and the unspecified address in any spelling (`0.0.0.0`, `::`, `0:0::0`, `::ffff:0.0.0.0`)
 * are refused: the entry listens on one interface the operator named, never on all of them.
 */
export function canonicalBindAddress(host: string): string {
  const literal = /^\[(.*)\]$/u.exec(host)?.[1] ?? host
  const invalid = () => new AppError(400, 'tls-invalid', 'HTTPS 监听地址必须是本机网卡的具体 IP 地址，不能是主机名或 0.0.0.0、:: 等通配地址')
  let canonical: string
  if (isIP(literal) === 4) canonical = literal
  else if (isIP(literal) === 6 && !literal.includes('%')) {
    try { canonical = new URL(`http://[${literal}]/`).hostname.slice(1, -1) } catch { throw invalid() }
  } else throw invalid()
  const ipv4 = isIP(canonical) === 4 ? canonical : mappedIpv4(canonical)
  if (canonical === '::' || (ipv4 !== undefined && inIpv4Range(ipv4, '0.0.0.0', 8))) throw invalid()
  return canonical
}

let localCache: { at: number; addresses: Set<string> } | undefined
/** Addresses of this machine; loopback ranges always count. */
export function isLocalAddress(address: string): boolean {
  const normalized = normalizeAddress(address)
  if (inIpv4Range(normalized, '127.0.0.0', 8) || normalized === '::1' || normalized === '0.0.0.0' || normalized === '::') return true
  const now = Date.now()
  if (!localCache || now - localCache.at > LOCAL_ADDRESS_TTL_MS) {
    const addresses = new Set<string>()
    for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) addresses.add(normalizeAddress(entry.address))
    localCache = { at: now, addresses }
  }
  return localCache.addresses.has(normalized)
}

/**
 * Refuses TLS material that would make the remote entry unsafe or unusable. The key check itself
 * (0600, owner, not inside the data dir or a workspace) is the caller's, since it needs those paths.
 */
export async function validateTls(options: TlsListenerOptions, now: number, log: (text: string) => void): Promise<ValidatedTls> {
  let origin: URL
  try { origin = new URL(options.publicOrigin) } catch { throw new AppError(400, 'tls-invalid', 'HTTPS 公开地址无效') }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || (origin.pathname !== '/' && origin.pathname !== '')) {
    throw new AppError(400, 'tls-invalid', 'HTTPS 公开地址必须是不含路径和查询参数的 https:// 地址')
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new AppError(400, 'tls-invalid', 'HTTPS 端口无效')
  let cert: Buffer
  let key: Buffer
  try { [cert, key] = await Promise.all([readFile(options.certPath), readFile(options.keyPath)]) }
  catch { throw new AppError(400, 'tls-invalid', '无法读取 HTTPS 证书或私钥') }
  let certificate: X509Certificate
  try { certificate = new X509Certificate(cert) } catch { throw new AppError(400, 'tls-invalid', 'HTTPS 证书无法解析') }
  const notAfter = Date.parse(certificate.validTo)
  if (!Number.isFinite(notAfter) || notAfter <= now) throw new AppError(400, 'tls-expired', 'HTTPS 证书已过期，已拒绝启动')
  const hostname = origin.hostname.replace(/^\[|\]$/gu, '')
  const matches = isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname)
  if (!matches) throw new AppError(400, 'tls-invalid', `HTTPS 证书与公开地址 ${origin.host} 不匹配`)
  if (notAfter - now < 14 * DAY_MS) log(`HTTPS 证书将在 ${Math.max(0, Math.floor((notAfter - now) / DAY_MS))} 天后过期，请及时更新。`)
  const host = canonicalBindAddress(options.host)
  return {
    listener: tlsListenerClass(host), host, port: options.port, publicOrigin: origin.origin,
    cert, key, notAfter, allowLocalPeers: options.allowLocalPeers === true,
  }
}

function listen(server: Server, options: ListenOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
    const onListening = () => { server.off('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(options)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) { resolve(); return }
    server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())
  })
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

/** A live socket means another Host owns this runtime directory; a dead one is removed. */
async function clearStaleSocket(path: string): Promise<void> {
  let stats
  try { stats = await lstat(path) }
  catch (error) { if (codeOf(error) === 'ENOENT') return; throw error }
  if (!stats.isSocket()) throw new AppError(500, 'socket-path-occupied', `${path} 不是 Latch 的套接字，已拒绝启动。请删除后重试。`)
  const live = await new Promise<boolean>(resolve => {
    const socket: Socket = connect(path)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
  if (live) throw new AppError(409, 'host-running', '另一个 Host 正在使用此数据目录，已拒绝启动')
  await unlink(path)
}

async function bindLoopback(port: number, handler: (req: IncomingMessage, res: ServerResponse) => void, log: (text: string) => void): Promise<{ servers: Server[]; port: number }> {
  const inUse = (value: number) => new AppError(500, 'port-in-use', `端口 ${value} 已被占用（127.0.0.1 或 ::1），已拒绝启动`)
  for (let attempt = 0; ; attempt++) {
    const v4 = createHttpServer(handler)
    try { await listen(v4, { host: '127.0.0.1', port, exclusive: true }) }
    catch (error) { throw codeOf(error) === 'EADDRINUSE' ? inUse(port) : error }
    const address = v4.address()
    if (!address || typeof address === 'string') { await closeServer(v4); throw new Error('Loopback listener did not bind a TCP port') }
    const v6 = createHttpServer(handler)
    try {
      await listen(v6, { host: '::1', port: address.port, ipv6Only: true, exclusive: true })
      return { servers: [v4, v6], port: address.port }
    } catch (error) {
      const code = codeOf(error)
      if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') {
        log('::1 不可用，只在 127.0.0.1 上监听。')
        return { servers: [v4], port: address.port }
      }
      await closeServer(v4)
      if (code === 'EADDRINUSE' && port === 0 && attempt < 5) continue
      throw code === 'EADDRINUSE' ? inUse(address.port) : error
    }
  }
}

/**
 * Starts host.sock (0600), loopback on 127.0.0.1 and ::1 with one port, and the optional TLS entry.
 * Each server passes its own fixed context with every request.
 */
export async function startListeners(options: {
  hostId: string
  socketPath: string
  port: number
  tls?: ValidatedTls
  handler: ListenerHandler
  log: (text: string) => void
  now?: () => number
}): Promise<ListenerSet> {
  const servers: Server[] = []
  const timers: Array<ReturnType<typeof setInterval>> = []
  let socketBound = false
  const closeAll = async () => {
    for (const timer of timers) clearInterval(timer)
    const failures: unknown[] = []
    for (const server of servers) {
      server.closeAllConnections()
      try { await closeServer(server) } catch (error) { failures.push(error) }
    }
    if (socketBound) {
      try { if ((await lstat(options.socketPath)).isSocket()) await unlink(options.socketPath) }
      catch (error) { if (codeOf(error) !== 'ENOENT') failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Listener cleanup failed')
  }
  try {
    const unixContext: ListenerContext = { listener: 'unix', origin: 'unix:' }
    await clearStaleSocket(options.socketPath)
    const unix = createHttpServer((req, res) => options.handler(req, res, unixContext))
    servers.push(unix)
    await listen(unix, { path: options.socketPath, exclusive: true })
    socketBound = true
    await chmod(options.socketPath, 0o600)

    let loopbackContext: ListenerContext | undefined
    const loopback = await bindLoopback(options.port, (req, res) => {
      if (!loopbackContext) { res.destroy(); return }
      options.handler(req, res, loopbackContext)
    }, options.log)
    servers.push(...loopback.servers)
    const host = `h-${options.hostId}.localhost:${loopback.port}`
    loopbackContext = { listener: 'loopback-tcp', origin: `http://${host}`, host, port: loopback.port }

    let tlsOrigin: string | undefined
    if (options.tls) {
      const tls = options.tls
      const tlsContext: ListenerContext = { listener: tls.listener, origin: tls.publicOrigin, host: new URL(tls.publicOrigin).host }
      const secure = createHttpsServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, (req, res) => options.handler(req, res, tlsContext))
      secure.on('connection', (socket: Socket) => {
        if (!tls.allowLocalPeers && (!socket.remoteAddress || isLocalAddress(socket.remoteAddress))) socket.destroy()
      })
      secure.on('tlsClientError', (_error, socket) => socket.destroy())
      servers.push(secure)
      try { await listen(secure, { host: tls.host, port: tls.port, exclusive: true }) }
      catch (error) { throw codeOf(error) === 'EADDRINUSE' ? new AppError(500, 'port-in-use', `HTTPS 端口 ${tls.port} 已被占用，已拒绝启动`) : error }
      tlsOrigin = tls.publicOrigin
      const now = options.now ?? Date.now
      const expiry = setInterval(() => {
        if (now() < tls.notAfter) return
        options.log('HTTPS 证书已过期，已关闭 HTTPS 入口。')
        clearInterval(expiry)
        secure.closeAllConnections()
        void closeServer(secure).catch(() => {})
      }, 60 * 60 * 1000)
      expiry.unref()
      timers.push(expiry)
    }
    return {
      socketPath: options.socketPath,
      loopbackPort: loopback.port,
      loopbackOrigin: loopbackContext.origin,
      ...(tlsOrigin ? { tlsOrigin } : {}),
      closeAllConnections() { for (const server of servers) server.closeAllConnections() },
      close: closeAll,
    }
  } catch (error) {
    await closeAll().catch(() => {})
    throw error
  }
}
