import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { AgentActivityPage, AgentMemory, CustomAgent, MemoryProposalList, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { RECALL_LIMITS } from '@latch/core/node-kit'
import { CustomAgents } from '../src/custom-agents.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.close()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Searches for the words after `recall ` in the person's message, when the tool is offered; `propose` proposes a memory. */
const plugin: HarnessPlugin = {
  id: 'recalling-provider',
  name: 'fixture',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerProvider({
      id: 'recalling-provider',
      name: 'fixture',
      model: 'fixture',
      async *stream({ messages, tools }) {
        const last = messages.at(-1)
        const said = last?.role === 'user' ? JSON.stringify(last) : ''
        const query = /recall ([^"\\]+)/u.exec(said)?.[1]
        if (query && tools.some(tool => tool.name === 'recall_memory')) {
          yield { type: 'tool-call', call: { id: `call-${randomUUID()}`, name: 'recall_memory', arguments: { query, limit: 10 } } }
          yield { type: 'finish', reason: 'tool-calls' }
          return
        }
        if (said.includes('propose') && tools.some(tool => tool.name === 'propose_memory')) {
          yield { type: 'tool-call', call: { id: `call-${randomUUID()}`, name: 'propose_memory', arguments: { content: '暗号 只是提议' } } }
          yield { type: 'finish', reason: 'tool-calls' }
          return
        }
        yield { type: 'text', text: 'Answer' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
}
const model = { providerId: 'recalling-provider', model: 'fixture' }
type Device = Awaited<ReturnType<TestHost['enroll']>>
const settled = (owner: Device, id: string) =>
  expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${id}`)).summary.status, { timeout: 20_000 }).toBe('idle')
const create = (owner: Device, name: string) =>
  owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: { requestId: randomUUID(), name, description: '', harnessId: 'standard', mode: 'agent', model, instructions: '', skills: [] },
  })
const remember = (owner: Device, agent: string, content: string) =>
  owner.json<AgentMemory>(`custom-agents/${agent}/memories`, { method: 'POST', body: { requestId: randomUUID(), content } })
const recallRows = async (owner: Device, sessionId: string) =>
  (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.filter(
    message => message.role === 'tool' && message.toolName === 'recall_memory',
  )

test('an Agent recalls only its own saved memories, as a visible row counted in its activity, and other devices keep their scope', async () => {
  const host = await startTestHost({ plugins: [plugin] })
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  const mine = await create(owner, '资料')
  const other = await create(owner, '另一位')
  const kept = await remember(owner, mine.id, '暗号 是 pnpm')
  await remember(owner, other.id, '暗号 另一位的')
  await remember(owner, 'general', '暗号 通用的')

  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: mine.id, prompt: 'please propose', requestId: randomUUID() },
  })
  await settled(owner, sessionId)
  // A proposal waits for the person: it is not a memory, so a search never answers it.
  await expect.poll(async () => (await owner.json<MemoryProposalList>(`custom-agents/${mine.id}/proposals`)).proposals.length).toBe(1)
  await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'recall 暗号', requestId: randomUUID() } })
  await settled(owner, sessionId)
  const [row] = await recallRows(owner, sessionId)
  expect(row).toMatchObject({ state: 'completed', tool: { toolTitle: '查记忆' } })
  expect(row!.tool?.input).toContain('暗号')
  const answered = JSON.parse(row!.text.split('\n')[1]!) as { matches: Array<Record<string, unknown>> }
  expect(answered.matches).toEqual([{ content: '暗号 是 pnpm', date: kept.updatedAt.slice(0, 10), source: 'user', external: false }])

  // Counted once for that turn; a second search in a later turn is its own row.
  const activity = () => owner.json<AgentActivityPage>(`custom-agents/${mine.id}/activity`)
  await expect
    .poll(async () => (await activity()).items.filter(item => item.kind === 'recall'))
    .toEqual([expect.objectContaining({ kind: 'recall', sessionId, count: 1 })])
  expect((await owner.json<AgentActivityPage>(`custom-agents/${other.id}/activity`)).items.some(item => item.kind === 'recall')).toBe(false)

  // A deleted memory is not answered again.
  await owner.json(`custom-agents/${mine.id}/memories/${kept.id}`, { method: 'DELETE', body: { requestId: randomUUID() } })
  await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'recall 暗号', requestId: randomUUID() } })
  await settled(owner, sessionId)
  expect((await recallRows(owner, sessionId)).at(-1)!.text).toBe('No saved memory matches.')
  await expect.poll(async () => (await activity()).items.filter(item => item.kind === 'recall').length).toBe(2)

  // 通用's own conversation searches 通用's memories, never an Agent's.
  const general = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: 'general', prompt: 'recall 暗号', requestId: randomUUID(), model },
  })
  await settled(owner, general.sessionId)
  const generalRow = (await recallRows(owner, general.sessionId))[0]
  expect(generalRow!.text).toContain('通用的')
  expect(generalRow!.text).not.toContain('pnpm')
  expect(generalRow!.text).not.toContain('另一位')

  // A work-scope device and a phone with it see neither the search nor the count; nothing of it is audited as text.
  const limited = await host.enroll({ listener: 'loopback-tcp' })
  await owner.json(`devices/${limited.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  expect((await limited.request(`custom-agents/${mine.id}/activity`)).status).toBe(403)
  expect((await limited.request(`tasks/${sessionId}`)).status).toBeGreaterThanOrEqual(403)
  const audit = await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8')
  expect(audit).not.toContain('暗号')
}, 120_000)

test('the search is bounded, never crosses owners, and its count survives a repeat and goes with its Agent', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-agent-recall-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  const agents = await CustomAgents.open({ dataDir, audit: { append: async () => {} } as never })
  cleanups.push(() => agents.close())
  const actor = { actor: { listener: 'unix' as const, deviceId: 'dev-1' }, authorize: () => {} } as never
  const config = { description: '', harnessId: 'standard', mode: 'agent' as const, instructions: '', skills: [] }
  const a = (await agents.create({ ...config, name: 'A', requestId: randomUUID() }, actor)).value
  const b = (await agents.create({ ...config, name: 'B', requestId: randomUUID() }, actor)).value
  for (let index = 0; index < 20; index++)
    await agents.createMemory(a.id, { requestId: randomUUID(), content: `口令 ${index} ${'长'.repeat(index === 0 ? 3900 : 1)}` }, actor)
  await agents.createMemory(b.id, { requestId: randomUUID(), content: '口令 B 的' }, actor)

  const found = agents.recall(a.id, '口令', 999)
  expect(found.matches).toHaveLength(RECALL_LIMITS.maxMatches)
  expect(found.more).toBe(10)
  expect(found.matches.every(match => [...match.content].length <= RECALL_LIMITS.content && !match.content.includes('B 的'))).toBe(true)
  expect(JSON.stringify(agents.recall(a.id, '口令', 10)).length).toBeLessThan(64 * 1024)
  expect(agents.recall(b.id, '口令').matches.map(match => match.content)).toEqual(['口令 B 的'])
  expect(() => agents.recall(a.id, '')).toThrow()
  expect(() => agents.recall(a.id, 'x'.repeat(RECALL_LIMITS.query + 1))).toThrow()
  expect(() => agents.recall('agt_00000000-0000-0000-0000-000000000000', '口令')).toThrow()

  // Each search adds one to its turn's row.
  await agents.noteRecall(a.id, { sessionId: 's1', messageId: 'm1' })
  await agents.noteRecall(a.id, { sessionId: 's1', messageId: 'm2' })
  await agents.noteRecall(a.id, { sessionId: 's1', messageId: 'm2' })
  expect(agents.recalls(a.id).map(row => [row.messageId, row.count])).toEqual([
    ['m1', 1],
    ['m2', 2],
  ])
  for (let index = 0; index < 80; index++) await agents.noteRecall(b.id, { sessionId: `s${index}` })
  expect(agents.recalls(b.id)).toHaveLength(64)
  await agents.remove(b.id, randomUUID(), actor)
  expect(() => agents.recalls(b.id)).toThrow()
  await expect(agents.noteRecall(b.id, { sessionId: 's1' })).rejects.toThrow()
  // The record holds where and how many, never the words.
  expect(await readFile(join(dataDir, 'agents', 'custom.json'), 'utf8')).toContain('"recalls"')
  expect(JSON.stringify(agents.recalls(a.id))).not.toContain('口令')
}, 60_000)
