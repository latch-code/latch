import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  AGENT_FILE_BYTES,
  type AgentFile,
  type AgentImportPreview,
  type AgentImportResult,
  type AgentMemory,
  type Automation,
  type AutomationList,
  type CustomAgent,
  type CustomAgentDetail,
  type CustomAgentList,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { AGENT_ACTIONS as AUDIT_ACTIONS } from '../src/audit-actions/agents.ts'
import { parseAgentFile } from '../src/custom-agents.ts'
import { createAgentRoutes } from '../src/routes/agents.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.close()
})

type Device = Awaited<ReturnType<TestHost['enroll']>>
const SECRET = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123'
async function fixture() {
  const host = await startTestHost()
  hosts.push(host)
  const owner = await host.enroll({ listener: 'unix' })
  return { host, owner }
}
const create = (owner: Device, name: string, extra: Record<string, unknown> = {}) =>
  owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name,
      description: '查资料',
      harnessId: 'standard',
      mode: 'agent',
      instructions: '先给结论',
      skills: [],
      ...extra,
    },
  })
const remember = (owner: Device, agent: string, content: string) =>
  owner.json<AgentMemory>(`custom-agents/${agent}/memories`, { method: 'POST', body: { requestId: randomUUID(), content } })
const auditLines = async (host: TestHost) =>
  (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { action: string; target?: string; detail: Record<string, unknown> })
const sample = (overrides: Partial<AgentFile> = {}): AgentFile => ({
  format: 'latch-agent',
  version: 1,
  exportedAt: '2026-11-14T00:00:00.000Z',
  agent: {
    name: '资料',
    description: '查资料',
    harnessId: 'standard',
    mode: 'agent',
    instructions: '先给结论',
    avatar: { bracket: 'curly', eyes: 'arc', hue: 'pine' },
  },
  memories: [{ content: '项目都用 pnpm', savedAt: '2026-11-01T00:00:00.000Z', origin: 'agent', external: true }],
  schedules: [{ name: '早报', prompt: '整理昨天的改动', schedule: { kind: 'daily', time: '09:00' }, notify: true }],
  ...overrides,
})

