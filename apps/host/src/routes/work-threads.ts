import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import {
  containsSecret,
  refusedBeforeAccepting,
  WORK_THREAD_LIMITS,
  type AgentQuestion,
  type DataScope,
  type HostFeatures,
  type TaskDetail,
  type TaskSummary,
  type WorkPost,
  type WorkPostAnswer,
  type WorkPostReplyAnswer,
  type WorkThreadAnswer,
} from '@latch/protocol'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { setPostAttention, type WorkItemPostAttention } from '../board.ts'
import { json, jsonBody, KIB } from '../http-util.ts'
import { itemIsPrivate, type WorkItemRecord, type WorkItemStore } from '../work-items.ts'
import {
  cut,
  checkedPostText,
  delivered,
  deliveryText,
  replyTo,
  workPostTurn,
  type QuotedPart,
  type WorkPostRecord,
  type WorkThreadStore,
} from '../work-threads.ts'
import type { DeviceCaller, RouteContext, RouteModule } from './registry.ts'

/** What an Agent's one chat is now (`custom-agents.ts`): only a `ready` one takes a post. */
export type AgentChatSlot = { state: 'ready'; sessionId: string } | { state: 'empty' } | { state: 'starting' }

export interface WorkThreadRouteDeps {
  threads: WorkThreadStore
  items: WorkItemStore
  /**
   * `POST /tasks/:id/prompt` without queueing or steering: the same access, workspace, private-context and receipt
   * checks (`sendPrompt`). `agent`: the target is an Agent's chat; the turn is recorded as carrying outside content
   * (`PromptOptions.outsideContent`, refused by a driver that cannot), and `remember` is what the person's 「记住…」 may
   * take, and nothing else.
   */
  deliver: (
    caller: DeviceCaller,
    sessionId: string,
    input: { requestId: string; prompt: string },
    agent: { remember: string } | undefined,
    /**
     * Whose words the prompt carries besides the caller's: the devices that wrote the posts it quotes, and `narrower`
     * when the 待办 itself was written by a device below the full data scope. A device-input grant needs all of them.
     */
    writers: { coauthors: readonly string[]; narrower: boolean },
  ) => Promise<void>
  /** The person's 「记住…」 from a post already in the chat; keyed by device and request, so it is made once. */
  remember: (caller: DeviceCaller, sessionId: string, text: string, requestId: string) => Promise<void>
  /** The Agent's one chat; undefined when there is no such Agent. Throws while old chats are not yet sorted. */
  agentChat: (caller: DeviceCaller, customAgentId: string) => Promise<AgentChatSlot | undefined>
  /** The name a quote gives an Agent. */
  agentName: (customAgentId: string) => string
  /** The Host's question IDs; the discussion never includes their prompts or options. */
  questions: (sessionId: string) => readonly AgentQuestion[]
  /** 我的 Agent hold private memory: the full data scope and `run`, as any write to one. */
  agentAccess: (caller: DeviceCaller) => void
  /** Clients read the 待办 (and so its thread) again; a private one tells devices with the full data scope only. */
  changed: (item: WorkItemRecord) => void
}

export interface WorkThreadRoutes extends RouteModule {
  attention(
    caller: DeviceCaller,
    records: readonly WorkItemRecord[],
    tasks?: readonly TaskSummary[],
  ): Promise<ReadonlyMap<string, WorkItemPostAttention>>
}

const POSTS = /^\/link\/api\/work\/items\/(itm_[A-Za-z0-9_-]{22})\/posts(?:\/(pst_[A-Za-z0-9_-]{22})(\/reply)?)?$/u
const POSTS_PAGE = 32
const REPLY_PAGE = 16_000
const POST_BODY_LIMIT = 32 * KIB
const BUSY = new Set<TaskSummary['status']>(['running', 'waiting-approval'])
const postSchema = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  text: z.string().max(WORK_THREAD_LIMITS.postChars * 2),
  target: z
    .union([
      z.strictObject({ sessionId: z.string().min(1).max(256) }),
      z.strictObject({ customAgentId: z.string().regex(/^(general|agt_[a-f0-9-]{36})$/u) }),
    ])
    .optional(),
})

