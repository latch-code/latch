import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { testHarness } from '@latch/testkit'
import { describe, expect, it } from 'vitest'
import { waitKindOf, type AppSnapshot, type BoardPlace, type CustomAgentSummary, type HostCatalog, type TaskSummary } from '@latch/protocol'
import { AgentsSpaceList, currentAgent, faceState, RosterMark } from '../src/agents/AgentsSpaceList.tsx'
import { AgentsHome } from '../src/agents/AgentsHome.tsx'
import { addressee, agentsOverview, defaultAddressee, rosterRows, rosterTopics, topicState, waitingTopic } from '../src/agents/roster.ts'
import { TopicFrame } from '../src/agents/TopicFrame.tsx'
import { shellOverview } from '../src/shell/SpaceNav.tsx'
import type { ShellState } from '../src/shell/useShellLayout.tsx'

const at = (minute: number) => new Date(Date.UTC(2026, 10, 14, 9, minute)).toISOString()

const agent = (id: string, name: string, extra: Partial<CustomAgentSummary> = {}): CustomAgentSummary => ({
  id,
  name,
  description: `${name}的职责`,
  harnessId: 'standard',
  mode: 'agent',
  avatar: { kind: 'face', bracket: 'curly', eyes: 'dot', hue: 'pine' },
  revision: 1,
  skillCount: 0,
  memoryCount: 0,
  sessionCount: 0,
  available: true,
  canAutomate: true,
  ...extra,
})

/** The group the Host gives a topic with no markers: what a live run waits on, a live run, an unopened failure, or done. */
const placed = (task: TaskSummary): BoardPlace => {
  const wait = waitKindOf(task)
  if (wait) return { group: 'attention', reason: wait }
  if (task.status === 'running' || task.status === 'waiting-approval') return { group: 'running' }
  if (task.status === 'failed' || task.runOutcome === 'failed') return { group: 'attention', reason: 'failed' }
  return { group: 'done' }
}

const topic = (id: string, owner: string, minute: number, extra: Partial<TaskSummary> = {}): TaskSummary => {
  const task: TaskSummary = {
    harnessId: 'standard',
    id,
    title: `话题 ${id}`,
    status: 'idle',
    updatedAt: at(minute),
    ...(owner === 'general' ? { generalChat: true } : { agent: { customAgentId: owner } }),
    ...extra,
  }
  return extra.board ? task : { ...task, board: placed(task) }
}

const live = (activity: NonNullable<TaskSummary['live']>['activity']) => ({ activity, since: at(0) }) as NonNullable<TaskSummary['live']>

const snapshot = (tasks: TaskSummary[], agents: CustomAgentSummary[] | undefined, approvals: string[] = []) =>
  ({
    tasks,
    customAgents: agents,
    approvals: approvals.map(sessionId => ({ sessionId })),
  }) as unknown as Pick<AppSnapshot, 'tasks' | 'approvals' | 'customAgents'>

