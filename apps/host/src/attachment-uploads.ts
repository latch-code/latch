import { constants } from 'node:fs'
import { mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { isAttachmentRef, type AttachmentRef, type AttachmentUploadView } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { writeFileAtomic } from '@latch/core/node-kit'
import { modelEffort } from './config.ts'
import { ATTACHMENT_FILE_LIMIT, ATTACHMENT_IMAGE_LIMIT, attachmentInputHash, type AttachmentStore } from './attachments.ts'

/** One part of a chunked upload: what one native stream carries. Every part but the last is exactly this long. */
export const ATTACHMENT_PART_BYTES = 1024 * 1024
/** An unfinished upload expires this long after its last accepted step; a finished or refused one is remembered as long. */
export const ATTACHMENT_UPLOAD_TTL = 60 * 60_000
/**
 * Unfinished uploads a device may hold: a whole message's attachments (8), so a person can stage one even with a lost
 * upload left over. The Host holds at most 64. Their declared bytes are held from the start against the same quota as
 * drafts (512 MiB per device, 2 GiB for the Host), so parts on disk stay within it.
 */
export const ATTACHMENT_UPLOADS_PER_DEVICE = 8
const ATTACHMENT_UPLOADS_PER_HOST = 64
/**
 * Finished and refused records kept for replays, per device and for the Host; past these the oldest go first. A replay
 * of a start whose record went is still answered from the attachment index.
 */
export const ATTACHMENT_RECORDS_PER_DEVICE = 32
const ATTACHMENT_RECORDS_PER_HOST = 256
/**
 * Parts being received at once, each buffered up to 1 MiB until it is written: as many as the single-body route lets
 * stream, or four on a phone's bulk upload connection, which its 4 MiB connection window bounds the same way.
 */
export const ATTACHMENT_PARTS_PER_DEVICE = 2
export const ATTACHMENT_PARTS_PER_BULK = 4
const PARTS_PER_HOST = 8
/** A part may arrive this many places past the first missing one, so parts in flight on one connection land in any order. */
export const ATTACHMENT_PART_WINDOW = 4
const ID = /^[A-Za-z0-9_-]{22}$/u
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)

const attachmentSelection = z.strictObject({
  harnessId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(64).optional(),
  mode: z.enum(['chat', 'agent']).optional(),
  model: z
    .strictObject({ providerId: z.string().min(1).max(64), model: z.string().min(1).max(200), effort: modelEffort.optional() })
    .optional(),
})
export const attachmentContext = z.strictObject({ selection: attachmentSelection, sessionId: z.string().min(1).max(256).optional() })
export type AttachmentContext = z.infer<typeof attachmentContext>

const uploadSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(ID),
  owner: z.string().min(1).max(256),
  requestId: z.string().uuid(),
  name: z.string().min(1).max(200),
  kind: z.enum(['image', 'text', 'file']),
  size: z.number().int().positive().max(ATTACHMENT_FILE_LIMIT),
  sha256,
  remote: z.boolean(),
  context: attachmentContext,
  createdAt: z.number().finite(),
  touchedAt: z.number().finite(),
  /** The received-part bitmap: the SHA-256 of each part by its index, null where that part has not arrived. */
  parts: z.array(sha256.nullable()).max(Math.ceil(ATTACHMENT_FILE_LIMIT / ATTACHMENT_PART_BYTES)),
  done: z.custom<AttachmentRef>(isAttachmentRef).optional(),
  /** A refusal of its content, given again to every replay of the completion. */
  failed: z
    .strictObject({ status: z.number().int().min(400).max(499), code: z.string().min(1).max(64), message: z.string().max(400) })
    .optional(),
})
type Upload = z.infer<typeof uploadSchema>

const partCount = (size: number) => Math.ceil(size / ATTACHMENT_PART_BYTES)
/** The first part not yet received; the part count when all are in. */
const firstMissing = (upload: Upload) => {
  const index = upload.parts.indexOf(null)
  return index >= 0 ? index : upload.parts.length
}
const receivedParts = (upload: Upload) => upload.parts.reduce((sum, hash) => sum + (hash ? 1 : 0), 0)
/** Where the bytes the record vouches for end: past the last received part. */
const recordedEnd = (upload: Upload) => {
  const last = upload.parts.findLastIndex(hash => hash !== null)
  return last < 0 ? 0 : Math.min((last + 1) * ATTACHMENT_PART_BYTES, upload.size)
}
const isOpen = (upload: Upload) => !upload.done && !upload.failed
/**
 * Refusals of what was sent, which hold however often the completion is replayed: the content checks, the SHA-256 and
 * declared kind (`attachment-invalid`) and another file under the request. Never a secret to confirm, and never what
 * the capability check says (a Harness not ready, a missing key, a project being changed): that can pass, so the parts
 * stay and the completion can be tried again.
 */
