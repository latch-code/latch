import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  CHANGE_SCOPES,
  REVIEW_NOTE_LIMITS,
  REVIEW_NOTE_STATUSES,
  type ReviewNote,
  type ReviewNoteCounts,
  type ReviewNoteList,
  type ReviewNoteSendResult,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, writeFileAtomic } from '@latch/core/node-kit'

const MAX_RECEIPTS = 512
const MAX_SENDS = 32
// Devices that may edit one note; past that a new note says the same.
const MAX_EDITORS = 16
/**
 * Stands for a writer the store cannot name: a note edited before editors were kept. No device has this ID (they are
 * `dev_…`), so a grant that needs it is never given.
 */
const UNKNOWN_WRITER = 'unknown-writer'

/** The client's request ID: only the receipt key of a write here, never sent on to a session. */
const rid = z.string().uuid()
const sendId = z.string().regex(/^snd_[a-f0-9-]{36}$/u)
/** The longest message a send makes, the same as the prompt route and the queue take. */
export const REVIEW_MESSAGE_CHARS = 16_000
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const noteId = z.string().regex(/^rn_[a-f0-9-]{36}$/u)
const at = z.string().datetime()
/** Line breaks and tabs stay; other control characters are refused. */
const plain = (value: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
const noteText = z.string().trim().min(1).max(REVIEW_NOTE_LIMITS.textChars).refine(plain, '反馈含有控制字符')
const line = z.string().max(REVIEW_NOTE_LIMITS.lineChars)
const range = z
  .strictObject({ start: z.number().int().min(1).max(10_000_000), end: z.number().int().min(1).max(10_000_000) })
  .refine(value => value.end >= value.start && value.end - value.start < REVIEW_NOTE_LIMITS.lines, '行范围无效')
const status = z.enum(['pending', 'sent', 'agent-claimed', 'reviewed']) satisfies z.ZodType<(typeof REVIEW_NOTE_STATUSES)[number]>
const scope = z.enum(['turn', 'session', 'uncommitted', 'base']) satisfies z.ZodType<(typeof CHANGE_SCOPES)[number]>

const noteSchema = z
  .strictObject({
    id: noteId,
    root: z.string().min(1).max(64),
    path: z.string().min(1).max(4096),
    range,
    side: z.enum(['old', 'new']),
    anchor: z.strictObject({
      scope,
      turnId: z.string().min(1).max(256).optional(),
      linesHash: hash,
      lines: z.array(line).min(1).max(REVIEW_NOTE_LIMITS.lines),
    }),
    text: noteText,
    status,
    messageId: z.string().min(1).max(256).optional(),
    /** The send the note is in while its result is open (`sends`); the note stays pending and locked meanwhile. */
    sendId: sendId.optional(),
    createdBy: z.strictObject({ deviceId: z.string().min(1).max(256), name: z.string().max(256) }),
    /** Every device that edited the text, its writer too: what it says may be theirs (`writersOf`). Never sent to a device. */
    editors: z.array(z.string().min(1).max(256)).min(1).max(MAX_EDITORS).optional(),
    createdAt: at,
    updatedAt: at,
  })
  .refine(note => note.anchor.lines.length === note.range.end - note.range.start + 1, '片段与行范围不一致')
type StoredNote = z.infer<typeof noteSchema>

const receiptSchema = z.strictObject({
  hash,
  action: z.enum(['create', 'edit', 'delete', 'status', 'send']),
  noteId: noteId.optional(),
  noteIds: z.array(noteId).max(REVIEW_NOTE_LIMITS.perSend).optional(),
  messageId: z.string().min(1).max(256).optional(),
  sendId: sendId.optional(),
})
const sendSchema = z.strictObject({
  id: sendId,
  /** The device's own request: its receipt is keyed by this, and nothing else uses it. */
  requestId: rid,
  deviceId: z.string().min(1).max(256),
  /** The Host's own request ID for the message: the prompt goes with it, and only a message carrying it settles the send. */
  promptRequestId: z.string().uuid(),
  /** The queued item while the message waits for the next turn. */
  queueId: z.string().min(1).max(256).optional(),
  noteIds: z.array(noteId).min(1).max(REVIEW_NOTE_LIMITS.perSend),
  /** The message exactly as first sent: a retry with the same request ID must send the same text. */
  prompt: z.string().min(1).max(1_000_000),
  /** Into the queue for the next turn; a retry goes the same way, or the queue's receipt would not answer it. */
  queue: z.literal(true).optional(),
  at,
})
const fileSchema = z.strictObject({
  version: z.literal(1),
  sessionId: z.string().min(1).max(256),
  revision: z.number().int().min(0),
  notes: z.array(noteSchema).max(REVIEW_NOTE_LIMITS.perSession),
  /** Sends whose result is still open. */
  sends: z.array(sendSchema).max(MAX_SENDS),
  /** By the hash of device and request ID. Insertion order is age: the oldest go first. */
  receipts: z.record(hash, receiptSchema),
})
type SessionFile = z.infer<typeof fileSchema>
type Receipt = z.infer<typeof receiptSchema>
type Send = z.infer<typeof sendSchema>

export const createNoteSchema = z.strictObject({
  requestId: rid,
  root: z.string().min(1).max(64),
  path: z.string().min(1).max(4096),
  range,
  side: z.enum(['old', 'new']),
  scope,
  turnId: z.string().min(1).max(256).optional(),
  lines: z.array(line).min(1).max(REVIEW_NOTE_LIMITS.lines),
  text: noteText,
})
export const editNoteSchema = z.strictObject({ requestId: rid, text: noteText })
export const statusNoteSchema = z.strictObject({ requestId: rid, status: z.enum(['sent', 'agent-claimed', 'reviewed']) })
export const deleteNoteSchema = z.strictObject({ requestId: rid })
export const sendNotesSchema = z.strictObject({
  requestId: rid,
  noteIds: z
    .array(noteId)
    .min(1)
    .max(REVIEW_NOTE_LIMITS.perSend)
    .refine(ids => new Set(ids).size === ids.length, '反馈重复'),
  /** The session is running: the message waits in its queue for the next turn. */
  queue: z.literal(true).optional(),
})

export interface Writer {
  deviceId: string
  name: string
}

const view = (note: StoredNote, sends: readonly Send[] = []): ReviewNote => {
  const { sendId, editors: _editors, ...rest } = note
  const queueId = sendId ? sends.find(send => send.id === sendId)?.queueId : undefined
  return { ...rest, ...(sendId ? { sending: true as const } : {}), ...(queueId ? { queueId } : {}) }
}
const resultOf = (receipt: Pick<Receipt, 'noteIds' | 'messageId'>): ReviewNoteSendResult => ({
  noteIds: receipt.noteIds ?? [],
  ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
})
export type OpenSend = Send
const receiptKey = (deviceId: string, requestId: string) => sha256Hex(`${deviceId}\0${requestId}`)

/**
 * Line feedback per session, one 0600 file each under `review-notes/`, written whole and atomically. Writes of a session
 * run one at a time; each carries a request ID whose receipt answers a retry with the same request.
 */
export class ReviewNotes {
  private readonly cache = new Map<string, SessionFile>()
  private readonly queues = new Map<string, Promise<unknown>>()
  /** Sends a request is pushing now: nothing drops one of these until its claim is released. */
  private readonly claims = new Set<string>()

  private constructor(
    private readonly directory: string,
    private readonly now: () => number,
  ) {}

  static async open(options: { dataDir: string; now?: () => number; log?: (text: string) => void }): Promise<ReviewNotes> {
    const directory = join(options.dataDir, 'review-notes')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const store = new ReviewNotes(directory, options.now ?? Date.now)
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue
      try {
        const file = fileSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')))
        if (sha256Hex(file.sessionId) === name.slice(0, 64)) store.cache.set(file.sessionId, file)
      } catch (error) {
        options.log?.(`行级反馈记录 ${name} 无法读取，已跳过：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return store
  }

  private pathOf(sessionId: string) {
    return join(this.directory, `${sha256Hex(sessionId)}.json`)
  }

  private stamp() {
    return new Date(this.now()).toISOString()
  }

  /** One write of a session after another; reads use the cache as it stands. */
  private serial<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    this.queues.set(sessionId, next)
    void next
      .catch(() => {})
      .finally(() => {
        if (this.queues.get(sessionId) === next) this.queues.delete(sessionId)
      })
    return next
  }

  private fileOf(sessionId: string): SessionFile {
    return structuredClone(this.cache.get(sessionId)) ?? { version: 1, sessionId, revision: 0, notes: [], sends: [], receipts: {} }
  }

  private async save(file: SessionFile): Promise<void> {
    file.revision++
    const keys = Object.keys(file.receipts)
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_RECEIPTS))) delete file.receipts[key]
    const checked = fileSchema.parse(file)
    await writeFileAtomic(this.pathOf(file.sessionId), JSON.stringify(checked))
    this.cache.set(file.sessionId, checked)
  }

  /**
   * Runs one request: a retry of a request this device already made gets that answer, the same request ID with other
   * content is refused, and the receipt is saved with the change itself.
   */
  private request<T>(
    sessionId: string,
    writer: Writer,
    requestId: string,
    asked: unknown,
    answer: (receipt: Receipt, file: SessionFile) => T,
    change: (file: SessionFile) => Omit<Receipt, 'hash'>,
  ): Promise<T> {
    return this.serial(sessionId, async () => {
      const file = this.fileOf(sessionId)
      const key = receiptKey(writer.deviceId, requestId),
        askedHash = sha256Hex(canonicalJson(asked))
      const known = file.receipts[key]
      if (known) {
        if (known.hash !== askedHash) throw new AppError(409, 'request-reused', '这个请求 ID 已用于另一项操作。')
        return answer(known, file)
      }
      const receipt: Receipt = { hash: askedHash, ...change(file) }
      file.receipts[key] = receipt
      await this.save(file)
      return answer(receipt, file)
    })
  }

  private noteIn(file: SessionFile, id: string): StoredNote {
    const note = file.notes.find(item => item.id === id)
    if (!note) throw new AppError(404, 'review-note-not-found', '找不到这条反馈。')
    return note
  }

  private current(file: SessionFile, id: string | undefined): ReviewNote {
    const note = id ? file.notes.find(item => item.id === id) : undefined
    if (!note) throw new AppError(404, 'review-note-not-found', '找不到这条反馈。')
    return view(note, file.sends)
  }

  list(sessionId: string): ReviewNoteList {
    const file = this.cache.get(sessionId)
    return { notes: (file?.notes ?? []).map(note => view(note, file?.sends)), revision: file?.revision ?? 0 }
  }

  /** Counts of the given sessions that have notes. */
  counts(sessionIds: ReadonlySet<string>): ReviewNoteCounts[] {
    const out: ReviewNoteCounts[] = []
    for (const [sessionId, file] of this.cache) {
      if (!sessionIds.has(sessionId) || !file.notes.length) continue
      const count = (wanted: string) => file.notes.filter(note => note.status === wanted).length
      out.push({
        sessionId,
        pending: count('pending'),
        sent: count('sent'),
        claimed: count('agent-claimed'),
        reviewed: count('reviewed'),
        revision: file.revision,
      })
    }
    return out
  }

  create(sessionId: string, writer: Writer, input: z.infer<typeof createNoteSchema>): Promise<ReviewNote> {
    const { requestId, ...asked } = input
    return this.request(
      sessionId,
      writer,
      requestId,
      { action: 'create', ...asked },
      (receipt, file) => this.current(file, receipt.noteId),
      file => {
        if (file.notes.length >= REVIEW_NOTE_LIMITS.perSession)
          throw new AppError(409, 'review-note-limit', `每个会话最多保留 ${REVIEW_NOTE_LIMITS.perSession} 条反馈，请先删除一些。`)
        if (input.lines.length !== input.range.end - input.range.start + 1)
          throw new AppError(400, 'review-note-lines', '选中的行与行范围不一致。')
        const stamp = this.stamp()
        const note: StoredNote = {
          id: `rn_${randomUUID()}`,
          root: input.root,
          path: input.path,
          range: input.range,
          side: input.side,
          anchor: {
            scope: input.scope,
            ...(input.turnId ? { turnId: input.turnId } : {}),
            linesHash: sha256Hex(input.lines.join('\n')),
            lines: input.lines,
          },
          text: input.text,
          status: 'pending',
          createdBy: { deviceId: writer.deviceId, name: writer.name },
          createdAt: stamp,
          updatedAt: stamp,
        }
        file.notes.push(note)
        return { action: 'create', noteId: note.id }
      },
    )
  }

  edit(sessionId: string, writer: Writer, id: string, input: z.infer<typeof editNoteSchema>): Promise<ReviewNote> {
    return this.request(
      sessionId,
      writer,
      input.requestId,
      { action: 'edit', id, text: input.text },
      (receipt, file) => this.current(file, receipt.noteId),
      file => {
        const note = this.noteIn(file, id)
        if (note.status !== 'pending' || note.sendId) throw new AppError(409, 'review-note-sent', '这条反馈已经发出，不能再改。')
        const editors = note.editors ?? []
        if (!editors.includes(writer.deviceId)) {
          if (editors.length >= MAX_EDITORS) throw new AppError(409, 'review-note-editors', '改过这条反馈的设备太多，请新建一条。')
          note.editors = [...editors, writer.deviceId]
        }
        note.text = input.text
        note.updatedAt = this.stamp()
        return { action: 'edit', noteId: id }
      },
    )
  }

  setStatus(sessionId: string, writer: Writer, id: string, input: z.infer<typeof statusNoteSchema>): Promise<ReviewNote> {
    return this.request(
      sessionId,
      writer,
      input.requestId,
      { action: 'status', id, status: input.status },
      (receipt, file) => this.current(file, receipt.noteId),
      file => {
        const note = this.noteIn(file, id)
        // Only a note that went out can be marked: the Agent never saw a pending one.
        if (!note.messageId) throw new AppError(409, 'review-note-not-sent', '这条反馈还没有发给 Agent。')
        note.status = input.status
        note.updatedAt = this.stamp()
        return { action: 'status', noteId: id }
      },
    )
  }

  remove(sessionId: string, writer: Writer, id: string, input: z.infer<typeof deleteNoteSchema>): Promise<{ deleted: string }> {
    return this.request(
      sessionId,
      writer,
      input.requestId,
      { action: 'delete', id },
      receipt => ({ deleted: receipt.noteId! }),
      file => {
        const note = this.noteIn(file, id)
        if (note.sendId) throw new AppError(409, 'review-note-sending', '这条反馈正在发送，结果确定后才能删除。')
        file.notes = file.notes.filter(item => item.id !== id)
        return { action: 'delete', noteId: id }
      },
    )
  }

  /**
   * The send's record before the message goes out: a new send claims its pending notes, keeps the message it composed and
   * the Host's own request ID for it; a retry of an open send gets that record back; a settled one gets its receipt.
   */
  beginSend(
    sessionId: string,
    writer: Writer,
    input: z.infer<typeof sendNotesSchema>,
    compose: (notes: ReviewNote[]) => string,
  ): Promise<{ settled: ReviewNoteSendResult } | { open: Send }> {
    return this.serial(sessionId, async () => {
      const file = this.fileOf(sessionId)
      const key = receiptKey(writer.deviceId, input.requestId),
        askedHash = sha256Hex(canonicalJson({ action: 'send', noteIds: input.noteIds, queue: Boolean(input.queue) }))
      const known = file.receipts[key]
      if (known) {
        if (known.hash !== askedHash) throw new AppError(409, 'request-reused', '这个请求 ID 已用于另一项操作。')
        return { settled: resultOf(known) }
      }
      const open = file.sends.find(send => send.requestId === input.requestId && send.deviceId === writer.deviceId)
      if (open) {
        if (canonicalJson(open.noteIds) !== canonicalJson(input.noteIds) || Boolean(open.queue) !== Boolean(input.queue))
          throw new AppError(409, 'request-reused', '这个请求 ID 已用于另一项操作。')
        return { open }
      }
      const notes = input.noteIds.map(id => this.noteIn(file, id))
      if (notes.some(note => note.status !== 'pending' || note.sendId))
        throw new AppError(409, 'review-note-sent', '有反馈已经发出或正在发送，请刷新后再发。')
      if (file.sends.length >= MAX_SENDS) throw new AppError(409, 'review-note-sends', '还有太多发送没有结果，请稍后再试。')
      const prompt = compose(notes.map(note => view(note)))
      // Nothing is kept for a message the prompt path or the queue would refuse, or could not store.
      if (prompt.length > REVIEW_MESSAGE_CHARS) throw new AppError(413, 'review-note-too-long', '反馈太长，分两次发。')
      const send: Send = {
        id: `snd_${randomUUID()}`,
        requestId: input.requestId,
        deviceId: writer.deviceId,
        promptRequestId: randomUUID(),
        noteIds: input.noteIds,
        prompt,
        ...(input.queue ? { queue: true as const } : {}),
        at: this.stamp(),
      }
      for (const note of notes) note.sendId = send.id
      file.sends.push(send)
      await this.save(file)
      return { open: send }
    })
  }

  /**
   * Every device that wrote these notes' text, creators and editors, as recorded; a note that is gone names none. A
   * pending note changes `updatedAt` only by an edit, so one edited without `editors` (from before they were kept) names
   * `UNKNOWN_WRITER`.
   */
  writersOf(sessionId: string, noteIds: readonly string[]): string[] {
    const notes = this.cache.get(sessionId)?.notes ?? []
    const writers = notes
      .filter(note => noteIds.includes(note.id))
      .flatMap(note => [note.createdBy.deviceId, ...(note.editors ?? (note.updatedAt !== note.createdAt ? [UNKNOWN_WRITER] : []))])
    return [...new Set(writers)]
  }

  /** Sends whose result is still open, for the caller to settle against the session's messages and queue. */
  openSends(sessionId: string): Send[] {
    return structuredClone(this.cache.get(sessionId)?.sends ?? [])
  }

  findSend(sessionId: string, id: string): Send {
    const send = this.cache.get(sessionId)?.sends.find(item => item.id === id)
    if (!send) throw new AppError(404, 'review-send-not-found', '这次发送已经有结果了，请刷新。')
    return structuredClone(send)
  }

  /**
   * Takes a send for pushing, under the session's lock: undefined when it is gone (settled or dropped meanwhile), 409
   * while another request pushes it. The caller releases it when done.
   */
  claim(sessionId: string, id: string): Promise<Send | undefined> {
    return this.serial(sessionId, async () => {
      const send = this.cache.get(sessionId)?.sends.find(item => item.id === id)
      if (!send) return undefined
      if (this.claims.has(id)) throw new AppError(409, 'review-send-busy', '这次发送正在进行，请稍后查询结果。')
      this.claims.add(id)
      return structuredClone(send)
    })
  }

  release(id: string): void {
    this.claims.delete(id)
  }

  /** The message waits in the session's queue as this item; the notes stay pending and locked until it goes out. */
  markQueued(sessionId: string, id: string, queueId: string): Promise<void> {
    return this.serial(sessionId, async () => {
      const file = this.fileOf(sessionId)
      const send = file.sends.find(item => item.id === id)
      if (!send || send.queueId === queueId) return
      send.queueId = queueId
      await this.save(file)
    })
  }

  /** The message is in the session: its notes are sent with its ID, and the sending device's receipt says so. */
  settleSend(sessionId: string, id: string, messageId: string): Promise<ReviewNoteSendResult | undefined> {
    return this.serial(sessionId, async () => {
      const file = this.fileOf(sessionId)
      const send = file.sends.find(item => item.id === id)
      if (!send) return undefined
      const stamp = this.stamp()
      for (const note of file.notes)
        if (note.sendId === id) {
          delete note.sendId
          note.status = 'sent'
          note.messageId = messageId
          note.updatedAt = stamp
        }
      file.sends = file.sends.filter(item => item.id !== id)
      const receipt: Receipt = {
        hash: sha256Hex(canonicalJson({ action: 'send', noteIds: send.noteIds, queue: Boolean(send.queue) })),
        action: 'send',
        noteIds: send.noteIds,
        messageId,
        sendId: id,
      }
      file.receipts[receiptKey(send.deviceId, send.requestId)] = receipt
      await this.save(file)
      return resultOf(receipt)
    })
  }

  /**
   * Nothing of the send reached the session: its notes are pending again. Refused while another request pushes it;
   * `claimed`: the request that holds the claim drops it itself.
   */
  dropSend(sessionId: string, id: string, claimed = false): Promise<void> {
    return this.serial(sessionId, async () => {
      if (!claimed && this.claims.has(id)) throw new AppError(409, 'review-send-busy', '这次发送正在进行，请稍后查询结果。')
      const file = this.fileOf(sessionId)
      if (!file.sends.some(item => item.id === id)) return
      for (const note of file.notes) if (note.sendId === id) delete note.sendId
      file.sends = file.sends.filter(item => item.id !== id)
      await this.save(file)
    })
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.serial(sessionId, async () => {
      this.cache.delete(sessionId)
      await rm(this.pathOf(sessionId), { force: true })
    })
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.queues.values()])
  }
}
