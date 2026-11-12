import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HistoryImportResult, HistoryList, HistoryPreview, HistorySources, TaskDetail, TaskSummary } from '@latch/protocol'
import {
  FAKE_ACP_AGENT,
  FAKE_HISTORY_SECRETS,
  fakeConversation,
  fakeLongConversation,
  writeFakeHistory,
  type TestDevice,
} from '@latch/testkit'
import { AuditLog } from '../src/audit.ts'
import { PREVIEW_BYTES, PREVIEW_MESSAGE_BYTES, previewMessages, textSeed } from '../src/history-import.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const SLOW = { timeout: 15_000 }
const CODEX_ENV = {
  FAKE_ACP_CONFIG: 'options',
  FAKE_ACP_MODES: 'read-only,workspace-write,agent,agent-full-access',
  FAKE_ACP_INITIAL_MODE: 'agent-full-access',
  FAKE_ACP_CAPS: 'list,load,resume,close,delete,dirs',
}

interface LogEntry {
  event: string
  method?: string | null
  params?: Record<string, unknown>
}

/**
 * A Host on directories that outlive it (so it can restart on them), the fake agent as Codex with history sessions, and
 * a project of two folders. `restart` closes the Host and starts another on the same data.
 */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-history-host-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data')
  const workspaceRoot = join(root, 'workspace')
  const main = join(workspaceRoot, 'app')
  const other = join(workspaceRoot, 'docs')
  const outside = join(root, 'elsewhere')
  for (const folder of [main, join(main, 'web'), other, outside]) await mkdir(folder, { recursive: true })
  const history = await writeFakeHistory(root, [
    {
      sessionId: 'ext-main',
      cwd: main,
      title: `Login bug ${FAKE_HISTORY_SECRETS.openai}`,
      updatedAt: '2026-11-10T08:00:00.000Z',
      updates: fakeConversation(),
    },
    {
      sessionId: 'ext-sub',
      cwd: join(main, 'web'),
      title: 'Web build',
      updatedAt: '2026-11-11T08:00:00.000Z',
      updates: fakeConversation(),
    },
    { sessionId: 'ext-other', cwd: other, title: 'Docs session', updates: [] },
    { sessionId: 'ext-outside', cwd: outside, title: 'Outside secret title', updates: [] },
    { sessionId: 'ext-busy', cwd: main, title: 'Open in a terminal', busy: true, updates: [] },
    { sessionId: 'ext-long', cwd: main, title: 'Long', updatedAt: '2026-11-01T08:00:00.000Z', updates: fakeLongConversation(80, 6_000) },
  ])
  const agentLog = join(root, 'agent.log')
  const env = { ...CODEX_ENV, FAKE_ACP_STATE: join(root, 'agent-state.json'), FAKE_ACP_LOG: agentLog, FAKE_ACP_HISTORY_FILE: history }
  let t: TestHost = await startTestHost({ dataDir, workspaceRoot })
  let owner = await t.enroll({ listener: 'unix' })
  const saved = await owner.confirmed('agents', {
    method: 'POST',
    body: { id: 'codex', name: 'Codex', presetId: 'codex', command: process.execPath, args: [FAKE_ACP_AGENT], env },
  })
  expect(saved.status).toBe(201)
  const plain = await owner.confirmed('agents', {
    method: 'POST',
    body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_LOG: join(root, 'plain.log') } },
  })
  expect(plain.status).toBe(201)
  const added = await owner.addFolders({ paths: [main, other] })
  expect(added.status).toBe(201)
  const projectId = ((await added.json()) as { workspace: { id: string } }).workspace.id
  cleanups.push(() => t.close())
  return {
    root,
    main,
    env,
    projectId,
    get t() {
      return t
    },
    get owner() {
      return owner
    },
    async restart() {
      await t.close()
      t = await startTestHost({ dataDir, workspaceRoot })
      owner = await t.enroll({ listener: 'unix' })
    },
    async plainLog(): Promise<LogEntry[]> {
      const text = await readFile(join(root, 'plain.log'), 'utf8').catch(() => '')
      return text
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as LogEntry)
    },
    async log(): Promise<LogEntry[]> {
      const text = await readFile(agentLog, 'utf8').catch(() => '')
      return text
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as LogEntry)
    },
    async audit(): Promise<string[]> {
      const text = await readFile(join(dataDir, 'audit', 'audit.jsonl'), 'utf8')
      return text
        .trim()
        .split('\n')
        .map(line => (JSON.parse(line) as { action: string }).action)
        .filter(action => action.startsWith('history.'))
    },
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

