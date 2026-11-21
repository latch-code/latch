import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import type { AttachmentRef, AttachmentUploadView } from '@latch/protocol'
import { AppError, type HarnessPlugin } from '@latch/sdk'
import { createRuntime } from '@latch/core'
import { writeFileAtomic } from '@latch/core/node-kit'
import { AttachmentStore, ATTACHMENT_DEVICE_BYTES } from '../src/attachments.ts'
import {
  AttachmentUploads,
  ATTACHMENT_PART_BYTES,
  ATTACHMENT_PARTS_PER_BULK,
  ATTACHMENT_RECORDS_PER_DEVICE,
  ATTACHMENT_UPLOAD_TTL,
  ATTACHMENT_UPLOADS_PER_DEVICE,
} from '../src/attachment-uploads.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const hosts: TestHost[] = []
const directories: string[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const MiB = ATTACHMENT_PART_BYTES
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
/** A PNG whose header claims 10,000 × 5,000 pixels: past the 40-megapixel cap. */
const hugePng = (() => {
  const copy = Buffer.from(png)
  copy.writeUInt32BE(10_000, 16)
  copy.writeUInt32BE(5_000, 20)
  return copy
})()
const text = (bytes: number, fill = 'a') => Buffer.alloc(bytes, fill)
const selection = { harnessId: 'acp' }

async function setup(options: { now?: () => number } = {}) {
  const host = await startTestHost(options.now ? { now: options.now } : {})
  hosts.push(host)
  const desktop = await host.enroll({ listener: 'unix' })
  await desktop.confirmedJson('agents', {
    body: { id: 'acp', name: 'ACP', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_CAPS: 'images,embedded' } },
  })
  expect((await desktop.confirmed('agents/acp/probe', { body: { requestId: randomUUID() } })).status).toBe(200)
  const phone = await host.enroll({ scopes: ['view', 'run'] })
  return { host, desktop, phone }
}
const begin = (device: TestDevice, bytes: Uint8Array, extra: Record<string, unknown> = {}) =>
  device.request('attachments/uploads', {
    body: { requestId: randomUUID(), name: 'notes.txt', kind: 'text', size: bytes.length, sha256: sha(bytes), selection, ...extra },
  })
const put = (device: TestDevice, id: string, index: number, bytes: Uint8Array) =>
  device.request(`attachments/uploads/${id}/parts/${index}`, {
    method: 'PUT',
    rawBody: bytes,
    headers: { 'content-type': 'application/octet-stream' },
  })
const complete = (device: TestDevice, id: string, body: Record<string, unknown> = {}) =>
  device.request(`attachments/uploads/${id}/complete`, { body })
const parts = (bytes: Buffer) => Array.from({ length: Math.ceil(bytes.length / MiB) }, (_, n) => bytes.subarray(n * MiB, (n + 1) * MiB))
async function send(device: TestDevice, bytes: Buffer, extra: Record<string, unknown> = {}) {
  const started = await begin(device, bytes, extra)
  expect(started.status).toBe(201)
  const { upload } = (await started.json()) as { upload: AttachmentUploadView }
  for (const [n, part] of parts(bytes).entries()) expect((await put(device, upload.id, n, part)).status).toBe(200)
  return upload
}

