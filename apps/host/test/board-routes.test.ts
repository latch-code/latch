import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, TaskDetail, TaskSummary } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
const folders: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.close()
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

const SLOW = { timeout: 20_000 }

/** A Host whose start directory is a repository, and one settled `shell-edit` turn that left a file uncommitted. */
async function fixture(directories: { dataDir: string; workspaceRoot: string } | Record<string, never> = {}) {
  const t = await startTestHost(directories)
  hosts.push(t)
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: t.workspaceRoot, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  await writeFile(join(t.workspaceRoot, 'tracked.txt'), 'committed\n')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  const owner = await t.enroll({ listener: 'unix' })
  await owner.confirmedJson('agents', { body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT] } })
  const { sessionId } = await owner.confirmedJson<{ sessionId: string }>('tasks', {
    body: { prompt: 'shell-edit', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
  })
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('idle')
  return { t, owner, sessionId }
}

const listed = async (device: TestDevice, sessionId: string) =>
  (await device.json<AppSnapshot>('snapshot')).tasks.find(task => task.id === sessionId)
const errorOf = async (response: Response) => ({ status: response.status, error: ((await response.json()) as { error: string }).error })
const patch = (device: TestDevice, sessionId: string, body: object) => device.request(`tasks/${sessionId}`, { method: 'PATCH', body })
const attend = (device: TestDevice, sessionId: string, body: object) =>
  device.request(`tasks/${sessionId}/attend`, { method: 'POST', body })

async function audited(t: TestHost, action: string): Promise<Array<{ detail: unknown }>> {
  const log = await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8')
  return log
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { action: string; detail: unknown })
    .filter(entry => entry.action === action)
}

