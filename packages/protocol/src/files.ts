/** A file is opened in the session's existing side column. Roots are stable Host IDs, never client-supplied paths. */
export interface FileOpenTarget {
  sessionId: string
  reference: string
  rootId?: string
  line?: number
}

export type FileKind =
  | 'text'
  | 'code'
  | 'markdown'
  | 'image'
  | 'svg'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'pptx'
  | 'docx'
  | 'xlsx'
  | 'csv'
  | 'html'
  | 'binary'

export interface FileMetadata {
  handle: string
  name: string
  root: string
  path: string
  ext: string
  kind: FileKind
  mime: string
  size: number
  mtime: number
  etag: string
  limit: number
  truncated?: true
  secret: boolean
  width?: number
  height?: number
  actions: { reveal: boolean; quicklook: boolean; open: boolean; download: boolean; preview: boolean }
  refused?: Record<string, string>
}

export interface FileChange {
  root: string
  path: string
  change: 'created' | 'modified' | 'deleted'
  size?: number
}

const KINDS: readonly FileKind[] = [
  'text',
  'code',
  'markdown',
  'image',
  'svg',
  'audio',
  'video',
  'pdf',
  'pptx',
  'docx',
  'xlsx',
  'csv',
  'html',
  'binary',
]
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A malformed or older response never becomes a content URL or an executable preview type. */
export function isFileMetadata(value: unknown): value is FileMetadata {
  if (
    !record(value)
    || typeof value.handle !== 'string'
    || !/^[A-Za-z0-9_-]{22}$/u.test(value.handle)
    || typeof value.name !== 'string'
    || value.name.length > 4096
    || typeof value.path !== 'string'
    || value.path.length > 4096
    || typeof value.root !== 'string'
    || !/^[a-zA-Z0-9_-]{1,32}$/u.test(value.root)
    || typeof value.ext !== 'string'
    || typeof value.mime !== 'string'
    || value.mime.length > 128
    || !KINDS.includes(value.kind as FileKind)
    || typeof value.secret !== 'boolean'
    || typeof value.etag !== 'string'
    || !/^"[a-f0-9]{32}"$/u.test(value.etag)
    || !record(value.actions)
  )
    return false
  for (const key of ['size', 'mtime', 'limit'] as const)
    if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || (key !== 'mtime' && value[key] < 0)) return false
  for (const key of ['reveal', 'quicklook', 'open', 'download', 'preview'] as const)
    if (typeof value.actions[key] !== 'boolean') return false
  for (const key of ['width', 'height'] as const)
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isInteger(value[key]) || value[key] < 1)) return false
  return true
}