test('export carries the portable definition, confirmed memories and schedules with a limited field set', async () => {
  const { host, owner } = await fixture()
  const agent = await create(owner, '资料')
  await owner.json(`custom-agents/${agent.id}`, {
    method: 'PATCH',
    body: { requestId: randomUUID(), baseRevision: 1, avatar: { kind: 'face', bracket: 'curly', eyes: 'arc', hue: 'pine' }, tools: [] },
  })
  const kept = await remember(owner, agent.id, '项目都用 pnpm')
  await remember(owner, agent.id, `密钥是 ${SECRET}`)
  const schedule = await owner.json<Automation>('automations', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '早报',
      customAgentId: agent.id,
      prompt: '整理昨天的改动',
      schedule: { kind: 'daily', time: '09:00' },
      notify: true,
      enabled: false,
    },
  })
  const other = await create(owner, '另一位')
  await remember(owner, other.id, '另一位的记忆')

  const response = await owner.request(`custom-agents/${agent.id}/export`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="agent.latch-agent.json"')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('cache-control')).toBe('no-store')
  const text = await response.text()
  const file = JSON.parse(text) as AgentFile
  expect(text).toBe(`${JSON.stringify(file, null, 2)}\n`)
  expect(file).toEqual({
    format: 'latch-agent',
    version: 1,
    exportedAt: expect.any(String),
    agent: {
      name: '资料',
      description: '查资料',
      harnessId: 'standard',
      mode: 'agent',
      instructions: '先给结论',
      avatar: { bracket: 'curly', eyes: 'arc', hue: 'pine' },
    },
    memories: [{ content: '项目都用 pnpm', savedAt: kept.createdAt, origin: 'user', external: false }],
    schedules: [{ name: '早报', prompt: '整理昨天的改动', schedule: { kind: 'daily', time: '09:00' }, notify: true }],
    // The memory that looks like a secret stayed behind, and the file says one did.
    omitted: { secretMemories: 1 },
  })
  // Nothing of this computer or of anyone's credentials: no IDs of agents, memories, schedules, devices or sessions, no
  // revision, receipt, home, model, tool or project choice, no secret.
  for (const forbidden of [
    SECRET,
    'sk-',
    agent.id,
    kept.id,
    schedule.id,
    owner.id,
    'agt_',
    'mem_',
    'auto_',
    'dev_',
    'requestId',
    'revision',
    'deviceId',
    'token',
    'credential',
    'apiKey',
    'home',
    'providerId',
    'tools',
    'projectId',
    'sessionId',
    '另一位',
  ])
    expect(text).not.toContain(forbidden)
  // It is exactly what the import reads.
  expect(parseAgentFile(file)).toEqual(file)

  // Recorded first, with IDs and counts only.
  const exported = (await auditLines(host)).filter(line => line.action === 'agent.exported')
  expect(exported).toEqual([expect.objectContaining({ target: agent.id, detail: { customAgentId: agent.id, memories: 1, schedules: 1 } })])
  expect(AUDIT_ACTIONS['agent.exported'].safeParse(exported[0]!.detail).success).toBe(true)
  expect(JSON.stringify(exported)).not.toContain('pnpm')

  // Instructions that look like a secret are not exported at all.
  const leaky = await create(owner, '带密钥', { instructions: `用 ${SECRET} 登录` })
  const refused = await owner.request(`custom-agents/${leaky.id}/export`)
  expect(refused.status).toBe(422)
  expect(await refused.json()).toMatchObject({ error: 'agent-export-secret' })
  expect((await auditLines(host)).filter(line => line.action === 'agent.exported')).toHaveLength(1)

  // Only a device that may read the Agent's private data exports it; 通用 and unknown Agents have no export.
  const limited = await host.enroll({ listener: 'loopback-tcp' })
  await owner.json(`devices/${limited.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  expect((await limited.request(`custom-agents/${agent.id}/export`)).status).toBe(403)
  // A device that may only look, once it may see private data, exports what it can already read.
  const reader = await host.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
  expect((await reader.request(`custom-agents/${agent.id}/export`)).status).toBe(403)
  await owner.confirmedJson(`devices/${reader.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
  expect((await reader.request(`custom-agents/${agent.id}/export`)).status).toBe(200)
  expect((await owner.request('custom-agents/general/export')).status).toBe(404)
  expect((await owner.request(`custom-agents/agt_${randomUUID()}/export`)).status).toBe(404)
  expect((await owner.request(`custom-agents/${agent.id}/export`, { method: 'POST', body: {} })).status).toBe(404)
}, 120_000)

test('import shows the file first, then creates a new Agent with imported memories and switched-off schedules, once per request', async () => {
  const { host, owner } = await fixture()
  const existing = await create(owner, '资料')
  await remember(owner, existing.id, '原来的记忆')
  const file = sample()

  // The preview creates nothing and says what this computer can do with the file.
  const preview = await owner.json<AgentImportPreview>('custom-agents/import/preview', { method: 'POST', body: { file } })
  expect(preview).toEqual({ file, harness: { id: 'standard', ready: true, label: expect.any(String) }, canSchedule: true, nameTaken: true })
  expect((await owner.json<CustomAgentList>('custom-agents')).agents).toHaveLength(1)

  const request = { requestId: randomUUID(), file }
  const first = await owner.json<AgentImportResult>('custom-agents/import', { method: 'POST', body: request })
  expect(first).toMatchObject({ memories: 1, schedules: 1, agent: { name: '资料', harnessId: 'standard', instructions: '先给结论' } })
  expect(first.agent.id).not.toBe(existing.id)
  expect(first.agent.avatar).toEqual({ kind: 'face', bracket: 'curly', eyes: 'arc', hue: 'pine' })
  // The same request again answers the same Agent and creates nothing more.
  const again = await owner.json<AgentImportResult>('custom-agents/import', { method: 'POST', body: request })
  expect(again.agent.id).toBe(first.agent.id)
  expect((await owner.json<CustomAgentList>('custom-agents')).agents.map(agent => agent.id).sort()).toEqual(
    [existing.id, first.agent.id].sort(),
  )
  // The same request with another file is a conflict, not a second Agent.
  const conflict = await owner.request('custom-agents/import', {
    method: 'POST',
    body: { requestId: request.requestId, file: sample({ memories: [] }) },
  })
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ error: 'request-conflict' })

  // The existing Agent is untouched: an import never overwrites.
  const before = await owner.json<CustomAgentDetail>(`custom-agents/${existing.id}`)
  expect(before.agent).toMatchObject({ revision: existing.revision, instructions: '先给结论' })
  expect(before.memories.map(memory => memory.content)).toEqual(['原来的记忆'])

  const detail = await owner.json<CustomAgentDetail>(`custom-agents/${first.agent.id}`)
  expect(detail.memories).toEqual([
    expect.objectContaining({
      content: '项目都用 pnpm',
      imported: { origin: 'agent', external: true, savedAt: '2026-11-01T00:00:00.000Z' },
    }),
  ])
  expect(detail.memories[0]).not.toHaveProperty('source')
  const schedules = (await owner.json<AutomationList>('automations')).automations.filter(item => item.customAgentId === first.agent.id)
  expect(schedules).toEqual([
    expect.objectContaining({
      name: '早报',
      prompt: '整理昨天的改动',
      enabled: false,
      state: 'off',
      schedule: { kind: 'daily', time: '09:00' },
    }),
  ])

  // An imported memory keeps where it came from when exported again, and round-trips.
  const exported = (await (await owner.request(`custom-agents/${first.agent.id}/export`)).json()) as AgentFile
  expect(exported.memories).toEqual(file.memories)
  expect(exported.schedules).toEqual(file.schedules)

  // Audited as an import, with IDs and counts only; the receipt answered the retry without a second record.
  const imported = (await auditLines(host)).filter(line => line.action === 'agent.imported')
  expect(imported).toEqual([
    expect.objectContaining({
      target: first.agent.id,
      detail: { customAgentId: first.agent.id, memories: 1, schedules: 1, fileHash: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    }),
  ])
  expect(AUDIT_ACTIONS['agent.imported'].safeParse(imported[0]!.detail).success).toBe(true)
  expect(JSON.stringify(imported)).not.toContain('pnpm')
}, 120_000)

