import { describe, expect, it } from 'vitest'
import type { AppSnapshot, HostCatalog, TaskSummary } from '@latch/protocol'
import {
  agentTopics,
  generalMode,
  generalSubmission,
  newTopicShowing,
  openAgent,
  isPersonalChat,
  ownerName,
  profileSection,
  topicOwner,
  topicWords,
} from '../src/agents/chat.ts'
import { agentActivity, agentSessions, sessionAgent } from '../src/agents/model.ts'
import { delegationRows, spaceOf } from '../src/sessions.ts'
import { submissionRequest } from '../src/core/api.ts'
import { markMounted } from '../src/hooks/useMounted.ts'

const task = (id: string, minute: number, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  harnessId: 'standard',
  id,
  title: `话题 ${id}`,
  status: 'idle',
  updatedAt: new Date(2026, 10, 12, 9, minute).toISOString(),
  ...extra,
})
const mine = (id: string, minute: number, extra: Partial<TaskSummary> = {}) =>
  task(id, minute, { agent: { customAgentId: 'agt_a' }, ...extra })
const general = (id: string, minute: number, extra: Partial<TaskSummary> = {}) => task(id, minute, { generalChat: true, ...extra })

describe('topics', () => {
  const tasks = [
    mine('a1', 1),
    mine('a2', 5),
    mine('a3', 9, { archived: true }),
    task('c1', 20),
    general('g1', 3),
    general('g2', 2, { archived: true }),
    task('o1', 30, { agent: { customAgentId: 'agt_b' } }),
  ]

  it('names the owner: one of yours, 通用 for a conversation with it, none for Code', () => {
    expect(topicOwner(mine('x', 0))).toBe('agt_a')
    expect(topicOwner(general('x', 0))).toBe('general')
    expect(topicOwner(task('x', 0))).toBeUndefined()
    expect(topicOwner(undefined)).toBeUndefined()
    // A conversation with 通用 is 我的 Agent's, not Code's.
    expect(spaceOf(general('x', 0))).toBe('agents')
    expect(spaceOf(task('x', 0))).toBe('code')
    expect(delegationRows(tasks).rows.map(item => item.id)).toEqual(['o1', 'a2', 'g1', 'a1'])
  })

  it('groups retained history by owner and keeps archived records apart', () => {
    expect(agentTopics(tasks, 'agt_a')).toEqual({ open: [tasks[1], tasks[0]], archived: [tasks[2]] })
    expect(agentSessions(tasks, 'agt_a').map(item => item.id)).toEqual(['a2', 'a1'])
    expect(agentTopics(tasks, 'general').archived.map(item => item.id)).toEqual(['g2'])
    // A schedule run remains reachable through its owner’s history.
    const withRun = [...tasks, mine('r1', 40, { automationId: 'aut_1' })]
    expect(agentTopics(withRun, 'agt_a').open.map(item => item.id)).toEqual(['r1', 'a2', 'a1'])
  })

  it('says what a topic is doing as its helper does', () => {
    expect(topicWords(mine('r', 0, { status: 'running' }), false)).toBe('运行中')
    const live = { runId: 'x', activity: 'command' as const, since: '', lastEventAt: '' }
    expect(topicWords(mine('r', 0, { status: 'running', live }), false)).toBe('在跑命令')
    expect(topicWords(mine('w', 0, { status: 'waiting-approval' }), false)).toBe('等你点头')
    expect(topicWords(mine('f', 0, { status: 'failed' }), false)).toBe('失败')
    expect(topicWords(mine('i', 0), false)).toBeUndefined()
    // Offline nothing live is said.
    expect(topicWords(mine('r', 0, { status: 'running' }), true)).toBeUndefined()
  })

  it('gives a face its state from its own topics, 通用 included', () => {
    const snapshot = { tasks: [general('g', 1, { status: 'running' })], approvals: [] }
    expect(agentActivity(snapshot, { id: 'general', available: true })).toBe('running')
    expect(agentActivity(snapshot, { id: 'agt_a', available: true })).toBe('idle')
    expect(sessionAgent({ customAgents: [] }, general('g', 1))).toEqual({ id: 'general', name: '通用' })
    expect(sessionAgent({ customAgents: [] }, mine('a', 1))?.name).toBe('已删除的 Agent')
    expect(sessionAgent({ customAgents: undefined }, mine('a', 1))?.name).toBe('Agent')
    expect(ownerName([{ id: 'agt_a', name: '资料助手' }], 'agt_a')).toBe('资料助手')
  })
})

