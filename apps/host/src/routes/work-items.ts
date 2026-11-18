import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import {
  normalizeBoardTags,
  WORK_ITEM_LIMITS,
  type DataScope,
  type HostFeatures,
  type TaskSummary,
  type WorkItem,
  type WorkItemAnswer,
  type WorkItemStartAnswer,
} from '@latch/protocol'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { json, jsonBody, KIB, safeDecode } from '../http-util.ts'
import {
  checkedNote,
  checkedPrompt,
  checkedTitle,
  fullItem,
  HARNESS_ID,
  itemIsPrivate,
  modelRefSchema,
  narrowerScope,
  newWorkItemId,
  PROJECT_ID,
  type WorkItemRecord,
  type WorkItemStore,
  type WorkReceipt,
  WORK_ITEMS_STORED,
} from '../work-items.ts'
import type { AuditEvent, DeviceCaller, RouteContext, RouteModule } from './registry.ts'
import type { WorkThreadRoutes } from './work-threads.ts'

export interface WorkItemRouteDeps {
  store: WorkItemStore
  /**
   * `POST /tasks` without a custom Agent, exactly: the body is parsed with its schema, an empty prompt refused, an
   * unconfirmed Harness bound, then `startSession` (confirmations, L3 start audits, project queue, worktree, receipts).
   */
  start: (
    req: IncomingMessage,
    caller: DeviceCaller,
    body: Record<string, unknown>,
    res: ServerResponse,
    options: {
      withoutPrivateContext: boolean
      /** The 待办 is private: the session starts as private as it, whatever context it carries. */
      privateFrom?: string
      /** An agent proposed it from a turn that read outside content: the session's context holds outside content. */
      outsideStart?: boolean
    },
  ) => Promise<{ sessionId: string }>
  /** A saved project, or `default`. */
  projectExists: (projectId: string) => boolean
  /** The 待办 changed: clients read again; a private one only tells devices with the full data scope. */
  changed: (item: WorkItemRecord, sessionIds: readonly string[]) => void
  /** Its thread's revision, while it has one. */
  threadRevision?: (itemId: string) => number | undefined
  postAttention?: WorkThreadRoutes['attention']
  /** The 待办 was deleted: what belongs to it goes too (its thread). */
  deleted?: (itemId: string) => Promise<void>
}

const ROOT = '/link/api/work/items'
const ONE = /^\/link\/api\/work\/items\/(itm_[A-Za-z0-9_-]{22})(?:\/(start|sessions)(?:\/([^/]+))?)?$/u
/** 16,000 characters of prompt, with room for JSON escapes. */
const ITEM_BODY_LIMIT = 256 * KIB
const TAG_PROBLEMS = {
  'tag-invalid': '标签要 1–24 个字，不能有换行或控制字符。',
  'tag-secret': '标签看起来像密钥，没有保存。',
  'tag-limit': '一个待办最多 8 个标签。',
} as const

const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const suggestions = {
  projectId: z.string().regex(PROJECT_ID),
  harnessId: z.string().regex(HARNESS_ID),
  model: modelRefSchema,
  worktree: z.enum(['new', 'project']),
}
const createSchema = z.strictObject({
  requestId,
  title: z.string().max(4 * KIB),
  prompt: z
    .string()
    .max(WORK_ITEM_LIMITS.promptChars * 2)
    .optional(),
  projectId: suggestions.projectId.optional(),
  harnessId: suggestions.harnessId.optional(),
  model: suggestions.model.optional(),
  worktree: suggestions.worktree.optional(),
  tags: z.array(z.string().max(256)).max(64).optional(),
  priority: z.enum(['high', 'mid', 'low']).optional(),
})
const patchSchema = z
  .strictObject({
    baseRevision: z.number().int().min(1),
    title: z
      .string()
      .max(4 * KIB)
      .optional(),
    prompt: z
      .string()
      .max(WORK_ITEM_LIMITS.promptChars * 2)
      .optional(),
    projectId: suggestions.projectId.nullable().optional(),
    harnessId: suggestions.harnessId.nullable().optional(),
    model: suggestions.model.nullable().optional(),
    worktree: suggestions.worktree.nullable().optional(),
    tags: z.array(z.string().max(256)).max(64).nullable().optional(),
    priority: z.enum(['high', 'mid', 'low']).optional(),
    note: z
      .string()
      .max(4 * KIB)
      .nullable()
      .optional(),
    closed: z.boolean().optional(),
  })
  .refine(value => Object.keys(value).some(key => key !== 'baseRevision'), '没有要修改的内容')
