import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { isFileMention, type TaskDetail } from '@latch/protocol'
import { parseReference, type FileRoot, type ResolvedFile } from './resolve.ts'
import { outsideKey } from './outside.ts'

const PATH_KEYS = ['path', 'file', 'file_path', 'filePath']
/** Folder references and outside ones are bounded apart, so a flood of absolute paths in tool output never crowds out the other. */
export const FOLDER_REFERENCE_LIMIT = 10_000
export const OUTSIDE_REFERENCE_LIMIT = 2_000
export const isOutsideKey = (key: string) => key.startsWith('@\n')

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

/**
 * Extracts only paths mentioned in Host-recorded messages, respecting each tool call's selected folder. A path written
 * as absolute (or `~/`, `file:`) outside every folder is kept as an outside key (`outsideKey`); a relative one that
 * climbs out of its folder is not.
 */
export function sessionReferences(detail: TaskDetail, roots: readonly FileRoot[], home: string, budget = 4 * 1024 * 1024): Set<string> {
  const found = new Set<string>()
  let folders = 0,
    outsides = 0
  const full = () => folders >= FOLDER_REFERENCE_LIMIT && outsides >= OUTSIDE_REFERENCE_LIMIT
  const keep = (key: string) => {
    if (found.has(key)) return
    if (isOutsideKey(key) ? outsides >= OUTSIDE_REFERENCE_LIMIT : folders >= FOLDER_REFERENCE_LIMIT) return
    found.add(key)
    if (isOutsideKey(key)) outsides++
    else folders++
  }
  const add = (text: string, rootId?: string) => {
    if (full()) return
    const value = parseReference(text, home)
    if (!value) return
    const primary = rootId === undefined ? roots[0] : roots.find(root => root.id === rootId)
    if (!isAbsolute(value.path) && !primary) return
    const path = isAbsolute(value.path) ? normalize(value.path) : resolve(primary!.path, value.path)
    let inside = false
    for (const root of roots) {
      const rel = relative(root.path, path)
      if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) continue
      inside = true
      keep(`${root.id}\n${rel.split(sep).join('/')}`)
    }
    // `//host/…` is the tail of a URL the scan split at its colon, not a file.
    if (!inside && isAbsolute(value.path) && !text.trimStart().startsWith('//') && !roots.some(root => root.path === path))
      keep(outsideKey(path))
  }
  const scan = (text: string | undefined, rootId?: string) => {
    if (!text || budget <= 0 || full()) return
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
      if (!isFileMention({ root: ref.root, path: ref.path }) || budget < ref.path.length || folders >= FOLDER_REFERENCE_LIMIT) continue
      budget -= ref.path.length
      if (roots.some(root => root.id === ref.root)) keep(`${ref.root}\n${ref.path}`)
    }
  }
  if (detail.fileChanges?.runId === detail.summary.runId) outputRefs(detail.fileChanges?.files)
  // Newest messages take precedence when a very long history reaches the bounded scan budget.
  for (const message of detail.messages.toReversed()) {
    outputRefs(message.outputs)
    for (const ref of (message.fileRefs ?? []).slice(0, 32)) {
      if (!isFileMention(ref) || budget < ref.path.length || folders >= FOLDER_REFERENCE_LIMIT) continue
      budget -= ref.path.length
      if (roots.some(root => root.id === ref.root)) keep(`${ref.root}\n${ref.path}`)
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

/** The absolute path a reference names when a message named it outside every folder, else undefined. */
export function outsideReference(input: string, references: ReadonlySet<string>, home: string): string | undefined {
  const value = parseReference(input, home)
  if (!value || !isAbsolute(value.path)) return undefined
  const path = normalize(value.path)
  return references.has(outsideKey(path)) ? path : undefined
}

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
