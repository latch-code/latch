import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  splitChangeNote,
  type ChangeList,
  type ChangeReceipt,
  type DiscardPreview,
  type OutputsCleanupPreview,
  type OutputsCleanupResult,
  type RewindPreview,
  type RewindReceipt,
  type SessionOutputsList,
  type TaskDetail,
  type TurnChanges,
} from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { AuditLog } from '../src/audit.ts'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.close()
})

const SLOW = { timeout: 15_000 }

/** A Host with the fake agent, and one settled `shell-edit` turn in a Git work tree. */
async function fixture(options: TestHostOptions = {}) {
  const t = await startTestHost(options)
  hosts.push(t)
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
      cwd: t.workspaceRoot,
      env: { PATH: process.env.PATH, HOME: t.root, GIT_CONFIG_NOSYSTEM: '1' },
      stdio: 'pipe',
    })
  git('init', '-q', '-b', 'main')
  await writeFile(join(t.workspaceRoot, 'tracked.txt'), 'committed\n')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  const owner = await t.enroll({ listener: 'unix' })
  const agentLog = join(t.root, 'agent.log')
  const saved = await owner.confirmed('agents', {
    method: 'POST',
    body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_LOG: agentLog } },
  })
  expect(saved.status).toBe(201)
  const created = await owner.confirmed('tasks', {
    method: 'POST',
    body: { prompt: 'shell-edit', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
  })
  expect(created.status).toBe(201)
  const { sessionId } = (await created.json()) as { sessionId: string }
  const path = `tasks/${sessionId}/changes`
  const turns = async () => (await owner.json<{ turns: TurnChanges[] }>(`${path}/turns`)).turns
  await expect.poll(async () => (await turns()).at(-1)?.state, SLOW).toBe('settled')
  const turnId = (await turns()).at(-1)!.turnId
  const file = (name: string) => join(t.workspaceRoot, name)
  return { t, owner, sessionId, path, turns, turnId, file, agentLog, git }
}

const undo = (owner: TestDevice, sessionId: string, turnId: string, action = 'undo', requestId = randomUUID()) =>
  owner.request(`tasks/${sessionId}/turns/${turnId}/${action}`, { method: 'POST', body: { requestId } })

async function audited(t: TestHost): Promise<string[]> {
  const log = await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8')
  return log
    .trim()
    .split('\n')
    .map(line => (JSON.parse(line) as { action: string }).action)
    .filter(action => action.startsWith('change.'))
}

