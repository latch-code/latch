import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileDiff } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { ChangesEngine, type ChangeLimits, type ChangesSession } from '../src/changes/engine.ts'
import { findGit } from '../src/changes/git.ts'
import type { ChangeWritePlan } from '../src/changes/types.ts'

const git = findGit()
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function fixture(limits: Partial<ChangeLimits> = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'latch-changes-engine-')))
  cleanup.push(() => rm(base, { recursive: true, force: true }))
  const dataDir = join(base, 'data'),
    project = join(base, 'project')
  await mkdir(dataDir, { mode: 0o700 })
  await mkdir(project)
  const excluded: string[][] = []
  const open = () =>
    ChangesEngine.open({
      dataDir,
      protectedPaths: [dataDir],
      git: git ?? false,
      limits,
      clone: async (source, target) => writeFile(target, await readFile(source)),
      excludeFromBackup: async paths => excluded.push(paths),
    })
  const engine = await open()
  cleanup.push(() => engine.close())
  const session: ChangesSession = { id: 'session-1', projectId: 'project-1', folders: [{ id: 'main', path: project }] }
  const plans: ChangeWritePlan[] = []
  const beforeWrite = async (plan: ChangeWritePlan) => {
    plans.push(plan)
  }
  return { base, dataDir, project, engine, session, plans, beforeWrite, excluded, open, file: (path: string) => join(project, path) }
}

describe('per-turn snapshots and the turn scope', () => {
  it('keeps snapshots private and out of backups, lists a running turn against now, and attributes a settled one', async () => {
    const f = await fixture()
    await writeFile(f.file('agent.ts'), 'one\ntwo\n')
    await writeFile(f.file('script.ts'), 'a\n')
    await f.engine.beginTurn({ session: f.session, turnId: 'run-1' })
    expect((await stat(join(f.dataDir, 'snapshots'))).mode & 0o777).toBe(0o700)
    expect(f.excluded).toEqual([[join(f.dataDir, 'snapshots')]])
    await writeFile(f.file('agent.ts'), 'one\nTWO\nlater\n')
    await writeFile(f.file('script.ts'), 'a\nb\n')
    await writeFile(f.file('made.ts'), 'new\n')
    const running = await f.engine.list({ session: f.session, scope: 'turn' })
    expect(running).toMatchObject({ turnId: 'run-1', running: true, undo: { available: false, reason: 'running' } })
    expect(running.files.map(file => [file.path, file.status])).toEqual([
      ['agent.ts', 'M'],
      ['made.ts', 'A'],
      ['script.ts', 'M'],
    ])
    // The agent's edit names agent.ts (absolute, as ACP agents write) and made.ts (relative, as Latch's tools write);
    // `later` and script.ts came from a command.
    await f.engine.settleTurn({
      session: f.session,
      turnId: 'run-1',
      outcome: 'completed',
      edits: [
        { path: f.file('agent.ts'), oldText: 'two\n', newText: 'TWO\n' },
        { path: 'made.ts', newText: 'new\n', previous: 'none' },
      ],
    })
    const settled = await f.engine.list({ session: f.session, scope: 'turn', turnId: 'run-1' })
    expect(settled.files).toEqual([
      { root: 'main', path: 'agent.ts', status: 'M', add: 2, del: 1, byCommand: true },
      { root: 'main', path: 'made.ts', status: 'A', add: 1, del: 0 },
      { root: 'main', path: 'script.ts', status: 'M', add: 1, del: 0, byCommand: true },
    ])
    expect(settled.totals).toEqual({ files: 3, add: 4, del: 1 })
    expect(settled.undo).toEqual({ available: true })
    const detail = await f.engine.file({ session: f.session, scope: 'turn', file: { root: 'main', path: 'agent.ts' } })
    expect(detail.hunks![0]!.lines.filter(line => line.kind !== 'context').map(line => [line.text, line.byCommand ?? false])).toEqual([
      ['two', false],
      ['TWO', false],
      ['later', true],
    ])
    expect(await f.engine.turns({ session: f.session })).toMatchObject([{ turnId: 'run-1', state: 'settled', files: 3 }])
  })

  it('writes a patch that git apply turns from the turn’s start into its end', async () => {
    const f = await fixture()
    await mkdir(f.file('src'))
    await writeFile(f.file('src/a.ts'), 'keep\nold\n')
    await writeFile(f.file('gone.txt'), 'bye\n')
    await f.engine.beginTurn({ session: f.session, turnId: 'run-1' })
    const start = join(f.base, 'start')
    execFileSync('/bin/cp', ['-R', f.project, start])
    await writeFile(f.file('src/a.ts'), 'keep\nnew\n')
    await rm(f.file('gone.txt'))
    await writeFile(f.file('added.txt'), 'hi')
    await f.engine.settleTurn({ session: f.session, turnId: 'run-1', outcome: 'completed' })
    const patch = await f.engine.patch({ session: f.session, scope: 'turn' })
    expect([patch.files, patch.omitted]).toEqual([3, 0])
    if (!git) return
    await writeFile(join(f.base, 'turn.diff'), patch.text)
    execFileSync(git, ['apply', join(f.base, 'turn.diff')], { cwd: start, env: { PATH: '/usr/bin:/bin', HOME: f.base } })
    expect(await readFile(join(start, 'src/a.ts'), 'utf8')).toBe('keep\nnew\n')
    expect(await readFile(join(start, 'added.txt'), 'utf8')).toBe('hi')
    expect(existsSync(join(start, 'gone.txt'))).toBe(false)
  })
})

