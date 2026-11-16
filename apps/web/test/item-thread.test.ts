import { describe, expect, it } from 'vitest'
import type { CustomAgentSummary, TaskSummary } from '@latch/protocol'
import {
  deliveryWords,
  matchTargets,
  mentionAt,
  postTarget,
  replySources,
  targetLabel,
  threadTargets,
  withoutMention,
} from '../src/board/itemThread.ts'

const task = (id: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  harnessId: 'fake',
  id,
  title: id,
  status: 'idle',
  updatedAt: '2026-11-17T00:00:00.000Z',
  ...extra,
})
const agent = (id: string, name: string) => ({ id, name }) as CustomAgentSummary

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
    const before = replySources(posts, { tasks: [task('s1')] })
    expect(before).toBe('s1:2026-11-17T00:00:00.000Z')
    expect(replySources(posts, { tasks: [task('s1', { updatedAt: '2026-11-17T00:00:01.000Z' })] })).not.toBe(before)
    expect(replySources(null, { tasks: [] })).toBe('')
  })
})
