/**
 * The 新内容哈希 next to a write diff: SHA-256 of the new text in the form the Host's local confirmation shows, so the
 * owner can check that the text read here is the text the confirmation window binds. It is computed with WebCrypto
 * after rendering; without WebCrypto (an insecure origin) the line is left out.
 */

export const CONTENT_HASH_LABEL = '新内容哈希'

/** First 16 hex characters as 'xxxx-xxxx-xxxx-xxxx', exactly like the Host's `hashDisplay`. */
export function hashDisplay(hexHash: string): string {
  if (!/^[0-9a-f]{16,}$/.test(hexHash)) throw new TypeError('hashDisplay: expected lowercase hex')
  return hexHash.slice(0, 16).match(/.{4}/g)!.join('-')
}

/** ACP clips each diff side and appends this line, so a hash of that text would not describe the written file. */
const CLIPPED_SUFFIX = '\n…（内容过长，已截断）'

/** WebCrypto's digest, or null where the page has none. */
export function contentHashCrypto(): SubtleCrypto | null {
  try {
    return globalThis.crypto?.subtle ?? null
  } catch {
    return null
  }
}

/** Whether `text` gets a hash line: WebCrypto is present and the text is not a clipped copy. */
export function hashable(text: string, subtle: SubtleCrypto | null = contentHashCrypto()): boolean {
  return subtle !== null && !text.endsWith(CLIPPED_SUFFIX)
}

/** Recent results, so a diff opened again shows its hash in the first render. */
const recent = new Map<string, string>()
const RECENT_LIMIT = 16

export function knownContentHash(text: string): string | undefined {
  return recent.get(text)
}

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

/** The displayed SHA-256 of `text` as UTF-8, or undefined when WebCrypto is missing or fails. */
export async function contentHash(text: string, subtle: SubtleCrypto | null = contentHashCrypto()): Promise<string | undefined> {
  const known = recent.get(text)
  if (known !== undefined) return known
  if (subtle === null) return undefined
  try {
    const display = hashDisplay(hex(new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)))))
    recent.set(text, display)
    if (recent.size > RECENT_LIMIT) recent.delete(recent.keys().next().value!)
    return display
  } catch {
    return undefined
  }
}
