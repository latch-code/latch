import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { modelEffort } from './config.ts'
import { LISTENER_CLASSES, type ListenerClass, type ModelRef, type PromptQueueItem, type TaskDetail } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, writeFileAtomic } from '@latch/core/node-kit'

const ACTIVE = new Set(['running', 'waiting-approval'])
const VISIBLE = new Set(['waiting', 'parked', 'dropped', 'sending', 'uncertain'])
const MAX_RECEIPTS = 100_000
const RECEIPTS_PER_DEVICE = 10_000
const text = z.string().min(1).max(16_000)
const id = z.string().min(1).max(256)
const actorSchema = z.strictObject({
  deviceId: id,
  listener: z.enum(LISTENER_CLASSES),
  dataScope: z.enum(['work', 'all']),
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
  dataScope: z.enum(['work', 'all']),
  nativeWindowHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  editor: actorSchema.optional(),
  binding: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  requestId: z.string().uuid(),
  sendRequestId: z.string().uuid(),
  hash: z.string().regex(/^[a-f0-9]{64}$/u),
  text: text.optional(),
  queuedAt: z.string().datetime(),
  state: z.enum(['waiting', 'parked', 'dropped', 'sending', 'uncertain', 'sent', 'removed']),
  waitRunId: z.string().max(128),
  reason: z.string().max(200).optional(),
  model: z
    .strictObject({ providerId: z.string().min(1).max(64), model: z.string().min(1).max(200), effort: modelEffort.optional() })
    .optional(),
})
const fileSchema = z.strictObject({ version: z.literal(1), items: z.array(recordSchema).max(MAX_RECEIPTS) })
type Record = z.infer<typeof recordSchema>
export interface QueueActor {
  deviceId: string
  listener: ListenerClass
  dataScope: 'work' | 'all'
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
  beforeEnqueue(actor: QueueActor, sessionId: string, itemId: string): Promise<void>
  send(
    actor: QueueActor,
    sessionId: string,
    input: {
      text: string
      requestId: string
      model?: ModelRef
      binding?: string
      queuedAt?: string
      itemId?: string
      authorize?: () => Promise<void>
    },
  ): Promise<void>
  changed(sessionId: string): void
}