describe('links into 我的 Agent', () => {
  const snapshot: Pick<AppSnapshot, 'catalog' | 'agentChats'> = {
    catalog: { features: { singleAgentChat: true } } as HostCatalog,
    agentChats: {
      agt_a: { state: 'ready', sessionId: 'a1' },
      general: { state: 'ready', sessionId: 'g1' },
      agt_none: { state: 'empty' },
      agt_wait: { state: 'starting' },
    },
  }

  it('opens the authoritative chat even when history moved and ignores a legacy new-topic link', () => {
    expect(openAgent({ id: 'agt_a' }, snapshot)).toEqual({ kind: 'topic', sessionId: 'a1', owner: 'agt_a' })
    expect(openAgent({ id: 'general' }, snapshot)).toEqual({ kind: 'topic', sessionId: 'g1', owner: 'general' })
    expect(openAgent({ id: 'agt_none' }, snapshot)).toEqual({ kind: 'page', target: { id: 'agt_none' } })
    expect(openAgent({ id: 'agt_wait' }, snapshot)).toEqual({ kind: 'page', target: { id: 'agt_wait' } })
    expect(openAgent({ id: 'agt_a', topic: 'new' }, snapshot)).toEqual({ kind: 'topic', sessionId: 'a1', owner: 'agt_a' })
    expect(openAgent({ id: 'agt_a' }, { agentChats: snapshot.agentChats })).toEqual({ kind: 'page', target: { id: 'agt_a' } })
    expect(isPersonalChat(snapshot, mine('a1', 1))).toBe(true)
    expect(isPersonalChat(snapshot, mine('r1', 40, { automationId: 'aut_1' }))).toBe(false)
    expect(openAgent(undefined, snapshot)).toEqual({ kind: 'page' })
    expect(openAgent({ id: 'new' }, snapshot)).toEqual({ kind: 'page', target: { id: 'new' } })
  })

  it('opens the profile at the section an old tab names; the old 委托 tab is the conversation', () => {
    expect(openAgent({ id: 'agt_a', tab: 'memory' }, snapshot)).toEqual({
      kind: 'topic',
      sessionId: 'a1',
      owner: 'agt_a',
      section: 'memory',
    })
    expect(openAgent({ id: 'agt_none', tab: 'schedules' }, snapshot)).toEqual({
      kind: 'page',
      target: { id: 'agt_none' },
      section: 'schedules',
    })
    expect(openAgent({ id: 'agt_a', tab: 'settings' }, snapshot)).toMatchObject({ section: 'settings' })
    expect(openAgent({ id: 'agt_a', tab: 'delegate' }, snapshot)).toEqual({ kind: 'topic', sessionId: 'a1', owner: 'agt_a' })
    expect(profileSection('delegate')).toBeUndefined()
    expect(profileSection(undefined)).toBeUndefined()
  })
})

describe('a new topic with 通用', () => {
  it('starts a new 通用 topic in Standard Agent mode, independently of other Harness choices', () => {
    const submission = generalSubmission({
      model: { providerId: 'p', model: 'm' },
      prompt: '你好',
    })
    expect(submission).toEqual({
      customAgentId: 'general',
      prompt: '你好',
      mode: 'agent',
      harnessId: 'standard',
      workspaceId: 'default',
      model: { providerId: 'p', model: 'm' },
    })
    expect(submissionRequest({ ...submission, requestId: 'r1' }).body).toMatchObject({ customAgentId: 'general', mode: 'agent' })
    expect(generalSubmission({ model: undefined, prompt: 'x' })).toEqual({
      customAgentId: 'general',
      prompt: 'x',
      mode: 'agent',
      harnessId: 'standard',
      workspaceId: 'default',
    })
    expect(generalMode()).toBe('agent')
  })
})

describe('an answered start', () => {
  it('opens its topic only while that Agent’s new topic is still shown', () => {
    expect(newTopicShowing({ entry: 'agents', myAgent: { id: 'agt_a', topic: 'new' } }, 'agt_a')).toBe(true)
    // Moved to another session, another Agent, the list or 设置 before the answer: stays there.
    expect(newTopicShowing({ entry: 'sessions' }, 'agt_a')).toBe(false)
    expect(newTopicShowing({ entry: 'agents', myAgent: { id: 'agt_b', topic: 'new' } }, 'agt_a')).toBe(false)
    expect(newTopicShowing({ entry: 'agents' }, 'agt_a')).toBe(false)
    expect(newTopicShowing({ entry: 'settings' }, 'agt_a')).toBe(false)
  })
})

describe('a new topic still on screen when the Host answers', () => {
  it('counts as mounted after StrictMode mounts, unmounts and mounts it again', () => {
    const mounted = { current: true }
    // StrictMode in development: effect, cleanup, effect.
    const first = markMounted(mounted)
    first()
    expect(mounted.current).toBe(false)
    const second = markMounted(mounted)
    expect(mounted.current).toBe(true)
    // Leaving for real lets an answer that arrives later stay unopened.
    second()
    expect(mounted.current).toBe(false)
  })
})
