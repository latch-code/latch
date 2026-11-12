import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitPrResult, GitPrState, GitDeliveryState, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, installFakeGh, type FakeGh, type TestDevice } from '@latch/testkit'
import { AuditLog } from '../src/audit.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.close()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const SLOW = { timeout: 20_000 }

/** A Host whose start directory is a repository, and one settled `shell-edit` turn of the fake agent there. */
async function fixture(options: { gh?: (scratch: string) => Promise<FakeGh> } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'latch-git-routes-'))
  cleanups.push(() => rm(scratch, { recursive: true, force: true }))
  const home = join(scratch, 'home')
  await mkdir(home)
  const gh = await options.gh?.(scratch)
  const t = await startTestHost({
    gitDelivery: {
      home,
      hostEnv: { HOME: home, USER: 'tester', PATH: '/usr/bin:/bin', TMPDIR: scratch, GH_TOKEN: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      shell: gh ? gh.shell : async () => ({ file: '/bin/sh', argv: ['-sh'] }),
    },
  })
  hosts.push(t)
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: t.workspaceRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString('utf8')
      .trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Tester')
  git('config', 'user.email', 'tester@example.invalid')
  await writeFile(join(t.workspaceRoot, 'tracked.txt'), 'committed\n')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  const owner = await t.enroll({ listener: 'unix' })
  const saved = await owner.confirmed('agents', {
    method: 'POST',
    body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT] },
  })
  expect(saved.status).toBe(201)
  const created = await owner.confirmed('tasks', {
    method: 'POST',
    body: { prompt: 'shell-edit', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
  })
  expect(created.status).toBe(201)
  const { sessionId } = (await created.json()) as { sessionId: string }
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('idle')
  const path = `tasks/${sessionId}/git`
  return { t, owner, sessionId, path, git, scratch }
}

async function audited(t: TestHost): Promise<string[]> {
  const log = await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8')
  return log
    .trim()
    .split('\n')
    .map(line => (JSON.parse(line) as { action: string }).action)
    .filter(action => action.startsWith('git.'))
}

const errorOf = async (response: Response) => ({ status: response.status, error: ((await response.json()) as { error: string }).error })
const post = (device: TestDevice, path: string, body: object) => device.request(path, { method: 'POST', body })

