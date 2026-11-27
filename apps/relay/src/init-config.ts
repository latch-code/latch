import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { isRelayEndpoint } from '@latch/link-wire'
import type { AcmeConfig } from './acme.ts'

export type PublicInit =
  | {
      mode: 'tls'
      domain: string
      port: number
      certificateFile: string
      keyFile: string
      /** The built `latch-relay-tls`. */
      gateway: string
      /** Optional Linux NIC for whole-machine billing protection; absent meters relay-forwarded bytes only. */
      iface?: string
      acme?: AcmeConfig
      selfSignedTls?: { target: string }
    }
  | {
      mode: 'proxy'
      domain: string
      /** Local loopback port the reverse proxy forwards `/v1/*` and `/healthz` to. */
      port: number
      /** Public HTTPS port clients dial on the reverse proxy (443 by default). */
      publicPort: number
      iface?: string
    }

/**
 * What `init --domain` assumes for a relay that serves its owner and a few phones on a small server. By default it
 * meters only the relay's own forwarded traffic (`source: 'relay'`, calibrated at 0 bytes on creation) so other
 * services on the same Linux host cannot trip its quota; `--iface` switches to whole-NIC provider billing protection.
 */
export const PUBLIC_DEFAULTS = Object.freeze({
  maxConnections: 256,
  maxRoutes: 64,
  maxPerPrefix: 64,
  maxStateBytes: 1024 * 1024,
  registrationWork: { softRoutesPerPrefix: 8, minBits: 0, maxBits: 16, maxConcurrent: 1 },
  quota: {
    monthlyBytes: 100 * 1024 ** 3,
    selfRelayMonthlyBytes: 500 * 1024 ** 3,
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
  const stripped = domain.replace(/^\[|\]$/gu, '').toLowerCase()
  const host = isIP(stripped) === 6 ? `[${stripped}]` : domain
  const origin = `https://${host}${port === 443 ? '' : `:${port}`}/`
  if (domain.includes('/') || (domain.includes(':') && isIP(stripped) !== 6) || !isRelayEndpoint(origin))
    throw new Error('Invalid relay domain')
  return origin
}

/** The public-interface fields of `relay.json`; the caller adds the node ID, admin port and secret files. */
export function publicRelayFields(input: PublicInit) {
  const dialedPort = input.mode === 'proxy' ? input.publicPort : input.port
  publicOrigin(input.domain, dialedPort)
  const { quota: quotaDefaults, gateway, ...rest } = PUBLIC_DEFAULTS
  const { selfRelayMonthlyBytes, monthlyBytes, ...quotaRest } = quotaDefaults
  const quota = input.iface
    ? { monthlyBytes, ...quotaRest, iface: input.iface }
    : { monthlyBytes: selfRelayMonthlyBytes, ...quotaRest, source: 'relay' as const }
  if (input.mode === 'proxy') {
    return {
      host: '127.0.0.1',
      port: input.port,
      behindProxy: true,
      ...rest,
      quota,
    }
  }
  if (![input.certificateFile, input.keyFile, input.gateway].every(isAbsolute)) throw new Error('Paths must be absolute')
  const cleanHost = input.domain.replace(/^\[|\]$/gu, '').toLowerCase()
  return {
    host: isIP(cleanHost) === 6 ? '::' : '0.0.0.0',
    port: input.port,
    certificateFile: input.certificateFile,
    keyFile: input.keyFile,
    ...(input.acme ? { acme: input.acme } : {}),
    ...(input.selfSignedTls ? { selfSignedTls: input.selfSignedTls } : {}),
    ...rest,
    quota,
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
