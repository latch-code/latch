import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  AGENT_BRACKETS,
  AGENT_EYES,
  AGENT_HUES,
  GENERAL_AGENT_ID,
  type AgentAvatar,
  type AgentBrief,
  type AgentExecutionContext,
  type AgentMemory,
  type AgentMemoryChange,
  type AgentMemoryCreate,
  type AgentMemoryPatch,
  type AgentSkillBody,
  type CustomAgent,
  type CustomAgentCreate,
  type CustomAgentPatch,
  type GeneralAgent,
  type GeneralAgentPatch,
  type MemoryOrigin,
  type MemoryProposal,
  type MemoryProposalResult,
  type MemorySource,
  MEMORY_UNDO_DAYS,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, containsSecret, redactSecrets, sha256Hex, type AtomicWriteFs } from '@latch/core/node-kit'
import { AgentJournal } from './agent-journal.ts'
import type { AuditActor, AuditLog } from './audit.ts'
import { scheduleSchema } from './schedule.ts'

export const CUSTOM_AGENT_ID = /^agt_[a-f0-9-]{36}$/u
const MAX_AGENTS = 64
const MAX_MEMORIES = 128
/** Per owner. Past it the oldest dismissed go first, then the oldest saved; pending ones are never dropped. */
export const MAX_PROPOSALS = 64
/** Agent proposals waiting for the person, per owner: the rest of the room is kept for the person's own 「记住…」. */
export const MAX_AGENT_PENDING = 32
const UNDO_MS = MEMORY_UNDO_DAYS * 24 * 60 * 60 * 1000
/** Per owner: the last edit or delete of each memory, newest kept. */
const MAX_CHANGES = 64
/** What one owner's proposals, or changes, may hold. */
const OWNER_BYTES = 256 * 1024
/** The agent's proposals may fill at most this much of an owner's room; the rest is the person's. */
const AGENT_BYTES = OWNER_BYTES / 2
const bytes = (rows: readonly unknown[]) => Buffer.byteLength(JSON.stringify(rows))
/** Mutation and start receipts answer retries of a recent request; the oldest go first once there are this many. */
const MAX_RECEIPTS = 4096

const stamp = z.string().datetime()
const revision = z.number().int().positive().safe()
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const agentId = z.string().regex(CUSTOM_AGENT_ID)
const memoryOwner = z.union([agentId, z.literal(GENERAL_AGENT_ID)])
const memoryId = z.string().regex(/^mem_[a-f0-9-]{36}$/u)
const proposalId = z.string().regex(/^prp_[a-f0-9-]{36}$/u)
const sessionRef = z.string().regex(/^[A-Za-z0-9_.:@-]{1,128}$/u)
const harnessId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/u)
const pluginId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)
const skillId = z.string().regex(/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_.-]{1,128}$/u)
const projectId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u)
const unique = <T extends string>(value: T[]) => new Set(value).size === value.length
const printable = (value: string) => !/[\p{Cc}\p{Cf}]/u.test(value)
const name = z.string().trim().min(1).max(80).refine(printable)
const model = z.strictObject({ providerId: harnessId, model: z.string().trim().min(1).max(256) })
const engineOptions = z.record(z.string().min(1).max(128), z.string().max(1024)).refine(value => Object.keys(value).length <= 8)
const instructions = z.string().max(32_000)
const skills = z.array(skillId).max(64).refine(unique)
const tools = z.array(pluginId).max(64).refine(unique)
const config = z.strictObject({
  name,
  description: z
    .string()
    .max(200)
    .refine(value => printable(value.replaceAll('\n', ' ')))
    .default(''),
  harnessId,
  mode: z.enum(['chat', 'agent']).default('agent'),
  model: model.optional(),
  engineOptions: engineOptions.optional(),
  instructions: instructions.default(''),
  skills: skills.default([]),
  tools: tools.optional(),
  defaultProjectId: projectId.optional(),
})
const avatar = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('face'), bracket: z.enum(AGENT_BRACKETS), eyes: z.enum(AGENT_EYES), hue: z.enum(AGENT_HUES) }),
])
const notifications = z.strictObject({ completed: z.boolean(), failed: z.boolean(), waiting: z.boolean() })
const createSchema = config.extend({ requestId, avatar: avatar.optional() })
const patchSchema = z.strictObject({
  name: name.optional(),
  description: z
    .string()
    .max(200)
    .refine(value => printable(value.replaceAll('\n', ' ')))
    .optional(),
  harnessId: harnessId.optional(),
  mode: z.enum(['chat', 'agent']).optional(),
  model: model.nullable().optional(),
  engineOptions: engineOptions.nullable().optional(),
  instructions: instructions.optional(),
  skills: skills.optional(),
  tools: tools.nullable().optional(),
  defaultProjectId: projectId.nullable().optional(),
  avatar: avatar.optional(),
  notifications: notifications.nullable().optional(),
  keepAwakeForSchedules: z.boolean().optional(),
  requestId,
  baseRevision: revision,
})
const generalPatchSchema = z.strictObject({
  instructions: instructions.optional(),
  skills: skills.nullable().optional(),
  requestId,
  baseRevision: revision,
})
const content = z
  .string()
  .max(4000)
  .refine(value => value.trim().length > 0)
const reason = z
  .string()
  .max(500)
  .refine(value => printable(value.replaceAll('\n', ' ')))
