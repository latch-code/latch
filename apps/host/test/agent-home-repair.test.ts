// An Agent's home after something happened to it: the Host sets it up again only where nothing is there, moves the one
// chat on only when its home lies under another start directory, and refuses everything else as it is.
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import type { AgentHome, AppSnapshot, Automation, AutomationDetail, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { buildHomeHelper } from '../scripts/build-home.ts'
import { latchCodeRoot } from '../src/paths.ts'
import type { LaunchTerminal, TerminalLaunch } from '../src/terminal/helper.ts'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const roots: string[] = []
const hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const plugin: HarnessPlugin = {
  id: 'agent-provider',
  name: 'fixture',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerProvider({
      id: 'agent-provider',
      name: 'fixture',
      model: 'fixture',
      async *stream({ messages }) {
        const last = messages.at(-1)
        if (last?.role === 'user' && last.content === 'Write inside the managed home') {
          yield {
            type: 'tool-call',
            call: { id: 'write-managed-home', name: 'write_file', arguments: { path: 'keep.txt', content: 'home note' } },
          }
          yield { type: 'finish', reason: 'tool-calls' }
          return
        }
        if (last?.role === 'user' && last.content === 'Read inside the managed home') {
          yield { type: 'tool-call', call: { id: 'read-managed-home', name: 'read_file', arguments: { path: 'keep.txt' } } }
          yield { type: 'finish', reason: 'tool-calls' }
          return
        }
        yield { type: 'text', text: last?.role === 'tool' ? last.content : 'Answer' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
}
const model = { providerId: 'agent-provider', model: 'fixture' }

async function tempRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-home-repair-')))
  roots.push(root)
  return root
}

async function boot(
  root: string,
  workspace = 'workspace',
  dataDir = 'data',
  migration: Pick<TestHostOptions, 'generalHomeMigration' | 'homeHelper'> = {},
) {
  const launched: TerminalLaunch[] = []
  const launch: LaunchTerminal = (spec, onEvent) => {
    launched.push(spec)
    onEvent({ type: 'started', pid: 1 })
    let closed = false
    return {
      pendingInput: 0,
      input() {},
      resize() {},
      signal() {},
      pauseOutput() {},
      resumeOutput() {},
      close() {
        if (!closed) {
          closed = true
          onEvent({ type: 'exit', signal: 1 })
          onEvent({ type: 'gone' })
        }
        return Promise.resolve()
      },
    }
  }
  const options = {
    dataDir: join(root, dataDir),
    workspaceRoot: workspace.startsWith('/') ? workspace : join(root, workspace),
    plugins: [plugin],
    terminal: { launch, shell: { file: '/bin/sh', argv: ['sh'] } },
    ...migration,
  }
  const host = await startTestHost(options)
  hosts.push(host)
  return { host, options, launched }
}

async function stop(host: TestHost) {
  hosts.splice(hosts.indexOf(host), 1)
  await host.close()
}

/** Requests as the same device across Host restarts. */
const credentials = new WeakMap<object, string>()
const as = (host: TestHost, credential: string) => {
  const request = (path: string, method: 'GET' | 'POST' = 'GET', body?: object) =>
    host.raw('unix', `api/${path}`, { method, headers: { authorization: `Latch-Device ${credential}` }, ...(body ? { body } : {}) })
  credentials.set(request, credential)
  return request
}
const credentialOf = (request: object) => credentials.get(request)!

async function answer(response: Response): Promise<[number, unknown]> {
  return [response.status, await response.json()]
}

async function settled(request: ReturnType<typeof as>, id: string) {
  await expect.poll(async () => ((await (await request(`tasks/${id}`)).json()) as TaskDetail).summary.status).toBe('idle')
}

async function auditActions(dataDir: string) {
  return (await readFile(join(dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { action: string; target?: string; detail?: Record<string, unknown> })
}

/** 通用's chat after one exchange. */
async function generalChat(root: string, workspace?: string, dataDir?: string) {
  const booted = await boot(root, workspace, dataDir)
  const owner = await booted.host.enroll({ listener: 'unix' })
  const request = as(booted.host, owner.credential)
  const started = await answer(
    await request('tasks', 'POST', { customAgentId: 'general', prompt: 'Hello', requestId: randomUUID(), model }),
  )
  expect(started[0]).toBe(201)
  const { sessionId } = started[1] as { sessionId: string }
  await settled(request, sessionId)
  return { ...booted, owner, request, sessionId, home: join(booted.options.workspaceRoot, 'helpers', 'general') }
}

describe.skipIf(process.platform !== 'darwin')("General's managed home on macOS", () => {
  let codeRoot: string
  let homeHelper: string | undefined
  const dataDir = '.latch/host'
  beforeAll(async () => {
    codeRoot = await mkdtemp(join(tmpdir(), 'latch-home-migration-build-'))
    const native = join(codeRoot, 'native', 'macos')
    await mkdir(native, { recursive: true })
    await copyFile(join(latchCodeRoot(), 'native', 'macos', 'LatchHome.swift'), join(native, 'LatchHome.swift'))
    homeHelper = await buildHomeHelper(codeRoot)
  }, 180_000)
  afterAll(async () => {
    if (codeRoot) await rm(codeRoot, { recursive: true, force: true })
  })

  test('moves the original folder and continues the same chat across startup workspace changes', async () => {
    const root = await tempRoot()
    const legacyDataDir = 'legacy-data'
    const legacy = await generalChat(root, 'old-workspace', legacyDataDir)
    const { sessionId } = legacy
    await writeFile(join(legacy.home, 'keep.txt'), 'original file')
    const original = await lstat(legacy.home, { bigint: true })
    await stop(legacy.host)

    const buildGeneralHomeHelper = vi.fn(async () => homeHelper)
    const options = { generalHomeMigration: true, generalHomeBase: join(root, '.latch'), buildGeneralHomeHelper }
    const migrated = await boot(root, 'new-workspace', legacyDataDir, options)
    const home = join(root, '.latch', 'agent-homes', 'general')
    const request = as(migrated.host, legacy.owner.credential)
    expect(await (await request('custom-agents/general/home')).json()).toMatchObject({ available: true, state: 'ready', path: home })
    expect(await lstat(home, { bigint: true })).toMatchObject({ dev: original.dev, ino: original.ino })
    expect(await readFile(join(home, 'keep.txt'), 'utf8')).toBe('original file')
    await expect(lstat(legacy.home)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(((await (await request('snapshot')).json()) as AppSnapshot).agentChats?.general).toEqual({ state: 'ready', sessionId })
    expect(
      await answer(await request(`tasks/${sessionId}/prompt`, 'POST', { prompt: 'after migration', requestId: randomUUID() })),
    ).toEqual([200, { accepted: true }])
    await settled(request, sessionId)
    const detail = (await (await request(`tasks/${sessionId}`)).json()) as TaskDetail
    expect(detail.summary.cwd).toBe(home)
    expect(detail.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['Hello', 'after migration'])
    expect((await request(`tasks/${sessionId}/terminals`, 'POST', { cols: 80, rows: 24 })).status).toBe(201)
    expect(migrated.launched.at(-1)?.cwd).toBe(home)
    await stop(migrated.host)

    const restarted = await boot(root, 'another-workspace', legacyDataDir, options)
    const again = as(restarted.host, legacy.owner.credential)
    expect(await answer(await again(`tasks/${sessionId}/prompt`, 'POST', { prompt: 'after restart', requestId: randomUUID() }))).toEqual([
      200,
      { accepted: true },
    ])
    expect(await readFile(join(home, 'keep.txt'), 'utf8')).toBe('original file')
    expect(buildGeneralHomeHelper).toHaveBeenCalledTimes(1)
  })

  test('creates a managed home with the first message and allows only its scoped file access', async () => {
    const root = await tempRoot()
    const { host, options } = await boot(root, 'workspace', dataDir, { generalHomeMigration: true, homeHelper })
    const owner = await host.enroll({ listener: 'unix' })
    const request = as(host, owner.credential)
    const home = join(root, '.latch', 'agent-homes', 'general')
    const note = join(home, 'keep.txt')
    const privateFile = join(options.dataDir, 'private.txt')
    await writeFile(privateFile, 'Host-only file', { mode: 0o600 })
    expect(await owner.json<AgentHome>('custom-agents/general/home')).toMatchObject({ available: false, state: 'pending', path: home })
    await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { customAgentId: 'general', prompt: 'Write inside the managed home', requestId: randomUUID(), model },
    })
    await expect
      .poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).approvals[0])
      .toMatchObject({
        toolName: 'write_file',
        risk: 'R1',
      })
    const approval = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).approvals[0]!
    await expect(lstat(note)).rejects.toMatchObject({ code: 'ENOENT' })
    await owner.json(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
    await settled(request, sessionId)
    expect(await readFile(note, 'utf8')).toBe('home note')
    await owner.json(`tasks/${sessionId}/prompt`, {
      method: 'POST',
      body: { prompt: 'Read inside the managed home', requestId: randomUUID() },
    })
    await settled(request, sessionId)
    expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.findLast(message => message.role === 'assistant')?.text).toContain(
      'home note',
    )

    const { files } = await owner.json<{ files: Array<{ status: string; file?: { handle: string } }> }>(
      `tasks/${sessionId}/files/resolve`,
      { method: 'POST', body: { paths: ['keep.txt', privateFile] } },
    )
    expect(files[0]).toMatchObject({ status: 'ok', file: { handle: expect.any(String) } })
    expect(await (await owner.request(`files/${files[0]!.file!.handle}`)).text()).toBe('home note')
    expect(files[1]).toMatchObject({ status: 'outside' })
    expect(files[1]).not.toHaveProperty('file')
    expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.cwd).toBe(home)
    expect(await owner.json<AgentHome>('custom-agents/general/home')).toMatchObject({ available: true, state: 'ready', path: home })
    expect((await stat(home)).mode & 0o777).toBe(0o700)
    await expect(lstat(join(options.workspaceRoot, 'helpers'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('leaves the original files and chat alone if the recorded home was replaced', async () => {
    const root = await tempRoot()
    const legacy = await generalChat(root, 'old-workspace', dataDir)
    const saved = join(root, 'original-home')
    await writeFile(join(legacy.home, 'keep.txt'), 'original file')
    await rename(legacy.home, saved)
    await mkdir(legacy.home, { mode: 0o700 })
    await writeFile(join(legacy.home, 'keep.txt'), 'replacement file')
    await stop(legacy.host)

    const updated = await boot(root, 'new-workspace', dataDir, { generalHomeMigration: true, homeHelper })
    const request = as(updated.host, legacy.owner.credential)
    expect(await (await request('custom-agents/general/home')).json()).toMatchObject({
      available: false,
      state: 'refused',
      path: legacy.home,
    })
    const sent = await answer(await request(`tasks/${legacy.sessionId}/prompt`, 'POST', { prompt: 'again', requestId: randomUUID() }))
    expect(sent).toEqual([409, expect.objectContaining({ error: 'helper-home-unavailable' })])
    const detail = (await (await request(`tasks/${legacy.sessionId}`)).json()) as TaskDetail
    expect(detail.summary.cwd).toBe(legacy.home)
    await expect(lstat(join(root, '.latch', 'agent-homes', 'general'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(saved, 'keep.txt'), 'utf8')).toBe('original file')
    expect(await readFile(join(legacy.home, 'keep.txt'), 'utf8')).toBe('replacement file')
  })
})

test('sets up a deleted home again on the next message, and the same chat continues there with its terminal', async () => {
  const root = await tempRoot()
  const { host, options, request, sessionId, home, launched } = await generalChat(root)
  await writeFile(join(home, 'gone.txt'), 'deleted with the home')
  await rm(home, { recursive: true })
  // Reading never sets anything up: the profile says the next message will.
  expect(await (await request('custom-agents/general/home')).json()).toMatchObject({ available: false, state: 'pending' })
  await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
  // The send is a person's: the home is recorded first, made again empty, and the turn runs in the same session.
  const sent = await answer(await request(`tasks/${sessionId}/prompt`, 'POST', { prompt: 'again', requestId: randomUUID() }))
  expect(sent).toEqual([200, { accepted: true }])
  await settled(request, sessionId)
  expect((await stat(home)).mode & 0o777).toBe(0o700)
  expect(await readdir(home)).toEqual([])
  const detail = (await (await request(`tasks/${sessionId}`)).json()) as TaskDetail
  expect(detail.summary.cwd).toBe(home)
  expect(detail.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['Hello', 'again'])
  expect((await auditActions(options.dataDir)).filter(row => row.action === 'agent.home.assigned').map(row => row.detail)).toEqual([
    { homeHash: expect.any(String) },
    { homeHash: expect.any(String), recreated: true },
  ])
  expect(((await (await request('snapshot')).json()) as AppSnapshot).agentChats?.general).toEqual({ state: 'ready', sessionId })
  expect(await (await request('custom-agents/general/home')).json()).toMatchObject({ available: true, state: 'ready' })
  const opened = await request(`tasks/${sessionId}/terminals`, 'POST', { cols: 80, rows: 24 })
  expect(opened.status).toBe(201)
  expect(launched.at(-1)?.cwd).toBe(await realpath(home))
  // A restart knows the new home as the one it made.
  await stop(host)
  const next = await boot(root)
  const restarted = as(next.host, credentialOf(request))
  expect(await answer(await restarted(`tasks/${sessionId}/prompt`, 'POST', { prompt: 'later', requestId: randomUUID() }))).toEqual([
    200,
    { accepted: true },
  ])
})

test('makes nothing when the record of setting a home up again cannot be written', async () => {
  const root = await tempRoot()
  const { host, request, sessionId, home } = await generalChat(root)
  await rm(home, { recursive: true })
  const append = host.host.security.audit.append.bind(host.host.security.audit)
  vi.spyOn(host.host.security.audit, 'append').mockImplementation(async event => {
    if (event.action === 'agent.home.assigned') throw new Error('disk full')
    return append(event)
  })
  const sent = await request(`tasks/${sessionId}/prompt`, 'POST', { prompt: 'again', requestId: randomUUID() })
  expect(sent.status).toBeGreaterThanOrEqual(500)
  await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
  const detail = (await (await request(`tasks/${sessionId}`)).json()) as TaskDetail
  expect(detail.messages.filter(message => message.role === 'user')).toHaveLength(1)
})

test.each(['widened', 'replaced', 'link'] as const)(
  'refuses a %s home as it is, with no folder to pick and nothing made or changed',
  async kind => {
    const root = await tempRoot()
    const { request, sessionId, home } = await generalChat(root)
    const original = join(root, 'original-home')
    if (kind === 'widened') await chmod(home, 0o755)
    if (kind === 'replaced') {
      await rename(home, original)
      await mkdir(home, { mode: 0o700 })
    }
    if (kind === 'link') {
      await rename(home, original)
      await symlink(original, home)
    }
    const sent = await answer(await request(`tasks/${sessionId}/prompt`, 'POST', { prompt: 'again', requestId: randomUUID() }))
    expect(sent).toEqual([409, expect.objectContaining({ error: 'helper-home-unavailable' })])
    // Nor does a first start get around it, nor does the chat move.
    const start = await answer(await request('tasks', 'POST', { customAgentId: 'general', prompt: 'new', requestId: randomUUID(), model }))
    expect(start).toEqual([409, expect.objectContaining({ error: 'agent-chat-exists' })])
    expect(((await (await request('snapshot')).json()) as AppSnapshot).agentChats?.general).toEqual({ state: 'ready', sessionId })
    expect(await (await request('custom-agents/general/home')).json()).toMatchObject({ available: false, state: 'refused' })
    const terminal = await answer(await request(`tasks/${sessionId}/terminals`, 'POST', { cols: 80, rows: 24 }))
    expect(terminal).toEqual([409, expect.objectContaining({ error: 'terminal-folder-unavailable' })])
    const info = await lstat(home)
    if (kind === 'widened') expect(info.mode & 0o777).toBe(0o755)
    if (kind === 'replaced') expect(await readdir(home)).toEqual([])
    if (kind === 'link') expect(info.isSymbolicLink()).toBe(true)
  },
)

test('moves the one chat to the home under a new start directory on the next message, and back again', async () => {
  const root = await tempRoot()
  const first = await generalChat(root)
  const credential = first.owner.credential
  // While the home is healthy, a first start is refused: the chat stays.
  const kept = await answer(
    await first.request('tasks', 'POST', { customAgentId: 'general', prompt: 'other', requestId: randomUUID(), model }),
  )
  expect(kept).toEqual([409, expect.objectContaining({ error: 'agent-chat-exists' })])
  await writeFile(join(first.home, 'kept.txt'), 'in the first start directory')
  await stop(first.host)

  const moved = await boot(root, 'other-workspace')
  const request = as(moved.host, credential)
  const message = { prompt: 'after the move', requestId: randomUUID() }
  const sent = await answer(await request(`tasks/${first.sessionId}/prompt`, 'POST', message))
  expect(sent[0]).toBe(200)
  const { sessionId } = sent[1] as { accepted: true; sessionId: string }
  expect(sessionId).not.toBe(first.sessionId)
  await settled(request, sessionId)
  const detail = (await (await request(`tasks/${sessionId}`)).json()) as TaskDetail
  expect(detail.summary).toMatchObject({ generalChat: true, cwd: join(moved.options.workspaceRoot, 'helpers', 'general') })
  expect(detail.messages.filter(row => row.role === 'user').map(row => row.text)).toEqual(['after the move'])
  expect(((await (await request('snapshot')).json()) as AppSnapshot).agentChats?.general).toEqual({ state: 'ready', sessionId })
  // A retry of the same message gets the same answer; the old chat stays to read and takes no new message.
  expect(await answer(await request(`tasks/${first.sessionId}/prompt`, 'POST', message))).toEqual([200, { accepted: true, sessionId }])
  const old = await answer(await request(`tasks/${first.sessionId}/prompt`, 'POST', { prompt: 'x', requestId: randomUUID() }))
  expect(old).toEqual([409, expect.objectContaining({ error: 'agent-chat-history-read-only' })])
  expect((await request(`tasks/${first.sessionId}`)).status).toBe(200)
  const retired = (await auditActions(join(root, 'data'))).filter(row => row.action === 'agent.chat.retired')
  expect(retired).toEqual([
    expect.objectContaining({ target: 'general', detail: { customAgentId: 'general', sessionId: first.sessionId, reason: 'home-moved' } }),
  ])
  expect(await readFile(join(first.home, 'kept.txt'), 'utf8')).toBe('in the first start directory')
  await stop(moved.host)

  // Back to the first start directory: its home is still known, so the chat moves into it as it is.
  const back = await boot(root)
  const backRequest = as(back.host, credential)
  const returned = await answer(await backRequest(`tasks/${sessionId}/prompt`, 'POST', { prompt: 'back', requestId: randomUUID() }))
  expect(returned[0]).toBe(200)
  const backId = (returned[1] as { sessionId: string }).sessionId
  await settled(backRequest, backId)
  expect(((await (await backRequest(`tasks/${backId}`)).json()) as TaskDetail).summary.cwd).toBe(first.home)
  expect(await readFile(join(first.home, 'kept.txt'), 'utf8')).toBe('in the first start directory')
})

test('starts 通用 in a start directory that is a link the owner chose', async () => {
  const root = await tempRoot()
  await mkdir(join(root, 'real-workspace'), { mode: 0o700 })
  await symlink(join(root, 'real-workspace'), join(root, 'workspace'))
  const { host } = await boot(root)
  const owner = await host.enroll({ listener: 'unix' })
  const started = await owner.request('tasks', {
    method: 'POST',
    body: { customAgentId: 'general', prompt: 'Hello', requestId: randomUUID(), model },
  })
  expect(started.status).toBe(201)
  expect((await stat(join(root, 'real-workspace', 'helpers', 'general'))).mode & 0o777).toBe(0o700)
})

test('starts 通用 on a fresh data directory whose start directory does not exist yet', async () => {
  const root = await tempRoot()
  const { host, options } = await boot(root)
  const owner = await host.enroll({ listener: 'unix' })
  await expect(stat(join(options.workspaceRoot, 'helpers'))).rejects.toMatchObject({ code: 'ENOENT' })
  const started = await owner.request('tasks', {
    method: 'POST',
    body: { customAgentId: 'general', prompt: 'Hello', requestId: randomUUID(), model },
  })
  expect(started.status).toBe(201)
  expect(await owner.json<AgentHome>('custom-agents/general/home')).toMatchObject({ available: true, state: 'ready' })
})

test('gives a second data directory on the same start directory a home of its own, never the first one’s', async () => {
  const root = await tempRoot()
  const first = await generalChat(root)
  await writeFile(join(first.home, 'first.txt'), 'first Host')
  await stop(first.host)
  const second = await boot(root, 'workspace', 'data-2')
  const owner = await second.host.enroll({ listener: 'unix' })
  // Before its first message the plain name is the other Host's: the profile does not show it as this one's home.
  const pending = await owner.json<AgentHome>('custom-agents/general/home')
  expect(pending).toMatchObject({ available: false, state: 'pending' })
  expect(pending.path).not.toBe(first.home)
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: 'general', prompt: 'Hello', requestId: randomUUID(), model },
  })
  await settled(as(second.host, owner.credential), sessionId)
  const cwd = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.cwd!
  expect(cwd).toMatch(/\/helpers\/general-[0-9a-f]{8}$/u)
  expect(cwd).not.toBe(first.home)
  expect(await readdir(cwd)).toEqual([])
  expect(await readFile(join(first.home, 'first.txt'), 'utf8')).toBe('first Host')
  const home = await owner.json<AgentHome>('custom-agents/general/home')
  expect(home).toMatchObject({ available: true, state: 'ready', path: await realpath(cwd) })
  // Its next message continues there, and so does the first Host's chat in its own home.
  await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'again', requestId: randomUUID() } })
  await settled(as(second.host, owner.credential), sessionId)
  await stop(second.host)
  const back = await boot(root)
  const request = as(back.host, first.owner.credential)
  expect(await answer(await request(`tasks/${first.sessionId}/prompt`, 'POST', { prompt: 'still mine', requestId: randomUUID() }))).toEqual(
    [200, { accepted: true }],
  )
})

test('moves one of my Agents’ chat the same way, on its own Harness and definition', async () => {
  const root = await tempRoot()
  const first = await boot(root)
  const owner = await first.host.enroll({ listener: 'unix' })
  const agent = await owner.json<{ id: string }>('custom-agents', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '整理',
      description: '',
      harnessId: 'standard',
      mode: 'agent',
      model,
      instructions: '',
      skills: [],
    },
  })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: 'Hello', requestId: randomUUID() },
  })
  await settled(as(first.host, owner.credential), sessionId)
  await stop(first.host)
  const moved = await boot(root, 'other-workspace')
  const request = as(moved.host, owner.credential)
  const sent = await answer(await request(`tasks/${sessionId}/prompt`, 'POST', { prompt: 'moved', requestId: randomUUID() }))
  expect(sent[0]).toBe(200)
  const next = (sent[1] as { sessionId: string }).sessionId
  expect(next).not.toBe(sessionId)
  await settled(request, next)
  expect(((await (await request(`tasks/${next}`)).json()) as TaskDetail).summary).toMatchObject({
    agent: { customAgentId: agent.id },
    harnessId: 'standard',
    cwd: join(moved.options.workspaceRoot, 'helpers', agent.id),
  })
})

