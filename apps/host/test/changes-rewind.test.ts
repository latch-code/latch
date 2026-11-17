import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChangesEngine, type ChangesSession } from '../src/changes/engine.ts'
import type { ChangeWritePlan } from '../src/changes/types.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

/** Three turns: the first edits a.txt, the second edits it again and creates b.txt, the third only reads. */
async function threeTurns() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'latch-changes-rewind-')))
  cleanup.push(() => rm(base, { recursive: true, force: true }))
  const dataDir = join(base, 'data'),
    project = join(base, 'project')
  await mkdir(dataDir, { mode: 0o700 })
  await mkdir(project)
  const engine = await ChangesEngine.open({
    dataDir,
    protectedPaths: [dataDir],
    git: false,
    clone: async (source, target) => writeFile(target, await readFile(source)),
    excludeFromBackup: async () => {},
  })
  cleanup.push(() => engine.close())
  const session: ChangesSession = { id: 'session-1', projectId: 'project-1', folders: [{ id: 'main', path: project }] }
  const file = (path: string) => join(project, path)
  const plans: ChangeWritePlan[] = []
  const beforeWrite = async (plan: ChangeWritePlan) => {
    plans.push(plan)
  }
  await writeFile(file('a.txt'), 'start\n')
  await engine.beginTurn({ session, turnId: 'run-1' })
  await writeFile(file('a.txt'), 'one\n')
  await engine.settleTurn({ session, turnId: 'run-1', outcome: 'completed' })
  await engine.beginTurn({ session, turnId: 'run-2' })
  await writeFile(file('a.txt'), 'two\n')
  await writeFile(file('b.txt'), 'made in two\n')
  await engine.settleTurn({ session, turnId: 'run-2', outcome: 'completed' })
  await engine.beginTurn({ session, turnId: 'run-3' })
  await engine.settleTurn({ session, turnId: 'run-3', outcome: 'completed' })
  return { engine, session, file, plans, beforeWrite }
}

