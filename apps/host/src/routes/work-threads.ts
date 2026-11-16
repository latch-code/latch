import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import {
  containsSecret,
  refusedBeforeAccepting,
  WORK_THREAD_LIMITS,
  type DataScope,
  type TaskDetail,
  type TaskSummary,
  type WorkPost,
  type WorkPostAnswer,
  type WorkThreadAnswer,
} from '@latch/protocol'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { json, jsonBody, KIB } from '../http-util.ts'
import { itemIsPrivate, type WorkItemRecord, type WorkItemStore } from '../work-items.ts'
import {
  checkedPostText,
  delivered,
  deliveryText,
  replyTo,
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
    agent?: { remember: string },
  ) => Promise<void>
  /** The person's 「记住…」 from a post already in the chat; keyed by device and request, so it is made once. */
  remember: (caller: DeviceCaller, sessionId: string, text: string, requestId: string) => Promise<void>
  /** The Agent's one chat; undefined when there is no such Agent. Throws while old chats are not yet sorted. */
  agentChat: (caller: DeviceCaller, customAgentId: string) => Promise<AgentChatSlot | undefined>
  /** The name a quote gives an Agent. */
  agentName: (customAgentId: string) => string
  /** 我的 Agent hold private memory: the full data scope and `run`, as any write to one. */
  agentAccess: (caller: DeviceCaller) => void
  /** Clients read the 待办 (and so its thread) again; a private one tells devices with the full data scope only. */
  changed: (item: WorkItemRecord) => void
}

const ONE = /^\/link\/api\/work\/items\/(itm_[A-Za-z0-9_-]{22})\/posts$/u
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
const conflict = () => new AppError(409, 'request-conflict', '同一个请求标识不能用于不同内容。')

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
export function createWorkThreadRoutes(context: RouteContext, deps: WorkThreadRouteDeps): RouteModule {
  const { threads, items } = deps
  /** Deliveries under way, by post: a retry meanwhile waits for the same one instead of sending again. */
  const sending = new Map<string, Promise<void>>()
  /** Posts being made, by device and request: the same request sent twice at once waits for the first. */
  const posting = new Map<string, Promise<unknown>>()
  const scopeOf = (caller: DeviceCaller): DataScope => context.devices.get(caller.device.id)?.dataScope ?? 'work'
  const fullData = (caller: DeviceCaller) => scopeOf(caller) === 'all'
  const sessionPrivate = (id: string) => context.hub.agentPrivate(id)

  /** As `GET /work/items/:id`: a private 待办 to the full data scope only, else as if it did not exist. */
  function visible(caller: DeviceCaller, id: string): WorkItemRecord {
    const item = items.get(id)
    if (!item || (itemIsPrivate(item, sessionPrivate) && !fullData(caller))) throw notFound()
    return item
  }

  async function detailOf(sessionId: string): Promise<TaskDetail | undefined> {
    return context.hub.detail(sessionId).catch(() => undefined)
  }

  function present(caller: DeviceCaller, post: WorkPostRecord, reply?: WorkPost['reply'], held?: boolean): WorkPost {
    const { deviceId, requestId, payloadHash: _hash, delivery, ...rest } = post
    return {
      ...structuredClone(rest),
      ...(deviceId === caller.device.id ? { requestId } : {}),
      ...(delivery
        ? {
            delivery: {
              sessionId: delivery.sessionId,
              state: sending.has(post.id) ? 'sending' : held ? 'sent' : delivery.state,
              ...(delivery.reason && !held ? { reason: delivery.reason } : {}),
              ...(delivery.code && !held ? { code: delivery.code } : {}),
            },
          }
        : {}),
      ...(reply ? { reply } : {}),
    }
  }

  async function list(caller: DeviceCaller, id: string): Promise<WorkThreadAnswer> {
    visible(caller, id)
    const thread = threads.get(id)
    const posts = thread?.posts ?? []
    const details = new Map<string, Promise<TaskDetail | undefined>>()
    const shown = await Promise.all(
      posts.map(async post => {
        const delivery = post.delivery
        // A session this device may not read gives no reply here; it would not be listed for it either.
        if (!delivery || (sessionPrivate(delivery.sessionId) && !fullData(caller))) return present(caller, post)
        if (!details.has(delivery.sessionId)) details.set(delivery.sessionId, detailOf(delivery.sessionId))
        const detail = await details.get(delivery.sessionId)
        if (!detail) return present(caller, post)
        const held = delivery.state !== 'sent' && !sending.has(post.id) && delivered(detail.messages, delivery.requestId)
        return present(caller, post, replyTo(detail.messages, delivery.requestId, BUSY.has(detail.summary.status)), held)
      }),
    )
    context.recheck(caller, 'view')
    visible(caller, id)
    return { posts: shown, revision: thread?.revision ?? 0 }
  }

  /**
   * What the thread gained since `sessionId` was last addressed, before `post`: the person's other posts, and the replies
   * other sessions gave to them. A target that is not private gets nothing that went to or came from a private one (an
   * Agent's chat), so a session a narrower device reads never carries it.
   */
  async function increment(posts: readonly WorkPostRecord[], post: WorkPostRecord, sessionId: string): Promise<QuotedPart[]> {
    const index = posts.findIndex(entry => entry.id === post.id)
    const before = posts.slice(0, index < 0 ? posts.length : index)
    const last = before.findLastIndex(
      entry => entry.delivery?.sessionId === sessionId && (entry.delivery.state === 'sent' || entry.delivery.state === 'unknown'),
    )
    const targetPrivate = sessionPrivate(sessionId)
    const parts: QuotedPart[] = []
    for (const entry of before.slice(last + 1)) {
      const to = entry.target
      if (to && 'customAgentId' in to && !targetPrivate) continue
      const other = entry.delivery && entry.delivery.sessionId !== sessionId ? entry.delivery : undefined
      if (other && sessionPrivate(other.sessionId) && !targetPrivate) continue
      parts.push({ label: to ? `我（发给 ${await targetName(to)}）` : '我', text: entry.text })
      if (!other || other.state === 'failed') continue
      const detail = await detailOf(other.sessionId)
      const reply = detail && replyTo(detail.messages, other.requestId, false)
      if (reply) parts.push({ label: `${await targetName(entry.target!)} 的回复`, text: reply.text + (reply.more ? '\n…' : '') })
    }
    return parts
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
        let prompt = ownWords()
          ? post.text
          : deliveryText(item.title, post.text, await increment(threads.get(itemId)?.posts ?? [], post, sessionId))
        if (ownWords()) prompt = post.text
        context.recheck(caller, 'run')
        if (agent) deps.agentAccess(caller)
        handed = true
        await deps.deliver(caller, sessionId, { requestId, prompt }, agent ? { remember: post.text } : undefined)
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
    const shown = (await list(caller, id)).posts.find(entry => entry.id === postId)
    if (!shown) throw notFound()
    return shown
  }

  return {
    async route({ req, res, caller, path, method }) {
      const match = ONE.exec(path)
      if (!match) return false
      context.requireScope(caller, 'view')
      const id = match[1]!
      if (method === 'GET') {
        json(res, await list(caller, id))
        return true
      }
      if (method !== 'POST') throw new AppError(404, 'not-found', '接口不存在。')
      const { post: answer, status } = await post(req, caller, id)
      json(res, { post: answer } satisfies WorkPostAnswer, status)
      return true
    },
  }
}
