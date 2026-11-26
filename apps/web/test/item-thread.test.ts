import { describe, expect, it } from 'vitest'
import type { Approval, ComputerSummary, CustomAgentSummary, TaskSummary, WorkPost, WorkPostRemote } from '@latch/protocol'
import {
  currentTarget,
  deliveryWords,
  matchTargets,
  mentionAt,
  postDecision,
  postPreview,
  postSourceVersion,
  postTarget,
  replySources,
  targetLabel,
  threadTargets,
  withoutMention,
  withoutMissingPostSources,
} from '../src/board/itemThread.ts'

import { remoteActions } from '../src/board/RemoteWorkPost.tsx'

const task = (id: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  harnessId: 'fake',
  id,
  title: id,
  status: 'idle',
  updatedAt: '2026-11-17T00:00:00.000Z',
  ...extra,
})
const agent = (id: string, name: string) => ({ id, name }) as CustomAgentSummary

it('leaves short posts intact and shows the first lines or complete characters of long posts', () => {
  expect(postPreview('发布说明已核对。')).toBeUndefined()
  expect(postPreview('版本\r\n 变更\n审阅\n回滚')).toBe('版本\r\n 变更\n审阅…')
  const first = '审'.repeat(95) + '👩‍💻'
  expect(postPreview(first + '回滚')).toBe(`${first}…`)
})

it('evicts the missing source from a complete listing while keeping the post and the delivery receipt', () => {
  const kept = { id: 'kept', at: '', text: '人的发言' }
  const linked: WorkPost = {
    id: 'post',
    at: '',
    text: '请核对版本',
    requestId: 'request-1',
    target: { sessionId: 's1' },
    delivery: { state: 'sent', sessionId: 's1' },
    turn: { sessionId: 's1', userMessageId: 'input' },
    reply: { messageId: 'reply', text: '审阅结果' },
  }
  const posts = [kept, linked]
  expect(withoutMissingPostSources(posts, { tasks: [] })).toBe(posts)
  expect(withoutMissingPostSources(posts, { tasks: [task('s1')], tasksComplete: true })).toBe(posts)
  const hidden = withoutMissingPostSources(posts, { tasks: [], tasksComplete: true })
  expect(hidden).toEqual([
    kept,
    { id: 'post', at: '', text: '请核对版本', requestId: 'request-1', delivery: { state: 'sent', sessionId: 's1' } },
  ])
  expect(withoutMissingPostSources(hidden, { tasks: [] })).toBe(hidden)
})

it('links a pending question only while its authorized session and run still match the read', () => {
  const source = task('s1', {
    status: 'running',
    runId: 'run-1',
    pendingQuestions: 1,
    board: { group: 'attention', reason: 'question' },
  })
  const post = {
    turn: { sessionId: source.id, userMessageId: 'input', runId: source.runId! },
    delivery: { sessionId: source.id, state: 'sent' },
    attention: { reason: 'question', decisionId: 'question-1' },
  } satisfies Pick<WorkPost, 'turn' | 'delivery' | 'attention'>
  const snapshot = { tasks: [source], approvals: [] }
  const version = postSourceVersion(source)
  expect(postDecision(post, snapshot, version)).toEqual({ kind: 'question', runId: 'run-1', id: 'question-1' })
  expect(postDecision(post, { ...snapshot, tasks: [] }, version)).toBeUndefined()
  expect(postDecision({ ...post, attention: { reason: 'question' } }, snapshot, version)).toBeUndefined()
  expect(postDecision({ ...post, turn: { ...post.turn, runId: 'another-run' } }, snapshot, version)).toBeUndefined()
  expect(postDecision({ ...post, delivery: { ...post.delivery, state: 'unknown' } }, snapshot, version)).toBeUndefined()
  const changed = { ...source, updatedAt: '2026-11-17T00:00:01.000Z' }
  const later = { ...snapshot, tasks: [changed] }
  expect(postDecision(post, later, version)).toBeUndefined()
  expect(postDecision({ ...post, attention: { reason: 'question', decisionId: 'question-2' } }, later, postSourceVersion(changed))).toEqual(
    {
      kind: 'question',
      id: 'question-2',
      runId: 'run-1',
    },
  )
  const answered = { ...source, pendingQuestions: 0 }
  expect(postDecision(post, { ...snapshot, tasks: [answered] }, postSourceVersion(answered))).toBeUndefined()
})

