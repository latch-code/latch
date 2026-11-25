import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { z } from 'zod'
import { escapeSecurityText, refusedBeforeAccepting, type AgentMention, type TaskDetail } from '@latch/protocol'
import { redactKnownSecrets, sha256Hex } from '@latch/core/node-kit'
import { AppError } from '@latch/sdk'
import { mentionsConversationReference } from './conversation-references.ts'
import { AgentJournal } from './agent-journal.ts'
import type { DeviceCaller } from './routes/registry.ts'
import { cut, workPostTurn } from './work-threads.ts'

const owner = z.string().regex(/^(?:general|agt_[\da-f-]{36})$/u)
const request = z.strictObject({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  target: z.strictObject({ kind: z.literal('agent'), customAgentId: owner }),
  text: z.string().trim().min(1).max(16_000),
})
const record = z.strictObject({
  id: z.string().uuid(),
  requestId: request.shape.requestId,
  sourceAgentId: owner,
  /** Fixed when accepted so renaming the source cannot change a replay. Older exchanges delivered their text alone. */
  sourceLabel: z.string().min(1).max(800).optional(),
  sourceSessionId: z.string().optional(),
  targetAgentId: owner,
  initiator: z.enum(['person', 'agent']),
  text: request.shape.text,
  createdAt: z.string().datetime(),
  deviceId: z.string(),
  dispatchId: z.string().uuid(),
  /** Pinned at acceptance. No destination means the first message of a new unique Agent chat. */
  destination: z.string().optional(),
  targetSessionId: z.string().optional(),
  outcome: z.enum(['completed', 'failed', 'cancelled', 'interrupted']).optional(),
  refusal: z.strictObject({ status: z.number().int(), code: z.string(), message: z.string() }).optional(),
})
type MentionRecord = z.infer<typeof record>
const MAX_RECORDS = 2048
const MAX_TEXT_BYTES = 8 * 1024 * 1024
const RECEIPT_MS = 7 * 24 * 60 * 60 * 1000
const state = z.strictObject({
  records: z.array(record).max(MAX_RECORDS),
  /** Recently retired requests keep no conversation content. */
  retired: z.record(z.string().regex(/^[a-f0-9]{64}$/u), z.number().int()),
})
type State = z.infer<typeof state>
const missing = () => new AppError(404, 'agent-mention-missing', '这条提及已移除。')
const pending = () => new AppError(503, 'agent-mention-unknown', '发送结果尚未确认，请重试同一条提及。')

interface MentionDeps {
  access(caller: DeviceCaller, write: boolean): void
  owner(id: string, writing: boolean): void
  owners(): Set<string>
  /** Only the Host decides which chat is current for an Agent. */
  slot(caller: DeviceCaller, id: string): Promise<{ state: 'empty' | 'starting' } | { state: 'ready'; sessionId: string }>
  detail(id: string): Promise<TaskDetail>
  deliver(caller: DeviceCaller, mention: MentionRecord, authorize: () => void, res?: ServerResponse): Promise<string>
  audit(caller: DeviceCaller, item: MentionRecord): Promise<void>
  changed(): void
}

type AgentOrigin = { sessionId: string; name: string; authorize: () => void }

function sourceLabel(name: string, fallback: string): string {
  // Keep the attribution on one line and keep a name from opening a quote or a conversation reference.
  return (
    escapeSecurityText(redactKnownSecrets(name))
      .replace(/[「」]/gu, ' ')
      .replaceAll('[', '［')
      .replaceAll(']', '］')
      .trim() || fallback
  )
}

/** The source can still be an empty Agent chat. Only the addressed Agent gets a turn. */
export class AgentMentions {
  private readonly sending = new Map<string, Promise<void>>()
  private constructor(
    private readonly journal: AgentJournal<State>,
    private readonly deps: MentionDeps,
  ) {}
  static async open(dataDir: string, deps: MentionDeps): Promise<AgentMentions> {
    const journal = await AgentJournal.open<State>(dataDir, 'mentions.json', state, { records: [], retired: {} }, { directory: 'agents' })
    const service = new AgentMentions(journal, deps)
    // A prior Host may have stopped between deleting an Agent and disposing of its private exchanges.
    const live = deps.owners()
    await service.removeWhere(row => !live.has(row.targetAgentId) || !live.has(row.sourceAgentId))
    return service
  }
  close() {
    return this.journal.close()
  }

