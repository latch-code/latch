import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { createRuntime, PluginRegistry } from '@latch/core'
import type { ModelMessage } from '@latch/sdk'
import type { AgentExecutionContext } from '@latch/protocol'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'latch-agent-runtime-'))
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
  const owned: AgentExecutionContext = {
    agent: { customAgentId: `agt_${randomUUID()}` },
    instructions: 'ONLY PRIVATE MEMORY',
    pluginIds: ['selected'],
    revision: 'a'.repeat(64),
  }
  return { dir, registry, runtime, seen, owned }
}

test('enforces selected capabilities and keeps private instructions transient across restart and later turns', async () => {
  const { dir, registry, runtime, seen, owned } = await fixture()
  const input = { prompt: 'hello', requestId: 'agent-create', agentContext: owned }
  const { sessionId } = await runtime.createTask(input)
  await vi.waitFor(async () => expect((await runtime.detail(sessionId)).summary.status).toBe('idle'))
  expect(seen[0]?.tools).toEqual(['selected_tool'])
  expect(seen[0]?.messages[1]).toEqual({ role: 'system', content: owned.instructions })
  expect(seen[0]?.messages.some(message => message.content.includes('selected skill'))).toBe(true)
  expect(seen[0]?.messages.some(message => message.content.includes('other skill'))).toBe(false)
  expect((await runtime.detail(sessionId)).messages[0]?.text).toBe('hello')
  expect((await runtime.detail(sessionId)).summary).toMatchObject({ agent: owned.agent, pluginIds: ['selected'] })
  expect(await readFile(join(dir, 'runtime.json'), 'utf8')).not.toContain(owned.instructions)
  expect(
    await runtime.createTask({ ...input, agentContext: { ...owned, instructions: 'new private memory', revision: 'b'.repeat(64) } }),
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
      agentContext: { ...owned, agent: { customAgentId: `agt_${randomUUID()}` } },
    }),
  ).rejects.toMatchObject({ code: 'agent-context-required' })
  await restored.prompt(sessionId, 'next', 'next-turn', {
    agentContext: { ...owned, pluginIds: [], instructions: 'NEW PRIVATE MEMORY' },
  })
  await vi.waitFor(async () => expect((await restored.detail(sessionId)).summary.status).toBe('idle'))
  expect(seen[1]?.tools).toEqual([])
  expect(seen[1]?.messages[1]?.content).toBe('NEW PRIVATE MEMORY')
  expect(seen[1]?.messages.some(message => message.content.includes('ONLY PRIVATE MEMORY'))).toBe(false)
  expect(await readFile(join(dir, 'runtime.json'), 'utf8')).not.toContain('NEW PRIVATE MEMORY')
})

test('fails closed when a selected plugin is removed, without recording or executing the input', async () => {
  const { runtime, registry, owned, seen } = await fixture()
  await registry.disable('selected')
  await expect(runtime.createTask({ prompt: 'hello', requestId: 'removed-plugin', agentContext: owned })).rejects.toMatchObject({
    code: 'agent-plugin-unavailable',
  })
  expect(await runtime.listTasks()).toEqual([])
  expect(seen).toEqual([])
})

test("persists an agent session's actual model even when selected from the implicit default and keeps it after restart", async () => {
  const { runtime, registry, owned, dir, seen } = await fixture()
  const { sessionId } = await runtime.createTask({ prompt: 'Agent default', requestId: 'agent-default', agentContext: owned })
  await vi.waitFor(async () => expect((await runtime.detail(sessionId)).summary.status).toBe('idle'))
  expect((await runtime.detail(sessionId)).summary).toMatchObject({ providerId: 'fixture', model: 'fixture' })
  await runtime.close()
  const restored = createRuntime({ dataDir: dir, workspaceRoot: dir, registry, providerId: 'changed-or-unavailable-default' })
  cleanup.push(() => restored.close())
  await restored.prompt(sessionId, 'Same selected model', 'agent-same-model', { agentContext: owned })
  await vi.waitFor(async () => expect((await restored.detail(sessionId)).summary.status).toBe('idle'))
  expect(seen).toHaveLength(2)
})

test('ordinary sessions keep the existing global plugin behavior and cannot acquire an agent later', async () => {
  const { runtime, owned, seen } = await fixture()
  const { sessionId } = await runtime.createTask({ prompt: 'ordinary', requestId: 'ordinary' })
  await vi.waitFor(async () => expect((await runtime.detail(sessionId)).summary.status).toBe('idle'))
  expect(seen[0]?.tools.sort()).toEqual(['other_tool', 'provider_tool', 'selected_tool'])
  await expect(runtime.prompt(sessionId, 'adopt', 'adopt-owner', { agentContext: owned })).rejects.toMatchObject({
    code: 'agent-context-required',
  })
})

test('rechecks the saved capability revisions in the real runtime before it persists or starts a delegated run', async () => {
  const { runtime, registry, owned, seen } = await fixture()
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
    runtime.createTask({ prompt: 'delegated', requestId: 'revision-bound', agentContext: { ...owned, expectedRevisions: grant } }),
  ).rejects.toMatchObject({ code: 'plugin-revision-changed' })
  expect(await runtime.listTasks()).toEqual([])
  expect(seen).toEqual([])
})

test("an assistant's session kept on disk opens to be read and refuses every new turn", async () => {
  const { dir, registry, runtime, seen, owned } = await fixture()
  const { sessionId } = await runtime.createTask({ prompt: 'before', requestId: 'assistant-before' })
  await vi.waitFor(async () => expect((await runtime.detail(sessionId)).summary.status).toBe('idle'))
  await runtime.close()
  const file = join(dir, 'runtime.json'),
    state = JSON.parse(await readFile(file, 'utf8'))
  state.tasks[sessionId].summary.personal = { assistantId: `asst_${randomUUID()}` }
  await writeFile(file, JSON.stringify(state))
  const restored = createRuntime({ dataDir: dir, workspaceRoot: dir, registry, providerId: 'fixture' })
  cleanup.push(() => restored.close())
  const detail = await restored.detail(sessionId)
  expect(detail.summary.personal).toEqual(state.tasks[sessionId].summary.personal)
  expect(detail.messages.map(message => message.text)).toEqual(['before', 'Done'])
  const readOnly = { status: 409, code: 'session-read-only' }
  await expect(restored.prompt(sessionId, 'after', 'assistant-after')).rejects.toMatchObject(readOnly)
  await expect(restored.prompt(sessionId, 'after', 'assistant-agent', { agentContext: owned })).rejects.toMatchObject(readOnly)
  expect(seen).toHaveLength(1)
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