describe('the board place on the Host', () => {
  it('moves a settled session with uncommitted work to 可交付 from the Host’s own read, on every way out', SLOW, async () => {
    const { t, owner, sessionId } = await fixture()
    await expect.poll(async () => (await listed(owner, sessionId))?.board?.group, SLOW).toBe('deliver')
    const summary = (await listed(owner, sessionId))!
    expect(summary.board).toMatchObject({ group: 'deliver', card: true, settle: expect.any(String) })
    expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.board?.group).toBe('deliver')
    expect(
      (await owner.json<{ summary: TaskSummary }>(`tasks/${sessionId}`, { method: 'PATCH', body: { pinned: true } })).summary.board?.group,
    ).toBe('deliver')
    // A device without the project's files sees the group, never what was read.
    const work = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'], dataScope: 'work' })
    expect((await listed(work, sessionId))?.board).toEqual(summary.board)
  })

  it('reads recent idle sessions once at start, so 可交付 is back after a restart without any device asking', SLOW, async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-board-restart-'))
    folders.push(root)
    const directories = { dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace') }
    await mkdir(directories.workspaceRoot, { recursive: true })
    const { t, owner, sessionId } = await fixture(directories)
    await expect.poll(async () => (await listed(owner, sessionId))?.board?.group, SLOW).toBe('deliver')
    await t.host.close()
    const again = await startTestHost(directories)
    hosts.push(again)
    const viewer = await again.enroll({ listener: 'unix' })
    await expect.poll(async () => (await listed(viewer, sessionId))?.board?.group, SLOW).toBe('deliver')
  })

  it('takes tags and a priority from a device that may run, checks them, and leaves updatedAt alone', SLOW, async () => {
    const { t, owner, sessionId } = await fixture()
    const before = (await listed(owner, sessionId))!
    const { summary } = await owner.json<{ summary: TaskSummary }>(`tasks/${sessionId}`, {
      method: 'PATCH',
      body: { tags: [' 前端 ', 'review', '前端'], priority: 'high' },
    })
    expect(summary).toMatchObject({ tags: ['前端', 'review'], priority: 'high', board: expect.any(Object) })
    expect(summary.updatedAt).toBe(before.updatedAt)
    expect(await listed(owner, sessionId)).toMatchObject({ tags: ['前端', 'review'], priority: 'high' })
    for (const [body, error] of [
      [{ tags: Array.from({ length: 9 }, (_, index) => `t${index}`) }, 'tag-limit'],
      [{ tags: ['x'.repeat(25)] }, 'tag-invalid'],
      [{ tags: ['a\nb'] }, 'tag-invalid'],
      [{ tags: ['AKIAABCDEFGHIJKLMNOP'] }, 'tag-secret'],
      [{ priority: 'urgent' }, 'invalid-input'],
      [{}, 'invalid-input'],
    ] as const)
      expect(await errorOf(await patch(owner, sessionId, body)), JSON.stringify(body)).toEqual({ status: 400, error })
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    expect((await patch(viewer, sessionId, { tags: ['x'] })).status).toBe(403)
    const cleared = await owner.json<{ summary: TaskSummary }>(`tasks/${sessionId}`, {
      method: 'PATCH',
      body: { tags: null, priority: 'mid' },
    })
    expect(cleared.summary).not.toHaveProperty('tags')
    expect(cleared.summary).not.toHaveProperty('priority')
  })

  it('records a marker only on the current settlement; checking needs run and an audit line first', SLOW, async () => {
    const { t, owner, sessionId } = await fixture()
    const settle = (await listed(owner, sessionId))!.board!.settle!
    expect(await errorOf(await attend(owner, sessionId, { settle: 'run-before', opened: true }))).toEqual({
      status: 409,
      error: 'attend-stale',
    })
    expect((await attend(owner, sessionId, { settle })).status).toBe(400)
    expect((await attend(owner, sessionId, { settle, opened: true, extra: 1 })).status).toBe(400)
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    expect((await attend(viewer, sessionId, { settle, opened: true })).status).toBe(200)
    expect((await attend(viewer, sessionId, { settle, checked: true })).status).toBe(403)
    expect(await audited(t, 'task.unknown.checked')).toEqual([])
    // The audit cannot be written: nothing is marked.
    const append = t.host.security.audit.append.bind(t.host.security.audit)
    const failing = vi
      .spyOn(t.host.security.audit, 'append')
      .mockImplementation(event =>
        event.action === 'task.unknown.checked' ? Promise.reject(new AppError(503, 'audit-unavailable', '审计不可用')) : append(event),
      )
    expect(await errorOf(await attend(owner, sessionId, { settle, checked: true }))).toEqual({ status: 503, error: 'audit-unavailable' })
    expect(t.host.bridge.attendedOf(sessionId)).toEqual({ settle, opened: true })
    failing.mockRestore()
    expect((await attend(owner, sessionId, { settle, checked: true })).status).toBe(200)
    expect((await attend(owner, sessionId, { settle, checked: true })).status).toBe(200)
    expect(t.host.bridge.attendedOf(sessionId)).toEqual({ settle, opened: true, checked: true })
    // One line for the conclusion, with the session and a count only; the retry wrote none.
    expect((await audited(t, 'task.unknown.checked')).map(entry => entry.detail)).toEqual([{ sessionId, count: 0 }])
    // The next run is a new settlement: checking it is a new conclusion with its own line.
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'again', requestId: randomUUID() } })
    await expect.poll(async () => (await listed(owner, sessionId))?.board?.settle, SLOW).not.toBe(settle)
    await expect.poll(async () => (await listed(owner, sessionId))?.status, SLOW).toBe('idle')
    const next = (await listed(owner, sessionId))!.board!.settle!
    expect((await attend(owner, sessionId, { settle: next, checked: true })).status).toBe(200)
    expect(t.host.bridge.attendedOf(sessionId)).toEqual({ settle: next, checked: true })
    expect(await audited(t, 'task.unknown.checked')).toHaveLength(2)
  })

  it('never shows a private session, its place or its markers to a device that may not read it', SLOW, async () => {
    const { t, owner, sessionId } = await fixture()
    const settle = (await listed(owner, sessionId))!.board!.settle!
    vi.spyOn(t.host.bridge, 'agentPrivate').mockImplementation(id => id === sessionId)
    for (const dataScope of ['work', 'files'] as const) {
      const device = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'], dataScope })
      const snapshot = await device.json<AppSnapshot>('snapshot')
      expect(
        snapshot.tasks.some(task => task.id === sessionId),
        dataScope,
      ).toBe(false)
      expect(JSON.stringify(snapshot), dataScope).not.toContain(settle)
      for (const response of [
        await patch(device, sessionId, { tags: ['x'] }),
        await patch(device, sessionId, { priority: 'high' }),
        await patch(device, sessionId, { pinned: true }),
        await attend(device, sessionId, { settle, opened: true }),
        await attend(device, sessionId, { settle, checked: true }),
      ]) {
        const text = await response.text()
        expect(response.status, dataScope).toBe(403)
        expect(text).not.toContain(settle)
      }
    }
    expect(t.host.bridge.attendedOf(sessionId)).toBeUndefined()
    // The owner, with the full data scope, still sees it and its place.
    expect((await listed(owner, sessionId))?.board).toMatchObject({ settle })
  })
})