describe('撤销本轮 and 恢复', () => {
  async function turned() {
    const f = await fixture()
    await writeFile(f.file('edit.txt'), 'before\n')
    await writeFile(f.file('gone.txt'), 'deleted by the turn\n')
    await chmod(f.file('edit.txt'), 0o755)
    await f.engine.beginTurn({ session: f.session, turnId: 'run-1' })
    await writeFile(f.file('edit.txt'), 'after\n')
    await rm(f.file('gone.txt'))
    await writeFile(f.file('made.txt'), 'created by the turn\n')
    await f.engine.settleTurn({ session: f.session, turnId: 'run-1', outcome: 'completed' })
    return f
  }

  it('puts the turn’s files back after recording the plan, replays a retried request, and redoes it', async () => {
    const f = await turned()
    const receipt = await f.engine.undoTurn({
      session: f.session,
      turnId: 'run-1',
      requestId: 'undo-request-1',
      beforeWrite: f.beforeWrite,
    })
    expect(receipt).toMatchObject({ action: 'undo', restored: 2, removed: 1, skipped: 0 })
    expect(await readFile(f.file('edit.txt'), 'utf8')).toBe('before\n')
    expect((await stat(f.file('edit.txt'))).mode & 0o777).toBe(0o755)
    expect(await readFile(f.file('gone.txt'), 'utf8')).toBe('deleted by the turn\n')
    expect(existsSync(f.file('made.txt'))).toBe(false)
    // The audit record names counts and a hash only.
    expect(f.plans).toEqual([
      {
        action: 'undo',
        sessionId: 'session-1',
        turnId: 'run-1',
        scope: 'turn',
        restore: 2,
        remove: 1,
        skipped: 0,
        planHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    ])
    expect(JSON.stringify(f.plans)).not.toContain('edit.txt')
    expect(
      await f.engine.undoTurn({ session: f.session, turnId: 'run-1', requestId: 'undo-request-1', beforeWrite: f.beforeWrite }),
    ).toEqual({
      ...receipt,
      replay: true,
    })
    expect(f.plans).toHaveLength(1)
    const list = await f.engine.list({ session: f.session, scope: 'turn' })
    expect(list).toMatchObject({ undone: true, undo: { available: false, reason: 'undone' }, redo: { available: true } })
    await expect(
      f.engine.undoTurn({ session: f.session, turnId: 'run-1', requestId: 'undo-request-2', beforeWrite: f.beforeWrite }),
    ).rejects.toMatchObject({
      code: 'change-undone',
    })
    await f.engine.redoTurn({ session: f.session, turnId: 'run-1', requestId: 'redo-request-1', beforeWrite: f.beforeWrite })
    expect(await readFile(f.file('edit.txt'), 'utf8')).toBe('after\n')
    expect(await readFile(f.file('made.txt'), 'utf8')).toBe('created by the turn\n')
    expect(existsSync(f.file('gone.txt'))).toBe(false)
  })

  it('writes nothing when the audit fails, and refuses once a file changed after the turn', async () => {
    const f = await turned()
    await expect(
      f.engine.undoTurn({
        session: f.session,
        turnId: 'run-1',
        requestId: 'undo-request-1',
        beforeWrite: () => Promise.reject(new Error('audit failed')),
      }),
    ).rejects.toThrow('audit failed')
    expect(await readFile(f.file('edit.txt'), 'utf8')).toBe('after\n')
    await writeFile(f.file('edit.txt'), 'edited again\n')
    expect((await f.engine.list({ session: f.session, scope: 'turn' })).undo).toEqual({ available: false, reason: 'changed-since' })
    await expect(
      f.engine.undoTurn({ session: f.session, turnId: 'run-1', requestId: 'undo-request-2', beforeWrite: f.beforeWrite }),
    ).rejects.toMatchObject({ code: 'change-files-changed', message: '之后又改过这些文件。' })
    // 撤销此文件 for another file of the turn still works.
    expect(
      await f.engine.discard({
        session: f.session,
        target: { scope: 'turn', turnId: 'run-1', files: [{ root: 'main', path: 'gone.txt' }] },
        beforeWrite: f.beforeWrite,
      }),
    ).toEqual({ restored: 1, removed: 0, skipped: 0, notRestored: [], noteNextTurn: true })
  })

  it('refuses while a turn runs, and never writes through a directory swapped for a symlink', async () => {
    const f = await fixture()
    await mkdir(f.file('src'))
    await writeFile(f.file('src/a.txt'), 'before\n')
    await f.engine.beginTurn({ session: f.session, turnId: 'run-1' })
    await writeFile(f.file('src/a.txt'), 'after\n')
    await f.engine.settleTurn({ session: f.session, turnId: 'run-1', outcome: 'completed' })
    await f.engine.beginTurn({ session: f.session, turnId: 'run-2' })
    await expect(
      f.engine.undoTurn({ session: f.session, turnId: 'run-1', requestId: 'undo-request-1', beforeWrite: f.beforeWrite }),
    ).rejects.toMatchObject({
      code: 'change-running',
    })
    await f.engine.settleTurn({ session: f.session, turnId: 'run-2', outcome: 'completed' })
    const outside = join(f.base, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'a.txt'), 'after\n')
    await rename(f.file('src'), join(f.base, 'moved'))
    await symlink(outside, f.file('src'))
    await expect(
      f.engine.undoTurn({ session: f.session, turnId: 'run-1', requestId: 'undo-request-2', beforeWrite: f.beforeWrite }),
    ).rejects.toMatchObject({
      code: 'change-path-refused',
    })
    expect(await readFile(join(outside, 'a.txt'), 'utf8')).toBe('after\n')
    expect(await readdir(outside)).toEqual(['a.txt'])
  })
})

