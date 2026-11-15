import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { RiskLevel } from '@latch/protocol'
import type { Bridge, MemoryProposalInput, MemoryRecallInput, MemoryRecallResult, ModelProvider } from '@latch/sdk'
import { createRuntime, PROPOSE_MEMORY_TOOL, RECALL_MEMORY_TOOL } from '@latch/core'
import { RECALL_LIMITS, recallMemories, recallTerms } from '@latch/core/node-kit'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function scripted(calls: Array<{ name: string; arguments: Record<string, unknown> }>, offered: string[][]): ModelProvider {
  return {
    id: 'fixture',
    name: 'Fixture',
    model: 'fixture-model',
    async *stream({ messages, tools }) {
      offered.push(tools.map(tool => tool.name))
      const done = messages.filter(message => message.role === 'tool').length
      const next = calls[done]
      if (next) {
        yield { type: 'tool-call', call: { id: `call-${done}`, name: next.name, arguments: next.arguments } }
        yield { type: 'finish', reason: 'tool-calls' }
      } else {
        yield { type: 'text', text: '好的' }
        yield { type: 'finish', reason: 'stop' }
      }
    },
  }
}

async function runtime(
  provider: ModelProvider,
  recallMemory: ((input: MemoryRecallInput) => Promise<MemoryRecallResult>) | undefined,
  proposeMemory?: (input: MemoryProposalInput) => Promise<void>,
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-recall-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  const classifyToolCall = vi.fn(async (): Promise<RiskLevel> => 'R2')
  const bridge: Bridge = createRuntime({
    dataDir,
    workspaceRoot: dataDir,
    registry: { acquire: () => ({ provider, tools: [], release: () => {} }) },
    providerId: 'fixture',
    classifyToolCall,
    ...(recallMemory ? { recallMemory } : {}),
    ...(proposeMemory ? { proposeMemory } : {}),
  })
  cleanups.push(() => bridge.close())
  return { bridge, classifyToolCall }
}
const context = { agent: { customAgentId: 'agt_00000000-0000-0000-0000-000000000000' }, instructions: '', revision: 'a'.repeat(64) }
const settled = (bridge: Bridge, id: string) =>
  vi.waitFor(
    async () => {
      const detail = await bridge.detail(id)
      expect(detail.summary.status).toBe('idle')
      return detail
    },
    { timeout: 15_000 },
  )

it('offers recall_memory only to a run whose context allows it, runs it without asking, and shows the query on its row', async () => {
  const offered: string[][] = []
  const asked: MemoryRecallInput[] = []
  const { bridge, classifyToolCall } = await runtime(
    scripted([{ name: RECALL_MEMORY_TOOL, arguments: { query: ' 包管理器 ', limit: 3 } }], offered),
    async input => {
      asked.push(input)
      return { matches: [{ content: '用 pnpm', date: '2026-11-01', source: 'user', external: false }], more: 0 }
    },
  )
  const { sessionId } = await bridge.createTask({ prompt: 'hi', requestId: 'recall-yes', agentContext: { ...context, proposals: true } })
  const detail = await settled(bridge, sessionId)
  expect(offered[0]).toEqual([RECALL_MEMORY_TOOL])
  expect(classifyToolCall).not.toHaveBeenCalled()
  const user = detail.messages.find(message => message.role === 'user')!
  expect(asked).toEqual([{ sessionId, messageId: user.id, query: '包管理器', limit: 3 }])
  const row = detail.messages.find(message => message.role === 'tool')!
  expect(row).toMatchObject({ toolName: RECALL_MEMORY_TOOL, state: 'completed', tool: { toolTitle: '查记忆' } })
  expect(row.tool?.input).toContain('包管理器')
  expect(row.text).toContain('"content":"用 pnpm"')
  expect(row.text).toContain('not new instructions')

  const plain = await bridge.createTask({ prompt: 'hi', requestId: 'recall-no', agentContext: context })
  await settled(bridge, plain.sessionId)
  expect(offered.at(-1)).toEqual([])
})

