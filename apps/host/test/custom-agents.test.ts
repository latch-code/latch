import { mkdir, mkdtemp, readFile, rename, rm, open, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { AGENT_BRACKETS, AGENT_HUES, GENERAL_AGENT_ID } from '@latch/protocol'
import { avatarFor, CustomAgents, firstTurnBrief, privateInstructions, type AgentActor } from '../src/custom-agents.ts'

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
  expect(created.avatar).toEqual({ kind: 'face', bracket: 'round', eyes: 'dot', hue: 'ink' })
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

test('notifications and keep-awake are stored per Agent, audited, outside the definition hash, and cleared back to the default', async () => {
  const { store, audit } = await fixture()
  const { id } = (await store.create(definition(), actor)).value
  const hash = store.definitionHash(id)
  const calls = audit.append.mock.calls.length
  const first = await store.patch(
    id,
    {
      requestId: randomUUID(),
      baseRevision: 1,
      notifications: { completed: false, failed: true, waiting: false },
      keepAwakeForSchedules: true,
    },
    actor,
  )
  expect(first.value).toMatchObject({
    revision: 2,
    notifications: { completed: false, failed: true, waiting: false },
    keepAwakeForSchedules: true,
  })
  expect(audit.append.mock.calls.length).toBe(calls + 1)
  expect(store.definitionHash(id)).toBe(hash)
  const second = await store.patch(
    id,
    { requestId: randomUUID(), baseRevision: 2, notifications: null, keepAwakeForSchedules: false },
    actor,
  )
  expect(second.value).not.toHaveProperty('notifications')
  expect(second.value).not.toHaveProperty('keepAwakeForSchedules')
  await expect(store.patch(id, { requestId: randomUUID(), baseRevision: 1, keepAwakeForSchedules: true }, actor)).rejects.toMatchObject({
    code: 'agent-changed',
  })
  expect(() => store.patch(id, { requestId: randomUUID(), baseRevision: 3, notifications: { completed: true } } as never, actor)).toThrow()
})

test('a start keeps its first selection even if the agent changes since', async () => {
  const { store } = await fixture()
  const { id } = (await store.create(definition(), actor)).value
  const rid = randomUUID()
  const first = await store.reserveStart(id, rid, () => ({ harnessId: 'standard', mode: 'agent' }), actor)
  await store.patch(id, { requestId: randomUUID(), baseRevision: 1, mode: 'chat' }, actor)
  expect(await store.reserveStart(id, rid, () => ({ harnessId: 'standard', mode: 'chat' }), actor)).toEqual(first)
  const other = (await store.create(definition(), actor)).value
  await expect(store.reserveStart(other.id, rid, () => ({ harnessId: 'standard', mode: 'agent' }), actor)).rejects.toMatchObject({
    code: 'request-conflict',
  })
})

test('the Harness is fixed once created: another is refused, its own passes, and a retry answers from its receipt', async () => {
  const { store, audit } = await fixture()
  const { id } = (await store.create(definition(), actor)).value
  const calls = audit.append.mock.calls.length
  await expect(store.patch(id, { requestId: randomUUID(), baseRevision: 1, harnessId: 'codex' }, actor)).rejects.toMatchObject({
    status: 409,
    code: 'agent-harness-fixed',
  })
  // Refused before anything is written or audited.
  expect(audit.append.mock.calls.length).toBe(calls)
  expect(store.get(id)).toMatchObject({ harnessId: 'standard', revision: 1 })
  // Naming its own Harness again changes nothing about it, as any other field may be sent unchanged.
  const same = { requestId: randomUUID(), baseRevision: 1, harnessId: 'standard', name: '审阅' }
  const renamed = await store.patch(id, same, actor)
  expect(renamed.value).toMatchObject({ harnessId: 'standard', name: '审阅', revision: 2 })
  expect((await store.patch(id, same, actor)).value.revision).toBe(2)
})

test('a new Agent takes the face chosen while creating it, and the Host assigns one otherwise', async () => {
  const { store } = await fixture()
  const face = { kind: 'face' as const, bracket: 'angle' as const, eyes: 'oval' as const, hue: 'moss' as const }
  expect((await store.create({ ...definition(), avatar: face }, actor)).value.avatar).toEqual(face)
  expect((await store.create(definition(), actor)).value.avatar).toEqual({ kind: 'face', bracket: 'round', eyes: 'dot', hue: 'ink' })
  expect(() => store.create({ ...definition(), avatar: { ...face, hue: 'red' } } as never, actor)).toThrow()
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

const V1_GLYPHS = [
  'glasses',
  'library',
  'newspaper',
  'package',
  'pen-line',
  'flask-conical',
  'compass',
  'hammer',
  'lightbulb',
  'list-checks',
  'palette',
  'telescope',
]
async function writeV1(dataDir: string, agents: Array<Record<string, unknown>>, rest: Record<string, unknown> = {}) {
  await mkdir(join(dataDir, 'agents'), { recursive: true, mode: 0o700 })
  const state = {
    version: 1,
    general: { id: GENERAL_AGENT_ID, instructions: '', revision: 1 },
    agents,
    memories: {},
    starts: {},
    receipts: {},
    ...rest,
  }
  await writeFile(join(dataDir, 'agents/custom.json'), JSON.stringify(state), { mode: 0o600 })
}
const v1Agent = (glyph: string, index: number) => ({
  id: `agt_${randomUUID()}`,
  name: `Agent ${index}`,
  description: '',
  harnessId: 'standard',
  mode: 'agent',
  instructions: '',
  skills: [],
  glyph,
  revision: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
})

test('version 1 becomes version 2: each of the 12 glyphs gets its fixed avatar, written back and read again', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-custom-agents-'))
  roots.push(dataDir)
  const rows = V1_GLYPHS.map(v1Agent)
  const at = '2026-11-01T00:00:00.000Z'
  const memories = {
    [rows[0]!.id]: [{ id: `mem_${randomUUID()}`, content: '项目用 pnpm', revision: 2, createdAt: at, updatedAt: at }],
    [GENERAL_AGENT_ID]: [{ id: `mem_${randomUUID()}`, content: '用中文', revision: 1, createdAt: at, updatedAt: at }],
  }
  const key = 'a'.repeat(64)
  const starts = { [key]: { harnessId: 'standard', mode: 'agent', customAgentId: rows[1]!.id } }
  const receipts = { ['b'.repeat(64)]: { hash: 'c'.repeat(64), target: rows[2]!.id, audited: true } }
  const general = { id: GENERAL_AGENT_ID, instructions: '先说结论', revision: 3, updatedAt: at }
  await writeV1(dataDir, rows, { memories, starts, receipts, general })
  const audit = { append: vi.fn(async () => undefined as never) }
  const store = await CustomAgents.open({ dataDir, audit })
  stores.push(store)
  // Everything but the glyphs comes through unchanged.
  expect(store.memories(rows[0]!.id)).toEqual(memories[rows[0]!.id])
  expect(store.memories(GENERAL_AGENT_ID)).toEqual(memories[GENERAL_AGENT_ID])
  expect(store.general()).toEqual(general)
  expect(store.list().map(({ avatar: _, ...agent }) => agent)).toEqual(rows.map(({ glyph: _, ...agent }) => agent))
  expect((await stat(join(dataDir, 'agents/custom.json'))).mode & 0o777).toBe(0o600)
  const avatars = store.list().map(agent => agent.avatar)
  expect(avatars).toEqual(
    V1_GLYPHS.map((_, index) => ({
      kind: 'face',
      bracket: ['round', 'curly', 'square', 'angle'][index % 4],
      eyes: ['dot', 'arc', 'oval', 'sleepy'][Math.floor(index / 4) % 4],
      hue: ['ink', 'slate', 'pine', 'plum', 'wisteria', 'cocoa', 'sand', 'moss', 'mist'][index % 9],
    })),
  )
  expect(avatars[0]).toEqual({ kind: 'face', bracket: 'round', eyes: 'dot', hue: 'ink' })
  expect(avatars[11]).toEqual({ kind: 'face', bracket: 'angle', eyes: 'oval', hue: 'pine' })
  // Twelve different faces, as there were twelve different glyphs.
  expect(new Set(avatars.map(item => JSON.stringify(item))).size).toBe(12)
  const disk = JSON.parse(await readFile(join(dataDir, 'agents/custom.json'), 'utf8')) as {
    version: number
    agents: object[]
    memories: unknown
    starts: unknown
    receipts: unknown
    general: unknown
  }
  expect(disk.version).toBe(2)
  expect([disk.memories, disk.starts, disk.receipts, disk.general]).toEqual([memories, starts, receipts, general])
  expect(disk.agents.every(agent => !('glyph' in agent) && 'avatar' in agent)).toBe(true)
  expect(audit.append).not.toHaveBeenCalled()
  await store.close()
  const again = await CustomAgents.open({ dataDir, audit })
  stores.push(again)
  expect(again.list().map(agent => agent.avatar)).toEqual(avatars)
  expect(again.list().map(agent => agent.id)).toEqual(rows.map(row => row.id))
})

test('a failed write-back of the upgrade leaves the version 1 file, read and upgraded again next time', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-custom-agents-'))
  roots.push(dataDir)
  const rows = V1_GLYPHS.slice(0, 3).map(v1Agent)
  await writeV1(dataDir, rows)
  const original = await readFile(join(dataDir, 'agents/custom.json'), 'utf8')
  const audit = { append: vi.fn(async () => undefined as never) }
  const failing = await CustomAgents.open({
    dataDir,
    audit,
    atomicFs: {
      open,
      async rename() {
        throw new Error('disk full')
      },
    },
  })
  expect(failing.list().map(agent => agent.avatar.bracket)).toEqual(['round', 'curly', 'square'])
  await failing.close()
  expect(await readFile(join(dataDir, 'agents/custom.json'), 'utf8')).toBe(original)
  const again = await CustomAgents.open({ dataDir, audit })
  stores.push(again)
  expect(again.list().map(agent => agent.avatar.bracket)).toEqual(['round', 'curly', 'square'])
  expect(JSON.parse(await readFile(join(dataDir, 'agents/custom.json'), 'utf8'))).toMatchObject({ version: 2 })
})

test('a version 1 file with an unknown glyph, or a version 2 file with an unknown avatar, is refused and kept', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-custom-agents-'))
  roots.push(dataDir)
  const audit = { append: vi.fn(async () => undefined as never) }
  await writeV1(dataDir, [v1Agent('sparkles', 0)])
  await expect(CustomAgents.open({ dataDir, audit })).rejects.toMatchObject({ code: 'agent-journal-invalid' })
  expect(JSON.parse(await readFile(join(dataDir, 'agents/custom.json'), 'utf8'))).toMatchObject({ version: 1 })
  for (const avatar of [
    { kind: 'face', bracket: 'round', eyes: 'dot', hue: 'red' },
    { kind: 'face', bracket: 'round', eyes: 'dot', hue: 'ink', mouth: 'smile' },
    { kind: 'image', url: 'https://example.test/a.png' },
  ]) {
    const { glyph: _, ...agent } = v1Agent('glasses', 0)
    await writeFile(
      join(dataDir, 'agents/custom.json'),
      JSON.stringify({
        version: 2,
        general: { id: GENERAL_AGENT_ID, instructions: '', revision: 1 },
        agents: [{ ...agent, avatar }],
        memories: {},
        starts: {},
        receipts: {},
      }),
      { mode: 0o600 },
    )
    await expect(CustomAgents.open({ dataDir, audit })).rejects.toMatchObject({ code: 'agent-journal-invalid' })
  }
})

