import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BranchListing, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { AuditLog } from '../src/audit.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.close()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const SLOW = { timeout: 30_000 }
const LONG = 'fix/studio-sidebar-history-scroll'

/** A Host with a saved project that is a repository on `main` with two more branches, and one settled session in it. */
async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), 'latch-branch-routes-'))
  cleanups.push(() => rm(scratch, { recursive: true, force: true }))
  const home = join(scratch, 'home')
  await mkdir(home)
  const t = await startTestHost({ gitDelivery: { home, hostEnv: { HOME: home, USER: 'tester', PATH: '/usr/bin:/bin', TMPDIR: scratch } } })
  hosts.push(t)
  const project = join(t.root, 'studio')
  await mkdir(project)
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString('utf8')
      .trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Tester')
  git('config', 'user.email', 'tester@example.invalid')
  await writeFile(join(project, 'README.md'), '# studio\n')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  git('branch', LONG)
  git('switch', '-q', '-c', 'feature/one')
  await writeFile(join(project, 'feature.txt'), 'f\n')
  git('add', '.')
  git('commit', '-q', '-m', 'feature')
  git('switch', '-q', 'main')
  const owner = await t.enroll({ listener: 'unix' })
  expect((await owner.addFolders({ paths: [project] })).ok).toBe(true)
  const workspaceId = (await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces.find(item =>
    item.path.endsWith('/studio'),
  )!.id
  expect(
    (
      await owner.confirmed('agents', {
        method: 'POST',
        body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT] },
      })
    ).status,
  ).toBe(201)
  const created = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { prompt: 'plan', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId },
  })
  const sessionId = created.sessionId
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('idle')
  const path = `workspaces/${encodeURIComponent(workspaceId)}/branches`
  return { t, owner, project, workspaceId, sessionId, path, git }
}

async function audits(t: TestHost): Promise<Array<{ action: string; detail: Record<string, unknown> }>> {
  const log = await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8')
  return log
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { action: string; detail: Record<string, unknown> })
    .filter(entry => entry.action.startsWith('git.switch'))
}

const errorOf = async (response: Response) => ({ status: response.status, error: ((await response.json()) as { error: string }).error })
const switchTo = (device: TestDevice, path: string, branch: string, requestId = randomUUID()) =>
  device.request(`${path}/switch`, { method: 'POST', body: { requestId, branch } })