describe('putting the files back to before a message', () => {
  it('previews and writes every turn from that message on as one plan, undoes each, replays a retry and redoes per turn', async () => {
    const f = await threeTurns()
    const turnIds = ['run-1', 'run-2', 'run-3']
    const preview = await f.engine.previewRewind({ session: f.session, turnIds })
    expect(preview).toMatchObject({
      available: true,
      restore: 1,
      remove: 1,
      skipped: 0,
      files: expect.arrayContaining([
        { root: 'main', path: 'a.txt' },
        { root: 'main', path: 'b.txt', remove: true },
      ]),
      notRestored: [],
      notCovered: [],
    })
    if (!preview.available) throw new Error('unavailable')
    const receipt = await f.engine.rewind({
      session: f.session,
      messageId: 'm1',
      turnIds,
      requestId: 'rewind-request-1',
      beforeWrite: f.beforeWrite,
    })
    expect(receipt).toMatchObject({ messageId: 'm1', restored: 1, removed: 1, skipped: 0 })
    expect(await readFile(f.file('a.txt'), 'utf8')).toBe('start\n')
    expect(existsSync(f.file('b.txt'))).toBe(false)
    // One audit record: counts and the confirmed hash, no paths.
    expect(f.plans).toEqual([expect.objectContaining({ action: 'rewind', turnId: 'run-1', planHash: preview.planHash })])
    expect(JSON.stringify(f.plans)).not.toContain('a.txt')
    expect(
      await f.engine.rewind({ session: f.session, messageId: 'm1', turnIds, requestId: 'rewind-request-1', beforeWrite: f.beforeWrite }),
    ).toEqual({ ...receipt, replay: true })
    expect(f.plans).toHaveLength(1)
    // The turns that changed files read as undone, and 恢复 brings each back, oldest first.
    const turns = await f.engine.turns({ session: f.session })
    expect(turns.filter(turn => turn.undone).map(turn => turn.turnId)).toEqual(['run-1', 'run-2'])
    await f.engine.redoTurn({ session: f.session, turnId: 'run-1', requestId: 'redo-request-1', beforeWrite: f.beforeWrite })
    await f.engine.redoTurn({ session: f.session, turnId: 'run-2', requestId: 'redo-request-2', beforeWrite: f.beforeWrite })
    expect(await readFile(f.file('a.txt'), 'utf8')).toBe('two\n')
    expect(await readFile(f.file('b.txt'), 'utf8')).toBe('made in two\n')
  })

  it('rewinds from a later message only over its own turns', async () => {
    const f = await threeTurns()
    const receipt = await f.engine.rewind({
      session: f.session,
      messageId: 'm2',
      turnIds: ['run-2', 'run-3'],
      requestId: 'rewind-request-2',
      beforeWrite: f.beforeWrite,
    })
    expect(receipt).toMatchObject({ restored: 1, removed: 1 })
    expect(await readFile(f.file('a.txt'), 'utf8')).toBe('one\n')
  })

  it('offers nothing outside the snapshots: a missing record, a change since or between turns, a running turn', async () => {
    const f = await threeTurns()
    expect(await f.engine.previewRewind({ session: f.session, turnIds: ['run-0', 'run-1'] })).toEqual({
      available: false,
      reason: 'not-recorded',
    })
    expect(await f.engine.previewRewind({ session: f.session, turnIds: ['run-3'] })).toEqual({ available: false, reason: 'no-changes' })
    await writeFile(f.file('a.txt'), 'edited by the person\n')
    expect(await f.engine.previewRewind({ session: f.session, turnIds: ['run-1', 'run-2', 'run-3'] })).toEqual({
      available: false,
      reason: 'changed-since',
    })
    await expect(
      f.engine.rewind({
        session: f.session,
        messageId: 'm1',
        turnIds: ['run-1', 'run-2', 'run-3'],
        requestId: 'rewind-request-3',
        beforeWrite: f.beforeWrite,
      }),
    ).rejects.toMatchObject({ code: 'change-files-changed' })
    expect(f.plans).toHaveLength(0)
    expect(await readFile(f.file('a.txt'), 'utf8')).toBe('edited by the person\n')
    await f.engine.beginTurn({ session: f.session, turnId: 'run-4' })
    expect(await f.engine.previewRewind({ session: f.session, turnIds: ['run-1'] })).toEqual({ available: false, reason: 'running' })
  })

  it('refuses a change made between two of the turns, which no record says how to put back', async () => {
    const f = await threeTurns()
    await f.engine.beginTurn({ session: f.session, turnId: 'run-4' })
    await f.engine.settleTurn({ session: f.session, turnId: 'run-4', outcome: 'completed' })
    // The person edits a.txt; a fifth turn changes it again.
    await writeFile(f.file('a.txt'), 'person\n')
    await f.engine.beginTurn({ session: f.session, turnId: 'run-5' })
    await writeFile(f.file('a.txt'), 'five\n')
    await f.engine.settleTurn({ session: f.session, turnId: 'run-5', outcome: 'completed' })
    expect(await f.engine.previewRewind({ session: f.session, turnIds: ['run-2', 'run-3', 'run-4', 'run-5'] })).toEqual({
      available: false,
      reason: 'changed-since',
    })
    // From after the person's edit, the record covers it.
    expect(await f.engine.previewRewind({ session: f.session, turnIds: ['run-5'] })).toMatchObject({ available: true, restore: 1 })
  })

  it('refuses a confirmation that no longer matches the files', async () => {
    const f = await threeTurns()
    await expect(
      f.engine.rewind({
        session: f.session,
        messageId: 'm1',
        turnIds: ['run-1', 'run-2', 'run-3'],
        requestId: 'rewind-request-4',
        beforeWrite: async plan => {
          if (plan.planHash !== 'f'.repeat(64)) throw Object.assign(new Error('stale'), { code: 'change-confirm-stale' })
        },
      }),
    ).rejects.toMatchObject({ code: 'change-confirm-stale' })
    expect(await readFile(f.file('a.txt'), 'utf8')).toBe('two\n')
  })
})

describe('what the rewind reads and leaves', () => {
  it('refuses a list of turns that is not the record’s own from that turn on', async () => {
    const f = await threeTurns()
    // run-2 is in the record but not named: its files would be left where it put them.
    expect(await f.engine.previewRewind({ session: f.session, turnIds: ['run-1', 'run-3'] })).toEqual({
      available: false,
      reason: 'not-recorded',
    })
    expect(await f.engine.previewRewind({ session: f.session, turnIds: ['run-2'] })).toEqual({ available: false, reason: 'not-recorded' })
  })

  it('leaves a turn whose files were all skipped as it was, and undoes only the ones it put back', async () => {
    const f = await threeTurns()
    await f.engine.beginTurn({ session: f.session, turnId: 'run-4' })
    // A file that may hold a secret is never kept, so it cannot be put back.
    await writeFile(f.file('.env'), 'TOKEN=abc\n')
    await f.engine.settleTurn({ session: f.session, turnId: 'run-4', outcome: 'completed' })
    const receipt = await f.engine.rewind({
      session: f.session,
      messageId: 'm2',
      turnIds: ['run-2', 'run-3', 'run-4'],
      requestId: 'rewind-request-5',
      beforeWrite: f.beforeWrite,
    })
    expect(receipt).toMatchObject({ restored: 1, removed: 1, skipped: 1 })
    expect(await readFile(f.file('.env'), 'utf8')).toBe('TOKEN=abc\n')
    const turns = await f.engine.turns({ session: f.session })
    expect(turns.filter(turn => turn.undone).map(turn => turn.turnId)).toEqual(['run-2'])
  })
})
