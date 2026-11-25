import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { mentionsConversationReference } from './conversation-references.ts'
import { modelEffort } from './config.ts'
import {
  DATA_SCOPES,
  LISTENER_CLASSES,
  refusedBeforeAccepting,
  type DataScope,
  type ListenerClass,
  type ModelRef,
  type PromptQueueItem,
  type TaskDetail,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, writeFileAtomic } from '@latch/core/node-kit'

const ACTIVE = new Set(['running', 'waiting-approval'])
const VISIBLE = new Set(['waiting', 'parked', 'dropped', 'sending', 'uncertain'])
const MAX_RECEIPTS = 100_000
const RECEIPTS_PER_DEVICE = 10_000
const text = z.string().min(1).max(16_000)
const id = z.string().min(1).max(256)
const MAX_COAUTHORS = 256
/** Refused, never cut: a device left out would no longer count as one that wrote the text. */
function checkedCoauthors(coauthors: readonly string[] | undefined): string[] | undefined {
  if (coauthors && coauthors.length > MAX_COAUTHORS)
    throw new AppError(400, 'queue-item-invalid', `写过这条排队内容的设备超过 ${MAX_COAUTHORS} 台，不能排队或修改。`)
  return coauthors?.length ? [...coauthors] : undefined
}
const actorSchema = z.strictObject({
  deviceId: id,
  listener: z.enum(LISTENER_CLASSES),
  dataScope: z.enum(DATA_SCOPES),
  nativeWindowHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
})
const recordSchema = z.strictObject({
  id,
  sessionId: id,
  deviceId: id,
  listener: z.enum(LISTENER_CLASSES),
  dataScope: z.enum(DATA_SCOPES),
  nativeWindowHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  editor: actorSchema.optional(),
  /** Other devices whose words the text carries (review notes): a device-input grant needs each of them, at sending too. */
  coauthors: z.array(id).min(1).max(MAX_COAUTHORS).optional(),
  binding: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  requestId: z.string().uuid(),
  sendRequestId: z.string().uuid(),
  /** Distinguishes a steer into this turn from a new prompt, including after a crash. */
  steerRunId: z.string().min(1).max(128).optional(),
  hash: z.string().regex(/^[a-f0-9]{64}$/u),
  text: z.string().max(16_000).optional(),
  teamRequest: z.literal(true).optional(),
  attachmentIds: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{22}$/u))
    .min(1)
    .max(8)
    .optional(),
  queuedAt: z.string().datetime(),
  state: z.enum(['waiting', 'parked', 'dropped', 'sending', 'uncertain', 'sent', 'removed']),
  waitRunId: z.string().max(128),
  orderRevision: z.number().int().nonnegative().optional(),
  contentRevision: z.number().int().nonnegative().optional(),
  reason: z.string().max(200).optional(),
  model: z
    .strictObject({ providerId: z.string().min(1).max(64), model: z.string().min(1).max(200), effort: modelEffort.optional() })
    .optional(),
})
const fileSchema = z.strictObject({ version: z.literal(1), items: z.array(recordSchema).max(MAX_RECEIPTS) })
type Record = z.infer<typeof recordSchema>
async function receivedSteer(item: Record, detail: TaskDetail, options: QueueOptions): Promise<boolean> {
  const received = detail.messages.some(
    message =>
      message.role === 'user'
      && message.steered
      && message.requestId === item.sendRequestId
      && (!item.attachmentIds
        || (message.attachments?.length === item.attachmentIds.length
          && item.attachmentIds.every((attachmentId, index) => message.attachments?.[index]?.id === attachmentId))),
  )
  if (!received || !item.attachmentIds) return received
  if (!options.bindAttachments) return false
  try {
    await options.bindAttachments(item, item.sessionId, item.attachmentIds)
    return true
  } catch {
    // Keep the upload claimed and retry publication from the same message.
    return false
  }
}
/**
 * Every new item must read back: the file is checked whole when the Host starts, so one item it would refuse there (too
 * long, a malformed request ID) would keep the Host from starting. Such an item is refused here and never written.
 */