test('import refuses, creating nothing: a missing Harness, another version, unknown fields, oversized or secret content, and devices out of scope', async () => {
  const { host, owner } = await fixture()
  const count = async () => (await owner.json<CustomAgentList>('custom-agents')).agents.length
  const attempt = async (file: unknown, path = 'custom-agents/import') => {
    const response = await owner.request(path, {
      method: 'POST',
      body: path.endsWith('preview') ? { file } : { requestId: randomUUID(), file },
    })
    return { status: response.status, body: (await response.json()) as { error?: string; message?: string; harness?: unknown } }
  }

  // The Harness the file names is not on this computer: the preview says which, and the import creates nothing.
  const missing = sample({ agent: { ...sample().agent, harnessId: 'not-installed' } })
  const shown = await attempt(missing, 'custom-agents/import/preview')
  expect(shown).toMatchObject({ status: 200, body: { harness: { id: 'not-installed', ready: false }, canSchedule: false } })
  expect(shown.body.harness).not.toHaveProperty('label')
  expect(await attempt(missing)).toMatchObject({ status: 409, body: { error: 'agent-import-harness' } })

  for (const [file, error, status] of [
    [{ ...sample(), version: 2 }, 'agent-import-version', 400],
    [{ ...sample(), version: 0 }, 'agent-import-version', 400],
    [{ ...sample(), version: '1' }, 'agent-import-version', 400],
    [{ ...sample(), format: 'latch-plugin' }, 'agent-import-invalid', 400],
    [{ ...sample(), extra: true }, 'agent-import-invalid', 400],
    [{ ...sample(), agent: { ...sample().agent, model: { providerId: 'x', model: 'y' } } }, 'agent-import-invalid', 400],
    [{ ...sample(), agent: { ...sample().agent, id: 'agt_00000000-0000-0000-0000-000000000000' } }, 'agent-import-invalid', 400],
    [
      { ...sample(), agent: { ...sample().agent, avatar: { kind: 'image', bracket: 'curly', eyes: 'arc', hue: 'pine' } } },
      'agent-import-invalid',
      400,
    ],
    [{ ...sample(), memories: [{ ...sample().memories[0], id: 'mem_1' }] }, 'agent-import-invalid', 400],
    [{ ...sample(), memories: [{ ...sample().memories[0], origin: 'host' }] }, 'agent-import-invalid', 400],
    [{ ...sample(), memories: [{ ...sample().memories[0], content: 'x'.repeat(4001) }] }, 'agent-import-invalid', 400],
    [{ ...sample(), memories: Array.from({ length: 129 }, () => sample().memories[0]) }, 'agent-import-invalid', 400],
    [{ ...sample(), schedules: [{ ...sample().schedules[0], enabled: true }] }, 'agent-import-invalid', 400],
    [{ ...sample(), schedules: [{ ...sample().schedules[0], schedule: { kind: 'hourly', time: '09:00' } }] }, 'agent-import-invalid', 400],
    [{ ...sample(), schedules: Array.from({ length: 17 }, () => sample().schedules[0]) }, 'agent-import-invalid', 400],
    [{ ...sample(), agent: { ...sample().agent, name: 'a‮b' } }, 'agent-import-invalid', 400],
    [{ ...sample(), agent: { ...sample().agent, instructions: 'x'.repeat(32_001) } }, 'agent-import-invalid', 400],
    [{ ...sample(), memories: [{ ...sample().memories[0], content: `记住 ${SECRET}` }] }, 'agent-import-secret', 422],
    [{ ...sample(), agent: { ...sample().agent, instructions: `用 ${SECRET}` } }, 'agent-import-secret', 422],
    [[sample()], 'agent-import-invalid', 400],
    ['latch-agent', 'agent-import-invalid', 400],
    [null, 'agent-import-invalid', 400],
  ] as const) {
    expect(await attempt(file), JSON.stringify(file).slice(0, 80)).toMatchObject({ status, body: { error } })
    expect(await attempt(file, 'custom-agents/import/preview')).toMatchObject({ status, body: { error } })
  }
  // A file padded past the limit is refused by its size, a 10 MB memory before it is even parsed.
  const padded = { ...sample(), agent: { ...sample().agent, instructions: 'x' }, pad: 'y'.repeat(AGENT_FILE_BYTES) }
  expect(await attempt(padded)).toMatchObject({ status: 413, body: { error: 'agent-import-too-large' } })
  const huge = sample({ memories: [{ ...sample().memories[0]!, content: '大'.repeat(10 * 1024 * 1024) }] })
  expect((await attempt(huge)).status).toBe(413)
  // A request ID too long to derive each schedule's own from, or anything beside the two fields.
  const long = await owner.request('custom-agents/import', { method: 'POST', body: { requestId: 'r'.repeat(101), file: sample() } })
  expect(long.status).toBe(400)
  const beside = await owner.request('custom-agents/import', {
    method: 'POST',
    body: { requestId: randomUUID(), file: sample(), overwrite: 'agt_x' },
  })
  expect(beside.status).toBe(400)
  expect(await count()).toBe(0)
  expect((await auditLines(host)).some(line => line.action === 'agent.imported')).toBe(false)

  // A device without the full data scope, and one that may only view, cannot import or preview.
  const limited = await host.enroll({ listener: 'loopback-tcp' })
  await owner.json(`devices/${limited.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  for (const path of ['custom-agents/import', 'custom-agents/import/preview'])
    expect((await limited.request(path, { method: 'POST', body: { requestId: randomUUID(), file: sample() } })).status).toBe(403)
  const reader = await host.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
  await owner.confirmedJson(`devices/${reader.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
  const viewOnly = await reader.request('custom-agents/import', { method: 'POST', body: { requestId: randomUUID(), file: sample() } })
  expect(viewOnly.status).toBe(403)
  expect(await viewOnly.json()).toMatchObject({ error: 'scope-required' })
  expect(await count()).toBe(0)
}, 180_000)

test('refuses a portable Harness ID that looks like a secret without echoing it', async () => {
  const { host, owner } = await fixture()
  const file = sample({ agent: { ...sample().agent, harnessId: SECRET } })
  const imports = []
  for (const path of ['custom-agents/import/preview', 'custom-agents/import']) {
    const response = await owner.request(path, {
      method: 'POST',
      body: path.endsWith('preview') ? { file } : { requestId: randomUUID(), file },
    })
    const body = await response.text()
    imports.push({ status: response.status, error: (JSON.parse(body) as { error?: string }).error, echoed: body.includes(SECRET) })
  }
  expect((await owner.json<CustomAgentList>('custom-agents')).agents).toEqual([])

  const installed = await owner.confirmed('agents', {
    method: 'POST',
    body: { id: SECRET, name: 'Fixture Harness', command: process.execPath, args: [FAKE_ACP_AGENT] },
  })
  expect(installed.status).toBe(201)
  const agent = await create(owner, '测试便携数据', { harnessId: SECRET })
  const exports = []
  for (const path of ['export/preview', 'export']) {
    const response = await owner.request(`custom-agents/${agent.id}/${path}`)
    const body = await response.text()
    exports.push({ status: response.status, error: (JSON.parse(body) as { error?: string }).error, echoed: body.includes(SECRET) })
  }
  expect({ imports, exports }).toEqual({
    imports: Array.from({ length: 2 }, () => ({ status: 422, error: 'agent-import-secret', echoed: false })),
    exports: Array.from({ length: 2 }, () => ({ status: 422, error: 'agent-export-secret', echoed: false })),
  })
  expect((await auditLines(host)).some(line => line.action === 'agent.imported' || line.action === 'agent.exported')).toBe(false)
}, 120_000)

test('round-trips a large Agent file at the schedule limit and refuses to drop additional schedules', async () => {
  const { owner } = await fixture()
  const agent = await create(owner, '大份资料', { instructions: '指'.repeat(32_000) })
  for (let index = 0; index < 20; index++) await remember(owner, agent.id, '记'.repeat(4_000))
  const schedule = (index: number) =>
    owner.json<Automation>('automations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: `定时 ${index}`,
        customAgentId: agent.id,
        prompt: '整'.repeat(16_000),
        schedule: { kind: 'daily', time: '09:00' },
        notify: false,
        enabled: false,
      },
    })
  for (let index = 0; index < 16; index++) await schedule(index)
  const path = `custom-agents/${agent.id}/export`
  expect(await owner.json(`${path}/preview`)).toMatchObject({ memories: 20, schedules: 16 })
  const file = await owner.json<AgentFile>(path)
  expect(Buffer.byteLength(JSON.stringify(file))).toBeGreaterThan(1024 * 1024)
  const preview = await owner.request('custom-agents/import/preview', { method: 'POST', body: { file } })
  expect(preview.status).toBe(200)
  const imported = await owner.json<AgentImportResult>('custom-agents/import', { method: 'POST', body: { requestId: randomUUID(), file } })
  expect(imported).toMatchObject({ memories: 20, schedules: 16 })

  await schedule(16)
  for (const endpoint of [path, `${path}/preview`]) {
    const refused = await owner.request(endpoint)
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({ error: 'agent-export-schedule-limit' })
  }
}, 120_000)

