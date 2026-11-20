import type { ReactNode } from 'react'
import type { TaskSummary } from '@latch/protocol'
import { textMatches, type TextMatch } from '../textSearch.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    searchingFiles: '正在查找文件…',
    filesFailed: '文件搜索失败',
    partialFiles: '只显示了部分文件，请缩小搜索范围。',
    files: '文件',
    noFiles: '没有匹配的文件',
    recent: '最近会话',
    commands: '命令',
    sessions: '会话',
    partialSessions: '只显示了部分会话，请缩小搜索范围。',
    agents: '我的 Agent',
    settings: '设置',
    inMessages: '在消息中',
    searchingMessages: '正在搜索消息…',
    messagesFailed: '消息搜索失败',
    noMessages: (query: string) => `消息里没有「${query}」`,
    partialMessages: '只显示了部分结果，请缩小搜索范围。',
  },
  {
    searchingFiles: 'Searching files…',
    filesFailed: 'File search failed',
    partialFiles: 'Showing some files. Narrow your search.',
    files: 'Files',
    noFiles: 'No matching files',
    recent: 'Recent sessions',
    commands: 'Commands',
    sessions: 'Sessions',
    partialSessions: 'Showing some sessions. Narrow your search.',
    agents: 'My Agents',
    settings: 'Settings',
    inMessages: 'In messages',
    searchingMessages: 'Searching messages…',
    messagesFailed: 'Message search failed',
    noMessages: (query: string) => `No messages contain “${query}”`,
    partialMessages: 'Showing some results. Narrow your search.',
  },
)

export type PaletteLevel = 'root' | 'files'

export interface PaletteEntry {
  id: string
  label: string
  /** The plain Code workspace, when Agent conversations also appear in search. */
  codeSession?: boolean
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
  space?: string
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

/** Exact labels, then prefixes and other label matches, then keywords. Keep the given order within each rank. */
export function matchEntries(entries: readonly PaletteEntry[], query: string): PaletteRow[] {
  const needle = query.trim()
  if (!needle) return [...entries]
  const exact: PaletteRow[] = []
  const prefix: PaletteRow[] = []
  const contains: PaletteRow[] = []
  const keywords: PaletteRow[] = []
  for (const entry of entries) {
    const mark = textMatches(entry.label, needle, 1)[0]
    if (mark) {
      const ranked = mark.start > 0 ? contains : mark.end < entry.label.length ? prefix : exact
      ranked.push({ ...entry, mark })
    } else if (textMatches(entry.keywords ?? '', needle, 1).length) keywords.push(entry)
  }
  return [...exact, ...prefix, ...contains, ...keywords]
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

function sessionGroup(label: string, rows: PaletteRow[]): PaletteGroup {
  if (rows.length && rows.every(row => row.codeSession)) return { label, space: 'Code', rows }
  return {
    label,
    rows: rows.map(row => (row.codeSession ? { ...row, sub: row.sub ? `Code · ${row.sub}` : 'Code' } : row)),
  }
}

const SESSION_ROWS = 20

const FILE_WORDS = {
  get loading() {
    return COPY.searchingFiles
  },
  get failed() {
    return COPY.filesFailed
  },
  get truncated() {
    return COPY.partialFiles
  },
}

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
    return [{ label: COPY.files, rows: state.rows, notes: searchNotes(state, { ...FILE_WORDS, none: COPY.noFiles }) }]
  }
  if (!typed)
    return [sessionGroup(COPY.recent, [...recent]), { label: COPY.commands, rows: commands.filter(command => command.root) }].filter(shown)
  const matchedSessions = matchEntries(sessions, typed)
  return [
    {
      ...sessionGroup(COPY.sessions, matchedSessions.slice(0, SESSION_ROWS)),
      notes: matchedSessions.length > SESSION_ROWS ? [{ text: COPY.partialSessions }] : [],
    },
    { label: COPY.files, rows: files?.rows ?? [], notes: files ? searchNotes({ ...files, loading: false }, FILE_WORDS) : [] },
    { label: COPY.agents, rows: matchEntries(myAgents, typed) },
    { label: 'Harness', rows: matchEntries(agents, typed) },
    { label: COPY.settings, rows: matchEntries(settings, typed) },
    { label: COPY.commands, rows: matchEntries(commands, typed) },
    {
      label: COPY.inMessages,
      rows: messages?.rows ?? [],
      notes: messages
        ? searchNotes(messages, {
            loading: COPY.searchingMessages,
            failed: COPY.messagesFailed,
            none: COPY.noMessages(typed),
            truncated: COPY.partialMessages,
          })
        : [],
    },
  ].filter(shown)
}
