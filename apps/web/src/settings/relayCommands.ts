import { isRelayEndpoint, isRelayLocation, type RelayLocation } from '@latch/protocol'

/**
 * The commands the 添加转发服务 steps show and type into a Latch terminal, in one place. Both Cloudflare Workers and a
 * Linux server run one `latch relay setup …` command on this Mac, which deploys, runs acceptance checks and writes
 * `~/.latch/relays/<name>.json` (0600) without putting secrets on the command line or terminal.
 */
export interface RelayStepCommands {
  login: string[]
  deploy: string[]
  /** Legacy fetch commands; empty when `latch relay setup` writes `~/.latch/relays/<name>.json` directly. */
  fetch: string[]
}

export type ServerTlsMode = 'acme' | 'proxy' | 'custom'

/** Where the person's own relay files live on this Mac (0700 at both levels; see link-client's relay-files.ts). */
export const RELAYS_DIR = '~/.latch/relays'

const SERVER = /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9.-]+|\[[a-fA-F0-9:]+\])$/u
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u
/** An absolute path that needs no quoting in a shell. */
const PLAIN_PATH = /^\/[A-Za-z0-9._/-]{1,200}$/u

export const validRelayName = (value: string) => NAME.test(value)
export const validRelayPath = (value: string) => PLAIN_PATH.test(value)

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u
const IPV6_BRACKETED = /^\[[a-fA-F0-9:]{2,45}\]$/u

function isIpLiteral(value: string): boolean {
  const clean = value.trim()
  if (IPV4.test(clean)) return true
  if (IPV6_BRACKETED.test(clean)) return true
  return clean.includes(':') && /^[a-fA-F0-9:]{2,45}$/u.test(clean)
}

function sshServerHost(server: string | undefined): string | undefined {
  if (!server) return undefined
  const at = server.indexOf('@')
  return (at >= 0 ? server.slice(at + 1) : server).trim()
}

export function serverRelayStem(domainOrServer: string | undefined): string {
  if (!domainOrServer) return 'linux'
  const host = sshServerHost(domainOrServer) ?? domainOrServer
  const clean = host.replace(/^\[|\]$/gu, '').toLowerCase()
  const raw = isIpLiteral(host) ? `ip-${clean.replace(/[^a-f0-9]/gu, '-')}` : clean.replaceAll('.', '-')
  const stem = raw
    .replace(/[^a-z0-9-]/gu, '')
    .replace(/-+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
    .replace(/-+$/gu, '')
  return stem && NAME.test(stem) ? stem : 'linux'
}

/** The origin a phone would dial, when the form's domain/IP and port make one the address book accepts. */
export function relayOrigin(domain: string, port: string): string | undefined {
  if (!/^[0-9]{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65_535) return undefined
  const clean = domain.trim()
  const host = clean.includes(':') && !clean.startsWith('[') ? `[${clean}]` : clean
  if (!/^(?:[a-z0-9.-]{1,253}|\[[a-f0-9:]{2,45}\])$/u.test(host)) return undefined
  const origin = `https://${host}${port === '443' ? '' : `:${port}`}`
  return isRelayEndpoint(`${origin}/`) ? origin : undefined
}

export function relaySetupCommands(
  kind: 'edge' | 'self',
  options: {
    /** `latch` as this Mac runs it: `pnpm latch` in a source checkout, the installed command otherwise. */
    latch?: string
    name?: string
    location?: RelayLocation | undefined
    tlsMode?: ServerTlsMode
    server?: string
    domain?: string
    port?: string
    cert?: string
    key?: string
  } = {},
): RelayStepCommands {
  const program = options.latch ?? 'latch'
  if (kind === 'edge') {
    const name = options.name && NAME.test(options.name) ? options.name : undefined
    const location = isRelayLocation(options.location) ? ` --location ${options.location}` : ''
    return {
      login: ['wrangler login'],
      // One command deploys, runs the acceptance checks against the fresh node and writes ~/.latch/relays/<name>.json.
      deploy: name ? [`${program} relay setup cloudflare --name ${name}${location}`] : [],
      fetch: [],
    }
  }
  const server = options.server && !options.server.startsWith('-') && SERVER.test(options.server) ? options.server : undefined
  const tlsMode = options.tlsMode ?? 'acme'
  const domain = (options.domain ?? '').trim()
  const explicitName = options.name && NAME.test(options.name) ? ` --name ${options.name}` : ''

  if (!server) return { login: [], deploy: [], fetch: [] }
  // zsh treats the brackets of an IPv6 SSH target as a filename pattern.
  const serverArg = server.includes('[') ? `'${server}'` : server
  const setup = `${program} relay setup linux --server ${serverArg}`

  if (tlsMode === 'acme') {
    if (!domain) {
      const port = options.port ?? '8443'
      if (!/^[0-9]{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65_535) return { login: [], deploy: [], fetch: [] }
      const portArg = port === '8443' || port === '443' ? '' : ` --port ${port}`
      return {
        login: [],
        deploy: [`${setup}${portArg}${explicitName}`],
        fetch: [],
      }
    }
    if (isIpLiteral(domain)) {
      const port = options.port ?? '8443'
      const origin = relayOrigin(domain, port)
      if (!origin) return { login: [], deploy: [], fetch: [] }
      const cleanIp = domain.replace(/^\[|\]$/gu, '').toLowerCase()
      const sshHost = sshServerHost(server)
        ?.replace(/^\[|\]$/gu, '')
        .toLowerCase()
      const ipArg = sshHost === cleanIp ? '' : ` --ip ${cleanIp}`
      const portArg = port === '8443' || port === '443' ? '' : ` --port ${port}`
      return {
        login: [],
        deploy: [`${setup}${ipArg}${portArg}${explicitName}`],
        fetch: [],
      }
    }
    const port = options.port ?? '443'
    const origin = relayOrigin(domain, port)
    if (!origin || !domain.includes('.')) return { login: [], deploy: [], fetch: [] }
    const portArg = port === '443' ? '' : ` --port ${port}`
    return {
      login: [],
      deploy: [`${setup} --domain ${domain}${portArg}${explicitName}`],
      fetch: [],
    }
  }

  if (tlsMode === 'proxy') {
    const listenPort = options.port ?? '18443'
    const origin = relayOrigin(domain, '443')
    if (
      !origin
      || isIpLiteral(domain)
      || !domain.includes('.')
      || !/^[0-9]{1,5}$/u.test(listenPort)
      || Number(listenPort) < 1
      || Number(listenPort) > 65_535
    )
      return { login: [], deploy: [], fetch: [] }
    const portArg = listenPort === '18443' ? '' : ` --port ${listenPort}`
    return {
      login: [],
      deploy: [`${setup} --domain ${domain} --behind-proxy${portArg}${explicitName}`],
      fetch: [],
    }
  }

  const port = options.port ?? '8443'
  const effectiveTarget = domain || sshServerHost(server) || ''
  const origin = relayOrigin(effectiveTarget, port)
  const cert = options.cert && PLAIN_PATH.test(options.cert) ? options.cert : undefined
  const key = options.key && PLAIN_PATH.test(options.key) ? options.key : undefined
  if (!origin || !cert || !key) return { login: [], deploy: [], fetch: [] }
  const domainArg = domain ? (isIpLiteral(domain) ? ` --ip ${domain.replace(/^\[|\]$/gu, '').toLowerCase()}` : ` --domain ${domain}`) : ''
  const portArg = port === '8443' ? '' : ` --port ${port}`
  return {
    login: [],
    deploy: [`${setup}${domainArg}${portArg} --cert ${cert} --key ${key}${explicitName}`],
    fetch: [],
  }
}