describe('the session scope', () => {
  it('composes the turns with the person’s changes between them, and drops a file changed and changed back', async () => {
    const f = await fixture()
    await writeFile(f.file('a.txt'), 'a1\n')
    await writeFile(f.file('b.txt'), 'b1\n')
    await f.engine.beginTurn({ session: f.session, turnId: 'run-1' })
    await writeFile(f.file('a.txt'), 'a2\n')
    await writeFile(f.file('b.txt'), 'b2\n')
    await f.engine.settleTurn({
      session: f.session,
      turnId: 'run-1',
      outcome: 'completed',
      edits: [{ path: 'a.txt', oldText: 'a1\n', newText: 'a2\n' }],
    })
    await writeFile(f.file('b.txt'), 'b1\n')
    await writeFile(f.file('c.txt'), 'by hand\n')
    await f.engine.beginTurn({ session: f.session, turnId: 'run-2' })
    await f.engine.settleTurn({ session: f.session, turnId: 'run-2', outcome: 'completed', edits: [] })
    const list = await f.engine.list({ session: f.session, scope: 'session' })
    expect(list.files).toEqual([
      { root: 'main', path: 'a.txt', status: 'M', add: 1, del: 1 },
      { root: 'main', path: 'c.txt', status: 'A', add: 1, del: 0, byUser: true },
    ])
  })
})