function valid(item: Record): void {
  if (!recordSchema.safeParse(item).success)
    throw new AppError(400, 'queue-item-invalid', `排队内容无效：每条最多 ${text.maxLength ?? 16_000} 个字符。`)
}
export interface QueueActor {
  deviceId: string
  listener: ListenerClass
  dataScope: DataScope
  /** Captured only from a Host-verified native opening; never accepted from the HTTP body. */
  nativeWindowHash?: string
}
export interface QueueOptions {
  dataDir: string
  now?: () => number
  detail(id: string): Promise<TaskDetail>
  /** Only a Host-derived execution hash is persisted; private context is rebuilt immediately before dispatch. */
  prepare?(actor: QueueActor, sessionId: string, model?: ModelRef): Promise<{ binding: string; model: ModelRef } | undefined>
  check(actor: QueueActor, sessionId: string, model?: ModelRef, binding?: string): Promise<void>
  holdAttachments?(actor: QueueActor, sessionId: string, ids: string[], requestId: string, model?: ModelRef): Promise<void>
  releaseAttachments?(actor: QueueActor, sessionId: string, ids: string[], requestId: string): Promise<void>
  bindAttachments?(actor: QueueActor, sessionId: string, ids: string[]): Promise<void>
  beforeEnqueue(actor: QueueActor, sessionId: string, itemId: string): Promise<void>
  /**
   * An item sent at once was refused before the session took it and deleted with its receipt: what was audited for it
   * (queued, sent) is marked as never committed.
   */
  dropped?(actor: QueueActor, sessionId: string, itemId: string): void
  canSteer?(sessionId: string, withAttachments: boolean): boolean
  steer?(
    actor: QueueActor,
    sessionId: string,
    input: {
      sender: QueueActor
      text: string
      itemId: string
      requestId: string
      runId: string
      queuedAt: string
      attachmentIds?: string[]
      attachmentRequestId?: string
      editor?: QueueActor
      coauthors?: readonly string[]
      authorize(): Promise<void>
    },
  ): Promise<'injected' | 'prompt-required'>
  send(
    actor: QueueActor,
    sessionId: string,
    input: {
      text: string
      requestId: string
      model?: ModelRef
      binding?: string
      attachmentIds?: string[]
      attachmentRequestId?: string
      queuedAt?: string
      teamRequest?: true
      itemId?: string
      editor?: QueueActor
      coauthors?: readonly string[]
      authorize?: () => Promise<void>
    },
  ): Promise<void>
  changed(sessionId: string): void
}

/** The Host owns FIFO scheduling and receipts; drivers still own prompt acceptance and request deduplication. */
export class PromptQueues {
  private serial: Promise<void> = Promise.resolve()
  // An upload was reserved, but the atomic queue write had no certain outcome. Keep it parked until a durable write.
  private readonly unconfirmedAdmissions = new Set<string>()
  private closed = false
  private constructor(
    private readonly options: QueueOptions,
    private entries: Map<string, Record>,
  ) {}

  static async open(options: QueueOptions): Promise<PromptQueues> {
    const path = join(options.dataDir, 'queues.json')
    let items: Record[] = []
    try {
      if ((await stat(path)).size > 512 * 1024 * 1024) throw new Error('queue file too large')
      items = fileSchema.parse(JSON.parse(await readFile(path, 'utf8'))).items
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw new AppError(500, 'queue-corrupt', '排队记录无法读取，原文件已保留；修复后再启动 Host')
    }
    const entries = new Map<string, Record>()
    const identities = new Set<string>()
    const unconfirmed = new Map<string, Record[]>()
    for (const item of items) {
      const identity = JSON.stringify([item.sessionId, item.deviceId, item.requestId])
      if (entries.has(item.id) || identities.has(identity)) throw new AppError(500, 'queue-corrupt', '排队记录有重复标识，原文件已保留')
      if (item.steerRunId && (item.state === 'parked' || item.state === 'waiting' || item.state === 'dropped'))
        throw new AppError(500, 'queue-corrupt', '追加记录状态无效，原文件已保留')
      identities.add(identity)
      if (item.state === 'sending') item.state = 'uncertain'
      if (item.state === 'uncertain' && item.steerRunId) {
        const session = unconfirmed.get(item.sessionId) ?? []
        session.push(item)
        unconfirmed.set(item.sessionId, session)
      }
      if (item.state === 'waiting') {
        item.state = 'parked'
        item.reason = 'Host 已重启，请确认后发送'
      }
      if (VISIBLE.has(item.state) && (item.text === undefined || (!item.text && !item.attachmentIds?.length)))
        throw new AppError(500, 'queue-corrupt', '排队内容缺失，原文件已保留')
      entries.set(item.id, item)
    }
    // The driver may already have recorded acceptance when the Host stopped. A quiet session need not emit another event.
    for (const [sessionId, pending] of unconfirmed) {
      const detail = await options.detail(sessionId).catch(() => undefined)
      if (!detail) continue
      for (const item of pending)
        if (await receivedSteer(item, detail, options))
          entries.set(item.id, { ...item, state: 'sent', text: undefined, attachmentIds: undefined, reason: undefined })
    }
    const queue = new PromptQueues(options, entries)
    if (items.length) await queue.commit(new Map(entries))
    return queue
  }