describe('the roster of 我的 Agent', () => {
  const agents = [agent('man', '小满'), agent('zhou', '老周'), agent('review', '审阅')]

  it('has one row per Agent in the Host’s order, then 通用, each with its open topics newest first', () => {
    const rows = rosterRows(
      snapshot(
        [
          topic('m1', 'man', 1),
          topic('m2', 'man', 5),
          topic('m3', 'man', 3, { archived: true }),
          topic('g1', 'general', 2),
          topic('c1', '', 9, { agent: undefined }),
        ],
        agents,
      ),
    )
    expect(rows.map(row => row.name)).toEqual(['小满', '老周', '审阅', '通用'])
    expect(rows[0].topics.map(task => task.id)).toEqual(['m2', 'm1'])
    expect(rows[0].updatedAt).toBe(at(5))
    expect(rows[1].topics).toEqual([])
    expect(rows[3].topics.map(task => task.id)).toEqual(['g1'])
    // A device that cannot read Agents is not offered 通用 either.
    expect(rosterRows(snapshot([], agents), { general: false }).map(row => row.id)).toEqual(['man', 'zhou', 'review'])
  })

  it('says a state only from the topics’ own events: waiting before working, a failure only of the newest topic', () => {
    const rows = rosterRows(
      snapshot(
        [
          topic('m1', 'man', 1, { status: 'running', live: live('command') }),
          topic('m2', 'man', 2, { status: 'waiting-approval', live: live('approval') }),
          topic('z1', 'zhou', 3, { status: 'running', live: live('command') }),
          topic('r1', 'review', 4, { status: 'failed' }),
          topic('g1', 'general', 5),
          topic('g0', 'general', 1, { status: 'failed' }),
        ],
        agents,
      ),
    )
    expect(rows.map(row => row.state)).toEqual(['waiting', 'running', 'failed', 'idle'])
    expect(rows[0].word).toEqual({ words: '等你点头', tone: 'waiting' })
    expect(rows[1].word).toEqual({ words: '在跑命令', tone: 'running' })
    // Nothing reported, nothing said.
    expect(rows[2].word).toBeUndefined()
    expect(rows[3].word).toBeUndefined()
  })

  it('counts an approval listed for a running topic as waiting, as the flag in the switch does', () => {
    const running = topic('m1', 'man', 1, { status: 'running', live: live('tool') })
    expect(topicState(running)).toBe('running')
    expect(topicState(running, new Set(['m1']))).toBe('waiting')
    expect(rosterRows(snapshot([running], agents, ['m1']))[0]!.state).toBe('waiting')
  })

  it('keeps an Agent that cannot start, with the Host’s reason, and still says what its topics do', () => {
    const old = agent('old', '旧版', { available: false, unavailableReason: 'OpenCode 需要 1.2 或更高版本' })
    const bare = agent('bare', '没装', { available: false })
    const rows = rosterRows(snapshot([topic('o1', 'old', 1, { status: 'running', live: live('model') })], [old, bare]), {
      generalBlocked: '先接上一个模型服务',
    })
    expect(rows[0]).toMatchObject({ unavailable: 'OpenCode 需要 1.2 或更高版本', state: 'running' })
    expect(rows[1]).toMatchObject({ unavailable: '现在不能开始', state: 'idle' })
    expect(rows[2]).toMatchObject({ id: 'general', unavailable: '先接上一个模型服务' })
    // An available Agent carries no reason.
    expect('unavailable' in rosterRows(snapshot([], agents))[0]).toBe(false)
  })

  it('keeps the topics of a deleted Agent under one row', () => {
    const tasks = [topic('x1', 'gone', 1), topic('x2', 'gone', 2), topic('m1', 'man', 3)]
    const rows = rosterRows(snapshot(tasks, agents))
    const gone = rows.at(-1)!
    expect(gone).toMatchObject({ id: 'gone', name: '已删除的 Agent', gone: true })
    expect(gone.topics.map(task => task.id)).toEqual(['x2', 'x1'])
    // Every open topic hangs under exactly one row.
    expect(
      rosterTopics(rows)
        .map(task => task.id)
        .toSorted(),
    ).toEqual(['m1', 'x1', 'x2'])
  })

  it('keeps every topic in sight while the Host withholds the list of Agents, under a neutral row, never called deleted', () => {
    const tasks = [
      topic('m1', 'man', 3, { status: 'waiting-approval', live: live('approval') }),
      topic('m2', 'man', 1),
      topic('z1', 'zhou', 2, { status: 'running', live: live('command') }),
      topic('g1', 'general', 4),
    ]
    const rows = rosterRows(snapshot(tasks, undefined))
    expect(rows.map(row => [row.id, row.name, row.gone, row.confirming ?? false])).toEqual([
      ['general', '通用', false, false],
      ['man', 'Agent', false, true],
      ['zhou', 'Agent', false, true],
    ])
    // What waits for you is still said, and still reachable: every open topic hangs under exactly one row.
    expect(rows.find(row => row.id === 'man')).toMatchObject({ state: 'waiting', word: { words: '等你点头' } })
    expect(
      rosterTopics(rows)
        .map(task => task.id)
        .toSorted(),
    ).toEqual(['g1', 'm1', 'm2', 'z1'])
    // A row nobody can name yet is not somebody to address.
    expect(defaultAddressee(rows)).toBe('general')
    // Once the list is back the same topics belong to their Agents again.
    expect(rosterRows(snapshot(tasks, agents)).some(row => row.confirming || row.gone)).toBe(false)
  })

  it('opens the approval first when a flagged person has several topics that wait, then the newest, as the 总览 orders them', () => {
    const asks = topic('ask-new', 'man', 9, { status: 'running', pendingQuestions: 1, live: live('model') })
    const approvalOld = topic('approve-old', 'man', 2, { status: 'waiting-approval', live: live('approval') })
    const approvalNew = topic('approve-new', 'man', 5, { status: 'waiting-approval', live: live('approval') })
    const idle = topic('idle', 'man', 10)
    const [row] = rosterRows(snapshot([asks, approvalOld, approvalNew, idle], agents))
    expect(row.topics[0].id).toBe('idle')
    expect(waitingTopic(row)?.id).toBe('approve-new')
    expect(agentsOverview([asks, approvalOld, approvalNew, idle]).attention.map(task => task.id)).toEqual([
      'approve-new',
      'approve-old',
      'ask-new',
    ])
    // Without an approval, the newest question; a stop that has not settled no longer waits; a failure is not a wait.
    expect(waitingTopic({ topics: [asks, idle] })?.id).toBe('ask-new')
    expect(waitingTopic({ topics: [approvalNew, asks] }, new Set(['approve-new']))?.id).toBe('ask-new')
    expect(waitingTopic({ topics: [topic('failed', 'man', 1, { status: 'failed' }), idle] })).toBeUndefined()
  })
})

