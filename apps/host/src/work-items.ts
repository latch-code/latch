import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import {
  BOARD_TAG_CHARS,
  BOARD_TAG_LIMIT,
  containsSecret,
  DATA_SCOPES,
  MODEL_EFFORT,
  WORK_ITEM_LIMITS,
  type DataScope,
  type GitPrStatus,
  type TaskSummary,
  type WorkItem,
  type WorkItemSummary,
} from '@latch/protocol'
import { writeFileAtomic } from '@latch/core/node-kit'
import { workItemPlace, type WorkItemMember } from './board.ts'

export const WORK_ITEMS_FILE = join('work', 'items.json')
/** A receipt answers retries for this long. */
export const WORK_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const WORK_RECEIPTS_PER_DEVICE = 10_000
const MAX_WORK_RECEIPTS = 20_000
/**
 * What the file holds at most. A device may make 2,000 of the 待办 it can read; this coarser bound covers private ones
 * too and is refused with its own error, so a device that cannot read them never counts them.
 */
export const WORK_ITEMS_STORED = 2 * WORK_ITEM_LIMITS.items

const ITEM_ID = /^itm_[A-Za-z0-9_-]{22}$/u
const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
const sessionIdText = z.string().min(1).max(256)
const requestIdText = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const hex64 = z.string().regex(/^[a-f0-9]{64}$/u)
/** A saved project's ID, or `default`; as `sessions-meta.json` stores a session's. */
export const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u
export const HARNESS_ID = /^[a-zA-Z0-9_-]{1,64}$/u
// Controls and line breaks; a title is one line.
const TITLE_REFUSED = /[\p{Cc}\p{Zl}\p{Zp}]/u
// Controls other than tab, line feed and carriage return.
const PROMPT_REFUSED = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u

const titleText = z.string().refine(value => {
  const length = [...value].length
  return length >= 1 && length <= WORK_ITEM_LIMITS.titleChars && value === value.trim() && !TITLE_REFUSED.test(value)
})
const promptText = z
  .string()
  .max(WORK_ITEM_LIMITS.promptChars)
  .refine(value => value === value.trim() && !PROMPT_REFUSED.test(value))
const tagText = z.string().refine(value => {
  const length = [...value].length
  return length >= 1 && length <= BOARD_TAG_CHARS && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
})
export const modelRefSchema = z.strictObject({
  providerId: z.string().regex(PROJECT_ID),
  model: z.string().trim().min(1).max(200),
  effort: z.string().regex(MODEL_EFFORT).optional(),
})

// Every persisted field is listed and the objects are strict: a file this build cannot read whole is refused, not trimmed.
const itemSchema = z.strictObject({
  id: z.string().regex(ITEM_ID),
  title: titleText,
  prompt: promptText,
  projectId: z.string().regex(PROJECT_ID).optional(),
  harnessId: z.string().regex(HARNESS_ID).optional(),
  model: modelRefSchema.optional(),
  worktree: z.enum(['new', 'project']).optional(),
  tags: z.array(tagText).min(1).max(BOARD_TAG_LIMIT).optional(),
  priority: z.enum(['high', 'low']).optional(),
  sessionIds: z.array(sessionIdText).max(WORK_ITEM_LIMITS.sessions),
  /**
   * The narrowest data scope of the devices that wrote what a start takes from the 待办 (prompt, project, Harness, model,
   * worktree). Below `all`, a start from it carries no private context, as a start by such a device itself would not.
   */
  startScope: z.enum(['work', 'files', 'all']),
  private: z.literal(true).optional(),
  closedAt: isoTime.optional(),
  createdAt: isoTime,
  updatedAt: isoTime,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
})
/**
 * What a create or a start answered, by device and request: a retry with the same body gets the same 待办 or session.
 * A start is `pending` from before the session is asked for until its membership is written with it.
 */