test('limits preview and download by the actual file bytes while preserving imported timestamp precision', async () => {
  const { host, owner } = await fixture()
  const file = sample({ schedules: [] })
  const memory = file.memories[0]!
  const compactBytes = Buffer.byteLength(JSON.stringify(file))
  memory.savedAt = memory.savedAt.replace(/Z$/u, `${'7'.repeat(AGENT_FILE_BYTES - compactBytes)}Z`)
  const { agent } = await owner.json<AgentImportResult>('custom-agents/import', {
    method: 'POST',
    body: { requestId: randomUUID(), file },
  })
  const detail = await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)
  expect(detail.memories[0]?.imported?.savedAt === memory.savedAt).toBe(true)
  for (const path of ['export/preview', 'export']) {
    const denied = await owner.request(`custom-agents/${agent.id}/${path}`)
    const body = await denied.text()
    expect(denied.status).toBe(413)
    expect(JSON.parse(body)).toMatchObject({ error: 'agent-export-too-large' })
    expect(body.length).toBeLessThan(1024)
    expect(body).not.toContain('7777777777')
  }
  expect((await auditLines(host)).some(line => line.action === 'agent.exported')).toBe(false)
}, 120_000)

test('the phone app may export by its scope but never imports: the route refuses a native listener before it reads the file', async () => {
  const calls: string[] = []
  const routes = createAgentRoutes(
    { refresh: () => {}, log: () => {}, dataDir: join(tmpdir(), `latch-no-avatars-${randomUUID()}`) } as never,
    {
      agents: {
        avatarImages: () => new Set<string>(),
        recover: async () => {},
        exportFile: () => (calls.push('export'), { file: sample(), body: '{}' }),
        noteExport: async () => void calls.push('audit'),
        importAgent: async () => (calls.push('import'), { value: {}, audited: true }),
        list: () => [],
      } as never,
      plans: () => ({ harnessFor: () => ({ id: 'standard', ready: true, canSchedule: true }) }) as never,
      automations: () => ({ list: () => [], create: async () => void calls.push('schedule') }) as never,
      access: () => ({ actor: { listener: 'native-direct', deviceId: 'dev_1' }, authorize: () => {} }) as never,
      sessions: async () => [],
      plugins: () => [],
      detail: async () => ({}) as never,
      sessionFiles: async () => undefined,
      computer: () => ({}) as never,
      home: async () => ({}) as never,
      folders: {} as never,
      requireDesktop: () => {},
      signedBody: async () => ({}),
      archiveLabel: () => 'Agent',
    },
  )
  const call = async (listener: string, method: string, path: string) => {
    const sent: { status?: number; body?: string } = {}
    const res = {
      setHeader: () => {},
      writeHead: (status: number) => ((sent.status = status), res),
      end: (body?: string) => void (sent.body = body),
    }
    // No body is ever read: a native import is refused first, and an export has none.
    const req = { url: path, headers: {}, [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('body read')) }) }
    const caller = { connection: { listener }, device: { id: 'dev_1' } }
    return routes.route!({ req, res, caller, path, method } as never).then(
      () => sent,
      (error: unknown) => error,
    )
  }
  for (const listener of ['native-direct', 'native-relay'])
    for (const path of ['/link/api/custom-agents/import', '/link/api/custom-agents/import/preview']) {
      const refused = await call(listener, 'POST', path)
      expect(refused).toBeInstanceOf(AppError)
      expect(refused).toMatchObject({ status: 403, code: 'agent-import-device' })
      // It says what is true: the phone app cannot yet, a browser page can.
      expect((refused as AppError).message).toBe('手机 App 里还不能导入，请在浏览器页面里导入。')
    }
  expect(calls).toEqual([])
  await call('native-direct', 'GET', '/link/api/custom-agents/agt_00000000-0000-0000-0000-000000000000/export')
  // Audited before the file is handed over.
  expect(calls).toEqual(['export', 'audit'])
})