const notFound = () => new AppError(404, 'item-not-found', '找不到这条待办。')
const replyNotFound = () => new AppError(404, 'post-reply-not-found', '找不到这条回复。')
const conflict = () => new AppError(409, 'request-conflict', '同一个请求标识不能用于不同内容。')
const postIdSchema = z.string().regex(/^pst_[A-Za-z0-9_-]{22}$/u)
const replyQuerySchema = z.strictObject({
  messageId: z.string().min(1).max(256).optional(),
  offset: z
    .string()
    .regex(/^\d{1,9}$/u)
    .transform(Number)
    .optional(),
})

function queryOf(req: IncomingMessage): Record<string, string> {
  const query = new URL(req.url ?? '/', 'http://latch.invalid').searchParams
  if (query.size !== new Set(query.keys()).size) throw new AppError(400, 'post-query-invalid', '讨论读取位置无效。')
  return Object.fromEntries(query)
}

/**
 * The session-side request of a post's delivery, derived from the device, the 待办 and the post's request, so a retry
 * sends the same one. Not secret: the device can compute it, so it only keeps the device's own posts apart from its own
 * other prompts.
 */
/** A post's ID from its request: a retry, or the same request sent twice at once, names the same post in its audit line. */
function postIdOf(deviceId: string, itemId: string, requestId: string): string {
  return `pst_${Buffer.from(sha256Hex(canonicalJson(['work-item-post-id', deviceId, itemId, requestId])), 'hex')
    .toString('base64url')
    .slice(0, 22)}`
}

