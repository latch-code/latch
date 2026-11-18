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
