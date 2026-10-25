import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileAtomic } from '@latch/core/node-kit'
import { AttachmentStore, ATTACHMENT_TTL } from '../src/attachments.ts'
const directories: string[] = []
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), 'latch-attachments-'))
  directories.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const input = (text = 'ordinary text', extra: Partial<Parameters<AttachmentStore['add']>[0]> = {}) => ({
  owner: 'device-a',
  requestId: randomUUID(),
  name: 'note.txt',
  size: Buffer.byteLength(text),
  remote: false,
  stream: (async function* () {
    yield Buffer.from(text)
  })(),
  recheck: () => {},
  accept: () => {},
  ...extra,
})
describe('private attachment store', () => {
  it('keeps original blobs recoverable after a failed bind and stops new writes until storage is reopened', async () => {
    const path = await directory()
    let failed = false
    const store = await AttachmentStore.open(path, {
        persist: async (file, text) => {
          if (failed) throw new Error('disk')
          await writeFileAtomic(file, text)
        },
      }),
      ref = await store.add(input('retained'))
    const creationRequestId = randomUUID()
    await store.claim('device-a', [ref.id], creationRequestId)
    failed = true
    await expect(store.bind('device-a', [ref.id], 'task-failed', creationRequestId)).rejects.toMatchObject({
      code: 'attachments-unavailable',
    })
    expect((await store.read(ref)).text).toBe('retained')
    await expect(store.add(input('another'))).rejects.toMatchObject({ code: 'attachments-unavailable' })
    const reopened = await AttachmentStore.open(path, { now: () => Date.now() + ATTACHMENT_TTL + 100, deferPrune: true })
    expect((await reopened.read(ref)).text).toBe('retained')
    await reopened.recoverSession('task-failed', [ref])
    await reopened.prune()
    expect(reopened.get(ref.id)?.taskId).toBe('task-failed')
    expect(reopened.refs('device-a', [ref.id], undefined, creationRequestId)).toEqual([ref])
    expect((await reopened.read(ref)).text).toBe('retained')
  })
  it('binds a draft to one device, preserves immutable hashes across a restart, and removes session blobs with the session', async () => {
    const path = await directory(),
      store = await AttachmentStore.open(path),
      requestId = randomUUID(),
      ref = await store.add(input('hello', { requestId }))
    expect(store.refs('device-a', [ref.id])).toEqual([ref])
    expect(() => store.refs('device-b', [ref.id])).toThrow('附件已过期')
    const replay = await store.add(input('hello', { requestId }))
    expect(replay).toEqual(ref)
    await expect(store.add(input('other', { requestId }))).rejects.toMatchObject({ code: 'request-conflict' })
    await store.bind('device-a', [ref.id], 'task-one')
    expect((await stat(join(path, 'attachments', 'task-one', ref.id))).mode & 0o777).toBe(0o600)
    const reopened = await AttachmentStore.open(path)
    expect(reopened.refs('device-b', [ref.id], 'task-one')).toEqual([ref])
    expect((await reopened.read(ref)).text).toBe('hello')
    expect(await readFile(join(path, 'attachments', 'index.json'), 'utf8')).not.toContain('hello')
    await expect(reopened.removeTask('..')).rejects.toThrow()
    await expect(reopened.removeTask('index.json')).rejects.toThrow()
    await reopened.removeTask('task-one')
    expect(reopened.get(ref.id)).toBeUndefined()
    await expect(stat(join(path, 'attachments', 'task-one', ref.id))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('sniffs bytes, refuses unsupported PDFs and invalid text, and only publishes after acceptance and audit', async () => {
    const path = await directory(),
      store = await AttachmentStore.open(path)
    await expect(store.add(input('%PDF-1.7'))).rejects.toMatchObject({ code: 'attachment-type-unsupported' })
    await expect(
      store.add(
        input('text', {
          name: 'secret.env',
          accept: () => {
            throw new Error('unsupported')
          },
        }),
      ),
    ).rejects.toThrow('unsupported')
    await expect(
      store.add(
        input('text', {
          audit: async () => {
            throw new Error('audit unavailable')
          },
        }),
      ),
    ).rejects.toThrow('audit unavailable')
    expect(await readdir(join(path, 'attachments', '_drafts'))).toEqual([])
    const ref = await store.add(input('plain text', { name: 'pretend.png' }))
    expect(ref.mime).toBe('text/plain')
  })
  it('rejects changed bytes, too many attachments, oversized remote uploads and interrupted or revoked streams without leaving temporary data', async () => {
    const path = await directory(),
      store = await AttachmentStore.open(path)
    await expect(store.add(input('text', { size: 11 * 1024 * 1024, remote: true }))).rejects.toMatchObject({ code: 'attachment-too-large' })
    await expect(store.add(input('text', { size: 5 }))).rejects.toMatchObject({ code: 'attachment-incomplete' })
    let checks = 0
    await expect(
      store.add(
        input('text', {
          recheck: () => {
            if (++checks === 3) throw new Error('revoked')
          },
        }),
      ),
    ).rejects.toThrow('revoked')
    expect(await readdir(join(path, 'attachments', '_drafts'))).toEqual([])
    const ref = await store.add(input('hello'))
    await writeFile(join(path, 'attachments', '_drafts', ref.id), 'other')
    await expect(store.read(ref)).rejects.toMatchObject({ code: 'attachment-changed' })
    expect(() =>
      store.refs(
        'device-a',
        Array.from({ length: 9 }, () => ref.id),
      ),
    ).toThrow('最多 8 个')
  })
  it('expires device drafts after one hour and refuses metadata corruption rather than losing existing attachments', async () => {
    const path = await directory()
    let now = 10
    const store = await AttachmentStore.open(path, { now: () => now }),
      ref = await store.add(input())
    now += ATTACHMENT_TTL
    await store.prune()
    expect(store.get(ref.id)).toBeUndefined()
    expect(await readdir(join(path, 'attachments', '_drafts'))).toEqual([])
    await writeFile(join(path, 'attachments', 'index.json'), '{bad')
    await expect(AttachmentStore.open(path)).rejects.toMatchObject({ code: 'attachments-unavailable' })
  })
  it('requires explicit acknowledgement for secret filenames and cleans up rejected uploads', async () => {
    const path = await directory(),
      store = await AttachmentStore.open(path)
    await expect(store.add(input('plain text', { name: '.env' }))).rejects.toMatchObject({ code: 'attachment-secret' })
    expect(await readdir(join(path, 'attachments', '_drafts'))).toEqual([])
    const ref = await store.add(input('plain text', { name: '.env', secretAcknowledged: true }))
    expect(store.get(ref.id)?.secret).toBe(true)
  })
  it('holds an admitted draft while creation is in flight across its original expiry', async () => {
    const path = await directory()
    let now = 10
    const store = await AttachmentStore.open(path, { now: () => now }),
      ref = await store.add(input())
    now += ATTACHMENT_TTL - 1
    expect(store.refs('device-a', [ref.id])).toEqual([ref])
    now += 2
    await store.prune()
    expect(store.get(ref.id)?.ref).toEqual(ref)
    await store.bind('device-a', [ref.id], 'task-near-expiry')
    now += ATTACHMENT_TTL * 2
    await store.prune()
    expect(store.get(ref.id)?.taskId).toBe('task-near-expiry')
  })
  it('atomically pins a draft to one create or prompt request, preserves the winner through restart and releases only a matching refusal', async () => {
    const path = await directory(),
      store = await AttachmentStore.open(path),
      ref = await store.add(input())
    const a = randomUUID(),
      b = randomUUID()
    const results = await Promise.allSettled([store.claim('device-a', [ref.id], a), store.claim('device-a', [ref.id], b, 'task-existing')])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: 'attachment-claimed' })
    await store.releaseClaim('device-a', [ref.id], b, 'task-existing')
    const reopened = await AttachmentStore.open(path)
    await expect(reopened.claim('device-a', [ref.id], b)).rejects.toMatchObject({ code: 'attachment-claimed' })
    await reopened.bind('device-a', [ref.id], 'task-created', a)
    expect(reopened.refs('device-a', [ref.id], undefined, a)).toEqual([ref])
    expect(() => reopened.refs('device-a', [ref.id], undefined, b)).toThrow('附件已过期')
    const another = await reopened.add(input('another'))
    await reopened.claim('device-a', [another.id], a, 'task-existing')
    await expect(reopened.claim('device-a', [another.id], b)).rejects.toMatchObject({ code: 'attachment-claimed' })
    await reopened.releaseClaim('device-a', [another.id], a, 'task-existing')
    await reopened.claim('device-a', [another.id], b)
    await reopened.bind('device-a', [another.id], 'task-other', b)
    const free = await reopened.add(input('free')),
      held = await reopened.add(input('held'))
    await reopened.claim('device-a', [held.id], a)
    await expect(reopened.claim('device-a', [free.id, held.id], b)).rejects.toMatchObject({ code: 'attachment-claimed' })
    await reopened.claim('device-a', [free.id], b)
  })
  it('keeps a dispatched unknown claim beyond draft TTL until it is resolved, even before its driver is available', async () => {
    const path = await directory()
    let now = 10
    const store = await AttachmentStore.open(path, { now: () => now }),
      ref = await store.add(input()),
      requestId = randomUUID()
    await store.claim('device-a', [ref.id], requestId)
    now += ATTACHMENT_TTL * 2
    const reopened = await AttachmentStore.open(path, { now: () => now })
    expect(reopened.refs('device-a', [ref.id], undefined, requestId)).toEqual([ref])
    await expect(reopened.claim('device-a', [ref.id], randomUUID())).rejects.toMatchObject({ code: 'attachment-claimed' })
    await reopened.bind('device-a', [ref.id], 'task-delayed', requestId)
    expect((await reopened.read(ref)).text).toBe('ordinary text')
  })
})
