import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSnapshotStore, type RuntimeState, type StoredTask } from '@latch/core'
import { afterEach, expect, test } from 'vitest'
import { withGeneralHomeSessions } from '../src/agent-home-sessions.ts'
import { SessionMetaStore } from '../src/session-meta.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'latch-home-sessions-'))
  roots.push(directory)
  const store = () => createSnapshotStore(join(directory, 'sessions'))
  const meta = await SessionMetaStore.open(directory)
  return { directory, store, meta }
}

function task(id: string, cwd: string, general = false): StoredTask {
  const updatedAt = '2026-11-26T10:00:00.000Z'
  return {
    summary: {
      id,
      title: id,
      updatedAt,
      status: 'idle',
      cwd,
      folders: [{ id: 'primary', path: cwd }],
      ...(general ? { generalChat: true as const } : {}),
    },
    messages: [{ id, role: 'user', text: cwd }],
    history: [{ role: 'user', content: cwd }],
    revision: 2,
  }
}

test('moves General’s Standard session working directories and keeps history and receipts across restarts', async () => {
  const { directory, store, meta } = await fixture()
  const from = join(directory, 'workspace', 'helpers', 'general')
  const other = join(directory, 'other', 'helpers', 'general')
  const to = join(directory, 'agent-homes', 'general')
  const active = task('active', from, true)
  const archived = task('archived', from)
  const automation = task('automation', from)
  const ordinary = task('ordinary', from)
  const custom = task('custom', from)
  const unrelated = task('unrelated', other, true)
  await meta.update('archived', () => ({ archived: true, generalChat: true, sessionFolder: 'helpers/general' }))
  await meta.update('automation', () => ({ automationId: 'schedule', sessionFolder: 'helpers/general' }))
  await meta.update('custom', () => ({
    agent: { customAgentId: 'other' },
    automationId: 'other-schedule',
    sessionFolder: 'helpers/general',
  }))
  const before: RuntimeState = {
    version: 1,
    tasks: { active, archived, automation, ordinary, custom, unrelated },
    receipts: { original: { taskId: 'active', payloadHash: 'original-receipt' } },
  }
  const initial = store()
  try {
    await initial.load()
    await initial.commit(before)
  } finally {
    await initial.close()
  }

  await withGeneralHomeSessions(directory, async sessions => {
    expect(sessions.paths('helpers/general')).toEqual([from, other])
    expect(sessions.paths('helpers/general-1234abcd')).toEqual([])
    await sessions.move('helpers/general', from, to)
    expect(sessions.paths('helpers/general')).toEqual([other])
  })
  await withGeneralHomeSessions(directory, sessions => sessions.move('helpers/general', from, to))
  const reopened = store()
  try {
    const migrated = await reopened.load()
    expect(migrated.receipts).toEqual(before.receipts)
    for (const original of [active, archived, automation]) {
      expect(migrated.tasks[original.summary.id]).toEqual({
        ...original,
        summary: { ...original.summary, cwd: to, folders: [{ id: 'primary', path: to }] },
      })
    }
    expect(migrated.tasks.ordinary).toEqual(ordinary)
    expect(migrated.tasks.custom).toEqual(custom)
    expect(migrated.tasks.unrelated).toEqual(unrelated)
  } finally {
    await reopened.close()
  }
  expect((await SessionMetaStore.open(directory)).get('archived')).toEqual({
    archived: true,
    generalChat: true,
    sessionFolder: 'helpers/general',
  })
})

test('shares the runtime single-writer lock', async () => {
  const { directory, store } = await fixture()
  const running = store()
  try {
    await running.load()
    await expect(withGeneralHomeSessions(directory, async () => {})).rejects.toMatchObject({ code: 'store-in-use' })
  } finally {
    await running.close()
  }
})