describe('branch routes', () => {
  it('lists for a device that may read the project’s files, and switches for one that may also run', SLOW, async () => {
    const { t, owner, path, workspaceId, sessionId, git } = await fixture()
    expect((await owner.json<{ catalog: { features: Record<string, unknown> } }>('snapshot')).catalog.features.branchSwitch).toBe(true)
    const listing = await owner.json<BranchListing>(path)
    expect(listing).toEqual({ current: 'main', branches: [{ name: 'main' }, { name: 'feature/one' }, { name: LONG }] })

    // A phone on the network with run and the project's files: the same as a pull.
    const phone = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'] })
    await t.host.security.devices.setScopes(phone.id, { dataScope: 'files' }, { listener: 'unix' }, 'lpc-local')
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    await t.host.security.devices.setScopes(viewer.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
    const narrow = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'], dataScope: 'work' })
    expect((await viewer.json<BranchListing>(path)).branches).toHaveLength(3)
    expect(await errorOf(await narrow.request(path))).toEqual({ status: 403, error: 'file-scope' })
    expect(await errorOf(await switchTo(narrow, path, 'feature/one'))).toEqual({ status: 403, error: 'file-scope' })
    expect((await switchTo(viewer, path, 'feature/one')).status).toBe(403)
    expect((await t.raw('loopback-tcp', `api/${path}`)).status).toBe(401)
    expect(await errorOf(await owner.request('workspaces/default/branches'))).toEqual({ status: 404, error: 'workspace-not-found' })
    expect(await errorOf(await switchTo(phone, path, '-x'))).toEqual({ status: 409, error: 'branch-switch-unknown' })
    expect(
      (await phone.request(`${path}/switch`, { method: 'POST', body: { requestId: randomUUID(), branch: 'main', force: true } })).status,
    ).toBe(400)
    expect(await audits(t)).toEqual([])

    const requestId = randomUUID()
    const switched = await phone.json<{ branch: string; head: string }>(`${path}/switch`, {
      method: 'POST',
      body: { requestId, branch: 'feature/one' },
    })
    expect(switched).toEqual({ branch: 'feature/one', head: git('rev-parse', 'HEAD') })
    expect(git('branch', '--show-current')).toBe('feature/one')
    expect(await phone.json(`${path}/switch`, { method: 'POST', body: { requestId, branch: 'feature/one' } })).toEqual({
      ...switched,
      replay: true,
    })
    const recorded = await audits(t)
    expect(recorded.map(entry => entry.action)).toEqual(['git.switch', 'git.switch.result'])
    expect(recorded[0]!.detail).toEqual({
      workspaceId,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      fromHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      toHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      preHead: expect.any(String),
    })
    expect(recorded[1]!.detail).toMatchObject({ outcome: 'done', head: switched.head })
    expect(JSON.stringify(recorded)).not.toContain('feature')

    // The project and its idle session now say the new branch, without waiting for the cache's 30 seconds.
    await expect
      .poll(
        async () =>
          (await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces.find(item => item.id === workspaceId)?.branch,
      )
      .toBe('feature/one')
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.branch).toBe('feature/one')
    expect((await owner.json<BranchListing>(path)).branches[0]).toEqual({ name: 'feature/one' })
  })

  it('waits for a session in the folder that runs or waits for approval, and holds new turns while it switches', SLOW, async () => {
    const { t, owner, path, sessionId, git } = await fixture()
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'permission', requestId: randomUUID() } })
    await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, SLOW).toBe('waiting-approval')
    expect(await errorOf(await switchTo(owner, path, 'feature/one'))).toEqual({ status: 409, error: 'branch-switch-turn-running' })
    await owner.json(`tasks/${sessionId}/cancel`, { method: 'POST', body: {} })
    await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, SLOW).not.toBe('waiting-approval')
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'hang', requestId: randomUUID() } })
    await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, SLOW).toBe('running')
    expect(await errorOf(await switchTo(owner, path, 'feature/one'))).toEqual({ status: 409, error: 'branch-switch-turn-running' })
    await owner.json(`tasks/${sessionId}/cancel`, { method: 'POST', body: {} })
    await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, SLOW).not.toBe('running')
    expect(git('branch', '--show-current')).toBe('main')
    expect(await audits(t)).toEqual([])

    // While the switch is recorded (and then runs), a new turn in that folder is refused.
    const append = AuditLog.prototype.append
    let release: () => void = () => {}
    const recording = new Promise<void>(done => {
      release = done
    })
    let reached: () => void = () => {}
    const atAudit = new Promise<void>(done => {
      reached = done
    })
    vi.spyOn(AuditLog.prototype, 'append').mockImplementation(async function (this: AuditLog, event) {
      if (event.action === 'git.switch') {
        reached()
        await recording
      }
      return append.call(this, event)
    })
    const switching = switchTo(owner, path, 'feature/one')
    await atAudit
    expect(
      await errorOf(
        await owner.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'plan', requestId: randomUUID() } }),
      ),
    ).toEqual({
      status: 409,
      error: 'branch-switching',
    })
    release()
    expect((await switching).status).toBe(200)
    expect(git('branch', '--show-current')).toBe('feature/one')
    expect(
      (await owner.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'plan', requestId: randomUUID() } })).status,
    ).toBeLessThan(300)
  })

  it('answers a retry of a switch that landed even while a turn now runs there', SLOW, async () => {
    const { t, owner, path, sessionId, git } = await fixture()
    const requestId = randomUUID()
    const first = await owner.json<{ branch: string; head: string }>(`${path}/switch`, {
      method: 'POST',
      body: { requestId, branch: 'feature/one' },
    })
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'hang', requestId: randomUUID() } })
    await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, SLOW).toBe('running')
    expect(await owner.json(`${path}/switch`, { method: 'POST', body: { requestId, branch: 'feature/one' } })).toEqual({
      ...first,
      replay: true,
    })
    // A new request to go elsewhere waits for the turn.
    expect(await errorOf(await switchTo(owner, path, 'main'))).toEqual({ status: 409, error: 'branch-switch-turn-running' })
    expect(git('branch', '--show-current')).toBe('feature/one')
    await owner.json(`tasks/${sessionId}/cancel`, { method: 'POST', body: {} })
  })

  it('runs nothing when the audit record cannot be written', SLOW, async () => {
    const { owner, path, git } = await fixture()
    vi.spyOn(AuditLog.prototype, 'append').mockRejectedValue(new Error('disk full'))
    expect((await switchTo(owner, path, 'feature/one')).status).toBeGreaterThanOrEqual(500)
    expect(git('branch', '--show-current')).toBe('main')
  })

  it('never switches a worktree Latch made, whose branch is its session’s', SLOW, async () => {
    const { t, owner, workspaceId } = await fixture()
    const started = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'plan', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId, worktree: true },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${started.sessionId}`)).summary.status, SLOW).toBe('idle')
    const cwd = (await owner.json<TaskDetail>(`tasks/${started.sessionId}`)).summary.cwd!
    // Added as a project of its own: still the session's worktree, never switched from here.
    expect((await owner.addFolders({ paths: [cwd] })).ok).toBe(true)
    const id = (await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces.find(item => item.path === cwd)!.id
    const before = execFileSync('git', ['branch', '--show-current'], { cwd }).toString('utf8').trim()
    expect(await errorOf(await switchTo(owner, `workspaces/${encodeURIComponent(id)}/branches`, 'main'))).toEqual({
      status: 409,
      error: 'branch-switch-worktree',
    })
    expect(execFileSync('git', ['branch', '--show-current'], { cwd }).toString('utf8').trim()).toBe(before)
    expect(await audits(t)).toEqual([])
  })
})