const deleteSchema = z.strictObject({ baseRevision: z.number().int().min(1) })
const sessionSchema = z.strictObject({ sessionId: z.string().min(1).max(256) })
/**
 * The choices `POST /tasks` takes, checked again by its own schema; `customAgentId`, `forkOf`, `appDraft` and `via` are
 * unknown keys here and refused. A 待办's sessions are Code sessions only.
 */
const startSchema = z.strictObject({
  requestId: z.string().uuid(),
  baseRevision: z.number().int().min(1),
  prompt: z
    .string()
    .max(WORK_ITEM_LIMITS.promptChars * 2)
    .optional(),
  harnessId: z.unknown().optional(),
  workspaceId: z.unknown().optional(),
  mode: z.unknown().optional(),
  model: z.unknown().optional(),
  ownModel: z.unknown().optional(),
  worktree: z.unknown().optional(),
  config: z.unknown().optional(),
  fileRefs: z.unknown().optional(),
  attachmentIds: z.unknown().optional(),
})

const notFound = () => new AppError(404, 'item-not-found', '找不到这条待办。')
const changedError = () => new AppError(409, 'item-changed', '待办已被修改，请刷新后再试。')
const conflict = () => new AppError(409, 'request-conflict', '同一个请求标识不能用于不同内容。')
/** What a start takes from the 待办: whoever writes one of these decides how much context a start from it may carry. */
const START_FIELDS = ['prompt', 'projectId', 'harnessId', 'model', 'worktree'] as const
const titleHash = (item: Pick<WorkItemRecord, 'title'>) => sha256Hex(item.title)

