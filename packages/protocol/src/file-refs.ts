/** An explicit file choice; paths are relative to stable Host roots, never client supplied absolute directories. */
export interface FileMention {
  root: string
  path: string
}
export function isFileMention(value: unknown): value is FileMention {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return (
    Object.keys(item).every(key => key === 'root' || key === 'path')
    && typeof item.root === 'string'
    && /^[A-Za-z0-9_-]{1,32}$/u.test(item.root)
    && typeof item.path === 'string'
    && item.path.length > 0
    && item.path.length <= 4096
    && !/[\\\u0000-\u001f\u007f]/u.test(item.path)
    && !item.path.startsWith('/')
    && !/^[A-Za-z]:/u.test(item.path)
    && item.path.split('/').every(part => part !== '.' && part !== '..' && part.length > 0)
  )
}
/** Model context only. The visible message remains exactly what the person typed. */
export function fileMentionContext(prompt: string, refs: readonly FileMention[], roots: readonly { id: string; path: string }[]): string {
  if (!refs.length) return prompt
  if (
    refs.length > 32
    || new Set(refs.map(ref => JSON.stringify(ref))).size !== refs.length
    || refs.some(ref => !isFileMention(ref) || !roots.some(root => root.id === ref.root))
  )
    throw new Error('file-reference-invalid')
  return `${prompt}\n\n[用户选择的文件引用]\n${refs.map(ref => `${ref.root}: ${roots.find(root => root.id === ref.root)!.path.replace(/\/+$/u, '')}/${ref.path}`).join('\n')}`
}
