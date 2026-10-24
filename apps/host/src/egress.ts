import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { isIP, isIPv4, isIPv6, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { Agent, buildConnector, fetch as undiciFetch } from 'undici'

/** Plugins declare a structurally identical type of their own (plugins/providers/http.ts); they never import the Host. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export type EgressReason =
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'metadata'
  | 'multicast'
  | 'reserved'
  | 'local-interface'
  | 'redirect'
  | 'protocol'

export class EgressDenied extends Error {
  readonly code = 'egress-denied'
  constructor(
    readonly target: string,
    readonly reason: EgressReason,
    message: string,
  ) {
    super(message)
    this.name = 'EgressDenied'
  }
}

export type LookupFunction = (
  hostname: string,
  options: { all: true; verbatim: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void

function denied(target: string, reason: EgressReason): EgressDenied {
  return new EgressDenied(
    target,
    reason,
    `Host 不会访问 ${target}（本机、私网或元数据地址）。如需访问本机模型服务，请在本机确认后加入出站白名单。`,
  )
}

function ipv4Number(ip: string): number {
  return ip.split('.').reduce((value, part) => value * 256 + Number(part), 0)
}

function inV4(ip: number, base: string, bits: number): boolean {
  const size = 2 ** (32 - bits)
  const start = ipv4Number(base)
  return ip >= start && ip < start + size
}

/**
 * Special-purpose blocks that are never globally routed: IETF protocol assignments, the documentation ranges, the
 * retired 6to4 relay anycast, and 198.18.0.0/15, which fake-IP proxies hand out for every name and then connect to
 * the real (possibly private) address themselves.
 */
const NON_GLOBAL_V4: ReadonlyArray<[string, number]> = [
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
]

function classifyV4(ip: string): Exclude<EgressReason, 'local-interface' | 'redirect' | 'protocol'> | undefined {
  const value = ipv4Number(ip)
  if (ip === '169.254.169.254') return 'metadata'
  if (inV4(value, '0.0.0.0', 8)) return 'reserved'
  if (inV4(value, '127.0.0.0', 8)) return 'loopback'
  if (inV4(value, '10.0.0.0', 8) || inV4(value, '100.64.0.0', 10) || inV4(value, '172.16.0.0', 12) || inV4(value, '192.168.0.0', 16))
    return 'private'
  if (inV4(value, '169.254.0.0', 16)) return 'link-local'
  if (inV4(value, '224.0.0.0', 4)) return 'multicast'
  if (inV4(value, '240.0.0.0', 4)) return 'reserved'
  if (NON_GLOBAL_V4.some(([base, bits]) => inV4(value, base, bits))) return 'reserved'
  return undefined
}

/** Eight 16-bit groups of a valid IPv6 address (no zone); undefined when it cannot be expanded. */
function ipv6Groups(ip: string): number[] | undefined {
  let text = ip
  const tail: number[] = []
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/u.exec(text)
  if (dotted) {
    if (!isIPv4(dotted[2]!)) return undefined
    const v4 = ipv4Number(dotted[2]!)
    tail.push(Math.floor(v4 / 65536), v4 % 65536)
    text = dotted[1]!.endsWith('::') ? dotted[1]! : dotted[1]!.slice(0, -1)
  }
  const parse = (part: string) => (part === '' ? [] : part.split(':').map(group => Number.parseInt(group, 16)))
  const total = 8 - tail.length
  const gap = text.indexOf('::')
  let groups: number[]
  if (gap >= 0) {
    const left = parse(text.slice(0, gap))
    const right = parse(text.slice(gap + 2))
    const fill = total - left.length - right.length
    if (fill < 0) return undefined
    groups = [...left, ...new Array<number>(fill).fill(0), ...right]
  } else groups = parse(text)
  groups.push(...tail)
  return groups.length === 8 && groups.every(group => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : undefined
}

function normalizeAddress(ip: string): string {
  return ip
    .replace(/^\[|\]$/gu, '')
    .replace(/%.*$/u, '')
    .toLowerCase()
}

/** Why the Host refuses to connect to `ip`, or undefined when it is a public address. */
export function isDeniedAddress(ip: string, localAddresses: ReadonlySet<string>): EgressDenied['reason'] | undefined {
  const address = normalizeAddress(ip)
  if (localAddresses.has(address)) return 'local-interface'
  if (isIPv4(address)) return classifyV4(address)
  if (!isIPv6(address)) return 'reserved'
  const groups = ipv6Groups(address)
  if (!groups) return 'reserved'
  const embedded = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
  const zeroPrefix = groups.slice(0, 5).every(group => group === 0)
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) are judged as IPv4.
  if (zeroPrefix && (groups[5] === 0xffff || groups[5] === 0)) {
    if (groups[5] === 0 && groups[6] === 0 && groups[7] === 0) return 'reserved'
    if (groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return 'loopback'
    const local = embedded(groups[6]!, groups[7]!)
    if (localAddresses.has(local)) return 'local-interface'
    return classifyV4(local)
  }
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 destination.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(group => group === 0))
    return classifyV4(embedded(groups[6]!, groups[7]!))
  if (groups[0] === 0x2002) {
    const reason = classifyV4(embedded(groups[1]!, groups[2]!))
    if (reason) return reason
  }
  // Not globally routed: local-use NAT64 (64:ff9b:1::/48, its IPv4 position varies), IPv4-translated (::ffff:0:0/96),
  // discard-only (100::/64), Teredo (2001::/32) and documentation (2001:db8::/32).
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1) return 'reserved'
  if (groups.slice(0, 4).every(group => group === 0) && groups[4] === 0xffff && groups[5] === 0) return 'reserved'
  if (groups[0] === 0x100 && groups.slice(1, 4).every(group => group === 0)) return 'reserved'
  if (groups[0] === 0x2001 && (groups[1] === 0 || groups[1] === 0xdb8)) return 'reserved'
  if (address === 'fd00:ec2::254') return 'metadata'
  const first = groups[0]!
  if ((first & 0xffc0) === 0xfe80) return 'link-local'
  if ((first & 0xffc0) === 0xfec0) return 'private'
  if ((first & 0xfe00) === 0xfc00) return 'private'
  if ((first & 0xff00) === 0xff00) return 'multicast'
  return undefined
}

