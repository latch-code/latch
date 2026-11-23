// What a link target in a reply is. Only web and mail addresses are links; a footnote jumps inside the reply; every
// file reference (a relative path, ../, an absolute path, a file:// URI) becomes a path chip that never navigates the
// page. Anything else is plain text.
import { FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileVideo, Presentation } from 'lucide-react'
import { FileGlyph, FolderGlyph, PageGlyph } from '@latch/ui'
import type { IconComponent } from '@latch/ui'

export type LinkTarget =
  | { kind: 'web' }
  | { kind: 'mail' }
  /** A footnote of this reply (the prefix Markdown rendering gave its ids). */
  | { kind: 'anchor' }
  /** A file reference: `path` is what the reader sees, copies, and the desktop app hands to the Host. */
  | { kind: 'path'; path: string }
  | { kind: 'text' }

const CONTROL = /[\u0000-\u001f\u007f]/u
const SCHEME = /^([a-z][a-z\d+.-]*):/iu
/** Schemes that stay schemes even when digits follow them (`tel:123`, `javascript:1`). */
const KNOWN_SCHEMES = new Set(['javascript', 'vbscript', 'data', 'blob', 'about', 'tel', 'sms', 'file', 'http', 'https', 'mailto'])

/**
 * The URL scheme a link target starts with, lowercased; undefined when it has none. A file name with a line number
 * looks like one but is a path: a "scheme" with a dot (`report.md:12`), or one followed only by a line and column
 * (`Makefile:12`, `main:42:5`), is not a scheme.
 */
