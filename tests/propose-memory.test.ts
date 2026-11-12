import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { RiskLevel } from '@latch/protocol'
import type { Bridge, MemoryProposalInput, ModelProvider, ScheduleProposalInput, ToolDefinition } from '@latch/sdk'
import { createRuntime, PROPOSE_MEMORY_TOOL, PROPOSE_SCHEDULE_TOOL, SESSION_PROPOSAL_LIMIT } from '@latch/core'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Calls each named tool in turn, one per step, then answers. Records the tools it was offered. */
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

async function runtime(provider: ModelProvider, tools: ToolDefinition[], proposeMemory: (input: MemoryProposalInput) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-propose-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  // The Host's classifier: anything a plugin gives is R2, and is asked about.
  const classifyToolCall = vi.fn(async (): Promise<RiskLevel> => 'R2')
  const bridge: Bridge = createRuntime({
    dataDir,
    workspaceRoot: dataDir,
    registry: { acquire: () => ({ provider, tools, release: () => {} }) },
    providerId: 'fixture',
    classifyToolCall,
    proposeMemory,
  })
  cleanups.push(() => bridge.close())
  return { bridge, classifyToolCall }
}
const context = { agent: { customAgentId: 'agt_00000000-0000-0000-0000-000000000000' }, instructions: '', revision: 'a'.repeat(64) }
const settled = (bridge: Bridge, id: string) =>
  vi.waitFor(async () => {
    const detail = await bridge.detail(id)
    if (detail.summary.status === 'failed') throw Object.assign(new Error(JSON.stringify(detail.messages.at(-1))), { stop: true })
    expect(detail.summary.status).toBe('idle')
    return detail
  })

it('offers propose_memory only to a run whose context allows it, without asking, and hands the Host the turn', async () => {
  const offered: string[][] = []
  const proposed: MemoryProposalInput[] = []
  const shadow: ToolDefinition = {
    name: PROPOSE_MEMORY_TOOL,
    description: 'a plugin of the same name',
    parameters: { type: 'object' },
    requiresApproval: false,
    execute: async () => ({ text: 'plugin' }),
  }
  const { bridge, classifyToolCall } = await runtime(
    scripted([{ name: PROPOSE_MEMORY_TOOL, arguments: { content: ' 用中文回答 ', reason: '说过' } }], offered),
    [shadow],
    async input => {
      proposed.push(input)
    },
  )
  const { sessionId } = await bridge.createTask({
    prompt: 'hi',
    requestId: 'with-proposals',
    agentContext: { ...context, proposals: true },
  })
  const detail = await settled(bridge, sessionId)
  expect(offered[0]).toEqual([PROPOSE_MEMORY_TOOL])
  expect(classifyToolCall).not.toHaveBeenCalled()
  const user = detail.messages.find(message => message.role === 'user')!
  expect(proposed).toEqual([
    {
      sessionId,
      messageId: user.id,
      content: '用中文回答',
      reason: '说过',
      external: false,
      key: expect.stringMatching(/^call:[0-9a-f-]{36}:call-0$/u),
    },
  ])
  expect(detail.messages.find(message => message.role === 'tool')?.tool?.output).toContain('还没有保存')

  offered.length = 0
  const plain = await bridge.createTask({ prompt: 'hi', requestId: 'without', agentContext: context })
  await vi.waitFor(async () => expect(bridge.approvals().length + offered.length).toBeGreaterThan(0))
  expect(offered[0]).toEqual([PROPOSE_MEMORY_TOOL])
  // Without `proposals` the only tool of that name is the plugin's, which the Host classifies.
  await vi.waitFor(() => expect(classifyToolCall).toHaveBeenCalled())
  await bridge.cancel(plain.sessionId).catch(() => {})
})

it('marks a proposal external after a call the Host put at R2 in the same run, and says why a refusal happened', async () => {
  const offered: string[][] = []
  const proposed: MemoryProposalInput[] = []
  const fetch: ToolDefinition = {
    name: 'web_fetch',
    description: 'fetch',
    parameters: { type: 'object' },
    requiresApproval: true,
    execute: async () => ({ text: 'page' }),
  }
  const { bridge } = await runtime(
    scripted(
      [
        { name: 'web_fetch', arguments: {} },
        { name: PROPOSE_MEMORY_TOOL, arguments: { content: '页面里说的' } },
        { name: PROPOSE_MEMORY_TOOL, arguments: { content: 'sk-proj-abcdefghijklmnopqrstuvwxyz' } },
      ],
      offered,
    ),
    [fetch],
    async input => {
      if (input.content.startsWith('sk-')) throw new Error('内容像是密钥或凭据，没有记下。')
      proposed.push(input)
    },
  )
  const { sessionId } = await bridge.createTask({ prompt: 'read it', requestId: 'external', agentContext: { ...context, proposals: true } })
  await vi.waitFor(() => expect(bridge.approvals()).toHaveLength(1))
  await bridge.decide(bridge.approvals()[0]!.id, 'allow')
  const detail = await settled(bridge, sessionId)
  expect(proposed).toEqual([expect.objectContaining({ content: '页面里说的', external: true })])
  const outputs = detail.messages.filter(message => message.role === 'tool').map(message => message.tool?.output)
  expect(outputs.at(-1)).toBe('TOOL_ERROR: 内容像是密钥或凭据，没有记下。')
})

