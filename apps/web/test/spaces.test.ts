import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, TaskSummary } from '@latch/protocol'
import { AgentsGlyph } from '../src/agents/AgentAvatar.tsx'
import { BRACKET_PATHS } from '../src/agents/avatarFace.ts'
import {
  filterSessions,
  inSpace,
  listedSessions,
  readSpace,
  delegationRows,
  recentDelegations,
  spaceKey,
  spaceOf,
  waitingCount,
  writeSpace,
} from '../src/sessions.ts'
import { backRoute, currentSpace, initialRoute, otherSpace, placeWaits, spaceMove, waitsElsewhere } from '../src/shell/spaces.ts'
import { delegationAgent } from '../src/agents/AgentsSpaceList.tsx'
import { shellSpaces } from '../src/shell/SpaceNav.tsx'

const task = (id: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  harnessId: 'standard',
  id,
  title: `会话 ${id}`,
  status: 'idle',
  updatedAt: new Date(2026, 10, 12, 9, Number(id.replace(/\D/gu, '') || 0)).toISOString(),
  ...extra,
})
const delegated = (id: string, extra: Partial<TaskSummary> = {}) => task(id, { agent: { customAgentId: 'review' }, ...extra })
const approval = (sessionId: string) => ({ sessionId }) as AppSnapshot['approvals'][number]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the two places', () => {
  const tasks = [task('c1'), delegated('a2'), task('c3', { archived: true }), delegated('a4', { archived: true })]

  it('puts a session in 我的 Agent only when it was delegated to an Agent', () => {
    expect(spaceOf(task('c'))).toBe('code')
    expect(spaceOf(delegated('a'))).toBe('agents')
    expect(inSpace(tasks, 'code').map(item => item.id)).toEqual(['c1', 'c3'])
    expect(inSpace(tasks, undefined)).toHaveLength(4)
  })

  it('filters each list to its own place, archived ones under their own filter, and both without a place', () => {
    expect(filterSessions(tasks, 'all', '', 'code').map(item => item.id)).toEqual(['c1'])
    expect(filterSessions(tasks, 'archived', '', 'code').map(item => item.id)).toEqual(['c3'])
    expect(filterSessions(tasks, 'all', '', 'agents').map(item => item.id)).toEqual(['a2'])
    expect(filterSessions(tasks, 'all', '').map(item => item.id)).toEqual(['c1', 'a2'])
  })

  it('steps through the list the place draws: Code without delegations, 我的 Agent through 最近委托', () => {
    const folded = new Set<string>()
    const waiting = delegated('a5', { status: 'waiting-approval' })
    const all = [...tasks, waiting]
    expect(listedSessions(all, [], { filter: 'all', search: '', folded, space: 'code' }).map(item => item.id)).toEqual(['c1'])
    expect(listedSessions(all, [], { filter: 'all', search: '', folded, space: 'agents' }).map(item => item.id)).toEqual(['a5', 'a2'])
    // Without 我的 Agent, every session is Code's, delegations or not, waiting first.
    expect(listedSessions(all, [], { filter: 'all', search: '', folded }).map(item => item.id)).toEqual(['a5', 'a2', 'c1'])
  })

  it('lists recent delegations newest first, archived left out, up to the limit', () => {
    const many = Array.from({ length: 9 }, (_, index) => delegated(`a${index + 1}`))
    expect(recentDelegations(many).map(item => item.id)).toEqual(['a9', 'a8', 'a7', 'a6', 'a5', 'a4'])
    expect(recentDelegations(tasks).map(item => item.id)).toEqual(['a2'])
    expect(recentDelegations(many, 9)).toHaveLength(9)
  })

  it('counts what waits in each place, only what that place can list', () => {
    const snapshot = {
      tasks: [task('c1', { status: 'waiting-approval' }), delegated('a2', { status: 'running', pendingQuestions: 1 }), task('c3')],
      approvals: [approval('a2'), approval('outside')],
    }
    // An approval for a session no list holds counts in the total (the Dock), in neither place.
    expect(waitingCount(snapshot)).toBe(3)
    expect(waitingCount(snapshot, 'code')).toBe(1)
    expect(waitingCount(snapshot, 'agents')).toBe(1)
    // The dot goes on the other place, never on the one shown.
    expect(waitsElsewhere({ tasks: [delegated('a', { status: 'waiting-approval' })], approvals: [] }, 'code')).toBe(true)
    expect(waitsElsewhere({ tasks: [delegated('a', { status: 'waiting-approval' })], approvals: [] }, 'agents')).toBe(false)
    expect(otherSpace('code')).toBe('agents')
  })

  it('follows the open session to its place, keeps the last place on shared pages, and has only Code without 我的 Agent', () => {
    const base = { agents: true, selectedId: null, selected: undefined, remembered: 'agents' as const }
    expect(currentSpace({ ...base, entry: 'agents' })).toBe('agents')
    expect(currentSpace({ ...base, entry: 'sessions' })).toBe('code')
    expect(currentSpace({ ...base, entry: 'sessions', selectedId: 'a', selected: delegated('a') })).toBe('agents')
    expect(currentSpace({ ...base, entry: 'sessions', selectedId: 'c', selected: task('c'), remembered: 'agents' })).toBe('code')
    // A session the Host has not listed yet (a delegation just sent) stays where it was sent from.
    expect(currentSpace({ ...base, entry: 'sessions', selectedId: 'new' })).toBe('agents')
    expect(currentSpace({ ...base, entry: 'settings' })).toBe('agents')
    expect(currentSpace({ ...base, entry: 'apps', remembered: 'code' })).toBe('code')
    expect(currentSpace({ ...base, agents: false, entry: 'agents' })).toBe('code')
  })

  it('remembers the place per device and opens a wide window there on a cold start', () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:4317' })
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    })
    const key = spaceKey('device-1')
    expect(readSpace(key)).toBe('code')
    writeSpace(key, 'agents')
    expect(readSpace(key)).toBe('agents')
    expect(readSpace(spaceKey('device-2'))).toBe('code')
    expect(initialRoute('device-1', true, true, false)).toEqual({ entry: 'agents' })
    // A restored session keeps its own place; a phone starts on its list; without 我的 Agent there is only Code.
    expect(initialRoute('device-1', true, true, true)).toEqual({ entry: 'sessions' })
    expect(initialRoute('device-1', true, false, false)).toEqual({ entry: 'sessions' })
    expect(initialRoute('device-1', false, true, false)).toEqual({ entry: 'sessions' })
    stored.set(key, 'something else')
    expect(readSpace(key)).toBe('code')
  })
})