export function urlScheme(target: string): string | undefined {
  const match = SCHEME.exec(target)
  if (!match) return undefined
  const name = match[1]!.toLowerCase()
  if (KNOWN_SCHEMES.has(name)) return name
  if (name.includes('.') || /^\d+(?::\d+)?(?:$|[?#])/u.test(target.slice(match[0].length))) return undefined
  return name
}

/**
 * The path a link target names, as the reader should see it: a file:// URI becomes its absolute path, percent escapes
 * are decoded, and a query or a fragment is dropped (a `#L12` line fragment stays). Undefined when it is no path.
 */
export function referenceText(target: string): string | undefined {
  let text = target.trim()
  if (!text || text.startsWith('//')) return undefined
  const scheme = urlScheme(text)
  if (scheme === 'file') {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return undefined
    }
    if (url.hostname !== '' && url.hostname !== 'localhost') return undefined
    text = url.pathname + (/^#L\d+(?:C\d+)?$/u.test(url.hash) ? url.hash : '')
  } else if (scheme !== undefined) {
    return undefined
  } else {
    const fragment = text.indexOf('#')
    if (fragment >= 0 && !/^#L\d+(?:C\d+)?$/u.test(text.slice(fragment))) text = text.slice(0, fragment)
    const query = text.indexOf('?')
    if (query >= 0) text = text.slice(0, query)
  }
  try {
    text = decodeURIComponent(text)
  } catch {
    /* Keep the text as written; the Host refuses what it cannot read. */
  }
  if (!text.trim() || CONTROL.test(text)) return undefined
  return text
}

/** What a link in a reply does. `anchorPrefix` is the prefix the reply's own footnote ids carry. */
export function linkTarget(href: string, anchorPrefix?: string): LinkTarget {
  const value = href.trim()
  const scheme = urlScheme(value)
  if (scheme === 'http' || scheme === 'https') return { kind: 'web' }
  if (scheme === 'mailto') return { kind: 'mail' }
  if (value.startsWith('#'))
    return anchorPrefix !== undefined && anchorPrefix !== '' && value.startsWith(`#${anchorPrefix}`) ? { kind: 'anchor' } : { kind: 'text' }
  // A web host written without its scheme is not a file, and Latch does not guess the scheme for it.
  if (scheme === undefined && /^www\./iu.test(value)) return { kind: 'text' }
  const path = referenceText(value)
  return path === undefined ? { kind: 'text' } : { kind: 'path', path }
}

/** Characters a path in inline code does not carry: spaces, quotes, shell and code punctuation. */
const NOT_A_PATH = /[\s\\"'<>|*?$`{}=;,()[\]]/u

/**
 * The path inline code names, when it looks like one: no spaces or code punctuation, and a last segment with an
 * extension that has a letter in it (`deck.pptx`, `src/app.ts:12`, `out/q1.png#L3`), so `v1.2.3`, `e.g.` and
 * `npm run build` stay code. Whether it is a file is the Host's answer; this only chooses what to ask about.
 */
export function codePathCandidate(text: string): string | undefined {
  if (text.length < 3 || text.length > 512 || NOT_A_PATH.test(text) || CONTROL.test(text)) return undefined
  const scheme = urlScheme(text)
  if (scheme !== undefined && scheme !== 'file') return undefined
  const path = referenceText(text)
  if (path === undefined) return undefined
  const name = referenceName(path)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1) : ''
  return /^[A-Za-z0-9]{1,10}$/u.test(ext) && /[A-Za-z]/u.test(ext) ? path : undefined
}

/** Whether a link's text is its path written another way (`site/a.html` for `./site/a.html`) or its file name. */
export function namesPath(text: string, path: string): boolean {
  const bare = (value: string) => value.replace(/^(?:\.\/)+/u, '')
  return text === path || bare(text) === bare(path) || path.endsWith(`/${bare(text)}`) || text === referenceName(path)
}

/** The path without a trailing `:12`, `:12:4` or `#L12` position. */
export function withoutPosition(path: string): string {
  return path.replace(/(?:#L\d+(?:C\d+)?|:\d+(?::\d+)?)$/u, '')
}

/** The path's last segment, without a `:12` or `#L12` position (what a file is called). */
export function referenceName(path: string): string {
  const bare = withoutPosition(path).replace(/\/+$/u, '')
  return bare.slice(bare.lastIndexOf('/') + 1) || bare
}

/**
 * The path to copy on the computer that runs Latch: a reference relative to the session's folder joined to it and
 * normalised by its spelling (`./`, `../`), without a position, so Finder's 「前往文件夹」 or a terminal takes it. An
 * absolute or `~/` reference is kept; without the folder a relative one stays as written.
 */
export function absoluteReference(path: string, folder: string | undefined): string {
  const bare = withoutPosition(path.trim())
  if (bare.startsWith('/') || bare.startsWith('~/') || !folder?.startsWith('/')) return bare
  const parts: string[] = []
  for (const part of `${folder}/${bare}`.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}${bare.endsWith('/') ? '/' : ''}`
}

/**
 * A path label split before its last segment, so the folders can shrink with an ellipsis and the file name stays
 * whole: `/Users/me/acme/out/` and `deck.pptx`. A label without a folder has an empty first part.
 */
export function splitPath(text: string): [folders: string, name: string] {
  const slash = text.lastIndexOf('/', text.length - 2)
  return slash < 0 ? ['', text] : [text.slice(0, slash + 1), text.slice(slash + 1)]
}

const ICONS: Array<[RegExp, IconComponent]> = [
  [/^(?:png|jpe?g|gif|webp|heic|avif|bmp|tiff?|ico|svg)$/u, FileImage],
  [/^(?:mp4|mov|m4v|webm|mkv|avi)$/u, FileVideo],
  [/^(?:mp3|m4a|wav|aac|flac|ogg|opus)$/u, FileAudio],
  [/^(?:xlsx?|csv|tsv|numbers)$/u, FileSpreadsheet],
  [/^(?:pptx?|key)$/u, Presentation],
  [/^(?:pdf|docx?|pages|md|markdown|txt|rtf|log)$/u, FileGlyph],
  [/^(?:zip|tar|gz|tgz|bz2|xz|7z|rar)$/u, FileArchive],
  [
    /^(?:ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|bash|css|scss|html?|xml|sql|ipynb)$/u,
    FileCode,
  ],
]

/** Folders keep their glyph; the caller may give particular file formats a more specific mark. */
export function referenceIcon(path: string, formats?: ReadonlyMap<string, IconComponent>): IconComponent {
  if (path.trim().endsWith('/')) return FolderGlyph
  const name = referenceName(path)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return formats?.get(ext) ?? ICONS.find(([pattern]) => pattern.test(ext))?.[1] ?? PageGlyph
}
