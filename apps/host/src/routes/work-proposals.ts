import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import type { WorkCardProposal, WorkTodoProposal } from '@latch/sdk'
import {
  containsSecret,
  normalizeBoardTags,
  WORK_ITEM_LIMITS,
  WORK_PROPOSAL_LIMITS,
  type DataScope,
  type HostFeatures,
  type WorkProposal,
  type WorkProposalAnswer,
  type WorkProposalSummary,
} from '@latch/protocol'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { json, jsonBody, KIB } from '../http-util.ts'
import {
  checkedNote,
  checkedPrompt,
  checkedTitle,
  HARNESS_ID,
  itemIsPrivate,
  newWorkItemId,
  PROJECT_ID,
  proposalPending,
  WORK_ITEMS_STORED,
  type WorkItemRecord,
  type WorkItemStore,
  type WorkProposalEntryRecord,
  type WorkProposalRecord,
} from '../work-items.ts'
import { checkedName } from '../teams.ts'
import type { DeviceCaller, RouteContext, RouteModule } from './registry.ts'

/** What the Host knows of the proposing session when it takes a proposal; nothing here comes from the agent. */
export interface ProposingSession {
  sessionId: string
  messageId?: string
  /** One of 我的 Agent (`general` for 通用), from the Host's own records. */
  customAgentId?: string
  external: boolean
  /** The session is private now: the proposal is readable by the full data scope only, and so is what it becomes. */
  private: boolean
  /** The project the session runs in; a proposed 待办 that names none suggests it. */
  projectId?: string
}

export interface WorkProposalRouteDeps {
  store: WorkItemStore
  /** A saved project, or `default`. */
  projectExists: (projectId: string) => boolean
  harnessExists: (harnessId: string) => boolean
  /** Writes a change the person accepted to a session's card: as `PATCH /tasks/:id` would, after its own access check. */
  changeSession: (caller: DeviceCaller, sessionId: string, change: { title?: string; tags?: string[]; note?: string }) => Promise<void>
  /** A 待办 changed: as `routes/work-items.ts` reports it. */
  itemChanged: (item: WorkItemRecord, sessionIds: readonly string[]) => void
  /** A proposal changed: clients read again; a private one only tells devices with the full data scope. */
  changed: (proposal: WorkProposalRecord) => void
}

const ROOT = /^\/link\/api\/work\/proposals\/(wpp_[A-Za-z0-9_-]{22})(?:\/(accept|dismiss))?$/u
const BODY_LIMIT = 256 * KIB
const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const entryEdit = z.strictObject({
  index: z
    .number()
    .int()
    .min(0)
    .max(WORK_PROPOSAL_LIMITS.entries - 1),
  title: z
    .string()
    .max(4 * KIB)
    .optional(),
  prompt: z
    .string()
    .max(WORK_ITEM_LIMITS.promptChars * 2)
    .optional(),
  projectId: z.string().regex(PROJECT_ID).nullable().optional(),
  harnessId: z.string().regex(HARNESS_ID).nullable().optional(),
  tags: z.array(z.string().max(256)).max(64).nullable().optional(),
})
const acceptSchema = z.strictObject({
  requestId,
  baseRevision: z.number().int().min(1),
  entries: z.array(entryEdit).min(1).max(WORK_PROPOSAL_LIMITS.entries).optional(),
})
const dismissSchema = z.strictObject({
  requestId,
  baseRevision: z.number().int().min(1),
  entries: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(WORK_PROPOSAL_LIMITS.entries - 1),
    )
    .min(1)
    .max(WORK_PROPOSAL_LIMITS.entries)
    .optional(),
})

const shortText = z.string().max(4 * KIB)
const tagInput = z.array(z.string().max(256)).max(64)
const todoInput = z.strictObject({
  title: shortText,
  prompt: z.string().max(WORK_PROPOSAL_LIMITS.promptChars * 2),
  project: z.string().max(256).optional(),
  harness: z.string().max(256).optional(),
  tags: tagInput.optional(),
  group: z.strictObject({ label: z.string().min(1).max(512), goal: shortText }).optional(),
})
const cardInput = z.strictObject({
  target: z.enum(['session', 'todo']),
  title: shortText.optional(),
  tags: tagInput.optional(),
  note: shortText.optional(),
})
/**
 * What a driver hands the Host (`WorkProposalInput`), checked whole at the boundary: types, lengths (the `messageId` as the
 * strict file keeps it, so no audit line is written for what the store would then refuse), exactly one of `todo` and `card`.
 */