const origin = z.enum(['user', 'agent'])
const source = z.strictObject({
  sessionId: sessionRef,
  messageId: z.string().min(1).max(200).refine(printable).optional(),
  requestId: requestId.optional(),
})
const memoryOrigin = source.extend({ proposalId, origin, external: z.boolean(), proposedAt: stamp })
/** What a proposal holds: memory text with no hidden or control characters but line breaks, and a one-paragraph reason. */
const proposalContent = content.refine(value => printable(value.replace(/[\n\t]/gu, ' ')))
const proposalText = z.strictObject({ content: proposalContent, reason: reason.optional() })
const memoryCreateSchema = z.strictObject({ requestId, content })
const undoSchema = z.strictObject({ requestId, baseRevision: revision })
const memoryPatchSchema = memoryCreateSchema.extend({ baseRevision: revision })
const agentSchema = config.extend({
  id: agentId,
  avatar,
  notifications: notifications.optional(),
  keepAwakeForSchedules: z.literal(true).optional(),
  revision,
  createdAt: stamp,
  updatedAt: stamp,
})
const memorySchema = z.strictObject({
  id: memoryId,
  content,
  revision,
  createdAt: stamp,
  updatedAt: stamp,
  source: memoryOrigin.optional(),
  edited: z.literal(true).optional(),
})
const automationId = z.string().regex(/^auto_[a-f0-9-]{36}$/u)
/** A schedule proposal's name and when; its `content` is each run's input. */
const scheduleProposal = z.strictObject({ name, plan: scheduleSchema })
const proposalSchema = z
  .strictObject({
    id: proposalId,
    kind: z.literal('schedule').optional(),
    schedule: scheduleProposal.optional(),
    /** One proposal per key: a driver's channel position, or the person's message by its request. */
    key: hash,
    /** Empty once the memory it became is gone for good (`purged`): the row keeps only its ids and state. */
    content: z.union([proposalContent, z.literal('')]),
    reason: reason.optional(),
    origin,
    external: z.boolean(),
    source,
    state: z.enum(['pending', 'saved', 'dismissed']),
    createdAt: stamp,
    updatedAt: stamp,
    memoryId: memoryId.optional(),
    automationId: automationId.optional(),
    purged: z.literal(true).optional(),
  })
  .refine(row => (row.content === '') === (row.purged === true) && (!row.purged || (row.state === 'saved' && row.reason === undefined)))
  .refine(
    row =>
      (row.kind === 'schedule') === (row.schedule !== undefined)
      && (row.kind === 'schedule' ? row.memoryId === undefined && row.origin === 'agent' && !row.purged : row.automationId === undefined),
  )
const changeSchema = z.strictObject({ memoryId, operation: z.enum(['update', 'delete']), at: stamp, previous: memorySchema })
const generalSchema = z.strictObject({
  id: z.literal(GENERAL_AGENT_ID),
  instructions,
  skills: skills.optional(),
  revision,
  updatedAt: stamp.optional(),
})
const selection = z.strictObject({ harnessId, mode: z.enum(['chat', 'agent']), model: model.optional(), workspaceId: projectId.optional() })
const startSchema = selection.extend({ customAgentId: agentId })
export type AgentSessionSelection = z.infer<typeof selection>

const stateSchema = z
  .strictObject({
    version: z.literal(2),
    general: generalSchema,
    agents: z.array(agentSchema).max(MAX_AGENTS),
    memories: z.record(memoryOwner, z.array(memorySchema).max(MAX_MEMORIES)),
    proposals: z.record(memoryOwner, z.array(proposalSchema).max(MAX_PROPOSALS)).default({}),
    changes: z.record(memoryOwner, z.array(changeSchema).max(MAX_CHANGES)).default({}),
    starts: z.record(hash, startSchema),
    receipts: z.record(hash, z.strictObject({ hash, target: z.string().max(128), audited: z.boolean() })),
  })
  .superRefine((state, ctx) => {
    if (Buffer.byteLength(JSON.stringify(state.agents)) > 2 * 1024 * 1024) ctx.addIssue({ code: 'custom', message: 'Definition capacity' })
    if (new Set(state.agents.map(agent => agent.id)).size !== state.agents.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate identity' })
    for (const rows of Object.values(state.memories)) {
      if (rows.reduce((size, row) => size + Buffer.byteLength(row.content), 0) > 256 * 1024)
        ctx.addIssue({ code: 'custom', message: 'Memory capacity' })
      if (new Set(rows.map(row => row.id)).size !== rows.length) ctx.addIssue({ code: 'custom', message: 'Duplicate identity' })
    }
    for (const rows of Object.values(state.proposals)) {
      if (Buffer.byteLength(JSON.stringify(rows)) > OWNER_BYTES) ctx.addIssue({ code: 'custom', message: 'Proposal capacity' })
      if (new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.key)).size !== rows.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate identity' })
    }
    for (const rows of Object.values(state.changes)) {
      if (Buffer.byteLength(JSON.stringify(rows)) > OWNER_BYTES) ctx.addIssue({ code: 'custom', message: 'Change capacity' })
      if (new Set(rows.map(row => row.memoryId)).size !== rows.length) ctx.addIssue({ code: 'custom', message: 'Duplicate identity' })
    }
  })
type State = z.infer<typeof stateSchema>

export interface AgentActor {
  actor: AuditActor & { deviceId: string }
  authorize(): void
}
export interface AgentMutation<T> {
  value: T
  audited: boolean
}
interface Options {
  dataDir: string
  audit: Pick<AuditLog, 'append'>
  now?: () => number
  atomicFs?: AtomicWriteFs
}

const digest = (value: unknown) => sha256Hex(canonicalJson(value))
function missing(): AppError {
  return new AppError(404, 'agent-not-found', '找不到这个 Agent。')
}
function changed(): AppError {
  return new AppError(409, 'agent-changed', '这项记录已更新，请刷新后再修改。')
}
/** The Harness an Agent was created on is fixed: a change of it, or a start on another, is refused with this. */
export function harnessFixed(status: 400 | 409 = 409): AppError {
  return new AppError(status, 'agent-harness-fixed', 'Agent 建好后不能换 Harness，要用别的 Harness 就新建一个 Agent。')
}
function keep<K extends string>(receipts: Record<K, unknown>): void {
  const keys = Object.keys(receipts) as K[]
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_RECEIPTS))) delete receipts[key]
}

/** 通用 and 我的 Agent with their memories, in `agents/custom.json`. Every mutation is audited first and answered by its receipt on a retry. */
export class CustomAgents {
  private constructor(
    private readonly options: Options,
    private readonly journal: AgentJournal<State>,
  ) {}

