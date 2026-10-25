import type { FileKind } from '@latch/protocol'
import { sha256Hex } from '@latch/core/node-kit'
import type { ResolvedFile } from './resolve.ts'
import { looksLikeText, matchesFamily } from './sniff.ts'

const MIB = 1024 * 1024
const TEXT_KINDS = new Set<FileKind>(['text', 'code', 'markdown', 'csv', 'html', 'svg'])
const CODE = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'yaml',
  'yml',
  'toml',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'php',
  'sh',
  'zsh',
  'bash',
  'css',
  'scss',
  'xml',
  'sql',
])
const ascii = (bytes: Uint8Array, offset: number, text: string) =>
  bytes.length >= offset + text.length && [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0))

/** Only browser-decoded media gets its real MIME. Documents are always served as attachment bytes. */
export function fileFormat(file: Pick<ResolvedFile, 'head' | 'ext'>): { kind: FileKind; mime: string } {
  const bytes = file.head
  for (const [family, mime] of [
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['bmp', 'image/bmp'],
  ] as const)
    if (matchesFamily(family, bytes)) return { kind: 'image', mime }
  if (ascii(bytes, 0, '\u0000\u0000\u0001\u0000')) return { kind: 'image', mime: 'image/x-icon' }
  if (ascii(bytes, 4, 'ftyp') && ['avif', 'avis'].includes(String.fromCharCode(...bytes.subarray(8, 12))))
    return { kind: 'image', mime: 'image/avif' }
  if (matchesFamily('pdf', bytes)) return { kind: 'pdf', mime: 'application/octet-stream' }
  if (matchesFamily('zip', bytes))
    return {
      kind: file.ext === 'pptx' || file.ext === 'docx' || file.ext === 'xlsx' ? file.ext : 'binary',
      mime: 'application/octet-stream',
    }
  if (matchesFamily('wav', bytes)) return { kind: 'audio', mime: 'audio/wav' }
  if (matchesFamily('flac', bytes)) return { kind: 'audio', mime: 'audio/flac' }
  if (ascii(bytes, 0, 'OggS')) return { kind: 'audio', mime: 'audio/ogg' }
  if (matchesFamily('isobmff', bytes))
    return { kind: file.ext === 'm4a' ? 'audio' : 'video', mime: file.ext === 'm4a' ? 'audio/mp4' : 'video/mp4' }
  if (ascii(bytes, 0, '\u001aE\u00df\u00a3')) return { kind: 'video', mime: 'video/webm' }
  if (matchesFamily('mp3', bytes)) return { kind: 'audio', mime: 'audio/mpeg' }
  if (looksLikeText(bytes)) {
    const kind =
      file.ext === 'svg'
        ? 'svg'
        : ['md', 'markdown'].includes(file.ext)
          ? 'markdown'
          : ['html', 'htm'].includes(file.ext)
            ? 'html'
            : ['csv', 'tsv'].includes(file.ext)
              ? 'csv'
              : CODE.has(file.ext)
                ? 'code'
                : 'text'
    return { kind, mime: kind === 'svg' ? 'image/svg+xml' : 'application/octet-stream' }
  }
  return { kind: 'binary', mime: 'application/octet-stream' }
}

/** The file identity is rechecked when opening its descriptor. This tag changes on atomic replacement too. */
export const fileEtag = (file: ResolvedFile) =>
  `"${sha256Hex(`${file.rootId}\n${file.relativePath}\n${file.identity ?? `${file.size}:${file.mtimeMs}`}`).slice(0, 32)}"`

export function contentLimit(kind: FileKind, local: boolean): number {
  switch (kind) {
    case 'text':
    case 'code':
      return (local ? 10 : 2) * MIB
    case 'markdown':
      return (local ? 10 : 2) * MIB
    case 'svg':
      return (local ? 2 : 1) * MIB
    case 'image':
      return (local ? 50 : 20) * MIB
    case 'pdf':
      return (local ? 500 : 100) * MIB
    case 'pptx':
    case 'docx':
      return (local ? 50 : 25) * MIB
    case 'xlsx':
      return (local ? 50 : 20) * MIB
    case 'csv':
      return (local ? 50 : 10) * MIB
    case 'html':
      return (local ? 5 : 2) * MIB
    case 'audio':
    case 'video':
      return local ? Number.MAX_SAFE_INTEGER : 200 * MIB
    case 'binary':
      return (local ? 50 : 20) * MIB
  }
}

export const canTruncate = (kind: FileKind) => TEXT_KINDS.has(kind) && kind !== 'csv' && kind !== 'html' && kind !== 'svg'

/** Fixed-header dimensions only: bounded reads, no image parser in the process holding credentials. */
export function imageDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0,
    height = 0
  if (mime === 'image/png' && bytes.length >= 24) {
    width = view.getUint32(16)
    height = view.getUint32(20)
  } else if (mime === 'image/gif' && bytes.length >= 10) {
    width = view.getUint16(6, true)
    height = view.getUint16(8, true)
  } else if (mime === 'image/bmp' && bytes.length >= 26) {
    width = view.getUint32(14, true) === 12 ? view.getUint16(18, true) : Math.abs(view.getInt32(18, true))
    height = view.getUint32(14, true) === 12 ? view.getUint16(20, true) : Math.abs(view.getInt32(22, true))
  } else if (mime === 'image/webp' && bytes.length >= 30 && ascii(bytes, 12, 'VP8X')) {
    width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16)
    height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16)
  } else if (mime === 'image/webp' && bytes.length >= 30 && ascii(bytes, 12, 'VP8 ') && ascii(bytes, 23, '\u009d\u0001\u002a')) {
    width = view.getUint16(26, true) & 0x3fff
    height = view.getUint16(28, true) & 0x3fff
  } else if (mime === 'image/webp' && bytes.length >= 25 && ascii(bytes, 12, 'VP8L') && bytes[20] === 0x2f) {
    const bits = view.getUint32(21, true)
    width = 1 + (bits & 0x3fff)
    height = 1 + ((bits >>> 14) & 0x3fff)
  } else if (mime === 'image/x-icon' && bytes.length >= 22) {
    const count = Math.min(view.getUint16(4, true), Math.floor((bytes.length - 6) / 16), 1024)
    for (let index = 0; index < count; index++) {
      const w = bytes[6 + 16 * index] || 256
      const h = bytes[7 + 16 * index] || 256
      if (w * h > width * height) {
        width = w
        height = h
      }
    }
  } else if (mime === 'image/jpeg') {
    let offset = 2
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) break
      const marker = bytes[offset + 1]!
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      const size = view.getUint16(offset + 2)
      if (size < 2 || offset + 2 + size > bytes.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = view.getUint16(offset + 5)
        width = view.getUint16(offset + 7)
        break
      }
      offset += 2 + size
    }
  }
  return width > 0 && height > 0 ? { width, height } : undefined
}
