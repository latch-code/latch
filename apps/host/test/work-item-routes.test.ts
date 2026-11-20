import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, CustomAgentList, TaskDetail, WorkItem, WorkItemAnswer, WorkItemStartAnswer } from '@latch/protocol'
import { AppError, type HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { WORK_RECEIPT_TTL_MS } from '../src/work-items.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
const folders: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.close()
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

const SLOW = { timeout: 30_000 }

/** A Host whose start directory is a repository, with the fake ACP agent defined from this Mac. */
async function fixture(directories: { dataDir: string; workspaceRoot: string } | Record<string, never> = {}) {
  const t = await startTestHost(directories)
  hosts.push(t)
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: t.workspaceRoot, stdio: 'pipe' })
  if (!(await stat(join(t.workspaceRoot, '.git')).catch(() => undefined))) {
    git('init', '-q', '-b', 'main')
    await writeFile(join(t.workspaceRoot, 'tracked.txt'), 'committed\n')
    git('add', '.')
    git('commit', '-q', '-m', 'first')
  }
  const owner = await t.enroll({ listener: 'unix' })
  await owner.confirmedJson('agents', { body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT] } })
  return { t, owner }
}

const errorOf = async (response: Response) => ({ status: response.status, error: ((await response.json()) as { error: string }).error })
const items = async (device: TestDevice) => (await device.json<AppSnapshot>('snapshot')).items ?? []
const listed = async (device: TestDevice, sessionId: string) =>
  (await device.json<AppSnapshot>('snapshot')).tasks.find(task => task.id === sessionId)

async function create(device: TestDevice, body: Record<string, unknown> = {}): Promise<WorkItem> {
  const { item } = await device.json<WorkItemAnswer>('work/items', {
    method: 'POST',
    body: { requestId: randomUUID(), title: '给 README 加一节', prompt: 'shell-edit', harnessId: 'fake', ...body },
  })
  return item
}

/** 开始 as the person saw the 待办: its current revision unless the test names one. */
async function start(device: TestDevice, id: string, body: Record<string, unknown> = {}) {
  const seen = await device.request(`work/items/${id}`)
  const baseRevision = seen.ok ? ((await seen.json()) as WorkItemAnswer).item.revision : 1
  return device.confirmed(`work/items/${id}/start`, {
    method: 'POST',
    body: { requestId: randomUUID(), mode: 'agent', baseRevision, ...body },
  })
}

async function audited(t: TestHost, action: string): Promise<Array<{ detail: Record<string, unknown> }>> {
  const log = await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8')
  return log
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { action: string; detail: Record<string, unknown> })
    .filter(entry => entry.action === action)
}

