/**
 * Credential shapes that must never reach a log line. Every Host log line passes through `redactSecrets`.
 * Order matters: whole credentials first, then the cookie and header forms that may carry them.
 */
const PATTERNS: readonly RegExp[] = [
  /ldc1\.dev_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/gu,
  /lp[io]1-[A-Z2-7]{26}/gu,
  /(?:harness_link|latch_[a-z2-7]{8}|__Host-latch_[a-z2-7]{8})=[^;\s]+/gu,
  /Latch-Device\s+\S+/gu,
  /#(?:token|pair)=[\w-]+/gu,
  /[?&]token=[\w-]+/gu,
]

export function redactSecrets(text: string): string {
  let output = String(text)
  for (const pattern of PATTERNS) output = output.replace(pattern, '[redacted]')
  return output
}