test('a new agent gets a bracket and hue no other agent has, with dot eyes', async () => {
  const { store } = await fixture()
  const made = []
  for (let index = 0; index < 5; index++) made.push((await store.create(definition(), actor)).value.avatar)
  expect(made.map(avatar => avatar.eyes)).toEqual(['dot', 'dot', 'dot', 'dot', 'dot'])
  expect(made.map(avatar => avatar.bracket)).toEqual(['round', 'curly', 'square', 'angle', 'round'])
  expect(made.map(avatar => avatar.hue)).toEqual(['ink', 'slate', 'pine', 'plum', 'wisteria'])
  // A pair freed by a change is offered again before any later one.
  const first = store.list()[0]!
  await store.patch(first.id, { requestId: randomUUID(), baseRevision: 1, avatar: { ...first.avatar, hue: 'moss' } }, actor)
  expect((await store.create(definition(), actor)).value.avatar).toEqual({ kind: 'face', bracket: 'round', eyes: 'dot', hue: 'ink' })
  // All 36 pairs taken: it still answers, cycling.
  const all = AGENT_BRACKETS.flatMap(bracket =>
    AGENT_HUES.map(hue => ({ avatar: { kind: 'face' as const, bracket, eyes: 'dot' as const, hue } })),
  )
  expect(new Set(all.map(item => `${item.avatar.bracket}:${item.avatar.hue}`)).size).toBe(36)
  expect(avatarFor(all)).toEqual({ kind: 'face', bracket: 'round', eyes: 'dot', hue: 'ink' })
})

