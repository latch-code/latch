import { mkdtemp, readFile, rename, rm, open, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { GENERAL_AGENT_ID } from '@latch/protocol'
import { CustomAgents, firstTurnBrief, privateInstructions, type AgentActor } from '../src/custom-agents.ts'

const roots: string[] = []
const stores: CustomAgents[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const actor: AgentActor = { actor: { deviceId: 'dev_owner', listener: 'unix' }, authorize: () => {} }
const definition = () => ({
  requestId: randomUUID(),
  name: '代码审阅',
  description: '只报真实的问题',
  harnessId: 'standard',
  mode: 'agent' as const,
  instructions: '不改代码',
  skills: [],
})
async function fixture(options: Partial<Parameters<typeof CustomAgents.open>[0]> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-custom-agents-'))
  roots.push(dataDir)
  const audit = { append: vi.fn(async () => undefined as never) }
  const open = () => CustomAgents.open({ dataDir, audit, now: () => Date.parse('2026-11-01T00:00:00Z'), ...options })
  const store = await open()
  stores.push(store)
  return { dataDir, audit, store, open }
}

test('keeps agents and memories private on disk and audits ids and hashes only', async () => {
  const { dataDir, audit, store, open: reopen } = await fixture()
  const created = (await store.create(definition(), actor)).value
  expect(created.id).toMatch(/^agt_/u)
  expect(created.glyph).toBe('glasses')
  const memory = (await store.createMemory(created.id, { requestId: randomUUID(), content: 'SECRET MEMORY' }, actor)).value
  expect((await stat(join(dataDir, 'agents'))).mode & 0o777).toBe(0o700)
  expect((await stat(join(dataDir, 'agents/custom.json'))).mode & 0o777).toBe(0o600)
  const details = JSON.stringify(audit.append.mock.calls)
  expect(details).not.toContain('SECRET MEMORY')
  expect(details).not.toContain('代码审阅')
  await store.close()
  const again = await reopen()
  stores.push(again)
  expect(again.memories(created.id)).toEqual([memory])
  expect(again.get(created.id).instructions).toBe('不改代码')
})

test('a retry is answered by its receipt, and a request cannot be reused for something else', async () => {
  const { store, audit } = await fixture()
  const request = definition()
  const first = (await store.create(request, actor)).value
  const count = audit.append.mock.calls.length
  expect((await store.create(request, actor)).value.id).toBe(first.id)
  expect(audit.append.mock.calls.length).toBe(count)
  expect(store.list()).toHaveLength(1)
  await expect(store.create({ ...request, name: '别的' }, actor)).rejects.toMatchObject({ code: 'request-conflict' })
})

test('an unknown write stays one record and blocks other work until it is retried', async () => {
  let fail = true
  const { store, dataDir } = await fixture({
    atomicFs: {
      open,
      async rename(from: string, to: string) {
        await rename(from, to)
        if (fail) throw new Error('fsync fault')
      },
    },
  })
  const request = definition()
  await expect(store.create(request, actor)).rejects.toMatchObject({ code: 'agent-write-unknown' })
  await expect(store.create(definition(), actor)).rejects.toMatchObject({ code: 'agent-write-unknown' })
  fail = false
  const created = (await store.create(request, actor)).value
  expect(store.list().map(agent => agent.id)).toEqual([created.id])
  expect(await readFile(join(dataDir, 'agents/custom.json'), 'utf8')).toContain(created.id)
})

test('an unknown write finishes by itself, so reads do not wait for someone to retry that request', async () => {
  let fail = true
  const { store } = await fixture({
    atomicFs: {
      open,
      async rename(from: string, to: string) {
        await rename(from, to)
        if (fail) throw new Error('fsync fault')
      },
    },
  })
  await expect(store.create(definition(), actor)).rejects.toMatchObject({ code: 'agent-write-unknown' })
  expect(store.hasPending()).toBe(true)
  expect(() => store.general()).toThrow('修改结果尚未确认')
  fail = false
  await vi.waitFor(() => expect(store.hasPending()).toBe(false), { timeout: 4000, interval: 50 })
  expect(store.list()).toHaveLength(1)
  expect(store.general().id).toBe(GENERAL_AGENT_ID)
})

test('patches by revision, clears optional fields with null, and refuses a stale edit', async () => {
  const { store } = await fixture()
  const created = (await store.create({ ...definition(), model: { providerId: 'p', model: 'm' }, tools: ['files'] }, actor)).value
  const patched = (
    await store.patch(created.id, { requestId: randomUUID(), baseRevision: 1, model: null, tools: null, name: '新名字' }, actor)
  ).value
  expect(patched).toMatchObject({ revision: 2, name: '新名字', instructions: '不改代码' })
  expect(patched).not.toHaveProperty('model')
  expect(patched).not.toHaveProperty('tools')
  await expect(store.patch(created.id, { requestId: randomUUID(), baseRevision: 1, name: '旧' }, actor)).rejects.toMatchObject({
    code: 'agent-changed',
  })
})

test('the definition hash follows what a run receives, not its name', async () => {
  const { store } = await fixture()
  const { id } = (await store.create(definition(), actor)).value
  const hash = store.definitionHash(id)
  await store.patch(id, { requestId: randomUUID(), baseRevision: 1, name: '改名' }, actor)
  expect(store.definitionHash(id)).toBe(hash)
  await store.patch(id, { requestId: randomUUID(), baseRevision: 2, instructions: '改指令' }, actor)
  const edited = store.definitionHash(id)
  expect(edited).not.toBe(hash)
  await store.createMemory(id, { requestId: randomUUID(), content: '一条记忆' }, actor)
  expect(store.definitionHash(id)).not.toBe(edited)
})

test('a start keeps its first selection even if the agent moves to another engine', async () => {
  const { store } = await fixture()
  const { id } = (await store.create(definition(), actor)).value
  const rid = randomUUID()
  const first = await store.reserveStart(id, rid, () => ({ harnessId: 'standard', mode: 'agent' }), actor)
  await store.patch(id, { requestId: randomUUID(), baseRevision: 1, harnessId: 'codex' }, actor)
  expect(await store.reserveStart(id, rid, () => ({ harnessId: 'codex', mode: 'agent' }), actor)).toEqual(first)
  const other = (await store.create(definition(), actor)).value
  await expect(store.reserveStart(other.id, rid, () => ({ harnessId: 'standard', mode: 'agent' }), actor)).rejects.toMatchObject({
    code: 'request-conflict',
  })
})

test('通用 starts empty, takes instructions, skills and memories, and cannot be deleted through the store', async () => {
  const { store } = await fixture()
  expect(store.general()).toMatchObject({ id: GENERAL_AGENT_ID, instructions: '', revision: 1 })
  expect(store.general()).not.toHaveProperty('skills')
  const hash = store.definitionHash(GENERAL_AGENT_ID)
  await store.patchGeneral({ requestId: randomUUID(), baseRevision: 1, instructions: '先说结论', skills: [] }, actor)
  expect(store.general()).toMatchObject({ instructions: '先说结论', skills: [], revision: 2 })
  expect(store.definitionHash(GENERAL_AGENT_ID)).not.toBe(hash)
  await store.patchGeneral({ requestId: randomUUID(), baseRevision: 2, skills: null }, actor)
  expect(store.general()).not.toHaveProperty('skills')
  const memory = (await store.createMemory(GENERAL_AGENT_ID, { requestId: randomUUID(), content: '用中文' }, actor)).value
  expect(store.memories(GENERAL_AGENT_ID)).toEqual([memory])
})

test('a deletion proceeds when the audit fails; a change does not', async () => {
  const { store, audit } = await fixture()
  const { id } = (await store.create(definition(), actor)).value
  audit.append.mockRejectedValue(new Error('audit down'))
  await expect(store.create(definition(), actor)).rejects.toThrow('audit down')
  await expect(store.patch(id, { requestId: randomUUID(), baseRevision: 1, name: 'x' }, actor)).rejects.toThrow('audit down')
  await expect(store.remove(id, randomUUID(), actor)).resolves.toMatchObject({ audited: false })
  expect(store.list()).toEqual([])
})

test('the first-turn block says who wrote what and adds nothing when there is nothing to add', () => {
  const memories = [{ id: 'mem', content: '项目用 pnpm', revision: 1, createdAt: '', updatedAt: '' }]
  expect(firstTurnBrief({ agentName: '通用', engineName: 'Codex', instructions: '  ', memories: [], skillNames: [] })).toBeUndefined()
  const brief = firstTurnBrief({
    agentName: '代码审阅',
    engineName: 'Codex',
    instructions: '只审阅',
    memories,
    skillNames: ['审阅清单', '发版检查'],
  })!
  expect(brief.segments.filter(segment => segment.source === 'user').map(segment => segment.text)).toEqual(['只审阅', '项目用 pnpm'])
  expect(brief.segments[0]).toEqual({ source: 'latch', text: expect.stringContaining('Codex 自带的提示词和工具不变') })
  expect(brief.segments.at(-1)?.text).toContain('「审阅清单」「发版检查」')
  expect(privateInstructions({ instructions: '只审阅', memories })).toBe('只审阅\n\n用户明确维护的记忆：\n\n项目用 pnpm')
})