describe('retention and recovery', () => {
  it('keeps the latest turns per session and removes content nothing refers to', async () => {
    const f = await fixture({ turnsPerSession: 2 })
    const objects = async () => {
      const directory = join(f.dataDir, 'snapshots', (await readdir(join(f.dataDir, 'snapshots')))[0]!, 'objects')
      let count = 0
      for (const name of await readdir(directory)) if (/^[0-9a-f]{2}$/u.test(name)) count += (await readdir(join(directory, name))).length
      return count
    }
    for (let turn = 1; turn <= 4; turn++) {
      await writeFile(f.file('a.txt'), `version ${turn}\n`)
      await f.engine.beginTurn({ session: f.session, turnId: `run-${turn}` })
      await writeFile(f.file('a.txt'), `version ${turn} edited\n`)
      await f.engine.settleTurn({ session: f.session, turnId: `run-${turn}`, outcome: 'completed' })
    }
    expect((await f.engine.turns({ session: f.session })).map(turn => turn.turnId)).toEqual(['run-3', 'run-4'])
    expect(await objects()).toBe(4)
  })

  it('drops the oldest turns to stay within the project cap and records over-cap files without content', async () => {
    const f = await fixture({ projectBytes: 64 })
    await writeFile(f.file('a.txt'), 'x'.repeat(30))
    await f.engine.beginTurn({ session: f.session, turnId: 'run-1' })
    await writeFile(f.file('a.txt'), 'y'.repeat(30))
    await f.engine.settleTurn({ session: f.session, turnId: 'run-1', outcome: 'completed' })
    await writeFile(f.file('a.txt'), 'z'.repeat(30))
    await f.engine.beginTurn({ session: f.session, turnId: 'run-2' })
    await writeFile(f.file('a.txt'), 'w'.repeat(30))
    await f.engine.settleTurn({ session: f.session, turnId: 'run-2', outcome: 'completed' })
    expect((await f.engine.turns({ session: f.session })).map(turn => turn.turnId)).toEqual(['run-2'])
    const list = await f.engine.list({ session: f.session, scope: 'turn' })
    expect(list.files).toMatchObject([{ path: 'a.txt', status: 'M' }])
  })

  it('settles a turn a stopped Host left running as interrupted, and forgets a deleted session', async () => {
    const f = await fixture()
    await writeFile(f.file('a.txt'), 'before\n')
    await f.engine.beginTurn({ session: f.session, turnId: 'run-1' })
    await writeFile(f.file('a.txt'), 'after\n')
    await f.engine.close()
    const restarted = await f.open()
    cleanup.push(() => restarted.close())
    expect(await restarted.turns({ session: f.session })).toMatchObject([{ turnId: 'run-1', state: 'interrupted' }])
    await restarted.recover()
    expect(await restarted.turns({ session: f.session })).toMatchObject([{ turnId: 'run-1', state: 'settled', files: 1 }])
    expect((await restarted.list({ session: f.session, scope: 'turn' })).files[0]).not.toHaveProperty('byCommand')
    await restarted.deleteSession({ id: f.session.id, projectId: f.session.projectId })
    expect(await restarted.turns({ session: f.session })).toEqual([])
    const project = (await readdir(join(f.dataDir, 'snapshots')))[0]!
    expect(await readdir(join(f.dataDir, 'snapshots', project, 'sessions'))).toEqual([])
  })

  it('settles a turn whose settlement never came as interrupted when the next one starts', async () => {
    const f = await fixture()
    await writeFile(f.file('a.txt'), 'before\n')
    await f.engine.beginTurn({ session: f.session, turnId: 'run-1' })
    await writeFile(f.file('a.txt'), 'after\n')
    await f.engine.beginTurn({ session: f.session, turnId: 'run-1' })
    await f.engine.beginTurn({ session: f.session, turnId: 'run-2' })
    expect(await f.engine.turns({ session: f.session })).toMatchObject([
      { turnId: 'run-1', state: 'settled', files: 1 },
      { turnId: 'run-2', state: 'running' },
    ])
  })

  it('rejects malformed sessions, scopes, turns and request IDs', async () => {
    const f = await fixture()
    await expect(f.engine.list({ session: { ...f.session, projectId: '../x' }, scope: 'turn' })).rejects.toMatchObject({
      code: 'change-session-invalid',
    })
    await expect(f.engine.list({ session: f.session, scope: 'everything' as never })).rejects.toMatchObject({
      code: 'change-scope-invalid',
    })
    await expect(f.engine.beginTurn({ session: f.session, turnId: '../../x' })).rejects.toMatchObject({ code: 'change-turn-invalid' })
    await expect(
      f.engine.undoTurn({ session: f.session, turnId: 'run-1', requestId: 'x', beforeWrite: f.beforeWrite }),
    ).rejects.toMatchObject({
      code: 'change-request-invalid',
    })
    expect(await f.engine.list({ session: f.session, scope: 'session' })).toMatchObject({ unavailable: 'no-turns', files: [] })
  })
})