  static async open(options: Options): Promise<CustomAgents> {
    const journal = await AgentJournal.open(
      options.dataDir,
      'custom.json',
      stateSchema,
      {
        version: 2,
        general: { id: GENERAL_AGENT_ID, instructions: '', revision: 1 },
        agents: [],
        memories: {},
        proposals: {},
        changes: {},
        starts: {},
        receipts: {},
      },
      // Every snapshot and new session reads this, so a failed write must not wait for someone to retry that request.
      { directory: 'agents', retryMs: 1000, upgrade: upgradeState, ...(options.atomicFs ? { atomicFs: options.atomicFs } : {}) },
    )
    return new CustomAgents(options, journal)
  }

  list(): CustomAgent[] {
    return this.journal.read().agents as CustomAgent[]
  }
  get(id: string): CustomAgent {
    const found = this.journal.read().agents.find(agent => agent.id === id)
    if (!found) throw missing()
    return found as CustomAgent
  }
  general(): GeneralAgent {
    return this.journal.read().general as GeneralAgent
  }
  memories(owner: string): AgentMemory[] {
    const state = this.journal.read()
    if (owner !== GENERAL_AGENT_ID && !state.agents.some(agent => agent.id === owner)) throw missing()
    return state.memories[owner] ?? []
  }
  /** Changes with anything a run would receive; names and timestamps stay out. */
  definitionHash(owner: string): string {
    const memories = this.memories(owner).map(memory => memory.content)
    if (owner === GENERAL_AGENT_ID) {
      const { instructions: text, skills: chosen } = this.general()
      return digest({ instructions: text, skills: chosen ?? null, memories })
    }
    const { id, instructions: text, skills: chosen, tools: allowed, harnessId: harness, mode, model: selected } = this.get(owner)
    return digest({ id, instructions: text, skills: chosen, tools: allowed ?? null, harness, mode, model: selected ?? null, memories })
  }
  hasPending(): boolean {
    return this.journal.hasPending()
  }
  /** Finishes a write whose result was left unknown, so a read does not stay refused until that request is retried. */
  recover(): Promise<void> {
    return this.journal.recover()
  }

  create(input: CustomAgentCreate, actor: AgentActor): Promise<AgentMutation<CustomAgent>> {
    const parsed = createSchema.parse(input)
    return this.mutate('create', 'agent', '', parsed, actor, state => {
      if (state.agents.length >= MAX_AGENTS) throw new AppError(409, 'agent-limit', `最多保存 ${MAX_AGENTS} 个 Agent。`)
      const { requestId: _, avatar: chosen, ...definition } = parsed,
        at = this.at(),
        id = `agt_${randomUUID()}`
      state.agents.push({ ...definition, id, avatar: chosen ?? avatarFor(state.agents), revision: 1, createdAt: at, updatedAt: at })
      return { target: id, customAgentId: id }
    }).then(result => ({ ...result, value: this.get(result.value) }))
  }

  patch(id: string, input: CustomAgentPatch, actor: AgentActor): Promise<AgentMutation<CustomAgent>> {
    agentId.parse(id)
    const parsed = patchSchema.parse(input)
    return this.mutate('update', 'agent', id, parsed, actor, state => {
      const found = state.agents.find(agent => agent.id === id)
      if (!found) throw missing()
      if (found.revision !== parsed.baseRevision) throw changed()
      // A helper is who it is: another Harness is another helper, so the Agent's own is the only one it takes.
      if (parsed.harnessId !== undefined && parsed.harnessId !== found.harnessId) throw harnessFixed()
      const {
        requestId: _,
        baseRevision: __,
        model: nextModel,
        engineOptions: nextOptions,
        tools: nextTools,
        defaultProjectId: project,
        notifications: nextNotifications,
        keepAwakeForSchedules: wake,
        ...rest
      } = parsed
      Object.assign(found, stripUndefined(rest), { revision: found.revision + 1, updatedAt: this.at() })
      assign(found, 'notifications', nextNotifications)
      // Off is the default, so it is stored only as on.
      assign(found, 'keepAwakeForSchedules', wake === undefined ? undefined : wake ? true : null)
      assign(found, 'model', nextModel)
      assign(found, 'engineOptions', nextOptions)
      assign(found, 'tools', nextTools)
      assign(found, 'defaultProjectId', project)
      return { target: id, customAgentId: id }
    }).then(result => ({ ...result, value: this.get(id) }))
  }

  remove(id: string, rid: string, actor: AgentActor): Promise<AgentMutation<{ id: string }>> {
    agentId.parse(id)
    return this.mutate(
      'delete',
      'agent',
      id,
      { requestId: requestId.parse(rid) },
      actor,
      state => {
        state.agents = state.agents.filter(agent => agent.id !== id)
        delete state.memories[id]
        delete state.proposals[id]
        delete state.changes[id]
        return { target: id, customAgentId: id }
      },
      true,
    ).then(result => ({ ...result, value: { id } }))
  }

  patchGeneral(input: GeneralAgentPatch, actor: AgentActor): Promise<AgentMutation<GeneralAgent>> {
    const parsed = generalPatchSchema.parse(input)
    return this.mutate('update', 'general', GENERAL_AGENT_ID, parsed, actor, state => {
      if (state.general.revision !== parsed.baseRevision) throw changed()
      if (parsed.instructions !== undefined) state.general.instructions = parsed.instructions
      assign(state.general, 'skills', parsed.skills)
      state.general.revision++
      state.general.updatedAt = this.at()
      return { target: GENERAL_AGENT_ID }
    }).then(result => ({ ...result, value: this.general() }))
  }

