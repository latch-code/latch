import { isFileMention } from './file-refs.ts'
import { FILE_KINDS, type FileChange, type FileKind } from './files.ts'
/** Finite file metadata only; paths always stay relative to a stable session folder. */
export function isFileChange(value: unknown): value is FileChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return (
    Object.keys(item).every(key => ['root', 'path', 'change', 'size', 'kind'].includes(key))
    && isFileMention({ root: item.root, path: item.path })
    && typeof item.change === 'string'
    && ['created', 'modified', 'deleted'].includes(item.change)
    && (item.size === undefined || (Number.isSafeInteger(item.size) && Number(item.size) >= 0))
    && (item.kind === undefined || FILE_KINDS.includes(item.kind as FileKind))
  )
}
