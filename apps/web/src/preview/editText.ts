import { FILE_EDIT_LIMIT } from '@latch/protocol'

/**
 * The text of a file the editor takes: UTF-8 (a byte-order mark is dropped, the Host keeps it) without NUL, within the
 * edit limit; undefined otherwise.
 */
export function decodeEditable(bytes: Uint8Array): string | undefined {
  if (bytes.length > FILE_EDIT_LIMIT) return undefined
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
  return text.includes('\u0000') ? undefined : text
}

/** More than one line-ending style (CRLF, LF, CR): the Host does not edit such a file. Same rule as the Host's. */
export function mixedLineEndings(bytes: Uint8Array): boolean {
  let crlf = 0,
    lf = 0,
    cr = 0
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 0x0d) {
      if (bytes[index + 1] === 0x0a) {
        crlf++
        index++
      } else if (index + 1 < bytes.length) cr++
    } else if (bytes[index] === 0x0a) lf++
  }
  return [crlf, lf, cr].filter(count => count > 0).length > 1
}

/** SHA-256 (hex) of the bytes, the base a save names; undefined where the page has no WebCrypto. */
export async function editHash(bytes: Uint8Array): Promise<string | undefined> {
  const subtle = (() => {
    try {
      return globalThis.crypto?.subtle
    } catch {
      return undefined
    }
  })()
  if (!subtle) return undefined
  const digest = await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
