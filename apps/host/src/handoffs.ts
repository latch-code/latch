import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import type { ServerResponse } from 'node:http'
import { z } from 'zod'
import {
  HANDOFF_LIMITS,
  isFileMention,
  MODEL_EFFORT,
  type FileMention,
  type Handoff,
  type HandoffEvidence,
  type HandoffLocale,
  type HandoffMaterial,
  type HandoffSummary,
  type HandoffTarget,
  type TaskDetail,
  type TaskSummary,
  type DataScope,
  readsProjectFiles,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, type AtomicWriteFs } from '@latch/core/node-kit'
import { AgentJournal } from './agent-journal.ts'
import { projectIdOf } from './session-lifecycle.ts'
import type { AuditActor, AuditLog } from './audit.ts'
import { checkedFileMentions } from './file-mentions.ts'
import { ProtectedPaths, realRoots, resolveRecorded, type FileRoot } from './files/resolve.ts'
import { isInsidePath } from './paths.ts'
import type { DeviceCaller } from './routes/registry.ts'

const MAX_HANDOFFS = 256
/** A new target's title, cut from the requirements or the first material: at most this many code points. */
export const HANDOFF_TITLE_CHARS = 60
/** Settled handoffs are pruned, oldest first, once the file passes this; the journal itself stops at 32 MB. */
const PRUNE_BYTES = 8 * 1024 * 1024
const MAX_VOID_STARTS = 4096
const DELETION_RETRY_MS = 1000
const MAX_RECEIPTS = 4096
/** A file named as material or evidence is hashed whole; larger ones are refused rather than read. */
export const HANDOFF_FILE_BYTES = 4 * 1024 * 1024
/** Sessions read when asking whether a start whose answer was lost made one. */
const LOOKUP_CANDIDATES = 32
/** Clock skew between the record's stamp and the driver's. */
const LOOKUP_SLACK_MS = 60_000

const rid = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const sessionId = z.string().min(1).max(256)
const handoffId = z.string().regex(/^hof_[a-f0-9-]{36}$/u)
const at = z.string().datetime()
const mention = z.custom<FileMention>(isFileMention, '文件引用无效')
/** Line breaks and tabs stay; other control characters are refused. */
const plain = (value: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
const bytes = (value: string) => Buffer.byteLength(value, 'utf8')
const material = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string().min(1).max(HANDOFF_LIMITS.materialBytes).refine(plain, '文字含有控制字符') }),
  z.strictObject({ kind: z.literal('message'), messageId: z.string().min(1).max(256), hash }),
  z.strictObject({ kind: z.literal('file'), file: mention, hash }),
])
const target = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('new-session'),
    projectId: z.string().min(1).max(64).optional(),
    harnessId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/u)
      .optional(),
    mode: z.enum(['chat', 'agent']).optional(),
    model: z
      .strictObject({
        providerId: z.string().min(1).max(64),
        model: z.string().min(1).max(200),
        effort: z.string().regex(MODEL_EFFORT).optional(),
      })
      .optional(),
    worktree: z.literal(true).optional(),
  }),
  z.strictObject({ kind: z.literal('session'), sessionId }),
])
const decision = z.string().min(1).max(HANDOFF_LIMITS.decisionChars).refine(plain, '决定含有控制字符')
const requirements = z
  .string()
  .refine(value => bytes(value) <= HANDOFF_LIMITS.requirementsBytes, `要求最多 ${HANDOFF_LIMITS.requirementsBytes / 1024} KB`)
  .refine(plain, '要求含有控制字符')
const returnScope = z.enum(['none', 'summary', 'summary-and-evidence'])
const locale = z.enum(['zh-CN', 'en'])
const evidenceItem = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), file: mention, hash }),
  z.strictObject({ kind: z.literal('message'), messageId: z.string().min(1).max(256), hash }),
])
const summary = z.string().min(1).max(HANDOFF_LIMITS.summaryChars).refine(plain, '摘要含有控制字符')
const status = z.enum(['starting', 'started', 'start-unknown', 'start-failed', 'returned', 'withdrawn', 'closed'])

const createSchema = z.strictObject({
  requestId: rid,
  sourceSessionId: sessionId,
  target,
  materials: z.array(material).max(HANDOFF_LIMITS.materials),
  requirements,
  decisions: z.array(decision).max(HANDOFF_LIMITS.decisions),
  returnScope,
  locale: locale.optional(),
})
const returnSchema = z.strictObject({
  requestId: rid,
  summary,
  evidence: z.array(evidenceItem).max(HANDOFF_LIMITS.evidence),
})
const withdrawSchema = z.strictObject({ requestId: rid })