const receiptSchema = z.strictObject({
  kind: z.enum(['create', 'start']),
  deviceId: z.string().min(1).max(64),
  requestId: requestIdText,
  itemId: z.string().regex(ITEM_ID),
  sessionId: sessionIdText.optional(),
  /** The request as sent; a retry must send the same. */
  requestHash: hex64,
  /** What was acted on: for a start, the final inputs it starts with, the 待办's own values and revision included. */
  payloadHash: hex64,
  state: z.enum(['pending', 'done']),
  /** A start whose session could not join (the 待办 was full or gone): the session stands on its own. */
  outside: z.enum(['item-full', 'item-gone']).optional(),
  at: isoTime,
})
const fileSchema = z
  .strictObject({
    version: z.literal(1),
    items: z.array(itemSchema).max(WORK_ITEMS_STORED),
    receipts: z.array(receiptSchema).max(MAX_WORK_RECEIPTS),
  })
  .superRefine((file, ctx) => {
    if (new Set(file.items.map(item => item.id)).size !== file.items.length) ctx.addIssue({ code: 'custom', message: 'duplicate item' })
    const sessions = file.items.flatMap(item => item.sessionIds)
    // A session belongs to one 待办 at most, once.
    if (new Set(sessions).size !== sessions.length) ctx.addIssue({ code: 'custom', message: 'session in two items' })
  })

export type WorkItemRecord = z.infer<typeof itemSchema>
export type WorkReceipt = z.infer<typeof receiptSchema>
interface State {
  items: Map<string, WorkItemRecord>
  receipts: WorkReceipt[]
}

/** The narrower of two data scopes. */
export const narrowerScope = (a: DataScope, b: DataScope): DataScope => (DATA_SCOPES.indexOf(a) <= DATA_SCOPES.indexOf(b) ? a : b)

export const newWorkItemId = (): string => `itm_${randomBytes(16).toString('base64url')}`

/** A title as the Host keeps it: trimmed, one line of 1–120 code points, nothing shaped like a credential. */
export function checkedTitle(raw: string): string {
  const title = raw.trim()
  if (!titleText.safeParse(title).success) throw new AppError(400, 'item-title-invalid', '标题要 1–120 个字，只占一行，不能有控制字符。')
  if (containsSecret(title)) throw new AppError(400, 'item-secret', '标题看起来含有密钥，没有保存。')
  return title
}

/** A prompt as the Host keeps it: trimmed as a session's first message is, at most 16,000 characters, no credential. */
export function checkedPrompt(raw: string): string {
  const prompt = raw.trim()
  if (!promptText.safeParse(prompt).success)
    throw new AppError(400, 'item-prompt-invalid', `要求最多 ${WORK_ITEM_LIMITS.promptChars} 个字符，不能有控制字符。`)
  if (containsSecret(prompt)) throw new AppError(400, 'item-secret', '要求看起来含有密钥，没有保存。')
  return prompt
}

/** Private for good once marked, and while any of its sessions is private now (a later turn can make one so). */
export function itemIsPrivate(item: Pick<WorkItemRecord, 'private' | 'sessionIds'>, sessionPrivate: (id: string) => boolean): boolean {
  return item.private === true || item.sessionIds.some(sessionPrivate)
}

/** What the Host reads of a session to place a 待办: its summary as listed now, and its pull request's last read state. */
export interface MemberFacts {
  summary: (sessionId: string) => TaskSummary | undefined
  prState: (sessionId: string) => GitPrStatus | undefined
}

export function itemSummary(record: WorkItemRecord, facts: MemberFacts, isPrivate: boolean): WorkItemSummary {
  const { prompt, private: _private, startScope: _scope, ...rest } = record
  const members: WorkItemMember[] = record.sessionIds.flatMap(id => {
    const place = facts.summary(id)?.board
    return place ? [{ place, prMerged: facts.prState(id) === 'merged' }] : []
  })
  return {
    ...structuredClone(rest),
    sessionIds: [...record.sessionIds],
    ...(prompt ? { hasPrompt: true as const } : {}),
    ...(isPrivate ? { private: true as const } : {}),
    board: workItemPlace(record, record.sessionIds.length, members),
  }
}