const list = (f: Fixture, device: TestDevice = f.owner) =>
  device.json<HistoryList>('history/list', { method: 'POST', body: { projectId: f.projectId, harnessId: 'codex' } })
const handleOf = (rows: HistoryList['rows'], title: string) => rows.find(row => row.title === title)!.handle
const importOf = (device: TestDevice, body: Record<string, unknown>) => device.request('history/imports', { method: 'POST', body })
const received = (log: LogEntry[], method: string) => log.filter(entry => entry.event === 'recv' && entry.method === method)

describe('接入已有会话 on the Host', () => {
  it('lists the project’s sessions only: main folder and below, a count for its other folders, none from outside or from Latch', async () => {
    const f = await fixture()
    const sources = await f.owner.json<HistorySources>(`history/sources?projectId=${f.projectId}`)
    expect(sources.sources).toEqual([{ harnessId: 'codex', label: 'Codex', available: true }])
    // A session Latch started itself in the project is Latch's to continue.
    const own = await f.owner.confirmed('tasks', {
      method: 'POST',
      body: { prompt: 'echo mine', requestId: randomUUID(), mode: 'agent', harnessId: 'codex', workspaceId: f.projectId },
    })
    expect(own.status).toBe(201)
    const { sessionId } = (await own.json()) as { sessionId: string }
    await expect.poll(async () => (await f.owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('idle')

    const listed = await list(f)
    expect(listed.rows.map(row => [row.title, row.subdir])).toEqual([
      ['Web build', 'web'],
      ['Login bug [redacted]', ''],
      ['Long', ''],
      ['Open in a terminal', ''],
    ])
    expect(listed.otherFolders).toBe(1)
    expect(listed.scanned).toBe(7)
    expect(JSON.stringify(listed)).not.toContain('Outside')
    expect(JSON.stringify(listed)).not.toContain('echo mine')
    expect(listed.rows.every(row => /^hh_[a-f0-9]{32}$/u.test(row.handle))).toBe(true)
    // Nothing was loaded to list them.
    expect(received(await f.log(), 'session/load')).toEqual([])
    expect(await f.audit()).toEqual(['history.list'])
  })

  it('previews within its limits, redacted and without tool output, and refuses a session open elsewhere', async () => {
    const f = await fixture()
    const rows = (await list(f)).rows
    const preview = await f.owner.json<HistoryPreview>('history/previews', {
      method: 'POST',
      body: { handle: handleOf(rows, 'Login bug [redacted]') },
    })
    const text = JSON.stringify(preview)
    expect(text).not.toContain(FAKE_HISTORY_SECRETS.openai)
    expect(text).not.toContain(FAKE_HISTORY_SECRETS.gateway)
    expect(text).not.toContain('OPENAI_API_KEY')
    expect(text).not.toContain('hidden reasoning')
    expect(preview.turns).toBe(2)
    expect(preview.messages.find(message => message.role === 'tool')).toEqual({
      role: 'tool',
      text: 'Run printenv',
      outputHidden: true,
      status: 'completed',
    })
    expect(received(await f.log(), 'session/prompt')).toEqual([])

    const long = await f.owner.json<HistoryPreview>('history/previews', { method: 'POST', body: { handle: handleOf(rows, 'Long') } })
    expect(long.messages.length).toBeLessThanOrEqual(40)
    expect(long.truncated).toBe(true)
    expect(long.messages.every(message => Buffer.byteLength(message.text) <= PREVIEW_MESSAGE_BYTES)).toBe(true)
    expect(long.messages.at(-1)).toMatchObject({ role: 'assistant', clipped: true })
    expect(Buffer.byteLength(JSON.stringify(long))).toBeLessThanOrEqual(PREVIEW_BYTES)
    // The first preview of the device was closed when the second opened.
    expect(received(await f.log(), 'session/close').map(entry => entry.params?.sessionId)).toEqual(['ext-main'])

    const busy = await f.owner.request('history/previews', { method: 'POST', body: { handle: handleOf(rows, 'Open in a terminal') } })
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ error: 'history-session-busy' })
    expect(received(await f.log(), 'session/load').filter(entry => entry.params?.sessionId === 'ext-busy')).toHaveLength(1)
    expect(await f.audit()).toEqual(['history.list', 'history.preview', 'history.preview', 'history.preview'])
  }, 30_000)

  it('imports once: the same request answers the same session after a restart, another request is told where it is', async () => {
    const f = await fixture()
    const rows = (await list(f)).rows
    const preview = await f.owner.json<HistoryPreview>('history/previews', {
      method: 'POST',
      body: { handle: handleOf(rows, 'Login bug [redacted]') },
    })
    const body = { requestId: randomUUID(), previewId: preview.previewId }
    const created = await importOf(f.owner, body)
    expect(created.status).toBe(201)
    const result = (await created.json()) as HistoryImportResult
    expect(result).toMatchObject({ requestId: body.requestId, mode: 'native' })
    expect(await f.owner.json<HistoryImportResult>('history/imports', { method: 'POST', body })).toEqual(result)
    expect(await f.owner.json<HistoryImportResult>(`history/imports/${body.requestId}`)).toEqual(result)

    const detail = await f.owner.json<TaskDetail>(`tasks/${result.taskId}`)
    expect(detail.summary).toMatchObject({
      harnessId: 'codex',
      workspaceId: f.projectId,
      agentPrivate: true,
      imported: { from: 'codex', mode: 'native' },
    })
    expect(detail.messages.filter(message => message.imported).length).toBeGreaterThan(0)
    expect(JSON.stringify(detail.messages)).not.toContain(FAKE_HISTORY_SECRETS.openai)

    await f.restart()
    expect(await f.owner.json<HistoryImportResult>(`history/imports/${body.requestId}`)).toEqual(result)
    const relisted = await list(f)
    expect(relisted.rows.find(row => row.importedTaskId)).toMatchObject({ title: 'Login bug [redacted]', importedTaskId: result.taskId })
    const again = await importOf(f.owner, { requestId: randomUUID(), handle: handleOf(relisted.rows, 'Login bug [redacted]') })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: 'history-already-imported', taskId: result.taskId })

    // Continued natively, with Latch's own mode, not the one the session ran in.
    const prompt = await f.owner.request(`tasks/${result.taskId}/prompt`, {
      method: 'POST',
      body: { prompt: 'echo onward', requestId: randomUUID() },
    })
    expect(prompt.status).toBeLessThan(300)
    await expect
      .poll(async () => (await f.owner.json<TaskDetail>(`tasks/${result.taskId}`)).messages.at(-1)?.text, SLOW)
      .toBe('echo: echo onward')
    const log = await f.log()
    expect(received(log, 'session/resume').map(entry => entry.params?.sessionId)).toEqual(['ext-main'])
    expect(received(log, 'session/set_config_option').map(entry => entry.params?.value)).toContain('read-only')

    // Deleting it in Latch leaves the agent's own session.
    const removed = await f.owner.confirmed(`tasks/${result.taskId}`, { method: 'DELETE' })
    expect(removed.status).toBeLessThan(300)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(received(await f.log(), 'session/delete')).toEqual([])
    expect(await f.audit()).toEqual(['history.list', 'history.preview', 'history.import', 'history.list'])
  }, 60_000)

  it('keeps imported sessions from a device without all data, and refuses it every step', async () => {
    const f = await fixture()
    const rows = (await list(f)).rows
    const created = (await (
      await importOf(f.owner, { requestId: randomUUID(), handle: handleOf(rows, 'Web build') })
    ).json()) as HistoryImportResult
    expect(created.mode).toBe('native')
    const work = await f.t.enroll({ listener: 'loopback-tcp' })
    await f.owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    for (const [path, init] of [
      [`history/sources?projectId=${f.projectId}`, {}],
      ['history/list', { method: 'POST', body: { projectId: f.projectId, harnessId: 'codex' } }],
      ['history/previews', { method: 'POST', body: { handle: handleOf(rows, 'Long') } }],
      ['history/imports', { method: 'POST', body: { requestId: randomUUID(), handle: handleOf(rows, 'Long') } }],
    ] as const) {
      const response = await work.request(path, init)
      expect(response.status).toBe(403)
    }
    expect((await work.request(`tasks/${created.taskId}`)).status).toBe(403)
    const snapshot = await work.json<{ tasks: TaskSummary[]; catalog: { features: { historyImport?: number } } }>('snapshot')
    expect(snapshot.tasks.map(task => task.id)).not.toContain(created.taskId)
    expect(snapshot.catalog.features.historyImport).toBeUndefined()
    // A fork of it is as private.
    const detail = await f.owner.json<TaskDetail>(`tasks/${created.taskId}`)
    const fork = await f.owner.confirmed('tasks', {
      method: 'POST',
      body: {
        forkOf: { taskId: created.taskId, upToMessageId: detail.messages.at(-1)!.id },
        requestId: randomUUID(),
        harnessId: 'fake',
        workspaceId: f.projectId,
      },
    })
    expect(fork.status).toBe(201)
    const forked = ((await fork.json()) as { sessionId: string }).sessionId
    expect((await work.request(`tasks/${forked}`)).status).toBe(403)
  }, 60_000)

  it('rebuilds as text for another harness, marked as such, and sends nothing until the person’s first message', async () => {
    const f = await fixture()
    const rows = (await list(f)).rows
    const response = await importOf(f.owner, { requestId: randomUUID(), handle: handleOf(rows, 'Login bug [redacted]'), harnessId: 'fake' })
    expect(response.status).toBe(201)
    const result = (await response.json()) as HistoryImportResult
    expect(result.mode).toBe('text')
    const waiting = await f.owner.json<TaskDetail>(`tasks/${result.taskId}`)
    expect(waiting.summary).toMatchObject({
      harnessId: 'fake',
      status: 'idle',
      agentPrivate: true,
      imported: { from: 'codex', mode: 'text' },
    })
    expect(waiting.messages.filter(message => message.role === 'user')).toEqual([])
    // No turn yet: the driver was never prompted.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(received(await f.plainLog(), 'session/prompt')).toEqual([])

    const sent = await f.owner.request(`tasks/${result.taskId}/prompt`, {
      method: 'POST',
      body: { prompt: 'echo go on', requestId: randomUUID() },
    })
    expect(sent.status).toBeLessThan(300)
    await expect.poll(async () => received(await f.plainLog(), 'session/prompt').length, SLOW).toBe(1)
    const prompted = (received(await f.plainLog(), 'session/prompt')[0]!.params!.prompt as Array<{ text: string }>)[0]!.text
    expect(prompted).toContain('按文字重建，不是原样恢复')
    expect(prompted.endsWith('echo go on')).toBe(true)
    const detail = await f.owner.json<TaskDetail>(`tasks/${result.taskId}`)
    const first = detail.messages.find(message => message.role === 'user')!.text
    expect(first).toContain('The bug is in the session check.')
    expect(first).not.toContain('OPENAI_API_KEY')
    expect(first).not.toContain('hidden reasoning')
    expect(first).not.toContain(FAKE_HISTORY_SECRETS.openai)
    expect(first.slice(0, detail.summary.imported!.prefixLength!)).not.toContain('echo go on')
    expect(first.slice(detail.summary.imported!.prefixLength!)).toBe('echo go on')
    // The same source cannot be brought in a second time, natively or not.
    const again = await importOf(f.owner, { requestId: randomUUID(), handle: handleOf((await list(f)).rows, 'Login bug [redacted]') })
    expect(await again.json()).toMatchObject({ error: 'history-already-imported', taskId: result.taskId })
  }, 60_000)

  it('drops the rebuilt text when the first message starts a new context', async () => {
    const f = await fixture()
    const rows = (await list(f)).rows
    const result = (await (
      await importOf(f.owner, { requestId: randomUUID(), handle: handleOf(rows, 'Login bug [redacted]'), harnessId: 'fake' })
    ).json()) as HistoryImportResult
    expect((await f.owner.json<TaskDetail>(`tasks/${result.taskId}`)).summary.imported?.prefixLength).toBeGreaterThan(0)
    const sent = await f.owner.request(`tasks/${result.taskId}/prompt`, {
      method: 'POST',
      body: { prompt: 'echo fresh start', requestId: randomUUID(), freshContext: true },
    })
    expect(sent.status).toBeLessThan(300)
    await expect.poll(async () => received(await f.plainLog(), 'session/prompt').length, SLOW).toBe(1)
    expect(JSON.stringify(received(await f.plainLog(), 'session/prompt')[0]!.params)).not.toContain('按文字重建')
    const detail = await f.owner.json<TaskDetail>(`tasks/${result.taskId}`)
    expect(detail.summary.imported).toEqual({ from: 'codex', mode: 'text' })
    expect(detail.messages.find(message => message.role === 'user')!.text).toBe('echo fresh start')
  }, 60_000)

  it('brings in an external session once across definitions that run the same adapter, and keeps only ids in a finished receipt', async () => {
    const f = await fixture()
    const rows = (await list(f)).rows
    const body = { requestId: randomUUID(), handle: handleOf(rows, 'Web build') }
    const result = (await (await importOf(f.owner, body)).json()) as HistoryImportResult
    const receipts = await readFile(join(f.root, 'data', 'history-imports.json'), 'utf8')
    expect(receipts).toContain(result.taskId)
    expect(receipts).not.toContain('Web build')
    expect(receipts).not.toContain(f.main)
    const twin = await f.owner.confirmed('agents', {
      method: 'POST',
      body: { id: 'codex-two', name: 'Codex Two', presetId: 'codex', command: process.execPath, args: [FAKE_ACP_AGENT], env: f.env },
    })
    expect(twin.status).toBe(201)
    const other = await f.owner.json<HistoryList>('history/list', {
      method: 'POST',
      body: { projectId: f.projectId, harnessId: 'codex-two' },
    })
    expect(other.rows.find(row => row.title === 'Web build')).toMatchObject({ importedTaskId: result.taskId })
    const again = await importOf(f.owner, { requestId: randomUUID(), handle: handleOf(other.rows, 'Web build') })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: 'history-already-imported', taskId: result.taskId })
  }, 60_000)

  it('refuses an import whose audit record cannot be written, and leaves nothing behind', async () => {
    const f = await fixture()
    const rows = (await list(f)).rows
    const append = AuditLog.prototype.append
    vi.spyOn(AuditLog.prototype, 'append').mockImplementation(function (this: AuditLog, event) {
      if (event.action === 'history.import') return Promise.reject(new Error('disk full'))
      return append.call(this, event)
    })
    const requestId = randomUUID()
    const refused = await importOf(f.owner, { requestId, handle: handleOf(rows, 'Web build') })
    expect(refused.status).toBeGreaterThanOrEqual(500)
    expect(received(await f.log(), 'session/load')).toEqual([])
    expect((await f.owner.request(`history/imports/${requestId}`)).status).toBe(404)
    vi.restoreAllMocks()
    expect((await importOf(f.owner, { requestId, handle: handleOf(rows, 'Web build') })).status).toBe(201)
  }, 60_000)
})

