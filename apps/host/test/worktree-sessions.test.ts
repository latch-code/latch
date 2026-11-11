import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { LatchWorktree, TaskDetail, TaskSummary, WorktreeBase, WorktreeInventory } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { findGit, GitReader } from '../src/changes/git.ts'
import { Worktrees } from '../src/worktrees.ts'
import type { LaunchTerminal } from '../src/terminal/helper.ts'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const git = findGit()
const hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
})

const SLOW = { timeout: 15_000 }

/**
 * A Host whose only Qwen Code is the fake agent in its own directory, and a project that is a Git repository with a
 * committed `.qwen/settings.json`, an uncommitted change to it and an untracked file.
 */
async function fixture(agentEnv: Record<string, string> = {}, hostOptions: TestHostOptions = {}) {
  const bin = await realpath(await mkdtemp(join(tmpdir(), 'latch-worktree-bin-')))
  onTestFinished(() => rm(bin, { recursive: true, force: true }))
  const log = join(bin, 'agent.log')
  const exports = Object.entries({
    FAKE_ACP_CONFIG: 'options',
    FAKE_ACP_MODES: 'plan,default,auto-edit,auto,yolo',
    FAKE_ACP_INITIAL_MODE: 'default',
    FAKE_ACP_LOG: log,
    ...agentEnv,
  }).map(([key, value]) => `${key}='${value}'`)
  await writeFile(
    join(bin, 'qwen'),
    ['#!/bin/sh', `export ${exports.join(' ')}`, `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`].join('\n'),
  )
  await chmod(join(bin, 'qwen'), 0o755)
  // Only this directory: no agent installed on the computer running the test is ever found or run.
  const agentOnly: TestHostOptions = {
    demo: false,
    commandDirectories: () => [bin],
    detectPreset: preset => (preset.id === 'qwen' ? { found: true, path: join(bin, 'qwen') } : { found: false }),
  }
  const t = await startTestHost({ ...agentOnly, ...hostOptions })
  hosts.push(t)
  const project = join(t.root, 'project')
  await mkdir(project)
  const run = (...args: string[]) =>
    execFileSync(git!, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
      cwd: project,
      stdio: 'pipe',
    }).toString('utf8')
  run('init', '-q')
  await mkdir(join(project, '.qwen'))
  await writeFile(join(project, '.qwen', 'settings.json'), '{"committed":true}\n')
  await writeFile(join(project, 'a.txt'), 'one\n')
  run('add', '-A')
  run('commit', '-qm', 'first')
  await writeFile(join(project, '.qwen', 'settings.json'), '{"committed":false}\n')
  await writeFile(join(project, 'new.txt'), 'untracked\n')
  const owner = await t.enroll({ listener: 'unix' })
  await owner.json('agents', {
    method: 'POST',
    body: { id: 'qwen', name: 'Qwen Code', presetId: 'qwen', command: 'qwen', args: ['--acp'], env: {} },
  })
  const { workspace } = (await (await owner.addFolders({ paths: [project] })).json()) as {
    workspace: { id: string; folders: Array<{ id: string }> }
  }
  const start = (device: TestDevice, body: Record<string, unknown> = {}) =>
    device.request('tasks', {
      method: 'POST',
      body: {
        prompt: 'hello',
        requestId: randomUUID(),
        mode: 'agent',
        harnessId: 'qwen',
        workspaceId: workspace.id,
        worktree: true,
        ...body,
      },
    })
  const audits = async () =>
    (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { action: string; detail?: Record<string, unknown> })
  const worktreeRoot = join(await realpath(t.root), 'worktrees')
  const leftovers = async () => {
    const buckets = existsSync(worktreeRoot) ? (await readdir(worktreeRoot)).filter(name => name !== '.metadata_never_index') : []
    return { buckets, branches: run('for-each-ref', '--format=%(refname)', 'refs/heads').trim().split('\n') }
  }
  return {
    t,
    owner,
    project,
    run,
    start,
    workspaceId: workspace.id,
    folderId: workspace.folders[0]!.id,
    audits,
    worktreeRoot,
    leftovers,
    log,
    agentOnly,
  }
}

const summaryOf = async (owner: TestDevice, sessionId: string) => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary

