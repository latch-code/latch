import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, writeFileAtomic, type AtomicWriteFs } from '@latch/core/node-kit'
import type {
  PersonalAssistant,
  PersonalAssistantCreate,
  PersonalAssistantPatch,
  PersonalGroup,
  PersonalGroupCreate,
  PersonalGroupPatch,
  PersonalMemory,
  PersonalMemoryCreate,
  PersonalMemoryPatch,
  PersonalRoutine,
  PersonalRoutineCreate,
  PersonalRoutinePatch,
} from '@latch/protocol'
import type { AuditActor, AuditLog } from './audit.ts'

const MAX_BYTES = 8 * 1024 * 1024
const MAX_RECEIPTS = 10_000
const stamp = z.string().datetime()
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const packageId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)
const harnessId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/u)
const assistantId = z.string().regex(/^asst_[a-f0-9-]{36}$/u)
const entityId = z.string().regex(/^(?:asst|mem|grp|routine)_[a-f0-9-]{36}$/u)
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(value => !/[\p{Cc}\p{Cf}]/u.test(value))
const text = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine(value => value.trim().length > 0)
const model = z.strictObject({ providerId: harnessId, model: text(256) })
const config = z.strictObject({
  name,
  role: z.string().max(2000),
  harnessId,
  mode: z.enum(['chat', 'agent']),
  model: model.optional(),
  pluginIds: z
    .array(packageId)
    .max(64)
    .refine(value => new Set(value).size === value.length),
})
const personalAssistantCreateSchema = config.extend({ requestId })
const personalAssistantPatchSchema = config.partial().extend({ requestId, baseRevision: revision, model: model.nullable().optional() })
const personalMemoryCreateSchema = z.strictObject({ requestId, content: text(4000) })
const personalMemoryPatchSchema = personalMemoryCreateSchema.extend({ baseRevision: revision })
const assistantSchema = config.extend({ id: assistantId, revision, createdAt: stamp, updatedAt: stamp })
const memorySchema = z.strictObject({ id: entityId, content: text(4000), revision, createdAt: stamp, updatedAt: stamp })
const groupConfig = z.strictObject({
  name,
  memberIds: z
    .array(assistantId)
    .min(1)
    .max(8)
    .refine(value => new Set(value).size === value.length),
  defaultAssistantId: assistantId,
  instructions: z.string().max(8000),
  maxRelays: z.number().int().min(0).max(3),
})
const personalGroupCreateSchema = groupConfig.extend({ requestId })
const personalGroupPatchSchema = groupConfig.partial().extend({ requestId, baseRevision: revision })
const groupSchema = groupConfig.extend({ id: entityId, revision, createdAt: stamp, updatedAt: stamp })
const schedule = z.strictObject({
  kind: z.literal('daily'),
  time: z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u),
  timeZone: text(80),
})
const routineConfig = z.strictObject({ assistantId, name, prompt: text(16_000), schedule })
const personalRoutineCreateSchema = routineConfig.extend({ requestId })
const personalRoutinePatchSchema = routineConfig.partial().extend({ requestId, baseRevision: revision })
const routineSchema = routineConfig.extend({
  id: entityId,
  revision,
  enabled: z.boolean(),
  state: z.enum(['disabled', 'ready', 'running', 'paused']),
  pauseReason: z
    .enum([
      'definition-changed',
      'owner-unavailable',
      'harness-unavailable',
      'plugin-unavailable',
      'missed',
      'unknown-outcome',
      'audit-unavailable',
    ])
    .optional(),
  nextRunAt: stamp.optional(),
  lastRun: z
    .strictObject({
      sessionId: z.string().max(256).optional(),
      at: stamp,
      state: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown']),
    })
    .optional(),
  createdAt: stamp,
  updatedAt: stamp,
})
type Kind = 'assistant' | 'memory' | 'group' | 'routine'
const reference = z.strictObject({
  kind: z.enum(['assistant', 'memory', 'group', 'routine']),
  id: entityId,
  assistantId: assistantId.optional(),
})
type Reference = z.infer<typeof reference>
const startSchema = z.strictObject({
  assistantId,
  definitionHash: hash,
  harnessId,
  mode: z.enum(['chat', 'agent']),
  model: model.optional(),
  pluginIds: z.array(packageId).max(64),
  requestId,
  clientRequestId: requestId.optional(),
  payloadHash: hash,
})
export type PersonalSessionBinding = z.infer<typeof startSchema>
const stateSchema = z
  .strictObject({
    version: z.literal(1),
    assistants: z.array(assistantSchema).max(64),
    memories: z.record(assistantId, z.array(memorySchema).max(128)),
    groups: z.array(groupSchema).max(32),
    routines: z.array(routineSchema).max(128),
    starts: z.record(hash, startSchema).default({}),
    receipts: z.record(hash, z.strictObject({ hash, result: reference })),
  })
  .superRefine((value, ctx) => {
    if (Buffer.byteLength(JSON.stringify({ assistants: value.assistants, groups: value.groups, routines: value.routines })) > 512 * 1024)
      ctx.addIssue({ code: 'custom', message: 'Definition capacity' })
    for (const memories of Object.values(value.memories))
      if (memories.reduce((size, item) => size + Buffer.byteLength(item.content), 0) > 256 * 1024)
        ctx.addIssue({ code: 'custom', message: 'Assistant memory capacity' })
    if (Object.keys(value.receipts).length > MAX_RECEIPTS || Object.keys(value.starts).length > MAX_RECEIPTS)
      ctx.addIssue({ code: 'custom', message: 'Receipt capacity' })
    if (
      Object.values(value.memories)
        .flat()
        .reduce((size, item) => size + item.content.length, 0) > 1_000_000
    )
      ctx.addIssue({ code: 'custom', message: 'Memory capacity' })
    for (const rows of [value.assistants, value.groups, value.routines, ...Object.values(value.memories)])
      if (new Set(rows.map(item => item.id)).size !== rows.length) ctx.addIssue({ code: 'custom', message: 'Duplicate identity' })
  })