export function fullItem(record: WorkItemRecord, facts: MemberFacts, isPrivate: boolean): WorkItem {
  return { ...itemSummary(record, facts, isPrivate), prompt: record.prompt }
}

function codeOf(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

const writeUnknown = () => new AppError(503, 'item-write-unknown', '待办没有确认保存，请重试同一次操作。')

/**
 * `work/items.json`: the 待办 and the receipts of their creates and starts, written atomically (0600) one change at a
 * time. A change is published in memory only once the file holds it; a failed write leaves the previous state, so a retry
 * of the same request applies it again and nothing is half done.
 */
export class WorkItemStore {
  private queue: Promise<void> = Promise.resolve()
  private bySession = new Map<string, string>()
  private readonly marking = new Set<string>()

  private constructor(
    private readonly path: string,
    private readonly dir: string,
    private state: State,
    private readonly now: () => number,
  ) {
    this.index()
  }

  static async open(dataDir: string, options: { now?: () => number } = {}): Promise<WorkItemStore> {
    const path = join(dataDir, WORK_ITEMS_FILE)
    let text: string | undefined
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error
    }
    const state: State = { items: new Map(), receipts: [] }
    if (text !== undefined) {
      let parsed: z.infer<typeof fileSchema>
      try {
        parsed = fileSchema.parse(JSON.parse(text))
      } catch {
        throw new AppError(500, 'config-corrupt', `待办文件 ${path} 无法读取，原文件已保留；请修复或移走后重启`)
      }
      for (const item of parsed.items) state.items.set(item.id, item)
      state.receipts = parsed.receipts.toSorted((a, b) => a.at.localeCompare(b.at))
    }
    return new WorkItemStore(path, join(dataDir, 'work'), state, options.now ?? Date.now)
  }

  list(): WorkItemRecord[] {
    return [...this.state.items.values()]
  }

  get(id: string): WorkItemRecord | undefined {
    return this.state.items.get(id)
  }

  /** The 待办 a session belongs to. */
  itemOf(sessionId: string): WorkItemRecord | undefined {
    const id = this.bySession.get(sessionId)
    return id === undefined ? undefined : this.state.items.get(id)
  }

  receipt(kind: WorkReceipt['kind'], deviceId: string, requestId: string): WorkReceipt | undefined {
    const oldest = new Date(this.now() - WORK_RECEIPT_TTL_MS).toISOString()
    return this.state.receipts.find(
      receipt => receipt.kind === kind && receipt.deviceId === deviceId && receipt.requestId === requestId && receipt.at >= oldest,
    )
  }

  /**
   * One change, against the state as it stands when its turn comes: `change` edits a copy and says whether anything
   * changed. Throwing refuses it with nothing written.
   */
  transact<T>(change: (draft: State, at: string) => { result: T; changed: boolean }): Promise<T> {
    const run = this.queue.then(async () => {
      const draft: State = {
        items: new Map([...this.state.items].map(([id, item]) => [id, structuredClone(item)])),
        receipts: [...this.state.receipts],
      }
      const at = new Date(this.now()).toISOString()
      const { result, changed } = change(draft, at)
      if (!changed) return result
      this.prune(draft)
      const file = { version: 1 as const, items: [...draft.items.values()], receipts: draft.receipts }
      if (!fileSchema.safeParse(file).success) throw new AppError(500, 'item-invalid', '待办无法保存：内容不符合格式，没有写入。')
      try {
        await mkdir(this.dir, { recursive: true, mode: 0o700 })
        await writeFileAtomic(this.path, JSON.stringify(file) + '\n', { prefix: '.items.json.' })
      } catch {
        throw writeUnknown()
      }
      this.state = draft
      this.index()
      return result
    })
    this.queue = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /**
   * A start's session joins its 待办, in the same write that settles the start's receipt with the session. When it
   * cannot (the 待办 is full or gone), the receipt still settles, with why, and the session stands on its own: a retry
   * answers the same, and nothing waits seven days as pending. Answers why it stands outside, if it does.
   */
  settleStart(start: {
    itemId: string
    deviceId: string
    requestId: string
    sessionId: string
    isPrivate: () => boolean
  }): Promise<'item-full' | 'item-gone' | undefined> {
    return this.transact((draft, at) => {
      const record = draft.items.get(start.itemId)
      let outside: 'item-full' | 'item-gone' | undefined
      if (!record) outside = 'item-gone'
      else if (!record.sessionIds.includes(start.sessionId)) {
        if (record.sessionIds.length >= WORK_ITEM_LIMITS.sessions) outside = 'item-full'
        else {
          record.sessionIds.push(start.sessionId)
          record.updatedAt = at
          record.revision++
        }
      }
      if (record && !outside && start.isPrivate()) record.private = true
      const receipt = draft.receipts.find(
        entry => entry.kind === 'start' && entry.deviceId === start.deviceId && entry.requestId === start.requestId,
      )
      if (receipt) {
        receipt.state = 'done'
        receipt.sessionId = start.sessionId
        if (outside) receipt.outside = outside
      }
      return { result: outside, changed: true }
    })
  }

  /** A session was deleted: it leaves its 待办. Answers the 待办 it left. */
  dropSessions(sessionIds: ReadonlySet<string>): Promise<WorkItemRecord[]> {
    return this.transact((draft, at) => {
      const left: WorkItemRecord[] = []
      for (const item of draft.items.values()) {
        const kept = item.sessionIds.filter(id => !sessionIds.has(id))
        if (kept.length === item.sessionIds.length) continue
        item.sessionIds = kept
        item.updatedAt = at
        item.revision++
        left.push(item)
      }
      return { result: left, changed: left.length > 0 }
    })
  }

  /**
   * Seen private on a read (a member turned private after it joined): written once in the background, so a member that
   * leaves or is deleted later never makes it readable again. A failed write is tried on the next read.
   */
  notePrivate(itemId: string, log: (text: string) => void): void {
    if (this.state.items.get(itemId)?.private || this.marking.has(itemId)) return
    this.marking.add(itemId)
    void this.markPrivate(itemId)
      .catch(error => log(`待办的私有标记没有写入：${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.marking.delete(itemId))
  }

  /** Once private, always: a member turned private after it joined. */
  markPrivate(itemId: string): Promise<void> {
    return this.transact(draft => {
      const item = draft.items.get(itemId)
      if (!item || item.private) return { result: undefined, changed: false }
      item.private = true
      return { result: undefined, changed: true }
    })
  }

  flush(): Promise<void> {
    return this.queue
  }

  private index(): void {
    this.bySession = new Map()
    for (const item of this.state.items.values()) for (const id of item.sessionIds) this.bySession.set(id, item.id)
  }

  private prune(draft: State): void {
    const oldest = new Date(this.now() - WORK_RECEIPT_TTL_MS).toISOString()
    let receipts = draft.receipts.filter(receipt => receipt.at >= oldest)
    const perDevice = new Map<string, number>()
    for (const receipt of receipts) perDevice.set(receipt.deviceId, (perDevice.get(receipt.deviceId) ?? 0) + 1)
    // Oldest first, per device and then overall.
    receipts = receipts.filter(receipt => {
      const count = perDevice.get(receipt.deviceId)!
      if (count <= WORK_RECEIPTS_PER_DEVICE) return true
      perDevice.set(receipt.deviceId, count - 1)
      return false
    })
    draft.receipts = receipts.slice(Math.max(0, receipts.length - MAX_WORK_RECEIPTS))
  }
}