test('answers a retry of the moving message while its start is still being confirmed', async () => {
  const root = await tempRoot()
  const first = await generalChat(root)
  const credential = first.owner.credential
  await stop(first.host)
  let moved = await boot(root, 'other-workspace')
  const message = { prompt: 'after the move', requestId: randomUUID() }
  const sent = await answer(await as(moved.host, credential)(`tasks/${first.sessionId}/prompt`, 'POST', message))
  expect(sent[0]).toBe(200)
  const { sessionId } = sent[1] as { sessionId: string }
  await settled(as(moved.host, credential), sessionId)
  await stop(moved.host)
  // The Host stopped before it recorded the new chat: the slot still holds the message as being confirmed.
  const journal = join(root, 'data', 'agents', 'custom.json')
  const state = JSON.parse(await readFile(journal, 'utf8')) as { chats: { general: { state: string; sessionId?: string } } }
  state.chats.general.state = 'starting'
  delete state.chats.general.sessionId
  await writeFile(journal, JSON.stringify(state))
  moved = await boot(root, 'other-workspace')
  const request = as(moved.host, credential)
  expect(((await (await request('snapshot')).json()) as AppSnapshot).agentChats?.general).toEqual({ state: 'starting' })
  expect(await answer(await request(`tasks/${first.sessionId}/prompt`, 'POST', message))).toEqual([200, { accepted: true, sessionId }])
  expect(((await (await request('snapshot')).json()) as AppSnapshot).agentChats?.general).toEqual({ state: 'ready', sessionId })
  const detail = (await (await request(`tasks/${sessionId}`)).json()) as TaskDetail
  expect(detail.messages.filter(row => row.role === 'user').map(row => row.text)).toEqual(['after the move'])
})