test('before a download the person is told how much the file holds and what it leaves out, each kind counted', async () => {
  const { host, owner } = await fixture()
  const agent = await create(owner, '资料')
  await remember(owner, agent.id, '项目都用 pnpm')
  await remember(owner, agent.id, '周五不开会')
  await remember(owner, agent.id, `密钥是 ${SECRET}`)
  const schedule = (name: string, prompt: string) =>
    owner.request('automations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name,
        customAgentId: agent.id,
        prompt,
        schedule: { kind: 'daily', time: '09:00' },
        notify: false,
        enabled: false,
      },
    })
  expect((await schedule('早报', '整理昨天的改动')).status).toBe(201)
  const leaky = await schedule('带密钥', `用 ${SECRET} 调接口`)

  const response = await owner.request(`custom-agents/${agent.id}/export/preview`)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  // Each kind left out is counted on its own; a schedule the Host itself refused to save is simply not there.
  expect(await response.json()).toEqual({
    memories: 2,
    schedules: 1,
    omitted: { secretMemories: 1, secretSchedules: leaky.status === 201 ? 1 : 0 },
  })
  // Looking is not exporting: nothing was recorded as handed over.
  expect((await auditLines(host)).some(line => line.action === 'agent.exported')).toBe(false)

  const exported = (await (await owner.request(`custom-agents/${agent.id}/export`)).json()) as AgentFile
  expect(exported.memories.map(memory => memory.content)).toEqual(['项目都用 pnpm', '周五不开会'])
  expect(exported.omitted).toEqual({ secretMemories: 1, ...(leaky.status === 201 ? { secretSchedules: 1 } : {}) })
  expect(JSON.stringify(exported)).not.toContain(SECRET)
  expect(parseAgentFile(exported)).toEqual(exported)

  // A name that looks like a secret refuses the preview and the export alike; so does a device out of scope.
  const named = await create(owner, 'ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  for (const path of ['export', 'export/preview']) {
    const refused = await owner.request(`custom-agents/${named.id}/${path}`)
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({ error: 'agent-export-secret' })
  }
  const limited = await host.enroll({ listener: 'loopback-tcp' })
  await owner.json(`devices/${limited.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  expect((await limited.request(`custom-agents/${agent.id}/export/preview`)).status).toBe(403)
  expect((await owner.request('custom-agents/general/export/preview')).status).toBe(404)
}, 120_000)
