const DOTENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template'])
const SECRET_NAMES = new Set(['.npmrc', '.pypirc', '.netrc', '.git-credentials'])
const SECRET_EXTENSIONS = ['.pem', '.p12', '.pfx', '.kdbx']

/**
 * Whether a `/`-separated path alone says the file likely holds a secret: `.env` files except the example ones, SSH
 * identities (not `.pub`), key and certificate stores, package-manager and Git credentials, Terraform state,
 * `credentials*.json` and everything under `.aws`, `.ssh`, plus `.kube/config` and `.docker/config.json`.
 */
export function isSecretPathName(path: string): boolean {
  const parts = path.toLowerCase().split('/')
  const name = parts.at(-1) ?? ''
  if (name === '.env' || (name.startsWith('.env.') && !DOTENV_EXAMPLES.has(name))) return true
  if (name.startsWith('id_') && !name.endsWith('.pub')) return true
  if (SECRET_NAMES.has(name) || SECRET_EXTENSIONS.some(ext => name.endsWith(ext))) return true
  if (name.includes('.keychain') || name.includes('.tfstate')) return true
  if (name.startsWith('credentials') && name.endsWith('.json')) return true
  if (parts.includes('.aws') || parts.includes('.ssh')) return true
  const tail = parts.slice(-2).join('/')
  return tail === '.git/config' || tail === '.kube/config' || tail === '.docker/config.json'
}

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
  /**
   * Set only for a file outside the session's folders that its messages named: the folder it is in, as named. `root`
   * is then that one file's own identity and `path` its name as named; there is no folder to list.
   */
  folder?: string
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
  /**
   * `edit`: the Host takes a small text edit of this file from this device (`PUT tasks/:id/files/:handle`); absent from
   * older Hosts and outside a session.
   */
  actions: {
    reveal: boolean
    quicklook: boolean
    open: boolean
    download: boolean
    preview: boolean
    edit?: boolean
    /** 在编辑器中打开 in the desktop app on this Mac; absent from older Hosts. */
    editor?: boolean
  }
  refused?: Record<string, string>
}

/** The largest text file the editor takes, before and after the edit (UTF-8 bytes). */
export const FILE_EDIT_LIMIT = 1024 * 1024

/** `PUT /link/api/tasks/:id/files/:handle`: the person's edit of a file they opened, checked against the version they opened. */
export interface FileEditRequest {
  requestId: string
  /** SHA-256 (hex) of the file's bytes as the editor read them. */
  baseHash: string
  /** The new text; the Host keeps the file's line endings, final newline and byte-order mark. */
  content: string
}

/** What a save did; a retry with the same `requestId` gets the same answer with `replay`. */
export interface FileEditResult {
  requestId: string
  /** SHA-256 of the file's bytes now: the base of the next save. */
  hash: string
  size: number
  /** The file already held exactly this text, so nothing was written. */
  unchanged?: true
  /** The Agent's next turn is told that the person edited this file. */
  noteNextTurn: boolean
  at: string
  replay?: true
}

export interface FileChange {
  kind?: FileKind
  root: string
  path: string
  change: 'created' | 'modified' | 'deleted'
  size?: number
  /** Absent from a complete pre-run folder scan on platforms where `change` stays `modified`. */
  fresh?: true
  /** Matched by `.gitignore` in a Git repository and not tracked by Git. */
  gitIgnored?: true
  /** SHA-256 of a created file's content when recorded at run settlement. */
  sha256?: string
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
    || (value.folder !== undefined && (typeof value.folder !== 'string' || value.folder.length > 4096 || !value.folder.startsWith('/')))
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
  if (value.actions.edit !== undefined && typeof value.actions.edit !== 'boolean') return false
  if (value.actions.editor !== undefined && typeof value.actions.editor !== 'boolean') return false
  for (const key of ['width', 'height'] as const)
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isInteger(value[key]) || value[key] < 1)) return false
  return true
}

/** Fixed-header dimensions only: no pixel decoding. */
export function imageDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } | undefined {
  const at = (offset: number, text: string) =>
    bytes.length >= offset + text.length && [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0,
    height = 0
  if (mime === 'image/png' && bytes.length >= 33 && view.getUint32(8) === 13 && at(12, 'IHDR')) {
    width = view.getUint32(16)
    height = view.getUint32(20)
  } else if (mime === 'image/gif' && bytes.length >= 10) {
    width = view.getUint16(6, true)
    height = view.getUint16(8, true)
  } else if (mime === 'image/bmp' && bytes.length >= 26) {
    width = view.getUint32(14, true) === 12 ? view.getUint16(18, true) : Math.abs(view.getInt32(18, true))
    height = view.getUint32(14, true) === 12 ? view.getUint16(20, true) : Math.abs(view.getInt32(22, true))
  } else if (mime === 'image/webp' && bytes.length >= 30 && at(12, 'VP8X') && view.getUint32(16, true) === 10) {
    width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16)
    height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16)
  } else if (
    mime === 'image/webp'
    && bytes.length >= 30
    && at(12, 'VP8 ')
    && view.getUint32(16, true) >= 10
    && at(23, '\u009d\u0001\u002a')
  ) {
    width = view.getUint16(26, true) & 0x3fff
    height = view.getUint16(28, true) & 0x3fff
  } else if (mime === 'image/webp' && bytes.length >= 25 && at(12, 'VP8L') && view.getUint32(16, true) >= 5 && bytes[20] === 0x2f) {
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
    while (offset + 1 < bytes.length && bytes[offset] === 0xff) {
      while (bytes[offset + 1] === 0xff) offset++
      const marker = bytes[offset + 1]!
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      if (offset + 3 >= bytes.length) break
      const size = view.getUint16(offset + 2)
      if (size < 2 || offset + 2 + size > bytes.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (size < 8) break
        height = view.getUint16(offset + 5)
        width = view.getUint16(offset + 7)
        break
      }
      offset += 2 + size
    }
  }
  return width > 0 && height > 0 ? { width, height } : undefined
}