test('a scheduled run sets a deleted home up again the way a message would, recorded first', async () => {
  const root = await tempRoot()
  const { owner, request, home, options } = await generalChat(root)
  await rm(home, { recursive: true })
  const { id } = await owner.json<Automation>('automations', {
    method: 'POST',
    body: { requestId: randomUUID(), name: 'Daily', model, prompt: 'Now', schedule: { kind: 'daily', time: '09:00' }, notify: false },
  })
  await owner.json(`automations/${id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
  await expect
    .poll(async () => (await owner.json<AutomationDetail>(`automations/${id}`)).automation.lastRun?.state, { timeout: 8000 })
    .toBe('completed')
  expect((await stat(home)).mode & 0o777).toBe(0o700)
  expect((await auditActions(options.dataDir)).filter(row => row.action === 'agent.home.assigned').at(-1)?.detail).toMatchObject({
    recreated: true,
  })
  void request
})

test.each(['deleted', 'moved'] as const)('an Agent on an ACP Harness continues after its home was %s', async kind => {
  const root = await tempRoot()
  const first = await boot(root)
  const owner = await first.host.enroll({ listener: 'unix' })
  const defined = await owner.confirmed('agents', {
    method: 'POST',
    body: { id: 'fake-acp', name: 'Fake ACP', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
  })
  expect(defined.ok).toBe(true)
  const agent = await owner.json<{ id: string }>('custom-agents', {
    method: 'POST',
    body: { requestId: randomUUID(), name: '外部', description: '', harnessId: 'fake-acp', mode: 'agent', instructions: '', skills: [] },
  })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: 'echo first', requestId: randomUUID() },
  })
  let request = as(first.host, owner.credential)
  await settled(request, sessionId)
  const home = join(first.options.workspaceRoot, 'helpers', agent.id)
  let target = sessionId
  if (kind === 'deleted') {
    await rm(home, { recursive: true })
    expect(await answer(await request(`tasks/${sessionId}/prompt`, 'POST', { prompt: 'echo again', requestId: randomUUID() }))).toEqual([
      200,
      { accepted: true },
    ])
  } else {
    await stop(first.host)
    const moved = await boot(root, 'other-workspace')
    request = as(moved.host, owner.credential)
    const sent = await answer(await request(`tasks/${sessionId}/prompt`, 'POST', { prompt: 'echo again', requestId: randomUUID() }))
    expect(sent[0]).toBe(200)
    target = (sent[1] as { sessionId: string }).sessionId
    expect(target).not.toBe(sessionId)
  }
  await settled(request, target)
  const detail = (await (await request(`tasks/${target}`)).json()) as TaskDetail
  expect(detail.summary.runOutcome).not.toBe('failed')
  expect(
    detail.messages
      .filter(row => row.role === 'user')
      .map(row => row.text)
      .at(-1),
  ).toBe('echo again')
  expect(detail.messages.filter(row => row.role === 'assistant').length).toBeGreaterThan(kind === 'deleted' ? 1 : 0)
})

test('gives the chat back when the move is refused before it starts: the update window, and a refusal after the slot moved', async () => {
  const root = await tempRoot()
  const first = await generalChat(root)
  const credential = first.owner.credential
  await stop(first.host)
  const moved = await boot(root, 'other-workspace')
  const request = as(moved.host, credential)
  // The install window refuses the start: nothing is retired.
  expect((await request('host/update-window', 'POST', { open: true })).status).toBe(200)
  const updating = await answer(await request(`tasks/${first.sessionId}/prompt`, 'POST', { prompt: 'now', requestId: randomUUID() }))
  expect(updating).toEqual([409, expect.objectContaining({ error: 'host-updating' })])
  expect(((await (await request('snapshot')).json()) as AppSnapshot).agentChats?.general).toEqual({
    state: 'ready',
    sessionId: first.sessionId,
  })
  expect((await auditActions(join(root, 'data'))).some(row => row.action === 'agent.chat.retired')).toBe(false)
  expect((await request('host/update-window', 'POST', { open: false, reason: 'cancelled' })).status).toBe(200)
  // A refusal that comes after the slot moved (an attachment that is not there) gives the slot back, on record.
  const missing = await answer(
    await request(`tasks/${first.sessionId}/prompt`, 'POST', {
      prompt: 'with a file',
      requestId: randomUUID(),
      attachmentIds: ['A'.repeat(22)],
    }),
  )
  expect(missing[0]).toBeGreaterThanOrEqual(400)
  expect(missing[0]).toBeLessThan(500)
  expect(((await (await request('snapshot')).json()) as AppSnapshot).agentChats?.general).toEqual({
    state: 'ready',
    sessionId: first.sessionId,
  })
  const rows = (await auditActions(join(root, 'data'))).filter(row => row.action.startsWith('agent.chat.'))
  expect(rows.map(row => [row.action, row.detail?.sessionId])).toEqual([
    ['agent.chat.retired', first.sessionId],
    ['agent.chat.restored', first.sessionId],
  ])
  await stop(moved.host)
  // Back on its own start directory, the chat is still the Agent's chat and takes messages.
  const back = await boot(root)
  expect(
    await answer(await as(back.host, credential)(`tasks/${first.sessionId}/prompt`, 'POST', { prompt: 'back', requestId: randomUUID() })),
  ).toEqual([200, { accepted: true }])
})

test('moves a chat only once, whoever sends at the same time, and answers retries by device and body', async () => {
  const root = await tempRoot()
  const first = await generalChat(root)
  const other = await first.host.enroll({ listener: 'unix' })
  await stop(first.host)
  const moved = await boot(root, 'other-workspace')
  const mine = as(moved.host, first.owner.credential)
  const theirs = as(moved.host, other.credential)
  const message = { prompt: 'mine', requestId: randomUUID() }
  const both = await Promise.all([
    mine(`tasks/${first.sessionId}/prompt`, 'POST', message),
    theirs(`tasks/${first.sessionId}/prompt`, 'POST', { prompt: 'theirs', requestId: randomUUID() }),
  ])
  const answers = await Promise.all(both.map(answer))
  expect(answers.map(([status]) => status).toSorted()).toEqual([200, 409])
  const won = answers.findIndex(([status]) => status === 200)
  const sessionId = (answers[won]![1] as { sessionId: string }).sessionId
  expect((await auditActions(join(root, 'data'))).filter(row => row.action === 'agent.chat.retired')).toHaveLength(1)
  const winner = won === 0 ? mine : theirs
  const loser = won === 0 ? theirs : mine
  const winning = won === 0 ? message : undefined
  await settled(winner, sessionId)
  if (winning) {
    // Another device with the same request ID is not the original request.
    expect((await loser(`tasks/${first.sessionId}/prompt`, 'POST', winning)).status).toBe(409)
    // The same device and ID with another body is a conflict.
    const changed = await answer(await mine(`tasks/${first.sessionId}/prompt`, 'POST', { ...winning, prompt: 'changed' }))
    expect(changed).toEqual([409, expect.objectContaining({ error: 'request-conflict' })])
  }
  expect(((await (await mine('snapshot')).json()) as AppSnapshot).agentChats?.general).toEqual({ state: 'ready', sessionId })
})

test('does not move a chat that still has a queued message, and says so with nothing changed', async () => {
  const root = await tempRoot()
  const first = await generalChat(root)
  const credential = first.owner.credential
  await stop(first.host)
  const queued = { prompt: 'queued before the move', requestId: randomUUID() }
  await writeFile(
    join(root, 'data', 'queues.json'),
    JSON.stringify({
      version: 1,
      items: [
        {
          id: `queue-${randomUUID()}`,
          sessionId: first.sessionId,
          deviceId: first.owner.id,
          listener: 'unix',
          dataScope: 'all',
          requestId: queued.requestId,
          sendRequestId: randomUUID(),
          hash: sha256Hex(canonicalJson({ text: queued.prompt })),
          text: queued.prompt,
          queuedAt: new Date().toISOString(),
          state: 'parked',
          waitRunId: '',
        },
      ],
    }),
    { mode: 0o600 },
  )
  const moved = await boot(root, 'other-workspace')
  const request = as(moved.host, credential)
  const refused = await answer(await request(`tasks/${first.sessionId}/prompt`, 'POST', { prompt: 'now', requestId: randomUUID() }))
  expect(refused).toEqual([409, expect.objectContaining({ error: 'agent-chat-move-pending' })])
  expect(((await (await request('snapshot')).json()) as AppSnapshot).agentChats?.general).toEqual({
    state: 'ready',
    sessionId: first.sessionId,
  })
  expect((await auditActions(join(root, 'data'))).some(row => row.action === 'agent.chat.retired')).toBe(false)
  const fileRef = await answer(
    await request(`tasks/${first.sessionId}/prompt`, 'POST', {
      prompt: 'see this',
      requestId: randomUUID(),
      fileRefs: [{ root: 'default', path: 'notes.md' }],
    }),
  )
  expect(fileRef[0]).toBeGreaterThanOrEqual(400)
})

test('a device without full data scope, or one removed, sets nothing up and records nothing', async () => {
  const root = await tempRoot()
  const { host, owner, request, sessionId, home, options } = await generalChat(root)
  const work = await host.enroll({ listener: 'loopback-tcp' })
  await owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
  const removed = await host.enroll({ listener: 'unix' })
  await owner.json(`devices/${removed.id}`, { method: 'DELETE', body: {} })
  await rm(home, { recursive: true })
  const before = (await auditActions(options.dataDir)).length
  const narrow = await work.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'x', requestId: randomUUID() } })
  expect([403, 404]).toContain(narrow.status)
  const gone = await removed.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'x', requestId: randomUUID() } })
  expect(gone.status).toBe(401)
  // A request the Host refuses for itself (an empty message) makes nothing either.
  expect((await request(`tasks/${sessionId}/prompt`, 'POST', { prompt: '', requestId: randomUUID() })).status).toBe(400)
  await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await auditActions(options.dataDir)).slice(before).filter(row => row.action === 'agent.home.assigned')).toEqual([])
})

test('reads, the terminal, warm-up and the input box’s capabilities leave an absent home absent', async () => {
  const root = await tempRoot()
  const { request, sessionId, home } = await generalChat(root)
  await rm(home, { recursive: true })
  expect((await request(`tasks/${sessionId}/terminals`, 'POST', { cols: 80, rows: 24 })).status).toBe(409)
  expect((await request(`tasks/${sessionId}/files/resolve`, 'POST', { paths: ['x.md'] })).status).toBeGreaterThanOrEqual(400)
  await request('custom-agents/general/warm', 'POST', {})
  const caps = await request('attachments/capabilities', 'POST', { selection: { harnessId: 'standard' }, sessionId })
  expect(caps.status).toBe(200)
  expect(await (await request('custom-agents/general/home')).json()).toMatchObject({ state: 'pending' })
  await request(`tasks/${sessionId}`)
  await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('heals, not moves, a chat whose recorded home is spelled another way after its whole start directory was deleted', async () => {
  const root = await tempRoot()
  // The same start directory under two spellings: through a link, and its real path (as a driver may record it).
  await mkdir(join(root, 'real'), { mode: 0o700 })
  await symlink(join(root, 'real'), join(root, 'spelled'))
  const first = await boot(root, join(root, 'spelled', 'workspace'))
  const owner = await first.host.enroll({ listener: 'unix' })
  const started = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: 'general', prompt: 'Hello', requestId: randomUUID(), model },
  })
  await settled(as(first.host, owner.credential), started.sessionId)
  await stop(first.host)
  const next = await boot(root, join(root, 'real', 'workspace'))
  await rm(join(root, 'real', 'workspace'), { recursive: true })
  const request = as(next.host, owner.credential)
  const sent = await answer(await request(`tasks/${started.sessionId}/prompt`, 'POST', { prompt: 'again', requestId: randomUUID() }))
  expect(sent).toEqual([200, { accepted: true }])
  await settled(request, started.sessionId)
  expect((await auditActions(join(root, 'data'))).some(row => row.action === 'agent.chat.retired')).toBe(false)
  expect((await stat(join(root, 'real', 'workspace', 'helpers', 'general'))).mode & 0o777).toBe(0o700)
})

test('moves the chat when its old start directory was deleted and the Host runs on another one', async () => {
  const root = await tempRoot()
  const first = await generalChat(root)
  const credential = first.owner.credential
  await stop(first.host)
  await rm(join(root, 'workspace'), { recursive: true })
  const moved = await boot(root, 'other-workspace')
  const request = as(moved.host, credential)
  const sent = await answer(await request(`tasks/${first.sessionId}/prompt`, 'POST', { prompt: 'after', requestId: randomUUID() }))
  expect(sent[0]).toBe(200)
  const { sessionId } = sent[1] as { sessionId: string }
  expect(sessionId).not.toBe(first.sessionId)
  await settled(request, sessionId)
  expect(((await (await request(`tasks/${sessionId}`)).json()) as TaskDetail).summary.cwd).toBe(
    join(moved.options.workspaceRoot, 'helpers', 'general'),
  )
  const old = await answer(await request(`tasks/${first.sessionId}/prompt`, 'POST', { prompt: 'x', requestId: randomUUID() }))
  expect(old).toEqual([409, expect.objectContaining({ error: 'agent-chat-history-read-only' })])
})

test('heals, not moves, when the deleted part of the start directory is spelled with capitals', async () => {
  const root = await tempRoot()
  await symlink(root, join(root, 'alias'))
  const first = await boot(root, join(root, 'Latch', 'Workspace'))
  const owner = await first.host.enroll({ listener: 'unix' })
  const started = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: 'general', prompt: 'Hello', requestId: randomUUID(), model },
  })
  await settled(as(first.host, owner.credential), started.sessionId)
  await stop(first.host)
  // The same start directory spelled through a link; then everything from `Latch` down is deleted.
  const next = await boot(root, join(root, 'alias', 'Latch', 'Workspace'))
  await rm(join(root, 'Latch'), { recursive: true })
  const request = as(next.host, owner.credential)
  const sent = await answer(await request(`tasks/${started.sessionId}/prompt`, 'POST', { prompt: 'again', requestId: randomUUID() }))
  expect(sent).toEqual([200, { accepted: true }])
  await settled(request, started.sessionId)
  expect((await auditActions(join(root, 'data'))).some(row => row.action === 'agent.chat.retired')).toBe(false)
  expect((await stat(join(root, 'Latch', 'Workspace', 'helpers', 'general'))).mode & 0o777).toBe(0o700)
})

test('sets its homes up again after another Host on the same start directory deleted and made helpers again', async () => {
  const root = await tempRoot()
  const first = await generalChat(root)
  await stop(first.host)
  const second = await boot(root, 'workspace', 'data-2')
  const other = await second.host.enroll({ listener: 'unix' })
  const theirs = await other.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: 'general', prompt: 'Hello', requestId: randomUUID(), model },
  })
  await settled(as(second.host, other.credential), theirs.sessionId)
  const otherHome = (await other.json<TaskDetail>(`tasks/${theirs.sessionId}`)).summary.cwd!
  // The other Host's helpers goes, and that Host makes it again with its own home.
  await rm(join(root, 'workspace', 'helpers'), { recursive: true })
  await other.json(`tasks/${theirs.sessionId}/prompt`, { method: 'POST', body: { prompt: 'again', requestId: randomUUID() } })
  await settled(as(second.host, other.credential), theirs.sessionId)
  await stop(second.host)
  // This Host's home is gone with it: nothing of its own can be in the new helpers, so it sets its home up there.
  const back = await boot(root)
  const request = as(back.host, first.owner.credential)
  expect(await answer(await request(`tasks/${first.sessionId}/prompt`, 'POST', { prompt: 'mine', requestId: randomUUID() }))).toEqual([
    200,
    { accepted: true },
  ])
  await settled(request, first.sessionId)
  expect((await stat(first.home)).mode & 0o777).toBe(0o700)
  expect((await stat(otherHome)).isDirectory()).toBe(true)
})
