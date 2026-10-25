import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { isFileMention, type TaskDetail } from '@latch/protocol'
import { parseReference, type FileRoot, type ResolvedFile } from './resolve.ts'

const PATH_KEYS = ['path', 'file', 'file_path', 'filePath']

/** Keeps path and folder fields when a long message is scanned in pieces. */
export function referenceInput(input: string | undefined): string | undefined {
  if (!input) return undefined
  try {
    const value: unknown = JSON.parse(input)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const fields = Object.fromEntries(
      Object.entries(value).filter(
        ([key, text]) => (key === 'folder' || PATH_KEYS.includes(key)) && typeof text === 'string' && text.length <= 4096,
      ),
    )
    return JSON.stringify(fields)
  } catch {
    return undefined
  }
}

/** Extracts only paths mentioned in Host-recorded messages, respecting each tool call's selected folder. */
export function sessionReferences(detail: TaskDetail, roots: readonly FileRoot[], home: string, budget = 4 * 1024 * 1024): Set<string> {
  const found = new Set<string>()
  const add = (text: string, rootId?: string) => {
    if (found.size >= 10_000) return
    const value = parseReference(text, home)
    if (!value || roots.length === 0) return
    const primary = rootId === undefined ? roots[0] : roots.find(root => root.id === rootId)
    if (!isAbsolute(value.path) && !primary) return
    const path = isAbsolute(value.path) ? normalize(value.path) : resolve(primary!.path, value.path)
    for (const root of roots) {
      const rel = relative(root.path, path)
      if (rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) found.add(`${root.id}\n${rel.split(sep).join('/')}`)
    }
  }
  const scan = (text: string | undefined, rootId?: string) => {
    if (!text || budget <= 0 || found.size >= 10_000) return
    const window = text.slice(0, budget)
    budget -= window.length
    // Quoted references preserve spaces. Bare references require a slash or an extension.
    for (const match of window.matchAll(
      /`([^`\n]{1,4096})`|\]\(([^\n)]{1,4096})\)|(?:^|[\s"'=:(])((?:file:\/\/|\.{0,2}\/|~\/)[^\s"'<>`{}\[\]]+|[^\s"'<>`{}\[\]():=,;]+\.[a-zA-Z][\w-]*(?::\d+(?::\d+)?)?)/gu,
    ))
      add(match[1] ?? match[2] ?? match[3] ?? '', rootId)
  }
  const outputRefs = (files: TaskDetail['messages'][number]['outputs']) => {
    for (const ref of (files ?? []).slice(0, 1000)) {
      if (!isFileMention({ root: ref.root, path: ref.path }) || budget < ref.path.length || found.size >= 10_000) continue
      budget -= ref.path.length
      if (roots.some(root => root.id === ref.root)) found.add(`${ref.root}\n${ref.path}`)
    }
  }
  if (detail.fileChanges?.runId === detail.summary.runId) outputRefs(detail.fileChanges?.files)
  // Newest messages take precedence when a very long history reaches the bounded scan budget.
  for (const message of detail.messages.toReversed()) {
    outputRefs(message.outputs)
    for (const ref of (message.fileRefs ?? []).slice(0, 32)) {
      if (!isFileMention(ref) || budget < ref.path.length || found.size >= 10_000) continue
      budget -= ref.path.length
      if (roots.some(root => root.id === ref.root)) found.add(`${ref.root}\n${ref.path}`)
    }
    const input: Record<string, string> = JSON.parse(referenceInput(message.tool?.input) ?? '{}')
    const folder = input.folder
    for (const key of PATH_KEYS) if (input[key]) add(input[key], folder)
    for (const location of message.tool?.locations ?? []) add(location, folder)
    for (const diff of message.tool?.diffs ?? []) add(diff.path, folder)
    scan(message.text, folder)
    scan(message.tool?.input, folder)
    scan(message.tool?.output, folder)
  }
  return found
}

export const isReferenced = (references: ReadonlySet<string>, file: ResolvedFile) => references.has(`${file.rootId}\n${file.relativePath}`)

export function isReferenceListed(input: string, references: ReadonlySet<string>, roots: readonly FileRoot[], home: string): boolean {
  const value = parseReference(input, home)
  if (!value || !roots[0]) return false
  const path = isAbsolute(value.path) ? normalize(value.path) : resolve(roots[0].path, value.path)
  return roots.some(root => {
    const rel = relative(root.path, path)
    return (
      rel !== ''
      && !isAbsolute(rel)
      && rel !== '..'
      && !rel.startsWith(`..${sep}`)
      && references.has(`${root.id}\n${rel.split(sep).join('/')}`)
    )
  })
}
