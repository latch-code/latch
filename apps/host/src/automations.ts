import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  AgentExecutionContext,
  Automation,
  AutomationConfig,
  AutomationCreate,
  AutomationDetail,
  AutomationEnable,
  AutomationPatch,
  AutomationPauseReason,
  AutomationRun,
  AutomationRunRequest,
  AutomationRunState,
  AutomationSummary,
  ModelRef,
  TaskDetail,
  TaskMode,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, type AtomicWriteFs } from '@latch/core/node-kit'
import { AgentJournal } from './agent-journal.ts'
import type { AuditLog } from './audit.ts'
import { CUSTOM_AGENT_ID, type AgentActor } from './custom-agents.ts'
import { nextRun, scheduleDate } from './schedule.ts'

const MAX_AUTOMATIONS = 128
const MAX_RUNS = 50
const MAX_RECEIPTS = 4096
const MAX_ATTEMPTS = 2
/** A scheduled time counts as met only this soon after it; later than that the Mac was off or asleep. */
const MISSED_AFTER_MS = 60_000
/** Says nothing about the automation: a plugin mid-update, an edit that landed first, or a write still being confirmed. */
const PASSING = new Set(['plugin-busy', 'automation-changed', 'agent-write-unknown'])
const passing = (error: unknown) => error instanceof AppError && PASSING.has(error.code)

const rid = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const id = z.string().regex(/^auto_[a-f0-9-]{36}$/u)
const at = z.string().datetime()
const revision = z.number().int().positive().safe()
const time = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u)
const schedule = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('daily'), time }),
  z.strictObject({ kind: z.literal('weekdays'), time }),
  z.strictObject({ kind: z.literal('weekly'), day: z.number().int().min(0).max(6), time }),
])
const name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(value => !/[\p{Cc}\p{Cf}]/u.test(value))
const prompt = z
  .string()
  .min(1)
  .max(16_000)
  .refine(value => value.trim().length > 0)