  createMemory(owner: string, input: AgentMemoryCreate, actor: AgentActor): Promise<AgentMutation<AgentMemory>> {
    memoryOwner.parse(owner)
    const parsed = memoryCreateSchema.parse(input)
    return this.mutate('create', 'memory', owner, parsed, actor, state => {
      this.assertOwner(state, owner)
      const rows = (state.memories[owner] ??= [])
      if (rows.length >= MAX_MEMORIES) throw new AppError(409, 'agent-memory-limit', `一个 Agent 最多保存 ${MAX_MEMORIES} 条记忆。`)
      const id = `mem_${randomUUID()}`,
        at = this.at()
      rows.push({ id, content: parsed.content, revision: 1, createdAt: at, updatedAt: at })
      return { target: id, ...ownerDetail(owner) }
    }).then(result => ({ ...result, value: this.memory(owner, result.value) }))
  }

  patchMemory(owner: string, id: string, input: AgentMemoryPatch, actor: AgentActor): Promise<AgentMutation<AgentMemory>> {
    memoryOwner.parse(owner)
    memoryId.parse(id)
    const parsed = memoryPatchSchema.parse(input)
    return this.mutate('update', 'memory', `${owner}/${id}`, parsed, actor, state => {
      this.assertOwner(state, owner)
      const found = state.memories[owner]?.find(row => row.id === id)
      if (!found) throw new AppError(404, 'agent-memory-not-found', '找不到这条记忆。')
      if (found.revision !== parsed.baseRevision) throw changed()
      this.keepChange(state, owner, { memoryId: id, operation: 'update', at: this.at(), previous: structuredClone(found) })
      // Where it came from stays, marked as changed since: the person's words now, from that proposal.
      if (found.content !== parsed.content && found.source) found.edited = true
      found.content = parsed.content
      found.revision++
      found.updatedAt = this.at()
      return { target: id, ...ownerDetail(owner) }
    }).then(result => ({ ...result, value: this.memory(owner, id) }))
  }

  removeMemory(owner: string, id: string, rid: string, actor: AgentActor): Promise<AgentMutation<{ id: string }>> {
    memoryOwner.parse(owner)
    memoryId.parse(id)
    return this.mutate(
      'delete',
      'memory',
      `${owner}/${id}`,
      { requestId: requestId.parse(rid) },
      actor,
      state => {
        const found = state.memories[owner]?.find(row => row.id === id)
        if (found) this.keepChange(state, owner, { memoryId: id, operation: 'delete', at: this.at(), previous: structuredClone(found) })
        if (state.memories[owner]) state.memories[owner] = state.memories[owner].filter(row => row.id !== id)
        return { target: id, ...ownerDetail(owner) }
      },
      true,
    ).then(result => ({ ...result, value: { id } }))
  }

  /** Each memory's last edit or delete that can still be undone, newest first. */
  memoryChanges(owner: string): AgentMemoryChange[] {
    const state = this.journal.read()
    if (owner !== GENERAL_AGENT_ID && !state.agents.some(agent => agent.id === owner)) throw missing()
    // A delete past the undo window is not shown, even before the next write purges it.
    const cutoff = (this.options.now ?? Date.now)() - UNDO_MS
    return (state.changes[owner] ?? []).filter(row => row.operation !== 'delete' || Date.parse(row.at) > cutoff).toReversed()
  }

  /** An owner's proposals, oldest first. */
  proposals(owner: string): MemoryProposal[] {
    const state = this.journal.read()
    if (owner !== GENERAL_AGENT_ID && !state.agents.some(agent => agent.id === owner)) throw missing()
    // A purged row is kept for its ids only; its text is gone and it is not shown.
    return (state.proposals[owner] ?? []).filter(row => !row.purged).map(({ key: _, purged: __, ...proposal }) => proposal)
  }

  /** For the snapshot: how many wait for the person, and when any last changed. Counts only, never the text. */
  proposalStates(): Record<string, { pending: number; at: string }> {
    const state = this.journal.read()
    return Object.fromEntries(
      Object.entries(state.proposals)
        .filter(([, rows]) => rows.length > 0)
        .map(([owner, rows]) => [
          owner,
          {
            pending: rows.filter(row => row.state === 'pending').length,
            at: rows.reduce((latest, row) => (row.updatedAt > latest ? row.updatedAt : latest), ''),
          },
        ]),
    )
  }

