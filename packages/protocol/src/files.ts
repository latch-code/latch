/** A file is opened in the session's existing side column. Roots are stable Host IDs, never client-supplied paths. */
export interface FileOpenTarget {
  view?: 'preview' | 'changes'
  attachmentId?: string
  sessionId: string
  reference: string
  rootId?: string
  line?: number
}

/** A workspace preview has no invented session; the selected harness determines its frozen roots. */
export interface WorkspaceFileOpenTarget {
  workspaceId: string
  harnessId: string
  reference: string
  rootId?: string
  line?: number
}
export type ContextFileOpenTarget = FileOpenTarget | WorkspaceFileOpenTarget
export type FileContext = { kind: 'session'; sessionId: string } | { kind: 'workspace'; workspaceId: string; harnessId: string }
export interface FileDirectoryEntry {
  name: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  mtime: number
}
export interface FileDirectoryListing {
  context: FileContext
  roots: Array<{ id: string; name: string }>
  rootId?: string
  dir?: string
  entries: FileDirectoryEntry[]
  truncated: boolean
}

export function isFileDirectoryListing(value: unknown): value is FileDirectoryListing {
  if (
    !record(value)
    || !record(value.context)
    || !Array.isArray(value.roots)
    || value.roots.length > 8
    || !Array.isArray(value.entries)
    || value.entries.length > 2000
    || typeof value.truncated !== 'boolean'
  )
    return false
  const context = value.context
  const id = (item: unknown): item is string =>
    typeof item === 'string' && item.length > 0 && item.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(item)
  if (
    context.kind === 'session' ? !id(context.sessionId) : context.kind !== 'workspace' || !id(context.workspaceId) || !id(context.harnessId)
  )
    return false
  const rootId = (item: unknown) => typeof item === 'string' && /^[A-Za-z0-9_-]{1,32}$/u.test(item)
  if (
    value.roots.some(root => !record(root) || !rootId(root.id) || !id(root.name))
    || (value.rootId !== undefined && (!rootId(value.rootId) || !value.roots.some(root => record(root) && root.id === value.rootId)))
    || (value.dir !== undefined
      && (typeof value.dir !== 'string'
        || value.dir.length > 4096
        || (value.dir !== '' && !value.dir.split('/').every(part => id(part) && part !== '.' && part !== '..' && !part.includes('\\')))))
  )
    return false
  return value.entries.every(
    entry =>
      record(entry)
      && id(entry.name)
      && !/[\\/]/u.test(entry.name)
      && ['file', 'directory', 'symlink', 'other'].includes(String(entry.kind))
      && Number.isSafeInteger(entry.size)
      && Number(entry.size) >= 0
      && Number.isSafeInteger(entry.mtime),
  )
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
  source?: 'attachment'
  attachmentId?: string
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
  kind?: FileKind
  root: string
  path: string
  change: 'created' | 'modified' | 'deleted'
  size?: number
}

export const FILE_KINDS: readonly FileKind[] = [
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
    || (value.source !== undefined && value.source !== 'attachment')
    || (value.source === 'attachment'
      ? typeof value.attachmentId !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(value.attachmentId)
      : value.attachmentId !== undefined)
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
    || !FILE_KINDS.includes(value.kind as FileKind)
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
