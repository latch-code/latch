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
  AutomationSchedule,
  AutomationSummary,
  ModelRef,
  ScheduleResult,
  ScheduleResultFile,
  ScheduleResultOutcome,
  TaskDetail,
  TaskMode,
} from '@latch/protocol'
import { GENERAL_AGENT_ID } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, type AtomicWriteFs } from '@latch/core/node-kit'
import { AgentJournal } from './agent-journal.ts'
import type { AuditLog } from './audit.ts'
import { CUSTOM_AGENT_ID, type AgentActor } from './custom-agents.ts'
import { nextRun, scheduleDate, scheduleSchema } from './schedule.ts'

const MAX_AUTOMATIONS = 128
/** Real runs kept per schedule; missed and skipped times are kept apart, as many again, newest first. */
const MAX_RUNS = 50
const DAY = 24 * 60 * 60 * 1000
/** How far back a walk over missed times starts: enough for the newest `MAX_RUNS` of them, and never more. */
const LOOKBACK: Record<AutomationSchedule['kind'], number> = { daily: 52 * DAY, weekdays: 75 * DAY, weekly: 52 * 7 * DAY }
const gap = (run: AutomationRun) => run.state === 'missed' || run.state === 'skipped'
/** Newest first: the newest `MAX_RUNS` real runs and, apart from them, the newest `MAX_RUNS` missed or skipped times. */
function trimRuns(runs: AutomationRun[]): AutomationRun[] {
  let real = 0,
    gaps = 0
  return runs.filter(run => (gap(run) ? ++gaps : ++real) <= MAX_RUNS)
}
const MAX_RECEIPTS = 4096
const MAX_ATTEMPTS = 2
/** Ticks (half a second each) a run's card waits for the files observed after it ended. */
const SETTLE_WAITS = 12
/** Result cards kept, over every owner; the oldest go first. */
const MAX_RESULTS = 256
/** Per owner; the oldest of that owner go first. */
const OWNER_RESULTS = 64
export const RESULT_LIMITS = { reply: 2000, files: 20, reason: 300 } as const
/** A scheduled time counts as met only this soon after it; later than that the Mac was off or asleep. */
const MISSED_AFTER_MS = 60_000
/**
 * Says nothing about the automation: a plugin mid-update, an edit that landed first, a write still being confirmed, or
 * the Host about to stop for an update (that run is missed; the automation stays on).
 */
const PASSING = new Set(['plugin-busy', 'automation-changed', 'agent-write-unknown', 'host-updating'])
const passing = (error: unknown) => error instanceof AppError && PASSING.has(error.code)