const FINAL = new Set([
  'attachment-invalid',
  'attachment-too-large',
  'attachment-type-unsupported',
  'attachment-image-unsupported',
  'attachment-image-invalid',
  'attachment-text-invalid',
  'request-conflict',
])

/**
 * Resumable uploads of one attachment in parts of at most 1 MiB, kept under `<dataDir>/attachments/_uploads/<id>/` as
 * `meta.json` (strict) and `data`, both private to the Host. A part may arrive out of order within `ATTACHMENT_PART_WINDOW`
 * of the first missing one and is written at its offset; the record keeps which parts arrived. A part already received
 * is answered again when its bytes are the same. Completion runs the store's content checks on the assembled file and
 * makes a normal draft. Everything is per device: another device's upload is not found.
 */
export class AttachmentUploads {
  private uploads = new Map<string, Upload>()
  /** `${owner}\0${requestId}` to its upload, so a start does not look through every record. */
  private requests = new Map<string, string>()
  /** Uploads whose declared bytes the store holds, by owner: given back exactly once. */
  private holding = new Map<string, string>()
  /** No record expires before this; pruning skips the scan until then. */
  private nextExpiry = Infinity
  private chains = new Map<string, Promise<unknown>>()
  private receiving = new Map<string, number>()
  private beginning: Promise<unknown> = Promise.resolve()
  private constructor(
    private readonly directory: string,
    private readonly store: AttachmentStore,
    private readonly now: () => number,
    private readonly persist: (path: string, text: string) => Promise<void>,
  ) {}
  static async open(
    dataDir: string,
    store: AttachmentStore,
    options: { now?: () => number; persist?: (path: string, text: string) => Promise<void> } = {},
  ): Promise<AttachmentUploads> {
    const directory = join(dataDir, 'attachments', '_uploads'),
      uploads = new AttachmentUploads(directory, store, options.now ?? Date.now, options.persist ?? writeFileAtomic)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (const name of await readdir(directory)) {
      const folder = join(directory, name)
      let upload: Upload | undefined
      try {
        upload = uploadSchema.parse(JSON.parse(await readFile(join(folder, 'meta.json'), 'utf8')))
        if (upload.id !== name) upload = undefined
        else if (isOpen(upload)) {
          // A part written before its record: the record is the truth, the bytes after the last recorded part go. A
          // missing part below it is a hole its own part fills later.
          const received = recordedEnd(upload),
            file = await open(join(folder, 'data'), constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
          try {
            const info = await file.stat()
            if (!info.isFile() || info.size < received) upload = undefined
            else if (info.size > received) await file.truncate(received)
          } finally {
            await file.close()
          }
        }
      } catch {
        upload = undefined
      }
      // Unfinished uploads are discardable: one that cannot be read is gone, and its device starts again.
      if (!upload || upload.touchedAt + ATTACHMENT_UPLOAD_TTL <= uploads.now()) {
        await rm(folder, { recursive: true, force: true })
        continue
      }
      uploads.remember(upload)
      if (isOpen(upload)) {
        store.hold(upload.owner, upload.size, true)
        uploads.holding.set(upload.id, upload.owner)
      }
    }
    await uploads.trim()
    return uploads
  }
  private folder(id: string): string {
    return join(this.directory, id)
  }
  private async save(upload: Upload): Promise<void> {
    await this.persist(join(this.folder(upload.id), 'meta.json'), JSON.stringify(upload) + '\n')
    this.remember(upload)
  }
  private remember(upload: Upload): void {
    this.uploads.set(upload.id, upload)
    this.requests.set(`${upload.owner}\0${upload.requestId}`, upload.id)
    this.nextExpiry = Math.min(this.nextExpiry, upload.touchedAt + ATTACHMENT_UPLOAD_TTL)
  }
  /** Gives the upload's held bytes back to the store, once. */
  private release(upload: Upload): void {
    if (this.holding.get(upload.id) !== upload.owner) return
    this.holding.delete(upload.id)
    this.store.unhold(upload.owner, upload.size)
  }
  /** Finished and refused records past the caps go, oldest first. */
  private async trim(owner?: string): Promise<void> {
    const kept = [...this.uploads.values()].filter(item => !isOpen(item)).sort((a, b) => a.touchedAt - b.touchedAt)
    const over = new Set<Upload>(kept.slice(0, Math.max(0, kept.length - ATTACHMENT_RECORDS_PER_HOST)))
    if (owner) {
      const own = kept.filter(item => item.owner === owner)
      for (const item of own.slice(0, Math.max(0, own.length - ATTACHMENT_RECORDS_PER_DEVICE))) over.add(item)
    }
    for (const item of over) await this.drop(item)
  }
  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(id) ?? Promise.resolve()).then(action, action)
    const settled = next.catch(() => {})
    this.chains.set(id, settled)
    void settled.then(() => {
      if (this.chains.get(id) === settled) this.chains.delete(id)
    })
    return next
  }
  private view(upload: Upload): AttachmentUploadView {
    const parts = partCount(upload.size)
    return {
      id: upload.id,
      requestId: upload.requestId,
      size: upload.size,
      partBytes: ATTACHMENT_PART_BYTES,
      parts,
      received: receivedParts(upload),
      next: firstMissing(upload) < parts ? firstMissing(upload) : null,
      bitmap: Array.from({ length: parts }, (_, index) => (upload.parts[index] ? '1' : '0')).join(''),
      expiresAt: upload.touchedAt + ATTACHMENT_UPLOAD_TTL,
      ...(upload.done ? { attachment: structuredClone(upload.done) } : {}),
    }
  }
  private find(owner: string, id: string): Upload {
    const upload = ID.test(id) ? this.uploads.get(id) : undefined
    if (!upload || upload.owner !== owner || upload.touchedAt + ATTACHMENT_UPLOAD_TTL <= this.now())
      throw new AppError(404, 'upload-missing', '这次上传已过期或不存在，请重新开始。')
    return upload
  }
  private refuse(upload: Upload): never {
    const failed = upload.failed!
    throw new AppError(failed.status, failed.code, failed.message)
  }
  private async drop(upload: Upload): Promise<void> {
    this.uploads.delete(upload.id)
    const key = `${upload.owner}\0${upload.requestId}`
    if (this.requests.get(key) === upload.id) this.requests.delete(key)
    this.release(upload)
    await rm(this.folder(upload.id), { recursive: true, force: true })
  }
  /** Removes uploads past their time; an unfinished one gives its held room back. Nothing to scan before the earliest expiry. */
  async prune(): Promise<void> {
    if (this.now() < this.nextExpiry) return
    this.nextExpiry = Infinity
    for (const upload of [...this.uploads.values()]) {
      if (upload.touchedAt + ATTACHMENT_UPLOAD_TTL > this.now()) {
        this.nextExpiry = Math.min(this.nextExpiry, upload.touchedAt + ATTACHMENT_UPLOAD_TTL)
        continue
      }
      await this.serial(upload.id, async () => {
        const current = this.uploads.get(upload.id)
        if (current && current.touchedAt + ATTACHMENT_UPLOAD_TTL <= this.now()) await this.drop(current)
        else if (current) this.nextExpiry = Math.min(this.nextExpiry, current.touchedAt + ATTACHMENT_UPLOAD_TTL)
      })
    }
  }
  /**
   * Starts an upload, or answers again for the same device and request: its upload as it stands, or the attachment that
   * request already made. Another file under the same request is a conflict.
   */
  async begin(input: {
    owner: string
    requestId: string
    name: string
    kind: 'image' | 'text' | 'file'
    size: number
    sha256: string
    remote: boolean
    context: AttachmentContext
  }): Promise<{ upload: AttachmentUploadView } | { attachment: AttachmentRef }> {
    const name = this.store.checkInput(input)
    if (input.kind === 'image' && input.size > ATTACHMENT_IMAGE_LIMIT)
      throw new AppError(415, 'attachment-image-unsupported', '图片仅支持 PNG、JPEG、GIF、WebP，每张最多 5 MB。')
    await this.prune()
    const run = async () => {
      const sameId = this.requests.get(`${input.owner}\0${input.requestId}`),
        same = sameId ? this.uploads.get(sameId) : undefined
      if (same && same.touchedAt + ATTACHMENT_UPLOAD_TTL > this.now()) {
        if (same.name !== name || same.size !== input.size || same.sha256 !== input.sha256 || same.kind !== input.kind)
          throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同附件。')
        return { upload: this.view(same) }
      }
      const made = this.store.made(input.owner, input.requestId)
      if (made) {
        if (made.inputHash !== attachmentInputHash(name, input.size, input.sha256))
          throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同附件。')
        return { attachment: made.ref }
      }
      const unfinished = [...this.holding.values()]
      if (
        unfinished.length >= ATTACHMENT_UPLOADS_PER_HOST
        || unfinished.filter(owner => owner === input.owner).length >= ATTACHMENT_UPLOADS_PER_DEVICE
      )
        throw new AppError(429, 'attachment-quota', '未完成的上传过多，请等待或取消一些上传后重试。')
      this.store.hold(input.owner, input.size)
      const at = this.now(),
        upload: Upload = {
          version: 1,
          id: randomBytes(16).toString('base64url'),
          owner: input.owner,
          requestId: input.requestId,
          name,
          kind: input.kind,
          size: input.size,
          sha256: input.sha256,
          remote: input.remote,
          context: input.context,
          createdAt: at,
          touchedAt: at,
          parts: [],
        }
      this.holding.set(upload.id, upload.owner)
      try {
        await mkdir(this.folder(upload.id), { mode: 0o700 })
        await (await open(join(this.folder(upload.id), 'data'), 'wx', 0o600)).close()
        await this.save(upload)
      } catch (error) {
        await this.drop(upload)
        throw error
      }
      return { upload: this.view(upload) }
    }
    // One start at a time, so two copies of the same request make one upload.
    const next = this.beginning.then(run, run)
    this.beginning = next.catch(() => {})
    return next
  }
  status(owner: string, id: string): AttachmentUploadView {
    const upload = this.find(owner, id)
    if (upload.failed) this.refuse(upload)
    return this.view(upload)
  }
  /**
   * Part `index` of the upload, written at its offset when it is within `ATTACHMENT_PART_WINDOW` of the first missing
   * part; one already received is answered again when its bytes are the same, and one further on is refused with the
   * part to send next. `recheck` runs before and after every chunk read. `limit`: parts this device may have being
   * received and written at once (`ATTACHMENT_PARTS_PER_BULK` on a bulk upload connection). `progress` hears every chunk.
   */
  async part(input: {
    owner: string
    id: string
    index: number
    declared?: number
    stream: AsyncIterable<Uint8Array>
    recheck: () => void | Promise<void>
    limit?: number
    progress?: (bytes: number) => void
  }): Promise<AttachmentUploadView> {
    const upload = this.find(input.owner, input.id)
    if (upload.failed) this.refuse(upload)
    const parts = partCount(upload.size)
    if (!Number.isSafeInteger(input.index) || input.index < 0 || input.index >= parts)
      throw new AppError(400, 'attachment-invalid', '分段序号无效。')
    const order = (current: Upload) => {
      const next = firstMissing(current)
      if (input.index >= next + ATTACHMENT_PART_WINDOW)
        throw new AppError(409, 'upload-part-order', `请先上传第 ${next + 1} 段。`, { next })
    }
    order(upload)
    const expected = input.index < parts - 1 ? ATTACHMENT_PART_BYTES : upload.size - ATTACHMENT_PART_BYTES * (parts - 1)
    if (input.declared !== undefined && input.declared > expected)
      throw new AppError(413, 'attachment-too-large', '分段超过这一段应有的大小。')
    const own = this.receiving.get(input.owner) ?? 0
    if (
      own >= Math.min(input.limit ?? ATTACHMENT_PARTS_PER_DEVICE, ATTACHMENT_PARTS_PER_BULK)
      || [...this.receiving.values()].reduce((sum, count) => sum + count, 0) >= PARTS_PER_HOST
    )
      throw new AppError(429, 'attachment-quota', '同时上传的附件过多，请稍后重试。')
    // The slot is held until the part is written, so bodies waiting for their turn count against it too.
    this.receiving.set(input.owner, own + 1)
    try {
      const check = async () => {
        // An abort or expiry meanwhile stops the reading too.
        this.find(input.owner, input.id)
        await input.recheck()
      }
      const chunks: Buffer[] = []
      let size = 0
      await check()
      for await (const chunk of input.stream) {
        await check()
        size += chunk.byteLength
        if (size > expected) throw new AppError(413, 'attachment-too-large', '分段超过这一段应有的大小。')
        chunks.push(Buffer.from(chunk))
        input.progress?.(chunk.byteLength)
        await check()
      }
      if (size !== expected) throw new AppError(400, 'attachment-incomplete', '这一段没有传完，请重试。')
      const body = Buffer.concat(chunks)
      const hash = createHash('sha256').update(body).digest('hex')
      return await this.serial(input.id, async () => {
        const current = this.find(input.owner, input.id)
        if (current.failed) this.refuse(current)
        const known = current.parts[input.index]
        if (known) {
          if (known !== hash)
            throw new AppError(409, 'upload-part-conflict', '这一段与已经收到的内容不同。', { next: this.view(current).next })
          return this.view(current)
        }
        order(current)
        await input.recheck()
        const file = await open(join(this.folder(current.id), 'data'), constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0))
        try {
          await file.write(body, 0, body.length, input.index * ATTACHMENT_PART_BYTES)
          await file.sync()
        } finally {
          await file.close()
        }
        const received = Array.from({ length: Math.max(current.parts.length, input.index + 1) }, (_, at) => current.parts[at] ?? null)
        received[input.index] = hash
        const next = { ...current, parts: received, touchedAt: this.now() }
        await this.save(next)
        return this.view(next)
      })
    } finally {
      const count = this.receiving.get(input.owner)!
      if (count <= 1) this.receiving.delete(input.owner)
      else this.receiving.set(input.owner, count - 1)
    }
  }
  /**
   * Checks the assembled file's size and SHA-256, then the same content checks as a single upload, and keeps it as a
   * draft. A refusal of the content is remembered and given again; a secret to confirm keeps the parts, so 仍然添加
   * completes again with `secretAcknowledged` and sends nothing twice.
   */
  async complete(input: {
    owner: string
    id: string
    remote: boolean
    secretAcknowledged?: boolean
    recheck: () => void | Promise<void>
    accept: (ref: AttachmentRef, context: AttachmentContext) => void | Promise<void>
    audit?: (ref: AttachmentRef) => Promise<void>
  }): Promise<AttachmentRef> {
    return this.serial(input.id, async () => {
      const upload = this.find(input.owner, input.id)
      if (upload.done) return structuredClone(upload.done)
      if (upload.failed) this.refuse(upload)
      // Kept before its record said so (a restart in between): the same request already made it.
      const made = this.store.made(upload.owner, upload.requestId)
      if (made && made.inputHash === attachmentInputHash(upload.name, upload.size, upload.sha256)) return this.finish(upload, made.ref)
      const parts = partCount(upload.size),
        received = receivedParts(upload)
      if (received < parts)
        throw new AppError(400, 'attachment-incomplete', `还有 ${parts - received} 段没有上传。`, { next: firstMissing(upload) })
      const file = join(this.folder(upload.id), 'data')
      if ((await stat(file)).size !== upload.size) throw new AppError(400, 'attachment-incomplete', '附件还有分段没有上传。')
      let ref: AttachmentRef
      // What the capability check says can pass, so it is never remembered as the answer.
      let capability = false
      try {
        ref = await this.store.adopt({
          owner: upload.owner,
          requestId: upload.requestId,
          name: upload.name,
          size: upload.size,
          sha256: upload.sha256,
          file,
          ...(input.secretAcknowledged ? { secretAcknowledged: true } : {}),
          recheck: input.recheck,
          accept: async ref => {
            // A declared `file` is whatever its content is; a declared picture or text must be that.
            if (upload.kind !== 'file' && ref.kind !== upload.kind)
              throw new AppError(415, 'attachment-invalid', '附件内容与开始上传时声明的类型不符。')
            capability = true
            await input.accept(ref, upload.context)
            capability = false
          },
          ...((input.remote || upload.remote) && input.audit ? { audit: input.audit } : {}),
        })
      } catch (error) {
        if (!capability && error instanceof AppError && FINAL.has(error.code)) {
          // The record first: if it cannot be written, nothing changed and the same completion can come again.
          await this.save({
            ...upload,
            touchedAt: this.now(),
            failed: { status: error.status, code: error.code, message: error.message.slice(0, 400) },
          })
          this.release(upload)
          await rm(file, { force: true })
          await this.trim(upload.owner)
        }
        throw error
      }
      return this.finish(upload, ref)
    })
  }
  /** The record first, then the held room: a record that cannot be written leaves the upload open and holding. */
  private async finish(upload: Upload, ref: AttachmentRef): Promise<AttachmentRef> {
    await this.save({ ...upload, touchedAt: this.now(), done: structuredClone(ref) })
    this.release(upload)
    await rm(join(this.folder(upload.id), 'data'), { force: true })
    await this.trim(upload.owner)
    return structuredClone(ref)
  }
  /** Stops and forgets the upload; parts on the Host go. A finished upload's attachment stays (`DELETE /attachments/:id`). */
  async abort(owner: string, id: string): Promise<void> {
    if (!ID.test(id)) return
    await this.serial(id, async () => {
      const upload = this.uploads.get(id)
      if (upload && upload.owner === owner) await this.drop(upload)
    })
  }
}
