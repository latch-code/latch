import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { testHarness } from '@latch/testkit'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot, CustomAgentSummary, HostCatalog, TaskSummary } from '@latch/protocol'
import { AgentsSpaceList, currentAgent, faceState, RosterMark } from '../src/agents/AgentsSpaceList.tsx'
import { AgentsHome } from '../src/agents/AgentsHome.tsx'
import {
  addressee,
  agentsOverview,
  defaultAddressee,
  queueOrder,
  rosterRows,
  rosterTopics,
  topicState,
  topicTree,
  TREE_TOPICS,
  waitingTopic,
} from '../src/agents/roster.ts'
import { TopicFrame } from '../src/agents/TopicFrame.tsx'
import { shellOverview } from '../src/shell/SpaceNav.tsx'
import type { ShellState } from '../src/shell/useShellLayout.tsx'
import { workGroups } from '../src/shell/workOverview.ts'

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

const topic = (id: string, owner: string, minute: number, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  harnessId: 'standard',
  id,
  title: `话题 ${id}`,
  status: 'idle',
  updatedAt: at(minute),
  ...(owner === 'general' ? { generalChat: true } : { agent: { customAgentId: owner } }),
  ...extra,
})

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
    expect(queueOrder(rows)[0].id).toBe('man')
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

describe('the queue of people', () => {
  it('puts who waits for you first, then who works, then whoever was last heard from', () => {
    const agents = [agent('a', '甲'), agent('b', '乙'), agent('c', '丙'), agent('d', '丁'), agent('e', '戊')]
    const rows = rosterRows(
      snapshot(
        [
          topic('a1', 'a', 50),
          topic('b1', 'b', 10, { status: 'running', live: live('tool') }),
          topic('c1', 'c', 5, { status: 'waiting-approval', live: live('approval') }),
          topic('d1', 'd', 20, { status: 'failed' }),
          topic('g1', 'general', 30),
        ],
        agents,
      ),
    )
    // 戊 has no topic: last, in the roster's order. A failure does not jump the queue; it sorts by recency.
    expect(queueOrder(rows).map(row => row.name)).toEqual(['丙', '乙', '甲', '通用', '丁', '戊'])
  })

  it('orders several who wait, and several who work, by recency, and leaves the roster itself as it was', () => {
    const agents = [agent('a', '甲'), agent('b', '乙'), agent('c', '丙')]
    const waiting = { status: 'waiting-approval' as const, live: live('approval') }
    const rows = rosterRows(snapshot([topic('a1', 'a', 1, waiting), topic('b1', 'b', 9, waiting), topic('c1', 'c', 5, waiting)], agents), {
      general: false,
    })
    expect(queueOrder(rows).map(row => row.name)).toEqual(['乙', '丙', '甲'])
    expect(rows.map(row => row.name)).toEqual(['甲', '乙', '丙'])
  })
})