describe.skipIf(!git)('sessions in a new worktree', () => {
  it('starts in a worktree beside the start directory, fingerprinted on its own configuration, and keeps the project', async () => {
    const f = await fixture()
    const head = f.run('rev-parse', 'HEAD').trim()
    expect(await f.owner.json(`workspaces/${f.workspaceId}/worktree`)).toEqual({
      branch: 'main',
      commit: head,
      branches: [{ name: 'main', commit: head, checkedOut: true }],
    })

    const requestId = randomUUID()
    const response = await f.start(f.owner, { requestId })
    expect(response.status).toBe(201)
    const { sessionId } = (await response.json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await summaryOf(f.owner, sessionId)).status).toBe('idle'), SLOW)
    const summary: TaskSummary = await summaryOf(f.owner, sessionId)
    expect(summary.workspaceId).toBe(f.workspaceId)
    expect(summary.worktree?.branch).toMatch(/^latch\/\d{8}-[0-9a-f]{4}$/u)
    expect(summary.branch).toBe(summary.worktree!.branch)
    expect(summary.cwd!.startsWith(`${f.worktreeRoot}/project-`)).toBe(true)
    // Committed files only: the uncommitted change and the untracked file stay in the project folder.
    expect(await readFile(join(summary.cwd!, '.qwen', 'settings.json'), 'utf8')).toBe('{"committed":true}\n')
    expect(existsSync(join(summary.cwd!, 'new.txt'))).toBe(false)
    expect(f.run('status', '--porcelain')).toBe(' M .qwen/settings.json\n?? new.txt\n')

    // The launch the record names is the worktree's, not the project folder's.
    const started = (await f.audits()).find(entry => entry.action === 'task.l3.started')!
    const inWorktree = await f.t.host.bridge.launchPreviewOf!('qwen', summary.cwd!)
    const inProject = await f.t.host.bridge.launchPreviewOf!('qwen', f.project)
    expect(started.detail?.launchHash).toBe(inWorktree?.launchHash)
    expect(inWorktree?.launchHash).not.toBe(inProject?.launchHash)
    // Every start ran the fake agent from the test's own directory.
    expect((await readFile(f.log, 'utf8')).length).toBeGreaterThan(0)

    // A retry is the same session in the same worktree; a later turn runs there too.
    const again = await f.start(f.owner, { requestId })
    expect(await again.json()).toEqual({ sessionId })
    expect((await f.leftovers()).buckets).toHaveLength(1)
    expect(await readdir(join(f.worktreeRoot, (await f.leftovers()).buckets[0]!))).toHaveLength(1)
    const next = await f.owner.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'again', requestId: randomUUID() } })
    expect(next.status).toBe(200)
  })

  it('refuses a later turn once the worktree is no longer the one Latch made for the session', async () => {
    const f = await fixture()
    const { sessionId } = (await (await f.start(f.owner)).json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await summaryOf(f.owner, sessionId)).status).toBe('idle'), SLOW)
    const cwd = (await summaryOf(f.owner, sessionId)).cwd!
    const name = cwd.split('/').at(-1)!
    await rm(join(f.project, '.git', 'worktrees', name, 'latch-session.json'))
    const next = await f.owner.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'again', requestId: randomUUID() } })
    expect(next.status).toBe(409)
    expect(await next.json()).toMatchObject({ error: 'workspace-changed' })
  })

  it('stops listing the worktree for its session once the project is removed', async () => {
    const f = await fixture()
    const { sessionId } = (await (await f.start(f.owner)).json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await summaryOf(f.owner, sessionId)).status).toBe('idle'), SLOW)
    expect((await f.owner.request(`workspaces/${f.workspaceId}`, { method: 'DELETE' })).status).toBe(200)
    const next = await f.owner.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'again', requestId: randomUUID() } })
    expect(next.status).toBe(409)
    expect(await next.json()).toMatchObject({ error: 'workspace-changed' })
    // The worktree and its branch stay: removing a project never deletes files.
    expect(existsSync((await summaryOf(f.owner, sessionId)).cwd!)).toBe(true)
  })

  it('says why and starts nothing when no worktree can be made', async () => {
    const f = await fixture()
    f.run('config', 'includeIf.gitdir:/nowhere/.path', '/nowhere')
    const refused = await f.owner.request(`workspaces/${f.workspaceId}/worktree`)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: 'worktree-include-if' })
    const response = await f.start(f.owner)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'worktree-include-if', message: expect.stringContaining('includeIf') })
    expect(await f.t.host.bridge.listTasks()).toEqual([])
    expect(existsSync(f.log)).toBe(false)
    expect(await f.leftovers()).toEqual({ buckets: [], branches: ['refs/heads/main'] })
  })

  it(
    "lets another project start while a worktree is being made, and holds this project's removal until the session exists",
    SLOW,
    async () => {
      const f = await fixture()
      const other = join(f.t.root, 'other')
      await mkdir(other)
      const { workspace } = (await (await f.owner.addFolders({ paths: [other] })).json()) as { workspace: { id: string } }
      let enter!: () => void
      let release!: () => void
      const entered = new Promise<void>(done => {
        enter = done
      })
      const held = new Promise<void>(done => {
        release = done
      })
      onTestFinished(() => release())
      const create = Worktrees.prototype.create
      vi.spyOn(Worktrees.prototype, 'create').mockImplementation(async function (this: Worktrees, input) {
        enter()
        await held
        return create.call(this, input)
      })
      const order: string[] = []
      const starting = f.start(f.owner).then(response => {
        order.push('start')
        return response
      })
      await entered
      const removing = f.owner.request(`workspaces/${f.workspaceId}`, { method: 'DELETE' }).then(response => {
        order.push('remove')
        return response
      })
      try {
        expect((await f.start(f.owner, { workspaceId: workspace.id, worktree: undefined })).status).toBe(201)
        expect(order).toEqual([])
      } finally {
        release()
      }
      const response = await starting
      expect(response.status).toBe(201)
      const { sessionId } = (await response.json()) as { sessionId: string }
      const removed = await removing
      // The removal's in-use check sees the session in its worktree, whatever state it has reached by then.
      expect(order).toEqual(['start', 'remove'])
      expect([200, 409]).toContain(removed.status)
      expect(existsSync((await summaryOf(f.owner, sessionId)).cwd!)).toBe(true)
      vi.restoreAllMocks()
    },
  )

  it('leaves no worktree or branch behind when the start is refused after it was made', async () => {
    const f = await fixture()
    const untracked = [{ root: f.folderId, path: 'new.txt' }]
    // Untracked, so it is in the project folder and not in the worktree, where the session would read it.
    const response = await f.start(f.owner, { fileRefs: untracked })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: 'file-reference-refused',
      message: '引用的文件不在新工作树里：新工作树只有已提交的文件。请先提交它，或在当前文件夹里开始。',
    })
    expect(await f.leftovers()).toEqual({ buckets: [], branches: ['refs/heads/main'] })
    expect(existsSync(f.log)).toBe(false)
    expect((await f.start(f.owner, { worktree: undefined, fileRefs: untracked })).status).toBe(201)
    // A committed file is read in the worktree.
    expect((await f.start(f.owner, { fileRefs: [{ root: f.folderId, path: 'a.txt' }] })).status).toBe(201)
  })

  it('takes a worktree only for a project, outside a fork, and needs run to read where one would start', async () => {
    const f = await fixture()
    const none = await f.start(f.owner, { workspaceId: 'default' })
    expect(await none.json()).toMatchObject({ error: 'worktree-project' })
    const viewer = await f.t.enroll({ scopes: ['view'] })
    expect(await (await viewer.request(`workspaces/${f.workspaceId}/worktree`)).json()).toMatchObject({ error: 'scope-required' })
    expect(await f.leftovers()).toEqual({ buckets: [], branches: ['refs/heads/main'] })
  })

  it('starts from another branch or commit, checks out an existing branch, and reuses an archived session’s worktree', async () => {
    const f = await fixture()
    f.run('branch', 'feature')
    const feature = f.run('rev-parse', 'refs/heads/feature').trim()
    const base = await f.owner.json<WorktreeBase>(`workspaces/${f.workspaceId}/worktree`)
    expect(base.branches?.map(item => item.name).toSorted()).toEqual(['feature', 'main'])
    expect(base.reusable).toBeUndefined()

    const fromBranch = await f.start(f.owner, { worktree: { from: 'commit', ref: 'feature' } })
    expect(fromBranch.status).toBe(201)
    const { sessionId: first } = (await fromBranch.json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await summaryOf(f.owner, first)).status).toBe('idle'), SLOW)
    expect((await summaryOf(f.owner, first)).worktree?.branch).toMatch(/^latch\//u)

    const checkedOut = await f.start(f.owner, { worktree: { from: 'branch', branch: 'main' } })
    expect(checkedOut.status).toBe(409)
    expect(await checkedOut.json()).toMatchObject({ error: 'worktree-branch-checked-out' })
    const badName = await f.start(f.owner, { worktree: { from: 'branch', branch: '--force' } })
    expect(await badName.json()).toMatchObject({ error: 'worktree-branch-name' })
    const onFeature = await f.start(f.owner, { worktree: { from: 'branch', branch: 'feature' } })
    expect(onFeature.status).toBe(201)
    const { sessionId: second } = (await onFeature.json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await summaryOf(f.owner, second)).status).toBe('idle'), SLOW)
    expect((await summaryOf(f.owner, second)).worktree?.branch).toBe('feature')
    expect(f.run('-C', (await summaryOf(f.owner, second)).cwd!, 'rev-parse', 'HEAD').trim()).toBe(feature)

    // The first session holds its worktree until it is archived.
    const cwd = (await summaryOf(f.owner, first)).cwd!
    const name = cwd.split('/').at(-1)!
    const held = await f.start(f.owner, { worktree: { from: 'reuse', name } })
    expect(await held.json()).toMatchObject({ error: 'worktree-reuse-held' })
    await f.owner.json(`tasks/${first}`, { method: 'PATCH', body: { archived: true } })
    const listed = await f.owner.json<{ worktrees: LatchWorktree[] }>(`workspaces/${f.workspaceId}/worktrees`)
    expect(listed.worktrees.find(item => item.name === name)).toMatchObject({ state: 'archived', sessionId: first, reusable: true })
    expect((await f.owner.json<WorktreeBase>(`workspaces/${f.workspaceId}/worktree`)).reusable?.map(item => item.name)).toEqual([name])
    const requestId = randomUUID()
    const reused = await f.start(f.owner, { requestId, worktree: { from: 'reuse', name } })
    expect(reused.status).toBe(201)
    const { sessionId: third } = (await reused.json()) as { sessionId: string }
    expect(await (await f.start(f.owner, { requestId, worktree: { from: 'reuse', name } })).json()).toEqual({ sessionId: third })
    await vi.waitFor(async () => expect((await summaryOf(f.owner, third)).status).toBe('idle'), SLOW)
    expect((await summaryOf(f.owner, third)).cwd).toBe(cwd)
    // The archived session no longer owns it.
    const late = await f.owner.request(`tasks/${first}/prompt`, { method: 'POST', body: { prompt: 'again', requestId: randomUUID() } })
    expect(late.status).toBe(409)
  })

  it('removes a session’s worktree after the count of uncommitted files is confirmed, audits first, and keeps the session read-only', async () => {
    const f = await fixture()
    const { sessionId } = (await (await f.start(f.owner)).json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await summaryOf(f.owner, sessionId)).status).toBe('idle'), SLOW)
    const summary = await summaryOf(f.owner, sessionId)
    const cwd = summary.cwd!
    await writeFile(join(cwd, 'a.txt'), 'one\ntwo\n')
    await writeFile(join(cwd, 'scratch.txt'), 'notes\n')
    const path = `tasks/${sessionId}/worktree`
    expect(await f.owner.json<WorktreeInventory>(path)).toMatchObject({ staged: 0, files: expect.any(Number), ownBranch: true })
    const facts = await f.owner.json<WorktreeInventory>(path)
    expect(facts.untracked).toBeGreaterThanOrEqual(1)
    const viewer = await f.t.enroll({ scopes: ['view'] })
    expect(await (await viewer.request(`${path}/remove`, { method: 'POST', body: { requestId: randomUUID() } })).json()).toMatchObject({
      error: 'scope-required',
    })
    const dirty = await f.owner.request(`${path}/remove`, { method: 'POST', body: { requestId: randomUUID() } })
    expect(dirty.status).toBe(409)
    expect(await dirty.json()).toMatchObject({ error: 'worktree-dirty', files: facts.files })
    expect(existsSync(join(cwd, 'scratch.txt'))).toBe(true)
    expect((await f.audits()).some(entry => entry.action === 'worktree.remove')).toBe(false)

    const requestId = randomUUID()
    const removed = await f.owner.json(`${path}/remove`, {
      method: 'POST',
      body: { requestId, discard: facts.files + facts.ignored, digest: facts.digest },
    })
    expect(removed).toEqual({ removed: true, discarded: facts.files, branch: 'deleted', branchName: summary.worktree!.branch })
    expect(
      await f.owner.json(`${path}/remove`, {
        method: 'POST',
        body: { requestId, discard: facts.files + facts.ignored, digest: facts.digest },
      }),
    ).toEqual(removed)
    expect(existsSync(cwd)).toBe(false)
    expect(f.run('for-each-ref', '--format=%(refname)', 'refs/heads').trim()).toBe('refs/heads/main')
    const audits = (await f.audits()).filter(entry => entry.action.startsWith('worktree.'))
    expect(audits.map(entry => entry.action)).toEqual(['worktree.remove', 'worktree.result'])
    expect(audits[0]!.detail).toMatchObject({ sessionId, forced: true, ownBranch: true, untracked: facts.untracked })
    expect(JSON.stringify(audits)).not.toContain('scratch')
    expect(JSON.stringify(audits)).not.toContain(cwd)
    expect(audits[1]!.detail).toMatchObject({ outcome: 'removed', branch: 'deleted' })

    // The session stays, says so, and takes no new turn.
    expect((await summaryOf(f.owner, sessionId)).worktree).toMatchObject({ removed: true })
    const next = await f.owner.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'again', requestId: randomUUID() } })
    expect(await next.json()).toMatchObject({ error: 'worktree-removed' })
    expect(await (await f.owner.request(path)).json()).toMatchObject({ error: 'worktree-removed' })
  })

  it('refuses to remove a worktree while a turn runs in it, and removes a leftover from the project', async () => {
    const f = await fixture()
    const { sessionId } = (await (await f.start(f.owner, { prompt: 'hang' })).json()) as { sessionId: string }
    await expect.poll(async () => (await f.t.host.bridge.summary(sessionId)).status, SLOW).toBe('running')
    expect((await f.owner.json<WorktreeInventory>(`tasks/${sessionId}/worktree`)).busy).toBe('turn')
    const running = await f.owner.request(`tasks/${sessionId}/worktree/remove`, { method: 'POST', body: { requestId: randomUUID() } })
    expect(await running.json()).toMatchObject({ error: 'worktree-turn-running' })
    expect(existsSync((await summaryOf(f.owner, sessionId)).cwd!)).toBe(true)

    // A worktree whose session is gone is a leftover, removed from the project.
    const { sessionId: gone } = (await (await f.start(f.owner)).json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await summaryOf(f.owner, gone)).status).toBe('idle'), SLOW)
    const cwd = (await summaryOf(f.owner, gone)).cwd!
    const name = cwd.split('/').at(-1)!
    expect(
      (await f.owner.request(`workspaces/${f.workspaceId}/worktrees/${name}/remove`, { method: 'POST', body: { requestId: randomUUID() } }))
        .status,
    ).toBe(409)
    expect((await f.owner.request(`tasks/${gone}`, { method: 'DELETE' })).status).toBe(200)
    const listed = await f.owner.json<{ worktrees: LatchWorktree[] }>(`workspaces/${f.workspaceId}/worktrees`)
    expect(listed.worktrees.find(item => item.name === name)).toMatchObject({ state: 'leftover', reusable: true })
    expect(await f.owner.json<WorktreeInventory>(`workspaces/${f.workspaceId}/worktrees/${name}`)).toMatchObject({ files: 0 })
    expect(
      await f.owner.json(`workspaces/${f.workspaceId}/worktrees/${name}/remove`, { method: 'POST', body: { requestId: randomUUID() } }),
    ).toMatchObject({ removed: true, branch: 'deleted' })
    expect(existsSync(cwd)).toBe(false)
    expect((await f.audits()).find(entry => entry.action === 'worktree.remove')?.detail).toMatchObject({
      workspaceId: f.workspaceId,
      forced: false,
    })
    expect((await f.audits()).find(entry => entry.action === 'worktree.remove')?.detail?.sessionId).toBeUndefined()
  })

  it('keeps a session’s worktree held while its Harness does not list it: neither reused nor removed as a leftover', async () => {
    const f = await fixture()
    const { sessionId } = (await (await f.start(f.owner)).json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await summaryOf(f.owner, sessionId)).status).toBe('idle'), SLOW)
    await f.owner.json(`tasks/${sessionId}`, { method: 'PATCH', body: { archived: true } })
    const cwd = (await summaryOf(f.owner, sessionId)).cwd!
    const name = cwd.split('/').at(-1)!
    const listTasks = f.t.host.bridge.listTasks.bind(f.t.host.bridge)
    vi.spyOn(f.t.host.bridge, 'listTasks').mockImplementation(async () => (await listTasks()).filter(task => task.id !== sessionId))
    onTestFinished(() => {
      vi.restoreAllMocks()
    })
    const listed = await f.owner.json<{ worktrees: LatchWorktree[] }>(`workspaces/${f.workspaceId}/worktrees`)
    expect(listed.worktrees.find(item => item.name === name)).toMatchObject({ state: 'archived', reusable: false })
    const reuse = await f.start(f.owner, { worktree: { from: 'reuse', name } })
    expect(await reuse.json()).toMatchObject({ error: 'worktree-reuse-held' })
    const removal = await f.owner.request(`workspaces/${f.workspaceId}/worktrees/${name}/remove`, {
      method: 'POST',
      body: { requestId: randomUUID() },
    })
    expect(await removal.json()).toMatchObject({ error: 'worktree-owned' })
    expect(existsSync(cwd)).toBe(true)
  })

  it('lets only a device with the full data scope reuse a private session’s worktree, and hides whose it is from others', async () => {
    const f = await fixture()
    const { sessionId } = (await (await f.start(f.owner)).json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await summaryOf(f.owner, sessionId)).status).toBe('idle'), SLOW)
    await f.owner.json(`tasks/${sessionId}`, { method: 'PATCH', body: { archived: true } })
    const name = (await summaryOf(f.owner, sessionId)).cwd!.split('/').at(-1)!
    vi.spyOn(f.t.host.bridge, 'sessionRecord').mockImplementation(id => (id === sessionId ? { archived: true, private: true } : undefined))
    onTestFinished(() => {
      vi.restoreAllMocks()
    })
    const work = await f.t.enroll({ scopes: ['view', 'run'] })
    await f.owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    const seen = (await work.json<{ worktrees: LatchWorktree[] }>(`workspaces/${f.workspaceId}/worktrees`)).worktrees.find(
      item => item.name === name,
    )!
    expect(seen).toMatchObject({ state: 'archived', reusable: false })
    expect(seen.sessionId).toBeUndefined()
    expect(seen.branch).toBeUndefined()
    const refused = await f.start(work, { worktree: { from: 'reuse', name } })
    expect(await refused.json()).toMatchObject({ error: 'worktree-reuse-held' })
    expect((await f.start(f.owner, { worktree: { from: 'reuse', name } })).status).toBe(201)
  })

  it('refuses to remove a worktree while its session has a terminal open', async () => {
    const launch: LaunchTerminal = (_spec, onEvent) => {
      onEvent({ type: 'started', pid: 1 })
      return {
        pendingInput: 0,
        input() {},
        resize() {},
        signal() {},
        pauseOutput() {},
        resumeOutput() {},
        close() {
          onEvent({ type: 'exit', signal: 1 })
          onEvent({ type: 'gone' })
          return Promise.resolve()
        },
      }
    }
    const f = await fixture({}, { terminal: { launch, shell: { file: '/bin/sh', argv: ['sh'] } } })
    const { sessionId } = (await (await f.start(f.owner)).json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await summaryOf(f.owner, sessionId)).status).toBe('idle'), SLOW)
    const opened = await f.owner.request(`tasks/${sessionId}/terminals`, { body: { cols: 80, rows: 24 } })
    expect(opened.status).toBe(201)
    expect((await f.owner.json<WorktreeInventory>(`tasks/${sessionId}/worktree`)).busy).toBe('terminal')
    const refused = await f.owner.request(`tasks/${sessionId}/worktree/remove`, { method: 'POST', body: { requestId: randomUUID() } })
    expect(await refused.json()).toMatchObject({ error: 'worktree-terminal-open' })
    expect(existsSync((await summaryOf(f.owner, sessionId)).cwd!)).toBe(true)
    expect((await f.audits()).some(entry => entry.action === 'worktree.remove')).toBe(false)
  })

  it('finishes marking the session on a retry when Git removed the worktree but the record was not written', async () => {
    const f = await fixture()
    const { sessionId } = (await (await f.start(f.owner)).json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await summaryOf(f.owner, sessionId)).status).toBe('idle'), SLOW)
    const cwd = (await summaryOf(f.owner, sessionId)).cwd!
    vi.spyOn(f.t.host.bridge, 'worktreeRemoved').mockRejectedValueOnce(new Error('disk full'))
    onTestFinished(() => {
      vi.restoreAllMocks()
    })
    const requestId = randomUUID()
    const first = await f.owner.request(`tasks/${sessionId}/worktree/remove`, { method: 'POST', body: { requestId } })
    expect(first.status).toBe(500)
    expect(existsSync(cwd)).toBe(false)
    expect((await summaryOf(f.owner, sessionId)).worktree?.removed).toBeUndefined()
    expect(await f.owner.json(`tasks/${sessionId}/worktree/remove`, { method: 'POST', body: { requestId } })).toMatchObject({
      removed: true,
      branch: 'deleted',
    })
    expect((await summaryOf(f.owner, sessionId)).worktree?.removed).toBe(true)
  })

  it('counts a removal running Git as busy for the install window, and refuses one after the commit', async () => {
    const f = await fixture()
    const ids: string[] = []
    for (let i = 0; i < 2; i++) ids.push(((await (await f.start(f.owner)).json()) as { sessionId: string }).sessionId)
    for (const id of ids) await vi.waitFor(async () => expect((await summaryOf(f.owner, id)).status).toBe('idle'), SLOW)
    const [first, second] = ids as [string, string]
    let atGit!: () => void
    const reached = new Promise<void>(done => (atGit = done))
    let letGo!: () => void
    const held = new Promise<void>(done => (letGo = done))
    const run = GitReader.prototype.run
    vi.spyOn(GitReader.prototype, 'run').mockImplementation(async function (this: GitReader, layout, args, options) {
      if (args.includes('worktree') && args.includes('remove')) {
        atGit()
        await held
      }
      return run.call(this, layout, args, options)
    })
    onTestFinished(() => {
      vi.restoreAllMocks()
    })
    expect((await f.owner.request('host/update-window', { method: 'POST', body: { open: true } })).status).toBe(200)
    const removing = f.owner.request(`tasks/${first}/worktree/remove`, { method: 'POST', body: { requestId: randomUUID() } })
    await reached
    expect((await f.owner.json<{ busy: { unknown: number } }>('host/update-window')).busy.unknown).toBe(1)
    const busy = await f.owner.request('host/update-window/commit', { method: 'POST', body: {} })
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ error: 'host-busy' })
    letGo()
    expect((await removing).status).toBe(200)
    expect((await f.owner.request('host/update-window/commit', { method: 'POST', body: {} })).status).toBe(200)
    const cwd = (await summaryOf(f.owner, second)).cwd!
    const refused = await f.owner.request(`tasks/${second}/worktree/remove`, { method: 'POST', body: { requestId: randomUUID() } })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: 'host-updating' })
    expect(existsSync(cwd)).toBe(true)
    expect((await f.audits()).filter(entry => entry.action === 'worktree.remove')).toHaveLength(1)
  })

  it('finishes a removal Git completed before the Host stopped, on a retry after the restart', async () => {
    const dirs = await realpath(await mkdtemp(join(tmpdir(), 'latch-worktree-restart-')))
    onTestFinished(() => rm(dirs, { recursive: true, force: true }))
    const dataDir = join(dirs, 'data'),
      workspaceRoot = join(dirs, 'workspace')
    await mkdir(workspaceRoot)
    const f = await fixture({}, { dataDir, workspaceRoot })
    const { sessionId } = (await (await f.start(f.owner)).json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await summaryOf(f.owner, sessionId)).status).toBe('idle'), SLOW)
    const cwd = (await summaryOf(f.owner, sessionId)).cwd!
    // Git removes the folder; the Host stops before it records the result or deletes the branch.
    let removed!: () => void
    const gitDone = new Promise<void>(done => (removed = done))
    const run = GitReader.prototype.run
    vi.spyOn(GitReader.prototype, 'run').mockImplementation(async function (this: GitReader, layout, args, options) {
      if (!(args.includes('worktree') && args.includes('remove'))) return run.call(this, layout, args, options)
      await run.call(this, layout, args, options)
      removed()
      return new Promise<Buffer>(() => {})
    })
    const abort = new AbortController()
    const first = f.owner
      .request(`tasks/${sessionId}/worktree/remove`, { method: 'POST', body: { requestId: randomUUID() }, signal: abort.signal })
      .catch(() => undefined)
    await gitDone
    vi.restoreAllMocks()
    expect(existsSync(cwd)).toBe(false)
    abort.abort()
    await first
    // Only the Host stops: the project and the worktrees stay where they are.
    await f.t.host.close()
    expect((await f.audits()).map(entry => entry.action).filter(action => action.startsWith('worktree.'))).toEqual(['worktree.remove'])

    const again = await startTestHost({ ...f.agentOnly, dataDir, workspaceRoot })
    hosts.push(again)
    const owner = await again.enroll({ listener: 'unix' })
    expect(await owner.json(`tasks/${sessionId}/worktree/remove`, { method: 'POST', body: { requestId: randomUUID() } })).toEqual({
      removed: true,
      discarded: 0,
      branch: 'kept',
    })
    expect((await summaryOf(owner, sessionId)).worktree?.removed).toBe(true)
    const results = (await f.audits()).filter(entry => entry.action === 'worktree.result')
    expect(results).toHaveLength(1)
    expect(results[0]!.detail).toMatchObject({ sessionId, outcome: 'removed', branch: 'kept' })
  })

  it('keeps the worktree of a session that became private after its start private as a leftover once it is deleted', async () => {
    const f = await fixture()
    const { sessionId } = (await (await f.start(f.owner)).json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await summaryOf(f.owner, sessionId)).status).toBe('idle'), SLOW)
    const name = (await summaryOf(f.owner, sessionId)).cwd!.split('/').at(-1)!
    // Private only now, after the worktree was bound.
    const record = f.t.host.bridge.sessionRecord.bind(f.t.host.bridge)
    const spy = vi.spyOn(f.t.host.bridge, 'sessionRecord').mockImplementation(id => {
      const found = record(id)
      return found && { ...found, private: true }
    })
    onTestFinished(() => {
      vi.restoreAllMocks()
    })
    expect((await f.owner.request(`tasks/${sessionId}`, { method: 'DELETE' })).status).toBe(200)
    spy.mockRestore()
    const work = await f.t.enroll({ scopes: ['view', 'run'] })
    await f.owner.json(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    const seen = (await work.json<{ worktrees: LatchWorktree[] }>(`workspaces/${f.workspaceId}/worktrees`)).worktrees.find(
      item => item.name === name,
    )!
    expect(seen).toMatchObject({ state: 'leftover', reusable: false })
    expect(seen.branch).toBeUndefined()
    expect(await (await f.start(work, { worktree: { from: 'reuse', name } })).json()).toMatchObject({ error: 'worktree-reuse-held' })
    expect((await f.start(f.owner, { worktree: { from: 'reuse', name } })).status).toBe(201)
  })

  it('refuses to remove a worktree while any session’s terminal works in a folder inside it', async () => {
    const launch: LaunchTerminal = (_spec, onEvent) => {
      onEvent({ type: 'started', pid: 1 })
      return {
        pendingInput: 0,
        input() {},
        resize() {},
        signal() {},
        pauseOutput() {},
        resumeOutput() {},
        close() {
          onEvent({ type: 'exit', signal: 1 })
          onEvent({ type: 'gone' })
          return Promise.resolve()
        },
      }
    }
    const f = await fixture({}, { terminal: { launch, shell: { file: '/bin/sh', argv: ['sh'] } } })
    const { sessionId } = (await (await f.start(f.owner)).json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await summaryOf(f.owner, sessionId)).status).toBe('idle'), SLOW)
    const cwd = (await summaryOf(f.owner, sessionId)).cwd!
    // Another project whose folder lies inside the worktree, with a session and a terminal of its own.
    const inner = join(cwd, 'pkg')
    await mkdir(inner)
    const { workspace } = (await (await f.owner.addFolders({ paths: [inner] })).json()) as { workspace: { id: string } }
    const other = (await (await f.start(f.owner, { workspaceId: workspace.id, worktree: undefined })).json()) as { sessionId: string }
    await vi.waitFor(async () => expect((await summaryOf(f.owner, other.sessionId)).status).toBe('idle'), SLOW)
    expect((await f.owner.request(`tasks/${other.sessionId}/terminals`, { body: { cols: 80, rows: 24 } })).status).toBe(201)
    const refused = await f.owner.request(`tasks/${sessionId}/worktree/remove`, { method: 'POST', body: { requestId: randomUUID() } })
    expect(await refused.json()).toMatchObject({ error: 'worktree-terminal-open' })
    expect(existsSync(cwd)).toBe(true)
  })
})