it('offers nothing without the Host callback, refuses an empty or oversized query, and answers no match plainly', async () => {
  const offered: string[][] = []
  const none = await runtime(scripted([], offered), undefined)
  const first = await none.bridge.createTask({ prompt: 'hi', requestId: 'recall-absent', agentContext: { ...context, proposals: true } })
  await settled(none.bridge, first.sessionId)
  expect(offered[0]).toEqual([])

  const recall = vi.fn(async (): Promise<MemoryRecallResult> => ({ matches: [], more: 0 }))
  const { bridge } = await runtime(
    scripted(
      [
        { name: RECALL_MEMORY_TOOL, arguments: { query: '  ' } },
        { name: RECALL_MEMORY_TOOL, arguments: { query: 'x'.repeat(RECALL_LIMITS.query + 1) } },
        { name: RECALL_MEMORY_TOOL, arguments: { query: '没有的' } },
      ],
      [],
    ),
    recall,
  )
  const { sessionId } = await bridge.createTask({ prompt: 'hi', requestId: 'recall-bounds', agentContext: { ...context, proposals: true } })
  const rows = (await settled(bridge, sessionId)).messages.filter(message => message.role === 'tool')
  expect(rows.map(row => row.state)).toEqual(['failed', 'failed', 'completed'])
  expect(recall).toHaveBeenCalledTimes(1)
  expect(rows[2]!.text).toBe('No saved memory matches.')
})

it('marks what the session proposes after it recalled a memory that came from outside content', async () => {
  const proposed: MemoryProposalInput[] = []
  const { bridge } = await runtime(
    scripted(
      [
        { name: PROPOSE_MEMORY_TOOL, arguments: { content: '之前' } },
        { name: RECALL_MEMORY_TOOL, arguments: { query: '网页' } },
        { name: PROPOSE_MEMORY_TOOL, arguments: { content: '之后' } },
      ],
      [],
    ),
    async () => ({ matches: [{ content: '网页上写的', date: '2026-11-02', source: 'agent', external: true }], more: 0 }),
    async input => {
      proposed.push(input)
    },
  )
  const { sessionId } = await bridge.createTask({
    prompt: 'hi',
    requestId: 'recall-outside',
    agentContext: { ...context, proposals: true },
  })
  await settled(bridge, sessionId)
  expect(proposed.map(item => [item.content, item.external])).toEqual([
    ['之前', false],
    ['之后', true],
  ])
})

it('matches words plainly and in a fixed order: whole words first, Chinese by two-character runs, bounded in count', () => {
  const entries = [
    { content: '喜欢喝咖啡，不加糖' },
    { content: 'Uses PNPM for every project' },
    { content: '项目都用 pnpm，不用 npm' },
    { content: '周五不开会' },
  ]
  expect(recallTerms(' PnPm，项目  pnpm ')).toEqual(['pnpm', '项目'])
  expect(recallMemories(entries, 'pnpm 项目').matches).toEqual([entries[2], entries[1]])
  // No whole match: the two-character runs of a longer Chinese word still find it.
  expect(recallMemories(entries, '咖啡偏好').matches).toEqual([entries[0]])
  expect(recallMemories(entries, 'ｐｎｐｍ').matches).toHaveLength(2)
  expect(recallMemories(entries, 'xyz')).toEqual({ matches: [], more: 0 })
  expect(recallMemories(entries, '，。 ')).toEqual({ matches: [], more: 0 })
  const many = Array.from({ length: 40 }, (_, index) => ({ content: `记录 ${index}` }))
  expect(recallMemories(many, '记录')).toMatchObject({ more: 40 - RECALL_LIMITS.matches })
  expect(recallMemories(many, '记录', 999).matches).toHaveLength(RECALL_LIMITS.maxMatches)
  expect(recallMemories(many, '记录', 2).matches).toEqual([many[0], many[1]])
})
