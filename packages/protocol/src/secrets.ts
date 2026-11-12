/**
 * Credential-shaped text, shared by the Host's log redaction and secret checks and by the page, which keeps a draft
 * holding one out of browser storage. Pure regular expressions, so every side tests the same shapes.
 */

/** Latch's own credentials: device credentials, invitation and offline enrolment codes, and model gateway tokens. */
export const LATCH_CREDENTIALS: readonly RegExp[] = [
  /lnw1\.[A-Za-z0-9_-]{43}/gu,
  /lnp1\.[A-Za-z0-9_-]{43}/gu,
  /(?:lrt1|lrs1|lnd1)\.[A-Za-z0-9_-]{43}/gu,
  /LATCHPAIR2\.[A-Za-z0-9_-]{32,512}/gu,
  /\/pair#2\.[A-Za-z0-9_-]{32,512}/gu,
  /LATCHBOOK1\.[A-Za-z0-9_-]{32,90000}/gu,
  /ldc1\.dev_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/gu,
  /lp[io]1-[A-Z2-7]{26}/gu,
  /lmg1\.[A-Za-z0-9_-]{43}/gu,
]

/** Where a credential travels: the cookies, the device header, URL parameters and userinfo, whatever value they carry. */
export const CREDENTIAL_CARRIERS: readonly RegExp[] = [
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
export const CREDENTIAL_KEYS: readonly RegExp[] = [
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
 * Whether the text holds a credential itself: a Latch credential or code, a private key's armour or a service key by
 * its prefix. Cookie, header and URL forms that only name a carrier do not count.
 */
export function containsSecret(text: string): boolean {
  return [...LATCH_CREDENTIALS, ...CREDENTIAL_KEYS].some(pattern => new RegExp(pattern.source, pattern.flags.replace('g', '')).test(text))
}

/**
 * Whether the text holds anything Host logs would redact (`redactSecrets`): the credentials above and also where one
 * travels (a cookie, the device header, `?token=`, URL `user:pass@`). A draft that does stays out of browser storage.
 */
export function looksSecret(text: string): boolean {
  return [...LATCH_CREDENTIALS, ...CREDENTIAL_CARRIERS, ...CREDENTIAL_KEYS].some(pattern =>
    new RegExp(pattern.source, pattern.flags.replace('g', '')).test(text),
  )
}