describe("every delegation in exactly one of 我的 Agent's lists", () => {
  it("keeps archived delegations under 我的 Agent's 已归档, out of 最近委托 and out of Code", () => {
    const tasks = [delegated('a1'), delegated('a2', { archived: true }), task('c3', { archived: true })]
    expect(delegationRows(tasks)).toEqual({ rows: [tasks[0]], total: 1, archived: 1 })
    expect(delegationRows(tasks, { filter: 'archived' }).rows.map(item => item.id)).toEqual(['a2'])
    expect(filterSessions(tasks, 'archived', '', 'code').map(item => item.id)).toEqual(['c3'])
    // Each delegation is listed once: in 最近委托 (with 全部) or under 已归档.
    const many = [...Array.from({ length: 8 }, (_, index) => delegated(`a${index + 10}`)), delegated('a3', { archived: true })]
    const recent = delegationRows(many, { expanded: true }).rows.map(item => item.id)
    const archived = delegationRows(many, { filter: 'archived' }).rows.map(item => item.id)
    expect([...recent, ...archived].toSorted()).toEqual(many.map(item => item.id).toSorted())
  })

  it('lifts what waits to the top of 最近委托, archived or not, and never cuts it with 全部', () => {
    const quiet = Array.from({ length: 8 }, (_, index) => delegated(`a${index + 20}`))
    const old = delegated('a1', { status: 'waiting-approval' })
    const shelved = delegated('a2', { status: 'waiting-approval', archived: true })
    const { rows, total } = delegationRows([...quiet, old, shelved])
    expect(rows.slice(0, 2).map(item => item.id)).toEqual(['a2', 'a1'])
    expect(rows).toHaveLength(6)
    expect(total).toBe(10)
    // Archived and waiting, as in Code's 等你处理: in 最近委托, and counted for the dot.
    expect(waitingCount({ tasks: [shelved], approvals: [] }, 'agents')).toBe(1)
    const crowd = Array.from({ length: 8 }, (_, index) => delegated(`a${index + 30}`, { status: 'waiting-approval' }))
    expect(delegationRows(crowd).rows).toHaveLength(8)
  })

  it('keeps the delegations of a deleted Agent, under the name it can still give', () => {
    const gone = delegated('a1', { agent: { customAgentId: 'gone' } })
    expect(recentDelegations([gone]).map(item => item.id)).toEqual(['a1'])
    expect(delegationAgent([], gone)).toBe('已删除的 Agent')
    expect(delegationAgent([{ id: 'gone', name: '周报' } as never], gone)).toBe('周报')
    // While the summaries are away (a write being confirmed) it says only Agent.
    expect(delegationAgent(undefined, gone)).toBe('Agent')
  })

  it('goes back from a delegation to its Agent, or to the list once the Agent is gone', () => {
    expect(backRoute(delegated('a'), [{ id: 'review' }], true)).toEqual({ entry: 'agents', myAgent: { id: 'review', tab: 'delegate' } })
    expect(backRoute(delegated('a'), [], true)).toEqual({ entry: 'agents' })
    expect(backRoute(delegated('a'), undefined, true)).toEqual({ entry: 'agents' })
    expect(backRoute(task('c'), [{ id: 'review' }], true)).toBeNull()
    expect(backRoute(delegated('a'), [{ id: 'review' }], false)).toBeNull()
  })

  it('steps the keys through the rows 我的 Agent shows: 全部 when open, 已归档 when chosen', () => {
    const folded = new Set<string>()
    const quiet = Array.from({ length: 8 }, (_, index) => delegated(`a${index + 20}`))
    const all = [...quiet, delegated('a1', { archived: true })]
    const keys = (options: { filter?: 'all' | 'archived'; expanded?: boolean }) =>
      listedSessions(all, [], { filter: 'all', search: '', folded, space: 'agents', ...options }).map(item => item.id)
    expect(keys({})).toEqual(['a27', 'a26', 'a25', 'a24', 'a23', 'a22'])
    expect(keys({ expanded: true })).toHaveLength(8)
    expect(keys({ filter: 'archived' })).toEqual(['a1'])
  })
})