describe.skipIf(!git)('撤销全部改动 for uncommitted changes', () => {
  it('restores tracked files from HEAD, removes untracked ones, and leaves secret-looking files alone', async () => {
    const f = await fixture()
    const run = (...args: string[]) =>
      execFileSync(git!, ['-c', 'user.name=Latch', '-c', 'user.email=latch@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
        cwd: f.project,
        env: { PATH: '/usr/bin:/bin', HOME: f.base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      })
    run('init', '-q')
    await writeFile(f.file('tracked.txt'), 'committed\n')
    await writeFile(f.file('removed.txt'), 'committed too\n')
    run('add', '-A')
    run('commit', '-qm', 'init')
    await writeFile(f.file('tracked.txt'), 'edited\n')
    await rm(f.file('removed.txt'))
    await writeFile(f.file('untracked.txt'), 'new\n')
    await writeFile(f.file('.env.local'), 'TOKEN=value\n')
    const listed = await f.engine.list({ session: f.session, scope: 'uncommitted' })
    expect(listed.files.map(file => [file.path, file.status, file.secret ?? false])).toEqual([
      ['.env.local', 'A', true],
      ['removed.txt', 'D', false],
      ['tracked.txt', 'M', false],
      ['untracked.txt', 'A', false],
    ])
    const writes = vi.fn(f.beforeWrite)
    expect(await f.engine.discard({ session: f.session, target: { scope: 'uncommitted' }, beforeWrite: writes })).toEqual({
      restored: 2,
      removed: 1,
      skipped: 1,
      notRestored: [{ root: 'main', path: '.env.local', reason: 'secret' }],
      noteNextTurn: true,
    })
    expect(writes).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'discard', scope: 'uncommitted', restore: 2, remove: 1, skipped: 1 }),
    )
    expect(await readFile(f.file('tracked.txt'), 'utf8')).toBe('committed\n')
    expect(await readFile(f.file('removed.txt'), 'utf8')).toBe('committed too\n')
    expect(existsSync(f.file('untracked.txt'))).toBe(false)
    expect(await readFile(f.file('.env.local'), 'utf8')).toBe('TOKEN=value\n')
  })
})

