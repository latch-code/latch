import { describe, expect, it, vi } from 'vitest'
import type { Message, TaskDetail, TaskSummary } from '@latch/protocol'
import { SessionSearch } from '../src/search.ts'
const summary = (id: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  id,
  title: id,
  updatedAt: '2026-10-25T00:00:00Z',
  status: 'idle',
  ...extra,
})
const message = (id: string, role: Message['role'], text: string): Message => ({ id, role, text, createdAt: '2026-10-25T00:00:00Z' })
const detail = (task: TaskSummary, messages: Message[]): TaskDetail => ({ summary: task, messages, approvals: [], liveText: '', cursor: 1 })
describe('private session search', () => {
  it('matches Chinese substrings and case-insensitive text, including archives, only in user and assistant bodies', async () => {
    const task = summary('a', { archived: true })
    const search = new SessionSearch({
      list: async () => [task],
      detail: async () =>
        detail(task, [
          message('u', 'user', '查找中文 Hello'),
          message('a', 'assistant', '中文你好'),
          message('t', 'tool', '中文'),
          message('s', 'system', '中文'),
        ]),
    })
    expect((await search.search('中文')).hits.map(hit => hit.messageId)).toEqual(['u', 'a'])
    expect((await search.search('hELLo')).hits[0]).toMatchObject({
      archived: true,
      snippet: '查找中文 Hello',
      match: { start: 5, end: 10 },
    })
  })
  it('invalidates changed, running, deleted and no-longer-visible sessions rather than returning stale cached text', async () => {
    let task = summary('a')
    let visible = true
    let tasks = [task]
    const load = vi.fn(async () => detail(task, [message('m', 'user', 'text')]))
    const search = new SessionSearch({ list: async () => tasks, detail: load, visible: () => visible })
    await search.search('text')
    await search.search('text')
    expect(load).toHaveBeenCalledTimes(1)
    task = { ...task, updatedAt: '2026-10-25T00:00:01Z' }
    tasks = [task]
    await search.search('text')
    expect(load).toHaveBeenCalledTimes(2)
    visible = false
    expect((await search.search('text')).hits).toEqual([])
    visible = true
    tasks = []
    await search.search('text')
    tasks = [task]
    await search.search('text')
    expect(load).toHaveBeenCalledTimes(3)
    task = { ...task, status: 'running' }
    tasks = [task]
    await search.search('text')
    await search.search('text')
    expect(load).toHaveBeenCalledTimes(5)
  })
  it('caps snippets and results and returns promptly when a driver does not answer', async () => {
    const task = summary('a')
    const search = new SessionSearch({
      list: async () => [task],
      detail: async () =>
        detail(
          task,
          Array.from({ length: 31 }, (_, i) => message(String(i), 'user', 'x'.repeat(300))),
        ),
    })
    const result = await search.search('x')
    expect(result.hits).toHaveLength(30)
    expect(result.truncated).toBe(true)
    expect(result.hits[0]!.snippet).toHaveLength(160)
    const hung = new SessionSearch({ budgetMs: 10, list: async () => [task], detail: () => new Promise(() => {}) })
    expect(await hung.search('x')).toEqual({ hits: [], truncated: true })
  })
})
