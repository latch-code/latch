// First-party content checks: a file is opened only when its first bytes agree with its extension, so a renamed
// program or a script saved as `.pdf` is refused. No third-party sniffer runs in the Host (they have had loop and
// decompression-bomb advisories); this reads only fixed headers. Mirrored in apps/desktop/src/files.cjs.
import type { ContentFamily } from './kinds.ts'

/** How many leading bytes the checks read. */
export const SNIFF_BYTES = 64 * 1024
const TEXT_WINDOW = 8 * 1024

const ascii = (bytes: Uint8Array, offset: number, text: string) =>
  bytes.length >= offset + text.length && [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0))

/** Valid UTF-8 (a sequence cut off at the window's end allowed) or a UTF-16 byte-order mark, with no NUL byte. */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return true
  const window = bytes.subarray(0, TEXT_WINDOW)
  if (window.includes(0)) return false
  let end = window.length
  // A multi-byte character cut by the window: drop its lead and continuation bytes before decoding.
  if (bytes.length > TEXT_WINDOW) {
    let back = 0
    while (back < 3 && end - back - 1 >= 0 && (window[end - back - 1]! & 0xc0) === 0x80) back++
    if (end - back - 1 >= 0 && window[end - back - 1]! >= 0xc0) end -= back + 1
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(window.subarray(0, end))
    return true
  } catch {
    return false
  }
}

const ISO_BRANDS_HEIC = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'])
/** QuickTime files from before the `ftyp` box start with one of these. */
const QUICKTIME_ATOMS = ['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']

/** Whether `bytes`, the start of a file, look like the given family. */
export function matchesFamily(family: ContentFamily, bytes: Uint8Array): boolean {
  switch (family) {
    case 'zip':
      return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
    case 'pdf':
      // Readers accept the header anywhere in the first 1 KiB; the files Latch opens put it first.
      return ascii(bytes, 0, '%PDF-')
    case 'png':
      return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
    case 'jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    case 'gif':
      return ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')
    case 'webp':
      return ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')
    case 'heic':
      return ascii(bytes, 4, 'ftyp') && ISO_BRANDS_HEIC.has(String.fromCharCode(...bytes.subarray(8, 12)))
    case 'tiff':
      return (
        bytes.length >= 4
        && ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00)
          || (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
      )
    case 'bmp':
      return ascii(bytes, 0, 'BM')
    case 'mp3':
      return ascii(bytes, 0, 'ID3') || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
    case 'aac':
      return ascii(bytes, 0, 'ID3') || ascii(bytes, 0, 'ADIF') || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0)
    case 'flac':
      return ascii(bytes, 0, 'fLaC') || ascii(bytes, 0, 'ID3')
    case 'wav':
      return ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')
    case 'isobmff':
      return ascii(bytes, 4, 'ftyp') || QUICKTIME_ATOMS.some(atom => ascii(bytes, 4, atom))
    case 'text':
      return looksLikeText(bytes)
  }
}
