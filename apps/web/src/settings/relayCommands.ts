import { isRelayEndpoint, isRelayLocation, type RelayLocation } from '@latch/protocol'

/**
 * The commands the 添加转发服务 steps show and type into a Latch terminal, in one place. The programs are named here and
 * nowhere else: `latch` (as the caller spells it for this Mac) deploys a Workers relay, and the relay's own program runs
 * on the person's server, today from a source checkout.
 */
export interface RelayStepCommands {
  login: string[]
  deploy: string[]
  /** Commands that bring the relay file to this Mac's ~/.latch/relays, before it is chosen. */
  fetch: string[]
}

/** Where the person's own relay files live on this Mac (0700 at both levels; see link-client's relay-files.ts). */
export const RELAYS_DIR = '~/.latch/relays'
/** The relay's program on a server. No release exists yet, so it runs from the source checkout there. */
const RELAY_PROGRAM = 'pnpm relay'
const RELAY_DATA = '/srv/latch-relay'

const SERVER = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$/u
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u
/** An absolute path that needs no quoting in a shell. */
const PLAIN_PATH = /^\/[A-Za-z0-9._/-]{1,200}$/u

export const validRelayName = (value: string) => NAME.test(value)
export const validRelayPath = (value: string) => PLAIN_PATH.test(value)
/** The origin a phone would dial, when the form's domain and port make one the address book accepts. */
export function relayOrigin(domain: string, port: string): string | undefined {
  if (!/^[a-z0-9.-]{1,253}$/u.test(domain) || !/^[0-9]{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65_535) return undefined
  const origin = `https://${domain}${port === '443' ? '' : `:${port}`}`
  return isRelayEndpoint(`${origin}/`) ? origin : undefined
}

export function relaySetupCommands(
  kind: 'edge' | 'self',
  options: {
    /** `latch` as this Mac runs it: `pnpm latch` in a source checkout, the installed command otherwise. */
    latch?: string
    name?: string
    location?: RelayLocation | undefined
    server?: string
    domain?: string
    port?: string
    cert?: string
    key?: string
  } = {},
): RelayStepCommands {
  if (kind === 'edge') {
    const name = options.name && NAME.test(options.name) ? options.name : undefined
    const location = isRelayLocation(options.location) ? ` --location ${options.location}` : ''
    return {
      login: ['wrangler login'],
      // One command deploys, runs the acceptance checks against the fresh node and writes ~/.latch/relays/<name>.json.
      deploy: name ? [`${options.latch ?? 'latch'} relay setup cloudflare --name ${name}${location}`] : [],
      fetch: [],
    }
  }
  const server = options.server && SERVER.test(options.server) ? options.server : undefined
  const origin = relayOrigin(options.domain ?? '', options.port ?? '8443')
  const cert = options.cert && PLAIN_PATH.test(options.cert) ? options.cert : undefined
  const key = options.key && PLAIN_PATH.test(options.key) ? options.key : undefined
  // The file's name on this Mac: the domain with hyphens for dots, as relay names allow, else `server`.
  const stem = options.domain?.replaceAll('.', '-')
  const name = stem && NAME.test(stem) ? stem : 'server'
  const data = `--data-dir ${RELAY_DATA}`
  return {
    login: server ? [`ssh ${server}`] : [],
    deploy:
      origin && cert && key
        ? [
            'pnpm install --frozen-lockfile && pnpm build:relay',
            // The form's answers become the whole configuration; nobody edits relay.json to start.
            `${RELAY_PROGRAM} init ${data} --domain ${options.domain} --port ${options.port ?? '8443'} --cert ${cert} --key ${key}`,
            `${RELAY_PROGRAM} check ${data} && ${RELAY_PROGRAM} profile ${data} --url ${origin} --output ${RELAY_DATA}/latch-connection.json`,
            `${RELAY_PROGRAM} start ${data}`,
          ]
        : [],
    // umask 077 makes both new levels 0700; a wider ~/.latch is refused when the file is read.
    fetch: server
      ? [`(umask 077 && mkdir -p ${RELAYS_DIR}) && scp ${server}:${RELAY_DATA}/latch-connection.json ${RELAYS_DIR}/${name}.json`]
      : [],
  }
}