describe('preview and seed limits', () => {
  it('keeps the last 40 messages within 4 KiB each and 256 KiB in all, tools by title only', () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      id: `${index}`,
      role: index % 3 === 2 ? ('tool' as const) : ('assistant' as const),
      text: `${'é'.repeat(5_000)} ${FAKE_HISTORY_SECRETS.gateway}`,
      tool: { title: `call ${index}`, output: FAKE_HISTORY_SECRETS.openai },
      state: 'completed' as const,
    }))
    const shown = previewMessages(messages)
    expect(shown.cut).toBe(true)
    expect(shown.messages.length).toBeLessThanOrEqual(40)
    expect(shown.messages.every(message => Buffer.byteLength(message.text) <= PREVIEW_MESSAGE_BYTES)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(shown.messages))).toBeLessThanOrEqual(PREVIEW_BYTES)
    expect(JSON.stringify(shown)).not.toContain(FAKE_HISTORY_SECRETS.openai)
    expect(shown.messages.find(message => message.role === 'tool')).toMatchObject({
      outputHidden: true,
      text: expect.stringMatching(/^call /u),
    })
  })

  it('seeds a rebuild from user and agent text only, keeping the last 200,000 characters', () => {
    const seed = textSeed(
      [
        { id: '1', role: 'user', text: 'u'.repeat(150_000) },
        { id: '2', role: 'tool', text: 'TOOL OUTPUT' },
        { id: '3', role: 'assistant', text: 'a'.repeat(150_000), reasoning: 'THOUGHT' },
      ],
      'Codex',
    )!
    expect(seed.truncated).toBe(true)
    expect(seed.text).toContain('按文字重建，不是原样恢复')
    expect(seed.text).not.toContain('TOOL OUTPUT')
    expect(seed.text).not.toContain('THOUGHT')
    expect(seed.prefixLength).toBe(seed.text.length)
  })
})