describe('待办 records', () => {
  it('makes, reads, edits, closes and deletes a 待办; a retry gets the same one', SLOW, async () => {
    const { t, owner } = await fixture()
    const requestId = randomUUID()
    const body = { requestId, title: '  给 README 加一节 ', prompt: '写一节安装说明', tags: [' docs ', 'docs'], priority: 'high' }
    const first = await owner.request('work/items', { method: 'POST', body })
    expect(first.status).toBe(201)
    const { item } = (await first.json()) as WorkItemAnswer
    expect(item).toMatchObject({
      id: expect.stringMatching(/^itm_[A-Za-z0-9_-]{22}$/u),
      title: '给 README 加一节',
      prompt: '写一节安装说明',
      tags: ['docs'],
      priority: 'high',
      sessionIds: [],
      revision: 1,
      board: { group: 'todo' },
    })
    // A retry answers the same 待办; another body under the same request ID is a conflict.
    expect((await owner.json<WorkItemAnswer>('work/items', { method: 'POST', body })).item.id).toBe(item.id)
    expect(await errorOf(await owner.request('work/items', { method: 'POST', body: { ...body, title: '别的' } }))).toEqual({
      status: 409,
      error: 'request-conflict',
    })
    // The snapshot lists it without its prompt; GET carries the prompt.
    const [summary] = await items(owner)
    expect(summary).toMatchObject({ id: item.id, hasPrompt: true, board: { group: 'todo' } })
    expect(summary).not.toHaveProperty('prompt')
    expect((await owner.json<WorkItemAnswer>(`work/items/${item.id}`)).item.prompt).toBe('写一节安装说明')

    const edited = await owner.json<WorkItemAnswer>(`work/items/${item.id}`, {
      method: 'PATCH',
      body: { baseRevision: 1, prompt: '改过的要求', priority: 'mid', projectId: 'default' },
    })
    expect(edited.item).toMatchObject({ prompt: '改过的要求', revision: 2, projectId: 'default' })
    expect(edited.item).not.toHaveProperty('priority')
    expect(await errorOf(await owner.request(`work/items/${item.id}`, { method: 'PATCH', body: { baseRevision: 1, title: 'x' } }))).toEqual(
      {
        status: 409,
        error: 'item-changed',
      },
    )
    const closed = await owner.json<WorkItemAnswer>(`work/items/${item.id}`, { method: 'PATCH', body: { baseRevision: 2, closed: true } })
    expect(closed.item).toMatchObject({ closedAt: expect.any(String), board: { group: 'done' } })
    const reopened = await owner.json<WorkItemAnswer>(`work/items/${item.id}`, {
      method: 'PATCH',
      body: { baseRevision: 3, closed: false },
    })
    expect(reopened.item.board).toEqual({ group: 'todo' })
    expect(reopened.item).not.toHaveProperty('closedAt')
    expect((await audited(t, 'work.item.closed')).map(entry => entry.detail)).toEqual([
      { itemId: item.id, closed: true },
      { itemId: item.id, closed: false },
    ])
    expect((await audited(t, 'work.item.changed')).map(entry => entry.detail.op)).toEqual(['created', 'edited'])
    // Ids and hashes only: the title and prompt never reach the audit log.
    const log = await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8')
    expect(log).not.toContain('README')
    expect(log).not.toContain('改过的要求')

    const file = join(t.dataDir, 'work', 'items.json')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await owner.request(`work/items/${item.id}`, { method: 'DELETE', body: { baseRevision: 4 } })).status).toBe(200)
    expect(await items(owner)).toEqual([])
    expect(await errorOf(await owner.request(`work/items/${item.id}`))).toEqual({ status: 404, error: 'item-not-found' })
  })

  it('looks up only this device’s original creation receipt, never creating an item on a missing receipt', SLOW, async () => {
    let now = Date.now()
    const t = await startTestHost({ now: () => now })
    hosts.push(t)
    const owner = await t.enroll({ listener: 'unix' })
    const other = await t.enroll({ listener: 'unix' })
    const viewer = await t.enroll({ listener: 'unix', scopes: ['view'] })
    const body = { requestId: randomUUID(), title: '保存待办', prompt: '稍后再开始' }
    const lookup = (device: TestDevice, input = body) => device.request('work/items/retry-create', { method: 'POST', body: input })
    expect(await errorOf(await lookup(owner))).toEqual({ status: 409, error: 'item-create-unconfirmed' })
    expect(await items(owner)).toHaveLength(0)
    const { item: made } = await owner.json<WorkItemAnswer>('work/items', { method: 'POST', body })
    expect(await (await lookup(owner)).json()).toMatchObject({ item: { id: made.id, sessionIds: [] }, requestId: body.requestId })
    expect(await errorOf(await lookup(owner, { ...body, prompt: 'different' }))).toEqual({ status: 409, error: 'request-conflict' })
    expect(await errorOf(await lookup(other))).toEqual({ status: 409, error: 'item-create-unconfirmed' })
    expect((await lookup(viewer)).status).toBe(403)
    now += WORK_RECEIPT_TTL_MS + 1
    await owner.renew()
    expect(await errorOf(await lookup(owner))).toEqual({ status: 409, error: 'item-create-unconfirmed' })
    expect((await items(owner)).map(item => item.id)).toEqual([made.id])
    expect((await audited(t, 'work.item.changed')).map(entry => entry.detail.op)).toEqual(['created'])
  })
  it('refuses titles and prompts it cannot keep, and every write from a device that may only view', SLOW, async () => {
    const { t, owner } = await fixture()
    const post = (body: Record<string, unknown>) =>
      owner.request('work/items', { method: 'POST', body: { requestId: randomUUID(), title: 't', ...body } })
    for (const [body, error] of [
      [{ title: '' }, 'item-title-invalid'],
      [{ title: 'a\nb' }, 'item-title-invalid'],
      [{ title: 'x'.repeat(121) }, 'item-title-invalid'],
      [{ title: 'key AKIAABCDEFGHIJKLMNOP' }, 'item-secret'],
      [{ prompt: 'use sk-ant-api03-' + 'a'.repeat(90) }, 'item-secret'],
      [{ prompt: 'x'.repeat(16_001) }, 'item-prompt-invalid'],
      [{ prompt: 'bell\u0007' }, 'item-prompt-invalid'],
      [{ tags: Array.from({ length: 9 }, (_, index) => `t${index}`) }, 'tag-limit'],
      [{ projectId: 'missing' }, 'workspace-unavailable'],
      [{ priority: 'urgent' }, 'invalid-input'],
      [{ owner: 'someone' }, 'invalid-input'],
    ] as const)
      expect(await errorOf(await post(body)), JSON.stringify(body).slice(0, 60)).toEqual({ status: 400, error })
    const item = await create(owner)
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    expect((await viewer.request(`work/items/${item.id}`)).status).toBe(200)
    for (const response of [
      await viewer.request('work/items', { method: 'POST', body: { requestId: randomUUID(), title: 't' } }),
      await viewer.request(`work/items/${item.id}`, { method: 'PATCH', body: { baseRevision: 1, closed: true } }),
      await viewer.request(`work/items/${item.id}`, { method: 'DELETE', body: { baseRevision: 1 } }),
      await viewer.request(`work/items/${item.id}/start`, { method: 'POST', body: { requestId: randomUUID() } }),
      await viewer.request(`work/items/${item.id}/sessions`, { method: 'POST', body: { sessionId: 'task-x' } }),
    ])
      expect(response.status).toBe(403)
  })

  it('starts through the same checks, confirmations and start audits as POST /tasks', SLOW, async () => {
    const { t, owner } = await fixture()
    const remote = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'], dataScope: 'all' })
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    const routes = {
      tasks: (device: TestDevice, body: Record<string, unknown>) =>
        device.confirmed('tasks', {
          method: 'POST',
          body: { requestId: randomUUID(), prompt: 'shell-edit', mode: 'agent', harnessId: 'fake', workspaceId: 'default', ...body },
        }),
      item: async (device: TestDevice, body: Record<string, unknown>) => {
        const item = await create(owner, { projectId: 'default' })
        return start(device, item.id, body)
      },
    }
    const outcomes: Record<string, unknown[]> = {}
    for (const [name, route] of Object.entries(routes)) {
      const seen: unknown[] = []
      seen.push(await errorOf(await route(viewer, {})))
      seen.push(await errorOf(await route(owner, { workspaceId: 'missing' })))
      seen.push(await errorOf(await route(owner, { worktree: true })))
      seen.push(await errorOf(await route(owner, { harnessId: 'nope' })))
      const requested = (await audited(t, 'task.l3.start-requested')).length
      const response = await route(owner, {})
      expect(response.status, name).toBe(201)
      const { sessionId } = (await response.json()) as { sessionId: string }
      const started = await audited(t, 'task.l3.started')
      seen.push((await audited(t, 'task.l3.start-requested')).length - requested)
      seen.push(started.filter(entry => entry.detail.sessionId === sessionId).length)
      // The same session, whichever device asks next, is started from that device's own scope and confirmations.
      seen.push((await route(remote, {})).status)
      outcomes[name] = seen
    }
    expect(outcomes.item).toEqual(outcomes.tasks)
    expect(outcomes.tasks).toEqual([
      { status: 403, error: expect.any(String) },
      { status: 400, error: 'workspace-unavailable' },
      { status: 400, error: 'worktree-project' },
      { status: 409, error: 'harness-unavailable' },
      1,
      1,
      201,
    ])
  })

  it('starts a session into the 待办, moves with it, and answers a retry with the same session', SLOW, async () => {
    const { t, owner } = await fixture()
    const item = await create(owner, { projectId: 'default' })
    const requestId = randomUUID()
    const response = await start(owner, item.id, { requestId })
    expect(response.status).toBe(201)
    const answer = (await response.json()) as WorkItemStartAnswer
    expect(answer.item).toMatchObject({ sessionIds: [answer.sessionId], revision: 2 })
    const { sessionId } = answer
    expect((await audited(t, 'work.item.started')).map(entry => entry.detail)).toEqual([
      { itemId: item.id, requestHash: expect.any(String) },
    ])
    expect((await audited(t, 'work.item.changed')).at(-1)?.detail).toMatchObject({ itemId: item.id, op: 'joined', sessionId, revision: 2 })
    // The session says which 待办 it is in; the 待办 follows its session to 可交付 (the fake agent leaves a file).
    await expect.poll(async () => (await listed(owner, sessionId))?.itemId, SLOW).toBe(item.id)
    await expect.poll(async () => (await items(owner))[0]?.board.group, SLOW).toBe('deliver')
    // A retry starts nothing new; another body under the same request ID is a conflict, and nothing starts either.
    const again = await start(owner, item.id, { requestId, baseRevision: 1 })
    expect(((await again.json()) as WorkItemStartAnswer).sessionId).toBe(sessionId)
    expect(await errorOf(await start(owner, item.id, { requestId, baseRevision: 1, prompt: '别的' }))).toEqual({
      status: 409,
      error: 'request-conflict',
    })
    // A start on what the person saw before the latest change starts nothing.
    expect(await errorOf(await start(owner, item.id, { baseRevision: 1 }))).toEqual({ status: 409, error: 'item-changed' })
    expect((await owner.json<WorkItemAnswer>(`work/items/${item.id}`)).item.sessionIds).toEqual([sessionId])
    // Its prompt is read-only now; marking it done moves it to 已结束, reopening back.
    expect(
      await errorOf(await owner.request(`work/items/${item.id}`, { method: 'PATCH', body: { baseRevision: 2, prompt: '新的' } })),
    ).toEqual({ status: 409, error: 'item-started' })
    const done = await owner.json<WorkItemAnswer>(`work/items/${item.id}`, { method: 'PATCH', body: { baseRevision: 2, closed: true } })
    expect(done.item.board).toEqual({ group: 'done' })
    expect(await errorOf(await start(owner, item.id))).toEqual({ status: 409, error: 'item-closed' })
    // Neither a custom Agent nor a fork nor a plugin page starts from a 待办.
    for (const extra of [{ customAgentId: 'general' }, { forkOf: { taskId: sessionId, upToMessageId: 'm' } }, { via: 'x' }])
      expect(await errorOf(await start(owner, item.id, extra))).toEqual({ status: 400, error: 'invalid-input' })
  })

  it('keeps archived sessions, drops deleted ones, and refuses a session that is already in another 待办', SLOW, async () => {
    const { owner } = await fixture()
    const first = await create(owner, { projectId: 'default' })
    const { sessionId } = (await (await start(owner, first.id)).json()) as WorkItemStartAnswer
    const other = await create(owner, { title: '另一条' })
    expect(await errorOf(await owner.request(`work/items/${other.id}/sessions`, { method: 'POST', body: { sessionId } }))).toEqual({
      status: 409,
      error: 'item-session-taken',
    })
    expect(
      await errorOf(await owner.request(`work/items/${other.id}/sessions`, { method: 'POST', body: { sessionId: 'task-none' } })),
    ).toEqual({ status: 404, error: 'task-not-found' })
    await expect.poll(async () => (await listed(owner, sessionId))?.status, SLOW).toBe('idle')
    await owner.json(`tasks/${sessionId}`, { method: 'PATCH', body: { archived: true } })
    expect((await owner.json<WorkItemAnswer>(`work/items/${first.id}`)).item.sessionIds).toEqual([sessionId])
    // Moved from one 待办 to the other.
    await owner.json(`work/items/${first.id}/sessions/${sessionId}`, { method: 'DELETE' })
    const moved = await owner.json<WorkItemAnswer>(`work/items/${other.id}/sessions`, { method: 'POST', body: { sessionId } })
    expect(moved.item.sessionIds).toEqual([sessionId])
    expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.itemId).toBe(other.id)
    // Deleting the 待办 leaves the session; deleting the session takes it out of its 待办.
    await owner.json(`tasks/${sessionId}`, { method: 'DELETE' })
    await expect.poll(async () => (await owner.json<WorkItemAnswer>(`work/items/${other.id}`)).item.sessionIds).toEqual([])
    expect((await owner.json<WorkItemAnswer>(`work/items/${other.id}`)).item.board).toEqual({ group: 'todo' })
  })

  it('does not start when its audit line cannot be written', SLOW, async () => {
    const { t, owner } = await fixture()
    const item = await create(owner, { projectId: 'default' })
    const append = t.host.security.audit.append.bind(t.host.security.audit)
    vi.spyOn(t.host.security.audit, 'append').mockImplementation(event =>
      event.action === 'work.item.started' ? Promise.reject(new AppError(503, 'audit-unavailable', '审计不可用')) : append(event),
    )
    const before = (await owner.json<AppSnapshot>('snapshot')).tasks.length
    expect(await errorOf(await start(owner, item.id))).toEqual({ status: 503, error: 'audit-unavailable' })
    expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(before)
    expect(await audited(t, 'task.l3.start-requested')).toEqual([])
  })

  it('drops a session that no longer exists once every Harness has listed, at start', SLOW, async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-items-prune-'))
    folders.push(root)
    const directories = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace') }
    await mkdir(join(directories.dataDir, 'work'), { recursive: true, mode: 0o700 })
    await mkdir(directories.workspaceRoot, { recursive: true })
    const at = new Date().toISOString()
    const id = `itm_${'P'.repeat(22)}`
    await writeFile(
      join(directories.dataDir, 'work', 'items.json'),
      JSON.stringify({
        version: 1,
        items: [{ id, title: '旧的', prompt: '', sessionIds: ['task-gone'], startScope: 'all', createdAt: at, updatedAt: at, revision: 1 }],
        receipts: [],
      }),
      { mode: 0o600 },
    )
    const t = await startTestHost(directories)
    hosts.push(t)
    const owner = await t.enroll({ listener: 'unix' })
    await expect.poll(async () => (await items(owner))[0]?.sessionIds, SLOW).toEqual([])
    expect((await items(owner))[0]).toMatchObject({ id, revision: 2, board: { group: 'todo' } })
  })

  it('keeps 待办 and their sessions across a restart', SLOW, async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-items-restart-'))
    folders.push(root)
    const directories = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace') }
    await mkdir(directories.workspaceRoot, { recursive: true })
    const { t, owner } = await fixture(directories)
    const item = await create(owner, { projectId: 'default' })
    const requestId = randomUUID()
    const { sessionId } = (await (await start(owner, item.id, { requestId })).json()) as WorkItemStartAnswer
    await expect.poll(async () => (await listed(owner, sessionId))?.status, SLOW).toBe('idle')
    await t.host.close()
    const again = await startTestHost(directories)
    hosts.push(again)
    const viewer = await again.enroll({ listener: 'unix' })
    await expect.poll(async () => (await items(viewer))[0], SLOW).toMatchObject({ id: item.id, sessionIds: [sessionId] })
    await expect.poll(async () => (await listed(viewer, sessionId))?.itemId, SLOW).toBe(item.id)
  })
})

