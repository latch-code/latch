// What Latch lets the desktop app do with a file of each type: show it in Finder (any regular file), preview it with
// the system's Quick Look, or open it with the default application. The type is the real path's extension, and the
// file's first bytes must agree with it (see sniff.ts). The lists mirror apps/desktop/src/files.cjs, which checks
// again in the main process; change both together.

/** How the first bytes of a file of that extension must look. */
export type ContentFamily =
  | 'zip'
  | 'pdf'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'heic'
  | 'tiff'
  | 'bmp'
  | 'mp3'
  | 'aac'
  | 'flac'
  | 'wav'
  | 'isobmff'
  | 'text'

export const FAMILY_OF: Readonly<Record<string, ContentFamily>> = Object.freeze({
  pdf: 'pdf',
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
  heic: 'heic',
  tif: 'tiff',
  tiff: 'tiff',
  bmp: 'bmp',
  mp3: 'mp3',
  m4a: 'isobmff',
  wav: 'wav',
  aac: 'aac',
  flac: 'flac',
  mp4: 'isobmff',
  mov: 'isobmff',
  m4v: 'isobmff',
  docx: 'zip',
  pptx: 'zip',
  xlsx: 'zip',
  key: 'zip',
  pages: 'zip',
  numbers: 'zip',
  csv: 'text',
  tsv: 'text',
  txt: 'text',
  md: 'text',
  json: 'text',
  log: 'text',
  yaml: 'text',
  yml: 'text',
  ipynb: 'text',
})

/**
 * Quick Look (macOS) hands the file to whatever previewer the system has for its type: Apple's own, or a preview
 * extension another app installed (WPS Office, for one, takes Markdown), and it starts no application. So it takes only
 * types whose content cannot point at the network. Office documents (linked pictures, linked workbooks) and Markdown
 * (images by URL) stay out until a check in the preview panel shows the previewer fetches nothing they link to
 * (`PREVIEW_UNVERIFIED`); they can still be opened with the default application.
 */
export const QUICK_LOOK_TYPES: ReadonlySet<string> = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'heic',
  'tif',
  'tiff',
  'bmp',
  'mp3',
  'm4a',
  'wav',
  'aac',
  'flac',
  'mp4',
  'mov',
  'm4v',
  'key',
  'pages',
  'numbers',
  'csv',
  'tsv',
  'txt',
  'json',
  'log',
])

/** Types kept out of Quick Look only because nobody has yet shown the previewer leaves their linked resources alone. */
export const PREVIEW_UNVERIFIED: ReadonlySet<string> = new Set(['docx', 'pptx', 'xlsx', 'md'])

export const OPEN_TYPES: ReadonlySet<string> = new Set([...QUICK_LOOK_TYPES, ...PREVIEW_UNVERIFIED, 'yaml', 'yml', 'ipynb'])

/**
 * Files an editor opens as a project or workspace rather than as text (its settings and tasks come with it): never
 * handed to an editor. Mirrors apps/desktop/src/editors.cjs.
 */
export const EDITOR_REFUSED_TYPES: ReadonlySet<string> = new Set([
  'code-workspace',
  'sublime-project',
  'sublime-workspace',
  'ipr',
  'iws',
  'iml',
])

/** The `ext` values an audit record may carry: an allowed type, `other` or `none` (no extension). */
export const AUDIT_FILE_TYPES: readonly [string, ...string[]] = ['other', 'none', ...OPEN_TYPES]

/** The lowercased extension of a file name without its dot; '' when it has none (`Makefile`, `.env`). */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 || dot === name.length - 1 ? '' : name.slice(dot + 1).toLowerCase()
}

export function auditType(ext: string): string {
  if (ext === '') return 'none'
  return OPEN_TYPES.has(ext) ? ext : 'other'
}
