import { describe, expect, it } from 'vitest'
import type { Message, TaskDetail, TaskSummary } from '@latch/protocol'
import { sessionVitals } from '../src/composer/vitals.ts'

const user = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: 'user', text: '回复 ok', ...extra })

const summary = (extra: Partial<TaskSummary> = {}) =>
  ({ id: 's1', status: 'idle', usage: undefined, ...extra }) as Pick<TaskSummary, 'id' | 'usage' | 'status'>
const detail = (messages: Message[], extra: Partial<TaskDetail> = {}) =>
  ({ summary: { id: 's1' }, messages, ...extra }) as Pick<TaskDetail, 'summary' | 'messages' | 'usageReport'>

describe('session vitals', () => {
  it('shows nothing that was not reported', () => {
    expect(sessionVitals(summary(), detail([]))).toEqual({})
  })

  it('counts turns and tool steps, tokens with the cached share, and the context share', () => {
    const vitals = sessionVitals(
      summary({ usage: { inputTokens: 109_081, outputTokens: 293, cacheReadTokens: 81_280 } }),
      detail(
        [
          user('u1'),
          { id: 't1', role: 'tool', text: '' },
          { id: 'a1', role: 'assistant', text: 'ok' },
          user('u2'),
          { id: 't2', role: 'tool', text: '' },
          { id: 't3', role: 'tool', text: '', subagent: { id: 'c', title: 'c', steps: [] } as unknown as Message['subagent'] },
        ],
        { usageReport: { contextUsed: 400_000, contextSize: 475_000, at: '' } },
      ),
    )
    expect(vitals.turns).toEqual({ turns: 2, steps: 2 })
    expect(vitals.tokens).toMatchObject({ total: 109_374, cached: 75, by: 'harness' })
    expect(vitals.context).toMatchObject({ percent: 84, near: true })
    expect(vitals.speed).toBeUndefined()
  })

  it('has no cached share when no cached input was reported, and no ring without a window size', () => {
    const vitals = sessionVitals(
      summary({ usage: { inputTokens: 100, outputTokens: 10 } }),
      detail([user('u1')], { usageReport: { contextUsed: 1000, at: '' } }),
    )
    expect(vitals.tokens?.cached).toBeUndefined()
    expect(vitals.context).toEqual({ used: 1000, near: false })
  })

  it('measures the running turn from the Harness’s own token count and streaming time, and only while it runs', () => {
    const messages: Message[] = [
      user('u1', { turn: { usage: { inputTokens: 1000, outputTokens: 900 }, stream: { outputTokens: 300, ms: 2000 } } }),
    ]
    expect(sessionVitals(summary({ status: 'running' }), detail(messages)).speed).toBe(150)
    expect(sessionVitals(summary({ status: 'idle' }), detail(messages)).speed).toBeUndefined()
    // Tokens without the Harness's own times say nothing about speed.
    const untimed: Message[] = [user('u1', { turn: { usage: { inputTokens: 1000, outputTokens: 300 } } })]
    expect(sessionVitals(summary({ status: 'running' }), detail(untimed)).speed).toBeUndefined()
  })

  it('sums what the gateway counted when the Harness reported nothing itself', () => {
    const routed = (input: number, cached: number): Message =>
      user(`u${input}`, {
        turn: {
          routed: {
            requests: 1,
            models: [{ model: 'm', requests: 1, usage: { inputTokens: input, outputTokens: 10, cacheReadTokens: cached } }],
          },
        },
      })
    const vitals = sessionVitals(summary(), detail([routed(100, 50), routed(300, 250)]))
    expect(vitals.tokens).toMatchObject({ total: 420, cached: 75, by: 'gateway' })
  })
})
