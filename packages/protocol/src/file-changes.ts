import { isFileMention } from './file-refs.ts'
import { FILE_KINDS, type FileChange, type FileKind } from './files.ts'
const SHA256_HEX = /^[0-9a-f]{64}$/u
/** Finite file metadata only; paths always stay relative to a stable session folder. */
export function isFileChange(value: unknown): value is FileChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return (
    Object.keys(item).every(key => ['root', 'path', 'change', 'size', 'kind', 'gitIgnored', 'sha256'].includes(key))
    && isFileMention({ root: item.root, path: item.path })
    && typeof item.change === 'string'
    && ['created', 'modified', 'deleted'].includes(item.change)
    && (item.size === undefined || (Number.isSafeInteger(item.size) && Number(item.size) >= 0))
    && (item.kind === undefined || FILE_KINDS.includes(item.kind as FileKind))
    && (item.gitIgnored === undefined || item.gitIgnored === true)
    && (item.sha256 === undefined || (typeof item.sha256 === 'string' && SHA256_HEX.test(item.sha256)))
  )
}
