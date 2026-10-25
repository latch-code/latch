/** Latch's own credentials: device credentials, and invitation and offline enrolment codes. */
const LATCH_CREDENTIALS: readonly RegExp[] = [/ldc1\.dev_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/gu, /lp[io]1-[A-Z2-7]{26}/gu]

/** Where a credential travels: the cookies, the device header and URL parameters, whatever value they carry. */
const CARRIERS: readonly RegExp[] = [
  /(?:harness_link|latch_[a-z2-7]{8}|__Host-latch_[a-z2-7]{8})=[^;\s]+/gu,
  /Latch-Device\s+\S+/gu,
  /#(?:token|pair)=[\w-]+/gu,
  /[?&]token=[\w-]+/gu,
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
const PATTERNS: readonly RegExp[] = [...LATCH_CREDENTIALS, ...CARRIERS, ...KEYS]
/** Credential-shaped text alone: a file that only names a header or a parameter (documentation) holds no secret. */
const CREDENTIALS: readonly RegExp[] = [...LATCH_CREDENTIALS, ...KEYS]

export function redactSecrets(text: string): string {
  let output = String(text)
  for (const pattern of PATTERNS) output = output.replace(pattern, '[redacted]')
  return output
}

/**
 * Whether the text holds a credential itself: a Latch credential or code, a private key's armour or a service key by
 * its prefix. The Host treats a text file that does as likely to hold a secret. The cookie, header and URL-parameter
 * forms are left to `redactSecrets`, so a file that documents `?token=…` or the `Latch-Device` header is not secret.
 */
export function containsSecret(text: string): boolean {
  return CREDENTIALS.some(pattern => new RegExp(pattern.source, pattern.flags.replace('g', '')).test(text))
}