describe('changes routes', () => {
  it('stamps a turn with the clock of its messages, which is how the page finds a turn its record', async () => {
    const clock = Date.parse('2026-03-01T08:00:00Z')
    const { owner, sessionId, turns } = await fixture({ clock: () => clock })
    expect(new Date(clock).toISOString()).toBe((await turns()).at(-1)!.startedAt)
    const { messages } = await owner.json<TaskDetail>(`tasks/${sessionId}`)
    expect(messages.find(message => message.role === 'user')?.createdAt).toBe((await turns()).at(-1)!.startedAt)
  })

  it('keeps a first turn in the project the session belongs to, not only in the default one', async () => {
    const t = await startTestHost()
    hosts.push(t)
    const owner = await t.enroll({ listener: 'unix' })
    const saved = await owner.confirmed('agents', {
      method: 'POST',
      body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT] },
    })
    expect(saved.status).toBe(201)
    const folder = await mkdtemp(join(tmpdir(), 'latch-changes-project-'))
    try {
      const { id: workspaceId } = ((await (await owner.addFolders({ paths: [folder] })).json()) as { workspace: { id: string } }).workspace
      const created = await owner.confirmed('tasks', {
        method: 'POST',
        body: { prompt: 'shell-edit', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId },
      })
      expect(created.status).toBe(201)
      const { sessionId } = (await created.json()) as { sessionId: string }
      const turns = async () => (await owner.json<{ turns: TurnChanges[] }>(`tasks/${sessionId}/changes/turns`)).turns
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('idle')
      await expect.poll(async () => (await turns()).at(-1)?.state, SLOW).toBe('settled')
      const list = await owner.json<ChangeList>(`tasks/${sessionId}/changes?scope=turn`)
      expect(list.files.map(file => file.path)).toEqual(['agent-edit.txt', 'command-edit.txt'])
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  it('announces the feature and lists a turn with what a command changed', async () => {
    const { owner, path, turnId } = await fixture()
    const snapshot = await owner.json<{ catalog: { features: { changes?: true } } }>('snapshot')
    expect(snapshot.catalog.features.changes).toBe(true)
    const list = await owner.json<ChangeList>(`${path}?scope=turn&turn=${turnId}`)
    expect(list.files).toEqual([
      { root: 'default', path: 'agent-edit.txt', status: 'A', add: 1, del: 0 },
      { root: 'default', path: 'command-edit.txt', status: 'A', add: 1, del: 0, byCommand: true },
    ])
    expect(list.undo).toEqual({ available: true })
    const detail = await owner.json<{ hunks: Array<{ lines: Array<{ text: string; byCommand?: true }> }> }>(
      `${path}/file?scope=turn&root=default&path=command-edit.txt`,
    )
    expect(detail.hunks[0]!.lines[0]).toMatchObject({ text: 'written by a command', byCommand: true })
    const patch = await owner.json<{ text: string; files: number }>(`${path}/patch?scope=turn`)
    expect(patch.files).toBe(2)
    expect(patch.text).toContain('+written by a command')
    const uncommitted = await owner.json<ChangeList>(`${path}?scope=uncommitted`)
    expect(uncommitted.files.map(item => item.path)).toEqual(['agent-edit.txt', 'command-edit.txt'])
    expect((await owner.request(`${path}?scope=nope`)).status).toBe(400)
  })

  it('refuses a device without the rights, before the session is looked at', async () => {
    const { t, sessionId, path, turnId } = await fixture()
    const widen = (device: TestDevice) =>
      t.host.security.devices.setScopes(device.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'], dataScope: 'work' })
    // Diffs show files no message mentioned, so they are for devices that may browse the folders.
    const narrow = await viewer.request(`${path}?scope=turn`)
    expect(narrow.status).toBe(403)
    expect(((await narrow.json()) as { error: string }).error).toBe('file-scope')
    await widen(viewer)
    expect((await viewer.request(`${path}?scope=turn`)).status).toBe(200)
    expect((await undo(viewer, sessionId, turnId)).status).toBe(403)
    const body = { scope: 'uncommitted', confirm: 'a'.repeat(64) }
    expect((await viewer.request(`${path}/discard`, { method: 'POST', body })).status).toBe(403)
    // Discarding work that is not one turn's stays on this computer.
    const remote = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'] })
    await widen(remote)
    expect((await remote.request(`${path}/discard`, { method: 'POST', body })).status).toBe(403)
    expect((await remote.request(`${path}/discard/preview`, { method: 'POST', body: {} })).status).toBe(403)
    expect(await audited(t)).toEqual([])
  })

  it('takes a discard of uncommitted changes only from this computer, on a session other devices may write to', async () => {
    const { t, owner, file } = await fixture()
    await writeFile(file('tracked.txt'), 'changed\n')
    // A Standard session has no rule of its own against remote input, so here only the route's own check refuses.
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: 'hello', requestId: randomUUID(), mode: 'chat', workspaceId: 'default' },
    })
    await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, SLOW).toBe('idle')
    const path = `tasks/${sessionId}/changes`
    const remote = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'] })
    await t.host.security.devices.setScopes(remote.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
    const errorOf = async (response: Response) => ({ status: response.status, error: ((await response.json()) as { error: string }).error })

    // This device may write to the session: a discard within a turn gets as far as looking for the turn.
    const turn = { scope: 'turn', turnId: 'no-such-turn', files: [{ root: 'default', path: 'tracked.txt' }] }
    expect(await errorOf(await remote.request(`${path}/discard`, { method: 'POST', body: turn }))).toEqual({
      status: 404,
      error: 'change-turn-missing',
    })

    const { planHash } = await owner.json<DiscardPreview>(`${path}/discard/preview`, { method: 'POST', body: {} })
    const localOnly = { status: 403, error: 'local-only' }
    expect(await errorOf(await remote.request(`${path}/discard/preview`, { method: 'POST', body: {} }))).toEqual(localOnly)
    const body = { scope: 'uncommitted', confirm: planHash }
    expect(await errorOf(await remote.request(`${path}/discard`, { method: 'POST', body }))).toEqual(localOnly)
    expect(await readFile(file('tracked.txt'), 'utf8')).toBe('changed\n')
    expect(await audited(t)).toEqual([])
  })

  it('tells the engine with the next message, and an undo followed by its redo tells nothing', async () => {
    const { t, owner, sessionId, turnId, file, agentLog } = await fixture()
    const first = (await (await undo(owner, sessionId, turnId)).json()) as ChangeReceipt
    expect(first).toMatchObject({ action: 'undo', removed: 2, skipped: 0, notRestored: [], notCovered: [], noteNextTurn: true })
    expect(existsSync(file('agent-edit.txt'))).toBe(false)
    expect(existsSync(file('command-edit.txt'))).toBe(false)
    const redone = (await (await undo(owner, sessionId, turnId, 'redo')).json()) as ChangeReceipt
    expect(redone).toMatchObject({ action: 'redo', restored: 2, noteNextTurn: false })
    expect(await readFile(file('command-edit.txt'), 'utf8')).toBe('written by a command\n')

    const requestId = randomUUID()
    const again = await undo(owner, sessionId, turnId, 'undo', requestId)
    expect(again.status).toBe(200)
    const replay = (await (await undo(owner, sessionId, turnId, 'undo', requestId)).json()) as ChangeReceipt
    expect(replay.replay).toBe(true)
    expect(await audited(t)).toEqual(['change.undo', 'change.redo', 'change.undo'])

    const prompt = { prompt: 'echo hello', requestId: randomUUID() }
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: prompt })
    // A retry of that message carries the same words, or the driver would refuse the request ID.
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: prompt })
    const opener = async () => (await t.host.bridge.detail(sessionId)).messages.findLast(message => message.role === 'user')?.text ?? ''
    await expect.poll(opener, SLOW).toContain('echo hello')
    const { note, text } = splitChangeNote(await opener())
    expect(text).toBe('echo hello')
    expect(note).toContain('用户撤销了 1 轮改动')
    await expect.poll(() => readFile(agentLog, 'utf8').catch(() => ''), SLOW).toContain('用户撤销了 1 轮改动')

    // Told once: the message after it carries nothing.
    await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, SLOW).toBe('idle')
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'echo again', requestId: randomUUID() } })
    await expect.poll(opener, SLOW).toBe('echo again')
  })

  it('leaves a slash command as sent, and tells the engine with the next plain message', async () => {
    const { t, owner, sessionId, turnId } = await fixture()
    expect((await undo(owner, sessionId, turnId)).status).toBe(200)
    const opener = async () => (await t.host.bridge.detail(sessionId)).messages.findLast(message => message.role === 'user')?.text ?? ''
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: '/status now', requestId: randomUUID() } })
    await expect.poll(opener, SLOW).toBe('/status now')
    await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, SLOW).toBe('idle')
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'echo hello', requestId: randomUUID() } })
    await expect.poll(opener, SLOW).toContain('echo hello')
    expect(splitChangeNote(await opener()).note).toContain('用户撤销了 1 轮改动')
  })

  it('sends a message without its note once the note takes too long, and a retry carries the same words', async () => {
    const { t, owner, sessionId } = await fixture()
    let aborted = false
    t.host.bridge.notePrompts(async (_sessionId, _requestId, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()))
      aborted = true
      return 'too late'
    }, 20)
    const prompt = { prompt: 'echo hello', requestId: randomUUID() }
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: prompt })
    await expect.poll(() => aborted, SLOW).toBe(true)
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: prompt })
    const opener = async () => (await t.host.bridge.detail(sessionId)).messages.findLast(message => message.role === 'user')?.text
    await expect.poll(opener, SLOW).toBe('echo hello')
  })

  it('refuses a discard of uncommitted changes until it is confirmed for exactly these files', async () => {
    const { t, owner, path, file } = await fixture()
    await writeFile(file('tracked.txt'), 'changed\n')
    const refused = await owner.request(`${path}/discard`, { method: 'POST', body: { scope: 'uncommitted' } })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toBe('change-confirm-required')
    expect(existsSync(file('agent-edit.txt'))).toBe(true)

    const preview = await owner.json<DiscardPreview>(`${path}/discard/preview`, { method: 'POST', body: {} })
    expect(preview).toMatchObject({ restore: 1, remove: 2, skipped: 0 })
    expect(preview.removes.map(item => item.path)).toEqual(['agent-edit.txt', 'command-edit.txt'])
    expect(preview.warning).toContain('删除 2 个')
    expect(preview.warning).toContain('未跟踪')
    expect(preview.warning).toContain('无法撤销')

    await writeFile(file('tracked.txt'), 'changed again\n')
    const stale = await owner.request(`${path}/discard`, { method: 'POST', body: { scope: 'uncommitted', confirm: preview.planHash } })
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { error: string }).error).toBe('change-confirm-stale')
    expect(await readFile(file('tracked.txt'), 'utf8')).toBe('changed again\n')
    expect(await audited(t)).toEqual([])

    const current = await owner.json<DiscardPreview>(`${path}/discard/preview`, { method: 'POST', body: {} })
    const done = await owner.json<{ restored: number; removed: number; noteNextTurn: boolean }>(`${path}/discard`, {
      method: 'POST',
      body: { scope: 'uncommitted', confirm: current.planHash },
    })
    expect(done).toMatchObject({ restored: 1, removed: 2, noteNextTurn: true })
    expect(await readFile(file('tracked.txt'), 'utf8')).toBe('committed\n')
    expect(existsSync(file('command-edit.txt'))).toBe(false)
    expect(await audited(t)).toEqual(['change.discard'])
  })

  it('marks the message that opened a turn, so the conversation can reach that turn', async () => {
    const { owner, sessionId, turnId } = await fixture()
    const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
    expect(detail.messages.find(message => message.role === 'user')?.turnId).toBe(turnId)
  })

  it('refuses to discard uncommitted changes in the middle of a merge, and draws what it found', async () => {
    const { t, owner, path, file, git } = await fixture()
    git('add', '.')
    git('commit', '-q', '-m', 'turn')
    git('checkout', '-q', '-b', 'side', 'HEAD~1')
    await writeFile(file('tracked.txt'), 'side\n')
    git('commit', '-q', '-am', 'side')
    git('checkout', '-q', 'main')
    await writeFile(file('tracked.txt'), 'main\n')
    git('commit', '-q', '-am', 'main')
    expect(() => git('merge', 'side')).toThrow()
    await writeFile(file('untracked.txt'), 'mine\n')
    const before = await audited(t)

    const list = await owner.json<ChangeList>(`${path}?scope=uncommitted`)
    expect(list.conflict).toEqual({ operation: 'merge', files: 1 })
    expect(list.files.find(item => item.path === 'tracked.txt')).toMatchObject({ conflicted: true })
    const preview = await owner.request(`${path}/discard/preview`, { method: 'POST', body: {} })
    expect(preview.status).toBe(409)
    expect(((await preview.json()) as { error: string }).error).toBe('change-git-conflict')
    const discard = await owner.request(`${path}/discard`, { method: 'POST', body: { scope: 'uncommitted', confirm: '0'.repeat(64) } })
    expect(discard.status).toBe(409)
    expect(((await discard.json()) as { error: string }).error).toBe('change-git-conflict')
    expect(existsSync(file('untracked.txt'))).toBe(true)
    expect(await audited(t)).toEqual(before)
  })

  it('notes on both turns that another session worked in the same folder, and not on later ones', async () => {
    const { owner, path, sessionId, turns } = await fixture()
    const held = await owner.confirmed('tasks', {
      method: 'POST',
      body: { prompt: 'hang', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
    })
    expect(held.status).toBe(201)
    const other = ((await held.json()) as { sessionId: string }).sessionId
    const otherPath = `tasks/${other}/changes`
    await expect.poll(async () => (await owner.json<{ turns: TurnChanges[] }>(`${otherPath}/turns`)).turns.length, SLOW).toBe(1)
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'echo beside', requestId: randomUUID() } })
    await expect.poll(async () => (await turns()).at(-1)?.otherSessions, SLOW).toEqual([other])
    await expect.poll(async () => (await owner.json<ChangeList>(`${otherPath}?scope=turn`)).otherSessions, SLOW).toEqual([sessionId])
    expect((await owner.json<ChangeList>(`${path}?scope=session`)).otherSessions).toEqual([other])
    expect((await turns()).at(0)?.otherSessions).toBeUndefined()
  })

  it('writes nothing when the audit record cannot be written', async () => {
    const { owner, sessionId, turnId, file } = await fixture()
    vi.spyOn(AuditLog.prototype, 'append').mockRejectedValue(new Error('disk full'))
    expect((await undo(owner, sessionId, turnId)).status).toBeGreaterThanOrEqual(500)
    expect(existsSync(file('agent-edit.txt'))).toBe(true)
  })

  it('refuses to write while the session runs, and takes a run a stop left open as interrupted when the Host next starts', async () => {
    const dirs = await mkdtemp(join(tmpdir(), 'latch-changes-routes-'))
    const dataDir = join(dirs, 'data'),
      workspaceRoot = join(dirs, 'workspace')
    await mkdir(workspaceRoot)
    try {
      const { t, owner, sessionId, path, turnId } = await fixture({ dataDir, workspaceRoot })
      const listed = async (device: TestDevice) => (await device.json<{ turns: TurnChanges[] }>(`${path}/turns`)).turns
      await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'hang', requestId: randomUUID() } })
      await expect.poll(async () => (await listed(owner)).at(-1)?.state, SLOW).toBe('running')
      const blocked = await undo(owner, sessionId, turnId)
      expect(blocked.status).toBe(409)
      expect(((await blocked.json()) as { error: string }).error).toBe('change-running')
      await t.close()
      hosts.length = 0
      const next = await startTestHost({ dataDir, workspaceRoot })
      hosts.push(next)
      const device = await next.enroll({ listener: 'unix' })
      await expect.poll(async () => (await listed(device)).at(-1), SLOW).toMatchObject({ state: 'settled' })
    } finally {
      for (const host of hosts.splice(0)) await host.close()
      await rm(dirs, { recursive: true, force: true })
    }
  })
})

