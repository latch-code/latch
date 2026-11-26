import {
  isFileMetadata,
  isFileMention,
  type FileChange,
  type FileContext,
  type FileDirectoryListing,
  type FileMetadata,
  type FileMention,
} from '@latch/protocol'
import { api, MessageError } from '../core/api.ts'
import { defineCopy } from '../core/i18n.ts'
import { fileContextBody, fileRoute } from './fileContext.ts'

const COPY = defineCopy(
  { invalid: '文件引用无效。', unavailable: '文件已变化或无法读取，请刷新文件树后重试。' },
  { invalid: 'Invalid file reference.', unavailable: 'The file changed or can’t be read. Refresh the file tree and try again.' },
)

/** The name of the only entry, when it is a folder and the listing is whole. */
export function soleFolder(listing: FileDirectoryListing | undefined): string | undefined {
  const [only, ...rest] = listing?.entries ?? []
  return only?.kind === 'directory' && rest.length === 0 && !listing?.truncated ? only.name : undefined
}

export const treeKey = (root: string, path: string): string => JSON.stringify([root, path])
export function resolvedFolder(value: unknown): FileMention | undefined {
  if (isFileMention(value)) return value
  if (
    value
    && typeof value === 'object'
    && 'path' in value
    && value.path === ''
    && 'root' in value
    && typeof value.root === 'string'
    && /^[A-Za-z0-9_-]{1,32}$/u.test(value.root)
  )
    return { root: value.root, path: '' }
  return undefined
}
export function treeLocation(key: string): FileMention | undefined {
  try {
    const value: unknown = JSON.parse(key)
    if (!Array.isArray(value) || value.length !== 2) return
    return resolvedFolder({ root: value[0], path: value[1] })
  } catch {
    return undefined
  }
}
export function treeChanges(changes: readonly FileChange[]): ReadonlySet<string> {
  return new Set(
    changes
      .slice(0, 1000)
      .filter(file => isFileMention({ root: file.root, path: file.path }))
      .map(file => treeKey(file.root, file.path)),
  )
}

/** Roots are the Host's frozen context; a relative label is never turned into a guessed absolute path. */
export function treeFullPath(
  file: Pick<FileMetadata, 'root' | 'path'>,
  folders?: readonly { id: string; path: string }[],
  cwd?: string,
): string | undefined {
  if (!isFileMention({ root: file.root, path: file.path })) return
  const base = folders?.length ? folders.find(folder => folder.id === file.root)?.path : cwd
  if (!base || base.length > 4096 || /[\u0000-\u001f\u007f]/u.test(base) || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(base)) return
  const separator = base.startsWith('/') ? '/' : '\\'
  return base.replace(/[\\/]+$/u, '') + separator + file.path.replaceAll('/', separator)
}

/** Resolve again at action time; tree names and old handles are never native-action authority. */
export async function readTreeFile(context: FileContext, target: FileMention, signal: AbortSignal): Promise<FileMetadata> {
  if (!isFileMention(target)) throw new MessageError(COPY.invalid)
  signal.throwIfAborted()
  const result = await api<{ files?: Array<{ status?: string; file?: unknown }> }>(fileRoute(context, 'resolve'), {
    method: 'POST',
    body: { ...fileContextBody(context), paths: [target.path], rootId: target.root },
    signal,
  })
  signal.throwIfAborted()
  const entry = result.files?.[0]
  if (
    result.files?.length !== 1
    || entry?.status !== 'ok'
    || !isFileMetadata(entry.file)
    || entry.file.source === 'attachment'
    || entry.file.root !== target.root
    || entry.file.path !== target.path
  )
    throw new MessageError(COPY.unavailable)
  return entry.file
}
export interface FileTreeView {
  expanded: readonly string[]
  selected?: string
  showHidden: boolean
  /** The person explicitly asked to locate the selected folder. Consumed by the mounted tree. */
  reveal?: true
}

export const TREE_BRANCH_LIMIT = 32

/** Open the folder and its parents first, preserving other expanded rows within the tree's limit. */
export function viewOfFolder(root: string, path: string, previous?: FileTreeView): FileTreeView {
  const folders = [treeKey(root, '')]
  let dir = ''
  for (const name of path ? path.split('/') : []) {
    dir = dir ? `${dir}/${name}` : name
    folders.push(treeKey(root, dir))
  }
  return {
    expanded: [...new Set([...folders, ...(previous?.expanded ?? [])])].slice(0, TREE_BRANCH_LIMIT),
    selected: treeKey(root, path),
    showHidden: previous?.showHidden ?? false,
    reveal: true,
  }
}