describe('git delivery routes', () => {
  it('announces the feature, lists the status and stages and commits with the audit record first', SLOW, async () => {
    const { t, owner, path, git } = await fixture()
    const snapshot = await owner.json<{ catalog: { features: { gitDelivery?: true } } }>('snapshot')
    expect(snapshot.catalog.features.gitDelivery).toBe(true)
    const state = await owner.json<GitDeliveryState>(path)
    expect(state).toMatchObject({ branch: 'main', staged: [], untracked: ['agent-edit.txt', 'command-edit.txt'], filters: false })
    expect(await owner.json(`${path}/stage`, { method: 'POST', body: { requestId: randomUUID(), paths: ['agent-edit.txt'] } })).toEqual({
      files: 1,
    })
    const commit = await owner.json<{ commit: string }>(`${path}/commit`, {
      method: 'POST',
      body: { requestId: randomUUID(), message: 'add the agent edit' },
    })
    expect(commit.commit).toBe(git('rev-parse', 'HEAD'))
    expect(await audited(t)).toEqual(['git.stage', 'git.result', 'git.commit', 'git.result'])
    expect(await errorOf(await post(owner, `${path}/push`, { requestId: randomUUID() }))).toEqual({ status: 409, error: 'git-no-remote' })
    expect(await errorOf(await post(owner, `${path}/push`, { requestId: randomUUID(), url: 'https://example.invalid/x.git' }))).toEqual({
      status: 400,
      error: 'invalid-input',
    })
  })

  it('needs run to write, full data scope for files, and full data scope for a private session', SLOW, async () => {
    const { t, path, sessionId } = await fixture()
    const widen = (device: TestDevice) =>
      t.host.security.devices.setScopes(device.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    await widen(viewer)
    expect((await viewer.request(path)).status).toBe(200)
    expect(await errorOf(await post(viewer, `${path}/commit`, { requestId: randomUUID(), message: 'm' }))).toEqual({
      status: 403,
      error: 'scope-required',
    })
    const phone = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'] })
    // Files of the session's folder are for devices that may browse it; a commit or a push names none.
    expect(await errorOf(await phone.request(path))).toEqual({ status: 403, error: 'file-scope' })
    expect(await errorOf(await post(phone, `${path}/stage`, { requestId: randomUUID(), paths: ['agent-edit.txt'] }))).toEqual({
      status: 403,
      error: 'file-scope',
    })
    expect(await errorOf(await post(phone, `${path}/commit`, { requestId: randomUUID(), message: 'm' }))).toEqual({
      status: 409,
      error: 'git-nothing-staged',
    })
    vi.spyOn(t.host.bridge, 'agentPrivate').mockImplementation(id => id === sessionId)
    expect(await errorOf(await post(phone, `${path}/commit`, { requestId: randomUUID(), message: 'm' }))).toEqual({
      status: 403,
      error: 'agent-scope-required',
    })
    expect(await errorOf(await post(phone, `${path}/push`, { requestId: randomUUID() }))).toEqual({
      status: 403,
      error: 'agent-scope-required',
    })
    await widen(phone)
    expect(await errorOf(await post(phone, `${path}/push`, { requestId: randomUUID() }))).toEqual({ status: 409, error: 'git-no-remote' })
    expect(await audited(t)).toEqual([])
  })

  it('runs nothing when the audit record cannot be written', SLOW, async () => {
    const { owner, path, git } = await fixture()
    git('add', 'agent-edit.txt')
    const head = git('rev-parse', 'HEAD')
    vi.spyOn(AuditLog.prototype, 'append').mockRejectedValue(new Error('disk full'))
    expect((await post(owner, `${path}/stage`, { requestId: randomUUID(), paths: ['command-edit.txt'] })).status).toBeGreaterThanOrEqual(
      500,
    )
    expect((await post(owner, `${path}/commit`, { requestId: randomUUID(), message: 'm' })).status).toBeGreaterThanOrEqual(500)
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(git('diff', '--cached', '--name-only')).toBe('agent-edit.txt')
  })

  it('refuses to stage or commit while a turn runs in the folder, and every write during a merge', SLOW, async () => {
    const { t, owner, path, sessionId, git } = await fixture()
    const merge = join(t.workspaceRoot, '.git', 'MERGE_HEAD')
    await writeFile(merge, `${git('rev-parse', 'HEAD')}\n`)
    expect((await owner.json<GitDeliveryState>(path)).gitOperation).toBe('merge')
    expect(await errorOf(await post(owner, `${path}/stage`, { requestId: randomUUID(), paths: ['agent-edit.txt'] }))).toEqual({
      status: 409,
      error: 'git-operation-in-progress',
    })
    await rm(merge)

    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'hang', requestId: randomUUID() } })
    await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, SLOW).toBe('running')
    expect(await errorOf(await post(owner, `${path}/stage`, { requestId: randomUUID(), paths: ['agent-edit.txt'] }))).toEqual({
      status: 409,
      error: 'git-turn-running',
    })
    git('add', 'agent-edit.txt')
    expect(await errorOf(await post(owner, `${path}/commit`, { requestId: randomUUID(), message: 'm' }))).toEqual({
      status: 409,
      error: 'git-turn-running',
    })
    // A push changes no file here.
    expect(await errorOf(await post(owner, `${path}/push`, { requestId: randomUUID() }))).toEqual({ status: 409, error: 'git-no-remote' })
    expect(await audited(t)).toEqual([])
  })

  it(
    'reads and creates the pull request through your gh: view to read, full scope for logs, run and the audit to create',
    SLOW,
    async () => {
      let gh: FakeGh | undefined
      const { t, owner, path, git, scratch } = await fixture({
        gh: async scratch => (gh = await installFakeGh(join(scratch, 'gh'))),
      })
      const bare = join(scratch, 'remote.git')
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
      git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
      git('config', 'remote.origin.pushurl', bare)
      git('push', '-q', '-u', 'origin', 'main')
      git('switch', '-q', '-c', 'feature')
      git('commit', '-q', '--allow-empty', '-m', 'Add the currency filter')
      expect(await errorOf(await post(owner, `${path}/pr`, { requestId: randomUUID(), title: 'T', body: '', base: 'main' }))).toEqual({
        status: 409,
        error: 'pr-not-pushed',
      })
      git('push', '-q', '-u', 'origin', 'feature')

      const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
      expect(await viewer.json<GitPrState>(`${path}/pr`)).toEqual({ checks: [], draft: { base: 'main' } })
      expect(await owner.json<GitPrState>(`${path}/pr`)).toEqual({ checks: [], draft: { title: 'Add the currency filter', base: 'main' } })
      expect(await errorOf(await post(viewer, `${path}/pr`, { requestId: randomUUID(), title: 'T', body: '', base: 'main' }))).toEqual({
        status: 403,
        error: 'scope-required',
      })
      const made = await owner.json<GitPrResult>(`${path}/pr`, {
        method: 'POST',
        body: { requestId: randomUUID(), title: 'Add the currency filter', body: 'Body', base: 'main', draft: true },
      })
      expect(made.pr).toEqual({ number: 1, url: 'https://github.com/acme/widgets/pull/1', base: 'main', head: 'feature' })
      expect(await audited(t)).toEqual(['git.pr.create', 'git.result'])
      const meta = JSON.parse(await readFile(join(t.dataDir, 'sessions-meta.json'), 'utf8')) as { sessions: Array<{ pr?: unknown }> }
      expect(meta.sessions.find(session => session.pr)?.pr).toEqual(made.pr)
      expect((await viewer.json<GitPrState>(`${path}/pr`)).pr).toMatchObject({ number: 1, draft: true, state: 'open' })

      await gh!.update(state => {
        state.prs[0]!.statusCheckRollup = [
          {
            __typename: 'CheckRun',
            name: 'test',
            status: 'COMPLETED',
            conclusion: 'FAILURE',
            detailsUrl: 'https://github.com/acme/widgets/actions/runs/7/job/42',
          },
        ]
        state.logs['42'] = 'test\tRun\t2026-11-12T10:00:00Z FAIL'
      })
      expect(await errorOf(await viewer.request(`${path}/pr/checks/42/log`))).toEqual({ status: 403, error: 'file-scope' })
      expect(await owner.json(`${path}/pr/checks/42/log`)).toEqual({ name: 'test', text: '[Run]\nFAIL' })

      // While an update installs, no write starts your gh.
      const calls = (await gh!.calls()).length
      expect((await owner.request('host/update-window', { method: 'POST', body: { open: true } })).status).toBe(200)
      expect((await owner.request('host/update-window/commit', { method: 'POST', body: {} })).status).toBe(200)
      expect(await errorOf(await post(owner, `${path}/pr`, { requestId: randomUUID(), title: 'T', body: '', base: 'main' }))).toEqual({
        status: 409,
        error: 'host-updating',
      })
      expect((await gh!.calls()).length).toBe(calls)
      expect(await gh!.violations()).toEqual([])
    },
  )
})
