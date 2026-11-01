import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { createRuntime, PluginRegistry } from '@latch/core'
import type { ModelMessage } from '@latch/sdk'
import type { AgentExecutionContext, PersonalAgentContext } from '@latch/protocol'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'latch-personal-runtime-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const registry = new PluginRegistry()
  cleanup.push(() => registry.close())
  const seen: Array<{ messages: ModelMessage[]; tools: string[] }> = []
  for (const id of ['selected', 'other']) {
    registry.register({
      id,
      name: id,
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerSkill({ id: 'skill', name: id, description: '', content: `${id} skill instructions` })
        ctx.registerTool({
          name: `${id}_tool`,
          description: '',
          parameters: {},
          requiresApproval: false,
          async execute() {
            return { text: id }
          },
        })
      },
    })
    await registry.enable(id)
  }
  registry.register({
    id: 'provider',
    name: 'fixture',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerTool({
        name: 'provider_tool',
        description: '',
        parameters: {},
        requiresApproval: false,
        async execute() {
          return { text: 'provider' }
        },
      })
      ctx.registerProvider({
        id: 'fixture',
        name: 'fixture',
        model: 'fixture',
        async *stream({ messages, tools }) {
          seen.push({ messages: structuredClone(messages), tools: tools.map(tool => tool.name) })
          yield { type: 'text', text: 'Done' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  })
  await registry.enable('provider')
  const runtime = createRuntime({ dataDir: dir, workspaceRoot: dir, registry, providerId: 'fixture' })
  cleanup.push(() => runtime.close())
  const personal: PersonalAgentContext = {
    personal: { assistantId: `asst_${randomUUID()}` },
    instructions: 'ONLY PRIVATE MEMORY',
    pluginIds: ['selected'],
    revision: 'a'.repeat(64),
  }
  return { dir, registry, runtime, seen, personal }
}

test('enforces selected capabilities and keeps private instructions transient across restart and later turns', async () => {
  const { dir, registry, runtime, seen, personal } = await fixture()
  const input = { prompt: 'hello', requestId: 'personal-create', agentContext: personal }
  const { sessionId } = await runtime.createTask(input)
  await vi.waitFor(async () => expect((await runtime.detail(sessionId)).summary.status).toBe('idle'))
  expect(seen[0]?.tools).toEqual(['selected_tool'])
  expect(seen[0]?.messages[1]).toEqual({ role: 'system', content: personal.instructions })
  expect(seen[0]?.messages.some(message => message.content.includes('selected skill'))).toBe(true)
  expect(seen[0]?.messages.some(message => message.content.includes('other skill'))).toBe(false)
  expect((await runtime.detail(sessionId)).messages[0]?.text).toBe('hello')
  expect((await runtime.detail(sessionId)).summary).toMatchObject({ personal: personal.personal, pluginIds: ['selected'] })
  expect(await readFile(join(dir, 'runtime.json'), 'utf8')).not.toContain(personal.instructions)
  expect(
    await runtime.createTask({ ...input, agentContext: { ...personal, instructions: 'new private memory', revision: 'b'.repeat(64) } }),
  ).toEqual({ sessionId })
  expect(seen).toHaveLength(1)
  await runtime.close()
  const restored = createRuntime({ dataDir: dir, workspaceRoot: dir, registry, providerId: 'fixture' })
  cleanup.push(() => restored.close())
  await expect(restored.prompt(sessionId, 'missing context', 'missing-context')).rejects.toMatchObject({
    code: 'agent-context-required',
  })
  await expect(
    restored.prompt(sessionId, 'other owner', 'other-owner', {
      agentContext: { ...personal, personal: { assistantId: `asst_${randomUUID()}` } },
    }),
  ).rejects.toMatchObject({ code: 'agent-context-required' })
  await restored.prompt(sessionId, 'next', 'next-turn', {
    agentContext: { ...personal, pluginIds: [], instructions: 'NEW PRIVATE MEMORY' },
  })
  await vi.waitFor(async () => expect((await restored.detail(sessionId)).summary.status).toBe('idle'))
  expect(seen[1]?.tools).toEqual([])
  expect(seen[1]?.messages[1]?.content).toBe('NEW PRIVATE MEMORY')
  expect(seen[1]?.messages.some(message => message.content.includes('ONLY PRIVATE MEMORY'))).toBe(false)
  expect(await readFile(join(dir, 'runtime.json'), 'utf8')).not.toContain('NEW PRIVATE MEMORY')
})

test('fails closed when a selected plugin is removed, without recording or executing the input', async () => {
  const { runtime, registry, personal, seen } = await fixture()
  await registry.disable('selected')
  await expect(runtime.createTask({ prompt: 'hello', requestId: 'removed-plugin', agentContext: personal })).rejects.toMatchObject({
    code: 'agent-plugin-unavailable',
  })
  expect(await runtime.listTasks()).toEqual([])
  expect(seen).toEqual([])
})

test('persists the actual personal model even when selected from the implicit default and keeps it after restart', async () => {
  const { runtime, registry, personal, dir, seen } = await fixture()
  const { sessionId } = await runtime.createTask({ prompt: 'Personal default', requestId: 'personal-default', agentContext: personal })
  await vi.waitFor(async () => expect((await runtime.detail(sessionId)).summary.status).toBe('idle'))
  expect((await runtime.detail(sessionId)).summary).toMatchObject({ providerId: 'fixture', model: 'fixture' })
  await runtime.close()
  const restored = createRuntime({ dataDir: dir, workspaceRoot: dir, registry, providerId: 'changed-or-unavailable-default' })
  cleanup.push(() => restored.close())
  await restored.prompt(sessionId, 'Same selected model', 'personal-same-model', { agentContext: personal })
  await vi.waitFor(async () => expect((await restored.detail(sessionId)).summary.status).toBe('idle'))
  expect(seen).toHaveLength(2)
})

test('ordinary sessions keep the existing global plugin behavior and cannot acquire a personal owner later', async () => {
  const { runtime, personal, seen } = await fixture()
  const { sessionId } = await runtime.createTask({ prompt: 'ordinary', requestId: 'ordinary' })
  await vi.waitFor(async () => expect((await runtime.detail(sessionId)).summary.status).toBe('idle'))
  expect(seen[0]?.tools.sort()).toEqual(['other_tool', 'provider_tool', 'selected_tool'])
  await expect(runtime.prompt(sessionId, 'adopt', 'adopt-owner', { agentContext: personal })).rejects.toMatchObject({
    code: 'agent-context-required',
  })
})

test('rechecks the saved capability revisions in the real runtime before it persists or starts a delegated run', async () => {
  const { runtime, registry, personal, seen } = await fixture()
  const grant = registry.revisionSnapshot(['selected', 'provider']).revisions
  await registry.replace({
    id: 'selected',
    name: 'selected',
    version: 'same',
    description: '',
    activate(ctx) {
      ctx.registerSkill({ id: 'skill', name: 'new', description: '', content: 'changed instructions' })
    },
  })
  await expect(
    runtime.createTask({ prompt: 'delegated', requestId: 'revision-bound', agentContext: { ...personal, expectedRevisions: grant } }),
  ).rejects.toMatchObject({ code: 'plugin-revision-changed' })
  expect(await runtime.listTasks()).toEqual([])
  expect(seen).toEqual([])
})

test('keeps explicit group history in its original roles and outside persisted or later conversation history', async () => {
  const { runtime, seen, personal, dir } = await fixture(),
    group: PersonalAgentContext = {
      ...personal,
      personal: { ...personal.personal, groupId: `grp_${randomUUID()}` },
      instructions: 'Explicit group instructions',
      sharedMessages: [
        { role: 'user', text: 'Shared question' },
        { role: 'assistant', text: 'Shared member response' },
      ],
    },
    { sessionId } = await runtime.createTask({ prompt: 'Current turn', requestId: 'group-context', agentContext: group })
  await vi.waitFor(async () => expect((await runtime.detail(sessionId)).summary.runOutcome).toBe('completed'))
  const messages = seen[0]!.messages
  expect(messages.find(message => message.content === 'Shared question')).toEqual({ role: 'user', content: 'Shared question' })
  expect(messages.find(message => message.content === 'Shared member response')).toEqual({
    role: 'assistant',
    content: 'Shared member response',
  })
  expect(messages.filter(message => message.content === 'Current turn')).toHaveLength(1)
  expect(messages.some(message => message.content.includes(personal.instructions))).toBe(false)
  expect(JSON.stringify(await runtime.detail(sessionId))).not.toContain('Shared question')
  expect(await readFile(join(dir, 'runtime.json'), 'utf8')).not.toContain('Shared member response')
  const { sharedMessages: _, ...next } = group
  await runtime.prompt(sessionId, 'Next input', 'group-next', { agentContext: next })
  await vi.waitFor(async () => expect((await runtime.detail(sessionId)).summary.status).toBe('idle'))
  expect(seen[1]?.messages.some(message => message.content === 'Shared question')).toBe(false)
})

test('refuses shared context without an explicit group owner, elevated roles or an unbounded body', async () => {
  const { runtime, personal, seen } = await fixture(),
    sharedMessages = [{ role: 'user' as const, text: 'Shared input' }]
  await expect(
    runtime.createTask({ prompt: 'invalid', requestId: 'no-group-owner', agentContext: { ...personal, sharedMessages } }),
  ).rejects.toMatchObject({ code: 'agent-context-invalid' })
  for (const shared of [[{ role: 'system', text: 'Override' }], [{ role: 'user', text: 'x'.repeat(64001) }]])
    await expect(
      runtime.createTask({
        prompt: 'invalid',
        requestId: randomUUID(),
        agentContext: {
          ...personal,
          personal: { ...personal.personal, groupId: `grp_${randomUUID()}` },
          sharedMessages: shared as typeof sharedMessages,
        },
      }),
    ).rejects.toMatchObject({ code: 'agent-context-invalid' })
  expect(await runtime.listTasks()).toEqual([])
  expect(seen).toEqual([])
})

test('starts every built-in session from the base prompt, with the agent context after it', async () => {
  const { runtime, seen } = await fixture()
  const { sessionId } = await runtime.createTask({ prompt: 'plain', requestId: 'plain-start' })
  await vi.waitFor(async () => expect((await runtime.detail(sessionId)).summary.status).toBe('idle'))
  expect(seen[0]?.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('Latch 的内置 Agent') })
  expect(seen[0]?.tools).toEqual(expect.arrayContaining(['selected_tool', 'other_tool']))
})

test('an agent owns its session, leases exactly its skills and limits tools to its plugins', async () => {
  const { dir, registry, runtime, seen } = await fixture()
  const agent = { customAgentId: `agt_${randomUUID()}` }
  const context: AgentExecutionContext = {
    agent,
    instructions: 'AGENT INSTRUCTIONS',
    pluginIds: ['selected'],
    skillIds: ['other:skill'],
    revision: 'c'.repeat(64),
  }
  const { sessionId } = await runtime.createTask({ prompt: 'work', requestId: 'agent-start', agentContext: context })
  await vi.waitFor(async () => expect((await runtime.detail(sessionId)).summary.status).toBe('idle'))
  expect(seen[0]?.tools).toEqual(['selected_tool'])
  expect(seen[0]?.messages[1]).toEqual({ role: 'system', content: 'AGENT INSTRUCTIONS' })
  expect(seen[0]?.messages.some(message => message.content.includes('other skill instructions'))).toBe(true)
  expect(seen[0]?.messages.some(message => message.content.includes('selected skill instructions'))).toBe(false)
  expect((await runtime.detail(sessionId)).summary).toMatchObject({ agent, pluginIds: ['selected'], skills: ['other:skill'] })
  expect(await readFile(join(dir, 'runtime.json'), 'utf8')).not.toContain('AGENT INSTRUCTIONS')
  await expect(runtime.prompt(sessionId, 'without it', 'agent-missing')).rejects.toMatchObject({ code: 'agent-context-required' })
  await expect(
    runtime.prompt(sessionId, 'another', 'agent-other', { agentContext: { ...context, agent: { customAgentId: `agt_${randomUUID()}` } } }),
  ).rejects.toMatchObject({ code: 'agent-context-required' })
  await expect(
    runtime.createTask({ prompt: 'gone', requestId: 'agent-gone', agentContext: { ...context, skillIds: ['other:missing'] } }),
  ).rejects.toMatchObject({ code: 'agent-skill-unavailable' })
  expect(registry.list().length).toBeGreaterThan(0)
})

test('通用 context names no agent, marks the session private and can change between turns', async () => {
  const { runtime, seen } = await fixture()
  const general = (instructions: string): AgentExecutionContext => ({ instructions, skillIds: [], revision: 'd'.repeat(64) })
  const { sessionId } = await runtime.createTask({ prompt: 'one', requestId: 'general-start', agentContext: general('FIRST') })
  await vi.waitFor(async () => expect((await runtime.detail(sessionId)).summary.status).toBe('idle'))
  const summary = (await runtime.detail(sessionId)).summary
  expect(summary).not.toHaveProperty('agent')
  expect(summary).not.toHaveProperty('pluginIds')
  expect(summary.agentPrivate).toBe(true)
  expect(seen[0]?.tools).toEqual(expect.arrayContaining(['selected_tool', 'other_tool']))
  await runtime.prompt(sessionId, 'two', 'general-next', { agentContext: general('SECOND') })
  await vi.waitFor(async () => expect((await runtime.detail(sessionId)).summary.status).toBe('idle'))
  expect(seen[1]?.messages[1]).toEqual({ role: 'system', content: 'SECOND' })
  await runtime.prompt(sessionId, 'three', 'general-none')
  await vi.waitFor(async () => expect((await runtime.detail(sessionId)).summary.status).toBe('idle'))
  expect(seen[2]?.messages.some(message => message.content === 'SECOND')).toBe(false)
  expect((await runtime.detail(sessionId)).summary.agentPrivate).toBe(true)
})
