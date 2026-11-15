import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { imageDimensions, isAttachmentRef, type AttachmentRef } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, redactSecrets, syncDirectory, writeFileAtomic } from '@latch/core/node-kit'
import { fileFormat } from './files/metadata.ts'
import { hasSecretContent, isSecretPath } from './files/secrets.ts'
export const ATTACHMENT_TTL = 60 * 60_000
/** How long a draft reserved for a request its session proved not to hold stays, counted from its upload. */
export const ATTACHMENT_CLAIM_TTL = 7 * 24 * 60 * 60_000
export const ATTACHMENT_FILE_LIMIT = 25 * 1024 * 1024
export const ATTACHMENT_REMOTE_LIMIT = 10 * 1024 * 1024
export const ATTACHMENT_IMAGE_LIMIT = 5 * 1024 * 1024
/** Per device: drafts, uploads under way and unfinished chunked uploads together. */
const ATTACHMENT_DEVICE_FILES = 32
export const ATTACHMENT_DEVICE_BYTES = 256 * 1024 * 1024
/** For the Host: drafts and every upload's bytes, received or held. */
const ATTACHMENT_HOST_BYTES = 1024 * 1024 * 1024
/** What a request named, so that its replay is told apart from another file under the same request ID. */
export function attachmentInputHash(name: string, size: number, sha256: string): string {
  return createHash('sha256').update(canonicalJson({ name, size, sha256 })).digest('hex')
}
const ID = /^[A-Za-z0-9_-]{22}$/u
const taskId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/u)
  .refine(value => value !== 'index.json')
