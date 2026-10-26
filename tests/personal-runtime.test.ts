import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { createRuntime, PluginRegistry } from '@latch/core'
import type { ModelMessage } from '@latch/sdk'
import type { PersonalExecutionContext } from '@latch/protocol'

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
  const personal: PersonalExecutionContext = {
    owner: { assistantId: `asst_${randomUUID()}` },
    instructions: 'ONLY PRIVATE MEMORY',
    pluginIds: ['selected'],
    revision: 'a'.repeat(64),
  }
  return { dir, registry, runtime, seen, personal }
}

test('enforces selected capabilities and keeps private instructions transient across restart and later turns', async () => {
  const { dir, registry, runtime, seen, personal } = await fixture()
  const input = { prompt: 'hello', requestId: 'personal-create', personal }
  const { sessionId } = await runtime.createTask(input)
  await vi.waitFor(async () => expect((await runtime.detail(sessionId)).summary.status).toBe('idle'))
  expect(seen[0]?.tools).toEqual(['selected_tool'])
  expect(seen[0]?.messages[0]).toEqual({ role: 'system', content: personal.instructions })
  expect(seen[0]?.messages.some(message => message.content.includes('selected skill'))).toBe(true)
  expect(seen[0]?.messages.some(message => message.content.includes('other skill'))).toBe(false)
  expect((await runtime.detail(sessionId)).messages[0]?.text).toBe('hello')
  expect((await runtime.detail(sessionId)).summary).toMatchObject({ personal: personal.owner, pluginIds: ['selected'] })
  expect(await readFile(join(dir, 'runtime.json'), 'utf8')).not.toContain(personal.instructions)
  expect(
    await runtime.createTask({ ...input, personal: { ...personal, instructions: 'new private memory', revision: 'b'.repeat(64) } }),
  ).toEqual({ sessionId })
  expect(seen).toHaveLength(1)
  await runtime.close()
  const restored = createRuntime({ dataDir: dir, workspaceRoot: dir, registry, providerId: 'fixture' })
  cleanup.push(() => restored.close())
  await expect(restored.prompt(sessionId, 'missing context', 'missing-context')).rejects.toMatchObject({
    code: 'personal-context-required',
  })
  await expect(
    restored.prompt(sessionId, 'other owner', 'other-owner', { personal: { ...personal, owner: { assistantId: `asst_${randomUUID()}` } } }),
  ).rejects.toMatchObject({ code: 'personal-context-required' })
  await restored.prompt(sessionId, 'next', 'next-turn', { personal: { ...personal, pluginIds: [], instructions: 'NEW PRIVATE MEMORY' } })
  await vi.waitFor(async () => expect((await restored.detail(sessionId)).summary.status).toBe('idle'))
  expect(seen[1]?.tools).toEqual([])
  expect(seen[1]?.messages[0]?.content).toBe('NEW PRIVATE MEMORY')
  expect(seen[1]?.messages.some(message => message.content.includes('ONLY PRIVATE MEMORY'))).toBe(false)
  expect(await readFile(join(dir, 'runtime.json'), 'utf8')).not.toContain('NEW PRIVATE MEMORY')
})

test('fails closed when a selected plugin is removed, without recording or executing the input', async () => {
  const { runtime, registry, personal, seen } = await fixture()
  await registry.disable('selected')
  await expect(runtime.createTask({ prompt: 'hello', requestId: 'removed-plugin', personal })).rejects.toMatchObject({
    code: 'personal-plugin-unavailable',
  })
  expect(await runtime.listTasks()).toEqual([])
  expect(seen).toEqual([])
})

test('ordinary sessions keep the existing global plugin behavior and cannot acquire a personal owner later', async () => {
  const { runtime, personal, seen } = await fixture()
  const { sessionId } = await runtime.createTask({ prompt: 'ordinary', requestId: 'ordinary' })
  await vi.waitFor(async () => expect((await runtime.detail(sessionId)).summary.status).toBe('idle'))
  expect(seen[0]?.tools.sort()).toEqual(['other_tool', 'provider_tool', 'selected_tool'])
  await expect(runtime.prompt(sessionId, 'adopt', 'adopt-owner', { personal })).rejects.toMatchObject({ code: 'personal-context-required' })
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
    runtime.createTask({ prompt: 'delegated', requestId: 'revision-bound', personal: { ...personal, expectedRevisions: grant } }),
  ).rejects.toMatchObject({ code: 'plugin-revision-changed' })
  expect(await runtime.listTasks()).toEqual([])
  expect(seen).toEqual([])
})