  /**
   * Keeps a proposal pending for the person; it never becomes a memory here. The same `key` (a driver's channel position,
   * or the person's message by its request) is kept once. Refuses, storing nothing, what looks like a secret, what is too
   * long, and a new one while the owner has as many pending as it may hold. Audited first, with enums and IDs only.
   */
  async propose(input: {
    owner: string
    key: string
    content: string
    reason?: string
    origin: MemoryOrigin
    external: boolean
    source: MemorySource
    actor: AuditActor
    /** A schedule proposal: its name and plan, as the agent sent them; `content` is each run's input. */
    schedule?: { name: string; plan: unknown }
  }): Promise<MemoryProposal> {
    memoryOwner.parse(input.owner)
    // A schedule's input is read whole before saving: runs of blank lines, which could push text out of view, are one.
    const trimmed = input.content.trim(),
      text = input.schedule ? trimmed.replace(/(?:[ \t]*\n){3,}/gu, '\n\n') : trimmed,
      why = input.reason?.trim() ?? ''
    // A schedule proposal is refused to the agent in its own words; checked against the scheduler's own schema.
    let plan: z.infer<typeof scheduleProposal> | undefined
    if (input.schedule) {
      if (input.origin !== 'agent') throw new AppError(400, 'agent-proposal-kind', 'Only an agent proposes schedules.')
      const named = name.safeParse(input.schedule.name)
      if (!named.success)
        throw new AppError(400, 'agent-schedule-invalid', 'The name must be 1 to 80 characters, with no control characters.')
      const when = scheduleSchema.safeParse(input.schedule.plan)
      if (!when.success)
        throw new AppError(
          400,
          'agent-schedule-invalid',
          'The plan must be {"kind":"daily"|"weekdays","time":"HH:MM"} or {"kind":"weekly","day":0-6,"time":"HH:MM"}, 0 being Sunday.',
        )
      if (!text || text.length > 4000) throw new AppError(413, 'agent-schedule-invalid', 'The prompt must be 1 to 4000 characters.')
      if (looksSecret(text) || looksSecret(named.data))
        throw new AppError(422, 'agent-memory-secret', 'It looks like a secret or credential, so it was not proposed.')
      if (!proposalContent.safeParse(text).success)
        throw new AppError(400, 'agent-schedule-invalid', 'The prompt has hidden or control characters, so it was not proposed.')
      plan = { name: named.data, plan: when.data }
    }
    if (!text) throw new AppError(400, 'agent-memory-empty', '提议的记忆是空的。')
    if (text.length > 4000 || why.length > 500) throw new AppError(413, 'agent-memory-too-long', '记忆最多 4000 字，理由最多 500 字。')
    if (looksSecret(text) || looksSecret(why)) throw new AppError(422, 'agent-memory-secret', '内容像是密钥或凭据，没有记下。')
    // Everything the record would refuse is refused here, before anything is audited.
    if (!proposalText.safeParse({ content: text, ...(why ? { reason: why } : {}) }).success)
      throw new AppError(400, 'agent-memory-invalid', '内容含有不可见的控制字符，没有记下。')
    const parsedSource = source.safeParse(input.source)
    if (!parsedSource.success) throw new AppError(400, 'agent-proposal-source', '提议的来源无效，没有记下。')
    const key = digest(['proposal', input.owner, input.key]),
      payload = digest([input.owner, input.key, text, why, input.origin, input.external, parsedSource.data, plan ?? null])
    const id = await this.journal.change(key, payload, async state => {
      this.assertOwner(state, input.owner)
      this.prune(state)
      const rows = (state.proposals[input.owner] ??= [])
      const held = rows.find(row => row.key === key)
      if (held) return { value: held.id, changed: false }
      // The person's 「记住…」 is never kept out by what the agent proposed. Agent-facing, so in the agent's words.
      if (input.origin === 'agent' && rows.filter(row => row.origin === 'agent' && row.state === 'pending').length >= MAX_AGENT_PENDING)
        throw new AppError(
          409,
          'agent-proposal-limit',
          'Too many of your proposals are waiting for the user. Propose again after the user has decided on them.',
        )
      const at = this.at(),
        proposal = {
          id: `prp_${randomUUID()}`,
          ...(plan ? { kind: 'schedule' as const, schedule: plan } : {}),
          key,
          content: text,
          ...(why ? { reason: why } : {}),
          origin: input.origin,
          external: input.external,
          source: parsedSource.data,
          state: 'pending' as const,
          createdAt: at,
          updatedAt: at,
        }
      rows.push(proposal)
      // The agent's own share first: its decided proposals make room, oldest first, and past that it is refused, so the
      // person's half is never taken.
      const agents = () => rows.filter(row => row.origin === 'agent')
      if (input.origin === 'agent') {
        for (const kind of ['dismissed', 'saved'] as const)
          while (bytes(agents()) > AGENT_BYTES && agents().some(row => row.state === kind))
            rows.splice(
              rows.findIndex(row => row.origin === 'agent' && row.state === kind),
              1,
            )
        if (bytes(agents()) > AGENT_BYTES)
          throw new AppError(
            409,
            'agent-proposal-limit',
            'Your proposals waiting for the user are too long in total. Propose again after the user has decided on them.',
          )
      }
      // Room comes from decided ones, oldest first: dismissed, then saved. Pending ones wait for the person.
      for (const kind of ['dismissed', 'saved'] as const)
        while (
          (rows.length > MAX_PROPOSALS || Buffer.byteLength(JSON.stringify(rows)) > OWNER_BYTES)
          && rows.some(row => row.state === kind)
        )
          rows.splice(
            rows.findIndex(row => row.state === kind),
            1,
          )
      if (rows.length > MAX_PROPOSALS || Buffer.byteLength(JSON.stringify(rows)) > OWNER_BYTES)
        throw new AppError(409, 'agent-proposal-limit', '等你处理的记忆提议太多，请先保存或不要一些。')
      await this.options.audit.append({
        action: 'agent.memory.proposed',
        actor: input.actor,
        target: proposal.id,
        detail: { origin: input.origin, external: input.external, ...ownerDetail(input.owner), kind: plan ? 'schedule' : 'memory' },
      })
      return { value: proposal.id }
    })
    return this.proposal(input.owner, id)
  }

  /** Saves a pending proposal as a memory, through the same receipts and audit as adding one. */
  saveProposal(owner: string, id: string, rid: string, actor: AgentActor): Promise<AgentMutation<MemoryProposalResult>> {
    memoryOwner.parse(owner)
    proposalId.parse(id)
    return this.mutate('create', 'memory', `${owner}/${id}/save`, { requestId: requestId.parse(rid) }, actor, state => {
      this.assertOwner(state, owner)
      const found = state.proposals[owner]?.find(row => row.id === id)
      if (!found) throw new AppError(404, 'agent-proposal-not-found', '找不到这条提议。')
      if (found.kind === 'schedule') throw new AppError(409, 'agent-proposal-kind', '这是定时任务的提议，请打开后在定时编辑里保存。')
      if (found.state !== 'pending') throw new AppError(409, 'agent-proposal-decided', '这条提议已经处理过了。')
      const rows = (state.memories[owner] ??= [])
      if (rows.length >= MAX_MEMORIES) throw new AppError(409, 'agent-memory-limit', `一个 Agent 最多保存 ${MAX_MEMORIES} 条记忆。`)
      const memory = `mem_${randomUUID()}`,
        at = this.at()
      rows.push({
        id: memory,
        content: found.content,
        revision: 1,
        createdAt: at,
        updatedAt: at,
        source: { ...found.source, proposalId: found.id, origin: found.origin, external: found.external, proposedAt: found.createdAt },
      })
      found.state = 'saved'
      found.memoryId = memory
      found.updatedAt = at
      return { target: memory, via: 'proposal', ...ownerDetail(owner) }
    }).then(result => ({ ...result, value: this.decision(owner, id, result.value) }))
  }

