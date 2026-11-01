import { describe, expect, it } from 'vitest'
import type { TaskSummary } from '@latch/protocol'
import { findClearance, matchPlacement } from '../src/components/transcriptFind.ts'
import {
  fileFolder,
  matchEntries,
  paletteGroups,
  recentSessions,
  snippetAround,
  type PaletteEntry,
  type PaletteSearchState,
} from '../src/palette/model.ts'

const entry = (id: string, label: string, extra: Partial<PaletteEntry> = {}): PaletteEntry => ({
  id,
  label,
  icon: null,
  run: () => {},
  ...extra,
})
const none = { recent: [], sessions: [], agents: [], settings: [], commands: [] }
const search = (extra: Partial<PaletteSearchState> = {}): PaletteSearchState => ({
  rows: [],
  loading: false,
  error: '',
  truncated: false,
  ...extra,
})

describe('palette groups', () => {
  it('shows recent sessions and root commands before typing, and only them', () => {
    const groups = paletteGroups({
      ...none,
      level: 'root',
      query: '  ',
      recent: [entry('a', '修复密钥')],
      sessions: [entry('a', '修复密钥'), entry('b', '更早的会话')],
      commands: [entry('new', '新会话', { root: true }), entry('copy', '复制当前会话')],
      files: search({ error: '不该出现' }),
      messages: search(),
    })
    expect(groups.map(group => group.label)).toEqual(['最近会话', '命令'])
    expect(groups[1]!.rows.map(row => row.id)).toEqual(['new'])
  })

  it('orders typed results with messages last, and leaves out what found nothing', () => {
    const groups = paletteGroups({
      level: 'root',
      query: '密钥',
      recent: [],
      sessions: [entry('s', '修复密钥')],
      files: search({ rows: [entry('f', '密钥.ts')] }),
      agents: [entry('a', '密钥 Agent'), entry('other', 'Codex')],
      settings: [entry('p', '模型服务', { keywords: '模型 密钥' })],
      commands: [entry('c', '轮换密钥'), entry('n', '新会话', { root: true })],
      messages: search({ rows: [entry('m', '…写入密钥')] }),
    })
    expect(groups.map(group => group.label)).toEqual(['会话', '文件', 'Harness', '设置', '命令', '在消息中'])
    expect(groups.find(group => group.label === 'Harness')!.rows.map(row => row.id)).toEqual(['a'])
    expect(groups.find(group => group.label === '命令')!.rows.map(row => row.id)).toEqual(['c'])
  })

  it('never says nothing matched while a search runs or after it failed', () => {
    const notes = (messages: PaletteSearchState) =>
      paletteGroups({ ...none, level: 'root', query: 'x', messages }).find(group => group.label === '在消息中')!.notes
    expect(notes(search({ loading: true }))).toEqual([{ text: '正在搜索消息…' }])
    expect(notes(search({ error: '连接已中断' }))).toEqual([{ text: '消息搜索失败：连接已中断', tone: 'error' }])
    expect(notes(search())).toEqual([{ text: '消息里没有「x」' }])
    expect(notes(search({ rows: [entry('m', 'x')] }))).toEqual([])
    expect(notes(search({ rows: [entry('m', 'x')], truncated: true }))).toEqual([{ text: '只显示了部分结果，请缩小搜索范围。' }])
  })

  it('reports a failed file search while typing, without the file spinner pushing the list around', () => {
    const groups = paletteGroups({ ...none, level: 'root', query: 'x', files: search({ loading: true }) })
    expect(groups.some(group => group.label === '文件')).toBe(false)
    const failed = paletteGroups({ ...none, level: 'root', query: 'x', files: search({ error: '没有权限' }) })
    expect(failed[0]!.notes).toEqual([{ text: '文件搜索失败：没有权限', tone: 'error' }])
  })

  it('shows only files at the files level, even with nothing typed', () => {
    const groups = paletteGroups({
      ...none,
      level: 'files',
      query: '',
      recent: [entry('a', '修复密钥')],
      files: search({ rows: [entry('f', 'a.ts')], truncated: true }),
    })
    expect(groups.map(group => group.label)).toEqual(['文件'])
    expect(groups[0]!.notes).toEqual([{ text: '只显示了部分文件，请缩小搜索范围。' }])
    expect(paletteGroups({ ...none, level: 'files', query: 'zz', files: search() })[0]!.notes).toEqual([{ text: '没有匹配的文件' }])
  })
})

