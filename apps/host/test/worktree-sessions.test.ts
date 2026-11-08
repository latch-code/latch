import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { TaskDetail, TaskSummary } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { findGit } from '../src/changes/git.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

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
async function fixture(agentEnv: Record<string, string> = {}) {
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
  const t = await startTestHost({
    demo: false,
    commandDirectories: () => [bin],
    detectPreset: preset => (preset.id === 'qwen' ? { found: true, path: join(bin, 'qwen') } : { found: false }),
  })
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
  }
}

const summaryOf = async (owner: TestDevice, sessionId: string) => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary

describe.skipIf(!git)('sessions in a new worktree', () => {
  it('starts in a worktree beside the start directory, fingerprinted on its own configuration, and keeps the project', async () => {
    const f = await fixture()
    const head = f.run('rev-parse', 'HEAD').trim()
    expect(await f.owner.json(`workspaces/${f.workspaceId}/worktree`)).toEqual({ branch: 'main', commit: head })

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

  it('leaves no worktree or branch behind when the start is refused after it was made', async () => {
    const f = await fixture()
    const untracked = [{ root: f.folderId, path: 'new.txt' }]
    // Untracked, so it is in the project folder and not in the worktree, where the session would read it.
    const response = await f.start(f.owner, { fileRefs: untracked })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'file-reference-refused' })
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
})