  wasDispatched(targetAgentId: string, requestId: string): boolean {
    return this.journal.read().records.some(item => item.targetAgentId === targetAgentId && item.dispatchId === requestId)
  }

  async list(caller: DeviceCaller, sourceAgentId: string): Promise<AgentMention[]> {
    this.deps.access(caller, false)
    this.deps.owner(sourceAgentId, false)
    await this.journal.recover()
    const records = this.journal
      .read()
      .records.filter(item => item.sourceAgentId === sourceAgentId)
      .slice(-100)
    const details = new Map<string, Promise<TaskDetail | undefined>>()
    const views = await Promise.all(records.map(item => this.present(caller, item, details)))
    this.deps.access(caller, false)
    this.deps.owner(sourceAgentId, false)
    const existing = new Set(this.journal.read().records.map(item => item.id))
    const live = this.deps.owners()
    return views.filter(item => existing.has(item.id) && live.has(item.targetAgentId))
  }

  async get(caller: DeviceCaller, sourceAgentId: string, id: string): Promise<AgentMention> {
    this.deps.access(caller, false)
    this.deps.owner(sourceAgentId, false)
    await this.journal.recover()
    const item = this.journal.read().records.find(row => row.id === id && row.sourceAgentId === sourceAgentId)
    if (!item) throw missing()
    const value = await this.present(caller, item, new Map())
    this.deps.access(caller, false)
    this.deps.owner(sourceAgentId, false)
    this.deps.owner(item.targetAgentId, false)
    if (!this.journal.read().records.some(row => row.id === id)) throw missing()
    return value
  }

  async send(
    caller: DeviceCaller,
    sourceAgentId: string,
    body: unknown,
    byAgent?: AgentOrigin,
    res?: ServerResponse,
  ): Promise<AgentMention> {
    const input = request.parse(body)
    const targetAgentId = input.target.customAgentId
    const authorize = () => {
      this.deps.access(caller, true)
      this.deps.owner(sourceAgentId, true)
      this.deps.owner(targetAgentId, true)
      byAgent?.authorize()
    }
    this.deps.access(caller, true)
    this.deps.access(caller, false)
    if (mentionsConversationReference(input.text)) throw new AppError(400, 'agent-mention-reference', '提及只发送文字，请先移除会话引用。')
    if (redactKnownSecrets(input.text) !== input.text) throw new AppError(422, 'agent-mention-secret', '这条消息含有凭据，请移除后再发送。')
    if (sourceAgentId === targetAgentId) throw new AppError(400, 'agent-mention-self', '请选择另一位 Agent。')
    await this.journal.recover()
    const initiator = byAgent ? 'agent' : 'person'
    const find = (records: MentionRecord[]) => records.find(item => item.requestId === input.requestId)
    let item = find(this.journal.read().records)
    let fresh = false
    if (!item) {
      authorize()
      const [source, target] = await Promise.all([this.deps.slot(caller, sourceAgentId), this.deps.slot(caller, targetAgentId)])
      if (target.state === 'starting') throw new AppError(409, 'agent-chat-starting', '这位 Agent 正在确认第一条消息，请稍后再发。')
      const proposed: MentionRecord = {
        id: randomUUID(),
        requestId: input.requestId,
        deviceId: caller.device.id,
        dispatchId: randomUUID(),
        sourceAgentId,
        ...(byAgent ? { sourceLabel: sourceLabel(byAgent.name, sourceAgentId) } : {}),
        targetAgentId,
        initiator,
        text: input.text,
        createdAt: new Date().toISOString(),
        sourceSessionId: byAgent?.sessionId ?? (source.state === 'ready' ? source.sessionId : undefined),
        destination: target.state === 'ready' ? target.sessionId : undefined,
      }
      // A unique change key per attempt: a recovered store write can never skip the body check below.
      item = await this.journal.change(
        proposed.id,
        proposed.id,
        async draft => {
          const prior = find(draft.records)
          if (prior) return { value: prior, changed: false }
          if ((draft.retired[sha256Hex(input.requestId)] ?? 0) > Date.now())
            throw new AppError(409, 'agent-mention-expired', '这条提及已经结束并移出了近期记录。')
          await this.makeRoom(draft, proposed)
          authorize()
          await this.deps.audit(caller, proposed)
          draft.records.push(proposed)
          return { value: proposed }
        },
        authorize,
      )
      fresh = proposed.id === item.id
    }
    if (
      item.deviceId !== caller.device.id
      || item.text !== input.text
      || item.sourceAgentId !== sourceAgentId
      || item.targetAgentId !== targetAgentId
      || item.initiator !== initiator
      || (byAgent && byAgent.sessionId !== item.sourceSessionId)
    )
      throw new AppError(409, 'request-conflict', '同一个请求标识不能用于不同的提及。')
    if (item.refusal) throw new AppError(item.refusal.status, item.refusal.code, item.refusal.message)
    if (!item.targetSessionId) {
      const held = this.sending.get(item.id)
      if (held) await held
      else {
        const operation = this.dispatch(caller, item, authorize, fresh, res).finally(() => this.sending.delete(item.id))
        this.sending.set(item.id, operation)
        await operation
      }
    }
    return this.get(caller, sourceAgentId, item.id)
  }

