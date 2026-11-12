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
  type AgentMemoryCreate,
  type AgentMemoryPatch,
  type AgentSkillBody,
  type CustomAgent,
  type CustomAgentCreate,
  type CustomAgentPatch,
  type GeneralAgent,
  type GeneralAgentPatch,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, type AtomicWriteFs } from '@latch/core/node-kit'
import { AgentJournal } from './agent-journal.ts'
import type { AuditActor, AuditLog } from './audit.ts'

export const CUSTOM_AGENT_ID = /^agt_[a-f0-9-]{36}$/u
const MAX_AGENTS = 64
const MAX_MEMORIES = 128
/** Mutation and start receipts answer retries of a recent request; the oldest go first once there are this many. */
const MAX_RECEIPTS = 4096

const stamp = z.string().datetime()
const revision = z.number().int().positive().safe()
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const agentId = z.string().regex(CUSTOM_AGENT_ID)
const memoryOwner = z.union([agentId, z.literal(GENERAL_AGENT_ID)])
const memoryId = z.string().regex(/^mem_[a-f0-9-]{36}$/u)
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
const createSchema = config.extend({ requestId })
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
const memoryCreateSchema = z.strictObject({ requestId, content })
const memoryPatchSchema = memoryCreateSchema.extend({ baseRevision: revision })
const agentSchema = config.extend({
  id: agentId,
  avatar,
  revision,
  createdAt: stamp,
  updatedAt: stamp,
})
const memorySchema = z.strictObject({ id: memoryId, content, revision, createdAt: stamp, updatedAt: stamp })
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
      { version: 2, general: { id: GENERAL_AGENT_ID, instructions: '', revision: 1 }, agents: [], memories: {}, starts: {}, receipts: {} },
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
      const { requestId: _, ...definition } = parsed,
        at = this.at(),
        id = `agt_${randomUUID()}`
      state.agents.push({ ...definition, id, avatar: avatarFor(state.agents), revision: 1, createdAt: at, updatedAt: at })
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
      const {
        requestId: _,
        baseRevision: __,
        model: nextModel,
        engineOptions: nextOptions,
        tools: nextTools,
        defaultProjectId: project,
        ...rest
      } = parsed
      Object.assign(found, stripUndefined(rest), { revision: found.revision + 1, updatedAt: this.at() })
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
        if (state.memories[owner]) state.memories[owner] = state.memories[owner].filter(row => row.id !== id)
        return { target: id, ...ownerDetail(owner) }
      },
      true,
    ).then(result => ({ ...result, value: { id } }))
  }

  /**
   * Fixes what one request starts on, so a retry after an unknown result keeps its engine even if the agent was edited
   * meanwhile, and so cannot create a second session elsewhere. The first answer stands.
   */
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
        const chosen = selection.parse(choose())
        state.starts[key] = { ...chosen, customAgentId: id }
        keep(state.starts)
        return { value: chosen }
      },
      actor.authorize,
    )
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
    kind: 'agent' | 'general' | 'memory',
    subject: string,
    input: { requestId: string },
    actor: AgentActor,
    apply: (state: State) => { target: string; customAgentId?: string },
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
        const before = digest([state.general, state.agents, state.memories]),
          result = apply(state),
          after = digest([state.general, state.agents, state.memories])
        let audited = true
        try {
          await this.options.audit.append({
            action: 'agent.changed',
            actor: actor.actor,
            target: result.target,
            detail: { kind, operation, before, after, ...(result.customAgentId ? { customAgentId: result.customAgentId } : {}) },
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
  /** Names of the skills the engine can fetch from the read-only server. */
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
    segments.push({ source: 'latch', text: `技能${skillNames.map(skill => `「${skill}」`).join('')}可以用只读的技能服务取到。` })
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
    revision: input.revision,
  }
}