it('a 只对话 run offers propose_memory and nothing else, and still refuses any other tool', async () => {
  const offered: string[][] = []
  const proposed: MemoryProposalInput[] = []
  const other: ToolDefinition = {
    name: 'read_file',
    description: 'read',
    parameters: { type: 'object' },
    requiresApproval: false,
    execute: async () => ({ text: 'file' }),
  }
  const { bridge } = await runtime(
    scripted([{ name: PROPOSE_MEMORY_TOOL, arguments: { content: '喜欢短回答' } }], offered),
    [other],
    async input => {
      proposed.push(input)
    },
  )
  const { sessionId } = await bridge.createTask({
    prompt: 'hi',
    requestId: 'chat-proposal',
    mode: 'chat',
    agentContext: { ...context, proposals: true },
  })
  const detail = await settled(bridge, sessionId)
  expect(detail.summary.mode).toBe('chat')
  expect(offered[0]).toEqual([PROPOSE_MEMORY_TOOL])
  expect(proposed).toEqual([expect.objectContaining({ content: '喜欢短回答', external: false })])

  // Without proposals a 只对话 run has no tools, and a call is refused as before.
  offered.length = 0
  const { bridge: plain } = await runtime(
    scripted([{ name: PROPOSE_MEMORY_TOOL, arguments: { content: 'x' } }], offered),
    [other],
    async () => {},
  )
  const refused = await plain.createTask({ prompt: 'hi', requestId: 'chat-plain', mode: 'chat', agentContext: context })
  await vi.waitFor(async () => expect((await plain.detail(refused.sessionId)).summary.status).toBe('failed'))
  expect(offered[0]).toEqual([])
})

it('marks everything a scheduled run proposes external', async () => {
  const proposed: MemoryProposalInput[] = []
  const { bridge } = await runtime(scripted([{ name: PROPOSE_MEMORY_TOOL, arguments: { content: '每周一汇总' } }], []), [], async input => {
    proposed.push(input)
  })
  const { sessionId } = await bridge.createTask({
    prompt: 'run',
    requestId: 'scheduled',
    agentContext: { ...context, proposals: true, unattended: true },
  })
  await settled(bridge, sessionId)
  expect(proposed).toEqual([expect.objectContaining({ content: '每周一汇总', external: true })])
})

/** Calls the given tool on the first step of every run, then answers. */
function everyTurn(
  call:
    | { name: string; arguments: Record<string, unknown> }
    | ((prompt: string) => { name: string; arguments: Record<string, unknown> } | undefined),
  unique = false,
): ModelProvider {
  return {
    id: 'fixture',
    name: 'Fixture',
    model: 'fixture-model',
    async *stream({ messages }) {
      const last = messages.at(-1)
      const prompt = last?.role === 'user' ? JSON.stringify(last.content) : ''
      const next = last?.role === 'user' ? (typeof call === 'function' ? call(prompt) : call) : undefined
      if (next) {
        // The same ID for the same tool, unless asked to differ: a fresh context may see it again.
        const id = next.name === PROPOSE_MEMORY_TOOL ? (unique ? `call-${messages.length}` : 'call-p') : 'call-f'
        yield { type: 'tool-call', call: { id, name: next.name, arguments: next.arguments } }
        yield { type: 'finish', reason: 'tool-calls' }
      } else {
        yield { type: 'text', text: '好的' }
        yield { type: 'finish', reason: 'stop' }
      }
    },
  }
}