describe('the space’s own 总览', () => {
  const tasks = [
    topic('wait', 'man', 9, { status: 'waiting-approval', live: live('approval') }),
    topic('ask', 'zhou', 8, { status: 'running', pendingQuestions: 1, live: live('model') }),
    topic('fail', 'review', 7, { status: 'failed' }),
    topic('run', 'zhou', 6, { status: 'running', live: live('command') }),
    topic('done', 'man', 5, { runOutcome: 'completed' }),
    topic('done-old', 'general', 2, { runOutcome: 'completed' }),
    topic('quiet', 'man', 4),
    topic('stopped', 'man', 3, { runOutcome: 'cancelled' }),
    topic('shelved', 'man', 10, { runOutcome: 'completed', archived: true }),
    { ...topic('code', '', 11, { status: 'waiting-approval' }), agent: undefined },
  ] as TaskSummary[]

  it('groups only topics: what waits for you (approvals first) and who works', () => {
    const work = agentsOverview(tasks)
    expect(work.attention.map(task => task.id)).toEqual(['wait', 'ask', 'fail'])
    expect(work.running.map(task => task.id)).toEqual(['run'])
  })

  it('keeps a stop that has not settled among those working, and a topic in one group only', () => {
    const work = agentsOverview(tasks, new Set(['wait']))
    expect(work.attention.map(task => task.id)).toEqual(['ask', 'fail'])
    expect(work.running.map(task => task.id)).toEqual(['wait', 'run'])
    const all = [...work.attention, ...work.running].map(task => task.id)
    expect(new Set(all).size).toBe(all.length)
  })

  it('groups by the Host: a failure the person has opened is no longer waiting', () => {
    const opened = topic('opened', 'man', 12, { status: 'failed', board: { group: 'done' } })
    expect(agentsOverview([...tasks, opened]).attention.map(task => task.id)).toEqual(['wait', 'ask', 'fail'])
  })

  it('keeps the chip where it was put: activity elsewhere never changes who the input addresses', () => {
    const agents = [agent('man', '小满'), agent('zhou', '老周')]
    const before = rosterRows(snapshot([topic('m1', 'man', 9), topic('z1', 'zhou', 3)], agents))
    // Picked once, when the 总览 opens.
    const picked = defaultAddressee(before)
    expect(picked).toBe('man')
    // 老周 stirs while the person types to 小满: the default would now be 老周, the chip is not.
    const after = rosterRows(snapshot([topic('m1', 'man', 9), topic('z1', 'zhou', 30, { status: 'running', live: live('tool') })], agents))
    expect(defaultAddressee(after)).toBe('zhou')
    expect(addressee(after, picked)?.id).toBe('man')
    // The person's own pick holds the same way, also when the picked one cannot start now (the input says why).
    expect(addressee(after, 'general')?.id).toBe('general')
    const blocked = rosterRows(snapshot([], [agent('man', '小满', { available: false })]))
    expect(addressee(blocked, 'man')).toMatchObject({ id: 'man', unavailable: '现在不能开始' })
    // Only when the picked Agent is gone does it move: to 通用, or the first of yours where 通用 is not offered.
    const deleted = rosterRows(snapshot([topic('m1', 'man', 9)], [agent('zhou', '老周')]))
    expect(addressee(deleted, 'man')?.id).toBe('general')
    expect(addressee(rosterRows(snapshot([], [agent('zhou', '老周')]), { general: false }), 'man')?.id).toBe('zhou')
    // While the list is withheld the unnamed rows are not addressable either.
    expect(addressee(rosterRows(snapshot([topic('m1', 'man', 9)], undefined)), 'man')?.id).toBe('general')
  })

  it('addresses the Agent last spoken with, else 通用, never a deleted one', () => {
    const agents = [agent('man', '小满'), agent('zhou', '老周')]
    expect(defaultAddressee(rosterRows(snapshot([topic('z1', 'zhou', 9), topic('m1', 'man', 3)], agents)))).toBe('zhou')
    expect(defaultAddressee(rosterRows(snapshot([], agents)))).toBe('general')
    expect(defaultAddressee(rosterRows(snapshot([topic('x1', 'gone', 9)], agents)))).toBe('general')
    expect(defaultAddressee(rosterRows(snapshot([], agents), { general: false }))).toBe('man')
  })
})