  /** 不要: the proposal stays, dismissed, until room is needed. Never refused for want of an audit record. */
  dismissProposal(owner: string, id: string, rid: string, actor: AgentActor): Promise<AgentMutation<MemoryProposalResult>> {
    memoryOwner.parse(owner)
    proposalId.parse(id)
    return this.mutate(
      'delete',
      'proposal',
      `${owner}/${id}/dismiss`,
      { requestId: requestId.parse(rid) },
      actor,
      state => {
        this.assertOwner(state, owner)
        const found = state.proposals[owner]?.find(row => row.id === id)
        if (!found) throw new AppError(404, 'agent-proposal-not-found', '找不到这条提议。')
        if (found.state === 'saved') throw new AppError(409, 'agent-proposal-decided', '这条提议已经保存了。')
        if (found.state === 'pending') {
          found.state = 'dismissed'
          found.updatedAt = this.at()
        }
        return { target: id, ...ownerDetail(owner) }
      },
      true,
    ).then(result => ({ ...result, value: this.decision(owner, id) }))
  }

  /**
   * A schedule proposal the person saved in the schedule editor: it now names that schedule. The schedule was created
   * first, under its own receipt; a retry with the same request finds it saved with the same schedule and answers the same.
   */
  scheduleSaved(
    owner: string,
    id: string,
    input: { requestId: string; automationId: string },
    actor: AgentActor,
  ): Promise<AgentMutation<MemoryProposalResult>> {
    memoryOwner.parse(owner)
    proposalId.parse(id)
    const saved = automationId.parse(input.automationId)
    return this.mutate(
      'update',
      'proposal',
      `${owner}/${id}/scheduled/${saved}`,
      { requestId: requestId.parse(input.requestId) },
      actor,
      state => {
        this.assertOwner(state, owner)
        const found = state.proposals[owner]?.find(row => row.id === id)
        if (!found) throw new AppError(404, 'agent-proposal-not-found', '找不到这条提议。')
        if (found.kind !== 'schedule') throw new AppError(409, 'agent-proposal-kind', '这条提议不是定时任务。')
        if (found.state === 'saved' && found.automationId === saved) return { target: id, ...ownerDetail(owner) }
        if (found.state !== 'pending') throw new AppError(409, 'agent-proposal-decided', '这条提议已经处理过了。')
        found.state = 'saved'
        found.automationId = saved
        found.updatedAt = this.at()
        return { target: id, ...ownerDetail(owner) }
      },
      // The schedule is saved already; the proposal's mark follows it even without an audit record.
      true,
    ).then(result => ({ ...result, value: this.decision(owner, id) }))
  }

  /** Puts back a memory as it was before its last edit or delete; that step is then used up. */
  undoMemory(
    owner: string,
    id: string,
    input: { requestId: string; baseRevision: number },
    actor: AgentActor,
  ): Promise<AgentMutation<AgentMemory>> {
    memoryOwner.parse(owner)
    memoryId.parse(id)
    const parsed = undoSchema.parse(input)
    return this.mutate('update', 'memory', `${owner}/${id}/undo`, parsed, actor, state => {
      this.assertOwner(state, owner)
      this.prune(state)
      const changes = state.changes[owner] ?? [],
        step = changes.find(change => change.memoryId === id)
      if (!step) throw new AppError(409, 'agent-memory-no-undo', '这条记忆没有可以撤销的修改。')
      const rows = (state.memories[owner] ??= []),
        current = rows.find(row => row.id === id),
        at = this.at()
      // Only what the person saw: a change made elsewhere since then is not silently undone.
      if ((current?.revision ?? step.previous.revision) !== parsed.baseRevision) throw changed()
      if (step.operation === 'update') {
        if (!current) throw new AppError(410, 'agent-memory-deleted', '这条记忆已删除。')
        current.content = step.previous.content
        assign(current, 'source', step.previous.source ?? null)
        assign(current, 'edited', step.previous.edited ?? null)
        current.revision++
        current.updatedAt = at
      } else {
        if (current) throw changed()
        if (rows.length >= MAX_MEMORIES) throw new AppError(409, 'agent-memory-limit', `一个 Agent 最多保存 ${MAX_MEMORIES} 条记忆。`)
        rows.push({ ...structuredClone(step.previous), revision: step.previous.revision + 1, updatedAt: at })
      }
      state.changes[owner] = changes.filter(change => change !== step)
      return { target: id, via: 'undo', ...ownerDetail(owner) }
    }).then(result => ({ ...result, value: this.memory(owner, id) }))
  }

  /** 清除 on a deleted memory: its text goes now instead of when the undo window ends. Never refused for want of an audit. */
  forgetChange(
    owner: string,
    id: string,
    input: { requestId: string; baseRevision: number },
    actor: AgentActor,
  ): Promise<AgentMutation<{ id: string }>> {
    memoryOwner.parse(owner)
    memoryId.parse(id)
    const parsed = undoSchema.parse(input)
    return this.mutate(
      'delete',
      'memory',
      `${owner}/${id}/forget`,
      parsed,
      actor,
      state => {
        this.assertOwner(state, owner)
        this.prune(state)
        const step = state.changes[owner]?.find(change => change.memoryId === id && change.operation === 'delete')
        if (step) {
          if (step.previous.revision !== parsed.baseRevision) throw changed()
          state.changes[owner] = state.changes[owner]!.filter(change => change !== step)
          this.dropText(state, owner, step)
        }
        return { target: id, ...ownerDetail(owner) }
      },
      true,
    ).then(result => ({ ...result, value: { id } }))
  }

  /** The original choice of this device's start, before a retry can confirm or bind any program. */
  recordedStart(id: string, deviceId: string, rid: string): AgentSessionSelection | undefined {
    const held = this.journal.read().starts[digest(['start', deviceId, rid])]
    if (held?.customAgentId !== id) return undefined
    const { customAgentId: _, ...selection } = held
    return selection
  }