  /** Whether this device's request is already on record for the session (queued, sent or otherwise answered). */
  /** Any queue holds or answered a request of this device with this ID, in whichever session. */
  knowsRequest(deviceId: string, requestId: string): boolean {
    for (const item of this.entries.values()) if (item.deviceId === deviceId && item.requestId === requestId) return true
    return false
  }

  holdsUpload(deviceId: string, requestId: string): boolean {
    for (const item of this.entries.values())
      if (item.deviceId === deviceId && item.requestId === requestId && item.attachmentIds?.length && VISIBLE.has(item.state)) return true
    return false
  }

  heldAttachmentIds(sessionId: string): string[] {
    return this.items(sessionId).flatMap(item => item.attachmentIds ?? [])
  }

  knows(sessionId: string, deviceId: string, requestId: string): boolean {
    for (const item of this.entries.values())
      if (item.sessionId === sessionId && item.deviceId === deviceId && item.requestId === requestId) return true
    return false
  }

  /**
   * One item of a session, by its ID or by the request ID it was first queued with (from any device), with its state and
   * the request ID its message carries now (an edit gives it a new one).
   */
  lookup(
    sessionId: string,
    by: { id: string } | { requestId: string },
  ): { id: string; state: Record['state']; sendRequestId: string } | undefined {
    for (const item of this.entries.values())
      if (item.sessionId === sessionId && ('id' in by ? item.id === by.id : item.requestId === by.requestId))
        return { id: item.id, state: item.state, sendRequestId: item.sendRequestId }
    return undefined
  }

  /** This session has an item that will still be sent by itself or is being sent now: a turn is queued to run. */
  pendingIn(sessionId: string): boolean {
    for (const item of this.entries.values())
      if (item.sessionId === sessionId && (item.state === 'waiting' || item.state === 'sending')) return true
    return false
  }

  /** Items that will still be sent by themselves or are being sent now. */
  pending(): number {
    let count = 0
    for (const item of this.entries.values()) if (item.state === 'waiting' || item.state === 'sending') count++
    return count
  }

  view(sessionId: string, steerAttachments = false): PromptQueueItem[] {
    return this.items(sessionId).map(item => ({
      id: item.id,
      text: item.text!,
      ...(item.attachmentIds?.length ? { attachmentCount: item.attachmentIds.length } : {}),
      queuedAt: item.queuedAt,
      state: item.state === 'sending' ? 'waiting' : item.state === 'uncertain' ? 'parked' : (item.state as PromptQueueItem['state']),
      ...(item.orderRevision !== undefined ? { orderRevision: item.orderRevision } : {}),
      ...(item.contentRevision !== undefined ? { contentRevision: item.contentRevision } : {}),
      ...(this.canSteer(item, steerAttachments) ? { canSteer: true as const } : {}),
      ...(item.state === 'sending'
        ? { reason: '正在发送', delivery: 'sending' as const }
        : item.state === 'uncertain'
          ? item.steerRunId
            ? { reason: '追加结果未确认，请核对会话记录', delivery: 'steer-unknown' as const }
            : { reason: '发送结果未确认，请重试这一项', delivery: 'uncertain' as const }
          : item.reason
            ? { reason: item.reason }
            : {}),
    }))
  }

