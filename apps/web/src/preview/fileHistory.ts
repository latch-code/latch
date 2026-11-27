import { isFileMention, type FileDiff, type FileOpenTarget, type TaskDetail } from '@latch/protocol'
import { appliedDiffs } from '../conversation.ts'
import { shownToolTitle } from '../conversation/toolTitles.ts'
import { defineCopy } from '../core/i18n.ts'

const FILE_HISTORY_COPY = defineCopy(
  { projectFolder: '项目文件夹', toolEdit: '工具修改' },
  { projectFolder: 'Project folder', toolEdit: 'Tool edit' },
)
export interface FileHistory {
  root: string
  folder: string
  path: string
  target: FileOpenTarget
  currentTurnId?: string
  entries: Array<{ id: string; toolId: string; tool: string; turnId?: string; at?: string; diff: FileDiff }>
}
/** Normalizes Host-recorded spellings only. It never resolves a filesystem or authorizes a new file read. */
function normalize(path: string): string | undefined {
  if (!path || path.length > 8192 || /[\u0000-\u001f\u007f]/u.test(path)) return undefined
  if (path.startsWith('file://')) {
    try {
      const url = new URL(path)
      if (url.hostname && url.hostname !== 'localhost') return undefined
      path = decodeURIComponent(url.pathname)
    } catch {
      return undefined
    }
  } else if (/^[a-z]+:\/\//iu.test(path)) return undefined
  path = path.replaceAll('\\', '/')
  const absolute = path.startsWith('/') || /^[A-Za-z]:\//u.test(path)
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return undefined
      parts.pop()
    } else parts.push(part)
  }
  return `${absolute && !/^[A-Za-z]:/u.test(path) ? '/' : ''}${parts.join('/')}`
}
export function fileHistories(detail: Pick<TaskDetail, 'summary' | 'messages'>): FileHistory[] {
  const folders = (
    detail.summary.folders?.length ? detail.summary.folders : detail.summary.cwd ? [{ id: 'default', path: detail.summary.cwd }] : []
  ).flatMap(folder => {
    const path = normalize(folder.path)
    return path ? [{ id: folder.id, path }] : []
  })
  const groups = new Map<string, FileHistory>()
  let turnId: string | undefined
  for (const message of detail.messages) {
    if (message.role === 'user' && !message.steered) turnId = message.id
    if (message.role !== 'tool') continue
    let selected: (typeof folders)[number] | undefined = folders[0]
    try {
      const input: unknown = JSON.parse(message.tool?.input ?? '{}')
      if (input && typeof input === 'object' && 'folder' in input) selected = folders.find(folder => folder.id === input.folder)
    } catch {
      /* Old tool records need not have structured input. */
    }
    for (const [index, diff] of appliedDiffs(message).entries()) {
      const absolute = diff.path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(diff.path) || diff.path.startsWith('file://')
      const path = normalize(absolute ? diff.path : selected ? `${selected.path}/${diff.path}` : '')
      if (!path) continue
      const root = folders.toSorted((a, b) => b.path.length - a.path.length).find(folder => path.startsWith(`${folder.path}/`))
      if (!root) continue
      const relative = path.slice(root.path.length + 1)
      if (!isFileMention({ root: root.id, path: relative })) continue
      const key = `${root.id}\n${relative}`
      const history = groups.get(key) ?? {
        root: root.id,
        folder: root.path.split('/').at(-1) || FILE_HISTORY_COPY.projectFolder,
        path: relative,
        target: { sessionId: detail.summary.id, reference: relative, rootId: root.id, view: 'changes' as const },
        entries: [],
      }
      history.entries.push({
        id: `${message.id}:${index}`,
        toolId: message.id,
        ...(turnId ? { turnId } : {}),
        tool: message.tool?.toolTitle
          ? shownToolTitle(message.tool.toolTitle, message.toolName)
          : (message.tool?.title ?? FILE_HISTORY_COPY.toolEdit),
        ...(message.startedAt ? { at: message.startedAt } : {}),
        diff,
      })
      groups.set(key, history)
    }
  }
  for (const history of groups.values()) history.currentTurnId = turnId
  return [...groups.values()]
}

/**
 * Finds the recorded edit history for a specific tool call's diff. Files inside the session's frozen roots reuse
 * `fileHistories` (and can switch to Host preview); recorded edits outside those roots stay diff-only and transient.
 */
export function recordedFileHistory(
  detail: Pick<TaskDetail, 'summary' | 'messages'>,
  messageId: string,
  diffIndex: number,
): { history: FileHistory; insideRoot: boolean } | undefined {
  const entryId = `${messageId}:${diffIndex}`
  const inside = fileHistories(detail).find(file => file.entries.some(entry => entry.id === entryId))
  if (inside) return { history: inside, insideRoot: true }
  const source = detail.messages.find(message => message.id === messageId && message.role === 'tool')
  const targetDiff = source ? appliedDiffs(source)[diffIndex] : undefined
  if (!targetDiff) return undefined
  const targetKey = normalize(targetDiff.path) ?? targetDiff.path
  let turnId: string | undefined
  const entries: FileHistory['entries'] = []
  for (const message of detail.messages) {
    if (message.role === 'user' && !message.steered) turnId = message.id
    if (message.role !== 'tool') continue
    for (const [index, diff] of appliedDiffs(message).entries()) {
      if ((normalize(diff.path) ?? diff.path) !== targetKey) continue
      entries.push({
        id: `${message.id}:${index}`,
        toolId: message.id,
        ...(turnId ? { turnId } : {}),
        tool: message.tool?.toolTitle
          ? shownToolTitle(message.tool.toolTitle, message.toolName)
          : (message.tool?.title ?? FILE_HISTORY_COPY.toolEdit),
        ...(message.startedAt ? { at: message.startedAt } : {}),
        diff,
      })
    }
  }
  if (entries.length === 0) return undefined
  return {
    insideRoot: false,
    history: {
      root: '',
      folder: '',
      path: targetDiff.path,
      target: { sessionId: detail.summary.id, reference: targetDiff.path, view: 'changes' },
      ...(turnId ? { currentTurnId: turnId } : {}),
      entries,
    },
  }
}