describe('the topics on an Agent’s tree', () => {
  const many = Array.from({ length: 9 }, (_, index) => topic(`t${index}`, 'man', 60 - index))

  it('shows the newest few and folds the rest into 「还有 N 个」', () => {
    const tree = topicTree(many)
    expect(tree.shown.map(task => task.id)).toEqual(['t0', 't1', 't2', 't3', 't4'])
    expect(tree.shown).toHaveLength(TREE_TOPICS)
    expect(tree.hidden).toBe(4)
    expect(topicTree(many, { expanded: true })).toMatchObject({ hidden: 0 })
    expect(topicTree(many.slice(0, 3))).toMatchObject({ hidden: 0 })
  })

  it('never folds away the open topic or one that waits for you', () => {
    const waiting = many.map(task => (task.id === 't8' ? { ...task, status: 'waiting-approval' as const, live: live('approval') } : task))
    const tree = topicTree(waiting, { selectedId: 't6' })
    expect(tree.shown.map(task => task.id)).toEqual(['t0', 't1', 't2', 't3', 't4', 't6', 't8'])
    expect(tree.hidden).toBe(2)
    expect(topicTree(many, { asking: new Set(['t7']) }).shown.map(task => task.id)).not.toContain('t7')
    const asked = many.map(task => (task.id === 't7' ? { ...task, status: 'running' as const } : task))
    expect(topicTree(asked, { asking: new Set(['t7']) }).shown.map(task => task.id)).toContain('t7')
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

  it('groups only topics: what waits for you (approvals first), who works, and the runs that completed', () => {
    const work = agentsOverview(tasks)
    expect(work.attention.map(task => task.id)).toEqual(['wait', 'ask', 'fail'])
    expect(work.running.map(task => task.id)).toEqual(['run'])
    // A topic never run, one that was stopped and an archived one are not results.
    expect(work.results.map(task => task.id)).toEqual(['done', 'done-old'])
  })

  it('keeps a stop that has not settled among those working, and a topic in one group only', () => {
    const work = agentsOverview(tasks, new Set(['wait']))
    expect(work.attention.map(task => task.id)).toEqual(['ask', 'fail'])
    expect(work.running.map(task => task.id)).toEqual(['wait', 'run'])
    const all = [...work.attention, ...work.running, ...work.results].map(task => task.id)
    expect(new Set(all).size).toBe(all.length)
  })

  it('leaves Code’s 总览 to Code’s sessions', () => {
    expect(workGroups(tasks).flatMap(group => group.tasks.map(task => task.id))).toEqual(['code'])
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
  const shell = (layout: 'overview' | 'triage', extra: Partial<ShellState> = {}) =>
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
      preferences: { workbenchLayout: layout },
      access: { scopes: new Set(['run', 'view']) },
      ...extra,
    }) as unknown as ShellState
  const list = (layout: 'overview' | 'triage', extra: Partial<ShellState> = {}, rail = false) =>
    renderToStaticMarkup(createElement(AgentsSpaceList, { shell: shell(layout, extra), rail }))

  it('侧栏: hangs the topics under the Agent in view only, the open one selected, and never names a Harness or model', () => {
    const html = list('overview')
    expect(html).toContain('data-people="roster"')
    expect(html).toContain('aria-label="小满 的话题"')
    expect(html).not.toContain('老周 的话题')
    expect(html).toMatch(/data-task-id="m1" aria-current="page"/u)
    expect(html).toContain('上周没看的 PR')
    // The row says its state by icon alone: the word is the header's, written once.
    expect(html).not.toMatch(/>等你点头</u)
    expect(html).not.toMatch(ENGINE_WORDS)
    // On the space's 总览 nobody is in view, so no tree hangs.
    expect(list('overview', { route: { entry: 'agents' } } as never)).not.toContain('agent-tree')
  })

  it('顶栏: a queue sorted by who waits, with the person-words on the second line and 新建 Agent leading its rail', () => {
    const html = list('triage', {}, true)
    expect(html).toContain('data-people="queue"')
    const order = (markup: string) => [...markup.matchAll(/data-agent-id="([^"]+)"/gu)].map(match => match[1])
    // The roster keeps the Host's order; the queue puts who waits first, then who works, then the newest.
    expect(order(list('overview'))).toEqual(['review', 'zhou', 'man', 'long', 'general'])
    expect(order(html)).toEqual(['man', 'zhou', 'review', 'long', 'general'])
    expect(html).not.toMatch(ENGINE_WORDS)
    expect(html).toMatch(/data-tone="waiting"[^]*等你点头/u)
    expect(html).toMatch(/data-tone="running"[^]*在跑命令/u)
    expect(html).toContain('新建 Agent')
    expect(html).not.toContain('agent-tree')
    // Under the drawer's own nav rows the queue does not repeat 新建 Agent; a device that cannot run has none.
    expect(list('triage')).not.toContain('agent-queue-new')
    expect(list('triage', { access: { scopes: new Set(['view']) } } as never, true)).not.toContain('agent-queue-new')
  })

  it('shows a device without the full data scope that Agents are locked, and no people', () => {
    const locked = { ...shell('overview').snapshot, device: { id: 'd1', dataScope: 'conversation' } }
    const html = list('overview', { snapshot: locked } as never)
    expect(html).toContain('这台设备看不到 Agent')
    expect(html).not.toContain('小满')
  })

  it('says there are no Agents yet beside 通用, which is always there', () => {
    const none = { ...snapshot([], []), device: { id: 'd1', dataScope: 'all' } }
    const html = list('overview', { snapshot: none, selectedId: null } as never)
    expect(html).toContain('还没有自己的 Agent')
    expect(html).toContain('通用')
  })

  it('finds the Agent in view from the open topic or the new topic, and none on the 总览 or under Code’s home', () => {
    const base = shell('overview')
    expect(currentAgent(base)).toBe('man')
    expect(currentAgent({ ...base, route: { entry: 'agents', myAgent: { id: 'zhou', topic: 'new' } } })).toBe('zhou')
    expect(currentAgent({ ...base, route: { entry: 'agents' } })).toBeUndefined()
    expect(currentAgent({ ...base, route: { entry: 'agents', myAgent: { id: 'new' } } })).toBeUndefined()
    expect(currentAgent({ ...base, route: { entry: 'sessions', overview: true } })).toBeUndefined()
  })
})

describe('总览 in the navigation', () => {
  const calls: string[] = []
  const shell = (space: 'code' | 'agents', route: ShellState['route'], agents = true) => ({
    space,
    route,
    entries: (agents ? ['sessions', 'agents'] : ['sessions']) as ShellState['entries'],
    openOverview: () => calls.push('code'),
    openMyAgent: () => calls.push('agents'),
  })

  it('leads to the space’s own 总览 in 我的 Agent and to Code’s home in Code', () => {
    const inTopic = shellOverview(shell('agents', { entry: 'sessions' }))
    expect(inTopic.active).toBe(false)
    inTopic.open()
    expect(shellOverview(shell('agents', { entry: 'agents' })).active).toBe(true)
    expect(shellOverview(shell('agents', { entry: 'agents', topics: true })).active).toBe(false)
    expect(shellOverview(shell('agents', { entry: 'agents', myAgent: { id: 'new' } })).active).toBe(false)
    const code = shellOverview(shell('code', { entry: 'sessions', overview: true }))
    expect(code.active).toBe(true)
    code.open()
    shellOverview(shell('agents', { entry: 'sessions' }, false)).open()
    expect(calls).toEqual(['agents', 'code', 'code'])
  })
})

describe('the topic header', () => {
  const frame = (layout: 'overview' | 'triage', extra: Partial<ShellState> = {}, agents = [agent('man', '小满')]) => {
    const tasks = [topic('m1', 'man', 9, { title: '今天的晨报', status: 'running', live: live('command') })]
    const shell = {
      snapshot: { ...snapshot(tasks, agents), automations: [] },
      catalog: undefined,
      connection: 'connected',
      phone: false,
      drawerMode: false,
      sidebarCollapsed: false,
      preferences: { workbenchLayout: layout },
      access: { scopes: new Set(['run']) },
      current: null,
      profileShown: null,
      selectedId: 'm1',
      owner: true,
      ...extra,
    } as unknown as ShellState
    return renderToStaticMarkup(createElement(TopicFrame, { shell, owner: 'man', current: 'm1', title: '今天的晨报' }))
  }

  // The header's own state word; the closed 话题 menu lists each topic's state too, out of sight.
  const said = (html: string) => html.match(/class="ui-status-word agent-activity"[^>]*>(?:<[^>]*>)*在跑命令/gu) ?? []

  it('侧栏: the role line, one state word in the person’s words, and the switcher named by the open topic', () => {
    const html = frame('overview')
    expect(html).toContain('小满的职责')
    expect(said(html)).toHaveLength(1)
    expect(html).toContain('aria-label="话题"')
    expect(html).toContain('今天的晨报')
    expect(html).not.toMatch(/standard|Harness|模型/u)
  })

  it('顶栏: leaves the state to the queue beside it, and says it itself once the queue is out of sight', () => {
    expect(said(frame('triage'))).toHaveLength(0)
    expect(said(frame('triage', { drawerMode: true } as never))).toHaveLength(1)
    expect(said(frame('triage', { sidebarCollapsed: true } as never))).toHaveLength(1)
  })

  it('says 不可用 with the reason and a way to repair for an Agent whose Harness is missing or too old', () => {
    const old = [agent('man', '小满', { available: false, unavailableReason: 'OpenCode 需要 1.2 或更高版本' })]
    const idle = { snapshot: { ...snapshot([topic('m1', 'man', 9)], old), automations: [] } }
    const html = frame('overview', idle as never, old)
    expect(html).toContain('不可用')
    expect(html).toContain('为什么不可用')
    expect(html).toContain('去修复')
    // A device that cannot change 设置 is told where, without a button it could not use.
    expect(frame('overview', { ...idle, owner: false } as never, old)).not.toContain('去修复')
  })

  it('keeps the topic of a deleted Agent readable under 已删除的 Agent, and lets no new topic start', () => {
    const html = frame('overview', {}, [])
    expect(html).toContain('已删除的 Agent')
    expect(html).toContain('data-tone="neutral">已删除')
    expect(said(html)).toHaveLength(0)
    expect(html).toContain('这个 Agent 已删除')
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
          preferences: { workbenchLayout: 'overview' },
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