const record = z.strictObject({
  id: handoffId,
  requestId: rid,
  /** The device that made it: its request IDs are its own. */
  deviceId: z.string().min(1).max(256),
  sourceSessionId: sessionId,
  target,
  targetSessionId: sessionId.optional(),
  /**
   * What the target's start or first input is sent with, so the driver's receipt answers every retry. Random and never
   * returned: nobody else can make a session that carries it.
   */
  startRequestId: z.string().uuid(),
  /** SHA-256 of the first message: a session found by the request ID must also carry exactly this text. */
  promptHash: hash,
  /** Its length: an input may arrive with the Host's undo note ahead of it, and the text after the note is what counts. */
  promptLength: z.number().int().min(1).max(1_000_000),
  /** `new-session`: the Harness and project the target must have, for the same check. */
  harnessId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/u)
    .optional(),
  projectId: z.string().min(1).max(64).optional(),
  /** Once private, always: a deleted session or a restart without its driver must not make its content readable. */
  sourcePrivate: z.boolean(),
  targetPrivate: z.boolean(),
  /** One of the two sessions was deleted, and the materials, requirements, decisions and result went with it. */
  contentRemoved: z.literal(true).optional(),
  materials: z.array(material).max(HANDOFF_LIMITS.materials),
  requirements,
  decisions: z.array(decision).max(HANDOFF_LIMITS.decisions),
  returnScope,
  locale,
  status,
  failure: z.strictObject({ code: z.string().min(1).max(128), message: z.string().max(500) }).optional(),
  result: z
    .strictObject({
      summary,
      evidence: z.array(evidenceItem).max(HANDOFF_LIMITS.evidence),
      at,
      requestId: rid,
      deviceId: z.string().min(1).max(256),
    })
    .optional(),
  /** The first message exactly as sent, kept until the start has an answer, so a retry sends the same. */
  pending: z
    .strictObject({
      prompt: z.string().min(1).max(1_000_000),
      fileRefs: z.array(mention).max(HANDOFF_LIMITS.materials),
      privateFrom: sessionId.optional(),
      /** A new target's title: a short line, not the template's opening. */
      title: z
        .string()
        .min(1)
        .refine(value => [...value].length <= HANDOFF_TITLE_CHARS)
        .optional(),
    })
    .optional(),
  createdAt: at,
  updatedAt: at,
})
const stateSchema = z
  .strictObject({
    version: z.literal(1),
    handoffs: z.array(record).max(MAX_HANDOFFS),
    /** By the hash of device and request ID: the hash of what was asked, and the handoff it made or changed. */
    receipts: z.record(hash, z.strictObject({ hash, id: handoffId })),
    /** Hashes of start request IDs given up on: a session carrying one is never bound to anything. */
    voidStarts: z.array(hash).max(MAX_VOID_STARTS),
  })
  .superRefine((state, ctx) => {
    if (new Set(state.handoffs.map(item => item.id)).size !== state.handoffs.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate handoff' })
  })
type State = z.infer<typeof stateSchema>
export type HandoffRecord = z.infer<typeof record>
type Material = z.infer<typeof material>
type Target = z.infer<typeof target>

const digest = (value: unknown) => sha256Hex(canonicalJson(value))
/**
 * Whether a stored message is this handoff's first message: exactly it, or it after the note the Host puts ahead of an
 * input to a session with an undo pending (`${note}\n\n${prompt}`, hub.ts `withNote`).
 */
function carriesPrompt(text: string, item: Pick<HandoffRecord, 'promptHash' | 'promptLength'>): boolean {
  if (text.length < item.promptLength) return false
  if (text.length > item.promptLength && text.slice(-item.promptLength - 2, -item.promptLength) !== '\n\n') return false
  return sha256Hex(text.slice(text.length - item.promptLength)) === item.promptHash
}

/** Nothing more can happen to it, so it may be pruned. */
function finished(item: HandoffRecord): boolean {
  return (
    item.contentRemoved === true
    || item.status === 'returned'
    || item.status === 'withdrawn'
    || item.status === 'closed'
    || item.status === 'start-failed'
    || (item.status === 'started' && item.returnScope === 'none')
  )
}

/** One material as the first message carries it. */
export type ComposedMaterial =
  | { kind: 'text'; text: string }
  | { kind: 'message'; role: 'user' | 'assistant'; text: string }
  | { kind: 'file'; file: FileMention }

const TEMPLATE: Record<
  HandoffLocale,
  {
    intro: string
    requirements: string
    none: string
    decisions: string
    materials: string
    text: (n: number) => string
    message: (n: number, role: 'user' | 'assistant') => string
    file: (n: number) => string
    fileNote: string
  }
> = {
  'zh-CN': {
    intro: '这是从另一个会话交接过来的任务。请按「要求」完成；「已定的决定」不要再改；「材料」原样附上，供参考。',
    requirements: '## 要求',
    none: '（没有写）',
    decisions: '## 已定的决定',
    materials: '## 材料',
    text: n => `### 材料 ${n}：选出的文字`,
    message: (n, role) => `### 材料 ${n}：来源会话中${role === 'user' ? '用户' : 'Agent'}的一条消息`,
    file: n => `### 材料 ${n}：文件`,
    fileNote: '已作为文件引用附上。',
  },
  en: {
    intro:
      'This task was handed over from another session. Do what the Requirements ask; treat the Decisions as settled; the Materials are attached verbatim for reference.',
    requirements: '## Requirements',
    none: '(none given)',
    decisions: '## Decisions',
    materials: '## Materials',
    text: n => `### Material ${n}: selected text`,
    message: (n, role) => `### Material ${n}: a message from the ${role === 'user' ? 'user' : 'agent'} in the source session`,
    file: n => `### Material ${n}: file`,
    fileNote: 'Attached as a file reference.',
  },
}

/** A fence longer than any run of backticks in the text, so material can never close it. */
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/gu)].map(match => match[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text}\n${fence}`
}

/** The target's first message, written by the Host from a fixed template; nothing in it comes from the client but the fields. */
export function handoffPrompt(
  language: HandoffLocale,
  input: { requirements: string; decisions: readonly string[]; materials: readonly ComposedMaterial[] },
): string {
  const words = TEMPLATE[language]
  const parts = [words.intro, '', words.requirements, input.requirements.trim() || words.none]
  if (input.decisions.length) parts.push('', words.decisions, ...input.decisions.map((item, index) => `${index + 1}. ${item.trim()}`))
  if (input.materials.length) {
    parts.push('', words.materials)
    input.materials.forEach((item, index) => {
      const n = index + 1
      parts.push('')
      if (item.kind === 'text') parts.push(words.text(n), fenced(item.text))
      else if (item.kind === 'message') parts.push(words.message(n, item.role), fenced(item.text))
      else parts.push(words.file(n), `\`${item.file.root}:${item.file.path}\` — ${words.fileNote}`)
    })
  }
  return parts.join('\n')
}