describe('what the rows draw', () => {
  const mark = (props: Parameters<typeof RosterMark>[0]) => renderToStaticMarkup(createElement(RosterMark, props))

  it('ends a row with an icon for the state and nothing at rest', () => {
    expect(mark({ state: 'idle', frozen: false })).toBe('')
    expect(mark({ state: 'waiting', frozen: false, words: '等你点头' })).toContain('data-tone="waiting"')
    expect(mark({ state: 'waiting', frozen: false, words: '等你点头' })).toContain('aria-label="等你点头"')
    expect(mark({ state: 'running', frozen: false, words: '在跑命令' })).toContain('data-tone="running"')
    expect(mark({ state: 'failed', frozen: false })).toContain('aria-label="失败"')
  })

  it('freezes the last state offline: muted, still, and labelled as the last one', () => {
    const frozen = mark({ state: 'running', frozen: true, words: '在跑命令' })
    expect(frozen).toContain('data-tone="neutral"')
    expect(frozen).toContain('上次状态：在跑命令')
    expect(faceState({ state: 'running' }, true)).toBe('idle')
    expect(faceState({ state: 'waiting' }, false)).toBe('waiting')
  })

  it('marks an Agent that cannot start with its reason, and rests its face', () => {
    const html = mark({ state: 'idle', frozen: false, unavailable: 'OpenCode 需要 1.2 或更高版本' })
    expect(html).toContain('不可用：OpenCode 需要 1.2 或更高版本')
    expect(html).toContain('data-tone="neutral"')
    expect(faceState({ state: 'idle', unavailable: '没装' }, false)).toBe('resting')
    // While one of its topics still works, the row says that.
    expect(faceState({ state: 'running', unavailable: '没装' }, false)).toBe('running')
  })

  const tasks = [
    topic('m1', 'man', 9, { title: '今天的晨报', status: 'waiting-approval', live: live('approval') }),
    topic('m2', 'man', 5, { title: '上周没看的 PR' }),
    topic('z1', 'zhou', 7, { status: 'running', live: live('command') }),
  ]
  // The Host's order is not the queue's: 老周 (working) is listed before 小满 (waiting), and 审阅 (idle, newest) first.
  const people = [
    agent('review', '审阅', { harnessId: 'codex' }),
    agent('zhou', '老周', { harnessId: 'codex' }),
    agent('man', '小满', { model: { providerId: 'deepseek', model: 'deepseek-chat' } }),
    agent('long', '一个名字特别特别长的 Agent 用来看省略'),
  ]
  const catalog: HostCatalog = {
    harnesses: [
      { ...testHarness('standard', { kind: 'builtin', label: 'Latch 内置' }), agentContext: 'private' },
      { ...testHarness('codex', { kind: 'agent', label: 'Codex' }), agentContext: 'first-turn' },
    ],
    providers: [{ id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', models: ['deepseek-chat'], defaultModel: 'deepseek-chat' }],
    workspaces: [{ id: 'default', name: 'start', path: '/work' }],
    defaults: { harnessId: 'standard', mode: 'agent', workspaceId: 'default', model: { providerId: 'deepseek', model: 'deepseek-chat' } },
  }
  const ENGINE_WORDS = /standard|codex|Codex|Latch 内置|DeepSeek|deepseek|Harness|模型/u
  const shell = (extra: Partial<ShellState> = {}) =>
    ({
      snapshot: {
        ...snapshot([...tasks, topic('r1', 'review', 30)], people),
        device: { id: 'd1', dataScope: 'all' },
        catalog,
      },
      catalog,
      connection: 'connected',
      route: { entry: 'sessions' },
      selectedId: 'm1',
      stopping: new Set<string>(),
      now: Date.UTC(2026, 10, 14, 10, 0),
      access: { scopes: new Set(['run', 'view']) },
      agentRemovals: { state: null, held: false, saving: false },
      ...extra,
    }) as unknown as ShellState
  const list = (extra: Partial<ShellState> = {}) => renderToStaticMarkup(createElement(AgentsSpaceList, { shell: shell(extra) }))

  it('selects one Agent row, and leaves its history out of the roster', () => {
    const html = list()
    expect(html).toContain('data-people="roster"')
    expect(html).toMatch(/data-agent-id="man" aria-current="page"/u)
    expect(html).not.toContain('agent-tree')
    expect(html).not.toContain('上周没看的 PR')
    // The row says its state by icon alone: the word is the header's, written once.
    expect(html).not.toMatch(/>等你点头</u)
    expect(html).not.toMatch(ENGINE_WORDS)
    expect(list({ route: { entry: 'agents' } } as never)).not.toContain('aria-current="page"')
  })

  it('offers row settings for every visible Agent and leaves General and view-only menus without deletion', () => {
    const html = list()
    expect(html).toContain('aria-label="更多操作：通用"')
    const generalMenu = html.slice(html.indexOf('role="menu" aria-label="通用 的操作"'))
    expect(generalMenu).toContain('data-label="设置"')
    expect(generalMenu).not.toContain('data-label="删除 Agent"')
    expect(html).toContain('data-label="删除 Agent"')
    expect(list({ access: { scopes: new Set(['view']) } } as never)).not.toContain('data-label="删除 Agent"')
  })

  it('shows a device without the full data scope that Agents are locked, and no people', () => {
    const locked = { ...shell().snapshot, device: { id: 'd1', dataScope: 'conversation' } }
    const html = list({ snapshot: locked } as never)
    expect(html).toContain('这台设备看不到 Agent')
    expect(html).not.toContain('小满')
  })

  it('says there are no Agents yet beside 通用, which is always there', () => {
    const none = { ...snapshot([], []), device: { id: 'd1', dataScope: 'all' } }
    const html = list({ snapshot: none, selectedId: null } as never)
    expect(html).toContain('还没有自己的 Agent')
    expect(html).toContain('通用')
  })

  it('finds the Agent in view from the open topic or the new topic, and none on the 总览 or under Code’s start screen', () => {
    const base = shell()
    expect(currentAgent(base)).toBe('man')
    expect(currentAgent({ ...base, route: { entry: 'agents', myAgent: { id: 'zhou', topic: 'new' } } })).toBe('zhou')
    expect(currentAgent({ ...base, route: { entry: 'agents' } })).toBeUndefined()
    expect(currentAgent({ ...base, route: { entry: 'agents', myAgent: { id: 'new' } } })).toBeUndefined()
    expect(currentAgent({ ...base, route: { entry: 'sessions', start: true } })).toBeUndefined()
  })
})

describe('总览 in the navigation', () => {
  const calls: string[] = []
  const shell = (space: 'code' | 'agents', route: ShellState['route'], agents = true) => ({
    space,
    route,
    entries: (agents ? ['sessions', 'agents'] : ['sessions']) as ShellState['entries'],
    openMyAgent: () => calls.push('agents'),
  })

  it('leads to the space’s own 总览 in 我的 Agent, and Code has none: 新会话 is its start screen', () => {
    const inTopic = shellOverview(shell('agents', { entry: 'sessions' }))
    expect(inTopic?.active).toBe(false)
    inTopic?.open()
    expect(shellOverview(shell('agents', { entry: 'agents' }))?.active).toBe(true)
    expect(shellOverview(shell('agents', { entry: 'agents', topics: true }))?.active).toBe(false)
    expect(shellOverview(shell('agents', { entry: 'agents', myAgent: { id: 'new' } }))?.active).toBe(false)
    expect(shellOverview(shell('code', { entry: 'sessions', start: true }))).toBeUndefined()
    expect(shellOverview(shell('agents', { entry: 'sessions' }, false))).toBeUndefined()
    expect(calls).toEqual(['agents'])
  })
})

describe('the topic header', () => {
  const frame = (extra: Partial<ShellState> = {}, agents = [agent('man', '小满')]) => {
    const tasks = [topic('m1', 'man', 9, { title: '今天的晨报', status: 'running', live: live('command') })]
    const shell = {
      snapshot: { ...snapshot(tasks, agents), automations: [] },
      catalog: undefined,
      connection: 'connected',
      phone: false,
      drawerMode: false,
      sidebarCollapsed: false,
      access: { scopes: new Set(['run']) },
      current: null,
      profileShown: null,
      selectedId: 'm1',
      owner: true,
      ...extra,
    } as unknown as ShellState
    return renderToStaticMarkup(createElement(TopicFrame, { shell, owner: 'man', current: 'm1', title: '今天的晨报' }))
  }

  // The header's own state word.
  const said = (html: string) => html.match(/class="ui-status-word agent-activity"[^>]*>(?:<[^>]*>)*在跑命令/gu) ?? []

  it('the role line, one state word and one identity entry', () => {
    const html = frame()
    expect(html).toContain('小满的职责')
    expect(said(html)).toHaveLength(1)
    expect(html).toContain('aria-label="小满 的资料"')
    expect(html).not.toContain('aria-label="话题"')
    expect(html).not.toMatch(/standard|Harness|模型/u)
  })

  it('says 不可用 with the reason and a way to repair for an Agent whose Harness is missing or too old', () => {
    const old = [agent('man', '小满', { available: false, unavailableReason: 'OpenCode 需要 1.2 或更高版本' })]
    const idle = { snapshot: { ...snapshot([topic('m1', 'man', 9)], old), automations: [] } }
    const html = frame(idle as never, old)
    expect(html).toContain('不可用')
    // The Host's reason is the word's tooltip, not an ⓘ beside it.
    expect(html).toMatch(
      /class="ui-hint-label" tabindex="0">不可用<\/span><span[^>]*role="tooltip"[^>]*><span>OpenCode 需要 1.2 或更高版本/u,
    )
    expect(html).toContain('去修复')
    // A device that cannot change 设置 is told where, without a button it could not use.
    expect(frame({ ...idle, owner: false } as never, old)).not.toContain('去修复')
  })

  it('keeps the topic of a deleted Agent readable under 已删除的 Agent, and lets no new topic start', () => {
    const html = frame({}, [])
    expect(html).toContain('已删除的 Agent')
    expect(html).toContain('data-tone="neutral">已删除')
    expect(said(html)).toHaveLength(0)
    expect(html).not.toContain('新话题')
  })
})

describe('the 总览 while the Host withholds the list of Agents', () => {
  // A device that only looks: the input is not drawn, so the page is the groups alone.
  const home = (agents: CustomAgentSummary[] | undefined, tasks: TaskSummary[]) =>
    renderToStaticMarkup(
      createElement(AgentsHome, {
        shell: {
          snapshot: { ...snapshot(tasks, agents), device: { id: 'd1', dataScope: 'all', scopes: ['view'] } },
          catalog: undefined,
          connection: 'offline',
          route: { entry: 'agents' },
          selectedId: null,
          stopping: new Set<string>(),
          statuses: new Map(),
          now: Date.UTC(2026, 10, 14, 10, 0),
          preferences: {},
          access: { scopes: new Set(['view']) },
          submission: { pending: null, sending: false },
          delegation: { sending: false, pending: null },
          lifecycle: {},
          audit: {},
        } as unknown as ShellState,
      }),
    )
  const waiting = topic('m1', 'man', 3, { status: 'waiting-approval', live: live('approval') })

  it('still draws what waits for you, instead of a skeleton', () => {
    const html = home(undefined, [waiting])
    expect(html).toContain('aria-label="等你处理"')
    expect(html).toContain('data-work-session="m1"')
    expect(html).not.toContain('agents-home-loading')
    // Nobody is called deleted, and nobody is told they have no Agents, while the list is not known.
    expect(html).not.toContain('已删除')
    expect(html).not.toContain('还没有自己的 Agent')
  })

  it('shows the skeleton only while there is nothing to draw, and the empty state only once the list is known', () => {
    expect(home(undefined, [])).toContain('agents-home-loading')
    expect(home([], [])).toContain('还没有自己的 Agent')
    expect(home([], [])).not.toContain('agents-home-loading')
  })
})
