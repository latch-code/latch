import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type {
  PersonalGroup,
  PersonalGroupConfig,
  PersonalGroupCreate,
  PersonalGroupPatch,
  PersonalGroupInput,
  PersonalGroupCancel,
  PersonalGroupMessage,
  PersonalGroupTurn,
  PersonalGroupDetail,
  TaskDetail,
  TaskSummary,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, type AtomicWriteFs } from '@latch/core/node-kit'
import type { AuditLog } from './audit.ts'
import type { PersonalActor } from './personal-store.ts'
import type { RoutinePlan } from './personal-routines.ts'
import { PersonalJournal } from './personal-journal.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/u),
  rid = z.uuid(),
  stamp = z.string().datetime(),
  aid = z.string().regex(/^asst_[a-f0-9-]{36}$/u),
  gid = z.string().regex(/^grp_[a-f0-9-]{36}$/u),
  revision = z.number().int().positive().safe(),
  config = z.strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(value => !/[\p{Cc}\p{Cf}]/u.test(value)),
    memberIds: z
      .array(aid)
      .min(1)
      .max(8)
      .refine(value => new Set(value).size === value.length),
    defaultAssistantId: aid,
    instructions: z.string().max(8000),
    maxRelays: z.number().int().min(0).max(3),
  }),
  group = config.extend({ id: gid, revision, createdAt: stamp, updatedAt: stamp }),
  message = z.strictObject({
    id: z.uuid(),
    requestId: rid.optional(),
    role: z.enum(['user', 'assistant', 'system']),
    text: z.string().max(17000),
    assistantId: aid.optional(),
    sessionId: z.string().max(256).optional(),
    createdAt: stamp,
    state: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  }),
  turn = z.strictObject({
    reason: z.enum(['definition-changed', 'owner-unavailable', 'unknown-outcome', 'host-restarted', 'storage-unavailable']).optional(),
    id: z.uuid(),
    state: z.enum(['running', 'waiting-approval', 'completed', 'failed', 'cancelled', 'interrupted']),
    assistantIds: z.array(aid).min(1).max(4),
    sessionIds: z.array(z.string().max(256)).max(4),
    currentAssistantId: aid.optional(),
    createdAt: stamp,
  }),
  record = z.strictObject({
    group,
    messages: z.array(message).max(512),
    turn: turn.optional(),
    stopping: z.boolean().optional(),
    bases: z.array(hash).max(4).optional(),
  }),
  receipt = z.strictObject({
    hash,
    id: gid,
    turnId: z.uuid().optional(),
    audited: z.boolean(),
    finalState: z.enum(['running', 'waiting-approval', 'completed', 'failed', 'cancelled', 'interrupted']).optional(),
  }),
  stateSchema = z
    .strictObject({ version: z.literal(1), groups: z.array(record).max(32), receipts: z.record(hash, receipt) })
    .superRefine((state, ctx) => {
      if (
        Object.keys(state.receipts).length > 10000
        || new Set(state.groups.map(row => row.group.id)).size !== state.groups.length
        || Buffer.byteLength(JSON.stringify(state.groups.map(row => row.group))) > 256 * 1024
      )
        ctx.addIssue({ code: 'custom', message: 'Capacity or identity' })
      for (const row of state.groups) {
        if (
          Buffer.byteLength(JSON.stringify(row.messages)) > 192 * 1024
          || new Set(row.messages.map(message => message.id)).size !== row.messages.length
        )
          ctx.addIssue({ code: 'custom', message: 'Message capacity or identity' })
        if (row.turn && ['running', 'waiting-approval'].includes(row.turn.state) && row.bases?.length !== row.turn.assistantIds.length)
          ctx.addIssue({ code: 'custom', message: 'Missing frozen participants' })
      }
    }),
  create = config.extend({ requestId: rid }),
  patch = config.partial().extend({ requestId: rid, baseRevision: revision }),
  input = z.strictObject({
    requestId: rid,
    prompt: z
      .string()
      .min(1)
      .max(16000)
      .refine(value => value.trim().length > 0),
    assistantIds: z.array(aid).min(1).max(4).optional(),
  }),
  cancel = z.strictObject({ requestId: rid, turnId: z.uuid() })
