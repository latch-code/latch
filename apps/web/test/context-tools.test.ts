import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { Message } from '@latch/protocol'
import { ContextToolActivity } from '../src/panel/ContextToolActivity.tsx'
import { ContextWindowHistory } from '../src/panel/ContextWindowHistory.tsx'
import { projectSessionContext } from '../src/panel/sessionContext.ts'

it('compares recorded calls, distinguishes confirmed failures from interrupted calls, and omits call bodies', () => {
  const tool = (id: string, extra: Partial<Message> = {}): Message => ({
    id,
    role: 'tool',
    text: 'private result',
    toolName: 'read_file',
    state: 'completed',
    ...extra,
  })
  const messages = [
    tool('a', { createdAt: '2026-11-24T00:00:01Z', startedAt: '2026-11-24T00:00:10Z', completedAt: '2026-11-24T00:00:14Z' }),
    tool('b', { state: 'failed' }),
    tool('c', { toolName: 'shell', state: 'failed', interrupted: true }),
    tool('d', { toolName: 'shell', state: 'failed', text: 'TOOL_OUTCOME_UNKNOWN' }),
    tool('e', { toolName: 'read /private/place', tool: { kind: 'read', input: 'private input' } }),
    tool('f', { role: 'assistant' }),
  ]
  const { context } = projectSessionContext({ harnessId: 'standard', messages })
  const html = renderToStaticMarkup(createElement(ContextToolActivity, { tools: context.tools }))
  expect(html).toContain('共 5 次 · 1 次失败')
  expect(html).toContain('单次最长实测 4 秒')
  expect(html).toContain('read_file')
  expect(html).toContain('other')
  expect(html).not.toContain('shell')
  expect(html).not.toContain('/private/place')
  expect(html).not.toContain('private result')
  expect(html).not.toContain('private input')
})

it('keeps a gap for a turn with no window report and preserves an explicitly measured zero', () => {
  const turn = (id: string, used?: number): Message => ({
    id,
    role: 'user',
    text: 'private question',
    ...(used === undefined ? {} : { turn: { contextWindow: { used, at: '2026-11-24T00:10:00Z', source: 'acp' } } }),
  })
  const render = (messages: Message[]) => {
    const { context } = projectSessionContext({ harnessId: 'external', messages })
    return renderToStaticMarkup(createElement(ContextWindowHistory, { windows: context.windows }))
  }
  const single = render([turn('a', 0), turn('b')])
  expect(single).toContain('1 份报告')
  expect(single).not.toContain('<svg')
  const html = render([turn('a', 0), { ...turn('steer'), steered: true }, turn('b'), turn('c', 40)])
  expect(html).toContain('Harness 报告')
  expect(html).toContain('>第 1 轮</span><span>0 tokens</span>')
  expect(html).toContain('>第 2 轮</span><span>未报告</span>')
  expect(html).toContain('>第 3 轮</span><span>40 tokens</span>')
  expect(html).not.toContain('较上一轮净变化')
  expect(html).not.toContain('private question')
})