type State = z.infer<typeof stateSchema>
export interface PersonalActor {
  actor: AuditActor & { deviceId: string }
  authorize(): void
  auditFailed?(): void
}
export interface PersonalMutation<T> {
  value: T
  audited: boolean
  replay?: true
}
export interface PersonalStoreOptions {
  audit: Pick<AuditLog, 'append'>
  now?: () => number
  atomicFs?: AtomicWriteFs
}
function digest(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}
function missing(): AppError {
  return new AppError(404, 'personal-not-found', '找不到这个个人助手或记录。')
}
function conflict(): AppError {
  return new AppError(409, 'personal-changed', '这项记录已更新，请刷新后再修改。')
}

/** One durable private namespace owns definitions, explicit memories, and device-bound mutation identities. */
export class PersonalStore {
  private readonly clientRequests = new Map<string, string>()
  private tail: Promise<unknown> = Promise.resolve()
  private pendingWrite?: { state: State; key: string; hash: string; ref: Reference; audited: boolean }
  private constructor(
    private readonly path: string,
    private state: State,
    private readonly options: PersonalStoreOptions,
  ) {
    for (const binding of Object.values(state.starts))
      if (binding.clientRequestId) this.clientRequests.set(binding.requestId, binding.clientRequestId)
  }
  static async open(dataDir: string, options: PersonalStoreOptions): Promise<PersonalStore> {
    const directory = join(dataDir, 'personal'),
      path = join(directory, 'personal.json'),
      uid = process.getuid?.()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const folder = await lstat(directory)
    if (!folder.isDirectory() || folder.isSymbolicLink() || folder.mode & 0o077 || (uid !== undefined && folder.uid !== uid))
      throw new AppError(500, 'personal-private', '个人助手目录必须只有本人可访问。')
    let state: State = { version: 1, assistants: [], memories: {}, groups: [], routines: [], starts: {}, receipts: {} }
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES || stat.mode & 0o077 || (uid !== undefined && stat.uid !== uid))
          throw new Error('Invalid private file')
        const bytes = Buffer.alloc(MAX_BYTES + 1)
        let count = 0
        while (count < bytes.length) {
          const read = await file.read(bytes, count, bytes.length - count, null)
          if (!read.bytesRead) break
          count += read.bytesRead
        }
        if (count > MAX_BYTES) throw new Error('Private file budget')
        state = stateSchema.parse(JSON.parse(bytes.subarray(0, count).toString('utf8')))
      } finally {
        await file.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new AppError(500, 'personal-invalid', '个人助手记录无法读取，原文件已保留。')
      await writeFileAtomic(path, `${JSON.stringify(state)}\n`)
    }
    return new PersonalStore(path, state, options)
  }
  private certain(): void {
    if (this.pendingWrite) throw new AppError(503, 'personal-write-unknown', '修改结果尚未确认，请重试同一次修改。')
  }
  assistants(): PersonalAssistant[] {
    this.certain()
    return structuredClone(this.state.assistants)
  }
  assistant(id: string): PersonalAssistant {
    this.certain()
    const found = this.state.assistants.find(item => item.id === id)
    if (!found) throw missing()
    return structuredClone(found)
  }
  memories(id: string): PersonalMemory[] {
    this.assistant(id)
    return structuredClone(this.state.memories[id] ?? [])
  }
  groups(): PersonalGroup[] {
    this.certain()
    return structuredClone(this.state.groups)
  }
  group(id: string): PersonalGroup {
    this.certain()
    const found = this.state.groups.find(item => item.id === id)
    if (!found) throw missing()
    return structuredClone(found)
  }
  routines(): PersonalRoutine[] {
    this.certain()
    return structuredClone(this.state.routines)
  }
  routine(id: string): PersonalRoutine {
    this.certain()
    const found = this.state.routines.find(item => item.id === id)
    if (!found) throw missing()
    return structuredClone(found)
  }
  definitionHash(id: string): string {
    return digest({ assistant: this.assistant(id), memories: this.memories(id) })
  }
  /** Presentation identity is separate from the device-bound internal execution receipt. */
  clientRequestIdFor(internal: string): string | undefined {
    return this.clientRequests.get(internal)
  }

  /** Reserves the original driver and selection before execution; retries can never migrate to another harness. */
  beginSession(id: string, rid: string, payload: unknown, caller: PersonalActor): Promise<PersonalMutation<PersonalSessionBinding>> {
    assistantId.parse(id)
    const key = digest([caller.actor.deviceId, rid])
    return this.change(
      caller,
      'start',
      'assistant',
      { requestId: rid, id, payload } as { requestId: string },
      draft => {
        if (Object.keys(draft.starts).length >= MAX_RECEIPTS) throw new AppError(429, 'personal-receipt-limit', '个人助手会话回执已满。')
        const assistant = draft.assistants.find(item => item.id === id)
        if (!assistant) throw missing()
        const definitionHash = digest({ assistant, memories: draft.memories[id] ?? [] })
        draft.starts[key] = {
          assistantId: id,
          definitionHash,
          harnessId: assistant.harnessId,
          mode: assistant.mode,
          ...(assistant.model ? { model: assistant.model } : {}),
          pluginIds: [...assistant.pluginIds],
          requestId: digest(['personal-session', caller.actor.deviceId, rid]),
          clientRequestId: rid,
          payloadHash: digest(payload),
        }
        return { kind: 'assistant', id }
      },
      state => {
        const start = state.starts[key]
        if (!start) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
        return start
      },
    ).then(result => {
      this.clientRequests.set(result.value.requestId, rid)
      return result
    })
  }
  private at(): string {
    return new Date((this.options.now ?? Date.now)()).toISOString()
  }
  private value(state: State, ref: Reference): unknown {
    return ref.kind === 'assistant'
      ? state.assistants.find(item => item.id === ref.id)
      : ref.kind === 'group'
        ? state.groups.find(item => item.id === ref.id)
        : ref.kind === 'routine'
          ? state.routines.find(item => item.id === ref.id)
          : state.memories[ref.assistantId ?? '']?.find(item => item.id === ref.id)
  }
  private change<T>(
    caller: PersonalActor,
    operation: 'create' | 'update' | 'delete' | 'start',
    kind: Kind,
    input: { requestId: string },
    apply: (draft: State) => Reference,
    project: (state: State, ref: Reference) => T,
  ): Promise<PersonalMutation<T>> {
    const pending = this.tail
      .catch(() => {})
      .then(async () => {
        caller.authorize()
        requestId.parse(input.requestId)
        const key = digest([caller.actor.deviceId, input.requestId]),
          payloadHash = digest([operation, kind, input])
        if (this.pendingWrite) {
          const held = this.pendingWrite
          if (held.key !== key) throw new AppError(503, 'personal-write-unknown', '修改结果尚未确认，请先重试原来的修改。')
          if (held.hash !== payloadHash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
          await this.publish(held)
          return { value: structuredClone(project(this.state, held.ref)), audited: held.audited, replay: true as const }
        }
        const receipt = this.state.receipts[key]
        if (receipt) {
          if (receipt.hash !== payloadHash) throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同修改。')
          return { value: structuredClone(project(this.state, receipt.result)), audited: true, replay: true as const }
        }
        const full = Object.keys(this.state.receipts).length >= MAX_RECEIPTS
        if (full && operation !== 'delete') throw new AppError(429, 'personal-receipt-limit', '个人助手修改回执已满，请在电脑上整理记录。')
        const draft = structuredClone(this.state),
          ref = apply(draft)
        const before = digest((operation === 'start' ? this.state.starts[key] : this.value(this.state, ref)) ?? null),
          after = digest((operation === 'start' ? draft.starts[key] : this.value(draft, ref)) ?? null)
        let audited = true
        try {
          await this.options.audit.append({
            action: 'personal.changed',
            actor: caller.actor,
            target: ref.id,
            detail: { kind, operation, before, after, ...(ref.assistantId ? { assistantId: ref.assistantId } : {}) },
          })
        } catch (error) {
          if (operation !== 'delete') throw error
          audited = false
        }
        caller.authorize()
        if (!full) draft.receipts[key] = { hash: payloadHash, result: ref }
        if (!stateSchema.safeParse(draft).success)
          throw new AppError(409, 'personal-storage-limit', '个人助手记录已达到容量上限，请先整理现有记录。')
        const bytes = `${JSON.stringify(draft)}\n`
        if (Buffer.byteLength(bytes) > MAX_BYTES) throw new AppError(409, 'personal-storage-limit', '个人助手记录已达到存储上限。')
        await this.publish({ state: draft, key, hash: payloadHash, ref, audited })
        return { value: structuredClone(project(draft, ref)), audited }
      })
    this.tail = pending
    return pending
  }
  private async publish(pending: NonNullable<PersonalStore['pendingWrite']>): Promise<void> {
    try {
      await writeFileAtomic(this.path, `${JSON.stringify(pending.state)}\n`, { fs: this.options.atomicFs })
    } catch {
      this.pendingWrite = pending
      throw new AppError(503, 'personal-write-unknown', '修改结果尚未确认，请重试同一次修改。')
    }
    this.state = pending.state
    this.pendingWrite = undefined
  }
  createAssistant(input: PersonalAssistantCreate, actor: PersonalActor): Promise<PersonalMutation<PersonalAssistant>> {
    const parsed = personalAssistantCreateSchema.parse(input)
    return this.change(
      actor,
      'create',
      'assistant',
      parsed,
      draft => {
        if (draft.assistants.length >= 64) throw new AppError(409, 'personal-limit', '最多保存 64 个个人助手。')
        const { requestId: _, ...config } = parsed,
          at = this.at(),
          id = `asst_${randomUUID()}`
        draft.assistants.push({ ...config, id, revision: 1, createdAt: at, updatedAt: at })
        return { kind: 'assistant', id }
      },
      (state, ref) => {
        const found = this.value(state, ref)
        if (!found) throw new AppError(410, 'personal-deleted', '这个助手已删除。')
        return found as PersonalAssistant
      },
    )
  }
  patchAssistant(id: string, input: PersonalAssistantPatch, actor: PersonalActor): Promise<PersonalMutation<PersonalAssistant>> {
    assistantId.parse(id)
    const parsed = personalAssistantPatchSchema.parse(input)
    return this.change(
      actor,
      'update',
      'assistant',
      { ...parsed, id } as typeof parsed,
      draft => {
        const found = draft.assistants.find(item => item.id === id)
        if (!found) throw missing()
        if (found.revision !== parsed.baseRevision) throw conflict()
        const { requestId: _, baseRevision: __, model: nextModel, ...changes } = parsed
        Object.assign(found, changes, { revision: found.revision + 1, updatedAt: this.at() })
        if (nextModel === null) delete found.model
        else if (nextModel !== undefined) found.model = nextModel
        this.pauseDefinitions(draft, id)
        return { kind: 'assistant', id }
      },
      (state, ref) => {
        const value = this.value(state, ref)
        if (!value) throw missing()
        return value as PersonalAssistant
      },
    )
  }
  removeAssistant(id: string, rid: string, actor: PersonalActor): Promise<PersonalMutation<{ id: string }>> {
    assistantId.parse(id)
    return this.change(
      actor,
      'delete',
      'assistant',
      { requestId: rid, id } as { requestId: string },
      draft => {
        draft.assistants = draft.assistants.filter(item => item.id !== id)
        delete draft.memories[id]
        this.pauseDefinitions(draft, id)
        return { kind: 'assistant', id }
      },
      (_state, ref) => ({ id: ref.id }),
    )
  }
  createMemory(id: string, input: PersonalMemoryCreate, actor: PersonalActor): Promise<PersonalMutation<PersonalMemory>> {
    assistantId.parse(id)
    const parsed = personalMemoryCreateSchema.parse(input)
    return this.change(
      actor,
      'create',
      'memory',
      { ...parsed, id } as typeof parsed,
      draft => {
        if (!draft.assistants.some(item => item.id === id)) throw missing()
        const rows = (draft.memories[id] ??= [])
        if (rows.length >= 128) throw new AppError(409, 'personal-memory-limit', '这个助手最多保存 128 条记忆。')
        const key = `mem_${randomUUID()}`,
          at = this.at()
        rows.push({ id: key, content: parsed.content, revision: 1, createdAt: at, updatedAt: at })
        this.pauseDefinitions(draft, id)
        return { kind: 'memory', id: key, assistantId: id }
      },
      (state, ref) => {
        const value = this.value(state, ref)
        if (!value) throw new AppError(410, 'personal-deleted', '这条记忆已删除。')
        return value as PersonalMemory
      },
    )
  }
  patchMemory(id: string, memoryId: string, input: PersonalMemoryPatch, actor: PersonalActor): Promise<PersonalMutation<PersonalMemory>> {
    assistantId.parse(id)
    entityId.parse(memoryId)
    const parsed = personalMemoryPatchSchema.parse(input)
    return this.change(
      actor,
      'update',
      'memory',
      { ...parsed, id, memoryId } as typeof parsed,
      draft => {
        const found = draft.memories[id]?.find(item => item.id === memoryId)
        if (!found) throw missing()
        if (found.revision !== parsed.baseRevision) throw conflict()
        found.content = parsed.content
        found.revision++
        found.updatedAt = this.at()
        this.pauseDefinitions(draft, id)
        return { kind: 'memory', id: memoryId, assistantId: id }
      },
      (state, ref) => {
        const value = this.value(state, ref)
        if (!value) throw new AppError(410, 'personal-deleted', '这条记忆已删除。')
        return value as PersonalMemory
      },
    )
  }
  removeMemory(id: string, memoryId: string, rid: string, actor: PersonalActor): Promise<PersonalMutation<{ id: string }>> {
    assistantId.parse(id)
    entityId.parse(memoryId)
    return this.change(
      actor,
      'delete',
      'memory',
      { requestId: rid, id, memoryId } as { requestId: string },
      draft => {
        if (draft.memories[id]) draft.memories[id] = draft.memories[id].filter(item => item.id !== memoryId)
        this.pauseDefinitions(draft, id)
        return { kind: 'memory', id: memoryId, assistantId: id }
      },
      (_state, ref) => ({ id: ref.id }),
    )
  }
  createGroup(input: PersonalGroupCreate, actor: PersonalActor): Promise<PersonalMutation<PersonalGroup>> {
    const parsed = personalGroupCreateSchema.parse(input)
    return this.change(
      actor,
      'create',
      'group',
      parsed,
      draft => {
        if (draft.groups.length >= 32) throw new AppError(409, 'personal-group-limit', '最多保存 32 个助手群聊。')
        this.checkGroup(parsed, draft)
        const { requestId: _, ...config } = parsed,
          id = `grp_${randomUUID()}`,
          at = this.at()
        draft.groups.push({ ...config, id, revision: 1, createdAt: at, updatedAt: at })
        return { kind: 'group', id }
      },
      (state, ref) => {
        const value = this.value(state, ref)
        if (!value) throw new AppError(410, 'personal-deleted', '这个群聊已删除。')
        return value as PersonalGroup
      },
    )
  }
  patchGroup(id: string, input: PersonalGroupPatch, actor: PersonalActor): Promise<PersonalMutation<PersonalGroup>> {
    entityId.parse(id)
    const parsed = personalGroupPatchSchema.parse(input)
    return this.change(
      actor,
      'update',
      'group',
      { ...parsed, id } as typeof parsed,
      draft => {
        const found = draft.groups.find(item => item.id === id)
        if (!found) throw missing()
        if (found.revision !== parsed.baseRevision) throw conflict()
        const { requestId: _, baseRevision: __, ...changes } = parsed
        Object.assign(found, changes, { revision: found.revision + 1, updatedAt: this.at() })
        this.checkGroup(found, draft)
        return { kind: 'group', id }
      },
      (state, ref) => {
        const value = this.value(state, ref)
        if (!value) throw missing()
        return value as PersonalGroup
      },
    )
  }
  removeGroup(id: string, rid: string, actor: PersonalActor): Promise<PersonalMutation<{ id: string }>> {
    entityId.parse(id)
    return this.change(
      actor,
      'delete',
      'group',
      { requestId: rid, id } as { requestId: string },
      draft => {
        draft.groups = draft.groups.filter(item => item.id !== id)
        return { kind: 'group', id }
      },
      (_state, ref) => ({ id: ref.id }),
    )
  }
  private checkGroup(group: Pick<PersonalGroup, 'memberIds' | 'defaultAssistantId'>, state: State): void {
    if (!group.memberIds.includes(group.defaultAssistantId) || group.memberIds.some(id => !state.assistants.some(item => item.id === id)))
      throw new AppError(400, 'personal-group-members', '请选择已存在的助手，并从成员中选择默认回复者。')
  }
  createRoutine(input: PersonalRoutineCreate, actor: PersonalActor): Promise<PersonalMutation<PersonalRoutine>> {
    const parsed = personalRoutineCreateSchema.parse(input)
    return this.change(
      actor,
      'create',
      'routine',
      parsed,
      draft => {
        if (draft.routines.length >= 128) throw new AppError(409, 'personal-routine-limit', '最多保存 128 个定时任务。')
        this.checkRoutine(parsed, draft)
        const { requestId: _, ...config } = parsed,
          id = `routine_${randomUUID()}`,
          at = this.at()
        draft.routines.push({ ...config, id, revision: 1, enabled: false, state: 'disabled', createdAt: at, updatedAt: at })
        return { kind: 'routine', id, assistantId: parsed.assistantId }
      },
      (state, ref) => {
        const value = this.value(state, ref)
        if (!value) throw new AppError(410, 'personal-deleted', '这个定时任务已删除。')
        return value as PersonalRoutine
      },
    )
  }
  patchRoutine(id: string, input: PersonalRoutinePatch, actor: PersonalActor): Promise<PersonalMutation<PersonalRoutine>> {
    entityId.parse(id)
    const parsed = personalRoutinePatchSchema.parse(input)
    return this.change(
      actor,
      'update',
      'routine',
      { ...parsed, id } as typeof parsed,
      draft => {
        const found = draft.routines.find(item => item.id === id)
        if (!found) throw missing()
        if (found.revision !== parsed.baseRevision) throw conflict()
        const { requestId: _, baseRevision: __, ...changes } = parsed
        Object.assign(found, changes, { revision: found.revision + 1, updatedAt: this.at() })
        this.checkRoutine(found, draft)
        if (found.enabled) {
          found.state = 'paused'
          found.pauseReason = 'definition-changed'
          delete found.nextRunAt
        }
        return { kind: 'routine', id, assistantId: found.assistantId }
      },
      (state, ref) => {
        const value = this.value(state, ref)
        if (!value) throw missing()
        return value as PersonalRoutine
      },
    )
  }
  removeRoutine(id: string, rid: string, actor: PersonalActor): Promise<PersonalMutation<{ id: string }>> {
    entityId.parse(id)
    return this.change(
      actor,
      'delete',
      'routine',
      { requestId: rid, id } as { requestId: string },
      draft => {
        draft.routines = draft.routines.filter(item => item.id !== id)
        return { kind: 'routine', id }
      },
      (_state, ref) => ({ id: ref.id }),
    )
  }
  private checkRoutine(routine: Pick<PersonalRoutine, 'assistantId' | 'schedule'>, state: State): void {
    if (!state.assistants.some(item => item.id === routine.assistantId)) throw missing()
    try {
      new Intl.DateTimeFormat('en', { timeZone: routine.schedule.timeZone }).format(new Date())
    } catch {
      throw new AppError(400, 'personal-time-zone', '请选择有效的时区。')
    }
  }
  private pauseDefinitions(state: State, id: string): void {
    for (const routine of state.routines)
      if (routine.assistantId === id && routine.enabled) {
        routine.state = 'paused'
        routine.pauseReason = 'definition-changed'
        routine.updatedAt = this.at()
      }
  }
  async close(): Promise<void> {
    await this.tail.catch(() => {})
  }
}
