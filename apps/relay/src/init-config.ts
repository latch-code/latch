import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isRelayEndpoint } from '@latch/link-wire'

export interface PublicInit {
  domain: string
  port: number
  certificateFile: string
  keyFile: string
  /** The built `latch-relay-tls`. */
  gateway: string
  /** The interface whose counters meter the traffic quota. */
  iface: string
}

/**
 * What `init --domain` assumes for a relay that serves its owner and a few phones on a small server. Each value is the
 * operator's to raise after measuring the machine; none is a capacity claim. The quota is deliberately low: reaching it
 * stops new traffic until the reset day, which is the safe way to be wrong.
 */
export const PUBLIC_DEFAULTS = Object.freeze({
  maxConnections: 256,
  maxRoutes: 64,
  maxPerPrefix: 64,
  maxStateBytes: 1024 * 1024,
  registrationWork: { softRoutesPerPrefix: 8, minBits: 0, maxBits: 16, maxConcurrent: 1 },
  quota: {
    monthlyBytes: 100 * 1024 ** 3,
    resetDay: 1,
    timezone: 'UTC',
    count: 'in+out' as const,
    burstBytes: 64 * 1024 * 1024,
    stopRatio: 0.9 as const,
  },
  fairness: { prefixDailyShare: 0.5, overageFactor: 0.1 },
  memory: { bufferBytes: 16 * 1024 * 1024, limitBytes: 256 * 1024 * 1024 },
  gateway: { maxHandshakes: 64, handshakesPerSecond: 20, handshakeBurst: 32, prefixFraction: 0.25 },
})

/** The address the form gives must be one a phone's address book accepts, or the exported relay file is useless. */
export function publicOrigin(domain: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid relay port')
  const origin = `https://${domain}${port === 443 ? '' : `:${port}`}/`
  if (domain.includes(':') || domain.includes('/') || !isRelayEndpoint(origin)) throw new Error('Invalid relay domain')
  return origin
}

/** The public-interface fields of `relay.json`; the caller adds the node ID, admin port and registration token file. */
export function publicRelayFields(input: PublicInit) {
  publicOrigin(input.domain, input.port)
  if (![input.certificateFile, input.keyFile, input.gateway].every(isAbsolute)) throw new Error('Paths must be absolute')
  const { quota, gateway, ...rest } = PUBLIC_DEFAULTS
  return {
    host: '0.0.0.0',
    port: input.port,
    certificateFile: input.certificateFile,
    keyFile: input.keyFile,
    ...rest,
    quota: { ...quota, iface: input.iface },
    gateway: { binary: input.gateway, ...gateway },
  }
}

/** The interface of the IPv4 default route on Linux; elsewhere the operator names it. */
export async function defaultRouteInterface(table = '/proc/net/route'): Promise<string | undefined> {
  const text = await readFile(table, 'utf8').catch(() => '')
  for (const line of text.split('\n').slice(1)) {
    const [iface, destination, , flags] = line.trim().split(/\s+/u)
    // RTF_UP | RTF_GATEWAY on the all-zero destination.
    if (iface && destination === '00000000' && (Number.parseInt(flags ?? '0', 16) & 3) === 3 && /^[a-zA-Z0-9_.:-]{1,15}$/u.test(iface))
      return iface
  }
  return undefined
}
