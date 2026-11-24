import { promisify } from 'node:util'
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BranchListing,
  GitCloneState,
  GitCommitDiff,
  GitCommitFileDiff,
  GitDeliveryState,
  GitHistory,
  GitHunkDiff,
  GitPrResult,
  GitPrState,
  TaskDetail,
  WorkbenchDelivery,
} from '@latch/protocol'
import { FAKE_ACP_AGENT, installFakeGh, type FakeGh, type TestDevice } from '@latch/testkit'
import { AuditLog } from '../src/audit.ts'
import { findGit } from '../src/changes/git.ts'
import { HarnessHub } from '../src/hub.ts'
import { GitDelivery } from '../src/git-delivery.ts'
import { installFakeSsh } from './helpers/fake-ssh.ts'
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
async function fixture(
  options: {
    gh?: (scratch: string) => Promise<FakeGh>
    rateLimits?: 'default'
    registerPoll?: (fn: () => Promise<void>) => void
    builtin?: boolean
  } = {},
) {
  const scratch = await mkdtemp(join(tmpdir(), 'latch-git-routes-'))
  cleanups.push(() => rm(scratch, { recursive: true, force: true }))
  const home = join(scratch, 'home')
  await mkdir(home)
  const gh = await options.gh?.(scratch)
  const t = await startTestHost({
    ...(options.rateLimits ? { rateLimits: options.rateLimits } : {}),
    worktreesDir: join(scratch, 'worktrees'),
    gitDelivery: {
      ...(options.registerPoll ? { registerPoll: options.registerPoll } : {}),
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
    body: {
      prompt: options.builtin ? 'hello' : 'shell-edit',
      requestId: randomUUID(),
      mode: 'agent',
      harnessId: options.builtin ? 'standard' : 'fake',
      workspaceId: 'default',
    },
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
  it('reads only requested workbench repositories, without file names, remote probes or write authority', SLOW, async () => {
    let gh: FakeGh | undefined
    const { t, owner, sessionId } = await fixture({ gh: async scratch => (gh = await installFakeGh(scratch)) })
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    await t.host.security.devices.setScopes(viewer.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
    const result = await viewer.json<WorkbenchDelivery>('workbench/delivery', {
      method: 'POST',
      body: { ids: [sessionId, 'missing', sessionId] },
    })
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]).toMatchObject({ sessionId, state: { branch: 'main', files: 2, untracked: 2 } })
    expect(result.entries[0]?.pr).toBeUndefined()
    expect(result.entries[1]?.error?.code).toBe('task-not-found')
    expect(JSON.stringify(result)).not.toContain('agent-edit.txt')
    expect(await gh!.calls()).toEqual([])
    expect(await audited(t)).toEqual([])
    expect((await post(owner, 'workbench/delivery', { ids: Array.from({ length: 13 }, () => sessionId) })).status).toBe(400)
    expect((await post(owner, 'workbench/delivery', { ids: [sessionId], extra: true })).status).toBe(400)
    const narrow = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'], dataScope: 'work' })
    expect(await errorOf(await post(narrow, 'workbench/delivery', { ids: [sessionId] }))).toEqual({ status: 403, error: 'file-scope' })
    expect((await t.raw('loopback-tcp', 'api/workbench/delivery', { method: 'POST', body: { ids: [sessionId] } })).status).toBe(401)
  })

  it('rechecks data scope after slow workbench reads before returning any evidence', SLOW, async () => {
    const { t, sessionId } = await fixture()
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    await t.host.security.devices.setScopes(viewer.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
    // The board reads the settled session in the background, and a device's read of the same folder joins a read in
    // flight: one full read first, so the read held below is this request's own.
    expect((await post(viewer, 'workbench/delivery', { ids: [sessionId] })).status).toBe(200)
    const original = GitDelivery.prototype.state
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const read = vi.spyOn(GitDelivery.prototype, 'state').mockImplementation(async function (this: GitDelivery, folder) {
      const result = await original.call(this, folder)
      await gate
      return result
    })
    const request = post(viewer, 'workbench/delivery', { ids: [sessionId] })
    // The route reaches the read after its own Git calls, which take more than poll's default second on a busy machine.
    await expect.poll(() => read.mock.calls.length, { timeout: 10_000 }).toBe(1)
    await t.host.security.devices.setScopes(viewer.id, { dataScope: 'work' }, { listener: 'unix' }, 'lpc-local')
    release()
    expect(await errorOf(await request)).toEqual({ status: 403, error: 'file-scope' })
  })

  it('stages by line for a device that may stage files, and gives a work-scope device no line, name or subject', SLOW, async () => {
    const { t, owner, path, git } = await fixture()
    const snapshot = await owner.json<{ catalog: { features: { gitHunks?: true } } }>('snapshot')
    expect(snapshot.catalog.features.gitHunks).toBe(true)
    await writeFile(join(t.workspaceRoot, 'tracked.txt'), 'committed\nsecond\nthird\n')
    const query = `${path}/diff?view=unstaged&path=tracked.txt`
    const diff = await owner.json<GitHunkDiff>(query)
    expect(diff).toMatchObject({ view: 'unstaged', path: 'tracked.txt', add: 2, del: 0 })
    const body = { requestId: randomUUID(), path: 'tracked.txt', base: diff.base, new: [[2, 2]] }
    // Patch text, or anything else beside the line numbers, is not a request.
    expect((await post(owner, `${path}/stage-lines`, { ...body, patch: '@@ -1 +1,2 @@' })).status).toBe(400)
    expect((await post(owner, `${path}/stage-lines`, { ...body, new: [[2, 'x']] })).status).toBe(400)
    expect((await owner.request(`${path}/diff?view=other&path=tracked.txt`)).status).toBe(400)
    expect(await audited(t)).toEqual([])
    expect(await owner.json(`${path}/stage-lines`, { method: 'POST', body })).toEqual({ lines: 1 })
    expect(git('show', ':tracked.txt')).toBe('committed\nsecond')
    expect(await audited(t)).toEqual(['git.stage', 'git.result'])
    const staged = await owner.json<GitHunkDiff>(`${path}/diff?view=staged&path=tracked.txt`)
    expect(
      await owner.json(`${path}/unstage-lines`, {
        method: 'POST',
        body: { requestId: randomUUID(), path: 'tracked.txt', base: staged.base, new: [[2, 2]] },
      }),
    ).toEqual({ lines: 1 })
    expect(git('diff', '--cached', '--name-only')).toBe('')
    // A stale request is told what changed.
    const stale = await post(owner, `${path}/stage-lines`, {
      ...body,
      requestId: randomUUID(),
      base: { ...diff.base, worktree: 'a'.repeat(64) },
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: 'git-file-changed', changed: 'worktree' })
    git('add', 'tracked.txt')
    git('commit', '-q', '-m', 'private subject')
    const sha = git('rev-parse', 'HEAD')
    // A device with `view` and the files reads history but stages nothing.
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    await t.host.security.devices.setScopes(viewer.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
    expect((await post(viewer, `${path}/stage-lines`, body)).status).toBe(403)
    const full = await viewer.json<GitHistory>(`${path}/history`)
    expect(full.commits[0]).toMatchObject({ sha, subject: 'private subject' })
    expect((await viewer.json<GitCommitDiff>(`${path}/history/${sha}`)).files).toEqual([
      { path: 'tracked.txt', status: 'M', add: 2, del: 0 },
    ])
    expect((await viewer.request(`${path}/history/${sha}?path=tracked.txt`)).status).toBe(200)
    expect(await errorOf(await viewer.request(`${path}/compare`))).toEqual({ status: 409, error: 'git-no-base' })
    // Data scope `work`: history names commits and files, so none of it is for this device. A commit ID it guesses is
    // answered like one that does not exist.
    const narrow = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'], dataScope: 'work' })
    for (const refused of [
      `${path}/history`,
      `${path}/history/${sha}`,
      `${path}/history/${'0'.repeat(40)}`,
      `${path}/compare`,
      `${path}/history?path=tracked.txt`,
      `${path}/history/${sha}?path=tracked.txt`,
      `${path}/compare?path=tracked.txt`,
      `${path}/diff?view=unstaged&path=tracked.txt`,
    ]) {
      const response = await narrow.request(refused)
      const text = await response.text()
      expect({ status: response.status, error: (JSON.parse(text) as { error: string }).error }, refused).toEqual({
        status: 403,
        error: 'file-scope',
      })
      expect(text).not.toContain(sha)
      expect(text).not.toContain('private subject')
    }
    expect(await errorOf(await post(narrow, `${path}/stage-lines`, body))).toEqual({ status: 403, error: 'file-scope' })
    expect((await t.raw('loopback-tcp', `api/${path}/history`)).status).toBe(401)
  })

  it('takes only rising, disjoint, bounded line ranges, and keeps a private session private on the new routes', SLOW, async () => {
    const { t, owner, sessionId, path, git } = await fixture()
    await writeFile(join(t.workspaceRoot, 'tracked.txt'), 'committed\nsecond\nthird\n')
    const diff = await owner.json<GitHunkDiff>(`${path}/diff?view=unstaged&path=tracked.txt`)
    const body = (lines: unknown) => ({ requestId: randomUUID(), path: 'tracked.txt', base: diff.base, new: lines })
    for (const lines of [
      [
        [3, 3],
        [2, 2],
      ],
      [
        [2, 3],
        [3, 3],
      ],
      [[3, 2]],
      [[1, 20_001]],
      [[1, 9_000_000]],
      Array.from({ length: 501 }, (_, index) => [index * 2 + 1, index * 2 + 1]),
    ])
      expect((await post(owner, `${path}/stage-lines`, body(lines))).status, JSON.stringify(lines).slice(0, 40)).toBe(400)
    expect(await audited(t)).toEqual([])
    expect(git('diff', '--cached', '--name-only')).toBe('')
    // A private session's routes need the full data scope here too.
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'] })
    vi.spyOn(t.host.bridge, 'agentPrivate').mockImplementation(id => id === sessionId)
    for (const refused of [`${path}/history`, `${path}/compare`, `${path}/diff?view=staged&path=tracked.txt`])
      expect((await viewer.request(refused)).status, refused).toBe(403)
    expect((await post(viewer, `${path}/unstage-lines`, body([[2, 2]]))).status).toBe(403)
    expect((await owner.request(`${path}/history`)).status).toBe(200)
  })

  it('keeps automatic comparison and history at file scope and requires full access to choose a base', SLOW, async () => {
    const { t, owner, path, git } = await fixture()
    const main = git('rev-parse', 'HEAD')
    git('switch', '-qc', 'topic')
    await writeFile(join(t.workspaceRoot, 'tracked.txt'), 'committed\nnew line\n')
    git('commit', '-qam', 'topic change')
    const head = git('rev-parse', 'HEAD')
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'], dataScope: 'files' })
    expect((await viewer.json<GitHistory>(`${path}/history`)).commits.map(commit => commit.sha)).toEqual([head])
    expect(await viewer.json<GitCommitDiff>(`${path}/compare`)).toMatchObject({ sha: head, parent: main })
    expect(await viewer.json<GitCommitFileDiff>(`${path}/compare?path=tracked.txt`)).toMatchObject({
      file: { path: 'tracked.txt', add: 1 },
    })

    const choices = `${path}/compare-branches`
    expect(await errorOf(await viewer.request(choices))).toEqual({ status: 403, error: 'git-compare-scope' })
    expect((await owner.json<BranchListing>(choices)).branches).toContainEqual(expect.objectContaining({ name: 'main' }))
    for (const base of ['main', main]) {
      const compare = `${path}/compare?base=${base}`
      const file = `${compare}&path=tracked.txt`
      expect(await errorOf(await viewer.request(compare))).toEqual({ status: 403, error: 'git-compare-scope' })
      expect(await errorOf(await viewer.request(file))).toEqual({ status: 403, error: 'git-compare-scope' })
      expect(await owner.json<GitCommitDiff>(compare)).toMatchObject({ sha: head, parent: main, base })
      expect(await owner.json<GitCommitFileDiff>(file)).toMatchObject({ sha: head, parent: main, file: { path: 'tracked.txt', add: 1 } })
    }
  })

  it('checks full data access again before returning a custom comparison or its error', SLOW, async () => {
    const { t, path } = await fixture()
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    for (const [method, url] of [
      ['comparisonBranches', `${path}/compare-branches`],
      ['treeDiff', `${path}/compare?base=main`],
      ['treeFile', `${path}/compare?base=missing&path=tracked.txt`],
    ] as const) {
      await t.host.security.devices.setScopes(viewer.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
      let release!: () => void
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      const read = vi.spyOn(GitDelivery.prototype, method).mockImplementation(async () => {
        await gate
        if (method === 'treeFile') throw new Error('comparison read failed')
        return { branches: [{ name: 'main' }], files: [] } as never
      })
      const request = viewer.request(url)
      try {
        await expect.poll(() => read.mock.calls.length).toBe(1)
        await t.host.security.devices.setScopes(viewer.id, { dataScope: 'files' }, { listener: 'unix' }, 'lpc-local')
      } finally {
        release()
      }
      expect(await errorOf(await request), method).toEqual({ status: 403, error: 'git-compare-scope' })
      read.mockRestore()
    }
  })

  it('counts the new routes against the device limits before anything is read or run', SLOW, async () => {
    const { t, owner, path, git } = await fixture({ rateLimits: 'default' })
    // Writes by the action limit, reads by the file limit: both are taken before the body or the repository is looked at.
    const writes = await Promise.all(Array.from({ length: 70 }, () => post(owner, `${path}/stage-lines`, { requestId: 'short' })))
    expect(writes.map(response => response.status)).toContain(429)
    expect(await errorOf(writes.find(response => response.status === 429)!)).toEqual({ status: 429, error: 'rate-limited' })
    const reads = await Promise.all(Array.from({ length: 90 }, () => owner.request('tasks/no-such-session/git/history')))
    expect(reads.map(response => response.status)).toContain(429)
    expect(await audited(t)).toEqual([])
    expect(git('diff', '--cached', '--name-only')).toBe('')
  })

  it('rechecks the data scope after a history read, and returns nothing read for the wider one', SLOW, async () => {
    const { t, path } = await fixture()
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    await t.host.security.devices.setScopes(viewer.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
    for (const [method, url] of [
      ['history', `${path}/history`],
      ['treeDiff', `${path}/compare`],
      ['hunkDiff', `${path}/diff?view=unstaged&path=tracked.txt`],
    ] as const) {
      await t.host.security.devices.setScopes(viewer.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
      let release!: () => void
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      const read = vi.spyOn(GitDelivery.prototype, method).mockImplementation(async () => {
        await gate
        return { commits: [{ sha: 'a'.repeat(40), at: '', subject: 'read for the wider scope' }], files: [], hunks: [] } as never
      })
      const request = viewer.request(url)
      await expect.poll(() => read.mock.calls.length).toBe(1)
      await t.host.security.devices.setScopes(viewer.id, { dataScope: 'work' }, { listener: 'unix' }, 'lpc-local')
      release()
      const response = await request
      const text = await response.text()
      expect({ status: response.status, text }, method).toMatchObject({ status: 403 })
      expect(text).not.toContain('read for the wider scope')
      read.mockRestore()
    }
  })

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
    const phone = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'], dataScope: 'work' })
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
    // A browser's default scope reads the files of a project, never a private session's.
    const browser = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'] })
    expect(await errorOf(await post(browser, `${path}/push`, { requestId: randomUUID() }))).toEqual({
      status: 403,
      error: 'agent-scope-required',
    })
    await widen(phone)
    expect(await errorOf(await post(phone, `${path}/push`, { requestId: randomUUID() }))).toEqual({ status: 409, error: 'git-no-remote' })
    expect(await audited(t)).toEqual([])
  })

  it(
    'fetches, pulls and aborts with the delivery guards: run, full scope for a private session, no turn for pull or abort',
    { timeout: 60_000 },
    async () => {
      const { t, owner, path, sessionId, git, scratch } = await fixture()
      const snapshot = await owner.json<{ catalog: { features: { gitSync?: true } } }>('snapshot')
      expect(snapshot.catalog.features.gitSync).toBe(true)
      // A bare remote on disk, and a second clone that moves it on.
      const env = { ...process.env, HOME: join(scratch, 'home'), GIT_CONFIG_NOSYSTEM: '1' }
      const gitIn = (cwd: string, ...args: string[]) =>
        execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
          .toString('utf8')
          .trim()
      const remote = join(scratch, 'remote.git'),
        other = join(scratch, 'other')
      gitIn(scratch, 'init', '-q', '--bare', '-b', 'main', remote)
      git('remote', 'add', 'origin', remote)
      git('push', '-q', '-u', 'origin', 'main')
      gitIn(scratch, 'clone', '-q', remote, other)
      await writeFile(join(other, 'tracked.txt'), 'committed\nupstream\n')
      gitIn(other, '-c', 'user.name=O', '-c', 'user.email=o@example.invalid', 'commit', '-q', '-am', 'upstream')
      gitIn(other, 'push', '-q', 'origin', 'main')

      const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
      for (const part of ['fetch', 'pull'])
        expect(await errorOf(await post(viewer, `${path}/${part}`, { requestId: randomUUID() }))).toEqual({
          status: 403,
          error: 'scope-required',
        })
      expect(await errorOf(await post(viewer, `${path}/abort`, { requestId: randomUUID(), operation: 'merge' }))).toEqual({
        status: 403,
        error: 'scope-required',
      })
      // The phone's work scope: they name no file, so run is enough, as for a push.
      const phone = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'], dataScope: 'work' })
      expect(await errorOf(await post(phone, `${path}/abort`, { requestId: randomUUID(), operation: 'merge' }))).toEqual({
        status: 409,
        error: 'git-no-operation',
      })
      expect(await errorOf(await post(phone, `${path}/abort`, { requestId: randomUUID(), operation: 'unmerged' }))).toEqual({
        status: 400,
        error: 'invalid-input',
      })
      expect(await errorOf(await post(phone, `${path}/fetch`, { requestId: randomUUID(), remote: 'origin' }))).toEqual({
        status: 400,
        error: 'invalid-input',
      })
      vi.spyOn(t.host.bridge, 'agentPrivate').mockImplementation(id => id === sessionId)
      for (const part of ['fetch', 'pull'])
        expect(await errorOf(await post(phone, `${path}/${part}`, { requestId: randomUUID() }))).toEqual({
          status: 403,
          error: 'agent-scope-required',
        })
      vi.restoreAllMocks()
      expect(await audited(t)).toEqual([])
      expect(await phone.json(`${path}/fetch`, { method: 'POST', body: { requestId: randomUUID() } })).toMatchObject({ remote: 'origin' })
      expect(await owner.json<GitDeliveryState>(path)).toMatchObject({ behind: 1, fetchedAt: expect.any(String) })
      expect(await audited(t)).toEqual(['git.fetch', 'git.result'])

      // A turn in the folder: the pull and the abort wait for it; a fetch changes no file.
      await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'hang', requestId: randomUUID() } })
      await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, SLOW).toBe('running')
      expect(await errorOf(await post(owner, `${path}/pull`, { requestId: randomUUID() }))).toEqual({
        status: 409,
        error: 'git-turn-running',
      })
      // An abort loses resolved conflicts: it waits for the turn too, with the merge it names under way.
      const mergeHead = join(t.workspaceRoot, '.git', 'MERGE_HEAD')
      await writeFile(mergeHead, `${git('rev-parse', 'HEAD')}\n`)
      expect(await errorOf(await post(owner, `${path}/abort`, { requestId: randomUUID(), operation: 'merge' }))).toEqual({
        status: 409,
        error: 'git-turn-running',
      })
      await rm(mergeHead)
      expect((await post(owner, `${path}/fetch`, { requestId: randomUUID() })).status).toBe(200)
      await owner.json(`tasks/${sessionId}/cancel`, { method: 'POST', body: {} })
      await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, SLOW).not.toBe('running')
      const pulled = await owner.json<{ updated: boolean; head: string }>(`${path}/pull`, {
        method: 'POST',
        body: { requestId: randomUUID() },
      })
      expect(pulled).toMatchObject({ updated: true, head: gitIn(other, 'rev-parse', 'HEAD') })
      expect((await audited(t)).slice(-2)).toEqual(['git.pull', 'git.result'])
    },
  )

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

  it('rejects a review start copied to another device or project or changed to a different commit', SLOW, async () => {
    const { t, owner, scratch, git } = await fixture()
    const add = async (name: string) => {
      const folder = join(scratch, name)
      await mkdir(folder)
      await promisify(execFile)('git', ['init', '-q', '-b', 'main', folder])
      const response = await owner.addFolders({ paths: [folder] })
      expect(response.status).toBe(201)
      return ((await response.json()) as { workspace: { id: string } }).workspace.id
    }
    const id = await add('one'),
      second = await add('two')
    const commit = git('rev-parse', 'HEAD')
    vi.spyOn(GitDelivery.prototype, 'reviewHead').mockResolvedValueOnce({
      number: 7,
      commit,
      repository: 'contributor/example',
      baseRepository: 'github.com/org/example',
      branch: 'work',
      fork: true,
    })
    const head = await owner.json<{ proof: string; baseRepository: string }>(`workspaces/${id}/review-head`, {
      method: 'POST',
      body: { number: 7, requestId: randomUUID() },
    })
    const other = await t.enroll({ listener: 'loopback-tcp', scopes: ['run', 'view'], dataScope: 'all' })
    const start = (device: TestDevice, workspaceId: string, sha: string) =>
      post(device, 'tasks', {
        requestId: randomUUID(),
        mode: 'agent',
        harnessId: 'standard',
        workspaceId,
        prompt: 'hello',
        worktree: { from: 'pr', number: 7, repository: head.baseRepository, commit: sha, proof: head.proof },
      })
    for (const [device, workspace, sha] of [
      [other, id, commit],
      [owner, second, commit],
      [owner, id, 'f'.repeat(40)],
    ] as const) {
      expect(await errorOf(await start(device, workspace, sha))).toEqual({ status: 409, error: 'pr-head-unverified' })
    }
  })

  it(
    'continues an explicitly authorized idle built-in session once and stops after its author loses scope',
    { timeout: 65_000 },
    async () => {
      let gh!: FakeGh
      let poll!: () => Promise<void>
      const { t, owner, sessionId, path, git, scratch } = await fixture({
        builtin: true,
        gh: async root => (gh = await installFakeGh(join(root, 'gh'))),
        registerPoll: tick => {
          poll = tick
        },
      })
      const remote = join(scratch, 'remote.git')
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
      git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git')
      git('config', 'remote.origin.pushurl', remote)
      git('push', '-q', '-u', 'origin', 'main')
      git('switch', '-q', '-c', 'feature')
      git('commit', '-q', '--allow-empty', '-m', 'new change')
      git('push', '-q', '-u', 'origin', 'feature')
      await owner.json(`${path}/pr`, { method: 'POST', body: { requestId: randomUUID(), title: 'Review change', body: '', base: 'main' } })
      await gh.update(state => {
        state.prs[0]!.headRefOid = git('rev-parse', 'HEAD')
      })
      const requestId = randomUUID()
      await owner.json(`${path}/pr/follow`, {
        method: 'POST',
        body: { requestId, revision: null, number: 1, enabled: true, automatic: true },
      })
      await gh.update(state => {
        state.prs[0]!.comments.push({ author: { login: 'reviewer' }, body: 'Check the empty path', createdAt: '2026-11-23T01:00:00Z' })
      })
      await poll()
      expect(await owner.json(`${path}/pr/follow`)).toMatchObject({ follow: { automatic: true, notice: { comments: 1, outcome: 'sent' } } })
      await poll()
      const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
      expect(detail.messages.filter(message => message.role === 'user' && message.text.includes('Check the empty path'))).toHaveLength(1)
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
      const prompt = vi.spyOn(HarnessHub.prototype, 'prompt').mockRejectedValueOnce(new Error('connection lost after dispatch'))
      const comment = (body: string) =>
        gh.update(state => {
          state.prs[0]!.comments.push({ author: { login: 'reviewer' }, body, createdAt: '2026-11-23T02:00:00Z' })
        })
      await comment('second question')
      await poll()
      expect(await owner.json(`${path}/pr/follow`)).toMatchObject({ follow: { notice: { outcome: 'unknown' } } })
      await comment('a later question')
      await poll()
      expect(prompt).toHaveBeenCalledTimes(1)
      prompt.mockRestore()
      await t.host.security.devices.setScopes(owner.id, { dataScope: 'work' }, { listener: 'unix' }, 'lpc-local')
      const calls = (await gh.calls()).length
      await poll()
      expect((await gh.calls()).length).toBe(calls)
      expect((await owner.request(`${path}/pr/follow`)).status).toBe(403)
    },
  )

  it(
    'reads and creates the pull request through your gh: view to read, full scope for logs, run and the audit to create',
    { timeout: 65_000 },
    async () => {
      let gh: FakeGh | undefined
      let poll!: () => Promise<void>
      const { t, owner, path, git, scratch } = await fixture({
        registerPoll: fn => {
          poll = fn
        },
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

      const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'], dataScope: 'work' })
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

      const watch = { requestId: randomUUID(), revision: null, number: 1, enabled: true }
      expect((await owner.json<GitPrState>(`${path}/pr`)).automaticRestriction).toBe('harness')
      expect((await post(owner, `${path}/pr/follow`, { ...watch, automatic: true })).status).toBe(409)
      expect((await post(viewer, `${path}/pr/follow`, watch)).status).toBe(403)
      expect((await post(owner, `${path}/pr/follow`, watch)).status).toBe(200)
      expect((await post(owner, `${path}/pr/follow`, watch)).status).toBe(200)
      expect((await viewer.request(`${path}/pr/follow`)).status).toBe(403)
      await gh!.update(state => {
        state.prs[0]!.comments.push({
          author: { login: 'reviewer' },
          body: 'Please check the empty case',
          createdAt: '2026-11-22T10:01:00Z',
        })
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
      await poll()
      const feedback = await owner.json(`${path}/pr/follow`)
      expect(feedback).toMatchObject({ follow: { enabled: true, notice: { comments: 1, failures: 1 } } })
      expect(JSON.stringify(feedback)).not.toContain('Please check')
      await poll()
      expect(await owner.json(`${path}/pr/follow`)).toEqual(feedback)
      const initialCalls = (await gh!.calls()).length
      await t.host.security.devices.setScopes(owner.id, { dataScope: 'work' }, { listener: 'unix' }, 'none')
      await t.host.security.devices.setScopes(owner.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
      // Restore the original scopes before the next poll. The old request cannot reauthorize the subscription.
      expect(await owner.json(`${path}/pr/follow`)).toMatchObject({ follow: { enabled: false, revision: watch.requestId } })
      expect((await post(owner, `${path}/pr/follow`, watch)).status).toBe(409)
      await poll()
      expect((await gh!.calls()).length).toBe(initialCalls)
      const restart = { ...watch, requestId: randomUUID(), revision: watch.requestId }
      expect((await post(owner, `${path}/pr/follow`, restart)).status).toBe(200)
      expect(
        (await post(owner, `${path}/pr/follow`, { ...watch, requestId: randomUUID(), enabled: false, revision: restart.requestId })).status,
      ).toBe(200)
      expect((await post(owner, `${path}/pr/follow`, watch)).status).toBe(409)
      const before = (await gh!.calls()).length
      await poll()
      expect((await gh!.calls()).length).toBe(before)
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

describe('clone route', () => {
  it('clones only for the desktop app with a signed body, audits first, and makes the folder a project', SLOW, async () => {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'latch-clone-route-')))
    cleanups.push(() => rm(scratch, { recursive: true, force: true }))
    const home = join(scratch, 'home'),
      served = join(scratch, 'served'),
      marks = join(scratch, 'marks'),
      parent = join(scratch, 'projects')
    await Promise.all([home, served, marks, parent].map(dir => mkdir(dir)))
    const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }
    const gitIn = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
        .toString('utf8')
        .trim()
    const work = join(scratch, 'work')
    await mkdir(work)
    gitIn(work, 'init', '-q', '-b', 'main')
    await writeFile(join(work, 'readme.txt'), 'hello\n')
    gitIn(work, 'add', '.')
    gitIn(work, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'first')
    gitIn(served, 'init', '-q', '--bare', '-b', 'main', 'widgets.git')
    gitIn(work, 'push', '-q', join(served, 'widgets.git'), 'main')
    const fake = await installFakeSsh({ root: scratch, served, marks, git: findGit()! })
    const t = await startTestHost({
      gitDelivery: { home, hostEnv: { HOME: home, USER: 'tester', PATH: '/usr/bin:/bin', TMPDIR: scratch }, shell: fake.shell },
    })
    hosts.push(t)
    const desktop = await t.enroll({ listener: 'unix' })
    const url = 'git@example.test:widgets.git'
    // Another device, or the page itself without main's signature, cannot clone.
    const browser = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run', 'admin'] })
    expect((await post(browser, 'workspaces/clone', { nonce: 'n', via: 'clone', url, parent, signature: 'x' })).status).toBe(403)
    expect(
      (await post(desktop, 'workspaces/clone', { nonce: 'n', via: 'clone', url, parent, signature: 'x' })).status,
    ).toBeGreaterThanOrEqual(400)
    // A signature over another address is not one for this one.
    expect(
      (await desktop.cloneRepository({ url, parent, signedBody: body => ({ ...body, url: 'git@example.test:other.git' }) })).status,
    ).toBeGreaterThanOrEqual(400)
    for (const [bad, code] of [
      ['ext::sh -c touch% /tmp/x', 'clone-url-invalid'],
      [join(served, 'widgets.git'), 'clone-url-invalid'],
      ['file://' + join(served, 'widgets.git'), 'clone-url-invalid'],
      ['https://user:secret@example.test/widgets.git', 'clone-url-credentials'],
      ['--upload-pack=touch /tmp/x', 'clone-url-invalid'],
    ] as const)
      expect(await errorOf(await desktop.cloneRepository({ url: bad, parent }))).toEqual({ status: 400, error: code })
    expect(await readdir(parent)).toEqual([])
    const started = await desktop.cloneRepository({ url, parent })
    expect(started.status).toBe(202)
    const { clone } = (await started.json()) as { clone: GitCloneState }
    expect(clone).toMatchObject({ state: 'running', name: 'widgets' })
    expect((await browser.request(`workspaces/clone/${clone.id}`)).status).toBe(403)
    let state = clone
    await expect
      .poll(async () => (state = (await desktop.json<{ clone: GitCloneState }>(`workspaces/clone/${clone.id}`)).clone).state, SLOW)
      .toBe('done')
    const workspaces = (await desktop.json<{ workspaces: Array<{ id: string; path: string }> }>('workspaces')).workspaces
    expect(workspaces.find(item => item.id === state.workspaceId)?.path).toBe(join(parent, 'widgets'))
    const log = (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { action: string; detail: Record<string, unknown> })
    const actions = log.map(entry => entry.action).filter(action => action.startsWith('git.clone') || action === 'workspace.added')
    expect(actions).toEqual(['git.clone', 'workspace.added', 'git.clone.result'])
    expect(log.find(entry => entry.action === 'workspace.added')?.detail.via).toBe('clone')
    expect(JSON.stringify(log)).not.toContain('example.test')
    expect(JSON.stringify(log)).not.toContain('user:secret')
  })
})
