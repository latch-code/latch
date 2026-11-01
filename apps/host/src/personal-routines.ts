import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  PersonalRoutine,
  PersonalRoutineCreate,
  PersonalRoutinePatch,
  PersonalRoutineEnable,
  PersonalRoutinePauseReason,
  PersonalAgentContext,
  TaskDetail,
  TaskMode,
  ModelRef,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, type AtomicWriteFs } from '@latch/core/node-kit'
import type { AuditLog } from './audit.ts'
import type { PersonalActor } from './personal-store.ts'
import { AgentJournal } from './agent-journal.ts'
import { dailyDate, nextDaily } from './personal-schedule.ts'

const rid = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  hash = z.string().regex(/^[a-f0-9]{64}$/u),
  id = z.string().regex(/^routine_[a-f0-9-]{36}$/u),
  at = z.string().datetime(),
  revision = z.number().int().positive().safe(),
  config = z.strictObject({
    assistantId: z.string().regex(/^asst_[a-f0-9-]{36}$/u),
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(value => !/[\p{Cc}\p{Cf}]/u.test(value)),
    prompt: z
      .string()
      .min(1)
      .max(16000)
      .refine(value => value.trim().length > 0),
    schedule: z.strictObject({ kind: z.literal('daily'), time: z.string().max(5), timeZone: z.string().min(1).max(80) }),
  }),
  pauseReason = z.enum([
    'definition-changed',
    'owner-unavailable',
    'harness-unavailable',
    'plugin-unavailable',
    'missed',
    'unknown-outcome',
    'audit-unavailable',
  ]),
  outcome = z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown']),
  routine = config.extend({
    id,
    revision,
    enabled: z.boolean(),
    state: z.enum(['disabled', 'ready', 'running', 'paused']),
    pauseReason: pauseReason.optional(),
    nextRunAt: at.optional(),
    createdAt: at,
    updatedAt: at,
    lastRun: z.strictObject({ sessionId: z.string().min(1).max(256).optional(), at, state: outcome }).optional(),
  }),
  grant = z.strictObject({ deviceId: z.string().max(256), basis: hash, persistent: z.boolean() }),
  attempt = z.strictObject({ requestId: rid, slot: at, date: z.string().max(10), sessionId: z.string().max(256).optional() }),
  row = z.strictObject({ routine, grant: grant.optional(), attempt: attempt.optional(), lastDate: z.string().max(10).optional() }),
  stateSchema = z
    .strictObject({
      version: z.literal(1),
      rows: z.array(row).max(128),
      receipts: z.record(hash, z.strictObject({ hash, id, audited: z.boolean() })),
    })
    .superRefine((state, ctx) => {
      if (Object.keys(state.receipts).length > 10000 || new Set(state.rows.map(row => row.routine.id)).size !== state.rows.length)
        ctx.addIssue({ code: 'custom', message: 'Capacity or duplicate identity' })
      if (Buffer.byteLength(JSON.stringify(state.rows.map(row => row.routine))) > 256 * 1024)
        ctx.addIssue({ code: 'custom', message: 'Overview body capacity' })
    }),
  create = config.extend({ requestId: rid }),
  patch = config.partial().extend({ requestId: rid, baseRevision: revision }),
  enable = z.strictObject({ requestId: rid, baseRevision: revision, enabled: z.boolean() })
type State = z.infer<typeof stateSchema>
type Row = z.infer<typeof row>
const digest = (value: unknown) => sha256Hex(canonicalJson(value))
export interface RoutinePlan {
  basis: string
  persistent: boolean
  personal: PersonalAgentContext
  mode: TaskMode
  model: ModelRef
}
interface Options {
  dataDir: string
  audit: Pick<AuditLog, 'append'>
  now?: () => number
  atomicFs?: AtomicWriteFs
  plan(assistantId: string): RoutinePlan
  authorize(deviceId: string): void
  start(input: { requestId: string; prompt: string; plan: RoutinePlan; authorize: () => void }): Promise<{ sessionId: string }>
  detail(sessionId: string): Promise<TaskDetail>
  cancel(sessionId: string, runId?: string): Promise<unknown>
  approvalTtlMs(): number
  changed(): void
}