  submit(
    actor: QueueActor,
    sessionId: string,
    input: {
      prompt: string
      requestId: string
      model?: ModelRef
      coauthors?: readonly string[]
      attachmentIds?: string[]
      teamRequest?: true | undefined
    },
    existingOnly = false,
  ): Promise<{ accepted: true } | { queued: { id: string } }> {
    return this.lock(async () => {
      this.assertOpen()
      const coauthors = checkedCoauthors(input.coauthors)
      const files = input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}
      if (!input.prompt && !files.attachmentIds) throw new AppError(400, 'invalid-prompt', '请输入任务内容或添加附件。')
      const team = input.teamRequest ? { teamRequest: true as const } : {}
      const hash = sha256Hex(canonicalJson({ text: input.prompt, ...(input.model ? { model: input.model } : {}), ...files, ...team }))
      const prior = [...this.entries.values()].find(
        item => item.sessionId === sessionId && item.deviceId === actor.deviceId && item.requestId === input.requestId,
      )
      if (prior) {
        if (prior.hash !== hash) throw new AppError(409, 'request-conflict', '同一次排队请求不能提交不同内容')
        if (this.unconfirmedAdmissions.has(prior.id)) await this.commit(new Map(this.entries))
        return VISIBLE.has(prior.state) ? { queued: { id: prior.id } } : { accepted: true }
      }
      if (existingOnly) throw new AppError(409, 'queue-settled', '没有可重试的排队回执。')
      const prepared = await this.options.prepare?.(actor, sessionId, input.model),
        model = prepared?.model ?? input.model,
        binding = prepared?.binding
      await this.options.check(actor, sessionId, model, binding)
      const detail = await this.options.detail(sessionId)
      const items = this.items(sessionId)
      if (!ACTIVE.has(detail.summary.status) && !items.length) {
        const next = new Map(this.entries)
        if (next.size >= MAX_RECEIPTS || [...next.values()].filter(item => item.deviceId === actor.deviceId).length >= RECEIPTS_PER_DEVICE)
          throw new AppError(409, 'queue-full', '排队回执已满，请删除不需要的旧会话后重试')
        const immediate: Record = {
          ...actor,
          id: `queue-${randomUUID()}`,
          sessionId,
          requestId: input.requestId,
          sendRequestId: input.requestId,
          hash,
          ...files,
          ...team,
          text: input.prompt,
          queuedAt: new Date(this.now()).toISOString(),
          waitRunId: detail.summary.runId ?? '',
          state: 'sending',
          ...(model ? { model } : {}),
          ...(binding ? { binding } : {}),
          ...(coauthors ? { coauthors } : {}),
        }
        valid(immediate)
        next.set(immediate.id, immediate)
        await this.options.beforeEnqueue(actor, sessionId, immediate.id)
        await this.admit(immediate, next)
        try {
          await this.options.send(actor, sessionId, {
            text: input.prompt,
            requestId: input.requestId,
            itemId: immediate.id,
            ...files,
            ...team,
            ...(immediate.coauthors ? { coauthors: immediate.coauthors } : {}),
            ...(model ? { model } : {}),
            ...(binding ? { binding } : {}),
          })
          await this.patch(immediate, { state: 'sent', text: undefined, attachmentIds: undefined })
        } catch (error) {
          // Refused before the session took it: the receipt goes too, so nothing on record can still send it and the
          // refusal stays definite (NOT_ACCEPTED_5XX). The client sends again as a new request, or not at all.
          if (error instanceof AppError && refusedBeforeAccepting(error.status, error.code)) {
            const next = new Map(this.entries)
            next.delete(immediate.id)
            let dropped = false
            try {
              await this.commit(next)
              dropped = true
            } catch {
              /* Kept on disk: it stays a visible item to retry, so the answer cannot be definite. */
            }
            if (dropped) {
              if (files.attachmentIds) await this.options.releaseAttachments?.(actor, sessionId, files.attachmentIds, immediate.requestId)
              this.options.dropped?.(actor, sessionId, immediate.id)
              this.options.changed(sessionId)
              throw error
            }
            await this.patch(immediate, { state: 'uncertain', reason: '发送结果未确认，请重试这一项' }).catch(() => {})
            throw new AppError(503, 'queue-send-unknown', '这条消息的发送结果未确认，请在队列里重试这一项。')
          }
          await this.patch(immediate, { state: 'uncertain', reason: '发送结果未确认，请重试这一项' })
          throw error
        }
        return { accepted: true }
      }
      if (items.length >= 5) throw new AppError(409, 'queue-full', '最多排队 5 条，请先移除一条')
      if ([...this.entries.values()].filter(item => VISIBLE.has(item.state)).length >= 1000)
        throw new AppError(409, 'queue-full', 'Host 的排队内容已满，请先移除不需要的内容')
      const next = new Map(this.entries)
      if (next.size >= MAX_RECEIPTS || [...next.values()].filter(item => item.deviceId === actor.deviceId).length >= RECEIPTS_PER_DEVICE)
        throw new AppError(409, 'queue-full', '排队回执已满，请删除不需要的旧会话后重试')
      const item: Record = {
        ...actor,
        id: `queue-${randomUUID()}`,
        sessionId,
        requestId: input.requestId,
        sendRequestId: input.requestId,
        hash,
        ...files,
        ...team,
        text: input.prompt,
        queuedAt: new Date(this.now()).toISOString(),
        waitRunId: detail.summary.runId ?? '',
        state:
          ACTIVE.has(detail.summary.status) && !!detail.summary.runId && !items.some(item => item.state !== 'waiting')
            ? 'waiting'
            : 'parked',
        ...(model ? { model } : {}),
        ...(binding ? { binding } : {}),
        ...(coauthors ? { coauthors } : {}),
      }
      if (items[0]?.orderRevision !== undefined) item.orderRevision = items[0].orderRevision
      if (item.state === 'parked') item.reason = '队列已暂停，请确认后发送'
      valid(item)
      await this.options.beforeEnqueue(actor, sessionId, item.id)
      // Audit I/O can outlive revocation or a policy change.
      await this.options.check(actor, sessionId, model, binding)
      next.set(item.id, item)
      await this.admit(item, next)
      this.options.changed(sessionId)
      return { queued: { id: item.id } }
    })
  }

  private async admit(item: Record, next: Map<string, Record>): Promise<void> {
    if (item.attachmentIds) {
      if (!this.options.holdAttachments) throw new AppError(409, 'attachments-unsupported', '当前会话不能保存排队附件。')
      await this.options.holdAttachments(item, item.sessionId, item.attachmentIds, item.requestId, item.model)
      try {
        await this.options.check(item, item.sessionId, item.model, item.binding)
      } catch (error) {
        await this.options.releaseAttachments?.(item, item.sessionId, item.attachmentIds, item.requestId)
        throw error
      }
    }
    try {
      await this.commit(next)
    } catch (cause) {
      if (!item.attachmentIds) throw cause
      // rename or directory sync may already have succeeded. Never release or dispatch on that uncertainty.
      this.entries.set(item.id, { ...item, state: 'parked', reason: '排队保存结果未确认，请确认后发送' })
      this.unconfirmedAdmissions.add(item.id)
      this.options.changed(item.sessionId)
      throw new AppError(503, 'queue-save-unknown', '排队保存结果未确认，请重试原请求或到队列里移除。')
    }
  }

  edit(sessionId: string, itemId: string, value: string, actor: QueueActor, authorize?: () => Promise<void>): Promise<void> {
    return this.lock(async () => {
      this.assertOpen()
      const item = this.find(sessionId, itemId)
      if (!VISIBLE.has(item.state) || item.state === 'sending' || item.state === 'uncertain')
        throw new AppError(409, 'queue-settled', '这一项已经发送或正在确认结果')
      if (!text.safeParse(value).success) throw new AppError(400, 'queue-item-invalid', '排队内容无效。')
      if (item.text === value) return
      await this.options.check(actor, sessionId, item.model, item.binding)
      await authorize?.()
      // The editor before this one may have kept words of its own: it stays a writer of the text, so authorship only grows.
      const previous = item.editor?.deviceId
      const kept =
        previous !== undefined && previous !== actor.deviceId && previous !== item.deviceId && !item.coauthors?.includes(previous)
          ? checkedCoauthors([...(item.coauthors ?? []), previous])
          : item.coauthors
      const contentRevision = (item.contentRevision ?? 0) + 1
      if (!Number.isSafeInteger(contentRevision)) throw new AppError(409, 'queue-item-invalid', '这条排队内容无法再修改。')
      await this.patch(item, {
        text: value,
        contentRevision,
        sendRequestId: randomUUID(),
        editor: actor,
        ...(kept ? { coauthors: kept } : {}),
      })
    })
  }

  remove(sessionId: string, itemId: string, authorize?: () => void): Promise<{ removed: true; deliveryUnknown?: true }> {
    return this.lock(async () => {
      authorize?.()
      const item = this.find(sessionId, itemId)
      const unknown = item.state === 'sending' || item.state === 'uncertain'
      if (item.state !== 'removed') {
        await this.patch(item, { state: 'removed', text: undefined, attachmentIds: undefined, reason: undefined })
        if (!unknown && item.attachmentIds) await this.options.releaseAttachments?.(item, sessionId, item.attachmentIds, item.requestId)
      }
      return { removed: true, ...(unknown ? { deliveryUnknown: true } : {}) }
    })
  }

  send(sessionId: string, itemId: string, authorize?: () => Promise<void>): Promise<void> {
    return this.lock(async () => {
      this.assertOpen()
      const item = this.find(sessionId, itemId)
      if (item.state === 'sent') return
      if (!VISIBLE.has(item.state) || item.state === 'dropped') throw new AppError(409, 'queue-settled', '这一项已移除或已失去发送权限')
      if (item.steerRunId) throw new AppError(409, 'steer-unknown', '追加结果未确认，请核对会话记录')
      if (this.items(sessionId)[0]?.id !== itemId) throw new AppError(409, 'queue-order', '请先发送或移除前面的内容')
      const detail = await this.options.detail(sessionId)
      if (ACTIVE.has(detail.summary.status) || detail.approvals.length) throw new AppError(409, 'task-running', '请等当前轮次结束')
      await authorize?.()
      await this.dispatch(item, true, authorize)
    })
  }

  reorder(
    sessionId: string,
    input: { baseOrder: string[]; order: string[]; baseRevision: number },
    authorize: () => Promise<void>,
    beforeChange?: () => Promise<void>,
  ): Promise<void> {
    return this.lock(async () => {
      this.assertOpen()
      await authorize()
      const items = this.items(sessionId)
      const { baseOrder, order, baseRevision } = input
      if (
        order.length !== baseOrder.length
        || new Set(baseOrder).size !== baseOrder.length
        || new Set(order).size !== order.length
        || !order.every(id => baseOrder.includes(id))
      )
        throw new AppError(400, 'invalid-input', '请提供同一组排队内容的完整顺序。')
      if (items.length === order.length && items.every((item, i) => item.id === order[i])) return
      if (
        (items[0]?.orderRevision ?? 0) !== baseRevision
        || !Number.isSafeInteger(baseRevision + 1)
        || items.length !== baseOrder.length
        || items.some((item, i) => item.id !== baseOrder[i] || item.state === 'sending' || item.state === 'uncertain')
      )
        throw new AppError(409, 'queue-order', '队列已变化，请重新查看后调整顺序。')
      if (beforeChange) {
        await beforeChange()
        await authorize()
      }
      // Map insertion order is the order written to disk and consumed by the automatic dispatcher.
      const next = new Map(this.entries)
      for (const id of order) next.delete(id)
      for (const id of order) next.set(id, { ...this.find(sessionId, id), orderRevision: baseRevision + 1 })
      await this.commit(next)
      this.options.changed(sessionId)
    })
  }

  private canSteer(item: Record, steerAttachments: boolean): boolean {
    return (
      (item.state === 'parked' || item.state === 'waiting')
      && (!item.attachmentIds || (steerAttachments && !!this.options.bindAttachments))
      && !item.teamRequest
      && !mentionsConversationReference(item.text ?? '')
      && !item.model
      && !item.binding
      && !!this.options.steer
      && (this.options.canSteer?.(item.sessionId, !!item.attachmentIds) ?? true)
    )
  }

  steer(
    sessionId: string,
    itemId: string,
    input: { runId: string; contentRevision: number },
    sender: QueueActor,
    authorize: () => Promise<void>,
  ): Promise<void> {
    return this.lock(async () => {
      this.assertOpen()
      await authorize()
      const item = this.find(sessionId, itemId)
      const { runId, contentRevision } = input
      if ((item.contentRevision ?? 0) !== contentRevision)
        throw new AppError(409, 'queue-content-changed', '这条排队内容已被修改，请核对后重新追加。')
      if (item.state === 'sent' && item.steerRunId === runId) return
      const detail = await this.options.detail(sessionId)
      if ((item.state === 'sending' || item.state === 'uncertain') && item.steerRunId) {
        if (item.steerRunId === runId && (await this.confirmSteer(item, detail))) return
        throw new AppError(409, 'steer-unknown', '追加结果未确认，请核对会话记录')
      }
      if (!this.canSteer(item, !!detail.steerAttachments) || !this.options.steer || !detail.steer || detail.summary.runId !== runId)
        throw new AppError(409, 'queue-steer-unavailable', '该项目前不能追加到这一轮，请查看队列。')

      if (!(await this.checkWriters(item))) throw new AppError(409, 'queue-paused', '排队内容的原授权已变化，请重新查看。')
      // The original request may already have tried to steer and received prompt-required before it was queued.
      const requestId = randomUUID()
      const sending: Record = { ...item, state: 'sending', steerRunId: runId, sendRequestId: requestId }
      await this.save(sending)
      let outcome: 'injected' | 'prompt-required'
      try {
        outcome = await this.options.steer(item, sessionId, {
          sender,
          runId,
          requestId,
          itemId,
          text: item.text!,
          queuedAt: item.queuedAt,
          ...(item.attachmentIds ? { attachmentIds: item.attachmentIds, attachmentRequestId: item.requestId } : {}),
          ...(item.editor ? { editor: item.editor } : {}),
          ...(item.coauthors ? { coauthors: item.coauthors } : {}),
          authorize: async () => {
            await this.options.check(item, sessionId, item.model, item.binding)
            if (item.editor) await this.options.check(item.editor, sessionId, item.model, item.binding)
            await authorize()
          },
        })
        if (outcome === 'injected' && item.attachmentIds) await this.options.bindAttachments!(item, sessionId, item.attachmentIds)
      } catch (error) {
        if (error instanceof AppError && refusedBeforeAccepting(error.status, error.code)) {
          await this.save(item)
          throw error
        }
        await this.patch(sending, { state: 'uncertain' })
        await this.park(sessionId, '上一条追加尚未确认，请检查队列')
        throw new AppError(409, 'steer-unknown', '追加结果未确认，请核对会话记录')
      }
      if (outcome !== 'injected') {
        await this.save(item)
        throw new AppError(409, 'queue-steer-unavailable', '当前轮次没有接受追加，队列会按原顺序处理。')
      }
      await this.patch(sending, { state: 'sent', text: undefined, attachmentIds: undefined, reason: undefined })
    })
  }

  private async confirmSteer(item: Record, detail: TaskDetail): Promise<boolean> {
    if (!(await receivedSteer(item, detail, this.options))) {
      // The lock is ours again. A surviving sending record means its final write did not settle.
      if (item.state === 'sending') await this.patch(item, { state: 'uncertain' })
      return false
    }
    await this.patch(item, { state: 'sent', text: undefined, attachmentIds: undefined, reason: undefined })
    return true
  }

  changed(sessionId: string): Promise<void> {
    return this.lock(async () => {
      if (this.closed) return
      const items = this.items(sessionId)
      const item = items[0]
      const unconfirmed = items.filter(entry => entry.steerRunId && (entry.state === 'uncertain' || entry.state === 'sending'))
      if (!unconfirmed.length && item?.state !== 'waiting') return
      let detail: TaskDetail
      try {
        detail = await this.options.detail(sessionId)
      } catch {
        if (items.some(entry => entry.state === 'waiting')) await this.park(sessionId, '会话已不可用，请重新检查')
        return
      }
      let unresolved = false
      for (const entry of unconfirmed) if (!(await this.confirmSteer(entry, detail))) unresolved = true
      if (unresolved) {
        if (items.some(pending => pending.state === 'waiting')) await this.park(sessionId, '上一条追加尚未确认，请检查队列')
        return
      }
      if (item?.state !== 'waiting') return
      if (ACTIVE.has(detail.summary.status)) return
      if (
        detail.summary.runOutcome !== 'completed'
        || !item.waitRunId
        || item.waitRunId !== detail.summary.runId
        || detail.approvals.length
      ) {
        await this.park(sessionId, '上一轮没有完成，请确认后发送')
        return
      }
      await this.dispatch(item, false)
    })
  }

  /** A stop pauses the session's queue whatever it ends: a stop that only answers requests left after a turn ends no run. */
  stopped(sessionId: string): Promise<void> {
    return this.lock(async () => {
      if (this.items(sessionId).some(item => item.state === 'waiting')) await this.park(sessionId, '已停止')
    })
  }

  forgetSession(sessionId: string): Promise<void> {
    return this.lock(async () => {
      const next = new Map(this.entries)
      for (const [key, item] of next) if (item.sessionId === sessionId) next.delete(key)
      await this.commit(next)
    })
  }

  close(): Promise<void> {
    this.closed = true
    return this.lock(async () => {
      const next = new Map(this.entries)
      for (const [key, item] of next)
        if (item.state === 'waiting' || item.state === 'sending')
          next.set(key, { ...item, state: item.state === 'sending' ? 'uncertain' : 'parked', reason: 'Host 已停止，请确认后发送' })
      if (next.size) await this.commit(next)
    })
  }

  private async checkWriters(item: Record): Promise<boolean> {
    try {
      await this.options.check(item, item.sessionId, item.model, item.binding)
      if (item.editor) await this.options.check(item.editor, item.sessionId, item.model, item.binding)
      return true
    } catch (error) {
      if (error instanceof AppError && (error.code === 'queue-paused' || error.code === 'queue-context-changed')) {
        await this.patch(item, {
          state: 'parked',
          reason:
            error instanceof AppError && error.code === 'queue-context-changed'
              ? 'Agent 的设置已改变，请移除此项后重新加入队列'
              : '验证窗口已变化，请检查后重新加入队列',
        })
        await this.park(item.sessionId, '原授权已变化，队列已暂停')
        return false
      }
      await this.patch(item, { state: 'dropped', reason: '设备权限或会话配置已变化，未发送' })
      await this.park(item.sessionId, '上一条未发送，请检查队列')
      return false
    }
  }

  private async dispatch(item: Record, resume: boolean, authorize?: () => Promise<void>): Promise<void> {
    if (!(await this.checkWriters(item))) return
    this.assertOpen()
    await this.patch(item, { state: 'sending', reason: undefined })
    const beforeSend =
      item.editor || authorize
        ? async () => {
            if (item.editor) await this.options.check(item.editor, item.sessionId, item.model, item.binding)
            await authorize?.()
          }
        : undefined
    try {
      await this.options.send(item, item.sessionId, {
        text: item.text!,
        requestId: item.sendRequestId,
        queuedAt: item.queuedAt,
        itemId: item.id,
        ...(item.teamRequest ? { teamRequest: true } : {}),
        ...(item.attachmentIds ? { attachmentIds: item.attachmentIds, attachmentRequestId: item.requestId } : {}),
        ...(item.editor ? { editor: item.editor } : {}),
        ...(item.coauthors ? { coauthors: item.coauthors } : {}),
        ...(beforeSend ? { authorize: beforeSend } : {}),
        ...(item.model ? { model: item.model } : {}),
        ...(item.binding ? { binding: item.binding } : {}),
      })
    } catch (error) {
      if (error instanceof AppError && (error.code === 'queue-paused' || error.code === 'queue-context-changed')) {
        await this.patch(this.find(item.sessionId, item.id), {
          state: 'parked',
          reason:
            error instanceof AppError && error.code === 'queue-context-changed'
              ? 'Agent 的设置已改变，请移除此项后重新加入队列'
              : '验证窗口已变化，请检查后重新加入队列',
        })
        await this.park(item.sessionId, '原授权已变化，队列已暂停')
        return
      }
      await this.patch(this.find(item.sessionId, item.id), { state: 'uncertain', reason: '发送结果未确认，请重试这一项' })
      await this.park(item.sessionId, '上一条未确认送达，请确认后发送')
      return
    }
    const detail = await this.options.detail(item.sessionId)
    const next = new Map(this.entries)
    next.set(item.id, { ...item, state: 'sent', text: undefined, attachmentIds: undefined, reason: undefined })
    for (const [key, pending] of next)
      if (pending.sessionId === item.sessionId && (pending.state === 'waiting' || (resume && pending.state === 'parked'))) {
        next.set(key, { ...pending, state: 'waiting', waitRunId: detail.summary.runId ?? '', reason: undefined })
      }
    await this.commit(next)
    this.options.changed(item.sessionId)
  }

  private items(sessionId: string): Record[] {
    return [...this.entries.values()].filter(item => item.sessionId === sessionId && VISIBLE.has(item.state))
  }
  private find(sessionId: string, id: string): Record {
    const item = this.entries.get(id)
    if (!item || item.sessionId !== sessionId) throw new AppError(404, 'queue-not-found', '找不到这条排队内容')
    return item
  }
  private assertOpen(): void {
    if (this.closed) throw new AppError(503, 'host-closing', 'Host 正在停止，队列已暂停')
  }
  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
  private async park(sessionId: string, reason: string): Promise<void> {
    const next = new Map(this.entries)
    for (const [key, item] of next)
      if (item.sessionId === sessionId && item.state === 'waiting') next.set(key, { ...item, state: 'parked', reason })
    await this.commit(next)
    this.options.changed(sessionId)
  }
  private async patch(item: Record, patch: Partial<Record>): Promise<void> {
    await this.save({ ...item, ...patch })
  }
  private async save(item: Record): Promise<void> {
    const next = new Map(this.entries)
    next.set(item.id, item)
    await this.commit(next)
    this.options.changed(item.sessionId)
  }
  private async commit(next: Map<string, Record>): Promise<void> {
    await writeFileAtomic(join(this.options.dataDir, 'queues.json'), JSON.stringify({ version: 1, items: [...next.values()] }))
    this.entries = next
    this.unconfirmedAdmissions.clear()
  }
  private lock<T>(action: () => Promise<T>): Promise<T> {
    const result = this.serial.then(action)
    this.serial = result.then(
      () => {},
      () => {},
    )
    return result
  }
}