function interfaceAddresses(): ReadonlySet<string> {
  const addresses = new Set<string>()
  for (const list of Object.values(networkInterfaces())) for (const item of list ?? []) addresses.add(normalizeAddress(item.address))
  return addresses
}

function cachedLocalAddresses(): () => ReadonlySet<string> {
  let cache: { at: number; value: ReadonlySet<string> } | undefined
  return () => {
    if (!cache || Date.now() - cache.at > 30_000) cache = { at: Date.now(), value: interfaceAddresses() }
    return cache.value
  }
}

const defaultLookup: LookupFunction = (hostname, options, callback) => dnsLookup(hostname, options, callback)

function hostKey(hostname: string, port: string | number): string {
  const host = normalizeAddress(hostname)
  return `${isIPv6(host) ? `[${host}]` : host}:${port}`
}

/**
 * Resolves `hostname` and returns the first address the Host may connect to. Allowlisted `host:port` entries bypass the
 * private-address rules (never the metadata addresses). Exported for tests; the connector uses it for every connection,
 * so the address that was checked is the address that is dialled.
 */
export async function resolveEgressAddress(input: {
  hostname: string
  port: number
  allow: readonly string[]
  lookup: LookupFunction
  localAddresses: ReadonlySet<string>
}): Promise<string> {
  return (await resolveEgress(input)).address
}

