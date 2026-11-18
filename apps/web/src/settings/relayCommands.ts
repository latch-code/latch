/**
 * The commands the 添加中继 steps show and type into a Latch terminal, in one place: today those of a source checkout
 * (`pnpm …`); a shipped command replaces them here without touching the page.
 */
export interface RelayStepCommands {
  login: string[]
  deploy: string[]
  /** Commands that bring the relay file to this Mac's ~/.latch/relays, before it is chosen. */
  fetch: string[]
}

/** Where the person's own relay files live on this Mac (0700 at both levels; see link-client's relay-files.ts). */
export const RELAYS_DIR = '~/.latch/relays'

const SERVER = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$/u
const DOMAIN = /^[a-z0-9.-]+$/u
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u

export function relaySetupCommands(
  kind: 'edge' | 'self',
  options: { region?: 'ne' | 'se'; server?: string; domain?: string } = {},
): RelayStepCommands {
  if (kind === 'edge') {
    const region = options.region ?? 'ne'
    return {
      login: ['wrangler login'],
      // Deploy, then the acceptance run against the fresh node before any Mac uses it.
      deploy: [`pnpm relay-edge:setup --region ${region}`, `pnpm relay-edge:accept --name ${region}`],
      // Finder hides ~/.latch; this opens it so the relay file can be dragged in.
      fetch: [`open ${RELAYS_DIR}`],
    }
  }
  const server = options.server && SERVER.test(options.server) ? options.server : undefined
  const domain = options.domain && DOMAIN.test(options.domain) ? options.domain : undefined
  // The file's name on this Mac: the domain with hyphens for dots, as relay names allow, else `linux`.
  const stem = domain?.replaceAll('.', '-')
  const name = stem && NAME.test(stem) ? stem : 'linux'
  return {
    login: server ? [`ssh ${server}`] : [],
    deploy: [
      'pnpm install --frozen-lockfile && pnpm build:relay && pnpm relay init --data-dir /srv/latch-relay',
      'pnpm relay check --data-dir /srv/latch-relay && pnpm relay start --data-dir /srv/latch-relay',
      ...(domain
        ? [`pnpm relay profile --data-dir /srv/latch-relay --url https://${domain}:8443 --output /srv/latch-relay/latch-connection.json`]
        : []),
    ],
    // umask 077 makes both new levels 0700; a wider ~/.latch is refused by `latch relay add`.
    fetch: server
      ? [
          `(umask 077 && mkdir -p ${RELAYS_DIR}) && scp ${server}:/srv/latch-relay/latch-connection.json ${RELAYS_DIR}/${name}.json`,
          `open ${RELAYS_DIR}`,
        ]
      : [],
  }
}
