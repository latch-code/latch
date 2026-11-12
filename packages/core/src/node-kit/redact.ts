/** Latch's own credentials: device credentials, invitation and offline enrolment codes, and model and tool gateway tokens. */
const LATCH_CREDENTIALS: readonly RegExp[] = [
  /lnw1\.[A-Za-z0-9_-]{43}/gu,
  /lnp1\.[A-Za-z0-9_-]{43}/gu,
  /(?:lrt1|lrs1|lnd1)\.[A-Za-z0-9_-]{43}/gu,
  /LATCHPAIR2\.[A-Za-z0-9_-]{32,512}/gu,
  /\/pair#2\.[A-Za-z0-9_-]{32,512}/gu,
  /LATCHBOOK1\.[A-Za-z0-9_-]{32,90000}/gu,
  /ldc1\.dev_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/gu,
  /lp[io]1-[A-Z2-7]{26}/gu,
  /lmg1\.[A-Za-z0-9_-]{43}/gu,
  /lbt1\.[A-Za-z0-9_-]{43}/gu,
]

/** Where a credential travels: the cookies, the device header, URL parameters and userinfo, whatever value they carry. */
const CARRIERS: readonly RegExp[] = [
  /(?:harness_link|latch_[a-z2-7]{8}|__Host-latch_[a-z2-7]{8})=[^;\s]+/gu,
  /Latch-Device\s+\S+/gu,
  /#(?:token|pair)=[\w-]+/gu,
  /[?&]token=[\w-]+/gu,
  // URL userinfo: `user:secret@` under any scheme, and a lone name under HTTP and WebSocket, where it is a token
  // (`ssh://git@host` and `ftp://anonymous@host` are not). A raw `@` stays inside: the last one before the path ends the
  // userinfo, as URL parsers read it. A raw `/`, `?` or `#` ends the authority there too, so what follows is not userinfo.
  /(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'<>`\\:]*:[^\s/?#"'<>`\\]*(?=@)/giu,
  /(?<=\b(?:https?|wss?):\/\/)[^\s/?#"'<>`\\]*(?=@)/giu,
]

/** Keys by their own shape. */
const KEYS: readonly RegExp[] = [
  // The armour line of a private key: PEM (RSA, EC, PKCS#8, encrypted, OpenSSH) and OpenPGP.
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/gu,
  // Model-service and platform keys by their documented prefixes.
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/gu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu,
  /\bAIza[0-9A-Za-z_-]{35}/gu,
]

/**
 * What must never reach a log line; every Host log line passes through `redactSecrets`. Order matters: whole Latch
 * credentials first, then the cookie, header and parameter forms that may carry them, then keys by their shape.
 */
export const PATTERNS: readonly RegExp[] = [...LATCH_CREDENTIALS, ...CARRIERS, ...KEYS]
/**
 * Credential-shaped text alone (the page keeps its own copy in `@latch/protocol`'s `secrets.ts`, held equal by
 * `tests/redact.test.ts`): a file that only names a header or a parameter (documentation) holds no secret. */
export const CREDENTIALS: readonly RegExp[] = [...LATCH_CREDENTIALS, ...KEYS]

export function redactSecrets(text: string): string {
  let output = String(text)
  for (const pattern of PATTERNS) output = output.replace(pattern, '[redacted]')
  return output
}

/** Secrets the Host keeps that have no shape of their own (an MCP server's secret variables), by source. */
const known = new Map<string, readonly string[]>()
let knownValues: readonly string[] = []

/** A value as it may appear in text: itself, JSON-escaped and URL-encoded. */
function forms(value: string): string[] {
  return [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]
}

/**
 * Sets one source's secret values for `redactKnownSecrets`, replacing that source's earlier list. Values under 8
 * characters are never added: masking them would garble ordinary text, so such a value is not protected this way.
 */
export function setKnownSecrets(source: string, values: readonly string[]): void {
  known.set(
    source,
    values.filter(value => value.length >= 8),
  )
  // Longest first, so a value that contains another is masked whole.
  knownValues = [...new Set([...known.values()].flat().flatMap(forms))].toSorted((a, b) => b.length - a.length)
}

/** Every value `setKnownSecrets` holds, in any of its forms, masked; nothing else changes. */
export function maskKnownSecrets(text: string): string {
  let output = String(text)
  for (const value of knownValues) if (output.includes(value)) output = output.replaceAll(value, '[redacted]')
  return output
}

/** `maskKnownSecrets` over every string of a JSON-shaped value (an agent's update), returning the same shape. */
export function maskKnownSecretsIn<T>(value: T): T {
  if (knownValues.length === 0) return value
  const walk = (item: unknown): unknown =>
    typeof item === 'string'
      ? maskKnownSecrets(item)
      : Array.isArray(item)
        ? item.map(walk)
        : item && typeof item === 'object'
          ? Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]))
          : item
  return walk(value) as T
}

/**
 * `redactSecrets`, and every value `setKnownSecrets` holds, for text the Host sends out: log lines, session text,
 * errors, events and diagnostics. Not for deciding whether a file or a text holds a secret: that is `redactSecrets` and
 * `containsSecret`, which know only shapes.
 */
export function redactKnownSecrets(text: string): string {
  return redactSecrets(maskKnownSecrets(text))
}

/**
 * Whether the text holds a credential itself: a Latch credential or code, a private key's armour or a service key by
 * its prefix. The Host treats a text file that does as likely to hold a secret. The cookie, header and URL forms are
 * left to `redactSecrets`, so a file that documents `?token=…`, `user:password@` or the `Latch-Device` header is not secret.
 */
export function containsSecret(text: string): boolean {
  return CREDENTIALS.some(pattern => new RegExp(pattern.source, pattern.flags.replace('g', '')).test(text))
}