  private async dispatch(caller: DeviceCaller, item: MentionRecord, check: () => void, fresh: boolean, res?: ServerResponse) {
    const authorize = () => {
      check()
      if (!this.journal.read().records.some(row => row.id === item.id)) throw missing()
    }
    let outcome: Pick<MentionRecord, 'targetSessionId' | 'refusal'>
    try {
      authorize()
      const targetSessionId = await this.deps.deliver(caller, item, authorize, res)
      outcome = { targetSessionId }
    } catch (cause) {
      // A refusal on retry cannot disprove acceptance of the earlier attempt.
      if (fresh && cause instanceof AppError && cause.code === 'post-unmarked')
        cause = new AppError(409, 'agent-mention-harness', '这位 Agent 的 Harness 不能标记外部内容，消息未发出。')
      if (!(fresh && cause instanceof AppError && refusedBeforeAccepting(cause.status, cause.code))) throw pending()
      outcome = { refusal: { status: cause.status, code: cause.code, message: redactKnownSecrets(cause.message).slice(0, 500) } }
    }
    const key = randomUUID()
    await this.journal.change(key, key, draft => {
      const stored = draft.records.find(row => row.id === item.id)
      if (!stored) throw missing()
      Object.assign(stored, outcome)
      return { value: true }
    })
    this.deps.changed()
    if (outcome.refusal) throw new AppError(outcome.refusal.status, outcome.refusal.code, outcome.refusal.message)
  }