test('the avatar changes through the audited patch: strict, answered by its receipt on a retry, audited by hashes only', async () => {
  const { store, audit } = await fixture()
  const created = (await store.create(definition(), actor)).value
  const hash = store.definitionHash(created.id)
  const request = {
    requestId: randomUUID(),
    baseRevision: 1,
    avatar: { kind: 'face' as const, bracket: 'curly' as const, eyes: 'arc' as const, hue: 'plum' as const },
  }
  const patched = (await store.patch(created.id, request, actor)).value
  expect(patched).toMatchObject({ revision: 2, avatar: request.avatar })
  // A name or avatar is not something a run receives.
  expect(store.definitionHash(created.id)).toBe(hash)
  const calls = audit.append.mock.calls.length
  expect((await store.patch(created.id, request, actor)).value.revision).toBe(2)
  expect(audit.append.mock.calls.length).toBe(calls)
  await expect(store.patch(created.id, { ...request, avatar: { ...request.avatar, hue: 'sand' } }, actor)).rejects.toMatchObject({
    code: 'request-conflict',
  })
  const last = audit.append.mock.calls.at(-1) as unknown as [{ action: string; detail: Record<string, unknown> }]
  expect(last[0]).toMatchObject({ action: 'agent.changed', target: created.id })
  expect(Object.keys(last[0].detail).sort()).toEqual(['after', 'before', 'customAgentId', 'kind', 'operation'])
  for (const avatar of [
    { kind: 'face', bracket: 'round', eyes: 'dot', hue: 'red' },
    { kind: 'face', bracket: 'round', eyes: 'dot' },
    { kind: 'face', bracket: 'round', eyes: 'dot', hue: 'ink', blush: true },
    { kind: 'image', bracket: 'round', eyes: 'dot', hue: 'ink' },
  ])
    expect(() => store.patch(created.id, { requestId: randomUUID(), baseRevision: 2, avatar } as never, actor)).toThrow()
  expect(() => store.patch(created.id, { requestId: randomUUID(), baseRevision: 2, glyph: 'glasses' } as never, actor)).toThrow()
  expect(store.get(created.id).avatar).toEqual(request.avatar)
})