describe('the data scope of 待办', () => {
  it('never shows a private 待办, its count or its ID to a device that may not read it', SLOW, async () => {
    const { t, owner } = await fixture()
    const item = await create(owner, { projectId: 'default' })
    const { sessionId: secret } = (await (await start(owner, item.id)).json()) as WorkItemStartAnswer
    const open = await create(owner, { title: '公开的', projectId: 'default' })
    const { sessionId: visible } = (await (await start(owner, open.id)).json()) as WorkItemStartAnswer
    await expect.poll(async () => (await listed(owner, secret))?.status, SLOW).toBe('idle')
    await expect.poll(async () => (await listed(owner, visible))?.status, SLOW).toBe('idle')
    // The first 待办's session turns private (as a later turn with 通用's context would make it); the second one's stays
    // visible, then is moved into the private 待办.
    vi.spyOn(t.host.bridge, 'agentPrivate').mockImplementation(id => id === secret)
    await owner.json(`work/items/${open.id}/sessions/${visible}`, { method: 'DELETE' })
    await owner.json(`work/items/${item.id}/sessions`, { method: 'POST', body: { sessionId: visible } })
    expect((await owner.json<WorkItemAnswer>(`work/items/${item.id}`)).item).toMatchObject({ private: true })
    expect((await items(owner)).map(entry => entry.id).toSorted()).toEqual([item.id, open.id].toSorted())

    for (const dataScope of ['work', 'files'] as const) {
      const device = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'], dataScope })
      const snapshot = await device.json<AppSnapshot>('snapshot')
      expect(
        snapshot.items?.map(entry => entry.id),
        dataScope,
      ).toEqual([open.id])
      expect(JSON.stringify(snapshot), dataScope).not.toContain(item.id)
      // The visible session is listed, without the private 待办's ID.
      expect(
        snapshot.tasks.find(task => task.id === visible),
        dataScope,
      ).not.toHaveProperty('itemId')
      expect(JSON.stringify(await device.json<TaskDetail>(`tasks/${visible}`)), dataScope).not.toContain(item.id)
      // Every route answers as for a 待办 that does not exist.
      const missing = `itm_${'Z'.repeat(22)}`
      for (const [path, init] of [
        ['', {}],
        ['', { method: 'PATCH', body: { baseRevision: 1, closed: true } }],
        ['', { method: 'DELETE', body: { baseRevision: 1 } }],
        ['/start', { method: 'POST', body: { requestId: randomUUID(), baseRevision: 1 } }],
        ['/sessions', { method: 'POST', body: { sessionId: visible } }],
        [`/sessions/${visible}`, { method: 'DELETE' }],
      ] as const) {
        const hidden = await device.request(`work/items/${item.id}${path}`, init)
        const absent = await device.request(`work/items/${missing}${path}`, init)
        expect([hidden.status, await hidden.text()], `${dataScope} ${path}`).toEqual([absent.status, await absent.text()])
      }
      // A visible session held by the private 待办 answers as a private session does: nothing says a 待办 holds it.
      const held = await device.request(`work/items/${open.id}/sessions`, { method: 'POST', body: { sessionId: visible } })
      const secretOne = await device.request(`work/items/${open.id}/sessions`, { method: 'POST', body: { sessionId: secret } })
      expect([held.status, await held.text()], dataScope).toEqual([secretOne.status, await secretOne.text()])
      // A private session cannot be added by such a device to a 待办 it can read.
      expect(
        await errorOf(await device.request(`work/items/${open.id}/sessions`, { method: 'POST', body: { sessionId: secret } })),
      ).toEqual({
        status: 403,
        error: 'agent-scope-required',
      })
    }
    // Private for good: the private session leaving does not make it readable again.
    await owner.json(`work/items/${item.id}/sessions/${secret}`, { method: 'DELETE' })
    const work = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'], dataScope: 'work' })
    expect((await items(work)).map(entry => entry.id)).toEqual([open.id])
    const stored = JSON.parse(await readFile(join(t.dataDir, 'work', 'items.json'), 'utf8')) as {
      items: Array<{ id: string; private?: true }>
    }
    expect(stored.items.find(entry => entry.id === item.id)?.private).toBe(true)
  })

  it('stays private when a member that turned private is deleted before anything read the 待办', SLOW, async () => {
    const { t, owner } = await fixture()
    const item = await create(owner, { projectId: 'default' })
    const { sessionId } = (await (await start(owner, item.id)).json()) as WorkItemStartAnswer
    await expect.poll(async () => (await listed(owner, sessionId))?.status, SLOW).toBe('idle')
    vi.spyOn(t.host.bridge, 'agentPrivate').mockImplementation(id => id === sessionId)
    await owner.json(`tasks/${sessionId}`, { method: 'DELETE' })
    await expect.poll(async () => (await owner.json<WorkItemAnswer>(`work/items/${item.id}`)).item.sessionIds).toEqual([])
    const stored = JSON.parse(await readFile(join(t.dataDir, 'work', 'items.json'), 'utf8')) as {
      items: Array<{ id: string; private?: true }>
    }
    expect(stored.items.find(entry => entry.id === item.id)?.private).toBe(true)
    const work = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'], dataScope: 'work' })
    expect(JSON.stringify(await work.json<AppSnapshot>('snapshot'))).not.toContain(item.id)
  })

  it('tells only devices with the full data scope when a private 待办 changes', SLOW, async () => {
    const { t, owner } = await fixture()
    const item = await create(owner, { projectId: 'default' })
    const { sessionId } = (await (await start(owner, item.id)).json()) as WorkItemStartAnswer
    // A visible session in the private 待办, which a narrower device may read and watch.
    const other = await create(owner, { title: '另一条', projectId: 'default' })
    const { sessionId: visible } = (await (await start(owner, other.id)).json()) as WorkItemStartAnswer
    await expect.poll(async () => (await listed(owner, sessionId))?.status, SLOW).toBe('idle')
    await expect.poll(async () => (await listed(owner, visible))?.status, SLOW).toBe('idle')
    await owner.json(`work/items/${other.id}/sessions/${visible}`, { method: 'DELETE' })
    await owner.json(`work/items/${item.id}/sessions`, { method: 'POST', body: { sessionId: visible } })
    vi.spyOn(t.host.bridge, 'agentPrivate').mockImplementation(id => id === sessionId)
    const work = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'], dataScope: 'work' })
    const full = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'], dataScope: 'all' })
    const controller = new AbortController()
    const listen = async (device: TestDevice, session?: string) => {
      const events = await device.request(session ? `events?sessionId=${session}` : 'events', { signal: controller.signal })
      const state = { text: '' }
      const reading = (async () => {
        const reader = events.body!.getReader()
        const decoder = new TextDecoder()
        for (;;) {
          const next = await reader.read()
          if (next.done) return
          state.text += decoder.decode(next.value, { stream: true })
        }
      })().catch(() => {})
      return { state, reading }
    }
    const narrow = await listen(work)
    const watching = await listen(work, visible)
    const wide = await listen(full)
    const refreshes = (text: string) => text.split('event: refresh').length - 1
    const events = (text: string) => text.split('\nevent: ').length - 1
    // Quiet first: the enrolments' own refreshes have gone out.
    await new Promise(done => setTimeout(done, 500))
    const before = [refreshes(narrow.state.text), refreshes(wide.state.text)]
    const watched = events(watching.state.text)
    const revision = (await owner.json<WorkItemAnswer>(`work/items/${item.id}`)).item.revision
    await owner.json(`work/items/${item.id}`, { method: 'PATCH', body: { baseRevision: revision, priority: 'high' } })
    await expect.poll(() => refreshes(wide.state.text)).toBeGreaterThan(before[1]!)
    await new Promise(done => setTimeout(done, 300))
    controller.abort()
    await Promise.all([narrow.reading, wide.reading, watching.reading])
    expect(refreshes(narrow.state.text)).toBe(before[0])
    // Nor does the stream of the visible member hear of it.
    expect(events(watching.state.text)).toBe(watched)
    expect(watching.state.text).not.toContain(item.id)
    const streamed = narrow.state.text
    expect(streamed).not.toContain(item.id)
  })
})