describe('palette matching', () => {
  it('finds a label case-insensitively, puts a prefix first, and marks only drawn text', () => {
    const rows = matchEntries(
      [
        entry('later', '打开 Agent'),
        entry('first', 'Agent 成员'),
        entry('word', '模型服务', { keywords: 'agent 默认' }),
        entry('no', '关于'),
      ],
      'agent',
    )
    expect(rows.map(row => row.id)).toEqual(['first', 'later', 'word'])
    expect(rows[0]!.mark).toEqual({ start: 0, end: 5 })
    expect(rows[2]!.mark).toBeUndefined()
  })

  it('takes recent sessions by last activity, without the archived', () => {
    const task = (id: string, updatedAt: string, archived = false) => ({ id, updatedAt, archived }) as unknown as TaskSummary
    const recent = recentSessions(
      [task('old', '2026-01-01'), task('new', '2026-03-01'), task('gone', '2026-04-01', true), task('mid', '2026-02-01')],
      2,
    )
    expect(recent.map(item => item.id)).toEqual(['new', 'mid'])
  })

  it('starts a long snippet just before its match', () => {
    const snippet = `${'前'.repeat(40)}命中${'后'.repeat(40)}`
    const { text, mark } = snippetAround(snippet, { start: 40, end: 42 })
    expect(text.slice(mark.start, mark.end)).toBe('命中')
    expect(text.startsWith('…')).toBe(true)
    expect(snippetAround('短 命中', { start: 2, end: 4 })).toEqual({ text: '短 命中', mark: { start: 2, end: 4 } })
  })
  it('does not leave the end of the previous sentence after the ellipsis', () => {
    const snippet = `${'前'.repeat(20)}。 回归测试 发布`
    const at = snippet.indexOf('发布')
    const { text, mark } = snippetAround(snippet, { start: at, end: at + 2 }, 7)
    expect(text).toBe('…回归测试 发布')
    expect(text.slice(mark.start, mark.end)).toBe('发布')
  })
})

describe('find clearance', () => {
  const bar = { left: 100, right: 400 }
  const pane = { top: 50, scrollTop: 0 }
  const match = (top: number, left = 200) => ({ top, left, right: left + 40, height: 18 })
  it('brings down a match at the top that lies under the bar', () => {
    expect(findClearance(match(70), bar, pane, 0)).toBe(40)
  })
  it('counts what the content has already come down', () => {
    expect(findClearance(match(110), bar, pane, 40)).toBe(40)
  })
  it('leaves alone a match beside the bar, further down, or with no box', () => {
    expect(findClearance(match(70, 20), bar, pane, 0)).toBe(0)
    expect(findClearance(match(400), bar, pane, 0)).toBe(0)
    expect(findClearance(match(70), bar, { top: 50, scrollTop: 300 }, 0)).toBe(0)
    expect(findClearance({ ...match(70), height: 0 }, bar, pane, 0)).toBe(0)
  })
})

describe('find placement', () => {
  const pane = { top: 100, bottom: 700, height: 600 }
  const rect = (top: number, height = 18) => ({ top, bottom: top + height, height })
  it('leaves a match that can already be read where it is', () => {
    expect(matchPlacement(rect(300), { top: 200 }, pane).move).toBe(false)
  })
  it('moves a match under the find bar or below the fold to a third of the way down, inside a tall row', () => {
    expect(matchPlacement(rect(120), { top: 110 }, pane)).toEqual({ move: true, offset: 190 })
    expect(matchPlacement(rect(2500), { top: 300 }, pane)).toEqual({ move: true, offset: 200 - 2200 })
  })
  it('falls back on the row while a match has no box yet', () => {
    expect(matchPlacement(rect(0, 0), { top: 0 }, pane).move).toBe(true)
  })
})

describe('typed sessions', () => {
  it('stops at twenty rows and says the list is partial', () => {
    const sessions = Array.from({ length: 25 }, (_, index) => entry(`s${String(index)}`, `修复 ${String(index)}`))
    const [group] = paletteGroups({ ...none, level: 'root', query: '修复', sessions })
    expect(group!.rows).toHaveLength(20)
    expect(group!.notes?.map(note => note.text)).toEqual(['只显示了部分会话，请缩小搜索范围。'])
    const [all] = paletteGroups({ ...none, level: 'root', query: '修复', sessions: sessions.slice(0, 20) })
    expect(all!.notes).toEqual([])
  })
})

describe('file folders', () => {
  it('names the folder, and the root only when given one', () => {
    expect(fileFolder('src/a/index.ts', 'index.ts', undefined)).toBe('src/a')
    expect(fileFolder('src/a/index.ts', 'index.ts', 'web')).toBe('web/src/a')
    expect(fileFolder('index.ts', 'index.ts', undefined)).toBe('')
    expect(fileFolder('index.ts', 'index.ts', 'web')).toBe('web')
  })
})