  private async present(
    caller: DeviceCaller,
    item: MentionRecord,
    details: Map<string, Promise<TaskDetail | undefined>>,
  ): Promise<AgentMention> {
    const { id, requestId, initiator, sourceAgentId, targetAgentId, sourceSessionId, text, createdAt } = item
    const view: AgentMention = {
      id,
      requestId,
      initiator,
      sourceAgentId,
      targetAgentId,
      sourceSessionId,
      text,
      createdAt,
      status: 'unknown',
    }
    if (item.refusal) return { ...view, status: 'failed', failure: item.refusal.message }
    let session = item.targetSessionId ?? item.destination
    if (!session) {
      const slot = await this.deps.slot(caller, targetAgentId).catch(() => undefined)
      if (slot?.state === 'ready') session = slot.sessionId
    }
    if (this.sending.has(id)) view.status = 'sending'
    if (!item.targetSessionId && view.status === 'unknown' && item.deviceId === caller.device.id && item.initiator === 'person')
      view.canRetry = true
    if (!session) return view
    let reading = details.get(session)
    if (!reading) {
      reading = this.deps.detail(session).catch(() => undefined)
      details.set(session, reading)
    }
    const detail = await reading
    const turn = detail && workPostTurn(detail, item.dispatchId)
    if (!turn || !detail) return view
    delete view.canRetry
    view.targetSessionId = session
    const last = turn.replies.at(-1)
    if (last) {
      const excerpt = cut(redactKnownSecrets(last.text), 16_000)
      view.reply = { messageId: last.messageId, text: excerpt.text, ...(excerpt.more ? { more: true as const } : {}) }
    }
    const latest = detail.messages.findLast(message => message.role === 'user' && !message.steered)?.id === turn.turn.userMessageId
    if (item.outcome) view.status = item.outcome
    else if (latest) {
      const { status, runOutcome } = detail.summary
      view.status = status === 'running' || status === 'waiting-approval' ? status : (runOutcome ?? 'unknown')
      if (runOutcome && view.status === runOutcome) {
        // A later question replaces the session's last outcome; retain only the observed outcome for this question.
        const key = randomUUID()
        await this.journal.change(key, key, draft => {
          const stored = draft.records.find(row => row.id === id)
          if (!stored || stored.outcome) return { value: true, changed: false }
          stored.outcome = runOutcome
          return { value: true }
        })
      }
    } else {
      const end = turn.rows.findLast(row => row.role === 'assistant' || row.role === 'system')
      if (end?.interrupted) view.status = 'interrupted'
      else if (end?.state === 'failed' || end?.state === 'cancelled') view.status = end.state
      // A completed intermediate assistant message can precede a cancelled tool; its text alone cannot prove success.
    }
    return view
  }

  /** Reclaim only a refused submission or a turn the Host can prove has ended. An unanswered delivery stays retryable. */
  private async makeRoom(draft: State, next: MentionRecord) {
    const now = Date.now()
    for (const [key, until] of Object.entries(draft.retired)) if (until <= now) delete draft.retired[key]
    let bytes = Buffer.byteLength(JSON.stringify(draft.records)) + Buffer.byteLength(JSON.stringify(next))
    if (draft.records.length < MAX_RECORDS && bytes < MAX_TEXT_BYTES) return
    const remove = new Set<string>()
    const details = new Map<string, TaskDetail | undefined>()
    for (const item of draft.records) {
      if (this.sending.has(item.id)) continue
      if (!item.refusal) {
        const id = item.targetSessionId
        if (!id) continue
        if (!details.has(id)) details.set(id, await this.deps.detail(id).catch(() => undefined))
        const detail = details.get(id)
        if (!detail) continue
        const bound = workPostTurn(detail, item.dispatchId)
        if (!bound) continue
        const latest = detail.messages.findLast(row => row.role === 'user' && !row.steered)
        if (latest?.id === bound.turn.userMessageId && !detail.summary.runOutcome) continue
      }
      remove.add(item.id)
      bytes -= Buffer.byteLength(JSON.stringify(item))
      draft.retired[sha256Hex(item.requestId)] = now + RECEIPT_MS
      if (draft.records.length - remove.size < MAX_RECORDS && bytes < MAX_TEXT_BYTES) break
    }
    if (Object.keys(draft.retired).length > 32_768)
      throw new AppError(429, 'agent-mention-receipts-full', '近期提及过多，请等七天内的旧回执到期后再发。')
    if (draft.records.length - remove.size >= MAX_RECORDS || bytes >= MAX_TEXT_BYTES)
      throw new AppError(409, 'agent-mention-capacity', '尚未结束的提及占满了记录，请先处理目标聊天中的进行项或确认结果未知的发送。')
    draft.records = draft.records.filter(row => !remove.has(row.id))
  }

  forget(kind: 'agent' | 'session', id: string): Promise<void> {
    return this.removeWhere(row =>
      kind === 'agent'
        ? row.sourceAgentId === id || row.targetAgentId === id
        : row.sourceSessionId === id || row.targetSessionId === id || row.destination === id,
    )
  }

  private async removeWhere(matches: (row: MentionRecord) => boolean): Promise<void> {
    const key = randomUUID()
    await this.journal.recover()
    await this.journal.change(key, key, draft => {
      const kept = draft.records.filter(row => !matches(row))
      if (kept.length === draft.records.length) return { value: true, changed: false }
      draft.records = kept
      return { value: true }
    })
  }
}