/** A new target's title: the first line of the requirements, else of the first material, else the file's name. */
export function handoffTitle(requirements: string, materials: readonly ComposedMaterial[]): string | undefined {
  const firstLine = (text: string) =>
    text
      .split('\n')
      .map(line => line.replace(/^[#>*\-\s]+/u, '').trim())
      .find(Boolean)
  const first = materials[0]
  const line =
    firstLine(requirements)
    ?? (first === undefined ? undefined : first.kind === 'file' ? first.file.path.split('/').at(-1) : firstLine(first.text))
  if (!line) return undefined
  if ([...line].length <= HANDOFF_TITLE_CHARS) return line
  // Cut between whole characters as seen (an emoji sequence stays whole), with room for the ellipsis, counting code points.
  let cut = '',
    points = 0
  for (const { segment } of TITLE_GRAPHEMES.segment(line)) {
    const size = [...segment].length
    if (points + size > HANDOFF_TITLE_CHARS - 1) break
    cut += segment
    points += size
  }
  return `${cut}…`
}
const TITLE_GRAPHEMES = new Intl.Segmenter('und', { granularity: 'grapheme' })

/** SHA-256 of a file's bytes, opened without following a link; undefined when it is not a readable regular file. */
export async function hashFile(path: string): Promise<string | undefined> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return undefined
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return undefined
    if (stat.size > HANDOFF_FILE_BYTES)
      throw new AppError(413, 'handoff-file-too-large', `作为材料或证据的文件最多 ${HANDOFF_FILE_BYTES / 1024 / 1024} MB。`)
    const sum = createHash('sha256'),
      buffer = Buffer.alloc(64 * 1024)
    let total = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      total += bytesRead
      if (total > HANDOFF_FILE_BYTES)
        throw new AppError(413, 'handoff-file-too-large', `作为材料或证据的文件最多 ${HANDOFF_FILE_BYTES / 1024 / 1024} MB。`)
      sum.update(buffer.subarray(0, bytesRead))
    }
    return sum.digest('hex')
  } finally {
    await handle.close()
  }
}

export interface HandoffOptions {
  dataDir: string
  audit: Pick<AuditLog, 'append'>
  now?: () => number
  atomicFs?: AtomicWriteFs
  guardedPaths: readonly string[]
  home: string
  log(text: string): void
  actor(caller: DeviceCaller): AuditActor
  /** Re-checks the caller's credential and, given one, its scope. */
  recheck(caller: DeviceCaller, scope?: 'view' | 'run'): void
  /** The caller's data scope as the Host records it now. */
  dataScope(caller: DeviceCaller): DataScope | undefined
  /** Whether a session holds private context: reading it takes data scope `all`. */
  isPrivate(sessionId: string): boolean
  /** The detail of a session the caller may read; throws as `GET /tasks/:id` does. */
  readSession(caller: DeviceCaller, sessionId: string): Promise<TaskDetail>
  /** What a device must pass to send new input to a session. */
  assertSessionInput(caller: DeviceCaller, sessionId: string): Promise<void>
  sessionRoots(sessionId: string): Promise<FileRoot[] | 'removed' | undefined>
  /** The Harness a new session without one gets. */
  defaultHarnessId(): string
  /** Before anything is on record: the Harness is ready and the project exists. The start checks them again. */
  checkNewTarget(target: Extract<Target, { kind: 'new-session' }>): Promise<void>
  /** The folders a new session's file references resolve in. */
  newTargetRoots(target: Extract<Target, { kind: 'new-session' }>): FileRoot[]
  /** The session start path of `POST /tasks`. */
  start(
    caller: DeviceCaller,
    input: {
      requestId: string
      prompt: string
      fileRefs: FileMention[]
      target: Extract<Target, { kind: 'new-session' }>
      privateFrom?: string
      title?: string
    },
    res: ServerResponse,
  ): Promise<{ sessionId: string }>
  /** The input path of `POST /tasks/:id/prompt`. */
  send(caller: DeviceCaller, sessionId: string, input: { requestId: string; prompt: string; fileRefs: FileMention[] }): Promise<void>
  /** Every session the Host can reach now; one missing from it is treated as unreadable. */
  listTasks(): Promise<TaskSummary[]>
  /** The detail as the Host keeps it, without a caller: only to find a start's own message by its request ID. */
  detail(sessionId: string): Promise<TaskDetail>
  changed(sessionIds: readonly string[]): void
}

type Outcome = Pick<HandoffRecord, 'status' | 'targetSessionId' | 'failure'>

/**
 * Handoffs between two sessions on this Host, in `handoffs/handoffs.json`. The source is never written; the target is
 * an ordinary session started (or sent to) through the same path as any other, with a random request ID only this
 * handoff knows, so the driver's own receipt answers a retry and a start whose answer was lost can be found again.
 */
export class Handoffs {
  private readonly starting = new Map<string, Promise<void>>()
  /** Deleted sessions whose handoffs are not stripped yet. */
  private readonly deletions = new Set<string>()
  private deletionRetry?: ReturnType<typeof setTimeout>
  private closed = false
  private constructor(
    private readonly options: HandoffOptions,
    private readonly journal: AgentJournal<State>,
  ) {}

  static async open(options: HandoffOptions): Promise<Handoffs> {
    const journal = await AgentJournal.open(
      options.dataDir,
      'handoffs.json',
      stateSchema,
      { version: 1, handoffs: [], receipts: {}, voidStarts: [] },
      { directory: 'handoffs', maximumBytes: 32 * 1024 * 1024, ...(options.atomicFs ? { atomicFs: options.atomicFs } : {}) },
    )
    const service = new Handoffs(options, journal)
    // A start that was on its way when the Host stopped has no answer: it may or may not have made a session.
    await journal.change('startup', 'startup', draft => {
      let changed = false
      for (const item of draft.handoffs)
        if (item.status === 'starting') {
          item.status = 'start-unknown'
          changed = true
        }
      return { value: true, changed }
    })
    return service
  }

  hasPending(): boolean {
    return this.journal.hasPending()
  }

  /** Summaries for the snapshot: handoffs whose source or target the reader can see. Only IDs and states. */
  summaries(visible: ReadonlySet<string>): HandoffSummary[] | undefined {
    if (this.journal.hasPending()) return undefined
    return this.journal
      .read()
      .handoffs.filter(
        item => visible.has(item.sourceSessionId) || (item.targetSessionId !== undefined && visible.has(item.targetSessionId)),
      )
      .map(item => ({
        id: item.id,
        sourceSessionId: item.sourceSessionId,
        ...(item.targetSessionId ? { targetSessionId: item.targetSessionId } : {}),
        status: item.status,
        returnScope: item.returnScope,
        updatedAt: item.updatedAt,
      }))
  }