  /** A retry keeps its first engine and project even if the Agent was edited meanwhile. */
  async reserveStart(id: string, rid: string, choose: () => AgentSessionSelection, actor: AgentActor): Promise<AgentSessionSelection> {
    agentId.parse(id)
    const key = digest(['start', actor.actor.deviceId, rid])
    return this.journal.change(
      key,
      id,
      state => {
        const held = state.starts[key]
        if (held) {
          if (held.customAgentId !== id) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
          const { customAgentId: _, ...chosen } = held
          return { value: chosen, changed: false }
        }
        if (!state.agents.some(agent => agent.id === id)) throw missing()
        this.prune(state)
        const chosen = selection.parse(choose())
        state.starts[key] = { ...chosen, customAgentId: id }
        keep(state.starts)
        return { value: chosen }
      },
      actor.authorize,
    )
  }

  /** A decision's answer: from the receipt alone, with the proposal and memory while they are still there. */
  private decision(owner: string, id: string, memory?: string): MemoryProposalResult {
    const proposal = this.proposals(owner).find(row => row.id === id),
      saved = memory ?? proposal?.memoryId,
      found = saved ? this.memories(owner).find(row => row.id === saved) : undefined
    return { proposalId: id, ...(saved ? { memoryId: saved } : {}), ...(proposal ? { proposal } : {}), ...(found ? { memory: found } : {}) }
  }
  /** A deleted memory's text is kept for the undo window only. Answers whether anything went. */
  private prune(state: State): boolean {
    const cutoff = (this.options.now ?? Date.now)() - UNDO_MS
    let pruned = false
    for (const [owner, rows] of Object.entries(state.changes)) {
      const expired = rows.filter(row => row.operation === 'delete' && Date.parse(row.at) <= cutoff)
      if (!expired.length) continue
      pruned = true
      state.changes[owner] = rows.filter(row => !expired.includes(row))
      for (const row of expired) this.dropText(state, owner, row)
    }
    return pruned
  }
  /**
   * A deleted memory's undo step is gone: so is its text, in the proposal it was saved from too. That row keeps its ids
   * and state, and is no longer listed.
   */
  private dropText(state: State, owner: string, change: State['changes'][string][number]): void {
    if (change.operation !== 'delete' || !change.previous.source) return
    const row = state.proposals[owner]?.find(item => item.id === change.previous.source!.proposalId)
    if (!row || row.state !== 'saved') return
    row.content = ''
    delete row.reason
    row.purged = true
  }

  /** Purges deleted memories past the undo window without waiting for another write: at start and once a day. */
  async purgeExpired(): Promise<void> {
    const probe = structuredClone(this.journal.read())
    if (!this.prune(probe)) return
    await this.journal.change(digest(['purge', randomUUID()]), digest(['purge']), state => ({
      value: undefined,
      changed: this.prune(state),
    }))
  }
  private proposal(owner: string, id: string): MemoryProposal {
    const found = this.proposals(owner).find(row => row.id === id)
    if (!found) throw new AppError(404, 'agent-proposal-not-found', '找不到这条提议。')
    return found
  }
  /** One undo step per memory, the newest; the oldest go first past the limit. */
  private keepChange(state: State, owner: string, change: State['changes'][string][number]): void {
    this.prune(state)
    const rows = (state.changes[owner] ?? []).filter(row => row.memoryId !== change.memoryId)
    rows.push(change)
    while (rows.length > MAX_CHANGES || (rows.length > 1 && Buffer.byteLength(JSON.stringify(rows)) > OWNER_BYTES))
      this.dropText(state, owner, rows.shift()!)
    state.changes[owner] = rows
  }
  private memory(owner: string, id: string): AgentMemory {
    const found = this.memories(owner).find(row => row.id === id)
    if (!found) throw new AppError(410, 'agent-memory-deleted', '这条记忆已删除。')
    return found
  }
  private assertOwner(state: State, owner: string): void {
    if (owner !== GENERAL_AGENT_ID && !state.agents.some(agent => agent.id === owner)) throw missing()
  }
  private at(): string {
    return new Date((this.options.now ?? Date.now)()).toISOString()
  }

  private async mutate(
    operation: 'create' | 'update' | 'delete',
    kind: 'agent' | 'general' | 'memory' | 'proposal',
    subject: string,
    input: { requestId: string },
    actor: AgentActor,
    apply: (state: State) => { target: string; customAgentId?: string; via?: 'proposal' | 'undo' },
    lowering = false,
  ): Promise<AgentMutation<string>> {
    actor.authorize()
    const key = digest([actor.actor.deviceId, input.requestId]),
      payload = digest([operation, kind, subject, input])
    const receipt = await this.journal.change(
      key,
      payload,
      async state => {
        const prior = state.receipts[key]
        if (prior) {
          if (prior.hash !== payload) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
          return { value: prior, changed: false }
        }
        this.prune(state)
        const before = digest([state.general, state.agents, state.memories, state.proposals]),
          result = apply(state),
          after = digest([state.general, state.agents, state.memories, state.proposals])
        let audited = true
        try {
          await this.options.audit.append({
            action: 'agent.changed',
            actor: actor.actor,
            target: result.target,
            detail: {
              kind,
              operation,
              before,
              after,
              ...(result.customAgentId ? { customAgentId: result.customAgentId } : {}),
              ...(result.via ? { via: result.via } : {}),
            },
          })
        } catch (error) {
          if (!lowering) throw error
          audited = false
        }
        const stored = { hash: payload, target: result.target, audited }
        state.receipts[key] = stored
        keep(state.receipts)
        return { value: stored }
      },
      actor.authorize,
    )
    return { value: receipt.target, audited: receipt.audited }
  }

  async close(): Promise<void> {
    await this.journal.close()
  }
}

/** What a memory must never hold: anything `redactSecrets` would hide, or a credential by its own shape. */
export function looksSecret(text: string): boolean {
  return redactSecrets(text) !== text || containsSecret(text)
}

/**
 * The person's own 「记住…」: the words after it, or undefined when the message does not start with it. Only the start
 * counts, so a message that quotes it later is ordinary.
 */