/** Durable delegated intents around the existing Harness. Storage recovery never repeats an unknown start. */
export class PersonalRoutines {
  private running = false
  private closed = false
  private timer?: ReturnType<typeof setInterval>
  private constructor(
    private readonly options: Options,
    private readonly journal: AgentJournal<State>,
  ) {}
  static async open(options: Options): Promise<PersonalRoutines> {
    const journal = await AgentJournal.open(
        options.dataDir,
        'routines.json',
        stateSchema,
        { version: 1, rows: [], receipts: {} },
        { directory: 'personal', atomicFs: options.atomicFs },
      ),
      service = new PersonalRoutines(options, journal)
    await journal.change('startup', 'startup', draft => {
      for (const row of draft.rows) {
        if (row.attempt && !row.attempt.sessionId) service.pause(row, 'unknown-outcome')
        else if (row.routine.enabled && !row.attempt) {
          if (!row.grant?.persistent) service.pause(row, 'definition-changed')
          else if (row.routine.nextRunAt && Date.parse(row.routine.nextRunAt) <= service.now()) service.pause(row, 'missed')
        }
      }
      return { value: true }
    })
    service.timer = setInterval(() => {
      void service.tick().catch(() => {})
    }, 500)
    service.timer.unref()
    return service
  }
  list(): PersonalRoutine[] {
    return this.journal.read().rows.map(row => row.routine)
  }
  get(id: string): PersonalRoutine {
    return this.find(this.journal.read(), id).routine
  }
  async create(input: PersonalRoutineCreate, actor: PersonalActor): Promise<PersonalRoutine> {
    const data = create.parse(input)
    return this.mutate('create', '', data, actor, state => {
      nextDaily(data.schedule, this.now())
      this.options.plan(data.assistantId)
      if (state.rows.length >= 128) throw new AppError(409, 'personal-routine-limit', '最多保存 128 个例行任务。')
      const { requestId: _, ...definition } = data
      const stamp = this.stamp(),
        value: PersonalRoutine = {
          ...definition,
          id: `routine_${randomUUID()}`,
          revision: 1,
          enabled: false,
          state: 'disabled',
          createdAt: stamp,
          updatedAt: stamp,
        }
      state.rows.push({ routine: value })
      return value.id
    })
  }
  async patch(id: string, input: PersonalRoutinePatch, actor: PersonalActor): Promise<PersonalRoutine> {
    const data = patch.parse(input)
    return this.mutate('update', id, data, actor, state => {
      const row = this.find(state, id),
        old = row.routine
      this.revision(old, data.baseRevision)
      if (row.attempt) throw new AppError(409, 'personal-routine-running', '请先等待当前例行任务结束。')
      const { requestId: _, baseRevision: __, ...changes } = data,
        next = { ...old, ...changes, revision: old.revision + 1, updatedAt: this.stamp() }
      nextDaily(next.schedule, this.now())
      this.options.plan(next.assistantId)
      row.routine = next
      if (digest(this.execution(old)) !== digest(this.execution(next)) && old.enabled) this.pause(row, 'definition-changed')
      return id
    })
  }
  async setEnabled(id: string, input: PersonalRoutineEnable, actor: PersonalActor): Promise<PersonalRoutine> {
    const data = enable.parse(input)
    if (data.enabled && actor.actor.listener !== 'unix') throw new AppError(403, 'local-only', '请在执行端电脑上开启例行任务。')
    return this.mutate(
      'update',
      id,
      data,
      actor,
      state => {
        const row = this.find(state, id)
        this.revision(row.routine, data.baseRevision)
        if (data.enabled) {
          if (row.attempt) throw new AppError(409, 'personal-routine-running', '请先等待当前例行任务结束。')
          this.options.authorize(actor.actor.deviceId)
          const plan = this.options.plan(row.routine.assistantId)
          row.grant = { deviceId: actor.actor.deviceId, basis: this.basis(row.routine, plan), persistent: plan.persistent }
          row.routine.enabled = true
          if (!row.attempt) {
            row.routine.state = 'ready'
            row.routine.nextRunAt = nextDaily(row.routine.schedule, this.now(), row.lastDate)
          }
          delete row.routine.pauseReason
        } else {
          row.routine.enabled = false
          if (!row.attempt) row.routine.state = 'disabled'
          delete row.routine.nextRunAt
          delete row.routine.pauseReason
          delete row.grant
        }
        row.routine.revision++
        row.routine.updatedAt = this.stamp()
        return id
      },
      !data.enabled,
    )
  }
  async remove(id: string, requestId: string, actor: PersonalActor): Promise<{ deleted: true }> {
    rid.parse(requestId)
    await this.mutate(
      'delete',
      id,
      { requestId },
      actor,
      state => {
        const row = this.find(state, id)
        if (row.attempt) throw new AppError(409, 'personal-routine-running', '请先等待当前例行任务结束。')
        state.rows = state.rows.filter(row => row.routine.id !== id)
        return id
      },
      true,
    )
    return { deleted: true }
  }
  private async mutate(
    operation: 'create' | 'update' | 'delete',
    id: string,
    data: { requestId: string },
    actor: PersonalActor,
    apply: (state: State) => string,
    lowering = false,
  ): Promise<PersonalRoutine> {
    actor.authorize()
    const key = digest([actor.actor.deviceId, data.requestId]),
      hash = digest([operation, id, data])
    const result = await this.journal.change(
      key,
      hash,
      async state => {
        const prior = state.receipts[key]
        if (prior) {
          if (prior.hash !== hash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
          return { value: prior, changed: false }
        }
        if (Object.keys(state.receipts).length >= 10000 && !lowering)
          throw new AppError(409, 'personal-receipt-limit', '修改回执已满，请先整理记录。')
        const before = digest(state.rows),
          target = apply(state),
          after = digest(state.rows)
        let audited = true
        try {
          await this.options.audit.append({
            action: 'personal.changed',
            actor: actor.actor,
            target,
            detail: { kind: 'routine', operation, before, after },
          })
        } catch (error) {
          if (!lowering) throw error
          audited = false
        }
        const receipt = { hash, id: target, audited }
        if (Object.keys(state.receipts).length < 10000) state.receipts[key] = receipt
        return { value: receipt }
      },
      actor.authorize,
    )
    this.options.changed()
    if (!result.audited) actor.auditFailed?.()
    if (operation === 'delete') return undefined as unknown as PersonalRoutine
    return this.get(result.id)
  }
  /** Public for deterministic Vitest clocks; production uses the same serialized bounded tick. */
  async tick(): Promise<void> {
    if (this.running || this.closed) return
    this.running = true
    try {
      if (this.journal.hasPending()) {
        await this.journal.recover()
        await this.reconcileUnknown()
      }
      for (const row of this.journal.read().rows) {
        if (this.closed) break
        if (row.attempt?.sessionId) {
          await this.settle(row)
          continue
        }
        if (!row.routine.enabled || row.routine.state !== 'ready' || !row.grant) continue
        let plan: RoutinePlan
        try {
          this.options.authorize(row.grant.deviceId)
          plan = this.options.plan(row.routine.assistantId)
          if (this.basis(row.routine, plan) !== row.grant.basis) {
            await this.markPaused(row, 'definition-changed')
            continue
          }
        } catch (error) {
          await this.markPaused(row, error instanceof AppError && error.status === 403 ? 'owner-unavailable' : 'plugin-unavailable')
          continue
        }
        if (!row.routine.nextRunAt || Date.parse(row.routine.nextRunAt) > this.now()) continue
        if (this.journal.read().rows.filter(row => row.attempt).length >= 2) break
        if (this.now() - Date.parse(row.routine.nextRunAt) > 60000) {
          await this.markPaused(row, 'missed')
          continue
        }
        await this.dispatch(row, plan)
      }
    } finally {
      this.running = false
    }
  }
  private async dispatch(row: Row, plan: RoutinePlan): Promise<void> {
    const slot = row.routine.nextRunAt!,
      requestId = digest(['personal-routine', row.routine.id, slot]),
      expected = row.grant!.basis,
      deviceId = row.grant!.deviceId,
      authorize = () => {
        this.options.authorize(deviceId)
        const current = this.find(this.journal.read(), row.routine.id)
        if (!current.routine.enabled || current.grant?.basis !== expected || current.grant.deviceId !== deviceId)
          throw new AppError(409, 'personal-routine-changed', '例行任务已停用或改变。')
        if (this.basis(row.routine, this.options.plan(row.routine.assistantId)) !== expected)
          throw new AppError(409, 'personal-definition-changed', '例行任务的执行配置已改变。')
      }
    try {
      await this.journal.change(
        requestId,
        'intent',
        async state => {
          authorize()
          const target = this.find(state, row.routine.id)
          if (target.attempt || !target.routine.enabled || target.routine.nextRunAt !== slot || target.grant?.basis !== expected)
            throw new AppError(409, 'personal-routine-changed', '例行任务已改变。')
          await this.options.audit.append({
            action: 'personal.changed',
            actor: { listener: 'host' },
            target: row.routine.id,
            detail: { kind: 'routine', operation: 'start', before: digest(target), after: digest({ requestId, slot }) },
          })
          target.attempt = { requestId, slot, date: dailyDate(row.routine.schedule, Date.parse(slot)) }
          target.lastDate = target.attempt.date
          target.routine.state = 'running'
          delete target.routine.nextRunAt
          target.routine.lastRun = { at: this.stamp(), state: 'running' }
          return { value: true }
        },
        authorize,
      )
    } catch {
      if (!this.journal.hasPending()) await this.markPaused(row, 'audit-unavailable')
      return
    }
    this.options.changed()
    try {
      authorize()
      const created = await this.options.start({ requestId, prompt: row.routine.prompt, plan, authorize })
      await this.journal.change(requestId, 'accepted', state => {
        const target = this.find(state, row.routine.id)
        if (target.attempt?.requestId !== requestId) throw new Error('Attempt changed')
        target.attempt.sessionId = created.sessionId
        target.routine.lastRun!.sessionId = created.sessionId
        return { value: true }
      })
    } catch {
      if (!this.journal.hasPending()) await this.markPaused(row, 'unknown-outcome')
    }
    this.options.changed()
  }
  private async settle(row: Row): Promise<void> {
    let detail: TaskDetail
    try {
      detail = await this.options.detail(row.attempt!.sessionId!)
    } catch {
      return
    }
    if (detail.summary.status === 'waiting-approval' && this.now() - Date.parse(row.routine.lastRun!.at) >= this.options.approvalTtlMs()) {
      await this.options.cancel(detail.summary.id, detail.summary.runId)
      return
    }
    if (detail.summary.status === 'running' || detail.summary.status === 'waiting-approval') return
    await this.journal.change(row.attempt!.requestId, 'settled', state => {
      const target = this.find(state, row.routine.id)
      if (target.attempt?.requestId !== row.attempt!.requestId) return { value: false, changed: false }
      const result = detail.summary.runOutcome
      target.routine.lastRun = { sessionId: detail.summary.id, at: this.stamp(), state: result ?? 'unknown' }
      delete target.attempt
      if (result === 'interrupted' || !result) this.pause(target, 'unknown-outcome')
      else if (target.routine.enabled) {
        target.routine.state = 'ready'
        target.routine.nextRunAt = nextDaily(target.routine.schedule, this.now(), target.lastDate)
      } else target.routine.state = 'disabled'
      return { value: true }
    })
    this.options.changed()
  }
  private async reconcileUnknown(): Promise<void> {
    for (const row of this.journal.read().rows) if (row.attempt && !row.attempt.sessionId) await this.markPaused(row, 'unknown-outcome')
  }
  private async markPaused(row: Row, reason: PersonalRoutinePauseReason): Promise<void> {
    await this.journal.change(`pause:${row.routine.id}`, reason, state => {
      this.pause(this.find(state, row.routine.id), reason)
      return { value: true }
    })
    this.options.changed()
  }
  private pause(row: Row, reason: PersonalRoutinePauseReason): void {
    row.routine.enabled = false
    row.routine.state = 'paused'
    row.routine.pauseReason = reason
    delete row.routine.nextRunAt
    if (row.attempt && !row.attempt.sessionId) {
      row.routine.lastRun = { at: this.stamp(), state: 'unknown' }
      delete row.attempt
    }
  }
  private basis(routine: PersonalRoutine, plan: RoutinePlan): string {
    return digest([this.execution(routine), plan.basis])
  }
  private execution(routine: PersonalRoutine): unknown {
    return { assistantId: routine.assistantId, prompt: routine.prompt, schedule: routine.schedule }
  }
  private find(state: State, key: string): Row {
    const row = state.rows.find(row => row.routine.id === key)
    if (!row) throw new AppError(404, 'personal-routine-not-found', '找不到这个例行任务。')
    return row
  }
  private revision(routine: PersonalRoutine, expected: number): void {
    if (routine.revision !== expected) throw new AppError(409, 'personal-changed', '这项记录已更新，请刷新后再修改。')
  }
  private now(): number {
    return (this.options.now ?? Date.now)()
  }
  private stamp(): string {
    return new Date(this.now()).toISOString()
  }
  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    while (this.running) await new Promise(resolve => setTimeout(resolve, 10))
    await this.journal.close()
  }
}
