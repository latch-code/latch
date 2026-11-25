import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomic } from '@latch/core/node-kit'
import { AttachmentStore, ATTACHMENT_CLAIM_TTL, ATTACHMENT_TTL, attachmentFileName, attachmentKind } from '../src/attachments.ts'
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, mkdir: vi.fn(fs.mkdir), open: vi.fn(fs.open) }
})
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const cleanups: Array<() => Promise<void>> = []
const directories: string[] = []
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), 'latch-attachments-'))
  directories.push(path)
  return path
}
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  vi.mocked(mkdir).mockReset().mockImplementation(actual.mkdir)
  vi.mocked(open).mockReset().mockImplementation(actual.open)
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const input = (text = 'ordinary text', extra: Partial<Parameters<AttachmentStore['add']>[0]> = {}) => ({
  owner: 'device-a',
  requestId: randomUUID(),
  name: 'note.txt',
  size: Buffer.byteLength(text),
  stream: (async function* () {
    yield Buffer.from(text)
  })(),
  recheck: () => {},
  accept: () => {},
  ...extra,
})
const binary = (bytes: Buffer, name: string) => ({
  ...input('', { name, size: bytes.length }),
  stream: (async function* () {
    yield bytes
  })(),
})
const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`), Buffer.alloc(16)])
describe('what an attachment is', () => {
  it('is a picture, text or a file, by its content and never refused for its type', () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')
    expect(attachmentKind(png, 'png', png.length)).toEqual({ kind: 'image', mime: 'image/png' })
    // Over the picture limit: still sent, by its path.
    expect(attachmentKind(png, 'png', 6 * 1024 * 1024)).toEqual({ kind: 'file', mime: 'image/png' })
    expect(attachmentKind(ftyp('heic'), 'heic', 100)).toEqual({ kind: 'file', mime: 'image/heic' })
    expect(attachmentKind(ftyp('qt  '), 'mov', 100)).toEqual({ kind: 'file', mime: 'video/quicktime' })
    expect(attachmentKind(ftyp('isom'), 'mp4', 100)).toEqual({ kind: 'file', mime: 'video/mp4' })
    expect(attachmentKind(ftyp('M4A '), 'm4a', 100)).toEqual({ kind: 'file', mime: 'audio/mp4' })
    expect(attachmentKind(Buffer.from('ID3\u0004\u0000\u0000'), 'mp3', 100)).toEqual({ kind: 'file', mime: 'audio/mpeg' })
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')])
    expect(attachmentKind(wav, 'wav', 100)).toEqual({ kind: 'file', mime: 'audio/wav' })
    const zip = Buffer.from('PK\u0003\u0004rest')
    expect(attachmentKind(zip, 'zip', 100)).toEqual({ kind: 'file', mime: 'application/zip' })
    expect(attachmentKind(zip, 'docx', 100).mime).toMatch(/wordprocessingml/u)
    expect(attachmentKind(zip, 'xlsx', 100).mime).toMatch(/spreadsheetml/u)
    for (const [text, ext] of [
      ['# 标题', 'md'],
      ['const a = 1', 'ts'],
      ['print(1)', 'py'],
      ['{"a":1}', 'json'],
      ['a,b\n1,2', 'csv'],
      ['<svg xmlns="http://www.w3.org/2000/svg"/>', 'svg'],
    ])
      expect(attachmentKind(Buffer.from(text), ext, text.length)).toEqual({ kind: 'text', mime: 'text/plain' })
  })
  it('names a saved file as the person did, with nothing that leaves its folder', () => {
    expect(attachmentFileName('季度报告 2026（最终版）.pdf')).toBe('季度报告 2026（最终版）.pdf')
    expect(attachmentFileName('..')).toBe('_..')
    expect(attachmentFileName('.env')).toBe('_.env')
    expect(attachmentFileName('a\u0000b:c')).toBe('a_b_c')
  })
})
describe('private attachment store', () => {
  const deliveries = ['reader', 'read', 'materialize'] as const
  async function delivered(method: (typeof deliveries)[number], store: AttachmentStore, ref: Awaited<ReturnType<AttachmentStore['add']>>) {
    if (method === 'materialize') return readFile(await store.materialize(ref, 'session-1'))
    if (method === 'read') return Buffer.from((await store.read(ref)).data)
    const reader = await store.reader(ref)
    try {
      return await reader.read(0, ref.size)
    } finally {
      await reader.close()
    }
  }
  it.each(deliveries)('%s waits for a binding already publishing the draft before opening its content', async method => {
    const path = await directory()
    let binding = false
    let entered!: () => void, release!: () => void
    const arrived = new Promise<void>(resolve => (entered = resolve))
    const released = new Promise<void>(resolve => (release = resolve))
    const pending: Promise<unknown>[] = []
    cleanups.push(async () => {
      release()
      await Promise.allSettled(pending)
    })
    const store = await AttachmentStore.open(path, {
      persist: async (file, text) => {
        if (binding) {
          entered()
          await released
        }
        await writeFileAtomic(file, text)
      },
    })
    const ref = await store.add(input('retained bytes'))
    binding = true
    const bound = store.bind('device-a', [ref.id], 'session-1')
    pending.push(bound)
    await arrived
    vi.mocked(open).mockClear()
    vi.mocked(mkdir).mockClear()
    const content = delivered(method, store, ref)
    pending.push(content)
    // The old draft will disappear when this publication finishes; do not capture it while waiting for the queue.
    expect(open).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
    release()
    await bound
    expect(await content).toEqual(Buffer.from('retained bytes'))
    expect(store.get(ref.id)?.taskId).toBe('session-1')
  })
  it.each(deliveries)('%s finishes checking its open draft before binding can unlink it', async method => {
    const path = await directory()
    const store = await AttachmentStore.open(path)
    const ref = await store.add(input('retained bytes'))
    const draft = join(path, 'attachments', '_drafts', ref.id)
    let entered!: () => void, release!: () => void
    const arrived = new Promise<void>(resolve => (entered = resolve))
    const released = new Promise<void>(resolve => (release = resolve))
    const pending: Promise<unknown>[] = []
    cleanups.push(async () => {
      release()
      await Promise.allSettled(pending)
    })
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await actual.open(...args)
      if (args[0] === draft) {
        const inspect = file.stat.bind(file)
        vi.spyOn(file, 'stat').mockImplementationOnce(async () => {
          const before = await inspect()
          entered()
          await released
          return before
        })
      }
      return file
    })
    const content = delivered(method, store, ref)
    pending.push(content)
    await arrived
    vi.mocked(mkdir).mockClear()
    const bound = store.bind('device-a', [ref.id], 'session-1')
    pending.push(bound)
    // bind enters mutate on the next microtask. Unlinking now would change this descriptor's captured ctime.
    await Promise.resolve()
    expect(mkdir).not.toHaveBeenCalled()
    release()
    expect(await content).toEqual(Buffer.from('retained bytes'))
    await bound
    await expect(stat(draft)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('reads ranges and copies a sent file without holding it whole, and refuses one that changed', async () => {
    const path = await directory(),
      store = await AttachmentStore.open(path)
    // Larger than one read chunk, so the copy and the check both take several.
    const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(3 * 1024 * 1024 + 17)])
    const ref = await store.add(binary(bytes, 'scan.pdf'))
    const reader = await store.reader(ref)
    try {
      expect(await reader.read(0, 9)).toEqual(bytes.subarray(0, 9))
      expect(await reader.read(2 * 1024 * 1024 + 5, 70_000)).toEqual(bytes.subarray(2 * 1024 * 1024 + 5, 2 * 1024 * 1024 + 5 + 70_000))
    } finally {
      await reader.close()
    }
    expect(await readFile(await store.materialize(ref, 'session-1'))).toEqual(bytes)
    // The stored bytes changed under it: no reader, and no copy left behind.
    const stored = join(path, 'attachments', '_drafts', ref.id)
    const changed = Buffer.from(bytes)
    changed[changed.length - 1] ^= 1
    await writeFile(stored, changed)
    await expect(store.reader(ref)).rejects.toMatchObject({ code: 'attachment-changed' })
    await rm(join(path, 'attachments', 'session-1'), { recursive: true })
    await expect(store.materialize(ref, 'session-1')).rejects.toMatchObject({ code: 'attachment-changed' })
    expect(await readdir(join(path, 'attachments', 'session-1', 'files', ref.id))).toEqual([])
  })
  it('saves a sent attachment as a private file under its own name for its agent, without following a link', async () => {
    const path = await directory(),
      store = await AttachmentStore.open(path)
    const bytes = Buffer.from('%PDF-1.7\nbody')
    const ref = await store.add(binary(bytes, '报告.pdf'))
    // A run may save its draft before the draft is bound, into the session's folder all the same.
    expect(await store.materialize(ref, 'session-1')).toBe(join(path, 'attachments', 'session-1', 'files', ref.id, '报告.pdf'))
    await store.bind('device-a', [ref.id], 'session-1')
    await expect(store.materialize(ref, 'session-2')).rejects.toMatchObject({ code: 'attachment-missing' })
    const file = await store.materialize(ref, 'session-1')
    expect(file).toBe(join(path, 'attachments', 'session-1', 'files', ref.id, '报告.pdf'))
    expect(await readFile(file)).toEqual(bytes)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(join(path, 'attachments', 'session-1', 'files', ref.id))).mode & 0o777).toBe(0o700)
    // The agent changed its copy: it is written again from the checked bytes.
    await writeFile(file, 'changed')
    expect(await readFile(await store.materialize(ref, 'session-1'))).toEqual(bytes)
    // A link put in its place is replaced, never followed.
    const outside = join(path, 'outside.txt')
    await writeFile(outside, 'keep')
    await rm(file)
    await symlink(outside, file)
    expect(await readFile(await store.materialize(ref, 'session-1'))).toEqual(bytes)
    expect((await lstat(file)).isSymbolicLink()).toBe(false)
    expect(await readFile(outside, 'utf8')).toBe('keep')
    // A folder that became a link is refused.
    await rm(join(path, 'attachments', 'session-1', 'files'), { recursive: true })
    await symlink(path, join(path, 'attachments', 'session-1', 'files'))
    await expect(store.materialize(ref, 'session-1')).rejects.toMatchObject({ code: 'attachment-changed' })
    await rm(join(path, 'attachments', 'session-1', 'files'))
    await store.removeTask('session-1')
    await expect(stat(join(path, 'attachments', 'session-1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
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
  it('lets go at startup only of week-old drafts a listed session proves unused, and keeps every one it cannot prove', async () => {
    const path = await directory(),
      store = await AttachmentStore.open(path)
    const add = async (text: string, sessionId?: string, steer = false) => {
      const ref = await store.add(input(text))
      await store.claim('device-a', [ref.id], randomUUID(), sessionId, steer)
      return ref
    }
    const abandoned = await add('given up', 'task-listed'),
      named = await add('named by a message', 'task-listed'),
      steered = await add('no agent acknowledgment', 'task-listed', true),
      harnessOff = await add('Harness disabled', 'task-of-disabled-harness'),
      listFailed = await add('Harness failed to list', 'task-of-failed-harness'),
      unknown = await add('unknown session', 'task-unknown'),
      start = await add('a new session’s request')
    // task-listed was listed and read; its message names one draft by ID (even with a ref recovery would not bind).
    const listed = new Map([['task-listed', new Set([named.id])]])
    const soon = await AttachmentStore.open(path, { now: () => Date.now() + ATTACHMENT_TTL * 2, deferPrune: true })
    await soon.pruneAbandonedClaims(listed)
    expect(soon.get(abandoned.id)).toBeDefined()
    const later = await AttachmentStore.open(path, { now: () => Date.now() + ATTACHMENT_CLAIM_TTL + 100, deferPrune: true })
    // A disabled Harness's sessions and those of a Harness whose list failed are absent from what was listed.
    await later.pruneAbandonedClaims(listed)
    expect(later.get(abandoned.id)).toBeUndefined()
    expect(() => later.refs('device-a', [abandoned.id], 'task-listed', randomUUID())).toThrow('附件已过期')
    for (const kept of [named, steered, harnessOff, listFailed, unknown, start]) {
      expect(later.get(kept.id)).toBeDefined()
      expect((await later.read(kept)).text?.length).toBeGreaterThan(0)
    }
    await expect(later.remove(steered.id, 'device-a')).rejects.toMatchObject({ code: 'attachment-in-use' })
    const requestId = later.reserved('device-a').find(entry => entry.id === steered.id)!.requestId
    expect(await later.releaseReserved('device-a', new Map([[steered.id, requestId]]), () => false)).toMatchObject({ count: 1 })
  })
  it('lets go of the drafts reserved for a session when that session is deleted', async () => {
    const path = await directory(),
      store = await AttachmentStore.open(path)
    const reserved = await store.add(input('for a deleted session')),
      other = await store.add(input('for another session'))
    await store.claim('device-a', [reserved.id], randomUUID(), 'task-gone')
    await store.claim('device-a', [other.id], randomUUID(), 'task-kept')
    await store.removeTask('task-gone')
    expect(store.get(reserved.id)).toBeUndefined()
    expect(await readdir(join(path, 'attachments', '_drafts'))).not.toContain(reserved.id)
    expect(store.get(other.id)).toBeDefined()
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
  it('takes a sent attachment again as a new draft of another device, by its stored bytes, and replays the same request', async () => {
    const path = await directory(),
      store = await AttachmentStore.open(path),
      sent = await store.add(input('sent once'))
    await store.bind('device-a', [sent.id], 'task-one')
    const requestId = randomUUID()
    const audited: string[] = []
    const copy = () =>
      store.copy({
        owner: 'device-b',
        requestId,
        source: sent,
        recheck: () => {},
        accept: () => {},
        audit: async ref => {
          audited.push(ref.id)
        },
      })
    const draft = await copy()
    expect(draft).toMatchObject({ name: 'note.txt', sha256: sent.sha256, size: sent.size })
    expect(draft.id).not.toBe(sent.id)
    expect(store.refs('device-b', [draft.id])).toEqual([draft])
    expect(() => store.refs('device-a', [draft.id])).toThrow('附件已过期')
    expect((await store.read(draft)).text).toBe('sent once')
    expect(await copy()).toEqual(draft)
    expect(audited).toEqual([draft.id])
    // The copy is a draft of its own: the sent one stays bound to its session.
    expect(store.get(sent.id)).toMatchObject({ taskId: 'task-one' })
  })
  it('holds a copy to the upload slots and quotas: parallel copies of a large attachment beyond them are refused at once', async () => {
    const path = await directory(),
      store = await AttachmentStore.open(path),
      big = 'a'.repeat(6 * 1024 * 1024),
      sent = await store.add(input(big, { name: 'big.txt' }))
    await store.bind('device-a', [sent.id], 'task-one')
    const copy = () => store.copy({ owner: 'device-b', requestId: randomUUID(), source: sent, recheck: () => {}, accept: () => {} })
    const results = await Promise.allSettled(Array.from({ length: 10 }, copy))
    const refused = results.filter(result => result.status === 'rejected')
    // Two uploads at a time per device, as for any upload; the rest never read a byte.
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2)
    expect(refused.map(result => (result as PromiseRejectedResult).reason.code)).toEqual(Array(8).fill('attachment-quota'))
    // The slots are given back: the next copy goes through.
    await expect(copy()).resolves.toMatchObject({ sha256: sent.sha256 })
  })
  it('sniffs bytes into a picture, text or a file of its type, and only publishes after acceptance and audit', async () => {
    const path = await directory(),
      store = await AttachmentStore.open(path)
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
    expect(await store.add(binary(Buffer.from('%PDF-1.7\n'), 'report.pdf'))).toMatchObject({ kind: 'file', mime: 'application/pdf' })
    expect(await store.add(binary(Buffer.from('ab\0cd'), 'b.txt'))).toMatchObject({ kind: 'file', mime: 'application/octet-stream' })
    const ref = await store.add(input('plain text', { name: 'pretend.png' }))
    expect(ref.mime).toBe('text/plain')
  })
  it('rejects changed bytes, too many attachments, oversized uploads and interrupted or revoked streams without leaving temporary data', async () => {
    const path = await directory(),
      store = await AttachmentStore.open(path)
    await expect(store.add(input('text', { size: 50 * 1024 * 1024 + 1 }))).rejects.toMatchObject({ code: 'attachment-too-large' })
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
  it('refuses to remove a draft whose create or prompt is still on its way, accepted or queued, and removes it once that ends', async () => {
    const store = await AttachmentStore.open(await directory()),
      ref = await store.add(input('claimed')),
      free = await store.add(input('free')),
      requestId = randomUUID()
    await store.claim('device-a', [ref.id], requestId, 'task-existing')
    let busy = true
    const asked: string[] = []
    const check = (id: string) => {
      asked.push(id)
      return busy
    }
    await expect(store.remove(ref.id, 'device-a', check)).rejects.toMatchObject({ status: 409, code: 'attachment-in-use' })
    expect(asked).toEqual([requestId])
    expect(store.get(ref.id)).toBeDefined()
    // A draft no message holds is removed whatever is in flight.
    await store.remove(free.id, 'device-a', check)
    expect(store.get(free.id)).toBeUndefined()
    busy = false
    await store.remove(ref.id, 'device-a', check)
    expect(store.get(ref.id)).toBeUndefined()
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
