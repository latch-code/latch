import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RECEIPT_TTL_MS,
  RECEIPTS_PER_DEVICE,
  SESSION_META_FILE,
  SessionMetaStore,
  type ApprovalRecord,
  type CancelRecord,
} from '../src/session-meta.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'lt-meta-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

const T0 = Date.parse('2026-10-25T08:00:00.000Z')
const DEVICE = 'dev_AAAAAAAAAAAAAAAAAAAAAA'
const OTHER = 'dev_BBBBBBBBBBBBBBBBBBBBBB'

function approval(approvalId: string, at = T0, deviceId = DEVICE): ApprovalRecord {
  return {
    kind: 'approval',
    approvalId,
    requestId: `request-${approvalId}`,
    deviceId,
    decision: 'allow',
    optionId: 'allow_once',
    optionKind: 'allow_once',
    at: new Date(at).toISOString(),
  }
}

function cancel(requestId: string, at = T0): CancelRecord {
  return {
    kind: 'cancel',
    requestId,
    deviceId: DEVICE,
    runId: 'run-1',
    outcome: 'stopped',
    status: 'cancelled',
    at: new Date(at).toISOString(),
  }
}

async function stored(directory: string): Promise<{ version: number; sessions: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(join(directory, SESSION_META_FILE), 'utf8'))
}