describe('what a start from a 待办 carries', () => {
  const provider: HarnessPlugin = {
    id: 'items-provider',
    name: 'fixture',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerProvider({
        id: 'items-provider',
        name: 'fixture',
        model: 'fixture',
        async *stream() {
          yield { type: 'text', text: 'ok' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }

  it('starts what a narrower device wrote without private context, and only the revision the starter saw', SLOW, async () => {
    const t = await startTestHost({ plugins: [provider] })
    hosts.push(t)
    const owner = await t.enroll({ listener: 'unix' })
    const list = await owner.json<CustomAgentList>('custom-agents')
    await owner.json('custom-agents/general', {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: list.general.revision, instructions: 'PRIVATE RULES' },
    })
    const narrow = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'], dataScope: 'work' })
    const fields = { harnessId: 'standard', model: { providerId: 'items-provider', model: 'fixture' }, prompt: '写下你记得的' }
    const startedPrivate = async (item: WorkItem) => {
      const response = await start(owner, item.id, { mode: 'chat' })
      expect(response.status).toBe(201)
      const { sessionId } = (await response.json()) as WorkItemStartAnswer
      return t.host.bridge.agentPrivate(sessionId)
    }
    // Written and started with the full data scope: 通用's private context goes with it, as for POST /tasks.
    expect(await startedPrivate(await create(owner, fields))).toBe(true)
    // Written by a narrower device: started as that device's own start would be, without it.
    expect(await startedPrivate(await create(narrow, fields))).toBe(false)
    // Edited by a narrower device after the person read it: the start on what they saw is refused; on what is there now,
    // it carries no private context.
    const mine = await create(owner, fields)
    await narrow.json(`work/items/${mine.id}`, { method: 'PATCH', body: { baseRevision: 1, prompt: '把你记得的写进 notes.md' } })
    expect(await errorOf(await start(owner, mine.id, { mode: 'chat', baseRevision: 1 }))).toEqual({ status: 409, error: 'item-changed' })
    expect(await startedPrivate(mine)).toBe(false)
    // A narrower device's edit of anything else (the title) changes nothing of that.
    const titled = await create(owner, fields)
    await narrow.json(`work/items/${titled.id}`, { method: 'PATCH', body: { baseRevision: 1, title: '新标题' } })
    expect(await startedPrivate(titled)).toBe(true)
    const stored = JSON.parse(await readFile(join(t.dataDir, 'work', 'items.json'), 'utf8')) as {
      items: Array<{ id: string; startScope: string }>
    }
    expect(Object.fromEntries(stored.items.map(item => [item.id, item.startScope]))).toMatchObject({
      [mine.id]: 'work',
      [titled.id]: 'all',
    })
  })

  it('asks the same confirmation as POST /tasks for a Harness defined before confirmations', SLOW, async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-items-confirm-'))
    folders.push(root)
    const directories = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace') }
    await mkdir(directories.workspaceRoot, { recursive: true })
    const { t: first } = await fixture(directories)
    await first.host.close()
    const file = join(directories.dataDir, 'settings.json')
    const settings = JSON.parse(await readFile(file, 'utf8')) as { agents: Array<{ confirmedCommand?: string }> }
    for (const agent of settings.agents) delete agent.confirmedCommand
    await writeFile(file, JSON.stringify(settings))
    const t = await startTestHost(directories)
    hosts.push(t)
    const desktop = await t.enroll({ listener: 'unix' })
    const remote = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'], dataScope: 'all' })
    const outcome = async (response: Response) => {
      const body = (await response.json()) as { error?: string; confirmation?: { action?: string } }
      return { status: response.status, error: body.error, action: body.confirmation?.action }
    }
    const item = await create(desktop, { projectId: 'default' })
    const taskBody = { prompt: 'shell-edit', mode: 'agent', harnessId: 'fake', workspaceId: 'default' }
    const itemBody = { mode: 'agent', baseRevision: item.revision }
    const routes = {
      tasks: (device: TestDevice) => device.request('tasks', { method: 'POST', body: { requestId: randomUUID(), ...taskBody } }),
      item: (device: TestDevice) =>
        device.request(`work/items/${item.id}/start`, { method: 'POST', body: { requestId: randomUUID(), ...itemBody } }),
    }
    const outcomes: Record<string, unknown[]> = {}
    for (const [name, route] of Object.entries(routes))
      outcomes[name] = [await outcome(await route(remote)), await outcome(await route(desktop))]
    expect(outcomes.item).toEqual(outcomes.tasks)
    expect(outcomes.tasks).toEqual([
      { status: 409, error: 'harness-unconfirmed', action: undefined },
      { status: 403, error: 'stepup-required', action: 'harness.command.apply' },
    ])
    // Confirmed once through the 待办, it is bound for both.
    const started = await desktop.confirmed(`work/items/${item.id}/start`, {
      method: 'POST',
      body: { requestId: randomUUID(), ...itemBody },
    })
    expect(started.status).toBe(201)
    expect((await routes.tasks(remote)).status).toBe(201)
  })
})