  /** Handoffs with this session as source or target, as this caller may read them. */
  async list(caller: DeviceCaller, session: string): Promise<Handoff[]> {
    sessionId.parse(session)
    await this.options.readSession(caller, session)
    await this.journal.recover()
    await this.sweepDeletions()
    const matching = () => this.journal.read().handoffs.filter(item => item.sourceSessionId === session || item.targetSessionId === session)
    for (const item of matching()) if (this.unresolved(item)) await this.lookup(item.id)
    const live = await this.live()
    this.options.recheck(caller, 'view')
    return matching().flatMap(item => this.view(caller, item, live) ?? [])
  }

  async get(caller: DeviceCaller, id: string): Promise<Handoff> {
    handoffId.parse(id)
    await this.journal.recover()
    await this.sweepDeletions()
    let live = await this.live()
    const found = this.find(this.journal.read(), id)
    if (!this.view(caller, found, live)) throw notFound()
    if (this.unresolved(found)) {
      await this.lookup(id)
      live = await this.live()
    }
    this.options.recheck(caller, 'view')
    return this.visibleView(caller, this.find(this.journal.read(), id), live)
  }

  /**
   * `POST /handoffs`. Checks, then the audit, then the record, then the start. A retry of the same request answers with the
   * same handoff; for one whose start has no answer it first looks for the session, and only then starts again with the
   * same request ID, which the driver's receipt turns into the session it already made, if it made one.
   */
  async create(caller: DeviceCaller, body: unknown, res: ServerResponse): Promise<{ value: Handoff; created: boolean }> {
    const input = createSchema.parse(body)
    const authorize = () => this.options.recheck(caller, 'run')
    const deviceId = caller.device.id,
      receiptKey = digest(['handoff', deviceId, input.requestId]),
      payload = digest(['create', input])
    await this.journal.recover()
    await this.sweepDeletions()
    const prior = this.journal.read().receipts[receiptKey]
    if (prior) {
      if (prior.hash !== payload) throw conflict()
      if (this.unresolved(this.find(this.journal.read(), prior.id))) {
        await this.lookup(prior.id)
        if (this.unresolved(this.find(this.journal.read(), prior.id))) await this.runStart(caller, prior.id, res, false)
      }
      return { value: this.visibleView(caller, this.find(this.journal.read(), prior.id), await this.live()), created: false }
    }
    if (!input.materials.length && !input.requirements.trim()) throw new AppError(400, 'handoff-empty', '请至少选一项材料或写下要求。')
    if (input.target.kind === 'session' && input.target.sessionId === input.sourceSessionId)
      throw new AppError(400, 'handoff-same-session', '不能交接给来源会话自己。')
    const source = await this.options.readSession(caller, input.sourceSessionId)
    const privateSource = this.options.isPrivate(input.sourceSessionId)
    const files = input.materials.filter(item => item.kind === 'file')
    if (files.length && !readsProjectFiles(this.options.dataScope(caller)))
      throw new AppError(403, 'file-scope', '此设备不能浏览项目文件。')
    if (input.target.kind === 'new-session') {
      await this.options.checkNewTarget(input.target)
      if (files.length && input.target.worktree)
        throw new AppError(
          400,
          'handoff-worktree-files',
          '新工作树里只有已提交的文件，与选定的文件版本可能不同。请交给项目文件夹里的会话，或把内容作为文字附上。',
        )
    } else {
      await this.options.assertSessionInput(caller, input.target.sessionId)
      if (privateSource && !this.options.isPrivate(input.target.sessionId))
        throw new AppError(403, 'handoff-private-target', '来源会话含私有内容，只能交给新会话，或同样私有的会话。')
    }
    const composed = await this.materials(input.materials, source, input.sourceSessionId, input.target)
    const language = input.locale ?? 'zh-CN'
    const prompt = handoffPrompt(language, { requirements: input.requirements, decisions: input.decisions, materials: composed })
    // Under the names the target's Harness uses for its folders.
    const fileRefs = composed.flatMap(item => (item.kind === 'file' ? [item.file] : []))
    const title = input.target.kind === 'new-session' ? handoffTitle(input.requirements, composed) : undefined
    const targetPrivate = input.target.kind === 'session' ? this.options.isPrivate(input.target.sessionId) : privateSource
    this.options.recheck(caller, 'run')
    const id = `hof_${randomUUID()}`,
      stamp = this.stamp()
    const written = await this.journal.change(
      receiptKey,
      payload,
      async draft => {
        const again = draft.receipts[receiptKey]
        if (again) {
          if (again.hash !== payload) throw conflict()
          return { value: again.id, changed: false }
        }
        this.prune(draft, true)
        if (draft.handoffs.length >= MAX_HANDOFFS)
          throw new AppError(409, 'handoff-limit', `最多保留 ${MAX_HANDOFFS} 条交接，请先关闭进行中的交接。`)
        await this.options.audit.append({
          action: 'handoff.created',
          actor: this.options.actor(caller),
          target: id,
          detail: {
            handoffId: id,
            sourceSessionId: input.sourceSessionId,
            target: input.target.kind,
            ...(input.target.kind === 'session' ? { targetSessionId: input.target.sessionId } : {}),
            materials: input.materials.length,
            files: files.length,
            decisions: input.decisions.length,
            returnScope: input.returnScope,
            promptHash: sha256Hex(prompt),
          },
        })
        draft.handoffs.push({
          id,
          requestId: input.requestId,
          deviceId,
          sourceSessionId: input.sourceSessionId,
          target: input.target,
          startRequestId: randomUUID(),
          promptHash: sha256Hex(prompt),
          promptLength: prompt.length,
          ...(input.target.kind === 'new-session'
            ? {
                harnessId: input.target.harnessId ?? this.options.defaultHarnessId(),
                projectId: input.target.projectId ?? 'default',
              }
            : {}),
          sourcePrivate: privateSource,
          targetPrivate,
          materials: input.materials,
          requirements: input.requirements,
          decisions: input.decisions,
          returnScope: input.returnScope,
          locale: language,
          status: 'starting',
          pending: {
            prompt,
            fileRefs,
            ...(privateSource ? { privateFrom: input.sourceSessionId } : {}),
            ...(title ? { title } : {}),
          },
          createdAt: stamp,
          updatedAt: stamp,
        })
        draft.receipts[receiptKey] = { hash: payload, id }
        this.trimReceipts(draft)
        return { value: id }
      },
      authorize,
    )
    this.options.changed([input.sourceSessionId])
    await this.runStart(caller, written, res, written === id)
    return { value: this.visibleView(caller, this.find(this.journal.read(), written), await this.live()), created: written === id }
  }

