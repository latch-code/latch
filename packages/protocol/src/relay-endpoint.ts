/**
 * The one grammar of a relay address: `https://` with a lower-case DNS name (letters, digits, dots, hyphens) or a
 * bracketed IPv6 literal, an optional port 1–65535 and at most a trailing `/`. No user, query, fragment, path or
 * underscore. The signed address book (link-wire), the Host, the settings page, the CLI and the iPhone
 * (`AddressBookCodec.relayURL`) all accept exactly this; written as a pattern because link-wire has no URL parser.
 */
const RELAY_ENDPOINT = /^https:\/\/([a-z0-9.-]{1,253}|\[[a-f0-9:]{2,45}\])(?::([0-9]{1,5}))?\/?$/u

export function isRelayEndpoint(value: string): boolean {
  const parsed = RELAY_ENDPOINT.exec(value)
  return Boolean(parsed) && (parsed![2] === undefined || (Number(parsed![2]) >= 1 && Number(parsed![2]) <= 65_535))
}

/**
 * Where a Workers relay may be asked to run: Cloudflare's Durable Object location hints. A hint is a preference the
 * platform may not honour, and no hint places the node near its first request.
 */
export const RELAY_LOCATIONS = ['apac', 'apac-ne', 'apac-se', 'wnam', 'enam', 'sam', 'weur', 'eeur', 'oc', 'afr', 'me'] as const
export type RelayLocation = (typeof RELAY_LOCATIONS)[number]
export const isRelayLocation = (value: unknown): value is RelayLocation => RELAY_LOCATIONS.includes(value as RelayLocation)