export const workProposalInputSchema = z
  .strictObject({
    sessionId: z.string().min(1).max(256),
    messageId: z.string().min(1).max(256).optional(),
    todo: todoInput.optional(),
    card: cardInput.optional(),
    external: z.boolean(),
    key: z.string().min(1).max(512),
  })
  .refine(input => (input.todo === undefined) !== (input.card === undefined))

const notFound = () => new AppError(404, 'proposal-not-found', '找不到这条提议。')
const changedError = () => new AppError(409, 'proposal-changed', '提议已有变化，请刷新后再试。')
const decided = () => new AppError(409, 'proposal-decided', '这条提议已经处理过了。')
const conflict = () => new AppError(409, 'request-conflict', '同一个请求标识不能用于不同内容。')
const newProposalId = () => `wpp_${randomBytes(16).toString('base64url')}`
// Refusals to the agent are in English, in its words; none quotes what it proposed.
const refuse = (status: number, code: string, message: string) => new AppError(status, code, message)
const ONE_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/u
const PROMPT_REFUSED = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
const HIDDEN = /[\p{Cf}]/u

/** What every write to a proposal answers, full text included: only a device that may read it gets here. */
function full(row: WorkProposalRecord, isPrivate: boolean): WorkProposal {
  return {
    id: row.id,
    kind: row.kind,
    from: {
      sessionId: row.from.sessionId,
      ...(row.from.customAgentId ? { customAgentId: row.from.customAgentId } : {}),
      ...(row.from.messageId ? { messageId: row.from.messageId } : {}),
    },
    ...(row.external ? { external: true as const } : {}),
    ...(isPrivate ? { private: true as const } : {}),
    ...(row.goal ? { goal: row.goal } : {}),
    ...(row.entries
      ? {
          entries: row.entries.map((entry, index) => ({
            index,
            state: entry.state,
            title: entry.title ?? '',
            ...(entry.name ? { name: entry.name } : {}),
            prompt: entry.prompt ?? '',
            ...(entry.prompt ? { hasPrompt: true as const } : {}),
            ...(entry.projectId ? { projectId: entry.projectId } : {}),
            ...(entry.harnessId ? { harnessId: entry.harnessId } : {}),
            ...(entry.tags ? { tags: [...entry.tags] } : {}),
            ...(entry.itemId ? { itemId: entry.itemId } : {}),
          })),
        }
      : {}),
    ...(row.change
      ? {
          change: {
            target: structuredClone(row.change.target),
            state: row.change.state,
            ...(row.change.title ? { title: row.change.title } : {}),
            ...(row.change.tags ? { tags: [...row.change.tags] } : {}),
            ...(row.change.note ? { note: row.change.note } : {}),
          },
        }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision,
  }
}

/** As the snapshot lists it: no 要求, which `GET /work/proposals/:id` carries. */
export function proposalSummary(row: WorkProposalRecord, isPrivate: boolean): WorkProposalSummary {
  const { entries, ...rest } = full(row, isPrivate)
  return {
    ...rest,
    // Nor the 待办 an accepted entry became: that 待办 may turn private later.
    ...(entries ? { entries: entries.map(({ prompt: _prompt, itemId: _itemId, ...entry }) => entry) } : {}),
  }
}

/** A decided entry keeps its state and the 待办 it became, never its text. */
/** Once nothing of a group is pending, its name goes too: only states and the 待办 it became are kept. */
function forgetText(row: WorkProposalRecord): void {
  if (!proposalPending(row)) delete row.goal
}

function settle(entry: WorkProposalEntryRecord, state: 'accepted' | 'dismissed', itemId?: string): void {
  entry.state = state
  delete entry.title
  delete entry.prompt
  delete entry.projectId
  delete entry.harnessId
  delete entry.tags
  if (itemId) entry.itemId = itemId
}

/**
 * Agents' proposals for the board (docs/ARCHITECTURE.md#agent-的提议): taken from a driver through `intake`, read and
 * decided by a person through the routes. A proposal is never a 待办 and never applies itself; an accepted 待办 is an
 * ordinary unstarted one whose start carries no private context (`startScope: 'work'`), since a model wrote it.
 */
export function createWorkProposalRoutes(context: RouteContext, deps: WorkProposalRouteDeps) {
  const { store } = deps
  const scopeOf = (caller: DeviceCaller): DataScope => context.devices.get(caller.device.id)?.dataScope ?? 'work'
  const fullData = (caller: DeviceCaller) => scopeOf(caller) === 'all'
  const sessionPrivate = (id: string) => context.hub.agentPrivate(id)
  const itemPrivate = (item: WorkItemRecord) => itemIsPrivate(item, sessionPrivate)
  /** A change waits for a private card: a 待办 that is private now, or a private session. */
  const targetPrivate = (row: Pick<WorkProposalRecord, 'change'>) => {
    const target = row.change?.target
    if (!target) return false
    if ('sessionId' in target) return sessionPrivate(target.sessionId)
    const item = store.get(target.itemId)
    return item !== undefined && itemPrivate(item)
  }
  /** Private once marked, and while its proposing session or the card it is for is private now. */
  const isPrivate = (row: WorkProposalRecord) => row.private === true || sessionPrivate(row.from.sessionId) || targetPrivate(row)

  function visible(caller: DeviceCaller, id: string): WorkProposalRecord {
    const row = store.proposal(id)
    if (!row || (isPrivate(row) && !fullData(caller))) throw notFound()
    return row
  }

  function tagsFor(raw: readonly string[] | undefined, english: boolean): string[] | undefined {
    if (!raw?.length) return undefined
    const normalized = normalizeBoardTags(raw)
    if ('problem' in normalized) {
      if (english) throw refuse(400, normalized.problem, 'Tags must be at most 8 labels of 1 to 24 characters, with nothing like a secret.')
      throw new AppError(400, normalized.problem, '标签要 1–24 个字，最多 8 个，不能像密钥。')
    }
    return normalized.tags.length ? normalized.tags : undefined
  }

  /** A title the agent wrote, checked as a 待办's title is, refused in its words. */
  function agentTitle(raw: string): string {
    const title = raw.trim()
    const length = [...title].length
    if (!length || length > WORK_PROPOSAL_LIMITS.titleChars || ONE_LINE.test(title) || HIDDEN.test(title))
      throw refuse(400, 'proposal-invalid', `The title must be one line of 1 to ${WORK_PROPOSAL_LIMITS.titleChars} characters.`)
    if (containsSecret(title)) throw refuse(422, 'proposal-secret', 'It looks like a secret or credential, so it was not proposed.')
    return title
  }

  function agentTodo(todo: WorkTodoProposal, session: ProposingSession): Omit<WorkProposalEntryRecord, 'key' | 'state'> {
    const title = agentTitle(todo.title)
    const prompt = todo.prompt.trim()
    if (!prompt || prompt.length > WORK_PROPOSAL_LIMITS.promptChars || PROMPT_REFUSED.test(prompt) || HIDDEN.test(prompt))
      throw refuse(
        400,
        'proposal-invalid',
        `The prompt must be 1 to ${WORK_PROPOSAL_LIMITS.promptChars} characters, with no control characters.`,
      )
    if (containsSecret(prompt)) throw refuse(422, 'proposal-secret', 'It looks like a secret or credential, so it was not proposed.')
    if (todo.project !== undefined && (!PROJECT_ID.test(todo.project) || !deps.projectExists(todo.project)))
      throw refuse(400, 'proposal-project', "Unknown project. Leave project out to suggest this session's project.")
    if (todo.harness !== undefined && (!HARNESS_ID.test(todo.harness) || !deps.harnessExists(todo.harness)))
      throw refuse(400, 'proposal-harness', 'Unknown Harness. Leave harness out.')
    const projectId = todo.project ?? (session.projectId && deps.projectExists(session.projectId) ? session.projectId : undefined)
    const tags = tagsFor(todo.tags, true)
    const name = checkedName(todo.name)
    return {
      title,
      ...(name ? { name } : {}),
      prompt,
      ...(projectId ? { projectId } : {}),
      ...(todo.harness ? { harnessId: todo.harness } : {}),
      ...(tags ? { tags } : {}),
    }
  }

  /**
   * One proposal from a driver, for a session the Host already checked (`ProposingSession`). Bounded per turn, per session
   * and pending in all; refused before anything is written when it looks like a secret, is too long or names what does
   * not exist. Its audit line comes first; nothing is kept without it. A line read twice is kept once.
   */
  async function intake(session: ProposingSession, input: { key: string; todo?: WorkTodoProposal; card?: WorkCardProposal }) {
    if (!session.messageId) throw refuse(409, 'proposal-turn', 'Propose from within a turn of the conversation.')
    const key = sha256Hex(canonicalJson(['work-proposal', session.sessionId, input.key]))
    const group = input.todo?.group
      ? sha256Hex(canonicalJson(['work-proposal-group', session.sessionId, input.todo.group.label]))
      : undefined
    const goal = input.todo?.group ? agentTitle(input.todo.group.goal) : undefined
    const entry = input.todo ? agentTodo(input.todo, session) : undefined
    let change: WorkProposalRecord['change'] | undefined
    if (input.card) {
      if ('priority' in input.card) throw refuse(400, 'proposal-priority', "Priority is the user's alone and cannot be proposed.")
      const title = input.card.title !== undefined ? agentTitle(input.card.title) : undefined
      let note: string | undefined
      if (input.card.note !== undefined)
        try {
          note = checkedNote(input.card.note)
        } catch (error) {
          throw error instanceof AppError && error.code === 'note-secret'
            ? refuse(422, 'proposal-secret', 'It looks like a secret or credential, so it was not proposed.')
            : refuse(400, 'proposal-invalid', `The note must be one line of 1 to ${WORK_PROPOSAL_LIMITS.noteChars} characters.`)
        }
      const tags = tagsFor(input.card.tags, true)
      if (title === undefined && note === undefined && tags === undefined)
        throw refuse(400, 'proposal-invalid', 'Propose a title, tags or a note.')
      change = {
        target: await cardTarget(session.sessionId, input.card.target),
        state: 'pending',
        ...(title ? { title } : {}),
        ...(tags ? { tags } : {}),
        ...(note ? { note } : {}),
      }
    }
    if (!entry && !change) throw refuse(400, 'proposal-invalid', 'Nothing was proposed.')
    const known = store.proposals().find(row => row.key === key || row.entries?.some(item => item.key === key))
    if (known) return known
    const joining = group ? store.proposals().find(row => row.group === group && row.from.sessionId === session.sessionId) : undefined
    const id = joining?.id ?? newProposalId()
    // A group's further items join the proposal its first item made; they are not new proposals.
    if (!joining) bounds(session, store.proposals())
    else if (!proposalPending(joining) || (joining.entries?.length ?? 0) >= WORK_PROPOSAL_LIMITS.entries)
      throw refuse(409, 'proposal-limit', `A group holds at most ${WORK_PROPOSAL_LIMITS.entries} to-dos, all proposed in one call.`)
    try {
      await context.audited({
        action: 'work.proposal.made',
        actor: { listener: 'host' },
        target: id,
        detail: {
          proposalId: id,
          kind: change ? 'change' : 'todo',
          entries: joining ? (joining.entries?.length ?? 0) + 1 : 1,
          external: session.external,
          sessionId: session.sessionId,
          ...(session.customAgentId ? { customAgentId: session.customAgentId } : {}),
        },
      })
    } catch {
      throw refuse(503, 'audit-unavailable', 'The proposal could not be recorded. Try again later.')
    }
    const row = await store.transact((draft, at) => {
      const again = draft.proposals.find(item => item.key === key || item.entries?.some(one => one.key === key))
      if (again) return { result: again, changed: false }
      if (joining) {
        const target = draft.proposals.find(item => item.id === joining.id)
        if (!target?.entries || !proposalPending(target) || target.entries.length >= WORK_PROPOSAL_LIMITS.entries)
          throw refuse(409, 'proposal-limit', `A group holds at most ${WORK_PROPOSAL_LIMITS.entries} to-dos, all proposed in one call.`)
        target.entries.push({ key, state: 'pending', ...entry! })
        // Any item of the group from outside content marks the whole group.
        if (session.external) target.external = true
        if (session.private) target.private = true
        target.updatedAt = at
        target.revision++
        return { result: target, changed: true }
      }
      // Checked again in the write, against what has been kept meanwhile.
      bounds(session, draft.proposals)
      const record: WorkProposalRecord = {
        id,
        kind: change ? 'change' : 'todo',
        key,
        ...(group ? { group } : {}),
        from: {
          sessionId: session.sessionId,
          ...(session.customAgentId ? { customAgentId: session.customAgentId } : {}),
          ...(session.messageId ? { messageId: session.messageId } : {}),
        },
        external: session.external,
        ...(session.private || (change !== undefined && targetPrivate({ change })) ? { private: true as const } : {}),
        ...(goal ? { goal } : {}),
        ...(entry ? { entries: [{ key, state: 'pending' as const, ...entry }] } : {}),
        ...(change ? { change } : {}),
        createdAt: at,
        updatedAt: at,
        revision: 1,
      }
      draft.proposals.push(record)
      return { result: record, changed: true }
    })
    deps.changed(row)
    return row
  }

  const pendingFull = () =>
    refuse(409, 'proposal-limit', 'Too many proposals are waiting for the user. Propose again after the user has decided on them.')

  /**
   * Per turn (every proposal of that turn), per session (those still waiting for the person) and pending in all; a group
   * counts once. A session's lifetime is bounded by its channel (32 proposals of every kind). Agent-facing.
   */
  function bounds(session: ProposingSession, rows: readonly WorkProposalRecord[]): void {
    const own = rows.filter(row => row.from.sessionId === session.sessionId)
    if (own.filter(proposalPending).length >= WORK_PROPOSAL_LIMITS.perSession)
      throw refuse(
        409,
        'proposal-limit',
        "Too many of this session's proposals are waiting for the user. Propose again after the user has decided on them.",
      )
    if (session.messageId && own.filter(row => row.from.messageId === session.messageId).length >= WORK_PROPOSAL_LIMITS.perTurn)
      throw refuse(409, 'proposal-limit', `At most ${WORK_PROPOSAL_LIMITS.perTurn} proposals per turn.`)
    if (rows.filter(proposalPending).length >= WORK_PROPOSAL_LIMITS.pending) throw pendingFull()
  }

  /**
   * The card a change is for, from the Host's records of the proposing session, never from the agent: the session's own
   * card, or the 待办 it belongs to.
   */
  async function cardTarget(sessionId: string, target: 'session' | 'todo'): Promise<{ sessionId: string } | { itemId: string }> {
    const item = store.itemOf(sessionId)
    if (target === 'todo') {
      if (!item) throw refuse(409, 'proposal-target', 'This session belongs to no to-do on the board. Use target "session".')
      return { itemId: item.id }
    }
    if (item) throw refuse(409, 'proposal-target', 'This session is part of a to-do; propose for it with target "todo".')
    const summary = await context.hub.summary(sessionId).catch(() => undefined)
    if (!summary?.board?.card) throw refuse(409, 'proposal-target', 'This session has no card of its own on the board.')
    return { sessionId }
  }

  function answer(res: ServerResponse, caller: DeviceCaller, row: WorkProposalRecord, itemIds?: string[], status = 200): void {
    context.recheck(caller, 'view')
    visible(caller, row.id)
    const readable = (id: string) => {
      const item = store.get(id)
      return item !== undefined && (fullData(caller) || !itemPrivate(item))
    }
    const proposal = full(row, isPrivate(row))
    for (const entry of proposal.entries ?? []) if (entry.itemId && !readable(entry.itemId)) delete entry.itemId
    const visibleIds = itemIds?.filter(readable)
    json(res, { proposal, ...(visibleIds?.length ? { itemIds: visibleIds } : {}) } satisfies WorkProposalAnswer, status)
  }

  function replayed(caller: DeviceCaller, kind: 'accept' | 'dismiss', request: string, payloadHash: string, id: string) {
    const prior = store.receipt(kind, caller.device.id, request)
    if (!prior) return undefined
    if (prior.payloadHash !== payloadHash || prior.proposalId !== id) throw conflict()
    return prior
  }

  /**
   * Accept: the named entries (or every pending one), each as the person edited it, become unstarted 待办 in one write;
   * a change is made to its card. The audit lines come first and nothing is accepted without them. The 待办 records
   * where it came from (`from`, with `external`), is private when the proposal is, and starts without private context.
   */
  async function accept(res: ServerResponse, caller: DeviceCaller, id: string, raw: unknown): Promise<void> {
    context.requireScope(caller, 'run')
    context.limits.classC.take(caller.device.id)
    const body = acceptSchema.parse(raw)
    const row = visible(caller, id)
    if (row.change) {
      const { requestId: request, ...fields } = body
      const payloadHash = sha256Hex(canonicalJson({ id, ...fields }))
      if (replayed(caller, 'accept', request, payloadHash, id)) return answer(res, caller, row)
      if (row.revision !== body.baseRevision) throw changedError()
      return acceptChange(res, caller, row, request, payloadHash)
    }
    const accepted = await acceptTodos(caller, id, body)
    return answer(res, caller, accepted.row, accepted.itemIds)
  }

  /**
   * The 待办 half of an accept, for `POST …/accept` and for a team's start: the 待办 it made, in the order of their
   * entries. A retry of the same request answers the same ones and makes nothing.
   */
  async function acceptTodos(
    caller: DeviceCaller,
    id: string,
    body: z.infer<typeof acceptSchema>,
  ): Promise<{ row: WorkProposalRecord; itemIds: string[] }> {
    const { requestId: request, ...fields } = body
    const payloadHash = sha256Hex(canonicalJson({ id, ...fields }))
    const row = visible(caller, id)
    const prior = replayed(caller, 'accept', request, payloadHash, id)
    if (prior) return { row, itemIds: prior.itemIds ?? [] }
    if (row.revision !== body.baseRevision) throw changedError()
    if (!row.entries) throw decided()
    const pending = row.entries.flatMap((entry, index) => (entry.state === 'pending' ? [index] : []))
    const chosen: Array<z.infer<typeof entryEdit>> = body.entries ?? pending.map(index => ({ index }))
    if (new Set(chosen.map(edit => edit.index)).size !== chosen.length) throw new AppError(400, 'invalid-input', '同一项只能接受一次。')
    if (!chosen.length || chosen.some(edit => !pending.includes(edit.index))) throw decided()
    // Each 待办 as the person leaves it: their edits are checked as any 待办's are.
    const drafts = chosen.map(edit => {
      const entry = row.entries![edit.index]!
      const projectId = edit.projectId === null ? undefined : (edit.projectId ?? entry.projectId)
      if (projectId && !deps.projectExists(projectId)) throw new AppError(400, 'workspace-unavailable', '找不到所选项目')
      const harnessId = edit.harnessId === null ? undefined : (edit.harnessId ?? entry.harnessId)
      const tags = edit.tags === null ? undefined : edit.tags !== undefined ? tagsFor(edit.tags, false) : entry.tags
      return {
        index: edit.index,
        title: checkedTitle(edit.title ?? entry.title!),
        prompt: checkedPrompt(edit.prompt ?? entry.prompt!),
        ...(projectId ? { projectId } : {}),
        ...(harnessId ? { harnessId } : {}),
        ...(tags?.length ? { tags } : {}),
        id: newWorkItemId(),
      }
    })
    const priv = isPrivate(row)
    context.recheck(caller, 'run')
    try {
      await context.audited({
        action: 'work.proposal.decided',
        actor: context.actorOf(caller),
        target: id,
        detail: { proposalId: id, op: 'accepted', count: drafts.length, external: row.external },
      })
      for (const draft of drafts)
        await context.audited({
          action: 'work.item.changed',
          actor: context.actorOf(caller),
          target: draft.id,
          detail: { itemId: draft.id, revision: 1, op: 'created', titleHash: sha256Hex(draft.title) },
        })
    } catch {
      throw new AppError(503, 'audit-unavailable', '审计记录暂时无法保存，没有接受，请重试。')
    }
    const result = await store.transact((draft, at) => {
      context.recheck(caller, 'run')
      const target = draft.proposals.find(item => item.id === id)
      if (!target?.entries || (isPrivate(target) && !fullData(caller))) throw notFound()
      if (target.revision !== body.baseRevision) throw changedError()
      if (drafts.some(one => target.entries![one.index]?.state !== 'pending')) throw decided()
      const readable = [...draft.items.values()].filter(item => fullData(caller) || !itemPrivate(item)).length
      if (readable + drafts.length > WORK_ITEM_LIMITS.items)
        throw new AppError(409, 'item-limit', `待办最多 ${WORK_ITEM_LIMITS.items} 条，请先删除不需要的。`)
      if (draft.items.size + drafts.length > WORK_ITEMS_STORED)
        throw new AppError(409, 'item-store-full', '这台电脑上的待办记录已满，请先清理。')
      const made: WorkItemRecord[] = []
      for (const one of drafts) {
        const record: WorkItemRecord = {
          id: one.id,
          title: one.title,
          prompt: one.prompt,
          ...(one.projectId ? { projectId: one.projectId } : {}),
          ...(one.harnessId ? { harnessId: one.harnessId } : {}),
          ...(one.tags ? { tags: one.tags } : {}),
          from: {
            sessionId: target.from.sessionId,
            ...(target.from.customAgentId ? { customAgentId: target.from.customAgentId } : {}),
            ...(target.from.messageId ? { messageId: target.from.messageId } : {}),
            proposalId: target.id,
            ...(target.external ? { external: true as const } : {}),
          },
          sessionIds: [],
          // A model wrote what a start takes from it, whatever device accepts it: its start carries no private context.
          startScope: 'work',
          titleScope: 'work',
          // As private as the proposal is now, in this write: its session may have turned private meanwhile.
          ...(isPrivate(target) ? { private: true as const } : {}),
          createdAt: at,
          updatedAt: at,
          revision: 1,
        }
        draft.items.set(record.id, record)
        settle(target.entries![one.index]!, 'accepted', record.id)
        made.push(record)
      }
      if (isPrivate(target)) target.private = true
      forgetText(target)
      target.updatedAt = at
      target.revision++
      draft.receipts.push({
        kind: 'accept',
        deviceId: caller.device.id,
        requestId: request,
        proposalId: id,
        itemIds: made.map(item => item.id),
        requestHash: payloadHash,
        payloadHash,
        state: 'done',
        at,
      })
      return { result: { row: target, made }, changed: true }
    })
    for (const item of result.made) deps.itemChanged(item, [])
    deps.changed(result.row)
    return { row: result.row, itemIds: result.made.map(item => item.id) }
  }

  /** A change to a card: the 待办's in the same write as the proposal; a session's through its own metadata route first. */
  async function acceptChange(
    res: ServerResponse,
    caller: DeviceCaller,
    row: WorkProposalRecord,
    request: string,
    payloadHash: string,
  ): Promise<void> {
    const change = row.change!
    if (change.state !== 'pending') throw decided()
    const fields = {
      ...(change.title ? { title: change.title } : {}),
      ...(change.tags ? { tags: change.tags } : {}),
      ...(change.note ? { note: change.note } : {}),
    }
    const target = change.target
    let item: WorkItemRecord | undefined
    if ('itemId' in target) {
      item = store.get(target.itemId)
      if (!item || (itemPrivate(item) && !fullData(caller))) throw new AppError(404, 'item-not-found', '找不到这条待办。')
    }
    context.recheck(caller, 'run')
    try {
      await context.audited({
        action: 'work.proposal.decided',
        actor: context.actorOf(caller),
        target: row.id,
        detail: { proposalId: row.id, op: 'accepted', count: 1, external: row.external },
      })
      if (item)
        await context.audited({
          action: 'work.item.changed',
          actor: context.actorOf(caller),
          target: item.id,
          detail: { itemId: item.id, revision: item.revision + 1, op: 'edited', titleHash: sha256Hex(fields.title ?? item.title) },
        })
    } catch {
      throw new AppError(503, 'audit-unavailable', '审计记录暂时无法保存，没有接受，请重试。')
    }
    const result = await store.transact((draft, at) => {
      context.recheck(caller, 'run')
      const proposal = draft.proposals.find(one => one.id === row.id)
      if (!proposal?.change || (isPrivate(proposal) && !fullData(caller))) throw notFound()
      if (proposal.change.state !== 'pending') throw decided()
      let edited: WorkItemRecord | undefined
      if ('itemId' in target) {
        edited = draft.items.get(target.itemId)
        if (!edited) throw new AppError(404, 'item-not-found', '找不到这条待办。')
        if (fields.title) edited.title = fields.title
        if (fields.tags) edited.tags = fields.tags
        if (fields.note) edited.note = fields.note
        edited.updatedAt = at
        edited.revision++
      }
      proposal.change = { target: proposal.change.target, state: 'accepted' }
      proposal.updatedAt = at
      proposal.revision++
      draft.receipts.push({
        kind: 'accept',
        deviceId: caller.device.id,
        requestId: request,
        proposalId: proposal.id,
        requestHash: payloadHash,
        payloadHash,
        state: 'done',
        at,
      })
      return { result: { proposal, edited, before: structuredClone(change) }, changed: true }
    })
    // A session's card is changed only once the proposal is taken in the write above, so a dismissal racing it cannot
    // leave the change made and the proposal dismissed. When the session refuses the change, the proposal waits again.
    if ('sessionId' in target)
      try {
        await deps.changeSession(caller, target.sessionId, fields)
      } catch (error) {
        await store
          .transact(draft => {
            const proposal = draft.proposals.find(one => one.id === row.id)
            if (!proposal?.change || proposal.change.state !== 'accepted') return { result: undefined, changed: false }
            proposal.change = result.before
            proposal.revision++
            draft.receipts = draft.receipts.filter(
              receipt => !(receipt.kind === 'accept' && receipt.deviceId === caller.device.id && receipt.requestId === request),
            )
            return { result: undefined, changed: true }
          })
          .catch(() => {})
        throw error
      }
    if (result.edited) deps.itemChanged(result.edited, result.edited.sessionIds)
    deps.changed(result.proposal)
    return answer(res, caller, result.proposal)
  }

  /** 不要: the named entries, or all still pending. Its audit line comes first; a missing one does not stop it. */
  async function dismiss(res: ServerResponse, caller: DeviceCaller, id: string, raw: unknown): Promise<void> {
    context.requireScope(caller, 'run')
    context.limits.classC.take(caller.device.id)
    const body = dismissSchema.parse(raw)
    const { requestId: request, ...fields } = body
    const payloadHash = sha256Hex(canonicalJson({ id, ...fields }))
    const row = visible(caller, id)
    if (replayed(caller, 'dismiss', request, payloadHash, id)) return answer(res, caller, row)
    if (row.revision !== body.baseRevision) throw changedError()
    const pending = row.entries
      ? row.entries.flatMap((entry, index) => (entry.state === 'pending' ? [index] : []))
      : row.change?.state === 'pending'
        ? [0]
        : []
    const chosen = row.entries ? (body.entries ?? pending) : pending
    if (!chosen.length || chosen.some(index => !pending.includes(index))) throw decided()
    context.recheck(caller, 'run')
    await context.audited(
      {
        action: 'work.proposal.decided',
        actor: context.actorOf(caller),
        target: id,
        detail: { proposalId: id, op: 'dismissed', count: chosen.length, external: row.external },
      },
      res,
    )
    const result = await store.transact((draft, at) => {
      context.recheck(caller, 'run')
      const target = draft.proposals.find(item => item.id === id)
      if (!target || (isPrivate(target) && !fullData(caller))) throw notFound()
      if (target.revision !== body.baseRevision) throw changedError()
      if (target.entries) {
        if (chosen.some(index => target.entries![index]?.state !== 'pending')) throw decided()
        for (const index of chosen) settle(target.entries[index]!, 'dismissed')
        forgetText(target)
      } else if (target.change) {
        if (target.change.state !== 'pending') throw decided()
        target.change = { target: target.change.target, state: 'dismissed' }
      }
      target.updatedAt = at
      target.revision++
      draft.receipts.push({
        kind: 'dismiss',
        deviceId: caller.device.id,
        requestId: request,
        proposalId: id,
        requestHash: payloadHash,
        payloadHash,
        state: 'done',
        at,
      })
      return { result: target, changed: true }
    })
    deps.changed(result)
    return answer(res, caller, result)
  }

  /**
   * The proposals this device may read and that still wait for the person, for the snapshot. A private one only for the
   * full data scope, and never counted elsewhere.
   */
  function summaries(scope: DataScope | undefined): WorkProposalSummary[] {
    return store.proposals().flatMap(row => {
      if (!proposalPending(row)) return []
      const priv = isPrivate(row)
      if (priv && scope !== 'all') return []
      return [proposalSummary(row, priv)]
    })
  }

  /**
   * A session was deleted: what it proposed and has not been decided goes (there is nothing left to link it to), and so
   * does any change waiting for its card. Decided rows stay, stripped, for their receipts.
   */
  async function sessionDeleted(sessionId: string): Promise<void> {
    const gone = (row: WorkProposalRecord) =>
      proposalPending(row)
      && (row.from.sessionId === sessionId
        || (row.change !== undefined && 'sessionId' in row.change.target && row.change.target.sessionId === sessionId))
    if (!store.proposals().some(gone)) return
    const removed = await store.transact((draft, at) => {
      const touched = draft.proposals.filter(gone)
      const decidedPart = (row: WorkProposalRecord) => row.entries?.some(entry => entry.state !== 'pending') === true
      for (const row of touched.filter(decidedPart)) {
        for (const entry of row.entries!) if (entry.state === 'pending') settle(entry, 'dismissed')
        forgetText(row)
        row.updatedAt = at
        row.revision++
      }
      draft.proposals = draft.proposals.filter(row => !gone(row) || decidedPart(row))
      return { result: touched, changed: touched.length > 0 }
    })
    for (const row of removed) deps.changed(row)
  }

  /** A 待办 was deleted: a change waiting for its card goes with it. */
  async function itemDeleted(itemId: string): Promise<void> {
    const gone = (row: WorkProposalRecord) =>
      proposalPending(row) && row.change !== undefined && 'itemId' in row.change.target && row.change.target.itemId === itemId
    if (!store.proposals().some(gone)) return
    const removed = await store.transact(draft => {
      const dropped = draft.proposals.filter(gone)
      draft.proposals = draft.proposals.filter(row => !gone(row))
      return { result: dropped, changed: dropped.length > 0 }
    })
    for (const row of removed) deps.changed(row)
  }

  const module: RouteModule = {
    features: () => ({ workProposals: true }) satisfies HostFeatures,
    async route({ req, res, caller, path, method }) {
      if (!path.startsWith('/link/api/work/proposals')) return false
      context.requireScope(caller, 'view')
      const match = ROOT.exec(path)
      if (!match) throw notFound()
      const id = match[1]!,
        action = match[2]
      if (!action && method === 'GET') {
        answer(res, caller, visible(caller, id))
      } else if (action === 'accept' && method === 'POST') await accept(res, caller, id, await jsonBody(req, BODY_LIMIT))
      else if (action === 'dismiss' && method === 'POST') await dismiss(res, caller, id, await jsonBody(req, BODY_LIMIT))
      else throw new AppError(404, 'not-found', '接口不存在。')
      return true
    },
  }
  return { module, intake, summaries, sessionDeleted, itemDeleted, isPrivate, acceptTodos }
}

export type WorkProposalRoutes = ReturnType<typeof createWorkProposalRoutes>