function deliveryRequestId(deviceId: string, itemId: string, requestId: string): string {
  const hex = sha256Hex(canonicalJson(['work-item-post', deviceId, itemId, requestId]))
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * A 待办's thread (docs/ARCHITECTURE.md#待办的讨论): only a person posts, and a post goes to at most one target, one of
 * the 待办's sessions or one of 我的 Agent in its one chat. Replies are read from the session and never copied in, so
 * nothing in a reply wakes anyone. Reading and posting follow the 待办's own visibility: a private one, and so its
 * thread, is a missing one to a device without the full data scope.
 */
export function createWorkThreadRoutes(context: RouteContext, deps: WorkThreadRouteDeps): WorkThreadRoutes {
  const { threads, items } = deps
  /** Deliveries under way, by post: a retry meanwhile waits for the same one instead of sending again. */
  const sending = new Map<string, Promise<void>>()
  /** Posts being made, by device and request: the same request sent twice at once waits for the first. */
  const posting = new Map<string, Promise<unknown>>()
  const scopeOf = (caller: DeviceCaller): DataScope => context.devices.get(caller.device.id)?.dataScope ?? 'work'
  const fullData = (caller: DeviceCaller) => scopeOf(caller) === 'all'
  const sessionPrivate = (id: string) => context.hub.agentPrivate(id)
  const seesSession = (caller: DeviceCaller, id: string) => fullData(caller) || !sessionPrivate(id)

  /** As `GET /work/items/:id`: a private 待办 to the full data scope only, else as if it did not exist. */
  function visible(caller: DeviceCaller, id: string): WorkItemRecord {
    const item = items.get(id)
    if (!item || (itemIsPrivate(item, sessionPrivate) && !fullData(caller))) throw notFound()
    return item
  }

  async function detailOf(sessionId: string): Promise<TaskDetail | undefined> {
    return context.hub.detail(sessionId).catch(() => undefined)
  }

  function sourceVisible(caller: DeviceCaller, detail: TaskDetail): boolean {
    const { id, harnessId } = detail.summary
    return context.hub.ownerOf(id) === harnessId && seesSession(caller, id)
  }

  async function readSource(caller: DeviceCaller, sessionId: string): Promise<TaskDetail | undefined> {
    if (!seesSession(caller, sessionId)) return undefined
    const detail = await detailOf(sessionId)
    if (!detail || detail.summary.id !== sessionId || !sourceVisible(caller, detail)) return undefined
    // A driver can return a detail it read before a delete. Confirm the source without reading its body again.
    const summary = await context.hub.summary(sessionId).catch(() => undefined)
    return summary?.harnessId === detail.summary.harnessId && sourceVisible(caller, detail) ? detail : undefined
  }

  async function attention(caller: DeviceCaller, records: readonly WorkItemRecord[], tasks?: readonly TaskSummary[]) {
    const openItems = new Set(records.filter(item => !item.closedAt).map(item => item.id))
    const unknown = [...openItems].flatMap(id =>
      threads.unknownIn(id).filter(({ post }) => !sending.has(post.id) && seesSession(caller, post.delivery.sessionId)),
    )
    const sources = new Set(unknown.map(({ post }) => post.delivery.sessionId))
    if (tasks) {
      for (const task of tasks) {
        if (task.board?.group !== 'attention' || !task.runId || !seesSession(caller, task.id)) continue
        const links = threads.deliveriesIn(task.id)
        if (links && [...links.values()].some(link => openItems.has(link.itemId))) sources.add(task.id)
      }
    } else {
      for (const itemId of openItems) {
        for (const { delivery } of threads.get(itemId)?.posts ?? [])
          if (delivery && seesSession(caller, delivery.sessionId)) sources.add(delivery.sessionId)
      }
    }
    const result = new Map<string, WorkItemPostAttention>()
    const held = new Set<string>()
    const ids = [...sources]
    for (let offset = 0; offset < ids.length; offset += 4) {
      const details = await Promise.all(ids.slice(offset, offset + 4).map(detailOf))
      for (const detail of details) {
        if (!detail || !seesSession(caller, detail.summary.id)) continue
        const links = threads.deliveriesIn(detail.summary.id)
        if (!links) continue
        const input = detail.messages.findLast(message => message.role === 'user' && !message.steered)
        const link = input?.requestId ? links.get(input.requestId) : undefined
        const { summary } = detail
        if (
          link
          && openItems.has(link.itemId)
          && summary.board?.group === 'attention'
          && summary.board.reason
          && workPostTurn(detail, link.post.delivery.requestId)?.current
        )
          setPostAttention(result, link.itemId, { postId: link.post.id, reason: summary.board.reason })
        for (const message of detail.messages) {
          if (message.role !== 'user' || message.steered || !message.requestId) continue
          const found = links.get(message.requestId)
          if (found?.post.delivery.state === 'unknown') held.add(found.post.id)
        }
      }
    }
    for (const { itemId, post } of unknown) {
      if (
        !held.has(post.id)
        && seesSession(caller, post.delivery.sessionId)
        && !sending.has(post.id)
        && threads.unknownIn(itemId).some(link => link.post.id === post.id)
      )
        setPostAttention(result, itemId, { postId: post.id, reason: 'unknown' })
    }
    // The caller rechecks its own view/window before publishing this. A source can turn private during a later read.
    for (const [itemId, place] of result) {
      const delivery = threads.get(itemId)?.posts.find(post => post.id === place.postId)?.delivery
      if (!delivery || !seesSession(caller, delivery.sessionId)) result.delete(itemId)
    }
    return result
  }

  function present(caller: DeviceCaller, post: WorkPostRecord, detail?: TaskDetail): WorkPost {
    const { deviceId, requestId, payloadHash: _hash, delivery, target, ...rest } = post
    const source = delivery && detail?.summary.id === delivery.sessionId && sourceVisible(caller, detail) ? detail : undefined
    const reading = delivery && source ? workPostTurn(source, delivery.requestId) : undefined
    const held = reading !== undefined
    const state = delivery ? (held ? 'sent' : sending.has(post.id) ? 'sending' : delivery.state) : undefined
    const lastReply = reading?.replies.at(-1)
    const preview = lastReply && cut(lastReply.text, WORK_THREAD_LIMITS.replyChars)
    const reason = reading?.current && source?.summary.board?.group === 'attention' ? source.summary.board.reason : undefined
    const decisionId =
      reason === 'approval'
        ? source?.approvals.find(approval => approval.sessionId === delivery?.sessionId)?.id
        : reason === 'question' && source
          ? deps.questions(source.summary.id).find(question => reading?.rows.some(row => row.id === `tool:${question.toolCallId}`))?.id
          : undefined
    return {
      ...structuredClone(rest),
      ...(target && source ? { target: structuredClone(target) } : {}),
      ...(deviceId === caller.device.id ? { requestId } : {}),
      ...(delivery && state
        ? {
            delivery: {
              ...(source ? { sessionId: delivery.sessionId } : {}),
              state,
              ...(source && delivery.reason && !held ? { reason: delivery.reason } : {}),
              ...(source && delivery.code && !held ? { code: delivery.code } : {}),
            },
          }
        : {}),
      ...(reading ? { turn: reading.turn } : {}),
      ...(preview && lastReply
        ? {
            reply: {
              messageId: lastReply.messageId,
              text: preview.text,
              ...(preview.more ? { more: true as const } : {}),
              ...(reading?.live ? { live: true as const } : {}),
            },
          }
        : {}),
      ...(reason || state === 'unknown' ? { attention: { reason: reason ?? 'unknown', ...(decisionId ? { decisionId } : {}) } } : {}),
    }
  }

  async function list(caller: DeviceCaller, id: string, before: string | undefined): Promise<WorkThreadAnswer> {
    visible(caller, id)
    const thread = threads.get(id)
    const posts = thread?.posts ?? []
    const end = before ? posts.findIndex(post => post.id === before) : posts.length
    if (end < 0) throw new AppError(404, 'post-page-not-found', '找不到这页发言。')
    const start = before || caller.nativeOpening ? Math.max(0, end - POSTS_PAGE) : 0
    const page = posts.slice(start, end)
    const ids = new Set(page.flatMap(post => (post.delivery ? [post.delivery.sessionId] : [])))
    const details = new Map(await Promise.all([...ids].map(async sessionId => [sessionId, await readSource(caller, sessionId)] as const)))
    context.recheck(caller, 'view')
    visible(caller, id)
    return {
      posts: page.map(post => present(caller, post, post.delivery && details.get(post.delivery.sessionId))),
      revision: thread?.revision ?? 0,
      ...(start > 0 ? { before: page[0]!.id } : {}),
    }
  }

  async function reply(caller: DeviceCaller, itemId: string, postId: string, req: IncomingMessage): Promise<WorkPostReplyAnswer> {
    visible(caller, itemId)
    const query = replyQuerySchema.parse(queryOf(req))
    const offset = query.offset ?? 0
    if (offset > 0 && !query.messageId) throw new AppError(400, 'post-query-invalid', '讨论读取位置无效。')
    const delivery = threads.get(itemId)?.posts.find(post => post.id === postId)?.delivery
    if (!delivery) throw replyNotFound()
    const detail = await readSource(caller, delivery.sessionId)
    context.recheck(caller, 'view')
    visible(caller, itemId)
    if (!detail || !sourceVisible(caller, detail)) throw replyNotFound()
    const reading = workPostTurn(detail, delivery.requestId)
    const message = query.messageId ? reading?.replies.find(row => row.messageId === query.messageId) : reading?.replies.at(-1)
    if (!reading || !message) throw replyNotFound()
    const text = [...message.text]
    if (offset >= text.length) throw new AppError(400, 'post-query-invalid', '讨论读取位置无效。')
    const next = offset + REPLY_PAGE
    return {
      turn: reading.turn,
      messageId: message.messageId,
      text: text.slice(offset, next).join(''),
      ...(next < text.length ? { nextOffset: next } : {}),
    }
  }

  /**
   * What the thread gained since `sessionId` was last addressed, before `post`: the person's other posts, and the replies
   * other sessions gave to them. A target that is not private gets nothing that went to or came from a private one (an
   * Agent's chat), so a session a narrower device reads never carries it.
   */
  async function increment(
    posts: readonly WorkPostRecord[],
    post: WorkPostRecord,
    sessionId: string,
  ): Promise<{ parts: QuotedPart[]; authors: string[] }> {
    const index = posts.findIndex(entry => entry.id === post.id)
    const before = posts.slice(0, index < 0 ? posts.length : index)
    const last = before.findLastIndex(
      entry => entry.delivery?.sessionId === sessionId && (entry.delivery.state === 'sent' || entry.delivery.state === 'unknown'),
    )
    const targetPrivate = sessionPrivate(sessionId)
    const parts: QuotedPart[] = []
    // Every post quoted, though the delivery may later drop the oldest to fit: a superset of whose words go.
    const authors = new Set<string>()
    for (const entry of before.slice(last + 1)) {
      const to = entry.target
      if (to && 'customAgentId' in to && !targetPrivate) continue
      const other = entry.delivery && entry.delivery.sessionId !== sessionId ? entry.delivery : undefined
      if (other && sessionPrivate(other.sessionId) && !targetPrivate) continue
      parts.push({ label: to ? `我（发给 ${await targetName(to)}）` : '我', text: entry.text })
      authors.add(entry.deviceId)
      if (!other || other.state === 'failed') continue
      const detail = await detailOf(other.sessionId)
      const reply = detail && replyTo(detail.messages, other.requestId, false)
      if (reply) parts.push({ label: `${await targetName(entry.target!)} 的回复`, text: reply.text + (reply.more ? '\n…' : '') })
    }
    return { parts, authors: [...authors] }
  }

  async function targetName(target: NonNullable<WorkPostRecord['target']>): Promise<string> {
    if ('customAgentId' in target) return `「${deps.agentName(target.customAgentId)}」`
    const summary = await context.hub.summary(target.sessionId).catch(() => undefined)
    return `会话「${summary?.title || '未命名会话'}」`
  }

  /** Where a post goes now: the member session, or the Agent's chat while it is ready and idle. */
  async function resolve(caller: DeviceCaller, item: WorkItemRecord, target: NonNullable<WorkPostRecord['target']>): Promise<string> {
    if ('sessionId' in target) {
      if (!item.sessionIds.includes(target.sessionId)) throw new AppError(409, 'post-target-gone', '这个会话不在这条待办里。')
      return target.sessionId
    }
    deps.agentAccess(caller)
    const chat = await deps.agentChat(caller, target.customAgentId)
    if (!chat) throw new AppError(404, 'agent-not-found', '找不到这个 Agent。')
    // Its first message starts the chat, and a session started that way could propose before it was marked; it starts
    // from the Agent's own page.
    if (chat.state === 'empty') throw new AppError(409, 'agent-chat-empty', '先在这个 Agent 的聊天里开始。')
    if (chat.state === 'starting') throw new AppError(409, 'agent-chat-starting', '这个 Agent 的聊天还在确认是否开始。')
    return chat.sessionId
  }

  async function idle(sessionId: string): Promise<void> {
    const summary = await context.hub.summary(sessionId)
    if (BUSY.has(summary.status)) throw new AppError(409, 'post-target-busy', '它正在运行，这一轮结束后再发。')
  }

  async function settle(itemId: string, postId: string, delivery: Partial<NonNullable<WorkPostRecord['delivery']>>): Promise<void> {
    await threads.transact(itemId, posts => {
      const post = posts.find(entry => entry.id === postId)
      if (!post?.delivery) return { result: undefined, changed: false }
      const { reason: _reason, code: _code, ...kept } = post.delivery
      post.delivery = { ...kept, ...delivery }
      return { result: undefined, changed: true }
    })
  }

  /**
   * Sends a kept post to its session, once: a session that already holds its request settles it as sent without
   * sending. An Agent's chat is marked as carrying outside content before anything reaches it, so what that turn and
   * the ones after it propose say 「来自外部内容」; without the mark nothing is sent. Its memory takes only the
   * person's own words. Not queued: a session in a turn refuses, and the post can be sent again later.
   */
  function deliver(caller: DeviceCaller, itemId: string, postId: string): Promise<void> {
    const running = sending.get(postId)
    if (running) return running
    const work = (async () => {
      const post = threads.get(itemId)?.posts.find(entry => entry.id === postId)
      if (!post?.delivery || !post.target) return
      const { sessionId, requestId } = post.delivery
      const agent = 'customAgentId' in post.target
      /** Set once the text is handed to the session: before that, any failure certainly sent nothing. */
      let handed = false
      try {
        if (agent) deps.agentAccess(caller)
        const detail = await context.hub.detail(sessionId)
        context.recheck(caller, 'run')
        visible(caller, itemId)
        if (delivered(detail.messages, requestId)) {
          // Its answer was lost: the person's 「记住…」 is made now, once (the proposal is keyed by the request).
          if (agent) await deps.remember(caller, sessionId, post.text, requestId)
          await settle(itemId, postId, { state: 'sent' })
          return
        }
        await idle(sessionId)
        const item = visible(caller, itemId)
        if (!agent && !item.sessionIds.includes(sessionId)) throw new AppError(409, 'post-target-gone', '这个会话不在这条待办里。')
        // A private 待办's title and thread stay with devices that may read it: a session they cannot read gets only the
        // person's own words. Read again after the quotes are gathered, since the 待办 may have turned private meanwhile.
        const ownWords = () => itemIsPrivate(visible(caller, itemId), sessionPrivate) && !sessionPrivate(sessionId)
        const quoted = ownWords() ? undefined : await increment(threads.get(itemId)?.posts ?? [], post, sessionId)
        let prompt = quoted ? deliveryText(item.title, post.text, quoted.parts) : post.text
        let writers = { coauthors: quoted?.authors ?? [], narrower: quoted !== undefined && item.startScope !== 'all' }
        if (ownWords()) {
          prompt = post.text
          writers = { coauthors: [], narrower: false }
        }
        context.recheck(caller, 'run')
        if (agent) deps.agentAccess(caller)
        handed = true
        await deps.deliver(caller, sessionId, { requestId, prompt }, agent ? { remember: post.text } : undefined, writers)
        await settle(itemId, postId, { state: 'sent' })
      } catch (error) {
        const known = error instanceof AppError
        // A conflict means a request with this ID reached the session: what happened is not known here.
        const failed =
          !handed
          || (known
            && (error.code === 'post-unmarked' || (refusedBeforeAccepting(error.status, error.code) && error.code !== 'request-conflict')))
        if (known && error.code === 'post-unmarked') context.log('待办的发言没有发出：这个 Harness 不能标记外部内容')
        await settle(itemId, postId, {
          state: failed ? 'failed' : 'unknown',
          ...(known && /^[a-z0-9-]{1,64}$/u.test(error.code) ? { code: error.code } : {}),
          reason: known ? error.message.slice(0, 300) : '没有确认送达。',
        }).catch(() => {})
      }
    })().finally(() => {
      sending.delete(postId)
      const item = items.get(itemId)
      if (item) deps.changed(item)
    })
    sending.set(postId, work)
    return work
  }

  async function post(req: IncomingMessage, caller: DeviceCaller, id: string): Promise<{ post: WorkPost; status: number }> {
    context.requireScope(caller, 'run')
    context.limits.classC.take(caller.device.id)
    const body = postSchema.parse(await jsonBody(req, POST_BODY_LIMIT))
    let item = visible(caller, id)
    const text = checkedPostText(body.text)
    if (containsSecret(text)) throw new AppError(400, 'post-secret', '发言看起来含有密钥，没有发出。')
    const payloadHash = sha256Hex(canonicalJson({ text, target: body.target ?? null }))
    const key = `${id}:${caller.device.id}:${body.requestId}`
    for (let held = posting.get(key); held; held = posting.get(key)) await held.catch(() => {})
    const made = make(caller, id, body, text, payloadHash, item)
    posting.set(key, made)
    try {
      return await made
    } finally {
      if (posting.get(key) === made) posting.delete(key)
    }
  }

  async function make(
    caller: DeviceCaller,
    id: string,
    body: z.infer<typeof postSchema>,
    text: string,
    payloadHash: string,
    seen: WorkItemRecord,
  ): Promise<{ post: WorkPost; status: number }> {
    let item = seen
    const prior = threads.find(id, caller.device.id, body.requestId)
    if (prior) {
      if (prior.payloadHash !== payloadHash) throw conflict()
      if (prior.delivery && prior.delivery.state !== 'sent') await deliver(caller, id, prior.id)
      return { post: await answerFor(caller, id, prior.id), status: 200 }
    }
    if ((threads.get(id)?.posts.length ?? 0) >= WORK_THREAD_LIMITS.posts)
      throw new AppError(409, 'thread-full', `一条待办最多 ${WORK_THREAD_LIMITS.posts} 条发言。`)
    const sessionId = body.target ? await resolve(caller, item, body.target) : undefined
    if (sessionId) {
      await idle(sessionId)
      context.recheck(caller, 'run')
      item = visible(caller, id)
      if ('sessionId' in body.target! && !item.sessionIds.includes(sessionId))
        throw new AppError(409, 'post-target-gone', '这个会话不在这条待办里。')
    }
    const agent = body.target !== undefined && 'customAgentId' in body.target
    const postId = postIdOf(caller.device.id, id, body.requestId)
    // An Agent's chat is private: the 待办 is private before anything names it, and stays so. Narrowing comes before the
    // audit line, so a refusal here leaves no line claiming a post.
    if (agent && !item.private) {
      deps.agentAccess(caller)
      await items.markPrivate(id)
    }
    // On record before it is kept or sent: an audit that cannot be written stops it.
    try {
      await context.audited({
        action: 'work.item.posted',
        actor: context.actorOf(caller),
        target: id,
        detail: { itemId: id, postId, target: !body.target ? 'none' : agent ? 'agent' : 'session', ...(sessionId ? { sessionId } : {}) },
      })
    } catch {
      throw new AppError(503, 'audit-unavailable', '审计记录暂时无法保存，没有发出，请重试。')
    }
    const kept = await threads.transact(id, (posts, at) => {
      const again = posts.find(entry => entry.deviceId === caller.device.id && entry.requestId === body.requestId)
      if (again) {
        if (again.payloadHash !== payloadHash) throw conflict()
        return { result: again, changed: false }
      }
      if (posts.length >= WORK_THREAD_LIMITS.posts)
        throw new AppError(409, 'thread-full', `一条待办最多 ${WORK_THREAD_LIMITS.posts} 条发言。`)
      const record: WorkPostRecord = {
        id: postId,
        at,
        deviceId: caller.device.id,
        requestId: body.requestId,
        payloadHash,
        text,
        ...(body.target ? { target: body.target } : {}),
        ...(sessionId
          ? { delivery: { requestId: deliveryRequestId(caller.device.id, id, body.requestId), sessionId, state: 'unknown' as const } }
          : {}),
      }
      posts.push(record)
      return { result: record, changed: true }
    })
    const now = items.get(id)
    if (now) deps.changed(now)
    if (kept.delivery) await deliver(caller, id, kept.id)
    return { post: await answerFor(caller, id, kept.id), status: 201 }
  }

  async function answerFor(caller: DeviceCaller, id: string, postId: string): Promise<WorkPost> {
    visible(caller, id)
    const post = threads.get(id)?.posts.find(entry => entry.id === postId)
    if (!post) throw new AppError(404, 'post-not-found', '找不到这条发言。')
    const delivery = post.delivery
    const detail = delivery ? await readSource(caller, delivery.sessionId) : undefined
    context.recheck(caller, 'view')
    visible(caller, id)
    return present(caller, post, detail)
  }

  return {
    attention,
    features: () => ({ workItemTurns: true }) satisfies HostFeatures,
    async route({ req, res, caller, path, method }) {
      const match = POSTS.exec(path)
      if (!match) return false
      context.requireScope(caller, 'view')
      const id = match[1]!
      if (method === 'GET') {
        if (match[2] && match[3]) json(res, await reply(caller, id, match[2], req))
        else if (match[2]) json(res, { post: await answerFor(caller, id, match[2]) } satisfies WorkPostAnswer)
        else {
          visible(caller, id)
          const { before } = z.strictObject({ before: postIdSchema.optional() }).parse(queryOf(req))
          json(res, await list(caller, id, before))
        }
        return true
      }
      if (method !== 'POST' || match[2]) throw new AppError(404, 'not-found', '接口不存在。')
      const { post: answer, status } = await post(req, caller, id)
      json(res, { post: answer } satisfies WorkPostAnswer, status)
      return true
    },
  }
}