it('links an approval only while its decision is pending on the same visible session', () => {
  const source = task('s1', {
    status: 'waiting-approval',
    runId: 'run-1',
    board: { group: 'attention', reason: 'approval' },
  })
  const post = {
    turn: { sessionId: source.id, userMessageId: 'input', runId: source.runId! },
    delivery: { sessionId: source.id, state: 'sent' },
    attention: { reason: 'approval', decisionId: 'approval-1' },
  } satisfies Pick<WorkPost, 'turn' | 'delivery' | 'attention'>
  const first: Approval = { id: 'approval-1', sessionId: 's1', toolName: 'tool', reason: 'Review', requestedAt: source.updatedAt }
  const snapshot = { tasks: [source], approvals: [first] }
  const version = postSourceVersion(source)
  expect(postDecision(post, snapshot, version)).toEqual({ kind: 'approval', runId: 'run-1', id: first.id })
  expect(postDecision(post, { ...snapshot, approvals: [{ ...first, sessionId: 's2' }] }, version)).toBeUndefined()
  expect(postDecision(post, { ...snapshot, approvals: [{ ...first, id: 'next-approval' }] }, version)).toBeUndefined()
  expect(postDecision(post, { ...snapshot, approvals: [] }, version)).toBeUndefined()
})

describe('the thread’s @', () => {
  it('offers the 待办’s listed sessions, then 通用 and 我的 Agent only where this device may read them', () => {
    const tasks = [task('s1', { title: '写文档' }), task('s2', { title: '' }), task('other')]
    const item = { sessionIds: ['s1', 's2', 'hidden'] }
    expect(threadTargets({ tasks }, item)).toEqual([
      { kind: 'session', id: 's1', label: '写文档', harnessId: 'fake' },
      { kind: 'session', id: 's2', label: '未命名会话', harnessId: 'fake' },
    ])
    const agentId = `agt_${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`
    const full = threadTargets(
      {
        tasks,
        customAgents: [agent(agentId, '助理')],
        agentChats: { [agentId]: { state: 'ready', sessionId: 'c1' }, general: { state: 'empty' } },
      },
      item,
    )
    expect(full.slice(2)).toEqual([
      { kind: 'agent', id: 'general', label: '通用', ready: false },
      { kind: 'agent', id: agentId, label: '助理', ready: true },
    ])
    expect(matchTargets(full, '助').map(target => target.id)).toEqual([agentId])
    expect(postTarget(full[3]!)).toEqual({ customAgentId: agentId })
    expect(targetLabel({ sessionId: 'hidden' }, full)).toBe('不在列表中')
    expect(targetLabel({ sessionId: 's1' }, full)).toBe('写文档')
  })

  it('offers a bound shortcut only on its paired desktop and keeps the selected host and Agent when the shortcut changes', () => {
    const computer: ComputerSummary = { hostId: 'linux', name: 'Build machine', local: false, state: 'offline' }
    const shortcut = { ...agent('shortcut', '编译助手'), workComputer: { hostId: computer.hostId, agentId: 'worker' } }
    const snapshot = { tasks: [], customAgents: [shortcut], agentChats: { shortcut: { state: 'ready' as const, sessionId: 'old-local' } } }
    const item = { sessionIds: [] }
    for (const hidden of [undefined, [], [{ ...computer, local: true }], [{ ...computer, hostId: 'other' }]])
      expect(threadTargets(snapshot, item, hidden).some(row => row.id === shortcut.id)).toBe(false)
    const targets = threadTargets(snapshot, item, [computer])
    const [choice] = matchTargets(targets, 'build')
    expect(choice).toMatchObject({ kind: 'remote', id: shortcut.id, computer })
    const selected = postTarget(choice!)
    expect(selected).toEqual({ customAgentId: shortcut.id, workComputer: { hostId: 'linux', agentId: 'worker' } })
    expect(targetLabel(selected, targets)).toBe('编译助手 · Build machine')
    expect(currentTarget({ customAgentId: shortcut.id }, targets)).toBeUndefined()

    for (const changed of [
      { hostId: 'other', agentId: 'worker' },
      { hostId: 'linux', agentId: 'replacement' },
    ]) {
      const next = threadTargets({ ...snapshot, customAgents: [{ ...shortcut, workComputer: changed }] }, item, [
        { ...computer, hostId: changed.hostId },
      ])
      expect(currentTarget(selected, next)).toBeUndefined()
      expect(targetLabel(selected, next)).toBe('worker · linux')
    }
  })

  it('reads the @word at the caret only at a word’s start, and takes it out of what is sent', () => {
    expect(mentionAt('@写', 2)).toEqual({ start: 0, query: '写' })
    expect(mentionAt('请 @助理 看看', 5)).toEqual({ start: 2, query: '助理' })
    expect(mentionAt('a@b', 3)).toBeUndefined()
    expect(mentionAt('@写 文档', 5)).toBeUndefined()
    expect(mentionAt('没有', 2)).toBeUndefined()
    expect(withoutMention('@写 看看这个', 0, 2)).toBe('看看这个')
    expect(withoutMention('请 @助理', 2, 5)).toBe('请 ')
  })

  it('says a delivery’s state as the input says a message’s, and reads the thread again when a reply’s session moves', () => {
    expect(deliveryWords({}, 'x')).toBeUndefined()
    expect(deliveryWords({ delivery: { sessionId: 's1', state: 'sending' } }, 'x')).toEqual({ tone: 'running', words: '发送中' })
    expect(deliveryWords({ delivery: { sessionId: 's1', state: 'sent' } }, '写文档')).toEqual({ tone: 'neutral', words: '已交给 写文档' })
    expect(deliveryWords({ delivery: { sessionId: 's1', state: 'unknown' } }, 'x')?.words).toBe('未确认送达')
    expect(deliveryWords({ delivery: { sessionId: 's1', state: 'failed' } }, 'x')).toEqual({ tone: 'failed', words: '没有送达' })
    const posts = [
      { id: 'p1', at: '', text: 'a', delivery: { sessionId: 's1', state: 'sent' as const } },
      { id: 'p2', at: '', text: 'b', delivery: { sessionId: 's1', state: 'sent' as const } },
      { id: 'p3', at: '', text: 'c' },
    ]
    const snapshot = { tasks: [task('s1')] }
    const before = replySources(posts, snapshot)
    expect(before).toBe(replySources(posts.slice(0, 1), snapshot))
    expect(replySources(posts, { tasks: [task('s1', { updatedAt: '2026-11-17T00:00:01.000Z' })] })).not.toBe(before)
    expect(replySources(posts, { tasks: [task('s1', { runId: 'next-run' })] })).not.toBe(before)
    expect(replySources(null, { tasks: [] })).toBe('')
  })
})

it('keeps a lost delivery retryable by its original identity and only opens a turn the work computer has acknowledged', () => {
  const receipt: WorkPostRemote = { customAgentId: 'shortcut', agentId: 'worker', hostId: 'linux', status: 'offline', revision: 1 }
  expect(remoteActions(receipt)).toEqual({ refresh: true, retry: true, open: false, poll: false })
  expect(remoteActions({ ...receipt, status: 'unknown', mentionId: 'accepted' })).toEqual({
    refresh: true,
    retry: true,
    open: false,
    poll: true,
  })
  for (const status of ['running', 'waiting-approval'] as const)
    expect(remoteActions({ ...receipt, status, mentionId: 'accepted', sessionId: 'target' })).toEqual({
      refresh: true,
      retry: false,
      open: true,
      poll: true,
    })
  for (const status of ['cancelled', 'interrupted', 'completed', 'failed'] as const)
    expect(remoteActions({ ...receipt, status, sessionId: 'target' })).toEqual({ refresh: false, retry: false, open: true, poll: false })
})