type State = z.infer<typeof stateSchema>
type Record = z.infer<typeof record>
interface Flight {
  groupId: string
  stop: boolean
  sessionId?: string
  done: Promise<void>
  finish(): void
}
interface Options {
  dataDir: string
  atomicFs?: AtomicWriteFs
  audit: Pick<AuditLog, 'append'>
  now?: () => number
  plan(group: PersonalGroup, assistantId: string, history: PersonalGroupMessage[]): RoutinePlan
  start(input: { requestId: string; prompt: string; plan: RoutinePlan; authorize: () => void }): Promise<{ sessionId: string }>
  detail(sessionId: string): Promise<TaskDetail>
  sessions(): Promise<TaskSummary[]>
  cancel(sessionId: string, runId?: string): Promise<unknown>
  changed(): void
}
const digest = (value: unknown) => sha256Hex(canonicalJson(value)),
  active = (turn?: PersonalGroupTurn) => turn?.state === 'running' || turn?.state === 'waiting-approval'

/** Explicit bounded turns only. Every member is an ordinary Harness session, not another model loop. */
export class PersonalGroups {
  private readonly flights = new Map<string, Flight>()
  private readonly identities = new Map<string, string>()
  private readonly intentPins = new Map<string, { hash: string; references: number }>()
  private readonly devicePins = new Map<string, number>()
  private pinCount = 0
  private submissions = 0
  private closed = false
  private constructor(
    private readonly options: Options,
    private readonly journal: PersonalJournal<State>,
  ) {
    for (const [key, value] of Object.entries(journal.read().receipts)) this.identities.set(key, value.hash)
  }
  static async open(options: Options): Promise<PersonalGroups> {
    const journal = await PersonalJournal.open(
        options.dataDir,
        'groups.json',
        stateSchema,
        { version: 1, groups: [], receipts: {} },
        { atomicFs: options.atomicFs },
      ),
      service = new PersonalGroups(options, journal)
    await journal.change('startup', 'startup', state => {
      for (const row of state.groups)
        if (active(row.turn)) {
          row.turn!.state = 'interrupted'
          row.turn!.reason = 'host-restarted'
          delete row.turn!.currentAssistantId
          delete row.stopping
        }
      return { value: true }
    })
    return service
  }
  list(): PersonalGroup[] {
    return this.journal.read().groups.map(row => row.group)
  }
  async detail(id: string, actor: PersonalActor): Promise<PersonalGroupDetail> {
    actor.authorize()
    const sessions = await this.options.sessions()
    actor.authorize()
    const row = this.find(this.journal.read(), id)
    return {
      group: row.group,
      messages: row.messages,
      ...(row.turn ? { turn: row.turn } : {}),
      sessions: sessions
        .filter(task => task.personal?.groupId === id)
        .sort(
          (a, b) =>
            Number(row.turn?.sessionIds.includes(b.id)) - Number(row.turn?.sessionIds.includes(a.id))
            || b.updatedAt.localeCompare(a.updatedAt),
        )
        .slice(0, 64),
    }
  }
  async create(value: PersonalGroupCreate, actor: PersonalActor): Promise<PersonalGroup> {
    actor.authorize()
    const data = create.parse(value)
    const saved = await this.mutation('create', '', data, actor, state => {
      this.validate(data)
      if (state.groups.length >= 32) throw new AppError(409, 'personal-group-limit', '最多保存 32 个助手群聊。')
      const { requestId: _, ...definition } = data,
        at = this.stamp(),
        id = `grp_${randomUUID()}`
      state.groups.push({ group: { ...definition, id, revision: 1, createdAt: at, updatedAt: at }, messages: [] })
      return { id }
    })
    return this.find(this.journal.read(), saved.id).group
  }
  async patch(id: string, value: PersonalGroupPatch, actor: PersonalActor): Promise<PersonalGroup> {
    const data = patch.parse(value),
      saved = await this.mutation('update', id, data, actor, state => {
        const row = this.find(state, id)
        if (row.group.revision !== data.baseRevision) throw new AppError(409, 'personal-changed', '群聊已更新，请刷新后再修改。')
        const { requestId: _, baseRevision: __, ...changes } = data,
          next = { ...row.group, ...changes, revision: row.group.revision + 1, updatedAt: this.stamp() }
        this.validate(next)
        if (active(row.turn) && digest(this.execution(row.group)) !== digest(this.execution(next)))
          throw new AppError(409, 'personal-group-running', '接力进行中，请先等待或停止当前轮次。')
        row.group = next
        return { id }
      })
    return this.find(this.journal.read(), saved.id).group
  }
  async remove(id: string, requestId: string, actor: PersonalActor): Promise<{ deleted: true }> {
    rid.parse(requestId)
    await this.mutation(
      'delete',
      id,
      { requestId },
      actor,
      state => {
        if (active(this.find(state, id).turn)) throw new AppError(409, 'personal-group-running', '请先停止当前轮次。')
        state.groups = state.groups.filter(row => row.group.id !== id)
        return { id }
      },
      true,
    )
    return { deleted: true }
  }
  async submit(id: string, value: PersonalGroupInput, actor: PersonalActor): Promise<{ accepted: true; turnId: string }> {
    if (this.closed) throw new AppError(503, 'host-closing', '电脑正在停止，请稍后重试。')
    this.submissions++
    try {
      return await this.submitAccepted(id, value, actor)
    } finally {
      this.submissions--
    }
  }
  private async submitAccepted(id: string, value: PersonalGroupInput, actor: PersonalActor): Promise<{ accepted: true; turnId: string }> {
    const data = input.parse(value)
    let fresh = false
    const saved = await this.mutation('start', id, data, actor, state => {
      const row = this.find(state, id)
      if (active(row.turn)) throw new AppError(409, 'personal-group-running', '请等当前轮次结束，或先停止。')
      if (state.groups.filter(row => active(row.turn)).length >= 4)
        throw new AppError(409, 'personal-group-busy', '正在进行的群聊已满，请稍后发送。')
      const ids = data.assistantIds ?? [row.group.defaultAssistantId]
      if (ids.length > row.group.maxRelays + 1 || ids.some(id => !row.group.memberIds.includes(id)))
        throw new AppError(400, 'personal-group-members', '请选择群聊中的成员，并遵守已保存的接力上限。')
      const bases = ids.map(id => this.options.plan(row.group, id, row.messages).basis),
        turnId = randomUUID(),
        at = this.stamp()
      row.turn = { id: turnId, state: 'running', assistantIds: ids, sessionIds: [], createdAt: at }
      row.bases = bases
      delete row.stopping
      const message: PersonalGroupMessage = {
        id: randomUUID(),
        requestId: data.requestId,
        role: 'user',
        text: data.prompt,
        createdAt: at,
        state: 'completed',
      }
      if (
        row.messages.length + 1 + ids.length > 512
        || Buffer.byteLength(JSON.stringify([...row.messages, message])) + ids.length * 17000 > 192 * 1024
      )
        throw new AppError(409, 'personal-group-history-full', '这个群聊的记录已满，请新建群聊继续；原有内容会保留。')
      row.messages.push(message)
      this.trim(row)
      fresh = true
      return { id, turnId }
    })
    if (fresh) {
      let finish!: () => void
      const flight: Flight = {
        groupId: id,
        stop: false,
        done: new Promise(resolve => {
          finish = resolve
        }),
        finish: () => finish(),
      }
      this.flights.set(saved.turnId!, flight)
      void this.drive(id, saved.turnId!, data.prompt, actor, flight)
        .finally(() => {
          this.flights.delete(saved.turnId!)
          flight.finish()
        })
        .catch(() => {})
    } else if (saved.turnId && !this.flights.has(saved.turnId)) {
      const row = this.find(this.journal.read(), id)
      if (row.turn?.id === saved.turnId && active(row.turn)) await this.end(id, saved.turnId, 'interrupted', 'unknown-outcome')
    }
    return { accepted: true, turnId: saved.turnId! }
  }
  /** No group body is returned. A late turn ID can never stop a newer round. */
  async cancel(
    id: string,
    value: PersonalGroupCancel,
    actor: PersonalActor,
  ): Promise<{ accepted: true; turnId: string; state: PersonalGroupTurn['state'] }> {
    const data = cancel.parse(value)
    actor.authorize()
    const release = this.pin('update', id, data, actor)
    try {
      return await this.cancelPinned(id, data, actor)
    } finally {
      release()
    }
  }
  private async cancelPinned(
    id: string,
    data: PersonalGroupCancel,
    actor: PersonalActor,
  ): Promise<{ accepted: true; turnId: string; state: PersonalGroupTurn['state'] }> {
    const key = digest([actor.actor.deviceId, data.requestId]),
      expected = digest(['update', id, data]),
      known = this.identities.get(key)
    if (known && known !== expected) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
    const flight = this.flights.get(data.turnId)
    if (flight && flight.groupId !== id) throw new AppError(409, 'personal-group-turn-changed', '这个群聊轮次已改变。')
    if (flight) flight.stop = true
    if (this.journal.hasPending()) {
      if (flight?.sessionId) await this.options.cancel(flight.sessionId)
      await this.journal.recover()
    }
    const persisted = this.journal.read(),
      prior = persisted.receipts[key]
    if (prior) {
      if (prior.hash !== expected) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
      if (prior.finalState) return { accepted: true, turnId: data.turnId, state: prior.finalState }
    }
    const initial = this.find(persisted, id)
    if (initial.turn?.id !== data.turnId) throw new AppError(409, 'personal-group-turn-changed', '这个群聊轮次已结束或改变。')
    let failure: unknown
    try {
      await this.mutation(
        'update',
        id,
        data,
        actor,
        state => {
          const row = this.find(state, id)
          if (row.turn?.id !== data.turnId) throw new AppError(409, 'personal-group-turn-changed', '这个群聊轮次已改变。')
          row.stopping = true
          return { id, turnId: data.turnId }
        },
        true,
      )
    } catch (error) {
      failure = error
    }
    if (flight?.sessionId) {
      const detail = await this.options.detail(flight.sessionId)
      await this.options.cancel(flight.sessionId, detail.summary.runId)
    }
    if (flight) await flight.done
    else if (active(initial.turn)) {
      const sessionId = initial.turn?.sessionIds.at(-1)
      if (sessionId) {
        const detail = await this.options.detail(sessionId)
        await this.options.cancel(sessionId, detail.summary.runId)
      }
      await this.end(id, data.turnId, 'cancelled')
    }
    if (failure) throw failure
    actor.authorize()
    const state = this.find(this.journal.read(), id).turn?.state ?? 'interrupted'
    await this.journal.change(
      `${key}:settled`,
      expected,
      draft => {
        const receipt = draft.receipts[key]
        if (receipt) receipt.finalState = state
        return { value: true }
      },
      actor.authorize,
    )
    return { accepted: true, turnId: data.turnId, state }
  }
  private async drive(id: string, turnId: string, prompt: string, actor: PersonalActor, flight: Flight): Promise<void> {
    try {
      const initial = this.find(this.journal.read(), id),
        ids = initial.turn!.assistantIds
      for (const [index, assistantId] of ids.entries()) {
        const authorize = () => {
          actor.authorize()
          const row = this.find(this.journal.read(), id)
          if (this.closed || flight.stop || row.stopping || row.turn?.id !== turnId)
            throw new AppError(409, 'personal-group-stopped', '接力已停止。')
          if (ids.some((member, index) => this.options.plan(row.group, member, []).basis !== initial.bases![index]))
            throw new AppError(409, 'personal-group-changed', '成员的执行配置已改变，接力已暂停。')
        }
        authorize()
        const row = this.find(this.journal.read(), id),
          lastUser = row.messages.findLast(message => message.role === 'user'),
          history = row.messages.filter(message =>
            message.role === 'user'
              ? index > 0 || message.id !== lastUser?.id
              : message.role === 'assistant' && message.state === 'completed',
          ),
          plan = this.options.plan(row.group, assistantId, history),
          requestId = digest(['personal-group', turnId, index])
        await this.internal(
          id,
          turnId,
          `intent:${index}`,
          row => {
            row.turn!.currentAssistantId = assistantId
            return true
          },
          authorize,
        )
        const created = await this.options.start({
          requestId,
          prompt: index === 0 ? prompt : '请继续本轮群聊中用户明确提出的任务，参考以上共享讨论。',
          plan,
          authorize,
        })
        flight.sessionId = created.sessionId
        await this.internal(id, turnId, `accepted:${index}`, row => {
          row.turn!.sessionIds.push(created.sessionId)
          return true
        })
        if (flight.stop || this.closed) await this.options.cancel(created.sessionId)
        const detail = await this.wait(created.sessionId, id, turnId, flight)
        await this.internal(id, turnId, `result:${index}`, row => {
          const state = detail.summary.runOutcome ?? 'interrupted'
          const text = this.answer(detail)
          if (text)
            row.messages.push({
              id: randomUUID(),
              role: 'assistant',
              text,
              assistantId,
              sessionId: created.sessionId,
              createdAt: this.stamp(),
              state,
            })
          this.trim(row)
          return true
        })
        flight.sessionId = undefined
        if (flight.stop || this.closed) {
          await this.end(id, turnId, 'cancelled')
          return
        }
        if (detail.summary.runOutcome !== 'completed') {
          await this.end(
            id,
            turnId,
            detail.summary.runOutcome === 'cancelled' ? 'cancelled' : detail.summary.runOutcome === 'failed' ? 'failed' : 'interrupted',
          )
          return
        }
      }
      await this.end(id, turnId, 'completed')
    } catch (error) {
      try {
        if (this.journal.hasPending()) await this.journal.recover()
        const code = error instanceof AppError ? error.code : ''
        const reason: PersonalGroupTurn['reason'] = this.closed
          ? 'host-restarted'
          : ['personal-group-changed', 'plugin-revision-changed', 'personal-not-found', 'personal-group-member-unavailable'].includes(code)
            ? 'definition-changed'
            : ['native-verification-required', 'scope-required', 'personal-scope-required', 'unauthorized', 'device-revoked'].includes(code)
              ? 'owner-unavailable'
              : code.includes('write-unknown')
                ? 'storage-unavailable'
                : 'unknown-outcome'
        await this.end(id, turnId, 'interrupted', reason)
      } catch {
        /* Unknown storage outcomes remain blocked; never continue the next member. */
      }
    }
  }
  private async wait(sessionId: string, id: string, turnId: string, flight: Flight): Promise<TaskDetail> {
    while (true) {
      const detail = await this.options.detail(sessionId)
      if (!['running', 'waiting-approval'].includes(detail.summary.status)) return detail
      if (flight.stop || this.closed) {
        await this.options.cancel(sessionId, detail.summary.runId)
        continue
      }
      const state = detail.summary.status === 'waiting-approval' ? 'waiting-approval' : 'running'
      if (this.find(this.journal.read(), id).turn?.state !== state)
        await this.internal(id, turnId, `status:${state}`, row => {
          row.turn!.state = state
          return true
        })
      await delay(100)
    }
  }
  private async end(id: string, turnId: string, state: PersonalGroupTurn['state'], reason?: PersonalGroupTurn['reason']): Promise<void> {
    await this.internal(id, turnId, `end:${state}`, row => {
      row.turn!.state = state
      if (reason) row.turn!.reason = reason
      else delete row.turn!.reason
      delete row.turn!.currentAssistantId
      delete row.stopping
      return true
    })
  }
  private async internal(
    id: string,
    turnId: string,
    phase: string,
    apply: (row: Record) => boolean,
    authorize: () => void = () => {},
  ): Promise<void> {
    await this.journal.change(
      `${turnId}:${phase}`,
      phase,
      state => {
        const row = this.find(state, id)
        if (row.turn?.id !== turnId) throw new AppError(409, 'personal-group-turn-changed', '群聊轮次已改变。')
        return { value: apply(row) }
      },
      authorize,
    )
    this.options.changed()
  }
  private async mutation(
    operation: 'create' | 'update' | 'delete' | 'start',
    id: string,
    data: { requestId: string },
    actor: PersonalActor,
    apply: (state: State) => { id: string; turnId?: string },
    lowering = false,
  ): Promise<{ id: string; turnId?: string }> {
    actor.authorize()
    const release = this.pin(operation, id, data, actor)
    try {
      return await this.mutationPinned(operation, id, data, actor, apply, lowering)
    } finally {
      release()
    }
  }
  private async mutationPinned(
    operation: 'create' | 'update' | 'delete' | 'start',
    id: string,
    data: { requestId: string },
    actor: PersonalActor,
    apply: (state: State) => { id: string; turnId?: string },
    lowering: boolean,
  ): Promise<{ id: string; turnId?: string }> {
    const key = digest([actor.actor.deviceId, data.requestId]),
      hash = digest([operation, id, data])
    if (this.identities.has(key) && this.identities.get(key) !== hash)
      throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
    const saved = await this.journal.change(
      key,
      hash,
      async state => {
        const prior = state.receipts[key]
        if (prior) {
          if (prior.hash !== hash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
          return { value: prior, changed: false }
        }
        if (Object.keys(state.receipts).length >= 10000 && !lowering)
          throw new AppError(409, 'personal-receipt-limit', '群聊请求回执已满，请先整理记录。')
        const before = digest(state.groups),
          target = apply(state),
          after = digest(state.groups)
        let audited = true
        try {
          await this.options.audit.append({
            action: 'personal.changed',
            actor: actor.actor,
            target: target.id,
            detail: { kind: 'group', operation, before, after },
          })
        } catch (error) {
          if (!lowering) throw error
          audited = false
        }
        const result = { ...target, hash, audited }
        if (Object.keys(state.receipts).length < 10000) {
          state.receipts[key] = result
          this.identities.set(key, hash)
        }
        return { value: result }
      },
      actor.authorize,
    )
    if (!saved.audited) actor.auditFailed?.()
    this.options.changed()
    return saved
  }
  /** A queued/auditing mutation already owns its RID, before any cancel can reduce a different turn with it. */
  private pin(operation: string, id: string, data: { requestId: string }, actor: PersonalActor): () => void {
    if (this.closed) throw new AppError(503, 'host-closing', '电脑正在停止，请稍后重试。')
    const device = actor.actor.deviceId,
      key = digest([device, data.requestId]),
      hash = digest([operation, id, data]),
      known = this.identities.get(key),
      current = this.intentPins.get(key)
    if ((known && known !== hash) || (current && current.hash !== hash))
      throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
    if (this.pinCount >= 256 || (this.devicePins.get(device) ?? 0) >= 32)
      throw new AppError(429, 'personal-group-busy', '正在处理的群聊请求较多，请稍后重试原请求。')
    const pin = current ?? { hash, references: 0 }
    pin.references++
    this.pinCount++
    this.intentPins.set(key, pin)
    this.devicePins.set(device, (this.devicePins.get(device) ?? 0) + 1)
    return () => {
      this.pinCount--
      const left = (this.devicePins.get(device) ?? 1) - 1
      if (left) this.devicePins.set(device, left)
      else this.devicePins.delete(device)
      pin.references--
      if (!pin.references && this.intentPins.get(key) === pin) this.intentPins.delete(key)
    }
  }
  private validate(group: PersonalGroupConfig): void {
    if (!group.memberIds.includes(group.defaultAssistantId))
      throw new AppError(400, 'personal-group-members', '默认回复助手必须在群成员中。')
    const temporary: PersonalGroup = { ...group, id: `grp_${randomUUID()}`, revision: 1, createdAt: this.stamp(), updatedAt: this.stamp() }
    for (const id of group.memberIds) this.options.plan(temporary, id, [])
  }
  private execution(group: PersonalGroup): unknown {
    return {
      memberIds: group.memberIds,
      defaultAssistantId: group.defaultAssistantId,
      instructions: group.instructions,
      maxRelays: group.maxRelays,
    }
  }
  private answer(detail: TaskDetail): string {
    let text = '',
      truncated = false
    for (const message of detail.messages)
      if (message.role === 'assistant') {
        const remaining = 16000 - text.length
        text += (text ? '\n\n' : '') + message.text.slice(0, Math.max(0, remaining))
        if (message.text.length > remaining) {
          truncated = true
          break
        }
      }
    let bounded = '',
      bytes = 0
    for (const point of text) {
      const size = Buffer.byteLength(JSON.stringify(point)) - 2
      if (bytes + size > 15000) {
        truncated = true
        break
      }
      bounded += point
      bytes += size
    }
    return bounded + (truncated ? '\n\n（群聊显示已截断，完整内容请打开该会话。）' : '')
  }
  private trim(row: Record): void {
    if (row.messages.length > 512 || Buffer.byteLength(JSON.stringify(row.messages)) > 192 * 1024)
      throw new AppError(409, 'personal-group-history-full', '群聊记录已达到容量，原内容已保留。')
  }
  private find(state: State, id: string): Record {
    const row = state.groups.find(row => row.group.id === id)
    if (!row) throw new AppError(404, 'personal-group-not-found', '找不到这个助手群聊。')
    return row
  }
  private stamp(): string {
    return new Date((this.options.now ?? Date.now)()).toISOString()
  }
  async close(): Promise<void> {
    this.closed = true
    for (const flight of this.flights.values()) flight.stop = true
    while (this.submissions) await delay(10)
    const flights = [...this.flights.values()]
    for (const flight of flights) {
      flight.stop = true
      if (flight.sessionId) await this.options.cancel(flight.sessionId).catch(() => {})
    }
    await Promise.all(flights.map(flight => flight.done))
    while (this.pinCount) await delay(10)
    await this.journal.close()
  }
}
