import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '@latch/sdk'
import {
  checkedPrompt,
  checkedTitle,
  itemIsPrivate,
  newWorkItemId,
  WORK_ITEMS_FILE,
  WORK_RECEIPT_TTL_MS,
  WorkItemStore,
  type WorkItemRecord,
} from '../src/work-items.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(join(root, 'work'), 0o700).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

async function dataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'latch-items-'))
  roots.push(root)
  return root
}

const T0 = Date.parse('2026-11-17T08:00:00.000Z')

function record(sessionIds: string[] = [], extra: Partial<WorkItemRecord> = {}): WorkItemRecord {
  const at = new Date(T0).toISOString()
  return {
    id: newWorkItemId(),
    title: '待办',
    prompt: '',
    sessionIds,
    startScope: 'all',
    createdAt: at,
    updatedAt: at,
    revision: 1,
    ...extra,
  }
}

function add(store: WorkItemStore, item: WorkItemRecord, receipt?: { deviceId: string; requestId: string; state?: 'pending' | 'done' }) {
  return store.transact((draft, at) => {
    draft.items.set(item.id, item)
    if (receipt)
      draft.receipts.push({
        kind: 'start',
        deviceId: receipt.deviceId,
        requestId: receipt.requestId,
        itemId: item.id,
        requestHash: 'b'.repeat(64),
        payloadHash: 'a'.repeat(64),
        state: receipt.state ?? 'pending',
        at,
      })
    return { result: item, changed: true }
  })
}

describe('the 待办 file', () => {
  it('writes 0600 in a 0700 folder and reads back what it wrote, receipts and private marks included', async () => {
    const dir = await dataDir()
    let now = T0
    const store = await WorkItemStore.open(dir, { now: () => now })
    const item = record(['task-1'])
    await add(store, item, { deviceId: 'dev-1', requestId: 'request-1' })
    await store.markPrivate(item.id)
    expect((await stat(join(dir, WORK_ITEMS_FILE))).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'work'))).mode & 0o777).toBe(0o700)
    const again = await WorkItemStore.open(dir, { now: () => now })
    expect(again.get(item.id)).toEqual({ ...item, private: true })
    expect(again.itemOf('task-1')?.id).toBe(item.id)
    expect(again.receipt('start', 'dev-1', 'request-1')).toMatchObject({ state: 'pending', itemId: item.id })
    // A receipt answers for seven days, then goes with the next write.
    now = T0 + WORK_RECEIPT_TTL_MS + 1
    expect(again.receipt('start', 'dev-1', 'request-1')).toBeUndefined()
    await add(again, record())
    expect(JSON.parse(await readFile(join(dir, WORK_ITEMS_FILE), 'utf8')).receipts).toEqual([])
  })

  it('refuses a file with a field it does not know, a session in two 待办 or one 待办 too many, and keeps it', async () => {
    const dir = await dataDir()
    await mkdir(join(dir, 'work'))
    const path = join(dir, WORK_ITEMS_FILE)
    const cases = [
      { version: 1, items: [{ ...record(), owner: 'someone' }], receipts: [] },
      { version: 1, items: [record(['task-1']), record(['task-1'])], receipts: [] },
      { version: 1, items: [record()], receipts: [], extra: true },
      { version: 1, items: [{ ...record(), status: 'doing' }], receipts: [] },
      { version: 1, items: [record(Array.from({ length: 17 }, (_, index) => `task-${index}`))], receipts: [] },
      { version: 2, items: [], receipts: [] },
      { version: 1, items: [(({ startScope: _scope, ...rest }) => rest)(record())], receipts: [] },
    ]
    for (const file of cases) {
      const text = JSON.stringify(file)
      await writeFile(path, text)
      await expect(WorkItemStore.open(dir)).rejects.toMatchObject({ status: 500, code: 'config-corrupt' })
      expect(await readFile(path, 'utf8')).toBe(text)
    }
  })

  it('leaves the state as it was when a write fails, and answers that the outcome is not known', async () => {
    const dir = await dataDir()
    const store = await WorkItemStore.open(dir)
    const first = record()
    await add(store, first)
    await chmod(join(dir, 'work'), 0o500)
    const second = record()
    await expect(add(store, second)).rejects.toMatchObject({ status: 503, code: 'item-write-unknown' })
    expect(store.get(second.id)).toBeUndefined()
    await chmod(join(dir, 'work'), 0o700)
    // The retry applies it.
    await add(store, second)
    expect((await WorkItemStore.open(dir)).list().map(item => item.id)).toEqual([first.id, second.id])
  })

  it('refuses a change that would break the file, writing nothing', async () => {
    const dir = await dataDir()
    const store = await WorkItemStore.open(dir)
    const one = record(['task-1'])
    await add(store, one)
    await expect(add(store, record(['task-1']))).rejects.toBeInstanceOf(AppError)
    expect(store.list()).toHaveLength(1)
  })

  it('takes a deleted session out of its 待办 and moves the revision', async () => {
    const dir = await dataDir()
    const store = await WorkItemStore.open(dir)
    const item = record(['task-1', 'task-2'])
    await add(store, item)
    const [left] = await store.dropSessions(new Set(['task-1', 'task-9']))
    expect(left).toMatchObject({ id: item.id, sessionIds: ['task-2'], revision: 2 })
    expect(store.itemOf('task-1')).toBeUndefined()
    expect(await store.dropSessions(new Set(['task-9']))).toEqual([])
  })
})