/** The start's request ID as the session sees it: its own namespace, so it never matches a `POST /tasks` of the device. */
function startRequestId(deviceId: string, itemId: string, requestId: string): string {
  const hex = sha256Hex(canonicalJson(['work-item-start', deviceId, itemId, requestId]))
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** 待办: one piece of work with 0–16 Code sessions (docs/ARCHITECTURE.md#待办). Only a person sets them; nothing here runs on its own. */
export function createWorkItemRoutes(context: RouteContext, deps: WorkItemRouteDeps): RouteModule {
  const { store } = deps
  /** Starts under way by 待办: they count against its 16 sessions, and the 待办 cannot be deleted meanwhile. */
  const starting = new Map<string, number>()
  const scopeOf = (caller: DeviceCaller): DataScope => context.devices.get(caller.device.id)?.dataScope ?? 'work'
  const fullData = (caller: DeviceCaller) => scopeOf(caller) === 'all'
  /** Write routes take from the same per-device budget as the Host's other person-driven writes. */
  const writing = (caller: DeviceCaller) => {
    context.requireScope(caller, 'run')
    context.limits.classC.take(caller.device.id)
  }
  const sessionPrivate = (id: string) => context.hub.agentPrivate(id)
  const isPrivate = (item: WorkItemRecord) => itemIsPrivate(item, sessionPrivate)

  /** The 待办, as long as this device may read it: a private one to the full data scope only, else as if it did not exist. */
  function visible(caller: DeviceCaller, id: string): WorkItemRecord {
    const item = store.get(id)
    if (!item || (isPrivate(item) && !fullData(caller))) throw notFound()
    return item
  }

  async function present(item: WorkItemRecord, caller: DeviceCaller): Promise<WorkItem> {
    const summaries = new Map<string, TaskSummary>()
    await Promise.all(
      item.sessionIds.map(async id => {
        const summary = await context.hub.summary(id).catch(() => undefined)
        if (summary) summaries.set(id, summary)
      }),
    )
    const postAttention = (await deps.postAttention?.(caller, [item]))?.get(item.id)
    context.recheck(caller, 'view')
    visible(caller, item.id)
    const priv = isPrivate(item)
    if (priv) store.notePrivate(item.id, context.log)
    return fullItem(
      item,
      {
        summary: id => summaries.get(id),
        prState: id => context.board.prState(id),
        ...(deps.threadRevision ? { thread: deps.threadRevision } : {}),
        ...(postAttention ? { postAttention } : {}),
        // Who proposed it, while that session is private now, only to a device that may read it.
        originVisible: id => fullData(caller) || !sessionPrivate(id),
      },
      priv,
    )
  }

  /** Re-checks the caller after an await, and that it may still read the 待办. */
  function again(caller: DeviceCaller, id: string): void {
    context.recheck(caller, 'run')
    visible(caller, id)
  }

  function tagsOf(raw: string[] | null | undefined): string[] | null | undefined {
    if (raw === undefined || raw === null) return raw
    const normalized = normalizeBoardTags(raw)
    if ('problem' in normalized) throw new AppError(400, normalized.problem, TAG_PROBLEMS[normalized.problem])
    return normalized.tags.length ? normalized.tags : null
  }

  function projectOf(projectId: string | null | undefined): void {
    if (projectId && !deps.projectExists(projectId)) throw new AppError(400, 'workspace-unavailable', '找不到所选项目')
  }

  async function answer(res: ServerResponse, item: WorkItemRecord, caller: DeviceCaller, status = 200): Promise<void> {
    json(res, { item: await present(item, caller) } satisfies WorkItemAnswer, status)
  }

  async function create(req: IncomingMessage, res: ServerResponse, caller: DeviceCaller): Promise<void> {
    writing(caller)
    const body = createSchema.parse(await jsonBody(req, ITEM_BODY_LIMIT))
    const { requestId: request, ...fields } = body
    const payloadHash = sha256Hex(canonicalJson(fields))
    const prior = store.receipt('create', caller.device.id, request)
    if (prior) {
      if (prior.payloadHash !== payloadHash) throw conflict()
      if (!prior.itemId) throw notFound()
      return answer(res, visible(caller, prior.itemId), caller)
    }
    const title = checkedTitle(body.title)
    const prompt = checkedPrompt(body.prompt ?? '')
    const tags = tagsOf(body.tags)
    projectOf(body.projectId)
    const id = newWorkItemId()
    context.recheck(caller, 'run')
    await context.audited(
      {
        action: 'work.item.changed',
        actor: context.actorOf(caller),
        target: id,
        detail: { itemId: id, revision: 1, op: 'created', titleHash: sha256Hex(title) },
      },
      res,
    )
    const item = await store.transact((draft, at) => {
      const again = draft.receipts.find(
        receipt => receipt.kind === 'create' && receipt.deviceId === caller.device.id && receipt.requestId === request,
      )
      if (again) {
        if (again.payloadHash !== payloadHash) throw conflict()
        const existing = again.itemId ? draft.items.get(again.itemId) : undefined
        if (!existing) throw notFound()
        return { result: existing, changed: false }
      }
      // Counted over what this device can read, so a narrower device never learns how many private ones there are; the
      // file's own bound is a separate, coarse refusal.
      const readable = [...draft.items.values()].filter(item => fullData(caller) || !isPrivate(item)).length
      if (readable >= WORK_ITEM_LIMITS.items)
        throw new AppError(409, 'item-limit', `待办最多 ${WORK_ITEM_LIMITS.items} 条，请先删除不需要的。`)
      if (draft.items.size >= WORK_ITEMS_STORED) throw new AppError(409, 'item-store-full', '这台电脑上的待办记录已满，请先清理。')
      const record: WorkItemRecord = {
        id,
        title,
        prompt,
        ...(body.projectId ? { projectId: body.projectId } : {}),
        ...(body.harnessId ? { harnessId: body.harnessId } : {}),
        ...(body.model ? { model: body.model } : {}),
        ...(body.worktree ? { worktree: body.worktree } : {}),
        ...(tags ? { tags } : {}),
        ...(body.priority && body.priority !== 'mid' ? { priority: body.priority } : {}),
        sessionIds: [],
        startScope: scopeOf(caller),
        createdAt: at,
        updatedAt: at,
        revision: 1,
      }
      draft.items.set(id, record)
      draft.receipts.push({
        kind: 'create',
        deviceId: caller.device.id,
        requestId: request,
        itemId: id,
        requestHash: payloadHash,
        payloadHash,
        state: 'done',
        at,
      })
      return { result: record, changed: true }
    })
    deps.changed(item, [])
    return answer(res, item, caller, 201)
  }

  async function patch(req: IncomingMessage, res: ServerResponse, caller: DeviceCaller, id: string): Promise<void> {
    writing(caller)
    const body = patchSchema.parse(await jsonBody(req, ITEM_BODY_LIMIT))
    const current = visible(caller, id)
    const title = body.title !== undefined ? checkedTitle(body.title) : undefined
    const prompt = body.prompt !== undefined ? checkedPrompt(body.prompt) : undefined
    const note = body.note === null || body.note?.trim() === '' ? null : body.note !== undefined ? checkedNote(body.note) : undefined
    const tags = tagsOf(body.tags)
    projectOf(body.projectId)
    if (current.revision !== body.baseRevision) throw changedError()
    const { baseRevision: _base, closed, ...rest } = body
    const edited = Object.keys(rest).length > 0
    context.recheck(caller, 'run')
    // Reductions and edits of the person's own record: a missing audit line does not stop them (`x-latch-audit: failed`).
    if (edited)
      await context.audited(
        {
          action: 'work.item.changed',
          actor: context.actorOf(caller),
          target: id,
          detail: { itemId: id, revision: current.revision + 1, op: 'edited', titleHash: sha256Hex(title ?? current.title) },
        },
        res,
      )
    if (closed !== undefined && closed !== (current.closedAt !== undefined))
      await context.audited({ action: 'work.item.closed', actor: context.actorOf(caller), target: id, detail: { itemId: id, closed } }, res)
    const item = await store.transact((draft, at) => {
      again(caller, id)
      const record = draft.items.get(id)
      if (!record) throw notFound()
      if (record.revision !== body.baseRevision) throw changedError()
      if (prompt !== undefined && prompt !== record.prompt && record.sessionIds.length)
        throw new AppError(409, 'item-started', '待办已经开始，要求不能再改。')
      const startEdit = START_FIELDS.some(key => body[key] !== undefined)
      // A start under way read these already; changing them now would make what started differ from what was asked.
      if (startEdit && starting.get(id)) throw new AppError(409, 'item-starting', '这条待办正在开始一个会话，稍后再改。')
      if (startEdit) record.startScope = narrowerScope(record.startScope, scopeOf(caller))
      if (title !== undefined) record.title = title
      if (prompt !== undefined) record.prompt = prompt
      for (const key of ['projectId', 'harnessId', 'model', 'worktree'] as const) {
        const value = body[key]
        if (value === null) delete record[key]
        else if (value !== undefined) (record as Record<string, unknown>)[key] = value
      }
      if (tags === null) delete record.tags
      else if (tags !== undefined) record.tags = tags
      if (body.priority === 'mid') delete record.priority
      else if (body.priority !== undefined) record.priority = body.priority
      if (note === null) delete record.note
      else if (note !== undefined) record.note = note
      if (closed === true) record.closedAt ??= at
      else if (closed === false) delete record.closedAt
      record.updatedAt = at
      record.revision++
      return { result: record, changed: true }
    })
    deps.changed(item, item.sessionIds)
    return answer(res, item, caller)
  }

  async function remove(req: IncomingMessage, res: ServerResponse, caller: DeviceCaller, id: string): Promise<void> {
    writing(caller)
    const body = deleteSchema.parse(await jsonBody(req))
    const current = visible(caller, id)
    if (current.revision !== body.baseRevision) throw changedError()
    if (starting.get(id)) throw new AppError(409, 'item-starting', '这条待办正在开始一个会话，稍后再删除。')
    context.recheck(caller, 'run')
    await context.audited(
      {
        action: 'work.item.changed',
        actor: context.actorOf(caller),
        target: id,
        detail: { itemId: id, revision: current.revision, op: 'deleted', titleHash: titleHash(current) },
      },
      res,
    )
    const removed = await store.transact(draft => {
      again(caller, id)
      const record = draft.items.get(id)
      if (!record) throw notFound()
      if (record.revision !== body.baseRevision) throw changedError()
      if (starting.get(id)) throw new AppError(409, 'item-starting', '这条待办正在开始一个会话，稍后再删除。')
      draft.items.delete(id)
      return { result: record, changed: true }
    })
    await deps.deleted?.(id).catch(error => context.log(`待办的讨论没有删除：${error instanceof Error ? error.message : String(error)}`))
    deps.changed(removed, removed.sessionIds)
    json(res, { deleted: true })
  }

  /**
   * An existing session joins. It must be readable by this device (a private one needs the full data scope), a Code
   * session, and in no other 待办. A private session makes the 待办 private for good, and its audit line comes first.
   */
  async function join(req: IncomingMessage, res: ServerResponse, caller: DeviceCaller, id: string): Promise<void> {
    writing(caller)
    const { sessionId } = sessionSchema.parse(await jsonBody(req))
    visible(caller, id)
    const summary = await readable(caller, sessionId)
    again(caller, id)
    readableNow(caller, sessionId)
    if (summary.agent || summary.generalChat || summary.personal || summary.automationId)
      throw new AppError(409, 'item-session-kind', '只有 Code 会话可以加入待办。')
    const owner = store.itemOf(sessionId)
    if (owner && owner.id !== id) throw taken(caller, owner)
    if (owner?.id === id) return answer(res, owner, caller)
    const current = visible(caller, id)
    if (current.sessionIds.length + (starting.get(id) ?? 0) >= WORK_ITEM_LIMITS.sessions)
      throw new AppError(409, 'item-full', `一条待办最多 ${WORK_ITEM_LIMITS.sessions} 个会话。`)
    const priv = sessionPrivate(sessionId)
    await joinAudit(caller, current, sessionId, priv, res)
    const item = await store.transact((draft, at) => {
      again(caller, id)
      readableNow(caller, sessionId)
      const record = draft.items.get(id)
      if (!record) throw notFound()
      const holder = [...draft.items.values()].find(other => other.sessionIds.includes(sessionId))
      if (holder?.id === id) return { result: record, changed: false }
      if (holder) throw taken(caller, holder)
      if (record.sessionIds.length >= WORK_ITEM_LIMITS.sessions)
        throw new AppError(409, 'item-full', `一条待办最多 ${WORK_ITEM_LIMITS.sessions} 个会话。`)
      record.sessionIds.push(sessionId)
      if (priv || sessionPrivate(sessionId)) record.private = true
      record.updatedAt = at
      record.revision++
      return { result: record, changed: true }
    })
    deps.changed(item, [sessionId])
    return answer(res, item, caller)
  }

  async function leave(res: ServerResponse, caller: DeviceCaller, id: string, sessionId: string): Promise<void> {
    writing(caller)
    const current = visible(caller, id)
    if (!current.sessionIds.includes(sessionId)) return answer(res, current, caller)
    context.recheck(caller, 'run')
    await context.audited(
      {
        action: 'work.item.changed',
        actor: context.actorOf(caller),
        target: id,
        detail: { itemId: id, revision: current.revision + 1, op: 'left', sessionId, titleHash: titleHash(current) },
      },
      res,
    )
    // A private 待办 stays private: its title and prompt may already hold what the session showed.
    const item = await store.transact((draft, at) => {
      again(caller, id)
      const record = draft.items.get(id)
      if (!record) throw notFound()
      if (!record.sessionIds.includes(sessionId)) return { result: record, changed: false }
      if (sessionPrivate(sessionId)) record.private = true
      record.sessionIds = record.sessionIds.filter(member => member !== sessionId)
      record.updatedAt = at
      record.revision++
      return { result: record, changed: true }
    })
    deps.changed(item, [sessionId])
    return answer(res, item, caller)
  }

  /**
   * Starts a session from the 待办 through `deps.start`, the same function `POST /tasks` uses. The person names the
   * revision they saw (`baseRevision`), so what starts is what they read. A 待办 any of whose start values a narrower
   * device wrote starts without private context, as that device's own start would. Before the start: the 待办's audit
   * line (refused without it) and a pending receipt over the final inputs. After it: the session joins in the same write
   * that settles the receipt; when it cannot (full, deleted), the receipt still settles and the answer says the session
   * stands on its own. A retry of the same request starts nothing new: the session's own start receipt answers it.
   */
  async function start(req: IncomingMessage, res: ServerResponse, caller: DeviceCaller, id: string): Promise<void> {
    writing(caller)
    const body = startSchema.parse(await jsonBody(req, ITEM_BODY_LIMIT))
    const { requestId: request, baseRevision, ...choices } = body
    const current = visible(caller, id)
    const requestHash = sha256Hex(canonicalJson({ itemId: id, baseRevision, ...choices }))
    const prior = store.receipt('start', caller.device.id, request)
    if (prior && (prior.itemId !== id || prior.requestHash !== requestHash)) throw conflict()
    if (prior?.state === 'done' && prior.sessionId) {
      await startAnswer(res, caller, id, prior.sessionId, prior.outside)
      return
    }
    if (current.revision !== baseRevision) throw changedError()
    if (current.closedAt) throw new AppError(409, 'item-closed', '待办已完成，请先重新打开。')
    if (!prior && current.sessionIds.length + (starting.get(id) ?? 0) >= WORK_ITEM_LIMITS.sessions)
      throw new AppError(409, 'item-full', `一条待办最多 ${WORK_ITEM_LIMITS.sessions} 个会话。`)
    const withoutPrivateContext = current.startScope !== 'all'
    // The 待办's choices fill what the person left out; the permission mode is never one of them.
    const { requestId: _derived, ...finalInput } = {
      ...choices,
      requestId: '',
      prompt: choices.prompt ?? current.prompt,
      ...(choices.workspaceId === undefined && current.projectId ? { workspaceId: current.projectId } : {}),
      ...(choices.harnessId === undefined && current.harnessId ? { harnessId: current.harnessId } : {}),
      ...(choices.model === undefined && choices.ownModel === undefined && choices.config === undefined && current.model
        ? { model: current.model }
        : {}),
      ...(choices.worktree === undefined && current.worktree === 'new' ? { worktree: true } : {}),
    }
    const input: Record<string, unknown> = { ...finalInput, requestId: startRequestId(caller.device.id, id, request) }
    const payloadHash = sha256Hex(canonicalJson({ itemId: id, revision: current.revision, input: finalInput, withoutPrivateContext }))
    if (prior && prior.payloadHash !== payloadHash) throw conflict()
    context.recheck(caller, 'run')
    // Executing: refused when the line cannot be written.
    try {
      await context.audited({
        action: 'work.item.started',
        actor: context.actorOf(caller),
        target: id,
        detail: { itemId: id, requestHash: sha256Hex(String(input.requestId)) },
      })
    } catch {
      throw new AppError(503, 'audit-unavailable', '审计记录暂时无法保存，会话没有开始，请重试。')
    }
    // From here until the session has joined, the 待办's start values and its existence are held (`starting`).
    starting.set(id, (starting.get(id) ?? 0) + 1)
    let started: { sessionId: string }
    try {
      await store.transact((draft, at) => {
        again(caller, id)
        const record = draft.items.get(id)
        if (!record) throw notFound()
        // An edit that landed before the hold: the inputs above are no longer the 待办's.
        if (record.revision !== baseRevision) throw changedError()
        if (prior) return { result: undefined, changed: false }
        const receipt: WorkReceipt = {
          kind: 'start',
          deviceId: caller.device.id,
          requestId: request,
          itemId: id,
          requestHash,
          payloadHash,
          state: 'pending',
          at,
        }
        draft.receipts.push(receipt)
        return { result: undefined, changed: true }
      })
      started = await deps.start(req, caller, input, res, {
        withoutPrivateContext,
        ...(isPrivate(current) ? { privateFrom: `item:${id}` } : {}),
        ...(current.from?.external ? { outsideStart: true } : {}),
      })
    } catch (error) {
      // Refused before anything started: the request is forgotten, as `POST /tasks` forgets a failed start.
      if (error instanceof AppError && error.status >= 400 && error.status < 500 && error.status !== 408)
        await store
          .transact(draft => {
            const before = draft.receipts.length
            draft.receipts = draft.receipts.filter(
              entry =>
                !(
                  entry.kind === 'start'
                  && entry.deviceId === caller.device.id
                  && entry.requestId === request
                  && entry.state === 'pending'
                ),
            )
            return { result: undefined, changed: draft.receipts.length !== before }
          })
          .catch(() => {})
      release(id)
      throw error
    }
    try {
      await joinStarted(res, caller, id, request, started.sessionId)
    } finally {
      release(id)
    }
  }

  function release(id: string): void {
    const left = (starting.get(id) ?? 1) - 1
    if (left > 0) starting.set(id, left)
    else starting.delete(id)
  }

  async function joinStarted(res: ServerResponse, caller: DeviceCaller, id: string, request: string, sessionId: string): Promise<void> {
    // A start from a device with the full data scope can carry 通用's private context: the 待办 is private from now on.
    const priv = sessionPrivate(sessionId)
    const before = store.get(id)
    if (before && !before.sessionIds.includes(sessionId) && before.sessionIds.length < WORK_ITEM_LIMITS.sessions)
      await joinAudit(caller, before, sessionId, priv, res)
    const outside = await store.settleStart({
      itemId: id,
      deviceId: caller.device.id,
      requestId: request,
      sessionId,
      isPrivate: () => priv || sessionPrivate(sessionId),
    })
    const item = store.get(id)
    if (item) deps.changed(item, outside ? [] : [sessionId])
    await startAnswer(res, caller, id, sessionId, outside)
  }

  /** The session, the 待办 as it stands when this device may read it, and whether the session stands outside it. */
  async function startAnswer(
    res: ServerResponse,
    caller: DeviceCaller,
    id: string,
    sessionId: string,
    outside: 'item-full' | 'item-gone' | undefined,
  ): Promise<void> {
    const record = store.get(id)
    const item = record && (fullData(caller) || !isPrivate(record)) ? await present(record, caller) : undefined
    json(res, { sessionId, ...(item ? { item } : {}), ...(outside ? { outside } : {}) } satisfies WorkItemStartAnswer, 201)
  }

  /**
   * The session is in another 待办. One this device cannot read answers as a private session does (403
   * `agent-scope-required`), so a narrower device never learns that a 待办 it cannot see holds the session.
   */
  function taken(caller: DeviceCaller, holder: WorkItemRecord): AppError {
    if (isPrivate(holder) && !fullData(caller))
      return new AppError(403, 'agent-scope-required', 'Agent 含有私有记忆，请先在电脑上允许这台设备使用。')
    return new AppError(409, 'item-session-taken', '这个会话已在另一条待办里。')
  }

  /** As any route reading a session: private ones need the full data scope, and the session must exist. */
  async function readable(caller: DeviceCaller, sessionId: string): Promise<TaskSummary> {
    readableNow(caller, sessionId)
    const summary = await context.hub.summary(sessionId)
    context.recheck(caller, 'run')
    readableNow(caller, sessionId)
    return summary
  }

  function readableNow(caller: DeviceCaller, sessionId: string): void {
    if (sessionPrivate(sessionId) && !fullData(caller))
      throw new AppError(403, 'agent-scope-required', 'Agent 含有私有记忆，请先在电脑上允许这台设备使用。')
  }

  /** Joining a private session widens who learns of it through the 待办: its line comes first, or nothing joins. */
  async function joinAudit(
    caller: DeviceCaller,
    item: WorkItemRecord,
    sessionId: string,
    priv: boolean,
    res: ServerResponse,
  ): Promise<void> {
    const event: AuditEvent = {
      action: 'work.item.changed',
      actor: context.actorOf(caller),
      target: item.id,
      detail: { itemId: item.id, revision: item.revision + 1, op: 'joined', sessionId, titleHash: titleHash(item) },
    }
    if (!priv) {
      await context.audited(event, res)
      return
    }
    try {
      await context.audited(event)
    } catch {
      throw new AppError(503, 'audit-unavailable', '审计记录暂时无法保存，会话没有加入待办，请重试。')
    }
  }

  return {
    features: () => ({ workItems: true }) satisfies HostFeatures,
    async route({ req, res, caller, path, method }) {
      if (path !== ROOT && !path.startsWith(`${ROOT}/`)) return false
      context.requireScope(caller, 'view')
      if (path === ROOT) {
        if (method !== 'POST') throw new AppError(404, 'not-found', '接口不存在。')
        await create(req, res, caller)
        return true
      }
      const match = ONE.exec(path)
      if (!match) throw notFound()
      const id = match[1]!,
        action = match[2],
        member = match[3] === undefined ? undefined : safeDecode(match[3])
      if (member !== undefined && member.length > 256) throw new AppError(400, 'invalid-session', '会话标识过长')
      if (!action && method === 'GET') {
        const item = await present(visible(caller, id), caller)
        context.recheck(caller, 'view')
        visible(caller, id)
        json(res, { item } satisfies WorkItemAnswer)
      } else if (!action && method === 'PATCH') await patch(req, res, caller, id)
      else if (!action && method === 'DELETE') await remove(req, res, caller, id)
      else if (action === 'start' && member === undefined && method === 'POST') await start(req, res, caller, id)
      else if (action === 'sessions' && member === undefined && method === 'POST') await join(req, res, caller, id)
      else if (action === 'sessions' && member !== undefined && method === 'DELETE') await leave(res, caller, id, member)
      else throw new AppError(404, 'not-found', '接口不存在。')
      return true
    },
  }
}
