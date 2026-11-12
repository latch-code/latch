import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MemoryProposal } from '@latch/protocol'
import { ProposalRow } from '../src/agents/ProposalRow.tsx'
import { effectWords, originWords, placeProposals, proposalRowState } from '../src/agents/proposals.ts'
import type { AgentWrite, AgentWrites, WriteState } from '../src/agents/useAgentWrites.ts'

const proposal = (extra: Partial<MemoryProposal> = {}): MemoryProposal => ({
  id: 'prp_1',
  content: '我用 pnpm',
  origin: 'agent',
  external: false,
  source: { sessionId: 's1', messageId: 'u2' },
  state: 'pending',
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z',
  ...extra,
})
const write = (verb: 'save' | 'dismiss'): AgentWrite => ({
  key: `proposal:prp_1:${verb}`,
  path: `custom-agents/agt/proposals/prp_1/${verb}`,
  method: 'POST',
  body: { requestId: 'request-1234' },
})
const writes = (state: WriteState | null): AgentWrites => ({
  state,
  run: async () => undefined,
  retry: async () => undefined,
  clear: () => {},
  held: state !== null && 'kind' in state && state.kind === 'unknown',
  saving: state !== null && 'phase' in state && state.phase === 'saving',
})
const render = (item: MemoryProposal, state: WriteState | null, effect?: string) =>
  renderToStaticMarkup(createElement(ProposalRow, { owner: 'agt', proposal: item, writes: writes(state), effect, disabled: false }))

describe('a memory proposal row', () => {
  it('has a state for each real case: the Host’s, or this device’s write while it is unsettled or refused', () => {
    expect(proposalRowState(proposal(), null)).toEqual({ kind: 'pending' })
    expect(proposalRowState(proposal(), { write: write('save'), phase: 'saving' })).toEqual({ kind: 'saving' })
    expect(proposalRowState(proposal(), { write: write('dismiss'), phase: 'saving' })).toEqual({ kind: 'dismissing' })
    expect(proposalRowState(proposal(), { write: write('save'), kind: 'unknown', message: '连接中断' })).toEqual({
      kind: 'unknown',
      message: '连接中断',
      requestId: 'request-1234',
    })
    expect(proposalRowState(proposal(), { write: write('save'), kind: 'refused', message: '这条提议已经处理过了。' })).toEqual({
      kind: 'failed',
      message: '这条提议已经处理过了。',
    })
    // Another proposal's write says nothing about this one; the Host's answer wins once it has one.
    expect(proposalRowState(proposal({ id: 'prp_2' }), { write: write('save'), phase: 'saving' })).toEqual({ kind: 'pending' })
    expect(proposalRowState(proposal({ state: 'saved' }), { write: write('save'), phase: 'done' })).toEqual({ kind: 'saved' })
    expect(proposalRowState(proposal({ state: 'dismissed' }), null)).toEqual({ kind: 'dismissed' })
  })

  it('says 想记住 with 保存 and 不要, who it came from, and 来自外部内容 only when external', () => {
    const pending = render(proposal(), null)
    expect(pending).toContain('想记住：')
    expect(pending).toContain('我用 pnpm')
    expect(pending).toContain('它推断的')
    expect(pending).not.toContain('来自外部内容')
    expect(pending.match(/data-variant="primary"/gu)).toHaveLength(1)
    expect(pending).toContain('保存')
    expect(pending).toContain('不要')
    const external = render(proposal({ origin: 'user', external: true }), null)
    expect(external).toContain('你说的')
    expect(external).toContain('来自外部内容')
    expect(external).toContain('data-tone="warn"')
  })

  it('says when a saved one takes effect, and keeps the request of an unknown result for 重试同一请求', () => {
    expect(render(proposal({ state: 'saved' }), null, '已生效')).toContain('已生效')
    expect(render(proposal({ state: 'saved' }), null, '从下一个话题起')).toContain('从下一个话题起')
    expect(render(proposal({ state: 'dismissed' }), null)).toContain('不要了')
    const unknown = render(proposal(), { write: write('save'), kind: 'unknown', message: '连接中断，Mac 可能已经保存。' })
    expect(unknown).toContain('结果未知')
    expect(unknown).toContain('重试同一请求')
    expect(unknown).toContain('request-1234')
    const failed = render(proposal(), { write: write('save'), kind: 'refused', message: '一个 Agent 最多保存 128 条记忆。' })
    expect(failed).toContain('没有保存')
    expect(failed).toContain('最多保存 128 条')
  })

  it('names effect and origin as the product does', () => {
    expect(effectWords({ agentContext: 'private' })).toBe('已生效')
    expect(effectWords({ agentContext: 'first-turn' })).toBe('从下一个话题起')
    expect(originWords('user')).toBe('你说的')
    expect(originWords('agent')).toBe('它推断的')
  })

  it('sits after the turn it came from, by message or by the person’s request, else after the last turn', () => {
    const messages = [
      { id: 'u1', role: 'user' as const, requestId: 'r1' },
      { id: 'a1', role: 'assistant' as const },
      { id: 'u2', role: 'user' as const, requestId: 'r2' },
    ]
    const turns = [{ key: 'u1' }, { key: 'u2' }]
    const placed = placeProposals(
      [
        proposal({ id: 'p1', source: { sessionId: 's1', requestId: 'r1' } }),
        proposal({ id: 'p2', source: { sessionId: 's1', messageId: 'u2' } }),
        proposal({ id: 'p3', source: { sessionId: 's1', messageId: 'gone' } }),
        proposal({ id: 'p4', source: { sessionId: 'other', messageId: 'u1' } }),
      ],
      's1',
      messages,
      turns,
    )
    expect([...placed].map(([key, items]) => [key, items.map(item => item.id)])).toEqual([
      ['u1', ['p1']],
      ['u2', ['p2', 'p3']],
    ])
  })
})