  /** `POST /handoffs/:id/return`: the target's result, cut to the agreed scope, onto the handoff record. */
  async returnResult(caller: DeviceCaller, id: string, body: unknown): Promise<Handoff> {
    handoffId.parse(id)
    const input = returnSchema.parse(body)
    const authorize = () => this.options.recheck(caller, 'run')
    await this.journal.recover()
    await this.sweepDeletions()
    const current = this.find(this.journal.read(), id)
    if (!current.targetSessionId) throw stateError(current)
    const detail = await this.options.readSession(caller, current.targetSessionId)
    const receiptKey = digest(['handoff-return', caller.device.id, input.requestId]),
      payload = digest(['return', id, input])
    const prior = this.journal.read().receipts[receiptKey]
    if (prior) {
      if (prior.hash !== payload || prior.id !== id) throw conflict()
      return this.visibleView(caller, this.find(this.journal.read(), id), await this.live())
    }
    if (current.status !== 'started' || current.contentRemoved) throw stateError(current)
    if (current.returnScope === 'none') throw new AppError(409, 'handoff-no-return', '这次交接约定不交回结果。')
    const evidence = current.returnScope === 'summary' ? [] : input.evidence
    if (evidence.some(item => item.kind === 'file') && !readsProjectFiles(this.options.dataScope(caller)))
      throw new AppError(403, 'file-scope', '此设备不能浏览项目文件。')
    const changed: number[] = []
    let roots: FileRoot[] | undefined
    for (const [index, item] of evidence.entries()) {
      if (item.kind === 'message') {
        const message = detail.messages.find(entry => entry.id === item.messageId)
        if (!message) throw new AppError(404, 'handoff-evidence-missing', '证据中的消息不在目标会话里。', { evidence: [index] })
        if (sha256Hex(message.text) !== item.hash) changed.push(index)
      } else {
        roots ??= await this.roots(current.targetSessionId)
        if ((await this.fileHash(roots, item.file)) !== item.hash) changed.push(index)
      }
    }
    if (changed.length) throw new AppError(409, 'handoff-evidence-changed', '证据中的内容已经变化，请重新选择。', { evidence: changed })
    const targetPrivate = this.options.isPrivate(current.targetSessionId),
      sourcePrivate = this.options.isPrivate(current.sourceSessionId)
    this.options.recheck(caller, 'run')
    await this.journal.change(
      receiptKey,
      payload,
      async draft => {
        const again = draft.receipts[receiptKey]
        if (again) {
          if (again.hash !== payload || again.id !== id) throw conflict()
          return { value: true, changed: false }
        }
        const item = this.find(draft, id)
        if (item.status !== 'started' || item.contentRemoved) throw stateError(item)
        this.prune(draft, false, id)
        await this.options.audit.append({
          action: 'handoff.returned',
          actor: this.options.actor(caller),
          target: id,
          detail: {
            handoffId: id,
            sourceSessionId: item.sourceSessionId,
            targetSessionId: item.targetSessionId!,
            evidence: evidence.length,
            summaryHash: sha256Hex(input.summary),
          },
        })
        const stamp = this.stamp()
        item.result = { summary: input.summary, evidence, at: stamp, requestId: input.requestId, deviceId: caller.device.id }
        item.status = 'returned'
        item.targetPrivate ||= targetPrivate
        item.sourcePrivate ||= sourcePrivate
        item.updatedAt = stamp
        draft.receipts[receiptKey] = { hash: payload, id }
        this.trimReceipts(draft)
        return { value: true }
      },
      authorize,
    )
    this.options.changed([current.sourceSessionId, current.targetSessionId])
    return this.visibleView(caller, this.find(this.journal.read(), id), await this.live())
  }

  /**
   * `POST /handoffs/:id/withdraw`. A handoff whose start failed is withdrawn; a started one is closed, its target left as
   * it is; one whose start has no answer is looked for first: found, it is bound and the answer says so; not found, it is
   * withdrawn and its start request ID void for good. An audit failure does not hold any of it back.
   */
  async withdraw(caller: DeviceCaller, id: string, body: unknown): Promise<{ value: Handoff; audited: boolean }> {
    handoffId.parse(id)
    const input = withdrawSchema.parse(body)
    const authorize = () => this.options.recheck(caller, 'run')
    await this.journal.recover()
    await this.sweepDeletions()
    const current = this.find(this.journal.read(), id)
    await this.options.readSession(caller, current.sourceSessionId)
    const receiptKey = digest(['handoff-withdraw', caller.device.id, input.requestId]),
      payload = digest(['withdraw', id])
    if (!this.journal.read().receipts[receiptKey] && this.unresolved(current)) {
      await this.lookup(id)
      const found = this.find(this.journal.read(), id)
      if (found.status === 'started')
        throw new AppError(409, 'handoff-start-found', '目标会话其实已经开始，交接已与它关联。要结束交接，请再关闭一次。', {
          targetSessionId: found.targetSessionId,
        })
    }
    let audited = true
    await this.journal.change(
      receiptKey,
      payload,
      async draft => {
        const again = draft.receipts[receiptKey]
        if (again) {
          if (again.hash !== payload || again.id !== id) throw conflict()
          return { value: true, changed: false }
        }
        const item = this.find(draft, id)
        if (item.status === 'withdrawn' || item.status === 'closed') return { value: true, changed: false }
        // Inside the write, so a retry whose start began after any earlier look cannot slip past it.
        if (this.starting.has(id)) throw stateError({ status: 'starting' })
        this.prune(draft, false, id)
        const from = item.status
        if (from !== 'start-failed' && from !== 'start-unknown' && from !== 'starting' && from !== 'started') throw stateError(item)
        try {
          await this.options.audit.append({
            action: 'handoff.withdrawn',
            actor: this.options.actor(caller),
            target: id,
            detail: { handoffId: id, from: from === 'starting' ? 'start-unknown' : from },
          })
        } catch {
          audited = false
        }
        if (from === 'started') item.status = 'closed'
        else {
          item.status = 'withdrawn'
          if (from !== 'start-failed') {
            draft.voidStarts = [...draft.voidStarts, sha256Hex(item.startRequestId)].slice(-MAX_VOID_STARTS)
            delete item.pending
          }
        }
        item.updatedAt = this.stamp()
        draft.receipts[receiptKey] = { hash: payload, id }
        this.trimReceipts(draft)
        return { value: true }
      },
      authorize,
    )
    this.options.changed([current.sourceSessionId, ...(current.targetSessionId ? [current.targetSessionId] : [])])
    return { value: this.visibleView(caller, this.find(this.journal.read(), id), await this.live()), audited }
  }

