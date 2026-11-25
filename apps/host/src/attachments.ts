import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, type FileHandle } from 'node:fs/promises'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import {
  ATTACHMENT_FILE_BYTES,
  ATTACHMENT_FILE_MIMES,
  ATTACHMENT_IMAGE_MIMES,
  imageDimensions,
  isAttachmentRef,
  type AttachmentFileMime,
  type AttachmentRef,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, redactSecrets, syncDirectory, writeFileAtomic } from '@latch/core/node-kit'
import { fileFormat } from './files/metadata.ts'
import { hasSecretContent, isSecretPath } from './files/secrets.ts'
export const ATTACHMENT_TTL = 60 * 60_000
/** How long a draft reserved for a request its session proved not to hold stays, counted from its upload. */
export const ATTACHMENT_CLAIM_TTL = 7 * 24 * 60 * 60_000
export const ATTACHMENT_FILE_LIMIT = ATTACHMENT_FILE_BYTES
export const ATTACHMENT_IMAGE_LIMIT = 5 * 1024 * 1024
/** Per device: drafts, uploads under way and unfinished chunked uploads together. */
const ATTACHMENT_DEVICE_FILES = 32
export const ATTACHMENT_DEVICE_BYTES = 512 * 1024 * 1024
/** For the Host: drafts and every upload's bytes, received or held. */
const ATTACHMENT_HOST_BYTES = 2 * 1024 * 1024 * 1024
/** Stored bytes are hashed and copied a mebibyte at a time, never held whole: a file may be 50 MiB. */
const READ_CHUNK = 1024 * 1024
/** Files whose whole content was checked against their ref, remembered by the file they were read from. */
const VERIFIED_FILES = 256
/** A stored attachment opened for reading ranges, after its whole content was checked once against its ref. */
export interface AttachmentReader {
  /** `length` bytes from `offset`, inside the file. */
  read(offset: number, length: number): Promise<Buffer>
  close(): Promise<void>
}
/** The file a descriptor holds, as far as a write to it would change: device, inode, size and both times. */
function fileIdentity(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
}
async function writeAll(file: FileHandle, chunk: Uint8Array): Promise<void> {
  for (let at = 0; at < chunk.byteLength;) at += (await file.write(chunk, at, chunk.byteLength - at)).bytesWritten
}
/** What a request named, so that its replay is told apart from another file under the same request ID. */
export function attachmentInputHash(name: string, size: number, sha256: string): string {
  return createHash('sha256').update(canonicalJson({ name, size, sha256 })).digest('hex')
}
const ID = /^[A-Za-z0-9_-]{22}$/u
const TEXT_FORMATS = new Set(['text', 'code', 'markdown', 'csv', 'html', 'svg'])
const OFFICE: Record<string, AttachmentFileMime> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'])
/**
 * What a file is, by its content: a picture a model can see (PNG, JPEG, GIF, WebP up to 5 MiB), text, or a file of a
 * sniffed type. Every file is one of the three: nothing is refused for its type.
 */
