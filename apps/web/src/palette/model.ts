import type { ReactNode } from 'react'
import type { TaskSummary } from '@latch/protocol'
import { textMatches, type TextMatch } from '../textSearch.ts'

export type PaletteLevel = 'root' | 'files'

export interface PaletteEntry {
  id: string
  label: string
  /** Quiet text after the label. */
  sub?: string
  /** `sub` is a path: it gives up its middle before its last folder. */
  subIsPath?: boolean
  /** Other words the row answers to; they are not drawn. */
  keywords?: string
  shortcut?: string
  icon: ReactNode
  /** Shown before anything is typed. */
  root?: boolean
  /** Opens a level of the palette instead of running and closing. */
  level?: PaletteLevel
  run: () => void
}

export interface PaletteRow extends PaletteEntry {
  mark?: TextMatch
}

export interface PaletteNote {
  text: string
  tone?: 'error'
  /** The reason, on hover; the note then reads as a short state. */
  hint?: string
}

export interface PaletteGroup {
  label: string
  rows: PaletteRow[]
  notes?: PaletteNote[]
}

/** What an answer from the Host has reached: a search still under way or refused is not the same as no match. */
export interface PaletteSearchState {
  rows: PaletteRow[]
  loading: boolean
  error: string
  truncated: boolean
  /** Entries the Host could not check against the ignore rules (`uncheckedNote`). */
  unchecked?: { label: string; detail: string } | undefined
}

/** Rows that contain the query; those that begin with it come first, and each keeps its given order otherwise. */
export function matchEntries(entries: readonly PaletteEntry[], query: string): PaletteRow[] {
  const needle = query.trim()
  if (!needle) return [...entries]
  const found: Array<{ row: PaletteRow; first: boolean }> = []
  for (const entry of entries) {
    const mark = textMatches(entry.label, needle, 1)[0]
    if (mark) found.push({ row: { ...entry, mark }, first: mark.start === 0 })
    else if (textMatches(entry.keywords ?? '', needle, 1).length) found.push({ row: entry, first: false })
  }
  return [...found.filter(item => item.first), ...found.filter(item => !item.first)].map(item => item.row)
}

/** The folder that tells a file from others of its name, with its root when the results span more than one. */
export function fileFolder(path: string, name: string, root: string | undefined): string {
  const folder = path.slice(0, Math.max(0, path.length - name.length - 1))
  return [root, folder].filter(Boolean).join('/')
}

export function recentSessions(tasks: readonly TaskSummary[], limit = 4): TaskSummary[] {
  return tasks
    .filter(task => !task.archived)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
}

/** A row is one line: the snippet starts just before its match, so the match is never cut off at the row's end. */
export function snippetAround(snippet: string, match: TextMatch, before = 10): { text: string; mark: TextMatch } {
  if (match.start <= before) return { text: snippet, mark: match }
  const cut = match.start - before
  // After the ellipsis, a cut must not leave the end of the previous sentence.
  const start = cut + (snippet.slice(cut, match.start).match(/^[\s\p{P}]+/u)?.[0].length ?? 0)
  return { text: `…${snippet.slice(start)}`, mark: { start: match.start - start + 1, end: match.end - start + 1 } }
}

function searchNotes(
  state: PaletteSearchState,
  words: { loading: string; failed: string; none?: string; truncated: string },
): PaletteNote[] {
  if (state.error) return [{ text: `${words.failed}：${state.error}`, tone: 'error' }]
  if (state.loading) return [{ text: words.loading }]
  const unchecked = state.unchecked ? [{ text: state.unchecked.label, hint: state.unchecked.detail }] : []
  if (state.truncated) return [{ text: words.truncated }, ...unchecked]
  return [...(!state.rows.length && words.none ? [{ text: words.none }] : []), ...unchecked]
}

const shown = (group: PaletteGroup) => group.rows.length > 0 || (group.notes?.length ?? 0) > 0

const SESSION_ROWS = 20

const FILE_WORDS = { loading: '正在查找文件…', failed: '文件搜索失败', truncated: '只显示了部分文件，请缩小搜索范围。' }

/** Before typing: 最近会话 and 命令. While typing, every kind of result, with what is slowest to answer last. */
export function paletteGroups({
  level,
  query,
  recent,
  sessions,
  files,
  agents,
  myAgents = [],
  settings,
  commands,
  messages,
}: {
  level: PaletteLevel
  query: string
  recent: readonly PaletteEntry[]
  sessions: readonly PaletteEntry[]
  files?: PaletteSearchState | undefined
  agents: readonly PaletteEntry[]
  /** 我的 Agent, each opening its page. */
  myAgents?: readonly PaletteEntry[]
  settings: readonly PaletteEntry[]
  commands: readonly PaletteEntry[]
  messages?: PaletteSearchState | undefined
}): PaletteGroup[] {
  const typed = query.trim()
  if (level === 'files') {
    const state = files ?? { rows: [], loading: false, error: '', truncated: false }
    return [{ label: '文件', rows: state.rows, notes: searchNotes(state, { ...FILE_WORDS, none: '没有匹配的文件' }) }]
  }
  if (!typed)
    return [
      { label: '最近会话', rows: [...recent] },
      { label: '命令', rows: commands.filter(command => command.root) },
    ].filter(shown)
  const matchedSessions = matchEntries(sessions, typed)
  return [
    {
      label: '会话',
      rows: matchedSessions.slice(0, SESSION_ROWS),
      notes: matchedSessions.length > SESSION_ROWS ? [{ text: '只显示了部分会话，请缩小搜索范围。' }] : [],
    },
    { label: '文件', rows: files?.rows ?? [], notes: files ? searchNotes({ ...files, loading: false }, FILE_WORDS) : [] },
    { label: '我的 Agent', rows: matchEntries(myAgents, typed) },
    { label: 'Harness', rows: matchEntries(agents, typed) },
    { label: '设置', rows: matchEntries(settings, typed) },
    { label: '命令', rows: matchEntries(commands, typed) },
    {
      label: '在消息中',
      rows: messages?.rows ?? [],
      notes: messages
        ? searchNotes(messages, {
            loading: '正在搜索消息…',
            failed: '消息搜索失败',
            none: `消息里没有「${typed}」`,
            truncated: '只显示了部分结果，请缩小搜索范围。',
          })
        : [],
    },
  ].filter(shown)
}
