import { isFileMetadata, isFileMention, type FileChange, type FileContext, type FileMetadata, type FileMention } from '@latch/protocol'
import { api } from '../core/api.ts'
import { fileContextBody, fileRoute } from './fileContext.ts'

export const treeKey = (root: string, path: string): string => JSON.stringify([root, path])
export function treeLocation(key: string): FileMention | undefined {
  try {
    const value: unknown = JSON.parse(key)
    if (!Array.isArray(value) || value.length !== 2) return
    const mention = { root: value[0], path: value[1] }
    if (mention.path === '' && typeof mention.root === 'string' && /^[A-Za-z0-9_-]{1,32}$/u.test(mention.root))
      return { root: mention.root, path: '' }
    return isFileMention(mention) ? mention : undefined
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
  if (!isFileMention(target)) throw new Error('文件引用无效。')
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
    throw new Error('文件已变化或无法读取，请刷新文件树后重试。')
  return entry.file
}
export interface FileTreeView {
  expanded: readonly string[]
  selected?: string
  showHidden: boolean
}