describe('a started session joining its 待办', () => {
  it('joins and settles the receipt in one write, or settles it outside when the 待办 is full or gone', async () => {
    const dir = await dataDir()
    const store = await WorkItemStore.open(dir)
    const item = record([])
    await add(store, item, { deviceId: 'dev-1', requestId: 'request-1' })
    const settle = (sessionId: string, requestId = 'request-1', itemId = item.id) =>
      store.settleStart({ itemId, deviceId: 'dev-1', requestId, sessionId, isPrivate: () => false })
    expect(await settle('task-1')).toBeUndefined()
    expect(store.get(item.id)).toMatchObject({ sessionIds: ['task-1'], revision: 2 })
    expect(store.receipt('start', 'dev-1', 'request-1')).toMatchObject({ state: 'done', sessionId: 'task-1' })
    expect(store.receipt('start', 'dev-1', 'request-1')).not.toHaveProperty('outside')

    const full = record(Array.from({ length: 16 }, (_, index) => `full-${index}`))
    await add(store, full, { deviceId: 'dev-1', requestId: 'request-2' })
    expect(await settle('task-2', 'request-2', full.id)).toBe('item-full')
    expect(store.get(full.id)?.sessionIds).toHaveLength(16)
    expect(store.itemOf('task-2')).toBeUndefined()
    expect(store.receipt('start', 'dev-1', 'request-2')).toMatchObject({ state: 'done', sessionId: 'task-2', outside: 'item-full' })

    const gone = record()
    await add(store, gone, { deviceId: 'dev-1', requestId: 'request-3' })
    await store.transact(draft => {
      draft.items.delete(gone.id)
      return { result: undefined, changed: true }
    })
    expect(await settle('task-3', 'request-3', gone.id)).toBe('item-gone')
    expect((await WorkItemStore.open(dir)).receipt('start', 'dev-1', 'request-3')).toMatchObject({
      state: 'done',
      sessionId: 'task-3',
      outside: 'item-gone',
    })
  })
})

describe('what a 待办 keeps', () => {
  it('keeps a one-line title and a prompt as a session’s first message, and nothing shaped like a credential', () => {
    expect(checkedTitle('  标题  ')).toBe('标题')
    for (const bad of ['', ' ', 'a\nb', 'a b', 'x'.repeat(121)])
      expect(() => checkedTitle(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'item-title-invalid' }))
    expect(() => checkedTitle('AKIAABCDEFGHIJKLMNOP')).toThrow(expect.objectContaining({ code: 'item-secret' }))
    expect(checkedPrompt(' 第一行\n第二行\t ')).toBe('第一行\n第二行')
    expect(checkedPrompt('')).toBe('')
    expect(() => checkedPrompt('x'.repeat(16_001))).toThrow(expect.objectContaining({ code: 'item-prompt-invalid' }))
    expect(() => checkedPrompt('a\u0000b')).toThrow(expect.objectContaining({ code: 'item-prompt-invalid' }))
  })

  it('is private once marked, and while any of its sessions is private', () => {
    expect(itemIsPrivate({ sessionIds: ['a', 'b'] }, id => id === 'b')).toBe(true)
    expect(itemIsPrivate({ sessionIds: [], private: true }, () => false)).toBe(true)
    expect(itemIsPrivate({ sessionIds: ['a'] }, () => false)).toBe(false)
  })
})
