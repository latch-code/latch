import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { Transcript } from '../src/components/Transcript.tsx'

describe('history from a Host that records no times', () => {
  it('renders without times, durations, separators or a thinking timer, and its footer keeps the tokens', () => {
    const detail: TaskDetail = {
      summary: { harnessId: 'standard', id: 's', title: 't', status: 'idle', updatedAt: '' },
      messages: [
        { id: 'u', role: 'user', text: '一' },
        { id: 'a', role: 'assistant', text: '答', reasoning: '想', usage: { inputTokens: 1200, outputTokens: 30 } },
        { id: 'tool:1', role: 'tool', text: 'ok', toolName: 'run', state: 'completed', tool: { kind: 'execute' } },
        { id: 'b', role: 'assistant', text: '好' },
      ],
      approvals: [],
      liveText: '',
      cursor: 1,
    }
    const html = renderToStaticMarkup(createElement(Transcript, { detail, approvals: [], harnessName: 'Latch' }))
    expect(html).not.toContain('<time')
    expect(html).not.toContain('time-separator')
    expect(html).not.toContain('用时')
    expect(html).not.toContain('思考了')
    expect(html).not.toContain('process-time')
    expect(html).toContain('思考过程')
    expect(html).toContain('>输入 1.2k<span class="turn-fact-unit"> tokens</span></span>')
    expect(html).toContain('>输出 30<span class="turn-fact-unit"> tokens</span></span>')
  })
})