const rid = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const id = z.string().regex(/^auto_[a-f0-9-]{36}$/u)
const at = z.string().datetime()
const revision = z.number().int().positive().safe()
const schedule = scheduleSchema
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
  /** Saved from this schedule proposal: no other request may save it again. */
  proposalId: z
    .string()
    .regex(/^prp_[a-f0-9-]{36}$/u)
    .optional(),
  /** When it last moved to another Agent or to 通用: its earlier runs stay with the owner they ran for. */
  ownedSince: at.optional(),
  /** Local date of the last scheduled run, so a repeated wall time cannot run twice that day. */
  lastDate: z.string().max(10).optional(),
  /** The time zone `nextRunAt` was worked out in. */
  zone: z.string().max(80).optional(),
  runs: z.array(runSchema).max(2 * MAX_RUNS),
})
const resultFile = z.strictObject({
  root: z.string().min(1).max(128),
  path: z.string().min(1).max(4096),
  change: z.enum(['created', 'modified', 'deleted']),
})
const resultSchema = z.strictObject({
  id: z.string().regex(/^res_[a-f0-9]{40}$/u),
  automationId: id,
  owner: z.union([customAgentId, z.literal(GENERAL_AGENT_ID)]),
  name,
  outcome: z.enum(['completed', 'failed', 'cancelled', 'interrupted', 'unknown']),
  trigger: z.enum(['schedule', 'manual']),
  runAt: at,
  at,
  sessionId: z.string().min(1).max(256).optional(),
  topicId: z.string().min(1).max(256).optional(),
  reply: z.string().max(RESULT_LIMITS.reply).optional(),
  replyTruncated: z.literal(true).optional(),
  files: z.array(resultFile).max(RESULT_LIMITS.files).optional(),
  filesMore: z.number().int().positive().max(1_000_000).optional(),
  failure: z
    .strictObject({
      reason: z.string().max(RESULT_LIMITS.reason),
      code: z
        .string()
        .regex(/^[a-z0-9-]{1,64}$/u)
        .optional(),
    })
    .optional(),
  contentRemoved: z.literal(true).optional(),
})
const stateSchema = z
  .strictObject({
    version: z.literal(1),
    rows: z.array(row).max(MAX_AUTOMATIONS),
    /** Result cards of runs that settled, oldest first: Host records in an Agent's conversation, never messages. */
    results: z.array(resultSchema).max(MAX_RESULTS).default([]),
    receipts: z.record(hash, z.strictObject({ hash, id: z.string().max(64), audited: z.boolean() })),
  })
  .superRefine((state, ctx) => {
    if (new Set(state.rows.map(item => item.automation.id)).size !== state.rows.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate identity' })
    if (new Set(state.results.map(item => item.id)).size !== state.results.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate identity' })
  })
const createSchema = config.extend({
  requestId: rid,
  proposalId: z
    .string()
    .regex(/^prp_[a-f0-9-]{36}$/u)
    .optional(),
})
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
  harnessId: string
  mode: TaskMode
  /** Absent for a Harness that chooses its own model. */
  model?: ModelRef
  agentContext?: AgentExecutionContext
}
/** Clears from cards what they took from deleted sessions, and lets cards of a deleted topic wait for the next. */
function forget(results: ScheduleResult[], ids: ReadonlySet<string>): boolean {
  let changed = false
  for (const item of results) {
    if (item.topicId !== undefined && ids.has(item.topicId)) {
      delete item.topicId
      changed = true
    }
    if (item.sessionId !== undefined && ids.has(item.sessionId) && !item.contentRemoved) {
      delete item.reply
      delete item.replyTruncated
      delete item.files
      delete item.filesMore
      delete item.failure
      item.contentRemoved = true
      changed = true
    }
  }
  return changed
}

/** What the Host reads of a settled run for its result card: where it goes, and what it says. */
export interface ResultContent {
  /** The owner's current topic when the run settled; absent when it had none. */
  topicId?: string
  reply?: string
  replyTruncated?: true
  files?: ScheduleResultFile[]
  filesMore?: number
  failure?: { reason: string; code?: string }
}
/** A run that settled, for the Host to read its result card from. */
export interface SettledRun {
  /** An Agent's ID, or `general`. */
  owner: string
  automationId: string
  outcome: ScheduleResultOutcome
  sessionId?: string
  detail?: TaskDetail
  /** Why a start was refused, when it never became a session. */
  refused?: unknown
}
/** A scheduled run the Host starts as a session. */
export interface AutomationStartInput {
  requestId: string
  automationId: string
  title: string
  prompt: string
  projectId?: string
  plan: AutomationPlan
  authorize: () => void
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
  start(input: AutomationStartInput): Promise<{ sessionId: string }>
  detail(sessionId: string): Promise<TaskDetail>
  cancel(sessionId: string, runId?: string): Promise<unknown>
  approvalTtlMs(): number
  changed(): void
  /**
   * Reads a settled run's result card: the owner's current topic, the start of the last reply, its files and why it did
   * not complete. Without it no card is recorded. A failure here records the card with what is known.
   */
  resultContent?(run: SettledRun): Promise<ResultContent>
  /** Whether a session still exists; rejects when that cannot be told now. Cards of sessions gone are cleared at start. */
  exists?(sessionId: string): Promise<boolean>
  /** A result card was recorded or moved; `topics` are the sessions whose conversations show it. */
  resultsChanged?(topics: string[]): void
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
  /** Sessions deleted since this Host started, so a card written later does not take their content. */
  private readonly gone = new Set<string>()
  /** Deletions not yet written to the cards; tried again on each check. */
  private readonly unforgotten = new Set<string>()
  /** Cards were checked against the sessions that still exist, once after this start. */
  private reconciled = false
  /** Runs that ended while their files were still being observed: how many ticks each has waited. */
  private readonly settling = new Map<string, number>()
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
        { version: 1, rows: [], results: [], receipts: {} },
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

  /** Whether this device's request was answered already, so sending it again replays that answer. */
  answered(deviceId: string, requestId: string): boolean {
    return this.journal.read().receipts[digest([deviceId, requestId])] !== undefined
  }
  /**
   * An owner's schedules with the runs it had (newest first), for its 动态: a schedule that moved here from another owner
   * brings none of the runs made before.
   */
  runsOf(owner: string): Array<{ automation: Automation; runs: AutomationRun[] }> {
    return this.journal
      .read()
      .rows.filter(item => (item.automation.customAgentId ?? GENERAL_AGENT_ID) === owner)
      .map(item => ({
        automation: item.automation,
        runs: item.ownedSince ? item.runs.filter(run => run.at >= item.ownedSince!) : item.runs,
      }))
  }
  /**
   * The times an owner's schedules missed since each one last really ran (a run, or 立即运行), newest first: what the
   * scheduler recorded against its own schedule, never guessed.
   */
  missedOf(owner: string): Array<{ automationId: string; name: string; at: string }> {
    const missed: Array<{ automationId: string; name: string; at: string }> = []
    for (const { automation, runs } of this.runsOf(owner)) {
      // Turned off or paused: nothing is missing it now.
      if (!automation.enabled) continue
      for (const run of runs) {
        if (run.state === 'skipped') continue
        if (run.state !== 'missed') break
        missed.push({ automationId: automation.id, name: automation.name, at: run.at })
      }
    }
    return missed.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_RUNS)
  }
  /**
   * For the desktop app's 「到点前后保持唤醒」: the earliest time a schedule of these owners is due, and how many of their
   * scheduled runs are under way. A run counts only for `holdMs` after its time, so a run that never settles cannot keep
   * the Mac awake. No IDs: the desktop app needs only the times.
   */
  wakeFor(owners: ReadonlySet<string>, holdMs: number): { next?: string; running: number } {
    let next: string | undefined
    let running = 0
    for (const item of this.journal.read().rows) {
      if (!owners.has(item.automation.customAgentId ?? GENERAL_AGENT_ID)) continue
      const due = item.automation.enabled && item.automation.state === 'ready' ? item.automation.nextRunAt : undefined
      if (due && (next === undefined || due < next)) next = due
      const run = item.attempt ? item.runs[0] : undefined
      if (run?.trigger === 'schedule' && this.now() - Date.parse(run.at) < holdMs) running++
    }
    return { ...(next ? { next } : {}), running }
  }
  /** Every result card, oldest first. */
  results(): ScheduleResult[] {
    return this.journal.read().results
  }
  /** An owner's cards: those delivered into `topicId`, or with `null` those still waiting for a topic. */
  resultsOf(owner: string, topicId: string | null): ScheduleResult[] {
    return this.results().filter(item => item.owner === owner && (topicId === null ? item.topicId === undefined : item.topicId === topicId))
  }
  /** The cards shown in a topic's conversation, whoever owns it. */
  resultsIn(topicId: string): ScheduleResult[] {
    return this.results().filter(item => item.topicId === topicId)
  }
  /** For the snapshot: per owner, how many cards wait for a topic and when any last changed. */
  resultStates(): Record<string, { unbound: number; at: string }> {
    const states: Record<string, { unbound: number; at: string }> = {}
    for (const item of this.results()) {
      const state = (states[item.owner] ??= { unbound: 0, at: '' })
      if (item.topicId === undefined) state.unbound++
      if (item.at > state.at) state.at = item.at
    }
    return states
  }

  /**
   * A new topic of the owner keeps the cards that waited for one: they sit before its first message, at the time each
   * run settled. Nothing is sent to the Harness.
   */
  async adoptResults(owner: string, topicId: string): Promise<void> {
    if (!this.results().some(item => item.owner === owner && item.topicId === undefined)) return
    const moved = await this.journal.change(`adopt:${owner}:${topicId}`, digest(['adopt', owner, topicId]), state => {
      let changed = false
      for (const item of state.results)
        if (item.owner === owner && item.topicId === undefined) {
          item.topicId = topicId
          changed = true
        }
      return { value: changed, changed }
    })
    if (moved) this.options.resultsChanged?.([topicId])
  }

  /**
   * A deleted session: the cards of a run it was lose the reply, files and reason they took from it; the cards delivered
   * into a topic it was wait for the owner's next topic.
   */
  async sessionDeleted(sessionId: string): Promise<void> {
    // Known at once, so a card written after this (a run settling now) never takes the session's content.
    this.gone.add(sessionId)
    if (!this.results().some(item => item.sessionId === sessionId || item.topicId === sessionId)) return
    try {
      await this.journal.change(`deleted:${sessionId}`, digest(['deleted', sessionId]), state => {
        const changed = forget(state.results, new Set([sessionId]))
        return { value: changed, changed }
      })
      this.unforgotten.delete(sessionId)
    } catch (error) {
      // Tried again on every check until it is written.
      this.unforgotten.add(sessionId)
      throw error
    }
    this.options.changed()
  }

  /**
   * Cards whose session went while the Host could not write it down (stopped, or the write failed): checked once after
   * a start, and again on each check for a deletion that is still to be written.
   */
  private async reconcile(): Promise<void> {
    if (this.unforgotten.size) {
      const ids = new Set(this.unforgotten)
      await this.journal.change(`deleted:${digest([...ids])}`, digest(['deleted', [...ids]]), state => {
        const changed = forget(state.results, ids)
        return { value: changed, changed }
      })
      for (const id of ids) this.unforgotten.delete(id)
      this.options.changed()
    }
    if (this.reconciled || !this.options.exists) return
    const ids = new Set(this.results().flatMap(item => [...(item.contentRemoved ? [] : [item.sessionId ?? '']), item.topicId ?? '']))
    ids.delete('')
    const missing = new Set<string>()
    for (const id of ids) if (!(await this.options.exists(id))) missing.add(id)
    if (missing.size) {
      for (const id of missing) this.gone.add(id)
      await this.journal.change(`reconciled:${digest([...missing])}`, digest(['deleted', [...missing]]), state => {
        const changed = forget(state.results, missing)
        return { value: changed, changed }
      })
      this.options.changed()
    }
    this.reconciled = true
  }
  /** Finishes a write whose result was left unknown, so a read does not stay refused until that request is retried. */
  recover(): Promise<void> {
    return this.journal.recover()
  }

  async create(input: AutomationCreate, actor: AgentActor): Promise<{ value: Automation; audited: boolean }> {
    const data = createSchema.parse(input)
    const { requestId: _, proposalId: __, ...definition } = data
    const result = await this.mutate('create', '', data, actor, state => {
      // A proposal saves one schedule. Checked in the same write as the create: two saves at once, or a save after one
      // whose proposal mark failed, find the first and create nothing. A retry of the same request replays its receipt.
      const saved = data.proposalId ? state.rows.find(row => row.proposalId === data.proposalId) : undefined
      if (saved) throw new AppError(409, 'agent-proposal-decided', '这条提议已经保存过了。', { automationId: saved.automation.id })
      if (state.rows.length >= MAX_AUTOMATIONS) throw new AppError(409, 'automation-limit', `最多保存 ${MAX_AUTOMATIONS} 个定时任务。`)
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
        item: Row = { automation: value, runs: [], ...(data.proposalId ? { proposalId: data.proposalId } : {}) }
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
      if ((next.customAgentId ?? null) !== (old.customAgentId ?? null)) item.ownedSince = this.stamp()
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
        if (this.atLimit(state))
          throw new AppError(409, 'automation-limit-running', `已有 ${MAX_ATTEMPTS} 个定时任务在运行，请等它们结束。`)
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
  async edit<T>(customAgent: string | undefined, actor: AgentActor, save: () => Promise<T>, definition?: () => string): Promise<T> {
    const owner = customAgent ?? ''
    // The grant follows `definitionHash`, which is part of every run's basis. A change outside it (a name, a description, an
    // avatar) keeps the basis, so it neither moves the grant to the editor nor pauses the schedule; a new name still shows
    // in later runs' first turn, which names the Agent. Unreadable before or after (a deletion, a write still unconfirmed)
    // rebinds as before.
    const hash = () => {
      try {
        return definition?.()
      } catch {
        return undefined
      }
    }
    const before = hash()
    this.editing.set(owner, (this.editing.get(owner) ?? 0) + 1)
    try {
      const saved = await save()
      const after = hash()
      if (before === undefined || after === undefined || before !== after) await this.rebind(customAgent, actor)
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
      // Asked again next time when the sessions cannot be read yet.
      await this.reconcile().catch(() => {})
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
          throw new AppError(409, 'automation-changed', '定时任务已关闭或已修改。')
        if (this.basis(configOf(current.automation), this.options.plan(configOf(current.automation))) !== expected)
          throw new AppError(409, 'automation-changed', '定时任务的执行配置已改变。')
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
            throw new AppError(409, 'automation-changed', '定时任务已修改。')
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
        const missed = error instanceof AppError && error.code === 'host-updating'
        // A start refused is a run that failed: its card says why. A missed time is not a run.
        const held = this.journal.read().rows.find(row => row.automation.id === key)
        const card =
          refused && !missed && held?.attempt?.requestId === requestId ? await this.card(held, 'failed', { refused: error }) : undefined
        if (refused)
          await this.journal.change(requestId, 'refused', state => {
            const target = this.find(state, key)
            if (target.attempt?.requestId !== requestId) return { value: false, changed: false }
            this.update(target, { state: missed ? 'missed' : 'failed' })
            delete target.attempt
            if (passing(error)) this.rest(target)
            else this.pause(target, error instanceof AppError && error.status === 403 ? 'owner-unavailable' : 'agent-unavailable')
            this.deliver(state, card)
            return { value: true }
          })
        else await this.markPaused(this.find(this.journal.read(), key), 'unknown-outcome')
        if (card?.topicId) this.options.resultsChanged?.([card.topicId])
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
    // The run's files are still being observed for a moment after it ends: its card waits for them, a few ticks at most.
    if (this.options.resultContent && detail?.messages.some(message => message.outputsPending)) {
      const waited = this.settling.get(attempt.requestId) ?? 0
      if (waited < SETTLE_WAITS) {
        this.settling.set(attempt.requestId, waited + 1)
        return
      }
    }
    this.settling.delete(attempt.requestId)
    const outcome = detail?.summary.runOutcome
    const card = await this.card(item, outcome ?? 'unknown', { sessionId: attempt.sessionId!, ...(detail ? { detail } : {}) })
    await this.journal.change(attempt.requestId, 'settled', draft => {
      const target = this.find(draft, key)
      if (target.attempt?.requestId !== attempt.requestId) return { value: false, changed: false }
      this.update(target, { state: outcome ?? 'unknown' })
      delete target.attempt
      if (detail && (outcome === 'interrupted' || !outcome)) this.pause(target, 'unknown-outcome')
      else this.rest(target)
      this.deliver(draft, card)
      return { value: true }
    })
    this.options.changed()
    if (card?.topicId) this.options.resultsChanged?.([card.topicId])
  }

  /**
   * The result card of the attempt `item` is running now: its ID comes from the attempt, so the same run settling again
   * after a restart is recorded once. Undefined when the Host reads none.
   */
  private async card(
    item: Row,
    outcome: ScheduleResultOutcome,
    run: { sessionId?: string; detail?: TaskDetail; refused?: unknown },
  ): Promise<ScheduleResult | undefined> {
    const read = this.options.resultContent,
      attempt = item.attempt,
      last = item.runs[0]
    if (!read || !attempt || !last) return undefined
    const owner = item.automation.customAgentId ?? GENERAL_AGENT_ID
    let content: ResultContent = {}
    try {
      content = await read({ owner, automationId: item.automation.id, outcome, ...run })
    } catch {
      // The card still says how the run ended and links to it.
    }
    return {
      id: `res_${digest(['result', item.automation.id, attempt.requestId]).slice(0, 40)}`,
      automationId: item.automation.id,
      owner,
      name: item.automation.name,
      outcome,
      trigger: last.trigger,
      runAt: last.at,
      at: this.stamp(),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...content,
    }
  }
  /** Keeps a card once, by its ID; the oldest go first past the limit. */
  private deliver(state: State, card: ScheduleResult | undefined): void {
    if (!card || state.results.some(existing => existing.id === card.id)) return
    const parsed = resultSchema.safeParse(card)
    if (!parsed.success) return
    // A session deleted since its content was read: checked in the same write that keeps the card.
    forget([parsed.data], this.gone)
    state.results.push(parsed.data)
    // Each owner keeps its newest; the oldest go first, of the owner and then overall.
    const owned = state.results.filter(item => item.owner === parsed.data.owner)
    for (const old of owned.slice(0, Math.max(0, owned.length - OWNER_RESULTS))) state.results.splice(state.results.indexOf(old), 1)
    if (state.results.length > MAX_RESULTS) state.results.splice(0, state.results.length - MAX_RESULTS)
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
    const due = item.automation.nextRunAt ?? (run ? after(Date.parse(run.at)) : undefined)
    if (!due) return
    for (const at of this.dueTimes(item, due))
      item.runs = trimRuns([{ at, state: 'skipped' as const, trigger: 'schedule' as const }, ...item.runs])
  }
  /**
   * The schedule's own times from `first` up to now, oldest first, at most the newest `MAX_RUNS`. The walk starts no
   * further back than those need, so a Mac off for a year costs no more than one off for two months.
   */
  private dueTimes(item: Row, first: string): string[] {
    const zone = this.zone(),
      schedule = item.automation.schedule,
      floor = this.now() - LOOKBACK[schedule.kind]
    const times: string[] = []
    let at: string | undefined = Date.parse(first) >= floor ? first : nextRun(schedule, floor, zone)
    while (at && Date.parse(at) <= this.now()) {
      times.push(at)
      if (times.length > MAX_RUNS) times.shift()
      const after = Date.parse(at)
      at = nextRun(schedule, after, zone, scheduleDate(after, zone))
    }
    return times
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
  /**
   * Every scheduled time that came and went with no run, from the schedule itself: a Mac asleep for three days misses
   * three daily times, each recorded once (at most the run history), none caught up. A time due within the last minute
   * still runs.
   */
  private reportMissed(item: Row): void {
    const due = item.automation.nextRunAt
    if (!due || Date.parse(due) > this.now()) return
    const times = this.dueTimes(item, due)
    const last = times.at(-1)
    // The time due within the last minute, past the one that was missed, still runs.
    const runnable = last !== undefined && last !== due && this.now() - Date.parse(last) <= MISSED_AFTER_MS ? times.pop() : undefined
    for (const at of times) this.record(item, { at, state: 'missed', trigger: 'schedule' })
    if (runnable) {
      delete item.queued
      item.automation.nextRunAt = runnable
      item.zone = this.zone()
    } else this.schedule(item)
  }
  private record(item: Row, run: AutomationRun): void {
    item.runs = trimRuns([run, ...item.runs])
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
    if (!found) throw new AppError(404, 'automation-not-found', '找不到这个定时任务。')
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