describe('putting the files back to before a message (从这里编辑)', () => {
  it('previews and writes from a message, audited first, for a device that may write the session and see its files', async () => {
    const { t, owner, sessionId, path, file, turnId } = await fixture()
    const { messages } = await owner.json<TaskDetail>(`tasks/${sessionId}`)
    const first = messages.find(message => message.role === 'user')!
    expect(first.turnId).toBe(turnId)
    const narrow = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'], dataScope: 'work' })
    const refused = await narrow.request(`${path}/rewind/preview`, { method: 'POST', body: { messageId: first.id } })
    expect(refused.status).toBe(403)
    const viewer = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    await t.host.security.devices.setScopes(viewer.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')
    expect((await viewer.request(`${path}/rewind/preview`, { method: 'POST', body: { messageId: first.id } })).status).toBe(403)
    const preview = await owner.json<RewindPreview>(`${path}/rewind/preview`, { method: 'POST', body: { messageId: first.id } })
    expect(preview).toMatchObject({ available: true, remove: 2 })
    if (!preview.available) throw new Error('unavailable')
    const missing = await owner.request(`${path}/rewind/preview`, { method: 'POST', body: { messageId: 'nope' } })
    expect(((await missing.json()) as { error: string }).error).toBe('change-message-missing')
    const stale = await owner.request(`${path}/rewind`, {
      method: 'POST',
      body: { messageId: first.id, requestId: randomUUID(), confirm: 'f'.repeat(64) },
    })
    expect(((await stale.json()) as { error: string }).error).toBe('change-confirm-stale')
    expect(existsSync(file('agent-edit.txt'))).toBe(true)
    const requestId = randomUUID()
    const receipt = await owner.json<RewindReceipt>(`${path}/rewind`, {
      method: 'POST',
      body: { messageId: first.id, requestId, confirm: preview.planHash },
    })
    expect(receipt).toMatchObject({ messageId: first.id, removed: 2 })
    expect(existsSync(file('agent-edit.txt'))).toBe(false)
    expect(existsSync(file('command-edit.txt'))).toBe(false)
    expect(await audited(t)).toEqual(['change.rewind'])
  })
})

describe('splitChangeNote', () => {
  it('leaves a message without a note alone', () => {
    expect(splitChangeNote('hello')).toEqual({ text: 'hello' })
    expect(splitChangeNote('[Latch] 说明\n\nhello')).toEqual({ note: '[Latch] 说明', text: 'hello' })
  })
})

describe('gitignored turn filtering and generated outputs cleanup', () => {
  it('omits gitignored artifacts from turn changes while listing and safely cleaning unchanged outputs', async () => {
    let workspace = ''
    const t = await startTestHost({
      demo: false,
      plugins: [
        {
          id: 'outputs-fixture',
          name: 'Fixture',
          version: '1',
          description: '',
          activate(ctx) {
            ctx.registerProvider({
              id: 'writer',
              name: 'Fixture',
              model: 'fixture',
              async *stream() {
                await new Promise(resolve => setTimeout(resolve, 40))
                await mkdir(join(workspace, 'test-results', 'shots'), { recursive: true })
                await mkdir(join(workspace, 'docs'), { recursive: true })
                await writeFile(join(workspace, 'src-added.ts'), 'export const x = 1\n')
                await writeFile(join(workspace, 'test-results', 'shots', 'one.png'), 'png-bytes-1')
                await writeFile(join(workspace, 'test-results', 'shots', 'edited.png'), 'png-bytes-2')
                await writeFile(join(workspace, 'docs', 'guide.html'), '<h1>Guide</h1>')
                yield { type: 'text', text: '生成完毕。' }
                yield { type: 'finish', reason: 'stop' }
              },
            })
          },
        },
      ],
    })
    hosts.push(t)
    workspace = t.workspaceRoot
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
        cwd: t.workspaceRoot,
        env: { PATH: process.env.PATH, HOME: t.root, GIT_CONFIG_NOSYSTEM: '1' },
        stdio: 'pipe',
      })
    git('init', '-q', '-b', 'main')
    await writeFile(join(t.workspaceRoot, '.gitignore'), '/test-results/\n')
    await writeFile(join(t.workspaceRoot, 'tracked.txt'), 'committed\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')

    const owner = await t.enroll({ listener: 'loopback-tcp', scopes: ['view', 'run'] })
    await t.host.security.devices.setScopes(owner.id, { dataScope: 'all' }, { listener: 'unix' }, 'lpc-local')

    const created = await owner.request('tasks', {
      method: 'POST',
      body: {
        prompt: 'run e2e',
        requestId: randomUUID(),
        mode: 'agent',
        workspaceId: 'default',
        model: { providerId: 'writer', model: 'fixture' },
      },
    })
    expect(created.status).toBe(201)
    const { sessionId } = (await created.json()) as { sessionId: string }

    await expect
      .poll(async () => (await owner.json<{ turns: TurnChanges[] }>(`tasks/${sessionId}/changes/turns`)).turns.at(-1)?.state, SLOW)
      .toBe('settled')
    await expect
      .poll(
        async () =>
          (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.some(m => (m.outputs?.length ?? 0) >= 3 && !m.outputsPending),
        SLOW,
      )
      .toBe(true)

    // 1. Turn changes exclude `/test-results/` while keeping unignored files (`src-added.ts`, `docs/guide.html`).
    const turnList = await owner.json<ChangeList>(`tasks/${sessionId}/changes?scope=turn`)
    expect(turnList.files.map(item => item.path)).toEqual(['docs/guide.html', 'src-added.ts'])

    // Modify one generated screenshot after the turn settled: cleanup must refuse to delete it!
    await writeFile(join(t.workspaceRoot, 'test-results', 'shots', 'edited.png'), 'user-annotated-bytes')

    // 2. Outputs endpoint classifies gitIgnored vs unignored and detects post-turn modification.
    const outputs = await owner.json<SessionOutputsList>(`tasks/${sessionId}/outputs`)
    expect(outputs.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'test-results/shots/one.png', gitIgnored: true, exists: true, removable: true }),
        expect.objectContaining({
          path: 'test-results/shots/edited.png',
          gitIgnored: true,
          exists: true,
          changedSince: true,
          removable: false,
        }),
        expect.objectContaining({ path: 'docs/guide.html', exists: true, removable: true }),
      ]),
    )
    expect(outputs.files.some(item => item.path === 'src-added.ts')).toBe(false)

    // 3. Preview and execute cleanup (including an arbitrary non-output file `tracked.txt`, which must be skipped!).
    const wanted = [
      { root: 'default', path: 'test-results/shots/one.png' },
      { root: 'default', path: 'test-results/shots/edited.png' },
      { root: 'default', path: 'tracked.txt' },
    ]
    const preview = await owner.json<OutputsCleanupPreview>(`tasks/${sessionId}/outputs/cleanup/preview`, {
      method: 'POST',
      body: { files: wanted },
    })
    expect(preview.remove).toBe(1)
    expect(preview.removes).toEqual([{ root: 'default', path: 'test-results/shots/one.png' }])
    expect(preview.skipped).toBe(2)
    expect(preview.notRemoved).toEqual(
      expect.arrayContaining([
        { root: 'default', path: 'test-results/shots/edited.png', reason: 'changed-since' },
        { root: 'default', path: 'tracked.txt', reason: 'not-retained' },
      ]),
    )

    const requestId = randomUUID()
    const cleaned = await owner.json<OutputsCleanupResult>(`tasks/${sessionId}/outputs/cleanup`, {
      method: 'POST',
      body: { files: wanted, confirm: preview.planHash, requestId },
    })
    expect(cleaned).toMatchObject({ removed: 1, skipped: 2 })
    expect(existsSync(join(t.workspaceRoot, 'test-results', 'shots', 'one.png'))).toBe(false)
    expect(existsSync(join(t.workspaceRoot, 'test-results', 'shots', 'edited.png'))).toBe(true)
    expect(existsSync(join(t.workspaceRoot, 'tracked.txt'))).toBe(true)

    // Replay with the same requestId returns the cached receipt without failing on stale hash.
    const replay = await owner.json<OutputsCleanupResult>(`tasks/${sessionId}/outputs/cleanup`, {
      method: 'POST',
      body: { files: wanted, confirm: preview.planHash, requestId },
    })
    expect(replay).toMatchObject({ removed: 1, skipped: 2, replay: true })

    // Delete the remaining unmodified deliverable `docs/guide.html` and verify its empty parent directory `docs/` is pruned!
    const docPreview = await owner.json<OutputsCleanupPreview>(`tasks/${sessionId}/outputs/cleanup/preview`, {
      method: 'POST',
      body: { files: [{ root: 'default', path: 'docs/guide.html' }] },
    })
    expect(docPreview.remove).toBe(1)
    await owner.json<OutputsCleanupResult>(`tasks/${sessionId}/outputs/cleanup`, {
      method: 'POST',
      body: { files: [{ root: 'default', path: 'docs/guide.html' }], confirm: docPreview.planHash, requestId: randomUUID() },
    })
    expect(existsSync(join(t.workspaceRoot, 'docs'))).toBe(false)
    expect(await audited(t)).toEqual(['change.outputs-clean', 'change.outputs-clean'])
  }, 30_000)
})