describe('session store receipts', () => {
  it('keeps receipts with their session across a reopen, and removes them with the session', async () => {
    const directory = await dataDir()
    const store = await SessionMetaStore.open(directory, { now: () => T0 })
    await store.update('task-a', meta => ({ ...meta, title: '标题' }))
    await store.record('task-a', approval('approval-1'))
    await store.record('task-a', cancel('cancel-0001'))
    await store.record('task-b', approval('approval-2'))
    expect(await stored(directory)).toEqual({
      version: 1,
      sessions: [
        { id: 'task-a', title: '标题', receipts: [approval('approval-1'), cancel('cancel-0001')] },
        { id: 'task-b', receipts: [approval('approval-2')] },
      ],
    })

    const reopened = await SessionMetaStore.open(directory, { now: () => T0 })
    expect(reopened.get('task-a')).toEqual({ title: '标题' })
    expect(reopened.approval('approval-1')).toEqual({ sessionId: 'task-a', record: approval('approval-1') })
    expect(reopened.cancel('task-a', DEVICE, 'cancel-0001')).toEqual(cancel('cancel-0001'))
    expect(reopened.cancel('task-a', OTHER, 'cancel-0001')).toBeUndefined()
    expect(reopened.cancel('task-b', DEVICE, 'cancel-0001')).toBeUndefined()
    expect(reopened.has('task-b')).toBe(true)

    await reopened.remove('task-a')
    expect(reopened.approval('approval-1')).toBeUndefined()
    expect(reopened.cancel('task-a', DEVICE, 'cancel-0001')).toBeUndefined()
    expect(reopened.has('task-a')).toBe(false)
    expect(await stored(directory)).toEqual({ version: 1, sessions: [{ id: 'task-b', receipts: [approval('approval-2')] }] })
  })

  it('reads a file written before receipts existed, and leaves out receipts it cannot read', async () => {
    const directory = await dataDir()
    await writeFile(join(directory, SESSION_META_FILE), JSON.stringify({ version: 1, sessions: [{ id: 'task-a', pinned: true }] }))
    const legacy = await SessionMetaStore.open(directory, { now: () => T0 })
    expect(legacy.get('task-a')).toEqual({ pinned: true })
    expect(legacy.approval('approval-1')).toBeUndefined()

    const later = { kind: 'prompt', requestId: 'prompt-0001', deviceId: DEVICE, at: new Date(T0).toISOString() }
    const damaged = { ...approval('approval-2'), decision: 'maybe' }
    await writeFile(
      join(directory, SESSION_META_FILE),
      JSON.stringify({ version: 1, sessions: [{ id: 'task-a', pinned: true, receipts: [later, damaged, approval('approval-3')] }] }),
    )
    const logs: string[] = []
    const mixed = await SessionMetaStore.open(directory, { now: () => T0, log: text => logs.push(text) })
    expect(mixed.approval('approval-3')?.record).toEqual(approval('approval-3'))
    expect(mixed.approval('approval-2')).toBeUndefined()
    expect(logs).toEqual(['会话设置文件中有 2 条无法识别的回执，已忽略'])
    await mixed.update('task-a', meta => ({ ...meta, archived: true }))
    expect((await stored(directory)).sessions).toEqual([{ id: 'task-a', pinned: true, archived: true, receipts: [approval('approval-3')] }])

    await writeFile(join(directory, SESSION_META_FILE), JSON.stringify({ version: 1, sessions: [{ id: 'task-a', receipts: 'none' }] }))
    await expect(SessionMetaStore.open(directory)).rejects.toMatchObject({ code: 'config-corrupt' })
  })

  it('forgets receipts after 7 days and keeps at most 10,000 per device, oldest first', async () => {
    const directory = await dataDir()
    const time = { now: T0 + RECEIPT_TTL_MS }
    const many = Array.from({ length: RECEIPTS_PER_DEVICE + 1 }, (_, index) => approval(`approval-${index}`, T0 + 1 + index))
    await writeFile(
      join(directory, SESSION_META_FILE),
      JSON.stringify({
        version: 1,
        sessions: [
          { id: 'task-old', receipts: [approval('expired', T0 - 1, OTHER)] },
          { id: 'task-many', receipts: many },
        ],
      }),
    )
    const store = await SessionMetaStore.open(directory, { now: () => time.now })
    expect(store.approval('expired')).toBeUndefined()
    expect(store.approval('approval-0')).toBeUndefined()
    expect(store.approval('approval-1')).toBeDefined()
    expect(store.approval(`approval-${RECEIPTS_PER_DEVICE}`)).toBeDefined()

    await store.record('task-other', approval('other-device', time.now, OTHER))
    expect(store.approval('approval-1')).toBeDefined()
    await store.record('task-many', approval('newest', time.now))
    expect(store.approval('approval-1')).toBeUndefined()
    expect(store.approval('approval-2')).toBeDefined()
    expect(store.approval('other-device')).toBeDefined()

    time.now += 4
    expect(store.approval('approval-2')).toBeUndefined()
    expect(store.approval('approval-3')).toBeDefined()
    expect(store.approval('newest')).toBeDefined()
  })

  it('answers from memory at once, and a receipt whose write failed goes into the next write', async () => {
    const directory = await dataDir()
    const store = await SessionMetaStore.open(directory, { now: () => T0 })
    // A directory in the file's place makes the rename fail.
    await mkdir(join(directory, SESSION_META_FILE))
    const failing = store.record('task-a', approval('approval-1'))
    expect(store.approval('approval-1')?.record).toEqual(approval('approval-1'))
    await expect(failing).rejects.toThrow()
    expect(store.approval('approval-1')?.record).toEqual(approval('approval-1'))
    await rmdir(join(directory, SESSION_META_FILE))
    await store.record('task-a', approval('approval-2'))
    expect((await stored(directory)).sessions).toEqual([{ id: 'task-a', receipts: [approval('approval-1'), approval('approval-2')] }])
  })

  it('writes receipts recorded while a write is queued in that one write, and a later receipt in a new one', async () => {
    const directory = await dataDir()
    const store = await SessionMetaStore.open(directory, { now: () => T0 })
    const together = Array.from({ length: 20 }, (_, index) => store.record(`task-${index}`, approval(`approval-${index}`)))
    expect(new Set(together).size).toBe(1)
    await Promise.all(together)
    expect((await stored(directory)).sessions).toHaveLength(20)
    const later = store.record('task-late', approval('approval-late'))
    expect(later).not.toBe(together[0])
    await later
    const reopened = await SessionMetaStore.open(directory, { now: () => T0 })
    expect(reopened.approval('approval-0')?.sessionId).toBe('task-0')
    expect(reopened.approval('approval-late')?.sessionId).toBe('task-late')
  })

  it('reopens a file with sessions that hold only receipts beside the most sessions with metadata', async () => {
    const directory = await dataDir()
    const sessions = [
      ...Array.from({ length: 100_000 }, (_, index) => ({ id: `task-${index}`, pinned: true })),
      { id: 'task-receipts', receipts: [approval('approval-1')] },
    ]
    await writeFile(join(directory, SESSION_META_FILE), JSON.stringify({ version: 1, sessions }))
    const store = await SessionMetaStore.open(directory, { now: () => T0 })
    expect(store.get('task-99999')).toEqual({ pinned: true })
    expect(store.approval('approval-1')?.sessionId).toBe('task-receipts')
  })
})