/** The Host owns FIFO scheduling and receipts; drivers still own prompt acceptance and request deduplication. */
export class PromptQueues {
  private serial: Promise<void> = Promise.resolve()
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
    for (const item of items) {
      const identity = JSON.stringify([item.sessionId, item.deviceId, item.requestId])
      if (entries.has(item.id) || identities.has(identity)) throw new AppError(500, 'queue-corrupt', '排队记录有重复标识，原文件已保留')
      identities.add(identity)
      if (item.state === 'sending') item.state = 'uncertain'
      if (item.state === 'waiting') {
        item.state = 'parked'
        item.reason = 'Host 已重启，请确认后发送'
      }
      if (VISIBLE.has(item.state) && !item.text) throw new AppError(500, 'queue-corrupt', '排队内容缺失，原文件已保留')
      entries.set(item.id, item)
    }
    const queue = new PromptQueues(options, entries)
    if (items.length) await queue.commit(new Map(entries))
    return queue
  }

  view(sessionId: string): PromptQueueItem[] {
    return this.items(sessionId).map(item => ({
      id: item.id,
      text: item.text!,
      queuedAt: item.queuedAt,
      state: item.state === 'sending' ? 'waiting' : item.state === 'uncertain' ? 'parked' : (item.state as PromptQueueItem['state']),
      ...(item.state === 'sending'
        ? { reason: '正在发送' }
        : item.state === 'uncertain'
          ? { reason: '发送结果未确认，请重试这一项' }
          : item.reason
            ? { reason: item.reason }
            : {}),
    }))
  }

  submit(
    actor: QueueActor,
    sessionId: string,
    input: { prompt: string; requestId: string; model?: ModelRef },
  ): Promise<{ accepted: true } | { queued: { id: string } }> {
    return this.lock(async () => {
      this.assertOpen()
      const hash = sha256Hex(canonicalJson({ text: input.prompt, ...(input.model ? { model: input.model } : {}) }))
      const prior = [...this.entries.values()].find(
        item => item.sessionId === sessionId && item.deviceId === actor.deviceId && item.requestId === input.requestId,
      )
      if (prior) {
        if (prior.hash !== hash) throw new AppError(409, 'request-conflict', '同一次排队请求不能提交不同内容')
        return VISIBLE.has(prior.state) ? { queued: { id: prior.id } } : { accepted: true }
      }
      const prepared = await this.options.prepare?.(actor, sessionId, input.model),
        model = prepared?.model ?? input.model,
        binding = prepared?.binding
      await this.options.check(actor, sessionId, model, binding)
      const detail = await this.options.detail(sessionId)
      if (!ACTIVE.has(detail.summary.status) && !this.items(sessionId).length) {
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
          text: input.prompt,
          queuedAt: new Date(this.now()).toISOString(),
          waitRunId: detail.summary.runId ?? '',
          state: 'sending',
          ...(model ? { model } : {}),
          ...(binding ? { binding } : {}),
        }
        next.set(immediate.id, immediate)
        await this.options.beforeEnqueue(actor, sessionId, immediate.id)
        await this.commit(next)
        try {
          await this.options.send(actor, sessionId, {
            text: input.prompt,
            requestId: input.requestId,
            itemId: immediate.id,
            ...(model ? { model } : {}),
            ...(binding ? { binding } : {}),
          })
          await this.patch(immediate, { state: 'sent', text: undefined })
        } catch (error) {
          await this.patch(immediate, { state: 'uncertain', reason: '发送结果未确认，请重试这一项' })
          throw error
        }
        return { accepted: true }
      }
      if (this.items(sessionId).length >= 5) throw new AppError(409, 'queue-full', '最多排队 5 条，请先移除一条')
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
        text: input.prompt,
        queuedAt: new Date(this.now()).toISOString(),
        waitRunId: detail.summary.runId ?? '',
        state:
          ACTIVE.has(detail.summary.status) && !!detail.summary.runId && !this.items(sessionId).some(item => item.state !== 'waiting')
            ? 'waiting'
            : 'parked',
        ...(model ? { model } : {}),
        ...(binding ? { binding } : {}),
      }
      if (item.state === 'parked') item.reason = '队列已暂停，请确认后发送'
      await this.options.beforeEnqueue(actor, sessionId, item.id)
      // Audit I/O can outlive revocation or a policy change.
      await this.options.check(actor, sessionId, model, binding)
      next.set(item.id, item)
      await this.commit(next)
      this.options.changed(sessionId)
      return { queued: { id: item.id } }
    })
  }

  edit(sessionId: string, itemId: string, value: string, actor: QueueActor, authorize?: () => Promise<void>): Promise<void> {
    return this.lock(async () => {
      this.assertOpen()
      const item = this.find(sessionId, itemId)
      if (!VISIBLE.has(item.state) || item.state === 'sending' || item.state === 'uncertain')
        throw new AppError(409, 'queue-settled', '这一项已经发送或正在确认结果')
      if (item.text === value) return
      await this.options.check(actor, sessionId, item.model, item.binding)
      await authorize?.()
      await this.patch(item, { text: value, sendRequestId: randomUUID(), editor: actor })
    })
  }

  remove(sessionId: string, itemId: string, authorize?: () => void): Promise<{ removed: true; deliveryUnknown?: true }> {
    return this.lock(async () => {
      authorize?.()
      const item = this.find(sessionId, itemId)
      const unknown = item.state === 'sending' || item.state === 'uncertain'
      if (item.state !== 'removed') await this.patch(item, { state: 'removed', text: undefined, reason: undefined })
      return { removed: true, ...(unknown ? { deliveryUnknown: true } : {}) }
    })
  }

  send(sessionId: string, itemId: string, authorize?: () => Promise<void>): Promise<void> {
    return this.lock(async () => {
      this.assertOpen()
      const item = this.find(sessionId, itemId)
      if (item.state === 'sent') return
      if (!VISIBLE.has(item.state) || item.state === 'dropped') throw new AppError(409, 'queue-settled', '这一项已移除或已失去发送权限')
      if (this.items(sessionId)[0]?.id !== itemId) throw new AppError(409, 'queue-order', '请先发送或移除前面的内容')
      const detail = await this.options.detail(sessionId)
      if (ACTIVE.has(detail.summary.status) || detail.approvals.length) throw new AppError(409, 'task-running', '请等当前轮次结束')
      await authorize?.()
      await this.dispatch(item, true, authorize)
    })
  }

  changed(sessionId: string): Promise<void> {
    return this.lock(async () => {
      if (this.closed) return
      const item = this.items(sessionId)[0]
      if (!item || item.state !== 'waiting') return
      let detail: TaskDetail
      try {
        detail = await this.options.detail(sessionId)
      } catch {
        await this.park(sessionId, '会话已不可用，请重新检查')
        return
      }
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

  private async dispatch(item: Record, resume: boolean, authorize?: () => Promise<void>): Promise<void> {
    try {
      await this.options.check(item, item.sessionId, item.model, item.binding)
      if (item.editor) await this.options.check(item.editor, item.sessionId, item.model, item.binding)
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
        return
      }
      await this.patch(item, { state: 'dropped', reason: '设备权限或会话配置已变化，未发送' })
      await this.park(item.sessionId, '上一条未发送，请检查队列')
      return
    }
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
    next.set(item.id, { ...item, state: 'sent', text: undefined, reason: undefined })
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
    const next = new Map(this.entries)
    next.set(item.id, { ...item, ...patch })
    await this.commit(next)
    this.options.changed(item.sessionId)
  }
  private async commit(next: Map<string, Record>): Promise<void> {
    await writeFileAtomic(join(this.options.dataDir, 'queues.json'), JSON.stringify({ version: 1, items: [...next.values()] }))
    this.entries = next
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