describe('going between the places', () => {
  const tasks = [task('c1'), delegated('a2'), delegated('a3', { archived: true })]

  it("goes back to the session a place was left on, while it is still that place's", () => {
    const move = (target: 'code' | 'agents', left: Parameters<typeof spaceMove>[0]['left'], selectedId: string | null = null) =>
      spaceMove({ target, left, selected: tasks.find(item => item.id === selectedId), selectedId, tasks })
    expect(move('agents', { kind: 'session', id: 'a2' }, 'c1')).toEqual({ route: { entry: 'sessions' }, choose: 'a2' })
    expect(move('code', { kind: 'session', id: 'c1' }, 'a2')).toEqual({ route: { entry: 'sessions' }, choose: 'c1' })
    // Code keeps an open session of its own under a page.
    expect(move('code', undefined, 'c1')).toEqual({ route: { entry: 'sessions' } })
    // Archived since, or never left: home, the new-session page or the list (or the page it was left on).
    expect(move('agents', { kind: 'session', id: 'a3' }, 'c1')).toEqual({ route: { entry: 'agents' } })
    expect(move('code', undefined, 'a2')).toEqual({ route: { entry: 'sessions' }, choose: null })
    expect(move('agents', { kind: 'page', myAgent: { id: 'review', tab: 'memory' } })).toEqual({
      route: { entry: 'agents', myAgent: { id: 'review', tab: 'memory' } },
    })
  })

  it('chooses no place on 应用 and 设置, so either segment goes back to its place', () => {
    const shell = (entry: 'sessions' | 'agents' | 'apps' | 'settings') => ({
      entries: ['sessions', 'agents', 'apps', 'settings'] as const,
      space: 'agents' as const,
      goSpace: () => {},
      waits: { code: false, agents: false },
      route: { entry },
    })
    expect(shellSpaces(shell('apps') as never)?.space).toBeNull()
    expect(shellSpaces(shell('settings') as never)?.space).toBeNull()
    expect(shellSpaces(shell('agents') as never)?.space).toBe('agents')
    expect(shellSpaces({ ...shell('sessions'), entries: ['sessions'] } as never)).toBeUndefined()
  })

  it('draws no dot while nothing waits, and one only where something does', () => {
    expect(placeWaits({ tasks: [task('c1'), delegated('a2')], approvals: [] }, true)).toEqual({ code: false, agents: false })
    expect(placeWaits({ tasks: [delegated('a2', { status: 'waiting-approval' })], approvals: [] }, true)).toEqual({
      code: false,
      agents: true,
    })
    expect(placeWaits({ tasks: [delegated('a2', { status: 'waiting-approval' })], approvals: [] }, false)).toEqual({
      code: false,
      agents: false,
    })
  })
})

describe('the 我的 Agent mark', () => {
  it('is the curly-brace face with dot eyes, moved onto the 16 grid of the glyphs, in one colour', () => {
    const html = renderToStaticMarkup(createElement(AgentsGlyph, { size: 16 }))
    const paths = [...html.matchAll(/<path d="([^"]+)"/gu)].map(match => match[1]!)
    expect(paths).toHaveLength(2)
    // The face's own braces, every point shifted by the same crop and scaled from 24 units onto the glyph's 16.
    const first = BRACKET_PATHS.curly[0].match(/-?\d+(?:\.\d+)?/gu)!.map(Number)
    const moved = paths[0]!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number)
    expect(moved.map((value, index) => Math.round((value * 1.5 + (index % 2 === 0 ? 8 : 8.5) - first[index]!) * 10) / 10 + 0)).toEqual(
      first.map(() => 0),
    )
    expect(html.match(/<circle /gu)).toHaveLength(2)
    expect(html).toContain('fill="currentColor"')
    expect(html).not.toMatch(/Q/u)
    expect(html).toContain('aria-hidden="true"')
  })
})
