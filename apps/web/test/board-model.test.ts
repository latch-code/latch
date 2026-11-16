import { describe, expect, it } from 'vitest'
import type { Approval, AppSnapshot, BoardPlace, TaskSummary, WorkItemPlace, WorkItemSummary, WorkspaceInfo } from '@latch/protocol'
import {
  boardColumns,
  filterOptions,
  groupCounts,
  listRows,
  NO_FILTERS,
  NO_PROJECT,
  WHO_CODE,
  type BoardFilters,
} from '../src/board/model.ts'

const NOW = Date.parse('2026-11-17T08:00:00Z')
const at = (daysAgo: number, minutes = 0) => new Date(NOW - daysAgo * 86_400_000 - minutes * 60_000).toISOString()
const card = (group: BoardPlace['group'], reason?: BoardPlace['reason']): BoardPlace => ({
  group,
  card: true,
  ...(reason ? { reason } : {}),
})
const task = (id: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  id,
  title: id,
  harnessId: 'codex',
  status: 'idle',
  updatedAt: at(0),
  ...extra,
})
const item = (id: string, board: WorkItemPlace, extra: Partial<WorkItemSummary> = {}): WorkItemSummary => ({
  id,
  title: id,
  sessionIds: [],
  createdAt: at(0),
  updatedAt: at(0),
  revision: 1,
  board,
  ...extra,
})
const workspaces: WorkspaceInfo[] = [
  { id: 'latch', name: 'latch', path: '/w/latch' } as WorkspaceInfo,
  { id: 'blog', name: 'blog', path: '/w/blog' } as WorkspaceInfo,
]
const ids = (cards: readonly { id: string }[]) => cards.map(item => item.id)
const columns = (tasks: TaskSummary[], filters: BoardFilters = NO_FILTERS) =>
  Object.fromEntries(boardColumns(tasks, filters, workspaces, NOW).map(column => [column.group, ids(column.cards)]))

