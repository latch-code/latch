import { describe, expect, it } from 'vitest'
import type { Message, TaskDetail } from '@latch/protocol'
import {
  askSideQuestion,
  closeSideQuestion,
  currentSideQuestion,
  sideQuestionBlock,
  sideQuestionBody,
  sideQuestionOf,
  sideQuestionPoint,
  sideQuestionRefusal,
  sideQuestionTransport,
} from '../src/conversation/SideQuestion.tsx'
import { slashOptions } from '../src/composer/SlashCommands.tsx'

const message = (id: string, role: Message['role'], extra: Partial<Message> = {}) =>
  ({ id, role, text: id, createdAt: '2026-11-13T00:00:00.000Z', ...extra }) as Message

describe('/btw', () => {
  it('reads the question after /btw, and nothing else as one', () => {
    expect(sideQuestionOf('/btw 这个函数为什么慢？')).toBe('这个函数为什么慢？')
    expect(sideQuestionOf('  /btw  多行\n问题 ')).toBe('多行\n问题')
    expect(sideQuestionOf('/btw ')).toBe('')
    expect(sideQuestionOf('/btw')).toBe('')
    expect(sideQuestionOf('/btwx 不是')).toBeUndefined()
    expect(sideQuestionOf('问一下 /btw')).toBeUndefined()
  })

  it('is offered where the Harness forks into a chat, and says why not elsewhere', () => {
    const features = { features: { fork: true } } as never
    expect(sideQuestionRefusal(features, { modes: ['chat', 'agent'], status: 'ready' })).toBeUndefined()
    expect(sideQuestionRefusal(features, { modes: ['agent'], status: 'ready' })).toBe('这个 Harness 尚不支持')
    expect(sideQuestionRefusal({ features: {} } as never, { modes: ['chat'], status: 'ready' })).toBe('这个 Harness 尚不支持')
    expect(sideQuestionRefusal(features, { modes: ['chat'], status: 'unavailable' })).toBe('这个 Harness 当前不可用')
  })

  it('forks after the last settled turn, never into the one that runs', () => {
    const settled = [message('u1', 'user'), message('a1', 'assistant'), message('u2', 'user'), message('a2', 'assistant')]
    expect(sideQuestionPoint(settled, false)).toBe('a2')
    const running = [...settled, message('u3', 'user'), message('a3', 'assistant', { state: 'running' })]
    expect(sideQuestionPoint(running, true)).toBe('a2')
    // Text added to the running turn does not count as a new turn.
    expect(sideQuestionPoint([...running, message('s', 'user', { steered: true })], true)).toBe('a2')
    // The first turn still runs: no background yet.
    expect(sideQuestionPoint([message('u1', 'user'), message('a1', 'assistant', { state: 'running' })], true)).toBeUndefined()
  })

  it('asks the same Harness and model in a chat-only fork', () => {
    const detail = {
      summary: { id: 'source', harnessId: 'standard', providerId: 'p1', model: 'm1', effort: 'high', status: 'running' },
      messages: [
        message('u1', 'user'),
        message('a1', 'assistant'),
        message('u2', 'user'),
        message('a2', 'assistant', { state: 'running' }),
      ],
    } as unknown as TaskDetail
    const body = sideQuestionBody(detail, '顺便问一句', 'proj', true)
    expect(body).toMatchObject({
      prompt: '顺便问一句',
      mode: 'chat',
      harnessId: 'standard',
      workspaceId: 'proj',
      forkOf: { taskId: 'source', upToMessageId: 'a1' },
      model: { providerId: 'p1', model: 'm1', effort: 'high' },
    })
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/u)
  })

  it('reads /btw in the slash menu with a short label, and says when the Harness cannot', () => {
    const offered = slashOptions('/bt', [], [], [{ name: 'btw', description: '旁支提问，不打断这一轮', text: '/btw ' }])
    expect(offered[0]).toMatchObject({ label: '/btw', description: '旁支提问，不打断这一轮', text: '/btw ' })
    expect(offered[0]!.unavailable).toBeUndefined()
    const refused = slashOptions(
      '/bt',
      [],
      [],
      [{ name: 'btw', description: '旁支提问', text: '/btw ', unavailable: '这个 Harness 尚不支持' }],
    )
    expect(refused[0]).toMatchObject({ description: '这个 Harness 尚不支持', unavailable: true })
  })

  it('keeps /btw in the input with the reason where it is not available, so it is never sent, queued or steered', () => {
    expect(sideQuestionBlock('/btw 为什么慢？', true, '这个 Harness 尚不支持')).toBe('/btw：这个 Harness 尚不支持')
    expect(sideQuestionBlock('/btw', true, '这个 Harness 当前不可用')).toBe('/btw：这个 Harness 当前不可用')
    expect(sideQuestionBlock('/btw 为什么慢？', true, undefined)).toBeUndefined()
    expect(sideQuestionBlock('普通的一句', true, '这个 Harness 尚不支持')).toBeUndefined()
    expect(sideQuestionBlock('/btw 为什么慢？', false, undefined)).toBeUndefined()
  })

  it('cancels a running answer before archiving on close, and ignores a start that answers after close', async () => {
    const calls: string[] = []
    let answer: ((value: { sessionId: string }) => void) | undefined
    const original = sideQuestionTransport.request
    sideQuestionTransport.request = (async (path: string, init?: { method?: string; body?: unknown }) => {
      calls.push(`${init?.method ?? 'GET'} ${path} ${JSON.stringify(init?.body ?? {})}`)
      if (path === 'tasks') return new Promise(resolve => (answer = resolve as never))
      return {}
    }) as typeof original
    try {
      const detail = {
        summary: { id: 'src', harnessId: 'standard', status: 'idle' },
        messages: [message('u1', 'user'), message('a1', 'assistant')],
      } as unknown as TaskDetail
      // Closed while the fork starts: the late answer stops and archives that fork and opens nothing.
      const started = askSideQuestion(detail, '顺便问', undefined, false)
      expect(currentSideQuestion('src')?.phase).toBe('starting')
      await closeSideQuestion('src', true)
      answer!({ sessionId: 'fork-1' })
      await started
      expect(currentSideQuestion('src')).toBeUndefined()
      expect(calls.slice(1).map(call => call.split(' ').slice(0, 2).join(' '))).toEqual(['POST tasks/fork-1/cancel', 'PATCH tasks/fork-1'])
      // Open with its answer still running: cancel first, then archive.
      calls.length = 0
      const second = askSideQuestion(detail, '再问', undefined, false)
      answer!({ sessionId: 'fork-2' })
      await second
      expect(currentSideQuestion('src')?.forkId).toBe('fork-2')
      await closeSideQuestion('src', true)
      expect(calls.slice(1).map(call => call.split(' ').slice(0, 2).join(' '))).toEqual(['POST tasks/fork-2/cancel', 'PATCH tasks/fork-2'])
      expect(calls.at(-1)).toContain('"archived":true')
      // A settled answer is only archived.
      calls.length = 0
      const third = askSideQuestion(detail, '第三问', undefined, false)
      answer!({ sessionId: 'fork-3' })
      await third
      await closeSideQuestion('src', false)
      expect(calls.slice(1).map(call => call.split(' ').slice(0, 2).join(' '))).toEqual(['PATCH tasks/fork-3'])
    } finally {
      sideQuestionTransport.request = original
    }
  })
})