  /**
   * A session was deleted: the handoffs naming it keep their IDs and states and lose everything else, so nothing of a
   * private session outlives it here. They count as settled and may be pruned.
   */
  async sessionDeleted(session: string): Promise<void> {
    this.deletions.add(session)
    await this.sweepDeletions()
  }

  /**
   * Strips the handoffs of every deleted session not yet done. A deletion whose write could not be made (another write's
   * result still unknown, a full disk) stays queued: every later operation sweeps again, and so does a timer, until it lands.
   */
  private async sweepDeletions(): Promise<void> {
    for (const session of [...this.deletions]) {
      const done = await this.strip(session)
      if (done) this.deletions.delete(session)
    }
    clearTimeout(this.deletionRetry)
    this.deletionRetry = undefined
    if (this.deletions.size && !this.closed) {
      this.deletionRetry = setTimeout(() => void this.sweepDeletions(), DELETION_RETRY_MS)
      this.deletionRetry.unref()
    }
  }

  private async strip(session: string): Promise<boolean> {
    return this.journal
      .change(`deleted:${session}`, digest(['deleted', session]), draft => {
        let changed = false
        for (const item of draft.handoffs) {
          if (item.contentRemoved || (item.sourceSessionId !== session && item.targetSessionId !== session)) continue
          item.materials = []
          item.requirements = ''
          item.decisions = []
          delete item.result
          delete item.pending
          delete item.failure
          item.contentRemoved = true
          item.updatedAt = this.stamp()
          changed = true
        }
        if (changed) this.prune(draft, false)
        return { value: changed, changed }
      })
      .then(changed => {
        if (changed) this.options.changed([session])
        return true
      })
      .catch(error => {
        this.options.log(`会话 ${session} 删除后交接内容未能清除，稍后重试：${error instanceof Error ? error.message : String(error)}`)
        return false
      })
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.deletionRetry)
    await Promise.allSettled([...this.starting.values()])
    await this.journal.close()
  }

  /** Each material checked against the version the request names, as the target will receive it. */
  private async materials(
    materials: readonly Material[],
    source: TaskDetail,
    sourceId: string,
    targetChoice: Target,
  ): Promise<ComposedMaterial[]> {
    const changed: number[] = [],
      composed: ComposedMaterial[] = []
    let sourceRoots: FileRoot[] | undefined, targetRoots: FileRoot[] | undefined
    let total = 0
    for (const [index, item] of materials.entries()) {
      if (item.kind === 'text') {
        total += bytes(item.text)
        composed.push(item)
      } else if (item.kind === 'message') {
        const message = source.messages.find(entry => entry.id === item.messageId)
        if (!message || (message.role !== 'user' && message.role !== 'assistant'))
          throw new AppError(404, 'handoff-material-missing', '材料中的消息不在来源会话里。', { materials: [index] })
        if (sha256Hex(message.text) !== item.hash) changed.push(index)
        total += bytes(message.text)
        composed.push({ kind: 'message', role: message.role, text: message.text })
      } else {
        sourceRoots ??= await this.roots(sourceId)
        targetRoots ??=
          targetChoice.kind === 'session' ? await this.roots(targetChoice.sessionId) : this.options.newTargetRoots(targetChoice)
        const chosen = await this.fileVersion(sourceRoots, item.file)
        if (chosen?.hash !== item.hash) {
          changed.push(index)
          composed.push({ kind: 'file', file: item.file })
          continue
        }
        // Harnesses name the same folder differently: the file is found in the target's folders by its real path, then
        // read there again under the target's own name through every check, and must be this very file and version.
        const named = await this.inFolders(targetRoots, chosen.realPath)
        const there = named && (await this.fileVersion(targetRoots, named, true))
        if (!named || there?.realPath !== chosen.realPath || there.hash !== item.hash)
          throw new AppError(409, 'handoff-file-elsewhere', '这个文件不在目标会话的文件夹里，请改交给来源会话所在的项目。', {
            materials: [index],
          })
        composed.push({ kind: 'file', file: named })
      }
    }
    if (changed.length) throw new AppError(409, 'handoff-material-changed', '有材料在选定之后变化了，请重新选择。', { materials: changed })
    if (total > HANDOFF_LIMITS.materialBytes)
      throw new AppError(413, 'handoff-too-large', `材料的文字合计最多 ${HANDOFF_LIMITS.materialBytes / 1024} KB。`)
    return composed
  }

  private async roots(session: string): Promise<FileRoot[]> {
    const roots = await this.options.sessionRoots(session)
    if (roots === undefined) throw new AppError(404, 'task-not-found', '找不到该任务')
    if (roots === 'removed') throw new AppError(409, 'workspace-changed', '会话的文件夹已不在项目中。')
    return roots
  }

  private async fileHash(roots: readonly FileRoot[], ref: FileMention, quiet = false): Promise<string | undefined> {
    return (await this.fileVersion(roots, ref, quiet))?.hash
  }

  /** Through the `@` reference checks first: a file they refuse is never read. Its real path and the hash of its bytes. */
  private async fileVersion(
    roots: readonly FileRoot[],
    ref: FileMention,
    quiet = false,
  ): Promise<{ realPath: string; hash: string | undefined } | undefined> {
    let checked: FileMention
    try {
      ;[checked] = (await checkedFileMentions([ref], roots, this.options.guardedPaths, this.options.home)) as [FileMention]
    } catch (error) {
      if (quiet) return undefined
      throw error
    }
    const resolved = await resolveRecorded(checked.root, checked.path, {
      roots,
      protectedPaths: new ProtectedPaths(this.options.guardedPaths),
      home: this.options.home,
    })
    if (resolved.status !== 'ok' || resolved.file.secret) return undefined
    return { realPath: resolved.file.realPath, hash: await hashFile(resolved.file.realPath) }
  }

  /** The reference that names a real path inside one of these folders, under the folder's own name; nothing outside them. */
  private async inFolders(roots: readonly FileRoot[], realPath: string): Promise<FileMention | undefined> {
    for (const root of await realRoots(roots)) {
      if (realPath === root.path || !isInsidePath(realPath, root.path)) continue
      const named = { root: root.id, path: relative(root.path, realPath).split(sep).join('/') }
      if (isFileMention(named)) return named
    }
    return undefined
  }

  /**
   * Sends the start once at a time per handoff and records its answer. `first`: this handoff's first attempt, the only one
   * a refusal settles as `start-failed`; after an attempt without an answer, a refusal says nothing about that attempt.
   */
  private runStart(caller: DeviceCaller, id: string, res: ServerResponse, first: boolean): Promise<void> {
    const running = this.starting.get(id)
    if (running) return running
    const task = this.startOnce(caller, id, res, first).finally(() => this.starting.delete(id))
    this.starting.set(id, task)
    return task
  }

  private async startOnce(caller: DeviceCaller, id: string, res: ServerResponse, first: boolean): Promise<void> {
    const item = this.find(this.journal.read(), id)
    if ((item.status !== 'starting' && item.status !== 'start-unknown') || !item.pending) return
    const { prompt, fileRefs, privateFrom, title } = item.pending
    let outcome: Outcome
    try {
      if (item.target.kind === 'new-session') {
        const created = await this.options.start(
          caller,
          {
            requestId: item.startRequestId,
            prompt,
            fileRefs,
            target: item.target,
            ...(privateFrom ? { privateFrom } : {}),
            ...(title ? { title } : {}),
          },
          res,
        )
        outcome = { status: 'started', targetSessionId: created.sessionId }
      } else {
        await this.options.send(caller, item.target.sessionId, { requestId: item.startRequestId, prompt, fileRefs })
        outcome = { status: 'started', targetSessionId: item.target.sessionId }
      }
    } catch (error) {
      // A definite refusal of the first attempt: nothing started. Anything else may have started a session that only the
      // receipt or a lookup can name.
      const refused = error instanceof AppError && error.status >= 400 && error.status < 500 && error.status !== 408
      const failure = refused ? { code: error.code.slice(0, 128), message: error.message.slice(0, 500) } : undefined
      outcome =
        refused && first ? { status: 'start-failed', failure: failure! } : { status: 'start-unknown', ...(failure ? { failure } : {}) }
    }
    await this.settle(id, outcome)
  }

  /**
   * Asks the driver's records, without sending anything, whether a start whose answer was lost made a session. A session
   * counts only if its first user message carries this handoff's secret request ID and exactly its first message, and (for
   * a new session) it runs on the chosen Harness in the chosen project.
   */
  private async lookup(id: string): Promise<void> {
    const item = this.find(this.journal.read(), id)
    if (!this.unresolved(item)) return
    if (this.journal.read().voidStarts.includes(sha256Hex(item.startRequestId))) return
    const since = Date.parse(item.createdAt) - LOOKUP_SLACK_MS
    const tasks = await this.options.listTasks().catch(() => [] as TaskSummary[])
    const candidates =
      item.target.kind === 'session'
        ? tasks.filter(task => task.id === (item.target as { sessionId: string }).sessionId)
        : tasks
            .filter(
              task =>
                task.harnessId === item.harnessId
                && projectIdOf(task) === item.projectId
                && (task.createdAt === undefined || Date.parse(task.createdAt) >= since),
            )
            .toSorted((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
            .slice(0, LOOKUP_CANDIDATES)
    for (const candidate of candidates) {
      const detail = await this.options.detail(candidate.id).catch(() => undefined)
      if (!detail) continue
      const users = detail.messages.filter(message => message.role === 'user')
      const carrying = item.target.kind === 'session' ? users.find(message => message.requestId === item.startRequestId) : users[0]
      if (carrying?.requestId === item.startRequestId && carriesPrompt(carrying.text, item)) {
        await this.settle(id, { status: 'started', targetSessionId: candidate.id })
        return
      }
    }
  }

  /**
   * Records a start's answer. A failed write is logged and leaves the handoff `starting` or `start-unknown` with no start
   * on its way, which the next read or retry resolves by lookup.
   */
  private async settle(id: string, outcome: Outcome): Promise<void> {
    const targetPrivate = outcome.targetSessionId ? this.options.isPrivate(outcome.targetSessionId) : false
    try {
      const changed = await this.journal.change(`settle:${id}`, digest(outcome), draft => {
        const item = this.find(draft, id)
        if (item.status !== 'starting' && item.status !== 'start-unknown') return { value: undefined, changed: false }
        if (outcome.targetSessionId && draft.voidStarts.includes(sha256Hex(item.startRequestId)))
          return { value: undefined, changed: false }
        this.prune(draft, false, id)
        item.status = outcome.status
        if (outcome.targetSessionId) item.targetSessionId = outcome.targetSessionId
        item.targetPrivate ||= targetPrivate
        if (outcome.failure) item.failure = outcome.failure
        else delete item.failure
        if (outcome.status !== 'start-unknown') delete item.pending
        item.updatedAt = this.stamp()
        return { value: [item.sourceSessionId, ...(item.targetSessionId ? [item.targetSessionId] : [])] }
      })
      if (changed) this.options.changed(changed)
    } catch (error) {
      this.options.log(`交接 ${id} 的开始结果未能写入，读取时会重新查找：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** A start with no answer and none on its way: one whose record or answer was not written, or from before a restart. */
  private unresolved(item: HandoffRecord): boolean {
    return (item.status === 'start-unknown' || item.status === 'starting') && !this.starting.has(item.id)
  }

  /** The sessions that exist now. A session gone, or whose driver is not mounted, reads as unreadable. */
  private async live(): Promise<ReadonlySet<string>> {
    return new Set((await this.options.listTasks().catch(() => [] as TaskSummary[])).map(task => task.id))
  }

  /** The record's mark or the live one: privacy never lapses, and a session that is not there is not readable. */
  private canRead(caller: DeviceCaller, session: string, recorded: boolean, live: ReadonlySet<string>): boolean {
    if (!live.has(session)) return false
    return !(recorded || this.options.isPrivate(session)) || this.options.dataScope(caller) === 'all'
  }

  private visibleView(caller: DeviceCaller, item: HandoffRecord, live: ReadonlySet<string>): Handoff {
    const value = this.view(caller, item, live)
    if (!value) throw notFound()
    return value
  }

  /** The handoff as this caller may read it: each side's fields only to a reader of that side. */
  private view(caller: DeviceCaller, item: HandoffRecord, live: ReadonlySet<string>): Handoff | undefined {
    const source = this.canRead(caller, item.sourceSessionId, item.sourcePrivate, live),
      targetReadable =
        item.targetSessionId !== undefined && this.canRead(caller, item.targetSessionId, item.targetPrivate || item.sourcePrivate, live),
      files = readsProjectFiles(this.options.dataScope(caller))
    // A handoff whose sessions are gone is still the caller's own record: IDs and state, nothing else.
    const own = item.deviceId === caller.device.id
    if (!source && !targetReadable && !own) return undefined
    const evidence = (list: NonNullable<HandoffRecord['result']>['evidence']): HandoffEvidence[] =>
      list.map(entry => (targetReadable && (entry.kind !== 'file' || files) ? entry : { kind: 'withheld' as const }))
    return {
      id: item.id,
      requestId: item.requestId,
      sourceSessionId: item.sourceSessionId,
      target: item.target as HandoffTarget,
      ...(item.targetSessionId ? { targetSessionId: item.targetSessionId } : {}),
      ...(source && !item.contentRemoved
        ? { materials: item.materials as HandoffMaterial[], requirements: item.requirements, decisions: item.decisions }
        : {}),
      returnScope: item.returnScope,
      locale: item.locale,
      status: item.status,
      ...(item.contentRemoved ? { contentRemoved: true as const } : {}),
      ...(item.failure ? { failure: item.failure } : {}),
      ...(item.result
        ? {
            result: {
              ...(targetReadable ? { summary: item.result.summary } : { summaryWithheld: true as const }),
              evidence: evidence(item.result.evidence),
              at: item.result.at,
              requestId: item.result.requestId,
            },
          }
        : {}),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }
  }

  /**
   * Room by count and by size, at every write that settles a handoff as well as at a new one: the oldest settled
   * handoffs go first, with their receipts. `keep`: the handoff this write is about, which stays whatever it becomes.
   */
  private prune(draft: State, room: boolean, keep?: string): void {
    // A new handoff needs room for itself; a settling write only keeps the size budget and the count within the limit.
    const limit = room ? MAX_HANDOFFS : MAX_HANDOFFS + 1
    // Measured once; each record removed takes about its own size with it.
    let size = Buffer.byteLength(JSON.stringify(draft))
    while (draft.handoffs.length >= limit || size > PRUNE_BYTES) {
      const oldest = draft.handoffs.findIndex(item => item.id !== keep && finished(item))
      if (oldest < 0) return
      const [gone] = draft.handoffs.splice(oldest, 1)
      size -= Buffer.byteLength(JSON.stringify(gone))
      for (const [key, receipt] of Object.entries(draft.receipts)) if (receipt.id === gone!.id) delete draft.receipts[key]
    }
  }

  private trimReceipts(draft: State): void {
    const keys = Object.keys(draft.receipts)
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_RECEIPTS))) delete draft.receipts[old]
  }

  private find(state: State, id: string): HandoffRecord {
    const found = state.handoffs.find(item => item.id === id)
    if (!found) throw notFound()
    return found
  }

  private stamp(): string {
    return new Date((this.options.now ?? Date.now)()).toISOString()
  }
}

function notFound(): AppError {
  return new AppError(404, 'handoff-not-found', '找不到这次交接。')
}
function conflict(): AppError {
  return new AppError(409, 'request-conflict', '同一个请求标识不能用于不同的交接。')
}
function stateError(item: Pick<HandoffRecord, 'status'> & { contentRemoved?: true }): AppError {
  if (item.contentRemoved) return new AppError(409, 'handoff-session-deleted', '交接的一个会话已删除。')
  switch (item.status) {
    case 'starting':
      return new AppError(409, 'handoff-starting', '目标会话正在开始，请稍后再试。')
    case 'start-unknown':
      return new AppError(409, 'handoff-start-unknown', '目标会话是否已开始还不确定，请先查询。')
    case 'start-failed':
      return new AppError(409, 'handoff-start-failed', '目标会话没有开始。')
    case 'returned':
      return new AppError(409, 'handoff-returned', '结果已经交回。')
    case 'withdrawn':
      return new AppError(409, 'handoff-withdrawn', '这次交接已撤回。')
    case 'closed':
      return new AppError(409, 'handoff-closed', '这次交接已关闭。')
    default:
      return new AppError(409, 'handoff-started', '目标会话已经开始。')
  }
}