/** `allowedBy` names the allowlist entry the address needed, if it was not a public address. */
async function resolveEgress(input: {
  hostname: string
  port: number
  allow: readonly string[]
  lookup: LookupFunction
  localAddresses: ReadonlySet<string>
}): Promise<{ address: string; allowedBy?: string }> {
  const host = normalizeAddress(input.hostname)
  const target = hostKey(host, input.port)
  const allowed = input.allow.includes(target)
  let addresses: string[]
  if (isIP(host)) addresses = [host]
  else {
    addresses = await new Promise<string[]>((resolve, reject) => {
      input.lookup(host, { all: true, verbatim: true }, (error, list) => (error ? reject(error) : resolve(list.map(item => item.address))))
    })
  }
  let firstReason: EgressReason | undefined
  for (const address of addresses) {
    const reason = isDeniedAddress(address, input.localAddresses)
    if (!reason) return { address: normalizeAddress(address) }
    if (allowed && reason !== 'metadata') return { address: normalizeAddress(address), allowedBy: target }
    firstReason ??= reason
  }
  throw denied(target, firstReason ?? 'reserved')
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 3

/**
 * Outbound HTTP for model providers. Refuses loopback, private, link-local, metadata, multicast, reserved and local
 * interface addresses unless the exact `host:port` is allowlisted, and refuses cross-origin redirects.
 */
export function createEgressFetch(options: {
  allow: () => readonly string[]
  lookup?: LookupFunction
  localAddresses?: () => ReadonlySet<string>
  connectTimeoutMs?: number
}): FetchLike {
  const lookup = options.lookup ?? defaultLookup
  const localAddresses = options.localAddresses ?? cachedLocalAddresses()
  const connect = buildConnector({ timeout: options.connectTimeoutMs ?? 10_000 })
  // Pooled keep-alive sockets skip the connect-time check, so connections that exist only because of an allowlist
  // entry are tracked by entry and destroyed, in use or idle, as soon as that entry is gone.
  const allowedSockets = new Map<string, Set<Socket>>()
  const sweep = () => {
    if (allowedSockets.size === 0) return
    const current = new Set(options.allow())
    for (const [entry, sockets] of allowedSockets) {
      if (current.has(entry)) continue
      allowedSockets.delete(entry)
      for (const socket of sockets) socket.destroy()
    }
  }
  const track = (entry: string, socket: Socket) => {
    let sockets = allowedSockets.get(entry)
    if (!sockets) allowedSockets.set(entry, (sockets = new Set()))
    sockets.add(socket)
    socket.once('close', () => {
      sockets.delete(socket)
      if (sockets.size === 0 && allowedSockets.get(entry) === sockets) allowedSockets.delete(entry)
    })
  }
  const agent = new Agent({
    connect(connectOptions, callback) {
      sweep()
      const tls = connectOptions.protocol === 'https:'
      const port = Number(connectOptions.port) || (tls ? 443 : 80)
      const original = normalizeAddress(connectOptions.hostname)
      resolveEgress({ hostname: original, port, allow: options.allow(), lookup, localAddresses: localAddresses() }).then(
        ({ address, allowedBy }) => {
          connect(
            {
              ...connectOptions,
              hostname: address,
              // TLS still verifies the name in the URL, not the address dialled.
              servername: tls && !isIP(original) ? original : undefined,
            },
            (...args) => {
              const [, socket] = args
              if (socket && allowedBy !== undefined) track(allowedBy, socket)
              callback(...args)
            },
          )
        },
        (error: Error) => callback(error, null),
      )
    },
  })

  return async (input, init = {}) => {
    let url = new URL(input)
    const check = (current: URL) => {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') throw denied(current.host || current.protocol, 'protocol')
    }
    check(url)
    const mode = init.redirect ?? 'follow'
    const request = (target: URL, requestInit: RequestInit) => {
      sweep()
      return undiciFetch(target.href, { ...(requestInit as object), dispatcher: agent } as Parameters<
        typeof undiciFetch
      >[1]) as unknown as Promise<Response>
    }
    if (mode !== 'follow') return request(url, init)

    let current: RequestInit = { ...init, redirect: 'manual' }
    for (let hops = 0; ; hops++) {
      const response = await request(url, current)
      const location = response.headers.get('location')
      if (!REDIRECTS.has(response.status) || location === null) return response
      const next = new URL(location, url)
      check(next)
      if (next.origin !== url.origin) {
        await response.body?.cancel().catch(() => {})
        throw denied(hostKey(next.hostname, next.port || (next.protocol === 'https:' ? 443 : 80)), 'redirect')
      }
      if (hops >= MAX_REDIRECTS) {
        await response.body?.cancel().catch(() => {})
        throw new TypeError('fetch failed: too many redirects')
      }
      await response.body?.cancel().catch(() => {})
      const method = (current.method ?? 'GET').toUpperCase()
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        const headers = new Headers(current.headers)
        headers.delete('content-type')
        headers.delete('content-length')
        current = { ...current, method: method === 'HEAD' ? 'HEAD' : 'GET', body: undefined, headers }
      } else if (current.body instanceof ReadableStream) {
        throw new TypeError('fetch failed: cannot replay a streamed body after a redirect')
      }
      url = next
    }
  }
}
