/**
 * The commands the 添加中继 steps show and type into a Latch terminal, in one place: today those of a source checkout
 * (`pnpm …`); a shipped command replaces them here without touching the page.
 */
export interface RelayStepCommands {
  login: string[]
  deploy: string[]
  /** Commands that bring the relay file to this Mac, before it is chosen. */
  fetch: string[]
}

const SERVER = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$/u
const DOMAIN = /^[a-z0-9.-]+$/u

export function relaySetupCommands(
  kind: 'edge' | 'self',
  options: { region?: 'ne' | 'se'; server?: string; domain?: string } = {},
): RelayStepCommands {
  if (kind === 'edge') {
    const region = options.region ?? 'ne'
    return {
      login: ['wrangler login'],
      deploy: [`pnpm relay-edge:setup --region ${region} --out "$HOME/latch-relay-${region}.json"`],
      fetch: [],
    }
  }
  const server = options.server && SERVER.test(options.server) ? options.server : undefined
  const domain = options.domain && DOMAIN.test(options.domain) ? options.domain : undefined
  return {
    login: server ? [`ssh ${server}`] : [],
    deploy: [
      'pnpm install --frozen-lockfile && pnpm build:relay && pnpm relay init --data-dir /srv/latch-relay',
      'pnpm relay check --data-dir /srv/latch-relay && pnpm relay start --data-dir /srv/latch-relay',
      ...(domain
        ? [`pnpm relay profile --data-dir /srv/latch-relay --url https://${domain}:8443 --output /srv/latch-relay/latch-connection.json`]
        : []),
    ],
    fetch: server ? [`scp ${server}:/srv/latch-relay/latch-connection.json "$HOME/latch-connection.json"`] : [],
  }
}