/** Runs one prompt through the fake ACP agent over stdio and returns the session updates it sent. */
async function promptFakeAgent(cwd: string, text: string): Promise<Array<Record<string, unknown>>> {
  const child = spawn(process.execPath, [FAKE_ACP_AGENT], { cwd, stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } })
  const updates: Array<Record<string, unknown>> = [],
    waiting = new Map<number, (result: unknown) => void>()
  let buffered = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk
    for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
      const message = JSON.parse(buffered.slice(0, end)) as {
        id?: number
        method?: string
        params?: { update: Record<string, unknown> }
        result?: unknown
      }
      buffered = buffered.slice(end + 1)
      if (message.method === 'session/update') updates.push(message.params!.update)
      else if (message.method === undefined && message.id !== undefined) waiting.get(message.id)?.(message.result)
    }
  })
  const request = (id: number, method: string, params: unknown) =>
    new Promise<unknown>(resolve => {
      waiting.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  try {
    await request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = (await request(2, 'session/new', { cwd, mcpServers: [] })) as { sessionId: string }
    await request(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
  } finally {
    child.stdin.end()
  }
  return updates
}

describe('an agent’s own edit and a command’s, from the fake ACP agent', () => {
  it('records both, and marks only the one the agent did not report as 由命令修改', async () => {
    const f = await fixture()
    await f.engine.beginTurn({ session: f.session, turnId: 'run-1' })
    const updates = await promptFakeAgent(f.project, 'shell-edit')
    expect(await readFile(f.file('agent-edit.txt'), 'utf8')).toBe('edited by the agent\n')
    expect(await readFile(f.file('command-edit.txt'), 'utf8')).toBe('written by a command\n')
    const edits: FileDiff[] = updates.flatMap(update =>
      (Array.isArray(update.content) ? (update.content as Array<Record<string, unknown>>) : [])
        .filter(item => item.type === 'diff')
        .map(item => ({
          path: item.path as string,
          newText: item.newText as string,
          ...(typeof item.oldText === 'string' ? { oldText: item.oldText } : { previous: 'none' as const }),
        })),
    )
    expect(edits).toHaveLength(1)
    await f.engine.settleTurn({ session: f.session, turnId: 'run-1', outcome: 'completed', edits })
    expect((await f.engine.list({ session: f.session, scope: 'turn' })).files).toEqual([
      { root: 'main', path: 'agent-edit.txt', status: 'A', add: 1, del: 0 },
      { root: 'main', path: 'command-edit.txt', status: 'A', add: 1, del: 0, byCommand: true },
    ])
  })
})

describe('what an undo could not reach', () => {
  it('names files not kept and edits no snapshot covers, and the note counts them', async () => {
    const f = await fixture()
    await writeFile(f.file('.env.local'), 'TOKEN=before\n')
    await writeFile(f.file('kept.txt'), 'before\n')
    await f.engine.beginTurn({ session: f.session, turnId: 'run-1' })
    await writeFile(f.file('.env.local'), 'TOKEN=after\n')
    await writeFile(f.file('kept.txt'), 'after\n')
    const outside = '/somewhere/else/file.txt'
    const edits: FileDiff[] = [
      { path: outside, newText: 'x' },
      { path: 'node_modules/pkg/index.js', newText: 'x' },
      { path: f.file('kept.txt'), oldText: 'before\n', newText: 'after\n' },
    ]
    await f.engine.settleTurn({ session: f.session, turnId: 'run-1', outcome: 'completed', edits })
    expect((await f.engine.list({ session: f.session, scope: 'turn' })).notCovered).toEqual([outside, 'node_modules/pkg/index.js'])
    const receipt = await f.engine.undoTurn({ session: f.session, turnId: 'run-1', requestId: 'request-one', beforeWrite: f.beforeWrite })
    expect(receipt).toMatchObject({
      restored: 1,
      skipped: 1,
      notRestored: [{ root: 'main', path: '.env.local', reason: 'secret' }],
      notCovered: [outside, 'node_modules/pkg/index.js'],
      noteNextTurn: true,
    })
    const note = await f.engine.noteFor({ session: f.session, requestId: 'message-1' })
    expect(note).toContain('用户撤销了 1 轮改动')
    expect(note).toContain('有 1 个文件')
    expect((await f.engine.turns({ session: f.session })).at(-1)?.notePending).toBe(true)
    // Another attempt with a new request ID, before any turn began, still owes the note.
    expect(await f.engine.noteFor({ session: f.session, requestId: 'message-2' })).toBe(note)
    await f.engine.beginTurn({ session: f.session, turnId: 'run-2' })
    // A retry of the message that started it gets the same words, and any other message none.
    expect(await f.engine.noteFor({ session: f.session, requestId: 'message-2' })).toBe(note)
    expect(await f.engine.noteFor({ session: f.session, requestId: 'message-3' })).toBeUndefined()
  })
})

describe('a file whose content was not kept', () => {
  const SECRET = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')

  it('is never removed or overwritten, in either direction, and the rest of the turn still goes back and forth', async () => {
    const f = await fixture()
    await writeFile(f.file('edited-to-secret.txt'), 'before\n')
    await f.engine.beginTurn({ session: f.session, turnId: 'run-1' })
    await writeFile(f.file('.env.local'), 'TOKEN=created\n')
    await writeFile(f.file('edited-to-secret.txt'), SECRET)
    await writeFile(f.file('kept.txt'), 'created\n')
    await f.engine.settleTurn({ session: f.session, turnId: 'run-1', outcome: 'completed' })

    const undone = await f.engine.undoTurn({ session: f.session, turnId: 'run-1', requestId: 'request-undo', beforeWrite: f.beforeWrite })
    expect(undone).toMatchObject({
      restored: 0,
      removed: 1,
      skipped: 2,
      notRestored: [
        { root: 'main', path: '.env.local', reason: 'secret' },
        { root: 'main', path: 'edited-to-secret.txt', reason: 'secret' },
      ],
    })
    expect(await readFile(f.file('.env.local'), 'utf8')).toBe('TOKEN=created\n')
    expect(await readFile(f.file('edited-to-secret.txt'), 'utf8')).toBe(SECRET)
    expect(existsSync(f.file('kept.txt'))).toBe(false)

    const redone = await f.engine.redoTurn({ session: f.session, turnId: 'run-1', requestId: 'request-redo', beforeWrite: f.beforeWrite })
    expect(redone).toMatchObject({ restored: 1, removed: 0, skipped: 2 })
    expect(await readFile(f.file('kept.txt'), 'utf8')).toBe('created\n')
    expect(await readFile(f.file('edited-to-secret.txt'), 'utf8')).toBe(SECRET)
  })

  it('refuses an undo with nothing it may touch, and does not call the turn undone', async () => {
    const f = await fixture()
    await f.engine.beginTurn({ session: f.session, turnId: 'run-1' })
    await writeFile(f.file('.env.local'), 'TOKEN=created\n')
    await f.engine.settleTurn({ session: f.session, turnId: 'run-1', outcome: 'completed' })

    const listed = await f.engine.list({ session: f.session, scope: 'turn' })
    expect(listed.undo).toEqual({ available: false, reason: 'not-retained' })
    await expect(
      f.engine.undoTurn({ session: f.session, turnId: 'run-1', requestId: 'request-undo', beforeWrite: f.beforeWrite }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'change-not-retained',
    })
    expect(f.plans).toEqual([])
    expect(await readFile(f.file('.env.local'), 'utf8')).toBe('TOKEN=created\n')
    const [turn] = await f.engine.turns({ session: f.session })
    expect(turn).not.toHaveProperty('undone')
    expect(turn).not.toHaveProperty('notePending')
    expect(await f.engine.noteFor({ session: f.session, requestId: 'message-1' })).toBeUndefined()

    // 撤销此文件 answers with the same file named, because the person picked it.
    const discarded = await f.engine.discard({
      session: f.session,
      target: { scope: 'turn', turnId: 'run-1', files: [{ root: 'main', path: '.env.local' }] },
      beforeWrite: f.beforeWrite,
    })
    expect(discarded).toMatchObject({
      removed: 0,
      skipped: 1,
      notRestored: [{ path: '.env.local', reason: 'secret' }],
      noteNextTurn: false,
    })
    expect(await readFile(f.file('.env.local'), 'utf8')).toBe('TOKEN=created\n')
  })
})

describe('the note for files written back', () => {
  async function repository() {
    const f = await fixture()
    const run = (...args: string[]) =>
      execFileSync(git!, ['-c', 'user.name=Latch', '-c', 'user.email=latch@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
        cwd: f.project,
        env: { PATH: '/usr/bin:/bin', HOME: f.base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      })
    run('init', '-q')
    await writeFile(f.file('edit.txt'), 'committed\n')
    run('add', '-A')
    run('commit', '-qm', 'init')
    return f
  }
  type Repository = Awaited<ReturnType<typeof repository>>
  const dropLoose = async (f: Repository) => {
    await writeFile(f.file('loose.txt'), 'nobody committed this\n')
    return f.engine.discard({
      session: f.session,
      target: { scope: 'uncommitted', files: [{ root: 'main', path: 'loose.txt' }] },
      beforeWrite: f.beforeWrite,
    })
  }
  const turnEditing = async (f: Repository) => {
    await f.engine.beginTurn({ session: f.session, turnId: 'run-1' })
    await writeFile(f.file('edit.txt'), 'edited\n')
    await f.engine.settleTurn({ session: f.session, turnId: 'run-1', outcome: 'completed' })
  }
  const flip = (f: Repository, action: 'undoTurn' | 'redoTurn') =>
    f.engine[action]({ session: f.session, turnId: 'run-1', requestId: `request-${action}`, beforeWrite: f.beforeWrite })

  it('survives an undo and its redo when a discard happened between them', async () => {
    const f = await repository()
    await turnEditing(f)
    await flip(f, 'undoTurn')
    expect(await dropLoose(f)).toMatchObject({ removed: 1, noteNextTurn: true })
    expect(await flip(f, 'redoTurn')).toMatchObject({ noteNextTurn: true })
    const note = await f.engine.noteFor({ session: f.session, requestId: 'message-1' })
    expect(note).toContain('用户撤销了 1 个文件的改动')
    expect(note).not.toContain('轮改动')
  })

  it('survives an undo and its redo when the discard came first', async () => {
    const f = await repository()
    await turnEditing(f)
    await dropLoose(f)
    await flip(f, 'undoTurn')
    const told = await f.engine.noteFor({ session: f.session, requestId: 'message-1' })
    expect(told).toContain('用户撤销了 1 轮改动')
    expect(told).toContain('用户撤销了 1 个文件的改动')
    expect(await flip(f, 'redoTurn')).toMatchObject({ noteNextTurn: true })
    expect(await f.engine.noteFor({ session: f.session, requestId: 'message-2' })).toContain('用户撤销了 1 个文件的改动')
  })

  it('is owed by a discard in a session with no turn, across a restart, and told once', async () => {
    const f = await repository()
    expect(await dropLoose(f)).toMatchObject({ removed: 1, noteNextTurn: true })
    await f.engine.close()
    const engine = await f.open()
    cleanup.push(() => engine.close())
    const note = await engine.noteFor({ session: f.session, requestId: 'message-1' })
    expect(note).toContain('用户撤销了 1 个文件的改动')
    await engine.beginTurn({ session: f.session, turnId: 'run-1' })
    expect(await engine.noteFor({ session: f.session, requestId: 'message-1' })).toBe(note)
    expect(await engine.noteFor({ session: f.session, requestId: 'message-2' })).toBeUndefined()
  })
})

describe('confirming a discard of uncommitted changes', () => {
  it('binds a modified tracked file too large to hash, so a later change makes the confirmation stale', async () => {
    const f = await fixture({ cloneLimit: 16 })
    const run = (...args: string[]) =>
      execFileSync(git!, ['-c', 'user.name=Latch', '-c', 'user.email=latch@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
        cwd: f.project,
        env: { PATH: '/usr/bin:/bin', HOME: f.base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      })
    run('init', '-q')
    await writeFile(f.file('big.txt'), 'committed\n')
    run('add', '-A')
    run('commit', '-qm', 'init')
    await writeFile(f.file('big.txt'), 'an edit longer than the limit\n')
    const preview = await f.engine.previewDiscard({ session: f.session })
    expect(preview.restore).toBe(1)
    expect((await f.engine.previewDiscard({ session: f.session })).planHash).toBe(preview.planHash)
    await writeFile(f.file('big.txt'), 'another edit, longer than the limit too\n')
    expect((await f.engine.previewDiscard({ session: f.session })).planHash).not.toBe(preview.planHash)
  })
})

describe('asking for a note', () => {
  it('does not wait behind other work when none is due, and gives up on a message that left without it', async () => {
    const f = await fixture()
    await f.engine.beginTurn({ session: f.session, turnId: 'run-1' })
    await writeFile(f.file('made.txt'), 'created\n')
    await f.engine.settleTurn({ session: f.session, turnId: 'run-1', outcome: 'completed' })
    let release = () => {}
    const held = new Promise<void>(resolve => (release = resolve))
    const reached = vi.fn(() => held)
    const undoing = f.engine.undoTurn({ session: f.session, turnId: 'run-1', requestId: 'request-one', beforeWrite: reached })
    await vi.waitFor(() => expect(reached).toHaveBeenCalled())
    // The queue is held by the undo; nothing is due yet, so this answers at once.
    expect(await f.engine.noteFor({ session: f.session, requestId: 'message-1' })).toBeUndefined()
    release()
    await undoing

    const gaveUp = new AbortController()
    gaveUp.abort()
    expect(await f.engine.noteFor({ session: f.session, requestId: 'message-2', signal: gaveUp.signal })).toBeUndefined()
    expect(await f.engine.noteFor({ session: f.session, requestId: 'message-3' })).toContain('用户撤销了 1 轮改动')
  })
})
