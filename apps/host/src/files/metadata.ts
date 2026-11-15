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