describe('chunked attachment uploads', () => {
  it('assembles a 3 MiB file from ordered parts, answers every replay the same and audits once on completion', async () => {
    const { host, phone, desktop } = await setup()
    const bytes = Buffer.concat([text(MiB, 'a'), text(MiB, 'b'), text(MiB / 2, 'c')]),
      requestId = randomUUID()
    const started = await begin(phone, bytes, { requestId })
    expect(started.status).toBe(201)
    const { upload } = (await started.json()) as { upload: AttachmentUploadView }
    expect(upload).toMatchObject({ requestId, size: bytes.length, partBytes: MiB, parts: 3, received: 0, next: 0 })
    // The same start again is the same upload.
    expect(((await (await begin(phone, bytes, { requestId })).json()) as { upload: AttachmentUploadView }).upload.id).toBe(upload.id)
    expect((await begin(phone, text(10), { requestId })).status).toBe(409)
    const [first, second, third] = parts(bytes) as [Buffer, Buffer, Buffer]
    // Within four places of the first missing part, a part may come first; the bitmap says which arrived.
    const early = await put(phone, upload.id, 1, second)
    expect(early.status).toBe(200)
    const view = (await early.json()) as { upload: AttachmentUploadView }
    expect(view.upload).toMatchObject({ received: 1, next: 0, bitmap: '010' })
    // A duplicate part with the same bytes gets the same answer; other bytes under that index conflict.
    expect(await (await put(phone, upload.id, 1, second)).json()).toEqual(view)
    expect(await (await put(phone, upload.id, 1, first)).json()).toMatchObject({ error: 'upload-part-conflict' })
    expect(await phone.json(`attachments/uploads/${upload.id}`)).toEqual(view)
    const unfinished = await complete(phone, upload.id)
    expect(unfinished.status).toBe(400)
    expect(await unfinished.json()).toMatchObject({ error: 'attachment-incomplete', next: 0 })
    expect(((await (await put(phone, upload.id, 0, first)).json()) as { upload: AttachmentUploadView }).upload).toMatchObject({
      received: 2,
      next: 2,
      bitmap: '110',
    })
    // The last part is exactly what is left, and a part never passes 1 MiB.
    expect((await put(phone, upload.id, 2, Buffer.concat([third, text(1)]))).status).toBe(413)
    expect((await put(phone, upload.id, 2, third.subarray(1))).status).toBe(400)
    expect((await put(phone, upload.id, 2, third)).status).toBe(200)
    const done = await complete(phone, upload.id)
    expect(done.status).toBe(201)
    const { attachment } = (await done.json()) as { attachment: AttachmentRef }
    expect(attachment).toMatchObject({ kind: 'text', mime: 'text/plain', size: bytes.length, sha256: sha(bytes), name: 'notes.txt' })
    // Every step again answers as before: completion, the start and a part.
    expect(await (await complete(phone, upload.id)).json()).toEqual({ attachment })
    expect(((await (await begin(phone, bytes, { requestId })).json()) as { upload: AttachmentUploadView }).upload).toMatchObject({
      id: upload.id,
      next: null,
      attachment,
    })
    expect(((await (await put(phone, upload.id, 1, second)).json()) as { upload: AttachmentUploadView }).upload.attachment).toEqual(
      attachment,
    )
    // The parts are gone; the file is a normal draft of this device, readable byte for byte once sent.
    await expect(stat(join(host.dataDir, 'attachments', '_uploads', upload.id, 'data'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(host.dataDir, 'attachments', '_drafts', attachment.id))).toEqual(bytes)
    const meta = await stat(join(host.dataDir, 'attachments', '_uploads', upload.id, 'meta.json'))
    expect(meta.mode & 0o777).toBe(0o600)
    // One record for the attachment, none per part.
    const audit = (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { action: string; detail?: Record<string, unknown> })
      .filter(record => record.action === 'attachment.add')
    expect(audit).toEqual([
      expect.objectContaining({
        detail: { attachmentId: attachment.id, contentHash: attachment.sha256, bytes: bytes.length, type: 'text' },
      }),
    ])
    // The desktop on host.sock sees nothing of the phone's upload.
    expect((await desktop.request(`attachments/uploads/${upload.id}`)).status).toBe(404)
  }, 60_000)
  it('refuses a size or hash mismatch and runs the same content checks on completion', async () => {
    const { phone } = await setup()
    // Limits at the start: the file cap, the image cap, an unknown kind.
    expect(await (await begin(phone, text(10), { size: 50 * MiB + 1 })).json()).toMatchObject({ error: 'attachment-too-large' })
    expect(await (await begin(phone, text(10), { kind: 'image', size: 5 * MiB + 1 })).json()).toMatchObject({
      error: 'attachment-image-unsupported',
    })
    expect((await begin(phone, text(10), { kind: 'pdf' })).status).toBe(400)
    // The assembled bytes must be what the start named.
    const named = await begin(phone, text(10), { sha256: sha(text(10, 'z')) })
    const { upload: mismatch } = (await named.json()) as { upload: AttachmentUploadView }
    expect((await put(phone, mismatch.id, 0, text(10))).status).toBe(200)
    const refused = await complete(phone, mismatch.id)
    expect(refused.status).toBe(400)
    const answer = await refused.json()
    expect(answer).toMatchObject({ error: 'attachment-invalid' })
    expect(await (await complete(phone, mismatch.id)).json()).toEqual(answer)
    // Sniffed, not declared: what the bytes are must be the kind the start named (a picture, text or a file).
    for (const [bytes, extra, error] of [
      [png, { name: 'a.txt' }, 'attachment-invalid'],
      [Buffer.from('ab\0cd'), { name: 'b.txt' }, 'attachment-invalid'],
      // Plain text in the sniffed head, not UTF-8 after it: the whole assembled file is decoded, and it is a file.
      [Buffer.concat([text(70_000), Buffer.from([0xe9, 0x0a])]), { name: 'e.txt' }, 'attachment-invalid'],
      [Buffer.from('%PDF-1.7\n'), { name: 'c.pdf' }, 'attachment-invalid'],
      // A picture past 40 megapixels is a file, not one a model is shown.
      [hugePng, { name: 'd.png', kind: 'image' }, 'attachment-invalid'],
    ] as const) {
      const upload = await send(phone, bytes, extra)
      expect(await (await complete(phone, upload.id)).json()).toMatchObject({ error })
    }
    const pdf = await send(phone, Buffer.from('%PDF-1.7\n'), { name: 'c.pdf', kind: 'file' })
    expect(await (await complete(phone, pdf.id)).json()).toMatchObject({ attachment: { kind: 'file', mime: 'application/pdf' } })
    // A secret asks first; 仍然添加 completes the same parts without sending them again.
    const secret = await send(phone, Buffer.from('TOKEN=1\n'), { name: '.env' })
    expect(await (await complete(phone, secret.id)).json()).toMatchObject({ error: 'attachment-secret' })
    const kept = await complete(phone, secret.id, { secretAcknowledged: true })
    expect(kept.status).toBe(201)
    const image = await send(phone, png, { name: 'look.png', kind: 'image' })
    expect(await (await complete(phone, image.id)).json()).toMatchObject({ attachment: { kind: 'image', width: 1, height: 1 } })
  }, 60_000)
  it('takes whatever a declared file sniffs as, by that kind, and holds every entrance to 50 MiB', async () => {
    const { phone } = await setup()
    // Declared `file`: text, a picture and bytes each come out as what their content is.
    for (const [bytes, name, kind, mime] of [
      [Buffer.from('# 笔记\n'), 'notes.md', 'text', 'text/plain'],
      [png, 'shot.png', 'image', 'image/png'],
      [Buffer.from([0, 1, 2, 3, 0xff]), 'blob.bin', 'file', 'application/octet-stream'],
    ] as const) {
      const upload = await send(phone, bytes, { name, kind: 'file' })
      expect(await (await complete(phone, upload.id)).json()).toMatchObject({ attachment: { kind, mime, name } })
    }
    // A declared picture or text is still held to that.
    const declaredText = await send(phone, Buffer.from([0, 1, 2]), { name: 'x.txt', kind: 'text' })
    expect(await (await complete(phone, declaredText.id)).json()).toMatchObject({ error: 'attachment-invalid' })
    // The phone's limit and the desktop's are one: 50 MiB starts, a byte more does not.
    const room = await begin(phone, text(10), { size: 50 * MiB })
    expect(room.status).toBe(201)
    const { upload: large } = (await room.json()) as { upload: AttachmentUploadView }
    expect(large.parts).toBe(50)
    expect(await (await begin(phone, text(10), { size: 50 * MiB + 1 })).json()).toMatchObject({ error: 'attachment-too-large' })
    expect((await phone.request(`attachments/uploads/${large.id}`, { method: 'DELETE' })).status).toBe(200)
  }, 60_000)
  it('checks a declared file against a Harness without files by its sniffed kind, at completion', async () => {
    const plugin: HarnessPlugin = {
      id: 'text-only',
      name: 'text-only',
      version: '1',
      description: '',
      activate: ctx =>
        ctx.registerHarness({
          id: 'text-only',
          name: 'text-only',
          version: '1',
          capabilities: { models: { owner: 'harness' }, modes: ['agent'], attachments: { text: true, textBytes: 1024 } },
          create: options => createRuntime(options),
        }),
    }
    const host = await startTestHost({ plugins: [plugin] })
    hosts.push(host)
    const phone = await host.enroll({ scopes: ['view', 'run'] })
    const only = { selection: { harnessId: 'text-only' }, kind: 'file' }
    const small = await send(phone, Buffer.from('short note\n'), { ...only, name: 'a.txt' })
    expect(await (await complete(phone, small.id)).json()).toMatchObject({ attachment: { kind: 'text' } })
    // Text past what it takes, and bytes it cannot take, are refused by what they are; the parts stay for a retry.
    const long = await send(phone, text(2048), { ...only, name: 'b.txt' })
    expect(await (await complete(phone, long.id)).json()).toMatchObject({ error: 'attachment-text-too-large' })
    const binary = await send(phone, Buffer.from([0, 1, 2]), { ...only, name: 'c.bin' })
    expect(await (await complete(phone, binary.id)).json()).toMatchObject({ error: 'attachment-type-unsupported' })
    expect(await phone.json(`attachments/uploads/${binary.id}`)).toMatchObject({ upload: { next: null } })
  }, 60_000)
  it('keeps each step to the device and its scope, and aborts on request', async () => {
    const { host, phone } = await setup()
    const viewer = await host.enroll({ scopes: ['view'] }),
      other = await host.enroll({ scopes: ['view', 'run'] })
    expect((await begin(viewer, text(10))).status).toBe(403)
    const { upload } = (await (await begin(phone, text(MiB + 10))).json()) as { upload: AttachmentUploadView }
    expect((await put(phone, upload.id, 0, text(MiB))).status).toBe(200)
    for (const response of [
      await other.request(`attachments/uploads/${upload.id}`),
      await put(other, upload.id, 1, text(10)),
      await complete(other, upload.id),
    ])
      expect(response.status).toBe(404)
    expect((await viewer.request(`attachments/uploads/${upload.id}`)).status).toBe(403)
    // Another device's abort is answered and changes nothing.
    expect(await other.json(`attachments/uploads/${upload.id}`, { method: 'DELETE' })).toEqual({ aborted: true })
    expect((await phone.json<{ upload: AttachmentUploadView }>(`attachments/uploads/${upload.id}`)).upload.next).toBe(1)
    expect(await phone.json(`attachments/uploads/${upload.id}`, { method: 'DELETE' })).toEqual({ aborted: true })
    expect(await phone.json(`attachments/uploads/${upload.id}`, { method: 'DELETE' })).toEqual({ aborted: true })
    expect((await phone.request(`attachments/uploads/${upload.id}`)).status).toBe(404)
    expect((await put(phone, upload.id, 1, text(10))).status).toBe(404)
    expect(await readdir(join(host.dataDir, 'attachments', '_uploads'))).toEqual([])
  }, 60_000)
  it('expires unfinished uploads, restores them across a restart and counts them against the device quota', async () => {
    const path = await mkdtemp(join(tmpdir(), 'latch-uploads-'))
    directories.push(path)
    let now = 1_000_000
    const store = await AttachmentStore.open(path, { now: () => now }),
      uploads = await AttachmentUploads.open(path, store, { now: () => now })
    const context = { selection }
    const start = (size: number, owner = 'device-a', requestId = randomUUID()) =>
      uploads.begin({ owner, requestId, name: 'n.txt', kind: 'text', size, sha256: sha(text(size)), remote: false, context })
    const id = (begun: Awaited<ReturnType<typeof start>>) => ('upload' in begun ? begun.upload.id : '')
    const first = id(await start(2 * MiB))
    const stream = (bytes: Buffer) =>
      (async function* () {
        yield bytes
      })()
    await uploads.part({ owner: 'device-a', id: first, index: 0, stream: stream(text(MiB)), recheck: () => {} })
    // Unfinished uploads take a draft slot each: with eight held, 24 drafts fit and the 25th does not.
    const held: string[] = [first]
    for (let n = 1; n < ATTACHMENT_UPLOADS_PER_DEVICE; n++) held.push(id(await start(10)))
    await expect(start(10)).rejects.toMatchObject({ status: 429, code: 'attachment-quota' })
    expect(store.holding('device-a')).toEqual({ count: 8, bytes: 2 * MiB + 70 })
    // An abort gives its room back, once.
    await uploads.abort('device-a', held.pop()!)
    await uploads.abort('device-a', held.at(-1)!)
    await uploads.abort('device-a', held.at(-1)!)
    expect(store.holding('device-a')).toEqual({ count: 6, bytes: 2 * MiB + 50 })
    held.splice(-1, 1, id(await start(10)), id(await start(10)))
    const add = () =>
      store.add({
        owner: 'device-a',
        requestId: randomUUID(),
        name: 'x.txt',
        size: 1,
        stream: stream(Buffer.from('x')),
        recheck: () => {},
        accept: () => {},
      })
    for (let n = 0; n < 24; n++) await add()
    await expect(add()).rejects.toMatchObject({ code: 'attachment-quota' })
    // Another device is not held back by this one's.
    expect(id(await start(10, 'device-b'))).toMatch(/^[A-Za-z0-9_-]{22}$/u)
    // A restart keeps the received part, drops bytes written past its record and holds the room again.
    await truncate(join(path, 'attachments', '_uploads', first, 'data'), MiB + 7)
    now += ATTACHMENT_UPLOAD_TTL - 60_000
    const restarted = await AttachmentStore.open(path, { now: () => now, deferPrune: true }),
      reopened = await AttachmentUploads.open(path, restarted, { now: () => now })
    // The restarted store holds the room of every open upload again.
    expect(restarted.holding('device-a')).toEqual({ count: 8, bytes: 2 * MiB + 70 })
    expect(restarted.holding('device-b')).toEqual({ count: 1, bytes: 10 })
    expect(reopened.status('device-a', first)).toMatchObject({ received: 1, next: 1 })
    expect((await stat(join(path, 'attachments', '_uploads', first, 'data'))).size).toBe(MiB)
    // After an hour without a step it is gone, and its room with it.
    now += 120_000
    expect(() => reopened.status('device-a', first)).toThrow(expect.objectContaining({ code: 'upload-missing' }))
    await reopened.prune()
    expect(await readdir(join(path, 'attachments', '_uploads'))).toEqual([])
    expect(restarted.holding('device-a')).toEqual({ count: 0, bytes: 0 })
  })
  it('holds declared bytes against the device total', async () => {
    const path = await mkdtemp(join(tmpdir(), 'latch-uploads-'))
    directories.push(path)
    const store = await AttachmentStore.open(path)
    const size = 50 * MiB
    for (let n = 0; n < Math.floor(ATTACHMENT_DEVICE_BYTES / size); n++) store.hold('device-a', size)
    expect(() => store.hold('device-a', size)).toThrow(expect.objectContaining({ code: 'attachment-quota' }))
    store.unhold('device-a', size)
    store.hold('device-a', size)
  })
  it('never keeps what the capability check says, and completes on a retry once the Harness is ready', async () => {
    const { store, uploads, open: begin, put } = await local()
    const id = await begin(text(10))
    await put(id, 0, text(10))
    for (const refusal of [
      new AppError(409, 'harness-unavailable', '当前 Harness 不可用。'),
      new AppError(415, 'attachment-image-unsupported', '当前模型不能看图片。'),
    ]) {
      await expect(finishUpload(uploads, id, () => Promise.reject(refusal))).rejects.toBe(refusal)
      // Not stored: the parts and the held room stay, and the record still waits for completion.
      expect(uploads.status('device-a', id)).toMatchObject({ next: null })
      expect(store.holding('device-a')).toEqual({ count: 1, bytes: 10 })
    }
    expect(await finishUpload(uploads, id, () => {})).toMatchObject({ kind: 'text', size: 10 })
    expect(store.holding('device-a')).toEqual({ count: 0, bytes: 0 })
  })
  it('gives the held room back once, and only after the record is written', async () => {
    let failing = false
    const {
      store,
      uploads,
      open: begin,
      put,
    } = await local(async (file, text) => {
      if (failing) throw new Error('disk')
      await writeFileAtomic(file, text)
    })
    const kept = await begin(text(10)),
      refused = await begin(text(10), sha(text(10, 'z'))),
      other = await begin(text(20))
    for (const id of [kept, refused]) await put(id, 0, text(10))
    failing = true
    await expect(finishUpload(uploads, kept, () => {})).rejects.toThrow('disk')
    await expect(finishUpload(uploads, refused, () => {})).rejects.toThrow('disk')
    expect(store.holding('device-a')).toEqual({ count: 3, bytes: 40 })
    failing = false
    expect(await finishUpload(uploads, kept, () => {})).toMatchObject({ size: 10 })
    await expect(finishUpload(uploads, refused, () => {})).rejects.toMatchObject({ code: 'attachment-invalid' })
    expect(store.holding('device-a')).toEqual({ count: 1, bytes: 20 })
    // Dropping finished and refused records gives nothing back twice: the open one still holds its room.
    for (const id of [kept, refused]) await uploads.abort('device-a', id)
    expect(store.holding('device-a')).toEqual({ count: 1, bytes: 20 })
    await uploads.abort('device-a', other)
    expect(store.holding('device-a')).toEqual({ count: 0, bytes: 0 })
  })
  it('keeps at most a set number of finished and refused records per device, dropping the oldest', async () => {
    const { path, uploads, open: begin, put, tick } = await local()
    const ids: string[] = []
    for (let n = 0; n <= ATTACHMENT_RECORDS_PER_DEVICE; n++) {
      const id = await begin(text(10), sha(text(10, 'z')))
      await put(id, 0, text(10))
      await expect(finishUpload(uploads, id, () => {})).rejects.toMatchObject({ code: 'attachment-invalid' })
      ids.push(id)
      tick()
    }
    expect(await readdir(join(path, 'attachments', '_uploads'))).toHaveLength(ATTACHMENT_RECORDS_PER_DEVICE)
    expect(() => uploads.status('device-a', ids[0]!)).toThrow(expect.objectContaining({ code: 'upload-missing' }))
    expect(() => uploads.status('device-a', ids.at(-1)!)).toThrow(expect.objectContaining({ code: 'attachment-invalid' }))
  })
  it('starts a chunked upload while the device already streams two single uploads', async () => {
    const { store, open: begin } = await local()
    let release!: () => void
    const held = new Promise<void>(done => (release = done))
    const streaming = () =>
      store.add({
        owner: 'device-a',
        requestId: randomUUID(),
        name: 's.txt',
        size: 2,
        stream: (async function* () {
          yield Buffer.from('s')
          await held
          yield Buffer.from('t')
        })(),
        recheck: () => {},
        accept: () => {},
      })
    const both = [streaming(), streaming()]
    await new Promise(done => setTimeout(done, 20))
    // A third single upload waits its turn; a start holds only bytes and goes ahead.
    await expect(streaming()).rejects.toMatchObject({ code: 'attachment-quota' })
    expect(await begin(text(10))).toMatch(/^[A-Za-z0-9_-]{22}$/u)
    release()
    await Promise.all(both)
  })
  it('writes parts that arrive out of order within four of the first missing one at their offsets, and refuses one further on', async () => {
    const { path, uploads, open: begin, put } = await local()
    const bytes = Buffer.concat(Array.from({ length: 7 }, (_, n) => text(n < 6 ? MiB : 1234, String.fromCharCode(97 + n)))),
      pieces = parts(bytes),
      id = await begin(bytes)
    const order = (index: number) => put(id, index, pieces[index]!)
    expect(await order(3)).toMatchObject({ received: 1, next: 0, bitmap: '0001000' })
    expect(await order(1)).toMatchObject({ next: 0, bitmap: '0101000' })
    // Four places past the first missing part is too far: the Host names the part to send next, before reading the body.
    await expect(order(4)).rejects.toMatchObject({ status: 409, code: 'upload-part-order', details: { next: 0 } })
    expect(await order(0)).toMatchObject({ received: 3, next: 2, bitmap: '1101000' })
    expect(await order(5)).toMatchObject({ next: 2, bitmap: '1101010' })
    await expect(order(6)).rejects.toMatchObject({ code: 'upload-part-order', details: { next: 2 } })
    for (const index of [2, 6, 4]) await order(index)
    expect(uploads.status('device-a', id)).toMatchObject({ received: 7, next: null, bitmap: '1111111' })
    expect(await readFile(join(path, 'attachments', '_uploads', id, 'data'))).toEqual(bytes)
    expect(await finishUpload(uploads, id, () => {})).toMatchObject({ size: bytes.length, sha256: sha(bytes) })
  })
  it('keeps the received-part bitmap across a restart, so a resume sends only the missing parts', async () => {
    const { path, store, uploads, open: begin, put, clock } = await local()
    const bytes = Buffer.concat([text(MiB, 'p'), text(MiB, 'q'), text(MiB, 'r'), text(10, 's')]),
      pieces = parts(bytes),
      id = await begin(bytes)
    await put(id, 0, pieces[0]!)
    await put(id, 2, pieces[2]!)
    const meta = JSON.parse(await readFile(join(path, 'attachments', '_uploads', id, 'meta.json'), 'utf8')) as { parts: unknown[] }
    expect(meta.parts).toEqual([sha(pieces[0]!), null, sha(pieces[2]!)])
    // Bytes written past the last recorded part, before a record said so, go at the restart; the hole below stays.
    await truncate(join(path, 'attachments', '_uploads', id, 'data'), 3 * MiB + 5)
    const restarted = await AttachmentUploads.open(path, store, { now: clock })
    const view = restarted.status('device-a', id)
    expect(view).toMatchObject({ received: 2, next: 1, bitmap: '1010' })
    expect((await stat(join(path, 'attachments', '_uploads', id, 'data'))).size).toBe(3 * MiB)
    // The same start again answers with the same bitmap; only the missing parts go.
    const again = await restarted.begin({
      owner: 'device-a',
      requestId: view.requestId,
      name: 'n.txt',
      kind: 'text',
      size: bytes.length,
      sha256: sha(bytes),
      remote: false,
      context: { selection },
    })
    expect(again).toEqual({ upload: view })
    const missing = [...view.bitmap].flatMap((bit, index) => (bit === '0' ? [index] : []))
    expect(missing).toEqual([1, 3])
    for (const index of missing.toReversed())
      await restarted.part({
        owner: 'device-a',
        id,
        index,
        stream: (async function* () {
          yield pieces[index]!
        })(),
        recheck: () => {},
      })
    expect(await finishUpload(restarted, id, () => {})).toMatchObject({ sha256: sha(bytes) })
    // A record from before the bitmap (a dense list of hashes) still reads.
    const older = await begin(text(2 * MiB, 'o'))
    await put(older, 0, text(MiB, 'o'))
    expect((await AttachmentUploads.open(path, store, { now: clock })).status('device-a', older)).toMatchObject({ next: 1, bitmap: '10' })
  })
  it('receives at most two parts of a device at once, or four on its bulk upload connection, holding each until it is written', async () => {
    const { uploads, open: begin } = await local()
    const bytes = text(6 * MiB),
      id = await begin(bytes),
      other = await begin(text(2 * MiB, 'b'))
    let release!: () => void
    const held = new Promise<void>(done => (release = done))
    const progress: number[] = []
    const slow = (index: number, limit?: number, upload = id) =>
      uploads.part({
        owner: 'device-a',
        id: upload,
        index,
        stream: (async function* () {
          yield text(MiB / 2)
          await held
          yield text(MiB / 2)
        })(),
        recheck: () => {},
        ...(limit ? { limit, progress: (bytes: number) => progress.push(bytes) } : {}),
      })
    const regular = [slow(0), slow(1)]
    await new Promise(done => setTimeout(done, 20))
    await expect(slow(2)).rejects.toMatchObject({ status: 429, code: 'attachment-quota' })
    const bulk = [slow(2, ATTACHMENT_PARTS_PER_BULK), slow(3, ATTACHMENT_PARTS_PER_BULK)]
    await new Promise(done => setTimeout(done, 20))
    // The limit counts the device's parts, whichever upload they belong to.
    await expect(slow(0, ATTACHMENT_PARTS_PER_BULK, other)).rejects.toMatchObject({ status: 429 })
    release()
    await Promise.all([...regular, ...bulk])
    expect(progress.reduce((sum, value) => sum + value, 0)).toBe(2 * MiB)
    expect(uploads.status('device-a', id)).toMatchObject({ received: 4, bitmap: '111100' })
  })
})

async function local(persist?: (path: string, text: string) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), 'latch-uploads-'))
  directories.push(path)
  let now = 1_000_000
  const store = await AttachmentStore.open(path, { now: () => now }),
    uploads = await AttachmentUploads.open(path, store, { now: () => now, ...(persist ? { persist } : {}) })
  return {
    path,
    store,
    uploads,
    tick: () => (now += 1000),
    clock: () => now,
    async open(bytes: Buffer, digest = sha(bytes)) {
      const begun = await uploads.begin({
        owner: 'device-a',
        requestId: randomUUID(),
        name: 'n.txt',
        kind: 'text',
        size: bytes.length,
        sha256: digest,
        remote: false,
        context: { selection },
      })
      if (!('upload' in begun)) throw new Error('no upload')
      return begun.upload.id
    },
    put: (id: string, index: number, bytes: Buffer) =>
      uploads.part({
        owner: 'device-a',
        id,
        index,
        stream: (async function* () {
          yield bytes
        })(),
        recheck: () => {},
      }),
  }
}
const finishUpload = (uploads: AttachmentUploads, id: string, accept: () => void | Promise<void>) =>
  uploads.complete({ owner: 'device-a', id, remote: false, recheck: () => {}, accept })