describe('the board model', () => {
  it('puts every card in the Host’s group and nothing else on the board', () => {
    const tasks = [
      task('waits', { board: card('attention', 'approval'), status: 'waiting-approval' }),
      task('runs', { board: card('running'), status: 'running' }),
      task('ready', { board: card('deliver') }),
      task('ended', { board: card('done') }),
      // The Host gives no card to 我的 Agent's own chat, an archived or a legacy session: they never show.
      task('chat', { board: { group: 'attention', reason: 'approval' }, agent: { customAgentId: 'a' }, status: 'waiting-approval' }),
      task('archived', { archived: true, board: { group: 'done' } }),
      // Without the Host's place there is no card, whatever the summary says.
      task('unplaced', { status: 'waiting-approval', pendingQuestions: 2 }),
    ]
    expect(columns(tasks)).toEqual({ todo: [], attention: ['waits'], running: ['runs'], deliver: ['ready'], done: ['ended'] })
  })

  it('counts only the cards it shows, never approvals or sessions the snapshot does not list', () => {
    const tasks = [
      task('waits', { board: card('attention', 'question'), status: 'waiting-approval', pendingQuestions: 1 }),
      task('failed', { status: 'failed', runOutcome: 'failed' }),
      task('stuck', { status: 'waiting-approval' }),
    ]
    // An approval of a private session this device may not read: in the snapshot's list, its session is not.
    const approvals = [{ id: 'p1', sessionId: 'private', risk: 'R1' } as Approval]
    const snapshot = { tasks, approvals } as Pick<AppSnapshot, 'tasks' | 'approvals'>
    expect(groupCounts(snapshot.tasks, NOW)).toEqual({ todo: 0, attention: 1, running: 0, deliver: 0, done: 0 })
    expect(boardColumns(snapshot.tasks, NO_FILTERS, workspaces, NOW).map(column => column.total)).toEqual([0, 1, 0, 0, 0])
  })

  it('filters with or inside a dimension and and between them, and keeps the unfiltered totals', () => {
    const tasks = [
      task('a', { board: card('done'), workspaceId: 'latch', tags: ['发版'] }),
      task('b', { board: card('done'), workspaceId: 'blog', tags: ['依赖'] }),
      task('c', { board: card('done'), workspaceId: 'latch', harnessId: 'claude', tags: ['依赖'] }),
      task('d', { board: card('done') }),
    ]
    const filters = { ...NO_FILTERS, projects: ['latch', NO_PROJECT], tags: ['发版', '依赖'] }
    expect(columns(tasks, filters).done).toEqual(['a', 'c'])
    expect(columns(tasks, { ...filters, harnesses: ['claude'] }).done).toEqual(['c'])
    expect(columns(tasks, { ...NO_FILTERS, projects: [NO_PROJECT] }).done).toEqual(['d'])
    expect(boardColumns(tasks, filters, workspaces, NOW).find(column => column.group === 'done')?.total).toBe(4)
  })

  it('sorts by priority, then the Host’s reason in rule order within 等你处理, then the newest first', () => {
    const tasks = [
      task('silent', { board: card('attention', 'silent'), updatedAt: at(0, 1) }),
      task('failed', { board: card('attention', 'failed'), updatedAt: at(0, 2) }),
      task('approval', { board: card('attention', 'approval'), updatedAt: at(0, 9) }),
      task('low', { board: card('attention', 'approval'), priority: 'low', updatedAt: at(0, 0) }),
      task('high', { board: card('attention', 'silent'), priority: 'high', updatedAt: at(0, 30) }),
      task('newer', { board: card('done'), updatedAt: at(0, 1) }),
      task('older', { board: card('done'), updatedAt: at(0, 5) }),
      task('first', { board: card('done'), priority: 'high', updatedAt: at(1) }),
    ]
    expect(columns(tasks).attention).toEqual(['high', 'approval', 'failed', 'silent', 'low'])
    expect(columns(tasks).done).toEqual(['first', 'newer', 'older'])
  })

  it('keeps seven days of 已结束 on the board and all of it in the list, with archived sessions apart', () => {
    const tasks = [
      task('recent', { board: card('done'), updatedAt: at(6) }),
      task('old', { board: card('done'), updatedAt: at(8) }),
      task('running', { board: card('running'), updatedAt: at(9) }),
      task('shelved', { archived: true, board: { group: 'done' } }),
      task('shelved-chat', { archived: true, agent: { customAgentId: 'a' } }),
      task('shelved-run', { archived: true, agent: { customAgentId: 'a' }, automationId: 's' }),
    ]
    expect(columns(tasks)).toMatchObject({ running: ['running'], done: ['recent'] })
    expect(groupCounts(tasks, NOW).done).toBe(1)
    expect(ids(listRows(tasks, 'done', NO_FILTERS, workspaces, 'group'))).toEqual(['recent', 'old'])
    expect(ids(listRows(tasks, 'all', NO_FILTERS, workspaces, 'group'))).toEqual(['running', 'recent', 'old'])
    expect(ids(listRows(tasks, 'all', NO_FILTERS, workspaces, 'time'))).toEqual(['recent', 'old', 'running'])
    expect(ids(listRows(tasks, 'archived', NO_FILTERS, workspaces, 'group'))).toEqual(['shelved', 'shelved-run'])
  })

  it('offers only what the cards hold as filter choices, and no Agent this device is not told about', () => {
    const tasks = [
      task('code', { board: card('done'), workspaceId: 'latch', tags: ['发版'] }),
      task('known', { board: card('running'), agent: { customAgentId: 'helper' }, automationId: 's', harnessId: 'claude' }),
      task('unknown', { board: card('running'), agent: { customAgentId: 'secret' }, automationId: 's' }),
      task('loose', { tags: ['不上板'] }),
    ]
    const options = filterOptions(tasks, {
      catalog: { workspaces, harnesses: [] } as unknown as AppSnapshot['catalog'],
      customAgents: [{ id: 'helper', name: '小满' }] as AppSnapshot['customAgents'],
    })
    expect(options.who).toEqual([
      { value: WHO_CODE, label: 'Code' },
      { value: 'helper', label: '小满' },
    ])
    expect(options.tags.map(option => option.value)).toEqual(['发版'])
    expect(options.projects.map(option => option.value)).toEqual(['latch', NO_PROJECT])
    expect(options.harnesses.map(option => option.value)).toEqual(['codex', 'claude'])
  })

  it('makes a 待办 one card with its sessions, which are never cards, rows or counts of their own', () => {
    const tasks = [
      task('impl', { board: card('running'), status: 'running', workspaceId: 'latch' }),
      task('review', { board: card('attention', 'question'), status: 'waiting-approval', pendingQuestions: 1 }),
      task('alone', { board: card('running'), status: 'running' }),
      // A session that names a 待办 this device is not given stays a card of its own: membership is the 待办's list.
      task('stray', { board: card('deliver'), itemId: 'itm_private' }),
    ]
    const items = [
      item('itm_work', { group: 'attention', reason: 'question' }, { sessionIds: ['impl', 'review', 'gone'] }),
      item('itm_later', { group: 'todo' }),
    ]
    const shown = boardColumns(tasks, NO_FILTERS, workspaces, NOW, items)
    expect(Object.fromEntries(shown.map(column => [column.group, ids(column.cards)]))).toEqual({
      todo: ['itm_later'],
      attention: ['itm_work'],
      running: ['alone'],
      deliver: ['stray'],
      done: [],
    })
    const work = shown[1]!.cards[0]!
    expect(work.kind === 'item' && ids(work.sessions)).toEqual(['impl', 'review'])
    expect(groupCounts(tasks, NOW, items)).toEqual({ todo: 1, attention: 1, running: 1, deliver: 1, done: 0 })
    expect(ids(listRows(tasks, 'all', NO_FILTERS, workspaces, 'group', items))).toEqual(['itm_later', 'itm_work', 'alone', 'stray'])
    expect(ids(listRows(tasks, 'todo', NO_FILTERS, workspaces, 'group', items))).toEqual(['itm_later'])
    // Archived sessions of a 待办 stay under it, never under 已归档.
    const archived = [...tasks, task('old', { archived: true })]
    const held = [item('itm_old', { group: 'deliver', reason: 'settled' }, { sessionIds: ['old'] })]
    expect(ids(listRows(archived, 'archived', NO_FILTERS, workspaces, 'group', held))).toEqual([])
  })

  it('sorts 待办 with sessions by priority and the Host’s reason, by the newest change of it or its sessions', () => {
    const tasks = [task('fresh', { board: card('running'), updatedAt: at(0, 1) })]
    const items = [
      item('itm_a', { group: 'running' }, { updatedAt: at(2), sessionIds: ['fresh'] }),
      item('itm_b', { group: 'running' }, { updatedAt: at(0, 5) }),
      item('itm_c', { group: 'running' }, { updatedAt: at(3), priority: 'high' }),
      item('itm_d', { group: 'attention', reason: 'failed' }),
      item('itm_e', { group: 'attention', reason: 'approval' }, { updatedAt: at(1) }),
    ]
    const shown = Object.fromEntries(
      boardColumns(tasks, NO_FILTERS, workspaces, NOW, items).map(column => [column.group, ids(column.cards)]),
    )
    expect(shown.running).toEqual(['itm_c', 'itm_a', 'itm_b'])
    expect(shown.attention).toEqual(['itm_e', 'itm_d'])
  })

  it('filters a 待办 by its sessions, or before it has one by its suggestions', () => {
    const tasks = [task('impl', { board: card('running'), harnessId: 'claude', workspaceId: 'blog' })]
    const items = [
      item('itm_started', { group: 'running' }, { sessionIds: ['impl'], harnessId: 'codex', tags: ['发版'] }),
      item('itm_todo', { group: 'todo' }, { harnessId: 'codex', projectId: 'latch' }),
      item('itm_bare', { group: 'todo' }),
    ]
    const shown = (filters: BoardFilters) => boardColumns(tasks, filters, workspaces, NOW, items).flatMap(column => ids(column.cards))
    expect(shown({ ...NO_FILTERS, harnesses: ['codex'] })).toEqual(['itm_todo'])
    expect(shown({ ...NO_FILTERS, harnesses: ['claude'] })).toEqual(['itm_started'])
    expect(shown({ ...NO_FILTERS, projects: ['blog'] })).toEqual(['itm_started'])
    expect(shown({ ...NO_FILTERS, projects: [NO_PROJECT] })).toEqual(['itm_bare'])
    expect(shown({ ...NO_FILTERS, who: [WHO_CODE], tags: ['发版'] })).toEqual(['itm_started'])
    const options = filterOptions(tasks, { catalog: { workspaces, harnesses: [] } as unknown as AppSnapshot['catalog'] }, items)
    expect(options.harnesses.map(option => option.value).toSorted()).toEqual(['claude', 'codex'])
    expect(options.tags.map(option => option.value)).toEqual(['发版'])
  })
})