it('keeps a session external after a page was read in an earlier turn, until its context starts over, with a key per run', async () => {
  const proposed: MemoryProposalInput[] = []
  const fetch: ToolDefinition = {
    name: 'web_fetch',
    description: 'fetch',
    parameters: { type: 'object' },
    requiresApproval: true,
    execute: async () => ({ text: 'page' }),
  }
  const { bridge } = await runtime(
    everyTurn(prompt =>
      prompt.includes('fetch')
        ? { name: 'web_fetch', arguments: {} }
        : { name: PROPOSE_MEMORY_TOOL, arguments: { content: prompt.slice(1, 9) } },
    ),
    [fetch],
    async input => {
      proposed.push(input)
    },
  )
  const agentContext = { ...context, proposals: true as const }
  const { sessionId } = await bridge.createTask({ prompt: 'fetch it', requestId: 'n', agentContext })
  await vi.waitFor(() => expect(bridge.approvals()).toHaveLength(1))
  await bridge.decide(bridge.approvals()[0]!.id, 'allow')
  await settled(bridge, sessionId)
  await bridge.prompt(sessionId, 'remember one', 'n1', { agentContext })
  await settled(bridge, sessionId)
  await bridge.prompt(sessionId, 'remember two', 'n2', { agentContext, freshContext: true })
  await settled(bridge, sessionId)
  expect(proposed.map(item => item.external)).toEqual([true, false])
  // The same call ID in two runs gives two keys.
  expect(new Set(proposed.map(item => item.key)).size).toBe(2)
  expect(proposed.every(item => item.key.endsWith(':call-p'))).toBe(true)
})

it('stops a session at 32 proposals and tells the agent so', async () => {
  const proposed: MemoryProposalInput[] = []
  const { bridge } = await runtime(everyTurn({ name: PROPOSE_MEMORY_TOOL, arguments: { content: '一条' } }, true), [], async input => {
    proposed.push(input)
  })
  const agentContext = { ...context, proposals: true as const }
  const { sessionId } = await bridge.createTask({ prompt: 'one', requestId: 'cap-0', agentContext })
  await settled(bridge, sessionId)
  for (let index = 1; index <= SESSION_PROPOSAL_LIMIT; index++) {
    await bridge.prompt(sessionId, `again ${index}`, `cap-${index}`, { agentContext })
    await settled(bridge, sessionId)
  }
  expect(proposed).toHaveLength(SESSION_PROPOSAL_LIMIT)
  const last = (await bridge.detail(sessionId)).messages.filter(message => message.role === 'tool').at(-1)
  expect(last?.tool?.output).toBe('TOOL_ERROR: This session has proposed as much as it may.')
}, 60_000)

it('offers propose_schedule beside propose_memory, without asking, hands the Host the plan as sent and gives the model its refusal', async () => {
  const offered: string[][] = []
  const schedules: ScheduleProposalInput[] = []
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-propose-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  const classifyToolCall = vi.fn(async (): Promise<RiskLevel> => 'R2')
  const provider = scripted(
    [
      { name: PROPOSE_SCHEDULE_TOOL, arguments: { name: '早间', plan: { kind: 'hourly' }, prompt: '整理' } },
      { name: PROPOSE_SCHEDULE_TOOL, arguments: { name: ' 早间 ', plan: { kind: 'daily', time: '08:00' }, prompt: ' 整理新闻 ' } },
    ],
    offered,
  )
  const bridge: Bridge = createRuntime({
    dataDir,
    workspaceRoot: dataDir,
    registry: { acquire: () => ({ provider, tools: [], release: () => {} }) },
    providerId: 'fixture',
    classifyToolCall,
    proposeMemory: async () => {},
    async proposeSchedule(input) {
      if ((input.plan as { kind?: string }).kind === 'hourly') throw new Error('The plan must be daily, weekdays or weekly.')
      schedules.push(input)
    },
  })
  cleanups.push(() => bridge.close())
  const { sessionId } = await bridge.createTask({
    prompt: 'hi',
    requestId: 'schedule',
    mode: 'chat',
    agentContext: { ...context, proposals: true },
  })
  const detail = await settled(bridge, sessionId)
  expect(offered[0]).toEqual([PROPOSE_MEMORY_TOOL, PROPOSE_SCHEDULE_TOOL])
  expect(classifyToolCall).not.toHaveBeenCalled()
  const outputs = detail.messages.filter(message => message.role === 'tool').map(message => message.tool?.output)
  expect(outputs[0]).toContain('The plan must be')
  expect(outputs[1]).toContain('nothing is scheduled yet')
  expect(schedules).toEqual([
    {
      sessionId,
      messageId: expect.any(String),
      name: '早间',
      plan: { kind: 'daily', time: '08:00' },
      prompt: '整理新闻',
      external: false,
      key: expect.stringMatching(/^call:[0-9a-f-]{36}:call-1$/u),
    },
  ])
})
