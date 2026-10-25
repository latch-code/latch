import { describe, expect, it } from 'vitest'
import type { Message, TaskDetail } from '@latch/protocol'
import { reportedUsage } from '../src/usage.ts'
const now = Date.parse('2026-10-25T12:00:00Z')
const message = (id: string, age: number, usage: Message['usage'], extra: Partial<Message> = {}): Message => ({
  id,
  role: 'assistant',
  text: '',
  createdAt: new Date(now - age * 86400_000).toISOString(),
  usage,
  ...extra,
})
const detail = (messages: Message[]): TaskDetail => ({
  summary: { id: 'a', title: 'a', status: 'idle', harnessId: 'standard', updatedAt: new Date(now).toISOString() },
  messages,
  approvals: [],
  liveText: '',
  cursor: 1,
})
describe('reported period usage', () => {
  it('counts actual assistant records within the period without attributing missing fields to the latest session model', async () => {
    const messages = [
      message('a', 1, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 }, { providerId: 'p', model: 'm' }),
      message('b', 2, { inputTokens: 2, outputTokens: 1 }, { providerId: 'p', model: 'm' }),
      message('old', 8, { inputTokens: 100, outputTokens: 50 }),
      message('tool', 1, { inputTokens: 999, outputTokens: 999 }, { role: 'tool' }),
      message('unknown', 1, { inputTokens: 3, outputTokens: 4 }, { createdAt: undefined }),
    ]
    const source = { list: async () => [{ id: 'a' }], detail: async () => detail(messages), now: () => now }
    const week = await reportedUsage(source, 7)
    expect(week.rows).toHaveLength(1)
    expect(week.rows[0]).toMatchObject({
      providerId: 'p',
      model: 'm',
      usage: { inputTokens: 12, outputTokens: 6, cacheReadTokens: 3 },
      partial: { cacheReadTokens: true, reasoningTokens: true },
    })
    expect(week.rows[0]!.usage.reasoningTokens).toBeUndefined()
    expect(week.unattributedMessages).toBe(1)
    const month = await reportedUsage(source, 30)
    expect(month.rows).toHaveLength(2)
    expect(month.rows.some(row => row.providerId === undefined && row.model === undefined)).toBe(true)
  })
  it('labels external reports as agent data and returns partial results within a bounded driver wait', async () => {
    const value = detail([message('a', 1, { inputTokens: 1, outputTokens: 2 })])
    value.summary.harnessId = 'external'
    const result = await reportedUsage(
      {
        list: async () => [{ id: 'a' }, { id: 'hung' }],
        detail: id => (id === 'a' ? Promise.resolve(value) : new Promise(() => {})),
        now: () => now,
        budgetMs: 10,
      },
      7,
    )
    expect(result.rows[0]!.source).toBe('agent')
    expect(result.truncated).toBe(true)
  })
})
