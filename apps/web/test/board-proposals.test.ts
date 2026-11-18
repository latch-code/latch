import { describe, expect, it } from 'vitest'
import type {
  BoardPlace,
  HostCatalog,
  TaskSummary,
  WorkItemPlace,
  WorkItemSummary,
  WorkProposalSummary,
  WorkspaceInfo,
} from '@latch/protocol'
import {
  boardColumns,
  filterOptions,
  groupCounts,
  listRows,
  NO_FILTERS,
  ORIGIN_AGENT,
  ORIGIN_PROPOSED,
  startAllItems,
} from '../src/board/model.ts'
import { dropAction } from '../src/board/drag.ts'
import { changeFor, proposerName, todoProposals } from '../src/board/proposals.ts'

const NOW = Date.parse('2026-11-17T08:00:00Z')
const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
const card = (group: BoardPlace['group']): BoardPlace => ({ group, card: true })
const task = (id: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  id,
  title: id,
  harnessId: 'codex',
  status: 'idle',
  updatedAt: at(0),
  ...extra,
})
const todo: WorkItemPlace = { group: 'todo' }
const item = (id: string, extra: Partial<WorkItemSummary> = {}): WorkItemSummary => ({
  id,
  title: id,
  sessionIds: [],
  createdAt: at(30),
  updatedAt: at(30),
  revision: 1,
  board: todo,
  ...extra,
})
const proposal = (id: string, extra: Partial<WorkProposalSummary> = {}): WorkProposalSummary => ({
  id,
  kind: 'todo',
  from: { sessionId: 'code-1' },
  entries: [{ index: 0, state: 'pending', title: `${id} 的待办`, hasPrompt: true }],
  createdAt: at(60),
  updatedAt: at(60),
  revision: 1,
  ...extra,
})
const workspaces: WorkspaceInfo[] = []
const ids = (cards: readonly { id: string }[]) => cards.map(entry => entry.id)

describe('proposals on the board', () => {
  it('a proposal is a card of its own in 未开始, before the 待办, and never a 待办', () => {
    const items = [item('itm-high', { priority: 'high' }), item('itm-mid')]
    const proposals = [proposal('wpp-1'), proposal('wpp-2', { updatedAt: at(5) })]
    const columns = boardColumns([task('code-1', { board: card('done') })], NO_FILTERS, workspaces, NOW, items, proposals)
    const column = columns.find(entry => entry.group === 'todo')!
    // Proposals first, newest first; then the 待办 by priority.
    expect(ids(column.cards)).toEqual(['wpp-2', 'wpp-1', 'itm-high', 'itm-mid'])
    expect(column.cards.slice(0, 2).every(entry => entry.kind === 'proposal')).toBe(true)
    expect(groupCounts([], NOW, items, proposals).todo).toBe(4)
    // 全部开始 starts 待办 only.
    expect(ids(startAllItems(column.cards))).toEqual(['itm-high', 'itm-mid'])
  })

  it('全部开始 passes by a 待办 whose 要求 came from outside content', () => {
    const items = [
      item('mine'),
      item('agent', { from: { sessionId: 'code-1', proposalId: 'wpp-x' } }),
      item('outside', { from: { sessionId: 'code-1', proposalId: 'wpp-y', external: true } }),
    ]
    const cards = boardColumns([], NO_FILTERS, workspaces, NOW, items).find(entry => entry.group === 'todo')!.cards
    expect(ids(startAllItems(cards)).toSorted()).toEqual(['agent', 'mine'])
  })

  it('a proposal is never dragged: it is accepted or dismissed', () => {
    const cards = boardColumns([], NO_FILTERS, workspaces, NOW, [], [proposal('wpp-1')])[0]!.cards
    for (const target of ['running', 'done'] as const)
      expect(dropAction(cards[0]!, target, { canStart: true, canMark: true, unconfirmed: false, stopping: false })).toBeNull()
  })

  it('来源 filters proposals and cards with a suggestion waiting, or 待办 an agent proposed', () => {
    const tasks = [
      task('code-1', { board: card('running'), status: 'running' }),
      task('code-2', { board: card('running'), status: 'running' }),
    ]
    const items = [item('mine'), item('agent', { from: { sessionId: 'code-1', proposalId: 'wpp-x' } })]
    const proposals = [
      proposal('wpp-1'),
      proposal('wpp-2', {
        kind: 'change',
        entries: undefined,
        change: { target: { sessionId: 'code-2' }, note: '等 CI', state: 'pending' },
      }),
    ]
    const options = filterOptions(tasks, {}, items, proposals)
    expect(options.origin.map(option => option.value)).toEqual([ORIGIN_PROPOSED, ORIGIN_AGENT])
    const proposed = listRows(tasks, 'all', { ...NO_FILTERS, origin: [ORIGIN_PROPOSED] }, workspaces, 'group', items, proposals)
    // The change proposal is not a card: it marks the card it is for.
    expect(ids(proposed)).toEqual(['wpp-1', 'code-2'])
    const agent = listRows(tasks, 'all', { ...NO_FILTERS, origin: [ORIGIN_AGENT] }, workspaces, 'group', items, proposals)
    expect(ids(agent)).toEqual(['agent'])
  })

  it('a change is found for its card, and who proposed it is named from the snapshot', () => {
    const change = proposal('wpp-c', {
      kind: 'change',
      entries: undefined,
      from: { sessionId: 'chat', customAgentId: 'agt_1' },
      change: { target: { itemId: 'itm-1' }, title: '新标题', state: 'pending' },
    })
    expect(changeFor([change], { itemId: 'itm-1' })?.id).toBe('wpp-c')
    expect(changeFor([change], { sessionId: 'itm-1' })).toBeUndefined()
    expect(todoProposals([change])).toEqual([])
    const snapshot = { tasks: [task('chat', { title: '聊天' })], customAgents: [{ id: 'agt_1', name: '助理' }] } as never
    expect(proposerName(change, snapshot).name).toBe('助理')
    expect(proposerName(change, { tasks: [] }).name).toBe('Agent')
  })

  it('names an ordinary Code source using its visible catalog and keeps the original session for details', () => {
    const source = task('code-1', { title: 'board {"tool":"propose_todo"}', workspaceId: 'project' })
    const row = proposal('wpp-d')
    const catalog = {
      harnesses: [{ id: 'codex', capabilities: { display: { label: 'Codex' } } }],
      workspaces: [{ id: 'project', name: '发布项目' }],
    } as HostCatalog
    expect(proposerName(row, { tasks: [source], catalog })).toEqual({ name: 'Codex · 发布项目', session: source })
    expect(proposerName(row, { tasks: [source], catalog: { ...catalog, workspaces: [] } })).toEqual({ name: 'Codex', session: source })
    expect(proposerName(row, { tasks: [source] })).toEqual({ name: 'Code 会话', session: source })
    expect(proposerName(row, { tasks: [], catalog })).toEqual({ name: 'Code 会话' })
  })
})
