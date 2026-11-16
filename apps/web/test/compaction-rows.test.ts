import { describe, expect, it } from 'vitest'
import type { Message } from '@latch/protocol'
import { collapseCompactions, projectTurns } from '../src/conversation.ts'

const user = (id: string, text = '回复 ok'): Message => ({ id, role: 'user', text })
const compacted = (id: string, text = 'Codex 已压缩上下文'): Message => ({ id: `compaction:${id}`, role: 'system', text })

describe('compaction rows', () => {
  // Real Codex 0.169, its auto-compact limit under the context it keeps: one item per turn, each with its own ID.
  const messages: Message[] = [
    user('u1'),
    { id: 'a1', role: 'assistant', text: 'ok' },
    user('u2'),
    compacted('01a1e3ca-0af2'),
    { id: 'a2', role: 'assistant', text: 'ok' },
    user('u3'),
    compacted('01a1e3ca-4ca0'),
    { id: 'a3', role: 'assistant', text: 'ok' },
  ]

  it('keeps the latest of repeated compactions, with how many there were', () => {
    const shown = collapseCompactions(messages)
    expect(shown.filter(message => message.role === 'system').map(message => [message.id, message.text])).toEqual([
      ['compaction:01a1e3ca-4ca0', 'Codex 已压缩上下文 · 2 次'],
    ])
    expect(
      projectTurns(messages)
        .turns.flatMap(turn => turn.replies)
        .filter(message => message.role === 'system'),
    ).toHaveLength(1)
  })

  it('collapses only a run in consecutive turns, and never the outcome of a /compact the person ran', () => {
    const apart = [user('u1'), compacted('a'), user('u2'), user('u3'), compacted('b')]
    expect(collapseCompactions(apart)).toBe(apart)
    const asked = [user('u1'), compacted('a'), user('u2', '/compact'), compacted('b'), user('u3'), compacted('c')]
    expect(collapseCompactions(asked)).toBe(asked)
    const runs = [
      user('u1'),
      compacted('a'),
      user('u2'),
      compacted('b'),
      user('u3'),
      user('u4'),
      compacted('c'),
      user('u5'),
      compacted('d'),
    ]
    expect(
      collapseCompactions(runs)
        .filter(message => message.role === 'system')
        .map(message => message.text),
    ).toEqual(['Codex 已压缩上下文 · 2 次', 'Codex 已压缩上下文 · 2 次'])
  })

  it('leaves a single compaction, one with a summary and one that failed as they are', () => {
    const one = [user('u1'), compacted('x')]
    expect(collapseCompactions(one)).toBe(one)
    const kinds = [
      user('u1'),
      compacted('x', 'pi 已压缩上下文\nSummary'),
      user('u2'),
      compacted('y', 'Codex 压缩上下文失败'),
      compacted('z'),
    ]
    expect(collapseCompactions(kinds)).toBe(kinds)
  })
})