const customAgentId = z.string().regex(CUSTOM_AGENT_ID)
const model = z.strictObject({ providerId: z.string().min(1).max(128), model: z.string().min(1).max(256) })
const projectId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u)
const config = z.strictObject({
  name,
  customAgentId: customAgentId.optional(),
  model: model.optional(),
  projectId: projectId.optional(),
  prompt,
  schedule,
  notify: z.boolean(),
})
const runSchema = z.strictObject({
  at,
  state: z.enum(['running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown', 'missed', 'skipped']),
  trigger: z.enum(['schedule', 'manual']),
  sessionId: z.string().min(1).max(256).optional(),
})
const automation = config.extend({
  id,
  revision,
  enabled: z.boolean(),
  state: z.enum(['off', 'ready', 'running', 'paused']),
  pause: z
    .strictObject({
      reason: z.enum(['definition-changed', 'owner-unavailable', 'agent-unavailable', 'unknown-outcome', 'audit-unavailable']),
      message: z.string().max(200),
    })
    .optional(),
  nextRunAt: at.optional(),
  lastRun: runSchema.optional(),
  createdAt: at,
  updatedAt: at,
})
const row = z.strictObject({
  automation,
  /** Who turned it on, and what they turned on. A run needs both still to hold. */
  grant: z.strictObject({ deviceId: z.string().max(256), basis: hash, persistent: z.boolean() }).optional(),
  attempt: z.strictObject({ requestId: z.string().max(256), sessionId: z.string().min(1).max(256).optional() }).optional(),
  /** The due time waiting for one of the runs in progress to end. It was met, so a late start is no missed time. */
  queued: at.optional(),
  /** Local date of the last scheduled run, so a repeated wall time cannot run twice that day. */
  lastDate: z.string().max(10).optional(),
  /** The time zone `nextRunAt` was worked out in. */
  zone: z.string().max(80).optional(),
  runs: z.array(runSchema).max(MAX_RUNS),
})
const stateSchema = z
  .strictObject({
    version: z.literal(1),
    rows: z.array(row).max(MAX_AUTOMATIONS),
    receipts: z.record(hash, z.strictObject({ hash, id: z.string().max(64), audited: z.boolean() })),
  })
  .superRefine((state, ctx) => {
    if (new Set(state.rows.map(item => item.automation.id)).size !== state.rows.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate identity' })
  })
const createSchema = config.extend({ requestId: rid })
const patchSchema = z.strictObject({
  name: name.optional(),
  customAgentId: customAgentId.nullable().optional(),
  model: model.nullable().optional(),
  projectId: projectId.nullable().optional(),
  prompt: prompt.optional(),
  schedule: schedule.optional(),
  notify: z.boolean().optional(),
  requestId: rid,
  baseRevision: revision,
})
const enableSchema = z.strictObject({ requestId: rid, baseRevision: revision, enabled: z.boolean() })
const runRequestSchema = z.strictObject({ requestId: rid })
type State = z.infer<typeof stateSchema>
type Row = z.infer<typeof row>

const PAUSE_MESSAGES: Record<AutomationPauseReason, string> = {
  'definition-changed': '模型、插件或策略已变化，请确认后重新开启。',
  'owner-unavailable': '开启它的设备已不能运行任务，请重新开启。',
  'agent-unavailable': 'Agent、模型或项目暂不可用，请检查后重新开启。',
  'unknown-outcome': '上一次运行的结果未知，为避免重复没有继续，请查看后重新开启。',
  'audit-unavailable': '操作记录写入失败，这次没有运行，请重新开启。',
}

const digest = (value: unknown) => sha256Hex(canonicalJson(value))

export interface AutomationPlan {
  /** Changes with anything a run would receive; a run whose basis differs from what was turned on pauses instead. */
  basis: string
  /** False when the plugins' revisions cannot be trusted across a restart. */
  persistent: boolean
  mode: TaskMode
  model: ModelRef
  agentContext?: AgentExecutionContext
}
interface Options {
  dataDir: string
  audit: Pick<AuditLog, 'append'>
  now?: () => number
  atomicFs?: AtomicWriteFs
  /** The Mac's IANA zone, read again on every check, since it can change. */
  timeZone?: () => string
  plan(config: AutomationConfig): AutomationPlan
  /** Whether this device may have such a run start while nobody is looking. */
  authorize(deviceId: string, config: AutomationConfig): void
  start(input: {
    requestId: string
    automationId: string
    title: string
    prompt: string
    projectId?: string
    plan: AutomationPlan
    authorize: () => void
  }): Promise<{ sessionId: string }>
  detail(sessionId: string): Promise<TaskDetail>
  cancel(sessionId: string, runId?: string): Promise<unknown>
  approvalTtlMs(): number
  changed(): void
}

export function automationSummary(value: Automation): AutomationSummary {
  const { prompt: _prompt, createdAt: _created, updatedAt: _updated, ...summary } = value
  return summary
}

function configOf(value: Automation): AutomationConfig {
  const {
    id: _id,
    revision: _r,
    enabled: _e,
    state: _s,
    pause: _p,
    nextRunAt: _n,
    lastRun: _l,
    createdAt: _c,
    updatedAt: _u,
    ...rest
  } = value
  return rest
}

/**
 * Saved schedules around the built-in engine, in `automations.json`. A start whose result stayed unknown is never sent
 * again, a time the Mac missed is reported and not caught up, and an unattended run still stops at every approval.
 */
export class Automations {
  private running = false
  private closed = false
  private timer?: ReturnType<typeof setInterval>
  /** Agents being saved, by ID and `''` for 通用, with how many saves are in progress. */
  private readonly editing = new Map<string, number>()
  private constructor(
    private readonly options: Options,
    private readonly journal: AgentJournal<State>,
  ) {}

  static async open(options: Options): Promise<Automations> {
    const journal = await AgentJournal.open(
        options.dataDir,
        'automations.json',
        stateSchema,
        { version: 1, rows: [], receipts: {} },
        options.atomicFs ? { atomicFs: options.atomicFs } : {},
      ),
      service = new Automations(options, journal)
    await journal.change('startup', 'startup', draft => {
      for (const item of draft.rows) {
        if (item.attempt && !item.attempt.sessionId) service.pause(item, 'unknown-outcome')
        else if (item.automation.enabled && !item.attempt) {
          if (!item.grant?.persistent) service.pause(item, 'definition-changed')
          else service.reportMissed(item)
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

  list(): Automation[] {
    return this.journal.read().rows.map(item => item.automation)
  }
  get(key: string): Automation {
    return this.find(this.journal.read(), key).automation
  }
  detail(key: string): AutomationDetail {
    const found = this.find(this.journal.read(), key)
    return { automation: found.automation, runs: found.runs }
  }
  hasPending(): boolean {
    return this.journal.hasPending()
  }
  /** Finishes a write whose result was left unknown, so a read does not stay refused until that request is retried. */
  recover(): Promise<void> {
    return this.journal.recover()
  }

  async create(input: AutomationCreate, actor: AgentActor): Promise<{ value: Automation; audited: boolean }> {
    const data = createSchema.parse(input)
    const { requestId: _, ...definition } = data
    const result = await this.mutate('create', '', data, actor, state => {
      if (state.rows.length >= MAX_AUTOMATIONS) throw new AppError(409, 'automation-limit', `最多保存 ${MAX_AUTOMATIONS} 个自动化。`)
      const stamp = this.stamp(),
        value: Automation = {
          ...definition,
          id: `auto_${randomUUID()}`,
          revision: 1,
          enabled: true,
          state: 'ready',
          createdAt: stamp,
          updatedAt: stamp,
        },
        item: Row = { automation: value, runs: [] }
      this.grant(item, actor)
      state.rows.push(item)
      return value.id
    })
    return { value: this.get(result.id), audited: result.audited }
  }

  async patch(key: string, input: AutomationPatch, actor: AgentActor): Promise<{ value: Automation; audited: boolean }> {
    const data = patchSchema.parse(input)
    const result = await this.mutate('update', key, data, actor, state => {
      const item = this.find(state, key),
        old = item.automation
      this.revision(old, data.baseRevision)
      if (item.attempt) throw this.busy()
      const { requestId: _, baseRevision: __, customAgentId: agent, model: selected, projectId: project, ...changes } = data
      const next = {
        ...old,
        ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)),
        revision: old.revision + 1,
        updatedAt: this.stamp(),
      } as Automation
      if (agent === null) delete next.customAgentId
      else if (agent !== undefined) next.customAgentId = agent
      if (selected === null) delete next.model
      else if (selected !== undefined) next.model = selected
      if (project === null) delete next.projectId
      else if (project !== undefined) next.projectId = project
      item.automation = next
      // A new time is a new plan for the day, so it may still run today.
      if (data.schedule && canonicalJson(data.schedule) !== canonicalJson(old.schedule)) delete item.lastDate
      // Only turning it on undoes a pause: the pause may be asking the owner to look at something a rename does not settle.
      if (old.enabled) this.grant(item, actor)
      return key
    })
    return { value: this.get(result.id), audited: result.audited }
  }

  async setEnabled(key: string, input: AutomationEnable, actor: AgentActor): Promise<{ value: Automation; audited: boolean }> {
    const data = enableSchema.parse(input)
    const result = await this.mutate(
      'update',
      key,
      data,
      actor,
      state => {
        const item = this.find(state, key)
        this.revision(item.automation, data.baseRevision)
        if (data.enabled) this.grant(item, actor)
        else {
          item.automation.enabled = false
          if (!item.attempt) item.automation.state = 'off'
          delete item.automation.nextRunAt
          delete item.automation.pause
          delete item.grant
          delete item.queued
        }
        item.automation.revision++
        item.automation.updatedAt = this.stamp()
        return key
      },
      !data.enabled,
    )
    return { value: this.get(result.id), audited: result.audited }
  }

  async remove(key: string, requestId: string, actor: AgentActor): Promise<{ audited: boolean }> {
    const result = await this.mutate(
      'delete',
      key,
      { requestId: rid.parse(requestId) },
      actor,
      state => {
        if (this.find(state, key).attempt) throw this.busy()
        state.rows = state.rows.filter(item => item.automation.id !== key)
        return key
      },
      true,
    )
    return { audited: result.audited }
  }

  /** 立即运行. It runs under the caller's authority, on or off, and leaves the schedule as it is. */
  async runNow(key: string, input: AutomationRunRequest, actor: AgentActor): Promise<{ value: Automation; audited: boolean }> {
    const data = runRequestSchema.parse(input)
    const requestId = digest(['automation-run', key, actor.actor.deviceId, data.requestId])
    let plan: AutomationPlan | undefined
    const result = await this.mutate(
      'run',
      key,
      data,
      actor,
      state => {
        const item = this.find(state, key)
        if (item.attempt) throw this.busy()
        if (this.atLimit(state)) throw new AppError(409, 'automation-limit-running', `已有 ${MAX_ATTEMPTS} 个自动化在运行，请等它们结束。`)
        const definition = configOf(item.automation)
        this.options.authorize(actor.actor.deviceId, definition)
        plan = this.options.plan(definition)
        item.attempt = { requestId }
        this.record(item, { at: this.stamp(), state: 'running', trigger: 'manual' })
        item.automation.state = 'running'
        return key
      },
      false,
      async () => {
        await this.options.audit.append({
          action: 'automation.ran',
          actor: actor.actor,
          target: key,
          detail: { trigger: 'manual', attempt: requestId },
        })
      },
    )
    if (result.replay) return { value: this.get(key), audited: result.audited }
    if (!plan) {
      // The retry only confirmed a write whose result was unknown: the start itself was never attempted, nor is it now.
      const held = this.find(this.journal.read(), key)
      if (held.attempt?.requestId === requestId && !held.attempt.sessionId) await this.markPaused(held, 'unknown-outcome')
      return { value: this.get(key), audited: result.audited }
    }
    this.options.changed()
    const current = this.find(this.journal.read(), key)
    await this.startAttempt(current, plan, requestId, () => {
      actor.authorize()
      this.options.authorize(actor.actor.deviceId, configOf(this.find(this.journal.read(), key).automation))
    })
    return { value: this.get(key), audited: result.audited }
  }

  /**
   * An authorized edit of an agent is an authorized edit of what its automations run, so they keep running on the new
   * definition. The check leaves them alone from before the save until they are bound to it, or it would find the new
   * definition against the old grant and pause them. A failed bind leaves the old grant, and the next check pauses them.
   */
  async edit<T>(customAgent: string | undefined, actor: AgentActor, save: () => Promise<T>): Promise<T> {
    const owner = customAgent ?? ''
    this.editing.set(owner, (this.editing.get(owner) ?? 0) + 1)
    try {
      const saved = await save()
      await this.rebind(customAgent, actor)
      return saved
    } finally {
      const left = this.editing.get(owner)! - 1
      if (left) this.editing.set(owner, left)
      else this.editing.delete(owner)
    }
  }

  private async rebind(customAgent: string | undefined, actor: AgentActor): Promise<void> {
    for (const item of this.journal.read().rows) {
      if (item.automation.customAgentId !== customAgent || !item.automation.enabled || !item.grant) continue
      const key = item.automation.id
      await this.journal
        .change(`rebind:${key}`, 'rebind', async state => {
          const target = this.find(state, key)
          let plan: AutomationPlan
          try {
            this.options.authorize(actor.actor.deviceId, configOf(target.automation))
            plan = this.options.plan(configOf(target.automation))
          } catch {
            this.pause(target, 'agent-unavailable')
            return { value: true }
          }
          const basis = this.basis(configOf(target.automation), plan),
            before = digest(target.grant ?? null)
          await this.options.audit.append({
            action: 'automation.changed',
            actor: actor.actor,
            target: key,
            detail: { operation: 'update', before, after: digest({ deviceId: actor.actor.deviceId, basis }) },
          })
          target.grant = { deviceId: actor.actor.deviceId, basis, persistent: plan.persistent }
          return { value: true }
        })
        .catch(() => {})
    }
    this.options.changed()
  }

  /** Public for deterministic Vitest clocks; production uses the same serialized bounded tick. */
  async tick(): Promise<void> {
    if (this.running || this.closed) return
    this.running = true
    try {
      if (this.journal.hasPending()) {
        await this.journal.recover()
        for (const item of this.journal.read().rows)
          if (item.attempt && !item.attempt.sessionId) await this.markPaused(item, 'unknown-outcome')
      }
      // Settled first, so a run that finished frees its place for a time due now.
      await this.eachRow(this.journal.read().rows, async item => {
        if (item.attempt?.sessionId) await this.settle(item)
      })
      const earliest = [...this.journal.read().rows].sort((a, b) =>
        (a.automation.nextRunAt ?? '').localeCompare(b.automation.nextRunAt ?? ''),
      )
      await this.eachRow(earliest, item => this.check(item))
    } finally {
      this.running = false
    }
  }

  /**
   * Reads each row again before visiting it, since anything awaited on the way can have changed it. A failure stays with
   * its row: the next check asks again and the rows after it still get their turn.
   */
  private async eachRow(rows: readonly Row[], visit: (item: Row) => Promise<void>): Promise<void> {
    for (const { automation } of rows) {
      if (this.closed) return
      const item = this.journal.read().rows.find(candidate => candidate.automation.id === automation.id)
      if (item) await visit(item).catch(() => {})
    }
  }

  private async check(item: Row): Promise<void> {
    if (item.attempt || !item.automation.enabled || item.automation.state !== 'ready' || !item.grant) return
    if (this.editing.has(item.automation.customAgentId ?? '')) return
    const definition = configOf(item.automation)
    let plan: AutomationPlan
    try {
      this.options.authorize(item.grant.deviceId, definition)
      plan = this.options.plan(definition)
    } catch (error) {
      if (passing(error)) return
      await this.markPaused(item, error instanceof AppError && error.status === 403 ? 'owner-unavailable' : 'agent-unavailable')
      return
    }
    if (this.basis(definition, plan) !== item.grant.basis) {
      await this.markPaused(item, 'definition-changed')
      return
    }
    if (item.zone !== this.zone()) {
      await this.journal.change(`zone:${item.automation.id}`, this.zone(), state => {
        this.schedule(this.find(state, item.automation.id))
        return { value: true }
      })
      return
    }
    const due = item.automation.nextRunAt
    if (!due || Date.parse(due) > this.now()) return
    const queued = item.queued === due
    if (!queued && this.now() - Date.parse(due) > MISSED_AFTER_MS) {
      await this.journal.change(`missed:${item.automation.id}`, due, state => {
        this.reportMissed(this.find(state, item.automation.id))
        return { value: true }
      })
      this.options.changed()
      return
    }
    if (this.atLimit(this.journal.read())) {
      if (!queued)
        await this.journal.change(`queued:${item.automation.id}`, due, state => {
          this.find(state, item.automation.id).queued = due
          return { value: true }
        })
      return
    }
    await this.dispatch(item, plan)
  }

  private async dispatch(item: Row, plan: AutomationPlan): Promise<void> {
    const key = item.automation.id,
      slot = item.automation.nextRunAt!,
      requestId = digest(['automation', key, slot]),
      expected = item.grant!.basis,
      deviceId = item.grant!.deviceId,
      authorize = () => {
        const current = this.find(this.journal.read(), key)
        this.options.authorize(deviceId, configOf(current.automation))
        if (!current.automation.enabled || current.grant?.basis !== expected || current.grant.deviceId !== deviceId)
          throw new AppError(409, 'automation-changed', '自动化已关闭或已修改。')
        if (this.basis(configOf(current.automation), this.options.plan(configOf(current.automation))) !== expected)
          throw new AppError(409, 'automation-changed', '自动化的执行配置已改变。')
      }
    let auditing = false
    try {
      await this.journal.change(
        requestId,
        'intent',
        async state => {
          authorize()
          const target = this.find(state, key)
          if (target.attempt || !target.automation.enabled || target.automation.nextRunAt !== slot || target.grant?.basis !== expected)
            throw new AppError(409, 'automation-changed', '自动化已修改。')
          auditing = true
          await this.options.audit.append({
            action: 'automation.ran',
            actor: { listener: 'host' },
            target: key,
            detail: { trigger: 'schedule', attempt: requestId },
          })
          auditing = false
          target.attempt = { requestId }
          delete target.queued
          target.lastDate = scheduleDate(Date.parse(slot), this.zone())
          target.automation.state = 'running'
          delete target.automation.nextRunAt
          this.record(target, { at: slot, state: 'running', trigger: 'schedule' })
          return { value: true }
        },
        authorize,
      )
    } catch (error) {
      if (this.journal.hasPending() || passing(error)) return
      await this.markPaused(
        item,
        auditing ? 'audit-unavailable' : error instanceof AppError && error.status === 403 ? 'owner-unavailable' : 'agent-unavailable',
      )
      return
    }
    this.options.changed()
    await this.startAttempt(this.find(this.journal.read(), key), plan, requestId, authorize)
  }

  private async startAttempt(item: Row, plan: AutomationPlan, requestId: string, authorize: () => void): Promise<void> {
    const key = item.automation.id
    try {
      authorize()
      const created = await this.options.start({
        requestId,
        automationId: key,
        title: item.automation.name,
        prompt: item.automation.prompt,
        ...(item.automation.projectId ? { projectId: item.automation.projectId } : {}),
        plan,
        authorize,
      })
      await this.journal.change(requestId, 'accepted', state => {
        const target = this.find(state, key)
        if (target.attempt?.requestId !== requestId) throw new Error('Attempt changed')
        target.attempt.sessionId = created.sessionId
        this.update(target, { sessionId: created.sessionId })
        return { value: true }
      })
    } catch (error) {
      const refused = passing(error) || (error instanceof AppError && error.status >= 400 && error.status < 500 && error.status !== 408)
      if (!this.journal.hasPending()) {
        if (refused)
          await this.journal.change(requestId, 'refused', state => {
            const target = this.find(state, key)
            if (target.attempt?.requestId !== requestId) return { value: false, changed: false }
            this.update(target, { state: 'failed' })
            delete target.attempt
            if (passing(error)) this.rest(target)
            else this.pause(target, error instanceof AppError && error.status === 403 ? 'owner-unavailable' : 'agent-unavailable')
            return { value: true }
          })
        else await this.markPaused(this.find(this.journal.read(), key), 'unknown-outcome')
      }
    }
    this.options.changed()
  }

  private async settle(item: Row): Promise<void> {
    const key = item.automation.id,
      attempt = item.attempt!
    let detail: TaskDetail | undefined
    try {
      detail = await this.options.detail(attempt.sessionId!)
    } catch (error) {
      // The session was deleted while it ran; anything else may pass, so it is asked again.
      if (!(error instanceof AppError && error.status === 404)) return
    }
    if (detail) {
      const status = detail.summary.status
      if (status === 'waiting-approval' && this.now() - Date.parse(item.automation.lastRun!.at) >= this.options.approvalTtlMs()) {
        await this.options.cancel(detail.summary.id, detail.summary.runId)
        return
      }
      if (status === 'running' || status === 'waiting-approval') {
        const state: AutomationRunState = status === 'running' ? 'running' : 'waiting'
        if (item.automation.lastRun?.state !== state) {
          await this.journal.change(attempt.requestId, state, draft => {
            const target = this.find(draft, key)
            if (target.attempt?.requestId === attempt.requestId) this.update(target, { state })
            return { value: true }
          })
          this.options.changed()
        }
        return
      }
    }
    await this.journal.change(attempt.requestId, 'settled', draft => {
      const target = this.find(draft, key)
      if (target.attempt?.requestId !== attempt.requestId) return { value: false, changed: false }
      const outcome = detail?.summary.runOutcome
      this.update(target, { state: outcome ?? 'unknown' })
      delete target.attempt
      if (detail && (outcome === 'interrupted' || !outcome)) this.pause(target, 'unknown-outcome')
      else this.rest(target)
      return { value: true }
    })
    this.options.changed()
  }

  /** The state an automation returns to once nothing is running. */
  private rest(item: Row): void {
    if (item.automation.enabled) {
      item.automation.state = 'ready'
      this.recordSkipped(item)
      this.schedule(item)
    } else item.automation.state = item.automation.pause ? 'paused' : 'off'
  }
  /** Every time that came and went while this run lasted. It stays `lastRun`, which says how the last real run ended. */
  private recordSkipped(item: Row): void {
    const zone = this.zone(),
      run = item.runs[0]
    const after = (at: number) => nextRun(item.automation.schedule, at, zone, scheduleDate(at, zone))
    let due = item.automation.nextRunAt ?? (run ? after(Date.parse(run.at)) : undefined)
    for (let count = 0; due && Date.parse(due) <= this.now() && count < MAX_RUNS; count++) {
      item.runs = [{ at: due, state: 'skipped' as const, trigger: 'schedule' as const }, ...item.runs].slice(0, MAX_RUNS)
      due = after(Date.parse(due))
    }
  }
  private grant(item: Row, actor: AgentActor): void {
    const definition = configOf(item.automation)
    this.options.authorize(actor.actor.deviceId, definition)
    const plan = this.options.plan(definition)
    item.grant = { deviceId: actor.actor.deviceId, basis: this.basis(definition, plan), persistent: plan.persistent }
    item.automation.enabled = true
    delete item.automation.pause
    if (!item.attempt) {
      item.automation.state = 'ready'
      this.schedule(item)
    }
  }
  private schedule(item: Row): void {
    const zone = this.zone()
    delete item.queued
    item.automation.nextRunAt = nextRun(item.automation.schedule, this.now(), zone, item.lastDate)
    item.zone = zone
  }
  private reportMissed(item: Row): void {
    const due = item.automation.nextRunAt
    if (!due || Date.parse(due) > this.now()) return
    this.record(item, { at: due, state: 'missed', trigger: 'schedule' })
    this.schedule(item)
  }
  private record(item: Row, run: AutomationRun): void {
    item.runs = [run, ...item.runs].slice(0, MAX_RUNS)
    item.automation.lastRun = run
  }
  private update(item: Row, change: Partial<AutomationRun>): void {
    const run = item.runs[0]
    if (!run) return
    Object.assign(run, change)
    item.automation.lastRun = run
  }
  private async markPaused(item: Row, reason: AutomationPauseReason): Promise<void> {
    await this.journal.change(`pause:${item.automation.id}`, reason, state => {
      const target = this.find(state, item.automation.id)
      // Turned off while this was on its way: that is the owner's word, and there is nothing to pause.
      if (!target.automation.enabled && !target.attempt) return { value: false, changed: false }
      this.pause(target, reason)
      return { value: true }
    })
    this.options.changed()
  }
  private pause(item: Row, reason: AutomationPauseReason): void {
    item.automation.enabled = false
    item.automation.state = 'paused'
    item.automation.pause = { reason, message: PAUSE_MESSAGES[reason] }
    delete item.automation.nextRunAt
    delete item.queued
    if (item.attempt && !item.attempt.sessionId) {
      this.update(item, { state: 'unknown' })
      delete item.attempt
    }
  }

  private async mutate(
    operation: 'create' | 'update' | 'delete' | 'run',
    key: string,
    data: { requestId: string },
    actor: AgentActor,
    apply: (state: State) => string,
    lowering = false,
    report?: () => Promise<void>,
  ): Promise<{ id: string; audited: boolean; replay?: true }> {
    actor.authorize()
    if (key) id.parse(key)
    const receiptKey = digest([actor.actor.deviceId, data.requestId]),
      payload = digest([operation, key, data])
    let replay = false
    const result = await this.journal.change(
      receiptKey,
      payload,
      async state => {
        const prior = state.receipts[receiptKey]
        if (prior) {
          if (prior.hash !== payload) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
          replay = true
          return { value: prior, changed: false }
        }
        const before = digest(state.rows.map(item => item.automation)),
          target = apply(state),
          after = digest(state.rows.map(item => item.automation))
        let audited = true
        try {
          if (report) await report()
          else
            await this.options.audit.append({
              action: 'automation.changed',
              actor: actor.actor,
              target,
              detail: { operation: operation === 'run' ? 'update' : operation, before, after },
            })
        } catch (error) {
          if (!lowering) throw error
          audited = false
        }
        const receipt = { hash: payload, id: target, audited }
        state.receipts[receiptKey] = receipt
        const keys = Object.keys(state.receipts)
        for (const old of keys.slice(0, Math.max(0, keys.length - MAX_RECEIPTS))) delete state.receipts[old]
        return { value: receipt }
      },
      actor.authorize,
    )
    this.options.changed()
    return { id: result.id, audited: result.audited, ...(replay ? { replay: true as const } : {}) }
  }

  private basis(definition: AutomationConfig, plan: AutomationPlan): string {
    return digest({
      customAgentId: definition.customAgentId ?? null,
      projectId: definition.projectId ?? null,
      prompt: definition.prompt,
      plan: plan.basis,
    })
  }
  private find(state: State, key: string): Row {
    const found = state.rows.find(item => item.automation.id === key)
    if (!found) throw new AppError(404, 'automation-not-found', '找不到这个自动化。')
    return found
  }
  private revision(value: Automation, expected: number): void {
    if (value.revision !== expected) throw new AppError(409, 'automation-changed', '这项记录已更新，请刷新后再修改。')
  }
  private atLimit(state: State): boolean {
    return state.rows.filter(item => item.attempt).length >= MAX_ATTEMPTS
  }
  private busy(): AppError {
    return new AppError(409, 'automation-running', '请先等待这次运行结束。')
  }
  private zone(): string {
    return (this.options.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone))()
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