export function attachmentKind(
  head: Uint8Array,
  ext: string,
  size: number,
):
  | { kind: 'image'; mime: (typeof ATTACHMENT_IMAGE_MIMES)[number] }
  | { kind: 'text'; mime: 'text/plain' }
  | { kind: 'file'; mime: AttachmentFileMime } {
  const brand =
    head.length >= 12 && String.fromCharCode(...head.subarray(4, 8)) === 'ftyp' ? String.fromCharCode(...head.subarray(8, 12)) : ''
  if (HEIF_BRANDS.has(brand)) return { kind: 'file', mime: 'image/heic' }
  if (brand === 'qt  ') return { kind: 'file', mime: 'video/quicktime' }
  const format = fileFormat({ head, ext })
  if (format.kind === 'image') {
    const mime = format.mime as AttachmentFileMime
    return (ATTACHMENT_IMAGE_MIMES as readonly string[]).includes(mime) && size <= ATTACHMENT_IMAGE_LIMIT
      ? { kind: 'image', mime: mime as (typeof ATTACHMENT_IMAGE_MIMES)[number] }
      : { kind: 'file', mime: (ATTACHMENT_FILE_MIMES as readonly string[]).includes(mime) ? mime : 'application/octet-stream' }
  }
  if (TEXT_FORMATS.has(format.kind)) return { kind: 'text', mime: 'text/plain' }
  if (format.kind === 'pdf') return { kind: 'file', mime: 'application/pdf' }
  if (format.kind === 'docx' || format.kind === 'xlsx' || format.kind === 'pptx') return { kind: 'file', mime: OFFICE[format.kind]! }
  if (format.kind === 'binary' && ext === 'zip' && head[0] === 0x50 && head[1] === 0x4b) return { kind: 'file', mime: 'application/zip' }
  if (format.kind === 'audio' || format.kind === 'video') {
    // An ID3 tag opens MP3 files far more often than FLAC ones; a QuickTime file may lack its `ftyp`.
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33)
      return { kind: 'file', mime: ext === 'flac' ? 'audio/flac' : 'audio/mpeg' }
    if (format.kind === 'video' && ext === 'mov') return { kind: 'file', mime: 'video/quicktime' }
    const mime = format.mime as AttachmentFileMime
    return { kind: 'file', mime: (ATTACHMENT_FILE_MIMES as readonly string[]).includes(mime) ? mime : 'application/octet-stream' }
  }
  return { kind: 'file', mime: 'application/octet-stream' }
}
/** A name an agent's tools can open: the attachment's own, without separators, control characters or a leading dot. */
export function attachmentFileName(name: string): string {
  const plain = name.replace(/[\u0000-\u001f\u007f/\\:]/gu, '_').trim()
  return (plain.startsWith('.') ? `_${plain}` : plain || 'attachment').slice(0, 200)
}
/** A directory of Latch's own: made 0700 when missing, and refused when what is there is a link or not a directory. */
async function privateFolder(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError(409, 'attachment-changed', '附件目录已变化，请重新添加。')
  await chmod(path, 0o700)
}
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
  claim: z.strictObject({ requestId: z.string().uuid(), sessionId: taskId.optional(), steer: z.literal(true).optional() }).optional(),
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
  /** By attachment ID: the identity of the file last checked whole against its ref (`reader`). */
  private readonly verified = new Map<string, string>()
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
  /** Binding must not unlink a draft during a finite content read: even an open descriptor's ctime changes. */
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const next = this.serial.then(action, action)
    this.serial = next.catch(() => {})
    return next
  }
  /** The name, request and size an upload names: one size limit for every entrance. */
  checkInput(input: { name: string; requestId: string; size: number }): string {
    if (this.failure) throw new AppError(503, 'attachments-unavailable', '附件存储暂时不可用，请重启后重试。')
    const name = input.name.trim()
    if (!name || name.length > 200 || /[\u0000-\u001f\u007f/\\]/u.test(name) || !z.string().uuid().safeParse(input.requestId).success)
      throw new AppError(400, 'attachment-invalid', '附件名称或请求标识无效。')
    if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > ATTACHMENT_FILE_LIMIT)
      throw new AppError(413, 'attachment-too-large', '每个文件最多 50 MB。')
    return name
  }
  /**
   * Room for `size` more bytes from `owner`: its drafts, uploads being received and unfinished chunked uploads count
   * against 32 files and 512 MiB per device and 2 GiB for the Host. `streaming`: a single-body upload, which also takes
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
    secretAcknowledged?: boolean
    stream: AsyncIterable<Uint8Array>
    recheck: () => void | Promise<void>
    accept: (ref: AttachmentRef) => void | Promise<void>
    audit?: (ref: AttachmentRef) => Promise<void>
  }): Promise<AttachmentRef> {
    const name = this.checkInput(input)
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
        if (size > input.size || size > ATTACHMENT_FILE_LIMIT) throw new AppError(413, 'attachment-too-large', '附件超过声明的大小。')
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
  /**
   * A sent attachment taken again as this owner's draft (从这里编辑 puts a message's attachments back in the composer): its
   * stored bytes, checked against their hash, published as a new draft under the same checks as an upload. The caller
   * has checked that the owner may read the source.
   */
  async copy(input: {
    owner: string
    requestId: string
    source: AttachmentRef
    secretAcknowledged?: boolean
    recheck: () => void | Promise<void>
    accept: (ref: AttachmentRef) => void | Promise<void>
    audit?: (ref: AttachmentRef) => Promise<void>
  }): Promise<AttachmentRef> {
    const { source } = input
    const name = this.checkInput({ name: source.name, requestId: input.requestId, size: source.size })
    const replay = this.made(input.owner, input.requestId)
    if (replay) {
      if (replay.inputHash !== attachmentInputHash(name, source.size, source.sha256))
        throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同附件。')
      return replay.ref
    }
    await this.prune()
    await input.recheck()
    // A copy is an upload: it takes one of the device's and the Host's upload slots and its bytes from the quota, at
    // once and with nothing awaited in between, as `add` does.
    this.assertRoom(input.owner, source.size, true)
    const active = this.uploads.get(input.owner) ?? { count: 0, bytes: 0 }
    this.uploads.set(input.owner, { count: active.count + 1, bytes: active.bytes + source.size })
    this.reservedBytes += source.size
    const temporary = join(this.directory, '_drafts', `.upload-${randomUUID()}`)
    try {
      const stored = this.state.entries[source.id]
      if (!stored || canonicalJson(stored.ref) !== canonicalJson(source)) throw new AppError(404, 'attachment-missing', '附件不可用。')
      // Streamed from the stored file into the new draft, checked against the size and hash it was stored with.
      const from = await open(this.path(stored), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => {
        throw new AppError(409, 'attachment-changed', '附件内容已变化，请重新添加。')
      })
      const to = await open(temporary, 'wx', 0o600)
      const hash = createHash('sha256'),
        head = Buffer.alloc(Math.min(65536, source.size)),
        buffer = Buffer.alloc(1024 * 1024)
      let size = 0
      try {
        const info = await from.stat()
        if (!info.isFile() || info.size !== source.size) throw new AppError(409, 'attachment-changed', '附件内容已变化，请重新添加。')
        for (;;) {
          const { bytesRead } = await from.read(buffer, 0, buffer.length, size)
          if (!bytesRead) break
          if (size + bytesRead > source.size) throw new AppError(409, 'attachment-changed', '附件内容已变化，请重新添加。')
          if (size < head.length) buffer.copy(head, size, 0, Math.min(bytesRead, head.length - size))
          hash.update(buffer.subarray(0, bytesRead))
          await to.writeFile(buffer.subarray(0, bytesRead))
          size += bytesRead
          await input.recheck()
        }
        if (size !== source.size || hash.digest('hex') !== source.sha256)
          throw new AppError(409, 'attachment-changed', '附件内容已变化，请重新添加。')
        await to.sync()
      } finally {
        await from.close()
        await to.close()
      }
      return await this.publish({ ...input, name, size: source.size, sha256: source.sha256, head, temporary })
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
      const current = this.uploads.get(input.owner)!
      if (current.count <= 1) this.uploads.delete(input.owner)
      else this.uploads.set(input.owner, { count: current.count - 1, bytes: current.bytes - source.size })
      this.reservedBytes -= source.size
    }
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
    const ext = name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : ''
    const kind = attachmentKind(first, ext, size)
    const dims = kind.kind === 'image' ? imageDimensions(first, kind.mime) : undefined
    // A picture whose size cannot be read, or that is too large to show, still goes: as a file, by its path.
    const picture = kind.kind === 'image' && dims && dims.width * dims.height <= 40_000_000
    const text = kind.kind === 'text' ? this.textOf(await readFile(temporary)) : undefined
    const sniffed: { kind: AttachmentRef['kind']; mime: AttachmentRef['mime'] } =
      kind.kind === 'image' && !picture
        ? { kind: 'file', mime: kind.mime }
        : kind.kind === 'text' && text === undefined
          ? { kind: 'file', mime: 'application/octet-stream' }
          : kind
    const secret = isSecretPath(name, first) || hasSecretContent(text === undefined ? first : new TextEncoder().encode(text))
    if (secret && !input.secretAcknowledged) throw new AppError(409, 'attachment-secret', '附件可能包含密钥，请确认后再添加。')
    const ref: AttachmentRef = {
      id: randomBytes(16).toString('base64url'),
      name: redactSecrets(name),
      mime: sniffed.mime,
      kind: sniffed.kind,
      size,
      sha256: input.sha256,
      ...(picture ? dims : {}),
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
  async claim(owner: string, ids: readonly string[], requestId: string, sessionId?: string, steer = false): Promise<void> {
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
        if (entry.claim && (!steer || entry.claim.steer)) continue
        entry.claim = { requestId, ...(sessionId ? { sessionId } : {}), ...(steer ? { steer: true as const } : {}) }
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
          if (!(await this.holds(this.path(entry), entry.ref))) throw new AppError(409, 'attachment-changed', '附件内容已变化。')
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
  /** The entry `ref` names, exactly as stored. */
  private entryOf(ref: AttachmentRef): Entry {
    const entry = this.state.entries[ref.id]
    if (!entry || !isAttachmentRef(ref) || canonicalJson(entry.ref) !== canonicalJson(ref))
      throw new AppError(404, 'attachment-missing', '附件不可用。')
    return entry
  }
  /**
   * Reads the whole file through `file` a mebibyte at a time, checking its size and hash against `ref`; `each` sees every
   * chunk (a reused buffer: write or copy it before returning). Returns the identity of the file it checked.
   */
  private async check(file: FileHandle, ref: AttachmentRef, each?: (chunk: Buffer) => Promise<void>): Promise<string> {
    const before = await file.stat()
    if (!before.isFile() || before.size !== ref.size) throw new Error('attachment-changed')
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(Math.max(1, Math.min(ref.size, READ_CHUNK)))
    for (let at = 0; at < ref.size;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, ref.size - at), at)
      if (!bytesRead) throw new Error('attachment-changed')
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      await each?.(chunk)
      at += bytesRead
    }
    const after = await file.stat()
    if (fileIdentity(after) !== fileIdentity(before) || hash.digest('hex') !== ref.sha256) throw new Error('attachment-changed')
    return fileIdentity(after)
  }
  /** Whether the plain file at `path` (no link followed) holds exactly `ref`'s bytes. */
  private async holds(path: string, ref: AttachmentRef): Promise<boolean> {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => undefined)
    if (!file) return false
    try {
      await this.check(file, ref)
      return true
    } catch {
      return false
    } finally {
      await file.close()
    }
  }
  /**
   * Opens a stored attachment for reading ranges, without holding it whole. Its whole content is checked against its
   * ref the first time, and again whenever the file is no longer the one checked (another inode, size or time).
   */
  reader(ref: AttachmentRef): Promise<AttachmentReader> {
    return this.mutate(() => this.openReader(ref))
  }
  private async openReader(ref: AttachmentRef): Promise<AttachmentReader> {
    const entry = this.entryOf(ref)
    const changed = () => new AppError(409, 'attachment-changed', '附件内容已变化，请重新添加。')
    const file = await open(this.path(entry), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => {
      throw changed()
    })
    try {
      const identity = fileIdentity(await file.stat())
      if (this.verified.get(ref.id) !== identity) {
        const checked = await this.check(file, ref)
        this.verified.delete(ref.id)
        this.verified.set(ref.id, checked)
        if (this.verified.size > VERIFIED_FILES) this.verified.delete(this.verified.keys().next().value!)
      }
    } catch {
      this.verified.delete(ref.id)
      await file.close()
      throw changed()
    }
    return {
      read: async (offset, length) => {
        const data = Buffer.alloc(length)
        for (let at = 0; at < length;) {
          const { bytesRead } = await file.read(data, at, length - at, offset + at)
          if (!bytesRead) {
            this.verified.delete(ref.id)
            throw changed()
          }
          at += bytesRead
        }
        return data
      },
      close: () => file.close(),
    }
  }
  read(ref: AttachmentRef): Promise<AttachmentData> {
    return this.mutate(() => this.readContent(ref))
  }
  private async readContent(ref: AttachmentRef): Promise<AttachmentData> {
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
  /**
   * A sent attachment as a file its agent opens with its own tools: `attachments/<session>/files/<id>/<name>` in the data
   * directory, 0600 in 0700 folders, written from the stored bytes after their hash is checked. No link is followed: a
   * folder must be a real directory, the file is written beside its place and renamed onto it, and a copy left there is
   * kept only while it is a plain file with the same bytes. Removed with the session, or by `prune` when no attachment
   * is bound to that session.
   */
  materialize(ref: AttachmentRef, sessionId: string): Promise<string> {
    return this.mutate(() => this.materializeFile(ref, sessionId))
  }
  private async materializeFile(ref: AttachmentRef, sessionId: string): Promise<string> {
    const entry = this.state.entries[ref.id]
    // The run may start before its draft is bound to the session (`bind`); a draft bound elsewhere is not this one's.
    if (!entry || (entry.taskId ?? sessionId) !== sessionId || !taskId.safeParse(sessionId).success)
      throw new AppError(404, 'attachment-missing', '附件不可用。')
    this.entryOf(ref)
    const session = join(this.directory, sessionId),
      files = join(session, 'files'),
      folder = join(files, ref.id)
    for (const path of [session, files, folder]) await privateFolder(path)
    const target = join(folder, attachmentFileName(ref.name))
    const existing = await lstat(target).catch(() => undefined)
    if (existing?.isFile() && existing.size === ref.size && (await this.holds(target, ref))) return target
    // Copied a mebibyte at a time while its hash is checked: a stored file that changed leaves no copy behind.
    const source = await open(this.path(entry), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => {
      throw new AppError(409, 'attachment-changed', '附件内容已变化，请重新添加。')
    })
    const temporary = join(folder, `.write-${randomUUID()}`)
    try {
      const fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try {
        await this.check(source, ref, chunk => writeAll(fd, chunk)).catch(() => {
          throw new AppError(409, 'attachment-changed', '附件内容已变化，请重新添加。')
        })
        await fd.sync()
      } finally {
        await fd.close()
      }
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    } finally {
      await source.close()
    }
    try {
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
    return target
  }
  /** The file's whole text, or undefined when it does not decode as text. */
  private textOf(data: Uint8Array): string | undefined {
    try {
      return this.decodeText(data)
    } catch {
      return undefined
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
      if (entry.claim?.steer || (claim && busy(claim.requestId)))
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
        // A steer can reach the agent without a recorded acknowledgment. Only the person's explicit release gives it up.
        if (entry.taskId || entry.claim?.steer || !named || named.has(id) || entry.createdAt + ATTACHMENT_CLAIM_TTL > this.now()) continue
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
      // Files saved for a run whose session never took its attachments (its start failed after the save).
      const bound = new Set(Object.values(this.state.entries).flatMap(entry => (entry.taskId ? [entry.taskId] : [])))
      for (const name of await readdir(this.directory)) {
        if (name.startsWith('_') || name === 'index.json' || bound.has(name) || !taskId.safeParse(name).success) continue
        const path = join(this.directory, name),
          info = await lstat(path).catch(() => undefined)
        if (!info?.isDirectory() || info.mtimeMs + ATTACHMENT_TTL > this.now()) continue
        if ((await readdir(path)).every(entry => entry === 'files')) await rm(path, { recursive: true, force: true })
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