const entrySchema = z.strictObject({
  ref: z.custom<AttachmentRef>(isAttachmentRef),
  owner: z.string().min(1).max(256),
  requestId: z.string().uuid(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: z.number().finite(),
  taskId: taskId.optional(),
  creationRequestId: z.string().uuid().optional(),
  claim: z.strictObject({ requestId: z.string().uuid(), sessionId: taskId.optional() }).optional(),
  secret: z.boolean(),
})
/** What a device released (`releaseReserved`): a later request naming it hears so, rather than that it never existed. */
const releasedSchema = z.strictObject({ owner: z.string().min(1).max(256), name: z.string().min(1).max(200), at: z.number().finite() })
const RELEASED_KEPT = 512
const indexSchema = z.strictObject({
  version: z.literal(1),
  entries: z.record(z.string().regex(ID), entrySchema),
  released: z.record(z.string().regex(ID), releasedSchema).optional(),
})
type Entry = z.infer<typeof entrySchema>
export type AttachmentData = { ref: AttachmentRef; data: Uint8Array; text?: string }
export interface AttachmentStoreOptions {
  deferPrune?: boolean
  now?: () => number
  persist?: (path: string, text: string) => Promise<void>
}
/** Private immutable blobs. Public access is adjudicated separately by the authenticated attachment routes. */
export class AttachmentStore {
  private state: z.infer<typeof indexSchema> = { version: 1, entries: {} }
  private serial: Promise<unknown> = Promise.resolve()
  private uploads = new Map<string, { count: number; bytes: number }>()
  private reservedBytes = 0
  /** Unfinished chunked uploads (`hold`), by owner: they count against the same quota as drafts. */
  private held = new Map<string, { count: number; bytes: number }>()
  private heldBytes = 0
  private leases = new Map<string, number>()
  private failure = false
  private readonly now: () => number
  private readonly persist: (path: string, text: string) => Promise<void>
  private constructor(
    private readonly directory: string,
    options: AttachmentStoreOptions,
  ) {
    this.now = options.now ?? Date.now
    this.persist = options.persist ?? writeFileAtomic
  }
  static async open(dataDir: string, options: AttachmentStoreOptions = {}): Promise<AttachmentStore> {
    const directory = join(dataDir, 'attachments'),
      store = new AttachmentStore(directory, options)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    await mkdir(join(directory, '_drafts'), { recursive: true, mode: 0o700 })
    try {
      store.state = indexSchema.parse(JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new AppError(503, 'attachments-unavailable', '附件索引无法验证，请修复存储后重启。')
    }
    if (!options.deferPrune) await store.prune()
    return store
  }
  private path(entry: Entry): string {
    return join(this.directory, entry.taskId ?? '_drafts', entry.ref.id)
  }
  private async commit(next: typeof this.state): Promise<void> {
    if (this.failure) throw new AppError(503, 'attachments-unavailable', '附件存储暂时不可用，请重启后重试。')
    try {
      await this.persist(join(this.directory, 'index.json'), JSON.stringify(next) + '\n')
      this.state = next
    } catch {
      this.failure = true
      throw new AppError(503, 'attachments-unavailable', '附件存储失败，上传结果未知，请重启后重试。')
    }
  }
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const next = this.serial.then(action, action)
    this.serial = next.catch(() => {})
    return next
  }
  /** The name, request and size an upload names, by the limits of its entry: `remote` is every entry but this Mac's. */
  checkInput(input: { name: string; requestId: string; size: number; remote: boolean }): string {
    if (this.failure) throw new AppError(503, 'attachments-unavailable', '附件存储暂时不可用，请重启后重试。')
    const name = input.name.trim()
    if (!name || name.length > 200 || /[\u0000-\u001f\u007f/\\]/u.test(name) || !z.string().uuid().safeParse(input.requestId).success)
      throw new AppError(400, 'attachment-invalid', '附件名称或请求标识无效。')
    const limit = input.remote ? ATTACHMENT_REMOTE_LIMIT : ATTACHMENT_FILE_LIMIT
    if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > limit)
      throw new AppError(413, 'attachment-too-large', input.remote ? '每个文件最多 10 MB。' : '每个文件最多 25 MB。')
    return name
  }
  /**
   * Room for `size` more bytes from `owner`: its drafts, uploads being received and unfinished chunked uploads count
   * against 32 files and 256 MiB per device and 1 GiB for the Host. `streaming`: a single-body upload, which also takes
   * one of the streams received at once (two per device, eight for the Host); a chunked upload's start holds bytes only.
   */
  private assertRoom(owner: string, size: number, streaming: boolean): void {
    const draft = Object.values(this.state.entries).filter(entry => !entry.taskId),
      own = draft.filter(entry => entry.owner === owner),
      active = this.uploads.get(owner) ?? { count: 0, bytes: 0 },
      held = this.held.get(owner) ?? { count: 0, bytes: 0 }
    if (
      (streaming && ([...this.uploads.values()].reduce((sum, item) => sum + item.count, 0) >= 8 || active.count >= 2))
      || this.reservedBytes + this.heldBytes + size + draft.reduce((sum, e) => sum + e.ref.size, 0) > ATTACHMENT_HOST_BYTES
      || own.length + active.count + held.count >= ATTACHMENT_DEVICE_FILES
      || own.reduce((sum, e) => sum + e.ref.size, 0) + active.bytes + held.bytes + size > ATTACHMENT_DEVICE_BYTES
    )
      throw new AppError(429, 'attachment-quota', '草稿附件过多，请移除一些附件或稍后重试。')
  }
  /**
   * Holds room for an unfinished chunked upload of `size` bytes until `unhold`: it counts as one of the device's drafts
   * from its start, so parts on disk can never pass the device's or the Host's quota. `restore`: at startup, without the
   * check, as the bytes are already on disk.
   */
  hold(owner: string, size: number, restore = false): void {
    if (!restore) this.assertRoom(owner, size, false)
    const held = this.held.get(owner) ?? { count: 0, bytes: 0 }
    this.held.set(owner, { count: held.count + 1, bytes: held.bytes + size })
    this.heldBytes += size
  }
  /** What unfinished chunked uploads of this owner hold. */
  holding(owner: string): { count: number; bytes: number } {
    return { ...(this.held.get(owner) ?? { count: 0, bytes: 0 }) }
  }
  unhold(owner: string, size: number): void {
    const held = this.held.get(owner)
    if (!held) return
    if (held.count <= 1) this.held.delete(owner)
    else this.held.set(owner, { count: held.count - 1, bytes: held.bytes - size })
    this.heldBytes -= size
  }
  /** The attachment this device's request already made, with the hash of what it named; for a replay of the request. */
  made(owner: string, requestId: string): { ref: AttachmentRef; inputHash: string } | undefined {
    const entry = Object.values(this.state.entries).find(item => item.owner === owner && item.requestId === requestId)
    return entry && !this.expired(entry) ? structuredClone({ ref: entry.ref, inputHash: entry.inputHash }) : undefined
  }
  /** Rechecks authorization before and after every received chunk and before publication. */
  async add(input: {
    owner: string
    requestId: string
    name: string
    size: number
    remote: boolean
    secretAcknowledged?: boolean
    stream: AsyncIterable<Uint8Array>
    recheck: () => void | Promise<void>
    accept: (ref: AttachmentRef) => void | Promise<void>
    audit?: (ref: AttachmentRef) => Promise<void>
  }): Promise<AttachmentRef> {
    const name = this.checkInput(input),
      limit = input.remote ? ATTACHMENT_REMOTE_LIMIT : ATTACHMENT_FILE_LIMIT
    await this.prune()
    await input.recheck()
    this.assertRoom(input.owner, input.size, true)
    const active = this.uploads.get(input.owner) ?? { count: 0, bytes: 0 }
    this.uploads.set(input.owner, { count: active.count + 1, bytes: active.bytes + input.size })
    this.reservedBytes += input.size
    const temporary = join(this.directory, '_drafts', `.upload-${randomUUID()}`),
      hash = createHash('sha256'),
      head: Buffer[] = []
    let fd: Awaited<ReturnType<typeof open>> | undefined
    let size = 0,
      headSize = 0
    try {
      fd = await open(temporary, 'wx', 0o600)
      for await (const chunk of input.stream) {
        await input.recheck()
        size += chunk.byteLength
        if (size > input.size || size > limit) throw new AppError(413, 'attachment-too-large', '附件超过声明的大小。')
        hash.update(chunk)
        if (headSize < 65536) {
          const part = Buffer.from(chunk.subarray(0, 65536 - headSize))
          head.push(part)
          headSize += part.length
        }
        await fd.writeFile(chunk)
        await input.recheck()
      }
      if (size !== input.size) throw new AppError(400, 'attachment-incomplete', '附件上传中断，草稿仍保留，请重试。')
      await fd.sync()
      await fd.close()
      return await this.publish({ ...input, name, size, sha256: hash.digest('hex'), head: Buffer.concat(head), temporary })
    } finally {
      await fd?.close().catch(() => {})
      await rm(temporary, { force: true }).catch(() => {})
      const current = this.uploads.get(input.owner)!
      if (current.count <= 1) this.uploads.delete(input.owner)
      else this.uploads.set(input.owner, { count: current.count - 1, bytes: current.bytes - input.size })
      this.reservedBytes -= input.size
    }
  }
  /**
   * A chunked upload's assembled file (`AttachmentUploads`): the same content checks and publication as `add`, after its
   * size and the SHA-256 named at its start are confirmed. The file is moved into the drafts when it is kept; otherwise
   * it stays where it is, for the caller to keep (a secret to confirm) or drop.
   */
  async adopt(input: {
    owner: string
    requestId: string
    name: string
    size: number
    sha256: string
    remote: boolean
    file: string
    secretAcknowledged?: boolean
    recheck: () => void | Promise<void>
    accept: (ref: AttachmentRef) => void | Promise<void>
    audit?: (ref: AttachmentRef) => Promise<void>
  }): Promise<AttachmentRef> {
    const name = this.checkInput(input)
    await input.recheck()
    const fd = await open(input.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const hash = createHash('sha256'),
      head = Buffer.alloc(Math.min(65536, input.size)),
      buffer = Buffer.alloc(1024 * 1024)
    let size = 0
    try {
      const info = await fd.stat()
      if (!info.isFile() || info.size !== input.size) throw new AppError(400, 'attachment-incomplete', '附件还有分段没有上传。')
      for (;;) {
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, size)
        if (!bytesRead) break
        if (size < head.length) buffer.copy(head, size, 0, Math.min(bytesRead, head.length - size))
        hash.update(buffer.subarray(0, bytesRead))
        size += bytesRead
        if (size > input.size) break
      }
    } finally {
      await fd.close()
    }
    if (size !== input.size) throw new AppError(400, 'attachment-incomplete', '附件还有分段没有上传。')
    const sha256 = hash.digest('hex')
    if (sha256 !== input.sha256) throw new AppError(400, 'attachment-invalid', '附件内容与开始上传时的摘要不一致。')
    return this.publish({ ...input, name, size, sha256, head, temporary: input.file })
  }
  /** Sniffs, checks and keeps a received file as this owner's draft; `temporary` is moved into the drafts on success. */
  private async publish(input: {
    owner: string
    requestId: string
    name: string
    size: number
    sha256: string
    head: Buffer
    temporary: string
    secretAcknowledged?: boolean
    recheck: () => void | Promise<void>
    accept: (ref: AttachmentRef) => void | Promise<void>
    audit?: (ref: AttachmentRef) => Promise<void>
  }): Promise<AttachmentRef> {
    const { name, size, head: first, temporary } = input
    await input.recheck()
    const ext = name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : '',
      format = fileFormat({ head: first, ext })
    if (format.kind !== 'image' && !['text', 'code', 'markdown', 'csv'].includes(format.kind))
      throw new AppError(
        415,
        'attachment-type-unsupported',
        format.kind === 'pdf' ? '尚未实现：需要在 Host 上解析 PDF。' : '当前 Harness 不接受这种附件。',
      )
    const image = format.kind === 'image'
    if (image && (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(format.mime) || size > ATTACHMENT_IMAGE_LIMIT))
      throw new AppError(415, 'attachment-image-unsupported', '图片仅支持 PNG、JPEG、GIF、WebP，每张最多 5 MB。')
    const dims = image ? imageDimensions(first, format.mime) : undefined
    if (image && (!dims || dims.width * dims.height > 40_000_000))
      throw new AppError(415, 'attachment-image-invalid', '图片尺寸无法验证，或超过 4,000 万像素。')
    const decoded = image ? undefined : this.decodeText(await readFile(temporary))
    const secret = isSecretPath(name, first) || hasSecretContent(image ? first : new TextEncoder().encode(decoded!))
    if (secret && !input.secretAcknowledged) throw new AppError(409, 'attachment-secret', '附件可能包含密钥，请确认后再添加。')
    const ref: AttachmentRef = {
      id: randomBytes(16).toString('base64url'),
      name: redactSecrets(name),
      mime: image ? (format.mime as AttachmentRef['mime']) : 'text/plain',
      kind: image ? 'image' : 'text',
      size,
      sha256: input.sha256,
      ...(dims ?? {}),
    }
    await input.accept(ref)
    await input.recheck()
    const inputHash = attachmentInputHash(name, size, ref.sha256)
    return await this.mutate(async () => {
      const replay = Object.values(this.state.entries).find(entry => entry.owner === input.owner && entry.requestId === input.requestId)
      if (replay) {
        if (replay.inputHash !== inputHash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同附件。')
        return structuredClone(replay.ref)
      }
      if (Object.keys(this.state.entries).length >= 50_000) throw new AppError(429, 'attachment-quota', '附件数量已达上限，请清理旧会话。')
      await input.recheck()
      await input.audit?.(ref)
      await input.recheck()
      const entry: Entry = { ref, owner: input.owner, requestId: input.requestId, inputHash, createdAt: this.now(), secret }
      await rename(temporary, this.path(entry))
      await syncDirectory(join(this.directory, '_drafts'))
      const next = structuredClone(this.state)
      next.entries[ref.id] = entry
      await this.commit(next)
      return structuredClone(ref)
    })
  }
  private expired(entry: Entry): boolean {
    // A dispatched request with an unknown outcome is no longer an unsubmitted draft.
    return (
      !entry.taskId
      && !entry.claim
      && !entry.creationRequestId
      && Math.max(entry.createdAt + ATTACHMENT_TTL, this.leases.get(entry.ref.id) ?? 0) <= this.now()
    )
  }
  get(id: string): { ref: AttachmentRef; owner: string; taskId?: string; creationRequestId?: string; secret: boolean } | undefined {
    const entry = this.state.entries[id]
    if (!ID.test(id) || !entry || this.expired(entry)) return undefined
    return structuredClone({
      ref: entry.ref,
      owner: entry.owner,
      secret: entry.secret,
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
      ...(entry.creationRequestId ? { creationRequestId: entry.creationRequestId } : {}),
    })
  }
  refs(owner: string, ids: readonly string[], sessionId?: string, creationRequestId?: string): AttachmentRef[] {
    if (this.failure) throw new AppError(503, 'attachments-unavailable', '附件存储暂时不可用，请重启后重试。')
    if (ids.length > 8 || new Set(ids).size !== ids.length) throw new AppError(400, 'attachment-count', '每条消息最多 8 个不同附件。')
    const refs = ids.map(id => {
      const entry = this.get(id)
      const gone = entry ? undefined : this.state.released?.[id]
      if (gone && gone.owner === owner)
        throw new AppError(409, 'attachment-released', `附件「${gone.name}」已在 设置 › 设备 里释放，请重新添加。`)
      if (
        !entry
        || (entry.taskId
          ? entry.taskId !== sessionId
            && !(sessionId === undefined && entry.owner === owner && creationRequestId && entry.creationRequestId === creationRequestId)
          : entry.owner !== owner)
      )
        throw new AppError(404, 'attachment-missing', '附件已过期或不属于这条消息，请重新添加。')
      const stored = this.state.entries[id]!,
        claim = stored.claim ?? (stored.creationRequestId ? { requestId: stored.creationRequestId } : undefined)
      if (!stored.taskId && creationRequestId && claim && (claim.requestId !== creationRequestId || claim.sessionId !== sessionId))
        throw new AppError(409, 'attachment-claimed', '附件已保留给另一条提交。请重试原提交，或移除附件后重新添加。')
      return entry.ref
    })
    for (const ref of refs) if (!this.state.entries[ref.id]!.taskId) this.leases.set(ref.id, this.now() + ATTACHMENT_TTL)
    return refs
  }
  hasDrafts(): boolean {
    return Object.values(this.state.entries).some(entry => !entry.taskId)
  }
  async claim(owner: string, ids: readonly string[], requestId: string, sessionId?: string): Promise<void> {
    await this.mutate(async () => {
      this.refs(owner, ids, sessionId, requestId)
      const next = structuredClone(this.state)
      let changed = false
      for (const id of ids) {
        const entry = next.entries[id]!
        if (entry.taskId) continue
        const previous = entry.claim ?? (entry.creationRequestId ? { requestId: entry.creationRequestId } : undefined)
        if (previous && (previous.requestId !== requestId || previous.sessionId !== sessionId))
          throw new AppError(409, 'attachment-claimed', '附件已保留给另一条提交。请重试原提交，或移除附件后重新添加。')
        if (entry.claim) continue
        entry.claim = { requestId, ...(sessionId ? { sessionId } : {}) }
        if (!sessionId) entry.creationRequestId = requestId
        changed = true
      }
      if (changed) await this.commit(next)
    })
  }
  async releaseClaim(owner: string, ids: readonly string[], requestId: string, sessionId?: string): Promise<void> {
    await this.mutate(async () => {
      const next = structuredClone(this.state)
      let changed = false
      for (const id of ids) {
        const entry = next.entries[id]
        if (!entry || entry.taskId || entry.owner !== owner || entry.claim?.requestId !== requestId || entry.claim.sessionId !== sessionId)
          continue
        delete entry.claim
        if (entry.creationRequestId === requestId) delete entry.creationRequestId
        changed = true
      }
      if (changed) await this.commit(next)
    })
  }
  async bind(owner: string, ids: readonly string[], sessionId: string, creationRequestId?: string): Promise<void> {
    taskId.parse(sessionId)
    await this.mutate(async () => {
      if (
        ids.length > 8
        || new Set(ids).size !== ids.length
        || ids.some(id => {
          const entry = this.state.entries[id]
          return (
            !entry
            || (entry.taskId
              ? entry.taskId !== sessionId
              : entry.owner !== owner
                || Boolean(
                  entry.claim
                  && (entry.claim.sessionId ? entry.claim.sessionId !== sessionId : entry.claim.requestId !== creationRequestId),
                ))
          )
        })
      )
        throw new AppError(404, 'attachment-missing', '附件不可用。')
      const next = structuredClone(this.state)
      await mkdir(join(this.directory, sessionId), { recursive: true, mode: 0o700 })
      for (const id of ids) {
        const entry = next.entries[id]!
        if (entry.taskId) continue
        const original = this.path(entry)
        entry.taskId = sessionId
        delete entry.claim
        if (creationRequestId) entry.creationRequestId = creationRequestId
        await copyFile(original, this.path(entry), constants.COPYFILE_EXCL).catch(async error => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          const existing = await readFile(this.path(entry))
          if (createHash('sha256').update(existing).digest('hex') !== entry.ref.sha256)
            throw new AppError(409, 'attachment-changed', '附件内容已变化。')
        })
      }
      for (const id of ids) {
        const file = await open(this.path(next.entries[id]!), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
          await file.sync()
        } finally {
          await file.close()
        }
      }
      await syncDirectory(join(this.directory, sessionId))
      await this.commit(next)
      for (const id of ids) this.leases.delete(id)
      for (const id of ids) await rm(join(this.directory, '_drafts', id), { force: true })
    })
  }
  async read(ref: AttachmentRef): Promise<AttachmentData> {
    const entry = this.state.entries[ref.id]
    if (!entry || !isAttachmentRef(ref) || canonicalJson(entry.ref) !== canonicalJson(ref))
      throw new AppError(404, 'attachment-missing', '附件不可用。')
    const fd = await open(this.path(entry), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => {
      throw new AppError(409, 'attachment-changed', '附件内容已变化，请重新添加。')
    })
    try {
      const info = await fd.stat()
      if (!info.isFile() || info.size !== ref.size) throw new Error('attachment-changed')
      const data = Buffer.alloc(ref.size)
      let at = 0
      while (at < data.length) {
        const chunk = await fd.read(data, at, data.length - at, at)
        if (!chunk.bytesRead) throw new Error('attachment-changed')
        at += chunk.bytesRead
      }
      if ((await fd.stat()).size !== ref.size) throw new Error('attachment-changed')
      if (createHash('sha256').update(data).digest('hex') !== ref.sha256) throw new Error('attachment-changed')
      return { ref: structuredClone(entry.ref), data, ...(ref.kind === 'text' ? { text: this.decodeText(data) } : {}) }
    } catch {
      throw new AppError(409, 'attachment-changed', '附件内容已变化，请重新添加。')
    } finally {
      await fd.close()
    }
  }
  private decodeText(data: Uint8Array): string {
    try {
      const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8'
      const text = new TextDecoder(encoding, { fatal: true }).decode(data)
      if (text.includes('\0')) throw new Error('binary')
      return text
    } catch {
      throw new AppError(415, 'attachment-text-invalid', '附件不是有效文本。')
    }
  }
  /** Restore an interrupted post-create binding before expired, unreferenced drafts can be removed. */
  async recoverSession(sessionId: string, refs: readonly AttachmentRef[]): Promise<void> {
    for (const ref of refs) {
      const entry = this.state.entries[ref.id]
      if (!entry || entry.taskId || canonicalJson(entry.ref) !== canonicalJson(ref)) continue
      await this.bind(entry.owner, [ref.id], sessionId, entry.creationRequestId)
    }
  }
  /**
   * Drops the owner's unsent draft. One reserved for a create or prompt that is on its way, was accepted in this run or
   * waits in a queue (`busy`, the same rule as releasing) stays: that message may still need its bytes.
   */
  async remove(id: string, owner: string, busy: (requestId: string) => boolean = () => false): Promise<void> {
    await this.mutate(async () => {
      const entry = this.state.entries[id]
      if (!entry || entry.taskId || entry.owner !== owner) return
      const claim = entry.claim ?? (entry.creationRequestId ? { requestId: entry.creationRequestId } : undefined)
      if (claim && busy(claim.requestId))
        throw new AppError(409, 'attachment-in-use', '这个附件属于一条还在发送的消息，确认结果前不能移除。')
      const next = structuredClone(this.state)
      delete next.entries[id]
      await this.commit(next)
      this.leases.delete(id)
      await rm(this.path(entry), { force: true })
    })
  }
  async removeTask(sessionId: string): Promise<void> {
    taskId.parse(sessionId)
    await this.mutate(async () => {
      const next = structuredClone(this.state),
        reserved: Entry[] = []
      for (const [id, entry] of Object.entries(next.entries)) {
        // A draft reserved for a prompt to this session is needed by no message once the session is gone.
        if (!entry.taskId && entry.claim?.sessionId === sessionId) reserved.push(entry)
        else if (entry.taskId !== sessionId) continue
        delete next.entries[id]
      }
      await this.commit(next)
      for (const entry of reserved) {
        this.leases.delete(entry.ref.id)
        await rm(this.path(entry), { force: true })
      }
      await rm(join(this.directory, taskId.parse(sessionId)), { recursive: true, force: true })
    })
  }
  /**
   * Drafts reserved for a request to an existing session that this startup proved no message needs: the session was
   * listed and read (`listed`, each session's message attachment IDs) and none of its messages names the draft. A device
   * gave that request up (放弃这次提交), and the draft would otherwise count against its quota for good. Anything not
   * proved is kept: a session whose Harness is off, failed to list or is unknown, and a new session's request, whose
   * session is unknown. Only at startup: while the Host runs, a reserved draft may belong to a request still under way.
   * A retry of the old request then hears `attachment-missing`, which is true: its session holds no such message.
   */
  async pruneAbandonedClaims(listed: ReadonlyMap<string, ReadonlySet<string>>): Promise<void> {
    await this.mutate(async () => {
      const next = structuredClone(this.state),
        removed: Entry[] = []
      for (const [id, entry] of Object.entries(next.entries)) {
        const sessionId = entry.claim?.sessionId,
          named = sessionId === undefined ? undefined : listed.get(sessionId)
        if (entry.taskId || !named || named.has(id) || entry.createdAt + ATTACHMENT_CLAIM_TTL > this.now()) continue
        removed.push(entry)
        delete next.entries[id]
      }
      if (!removed.length) return
      await this.commit(next)
      for (const entry of removed) {
        this.leases.delete(entry.ref.id)
        await rm(this.path(entry), { force: true })
      }
    })
  }
  /** This owner's uploads held for a submission (`claim`) and not in a session: what 放弃 can leave behind. */
  reserved(owner: string): Array<{ id: string; size: number; requestId: string; sessionId?: string }> {
    const held: Array<{ id: string; size: number; requestId: string; sessionId?: string }> = []
    for (const [id, entry] of Object.entries(this.state.entries)) {
      const claim = entry.claim ?? (entry.creationRequestId ? { requestId: entry.creationRequestId } : undefined)
      if (entry.taskId || entry.owner !== owner || !claim) continue
      held.push({ id, size: entry.ref.size, requestId: claim.requestId, ...(claim.sessionId ? { sessionId: claim.sessionId } : {}) })
    }
    return held
  }
  /**
   * Removes the owner's reserved uploads among `ids` that are still reserved for the same request: the caller proved no
   * saved message needs them. `busy` is asked again here, in the store's turn, for each request: a retry that arrived
   * while the proof read the sessions keeps its upload. Returns what was removed.
   */
  async releaseReserved(
    owner: string,
    proven: ReadonlyMap<string, string>,
    busy: (requestId: string) => boolean,
  ): Promise<{ count: number; bytes: number }> {
    return this.mutate(async () => {
      const next = structuredClone(this.state),
        removed: Entry[] = []
      for (const [id, requestId] of proven) {
        const entry = next.entries[id]
        const claim = entry?.claim ?? (entry?.creationRequestId ? { requestId: entry.creationRequestId } : undefined)
        if (!entry || entry.taskId || entry.owner !== owner || claim?.requestId !== requestId || busy(requestId)) continue
        removed.push(entry)
        delete next.entries[id]
        next.released = { ...next.released, [id]: { owner, name: entry.ref.name, at: this.now() } }
      }
      if (!removed.length) return { count: 0, bytes: 0 }
      const kept = Object.entries(next.released ?? {}).sort((a, b) => b[1].at - a[1].at)
      if (kept.length > RELEASED_KEPT) next.released = Object.fromEntries(kept.slice(0, RELEASED_KEPT))
      await this.commit(next)
      for (const entry of removed) {
        this.leases.delete(entry.ref.id)
        await rm(this.path(entry), { force: true })
      }
      return { count: removed.length, bytes: removed.reduce((sum, entry) => sum + entry.ref.size, 0) }
    })
  }
  async prune(): Promise<void> {
    await this.mutate(async () => {
      const next = structuredClone(this.state),
        removed: Entry[] = []
      for (const [id, entry] of Object.entries(next.entries))
        if (this.expired(entry)) {
          removed.push(entry)
          delete next.entries[id]
        }
      if (removed.length) await this.commit(next)
      for (const entry of removed) {
        this.leases.delete(entry.ref.id)
        await rm(this.path(entry), { force: true })
      }
      for (const name of await readdir(join(this.directory, '_drafts'))) {
        if (
          !/^\.upload-[a-f0-9-]+$/u.test(name)
          && !(ID.test(name) && (!this.state.entries[name] || this.state.entries[name]!.taskId !== undefined))
        )
          continue
        const path = join(this.directory, '_drafts', name),
          info = await lstat(path).catch(() => undefined)
        if (info && info.mtimeMs + ATTACHMENT_TTL <= this.now()) await rm(path, { force: true })
      }
    })
  }
}