export function rememberRequest(prompt: string): string | undefined {
  const match = /^\s*(?:请记住|记住|remember\b)[\s:：,，、]*/iu.exec(prompt)
  if (!match) return undefined
  const rest = prompt.slice(match[0].length).trim()
  return rest || undefined
}

function ownerDetail(owner: string): { customAgentId?: string } {
  return owner === GENERAL_AGENT_ID ? {} : { customAgentId: owner }
}
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>
}
/** Null clears an optional field, undefined leaves it. */
function assign<T extends object, K extends keyof T>(target: T, key: K, next: T[K] | null | undefined): void {
  if (next === null) delete target[key]
  else if (next !== undefined) target[key] = next
}
/**
 * An unused bracket and hue first, with dot eyes. Stepping both together visits all 36 pairs, since 4 and 9 share no
 * factor, so the first agents differ in bracket and in hue.
 */
export function avatarFor(agents: ReadonlyArray<{ avatar: AgentAvatar }>): AgentAvatar {
  const used = new Set(agents.map(agent => `${agent.avatar.bracket}:${agent.avatar.hue}`))
  const count = AGENT_BRACKETS.length * AGENT_HUES.length
  const at = (step: number): AgentAvatar => ({
    kind: 'face',
    bracket: AGENT_BRACKETS[step % AGENT_BRACKETS.length]!,
    eyes: 'dot',
    hue: AGENT_HUES[step % AGENT_HUES.length]!,
  })
  for (let step = 0; step < count; step++) {
    const next = at(step)
    if (!used.has(`${next.bracket}:${next.hue}`)) return next
  }
  return at(agents.length % count)
}

/** The glyphs of version 1, in their order; each maps to a fixed avatar. */
const V1_GLYPHS = [
  'glasses',
  'library',
  'newspaper',
  'package',
  'pen-line',
  'flask-conical',
  'compass',
  'hammer',
  'lightbulb',
  'list-checks',
  'palette',
  'telescope',
] as const
export function avatarOfGlyph(glyph: string): AgentAvatar | undefined {
  const index = (V1_GLYPHS as readonly string[]).indexOf(glyph)
  if (index < 0) return undefined
  return {
    kind: 'face',
    bracket: AGENT_BRACKETS[index % AGENT_BRACKETS.length]!,
    eyes: AGENT_EYES[Math.floor(index / AGENT_BRACKETS.length) % AGENT_EYES.length]!,
    hue: AGENT_HUES[index % AGENT_HUES.length]!,
  }
}
/** Version 1 named a glyph; version 2 has the avatar in its place. Anything else is left for the schema to refuse. */
function upgradeState(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || (raw as { version?: unknown }).version !== 1) return raw
  const state = raw as { version: number; agents?: unknown }
  if (!Array.isArray(state.agents)) return raw
  const agents = state.agents.map((agent: unknown) => {
    if (typeof agent !== 'object' || agent === null || !('glyph' in agent)) return agent
    const { glyph, ...rest } = agent as { glyph: unknown }
    const mapped = typeof glyph === 'string' ? avatarOfGlyph(glyph) : undefined
    return mapped ? { ...rest, avatar: mapped } : agent
  })
  return { ...state, version: 2, agents }
}

export interface AgentDelivery {
  /** 「通用」, or the agent's name. */
  agentName: string
  /** The engine's name, as the first-turn block says it. */
  engineName: string
  instructions: string
  memories: readonly AgentMemory[]
  /** Names of the skills the engine can fetch from the skills server. */
  skillNames: readonly string[]
}

/** What a private-context driver receives as its system context. */
export function privateInstructions(input: Pick<AgentDelivery, 'instructions' | 'memories'>): string {
  return [input.instructions, ...(input.memories.length ? ['用户明确维护的记忆：', ...input.memories.map(memory => memory.content)] : [])]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The first-turn block for an engine that keeps its own prompt and history. Latch adds it and never replaces anything, so
 * the framing says so; absent when there is nothing to add.
 */
export function firstTurnBrief(input: AgentDelivery): AgentBrief | undefined {
  const { agentName, engineName, instructions: text, memories, skillNames } = input
  if (!text.trim() && !memories.length && !skillNames.length) return undefined
  const segments: AgentBrief['segments'] = [
    { source: 'latch', text: `这是用户为「${agentName}」写的指令，第一轮发给 ${engineName}。${engineName} 自带的提示词和工具不变。` },
  ]
  if (text.trim()) segments.push({ source: 'latch', text: '指令：' }, { source: 'user', text })
  if (memories.length)
    segments.push(
      { source: 'latch', text: '用户明确维护的记忆：' },
      ...memories.map(memory => ({ source: 'user' as const, text: memory.content })),
    )
  if (skillNames.length)
    segments.push({ source: 'latch', text: `技能${skillNames.map(skill => `「${skill}」`).join('')}可以用技能服务取到。` })
  return { segments }
}

export function agentContext(input: {
  agent?: { customAgentId: string }
  delivery: 'private' | 'first-turn'
  brief: AgentDelivery
  revision: string
  pluginIds?: string[]
  skillIds?: string[]
  skillBodies?: AgentSkillBody[]
  expectedRevisions?: Record<string, string>
  /** One of 我的 Agent's sessions or a conversation with 通用, on a Harness that can call `propose_memory`. */
  proposals?: boolean
}): AgentExecutionContext {
  const brief = input.delivery === 'first-turn' ? firstTurnBrief(input.brief) : undefined
  return {
    ...(input.agent ? { agent: input.agent } : {}),
    instructions: input.delivery === 'private' ? privateInstructions(input.brief) : '',
    ...(brief ? { brief } : {}),
    ...(input.pluginIds ? { pluginIds: input.pluginIds } : {}),
    ...(input.skillIds ? { skillIds: input.skillIds } : {}),
    ...(input.skillBodies?.length ? { skillBodies: input.skillBodies } : {}),
    ...(input.expectedRevisions ? { expectedRevisions: input.expectedRevisions } : {}),
    ...(input.proposals ? { proposals: true as const } : {}),
    revision: input.revision,
  }
}
