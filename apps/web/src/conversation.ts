import {
  modelIdKey,
  splitChangeNote,
  type Approval,
  type Message,
  type RoutedModel,
  type TaskDetail,
  type TaskStatus,
  type TokenUsage,
  type ToolDecision,
  type ToolKind,
} from '@latch/protocol'
import { parseDuration, parseTime } from './core/hostClock.ts'
import { APPROVAL_COPY, DECISION_COPY, JUDGED_COPY } from './core/securityCopy.ts'
import { absoluteTime, argumentView, basename, clockTime, dayClockTime, formatDuration, messageTime, sameDay, sumUsage } from './format.ts'
import { diffLines, previousState } from './diff.ts'
import { toolKind } from './icons.tsx'
import { thinkingWord } from './composer/modelReasoning.ts'

/*
 * What the conversation shows, derived from the Host's messages alone: turns, their footers, what a work row says, when
 * a turn's work folds away and what the live status line says. Every time and count comes from a Host field; when a field
 * is missing (an older Host, a plugin driver, older history) the part that needs it is left out rather than estimated.
 */

export const liveMessageId = (detail: TaskDetail) => detail.liveMessageId ?? `live:${detail.summary.id}`
export const isLive = (detail: TaskDetail) => detail.liveText.length > 0 || (detail.liveReasoning?.length ?? 0) > 0

/** Committed messages plus the streaming reply under the ID it will keep once committed. */
export function renderedMessages(detail: TaskDetail): Message[] {
  const messages = [...detail.messages]
  const id = liveMessageId(detail)
  if (isLive(detail) && !messages.some(message => message.id === id)) {
    messages.push({ id, role: 'assistant', text: detail.liveText, ...(detail.liveReasoning ? { reasoning: detail.liveReasoning } : {}) })
  }
  return messages
}

export const toolRowId = (approval: Approval) => (approval.toolCallId ? `tool:${approval.toolCallId}` : undefined)

/**
 * A prompt and everything that answered it, up to the next prompt. Content before any prompt is a turn of its own. Text
 * added to a running turn (`steered`) belongs to that turn, in reading order.
 */
export interface Turn {
  /** The prompt's message ID; `lead:<first id>` for content before any prompt. */
  key: string
  user?: Message
  /** Assistant blocks, tool rows and system notes, in order. */
  replies: Message[]
}

export function turnsOf(messages: Message[]): Turn[] {
  const turns: Turn[] = []
  for (const message of messages) {
    if (message.role === 'user' && !message.steered) turns.push({ key: message.id, user: message, replies: [] })
    else {
      const last = turns.at(-1)
      if (last) last.replies.push(message)
      else turns.push({ key: `lead:${message.id}`, replies: [message] })
    }
  }
  return turns
}

/** Whether two values parsed from JSON hold the same data; it looks at every field, so a new one is never missed. */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameData(left[key], right[key]))
}

/**
 * The turns, with each turn whose data did not change kept as the same object. A full frame parses every message of the
 * session again, and a memoized turn compares by identity.
 */
export function stableTurns(previous: readonly Turn[], next: readonly Turn[]): Turn[] {
  const known = new Map(previous.map(turn => [turn.key, turn]))
  return next.map(turn => {
    const before = known.get(turn.key)
    return before && sameData(before, turn) ? before : turn
  })
}

/** The immutable committed history. A body-only frame can reuse this whole projection. */
export function projectTurns(messages: Message[], previous: readonly Turn[] = []) {
  const turns = stableTurns(previous, turnsOf(messages))
  return {
    turns,
    history: turns.slice(0, -1),
    ids: new Set(messages.map(message => message.id)),
    switches: settingSwitches(turns),
    index: turns.map(turn => ({ key: turn.key, at: turnTimes(turn).startedAt })),
    messageFacts: runMessageFacts(messages, turns),
  }
}

/** Only the last turn owns the synthetic reply; a committed ID always wins, just as in renderedMessages. */
export function liveTurn(projection: ReturnType<typeof projectTurns>, detail: TaskDetail): Turn | undefined {
  const last = projection.turns.at(-1)
  const id = liveMessageId(detail)
  if (!isLive(detail) || projection.ids.has(id)) return last
  const message: Message = {
    id,
    role: 'assistant',
    text: detail.liveText,
    ...(detail.liveReasoning ? { reasoning: detail.liveReasoning } : {}),
  }
  return last ? { ...last, replies: [...last.replies, message] } : { key: `lead:${id}`, replies: [message] }
}

/** How a settled turn ended. */
export type TurnOutcome = 'completed' | 'failed' | 'stopped' | 'interrupted'

/**
 * The outcome of a settled turn: for the latest one, the session's status says it; an earlier one is read from its own
 * messages (a stopped or failed reply, a failure note).
 */
export function turnOutcome(turn: Turn, latestStatus: TaskStatus | undefined): TurnOutcome {
  if (latestStatus !== undefined) {
    if (latestStatus === 'failed') return 'failed'
    if (latestStatus === 'cancelled') return 'stopped'
    if (latestStatus === 'interrupted') return 'interrupted'
    return 'completed'
  }
  // The Host's stop is nobody's: a turn it cut off reads as interrupted, never as stopped.
  if (turn.replies.some(message => message.interrupted)) return 'interrupted'
  if (turn.replies.some(message => message.role === 'assistant' && message.state === 'cancelled')) return 'stopped'
  if (turn.replies.some(message => (message.role === 'assistant' || message.role === 'system') && message.state === 'failed'))
    return 'failed'
  return 'completed'
}

/**
 * The outcome in words, as the footer's first segments, stating only what is true of this turn: a stopped turn says it
 * kept part of the reply only when it has prose, an interrupted one that it kept content only when it has prose or a
 * tool row. A completed turn says nothing.
 */
export function outcomeWords(turn: Turn, outcome: TurnOutcome): string[] {
  if (outcome === 'failed') return ['失败']
  if (outcome === 'stopped') return turnText(turn) ? ['已停止', '保留了部分回复'] : ['已停止']
  if (outcome === 'interrupted')
    return turnText(turn) || turn.replies.some(message => message.role === 'tool') ? ['回复中断', '保留了部分内容'] : ['回复中断']
  return []
}

/** The prose of every reply block of the turn, as the model wrote it, one blank line apart: what 复制回复 copies. */
export const turnText = (turn: Turn): string =>
  turn.replies
    .filter(message => message.role === 'assistant' && message.text.trim())
    .map(message => message.text)
    .join('\n\n')

/** Usage the turn's steps reported, summed; undefined when none did (an agent that reports usage per session). */
export function turnUsage(turn: Turn): TokenUsage | undefined {
  return sumUsage(turn.replies.flatMap(message => (message.role === 'assistant' && message.usage ? [message.usage] : [])))
}

/** What a turn on a model service sent through Latch, as the gateway counted it, read for the author line and footer. */
export interface TurnRoute {
  requests: number
  models: RoutedModel[]
  /** The model the session had chosen for the turn. */
  chosen?: string
  /**
   * The model that answered most of the turn's requests for the chosen model, as the service named it; else the model
   * those requests named.
   */
  answered?: string
  /** `answered` is what the service said, not only what the requests named. */
  reported: boolean
  /** `answered` is another model than the chosen one, not just a dated version of it. */
  differs: boolean
  /** Tokens the replies reported, summed; a part stays only when every model's sum has it. */
  usage?: TokenUsage
  /** Replies that arrived whole without reporting tokens, so `usage` leaves them out. */
  unmeasured: number
  /** Requests still under way when the turn ended, so `usage` leaves them out too. */
  open: number
}

export function turnRoute(turn: Turn): TurnRoute | undefined {
  const routed = turn.user?.turn?.routed
  if (!routed?.requests) return undefined
  const { chosen, models } = routed
  // The chosen model's own entry, else the one asked for most: a turn that never asked for the chosen model used another.
  const main =
    (chosen ? models.find(entry => modelIdKey(entry.model) === modelIdKey(chosen)) : undefined)
    ?? models.toSorted((a, b) => b.requests - a.requests)[0]
  const answered = main ? (main.used ?? main.model) : undefined
  const usages = models.flatMap(entry => (entry.usage ? [entry.usage] : []))
  const total = (count: (entry: RoutedModel) => number) => models.reduce((sum, entry) => sum + count(entry), 0)
  return {
    requests: routed.requests,
    models,
    ...(chosen ? { chosen } : {}),
    ...(answered ? { answered } : {}),
    reported: main?.used !== undefined,
    differs: !!chosen && !!answered && modelIdKey(chosen) !== modelIdKey(answered),
    ...(usages.length ? { usage: sumUsage(usages) } : {}),
    unmeasured: total(entry => Math.max(0, entry.requests - (entry.failed ?? 0) - (entry.measured ?? 0) - (entry.open ?? 0))),
    open: total(entry => entry.open ?? 0),
  }
}

/** The model the turn's first step used, for the source row. */
export const turnModel = (turn: Turn): Message | undefined =>
  turn.replies.find(message => message.role === 'assistant' && typeof message.model === 'string' && message.model)

/**
 * Where the model or thinking level changed from the turn before, by turn key: what changed, as `from → to`. Only a value
 * the Host recorded on both sides counts; a turn with no answer carries the last one recorded across it.
 */
export function settingSwitches(turns: readonly Turn[]): Map<string, string> {
  const switches = new Map<string, string>()
  let model: string | undefined
  let thinking: string | undefined
  for (const turn of turns) {
    const step = turnModel(turn)
    if (!step?.model) continue
    const nextThinking = step.thinking ? thinkingWord(step.thinking) : undefined
    const modelChanged = model !== undefined && step.model !== model
    const thinkingChanged = thinking !== undefined && nextThinking !== undefined && nextThinking !== thinking
    if (modelChanged && thinkingChanged) switches.set(turn.key, `${model} · ${thinking} → ${step.model} · ${nextThinking}`)
    else if (modelChanged) switches.set(turn.key, `模型 ${model} → ${step.model}`)
    else if (thinkingChanged) switches.set(turn.key, `思考 ${thinking} → ${nextThinking}`)
    model = step.model
    // A model without levels says nothing about the next one's.
    thinking = nextThinking ?? (modelChanged ? undefined : thinking)
  }
  return switches
}

export interface TurnTimes {
  /** When the prompt was committed. */
  startedAt?: number
  /** When the turn settled, as the Host recorded it. */
  endedAt?: number
  /** When the reply was sent: the turn's end, or else the last reply block's completion (older history). */
  sentAt?: number
  activeMs?: number
  waitMs?: number
}

export function turnTimes(turn: Turn): TurnTimes {
  const stats = turn.user?.turn
  const endedAt = parseTime(stats?.endedAt)
  const lastDone = turn.replies.findLast(message => parseTime(message.completedAt) !== undefined)
  return {
    startedAt: parseTime(turn.user?.createdAt),
    endedAt,
    sentAt: endedAt ?? parseTime(lastDone?.completedAt),
    activeMs: parseDuration(stats?.activeMs),
    waitMs: parseDuration(stats?.waitMs),
  }
}

const END_WORDS: Record<TurnOutcome, string> = { completed: '完成', stopped: '停止', failed: '结束', interrupted: '结束' }

/**
 * The tooltip of a settled turn's time: 「10月25日 14:31:05 开始 · 14:32:17 完成 · 用时 1 分 12 秒（不含等待批准 20 秒）」.
 * The end carries its day only when the turn crossed midnight; the duration (the Host's working time) and the approval
 * wait appear only when recorded, and an interrupted turn has no duration.
 */
export function turnTimeTip(times: TurnTimes, outcome: TurnOutcome, now: number): string | undefined {
  const parts: string[] = []
  const { startedAt, sentAt } = times
  if (startedAt !== undefined) parts.push(`${dayClockTime(startedAt, now)} 开始`)
  if (sentAt !== undefined)
    parts.push(
      `${startedAt !== undefined && sameDay(startedAt, sentAt) ? clockTime(sentAt) : dayClockTime(sentAt, now)} ${END_WORDS[outcome]}`,
    )
  const duration = outcome === 'interrupted' || times.activeMs === undefined ? undefined : formatDuration(times.activeMs)
  if (duration) {
    const wait = times.waitMs !== undefined && times.waitMs >= 1000 ? formatDuration(times.waitMs) : undefined
    parts.push(`用时 ${duration}${wait ? `（不含等待批准 ${wait}）` : ''}`)
  }
  return parts.length ? parts.join(' · ') : undefined
}

// ---- Process rows ------------------------------------------------------------------------------------------------

const VERBS: Partial<Record<ToolKind, string>> = {
  read: '读取',
  edit: '编辑',
  delete: '删除',
  move: '移动',
  search: '搜索',
  execute: '运行',
  fetch: '获取',
}

function argument(input: string | undefined, names: string[]): string | undefined {
  const view = argumentView(input)
  if (view.kind !== 'entries') return undefined
  for (const name of names) {
    const found = view.entries.find(([key]) => key === name)?.[1]
    if (found !== undefined && found.trim() && !found.includes('\n')) return found
  }
  return undefined
}

/**
 * What a work row says: a verb by the tool's kind and its object, a file by its name, a command, query or address in
 * mono; or, when the tool names no object Latch can read, its own title alone. A tool that declares its own title (Latch
 * 内置: 「写入文件」) is named by that title with the call's object, and one that has neither a title nor an object Latch
 * can read shows its raw name in mono, never a guess. The spinner says it runs, so the words keep one tense.
 */
export interface ToolLabel {
  verb?: string
  object: string
  mono: boolean
}

const PATH_KEYS = ['path', 'file', 'file_path', 'filePath']
/** The arguments a titled tool's object is read from, in order, and whether it is shown in mono. */
const OBJECT_KEYS: Array<[keys: string[], path: boolean]> = [
  [PATH_KEYS, true],
  [['command', 'cmd'], false],
  [['query', 'pattern', 'q'], false],
  [['url'], false],
]

/** The object of a titled tool's call: its first location or a known argument; the workspace root names nothing. */
function titledObject(tool: Message['tool']): { object: string; path: boolean } | undefined {
  const located = tool?.locations?.[0]
  if (located) return { object: located, path: true }
  for (const [keys, path] of OBJECT_KEYS) {
    const value = argument(tool?.input, keys)
    if (value !== undefined) return value.trim() === '.' || value.trim() === './' ? undefined : { object: value, path }
  }
  return undefined
}

/** A path as a row shows it: the file's name, or the path itself when it ends without one. */
const shortPath = (path: string) => basename(path) || path

/** A file edit: 「编辑 providers.ts」, 「新建 providers.test.ts · 42 行」, 「编辑 3 个文件」. */
function diffLabel(tool: Message['tool']): ToolLabel | undefined {
  const diffs = tool?.diffs
  if (!diffs?.length) return undefined
  if (diffs.length > 1) return { verb: '编辑', object: `${diffs.length} 个文件`, mono: false }
  const diff = diffs[0]!
  if (previousState(diff) !== 'none') return { verb: '编辑', object: shortPath(diff.path), mono: false }
  const lines = diff.newText === '' ? 0 : diff.newText.replace(/\n$/, '').split('\n').length
  return { verb: '新建', object: `${shortPath(diff.path)} · ${lines} 行`, mono: false }
}

export function toolLabel(message: Pick<Message, 'tool' | 'toolName' | 'state'>): ToolLabel {
  const tool = message.tool
  if (isReview(tool)) return { object: JUDGED_COPY.review(tool!.judged!.by), mono: false }
  const edited = diffLabel(tool)
  if (edited) return edited
  if (tool?.toolTitle) {
    const found = titledObject(tool)
    if (!found) return { object: tool.toolTitle, mono: false }
    return { verb: tool.toolTitle, object: found.path ? shortPath(found.object) : found.object, mono: !found.path }
  }
  const kind = toolKind(message)
  const verb = VERBS[kind]
  let object: string | undefined
  let mono = true
  if (kind === 'execute') object = argument(tool?.input, ['command', 'cmd'])
  else if (kind === 'read' || kind === 'edit' || kind === 'delete' || kind === 'move') {
    const path = tool?.locations?.[0] ?? argument(tool?.input, PATH_KEYS)
    object = path === undefined ? undefined : shortPath(path)
    mono = false
  } else if (kind === 'search') object = argument(tool?.input, ['query', 'pattern', 'q'])
  else if (kind === 'fetch') object = argument(tool?.input, ['url'])
  if (object !== undefined && verb !== undefined) return { verb, object, mono }
  // A title that only repeats the tool's identifier is the raw name.
  if (tool?.title && tool.title !== message.toolName) return { object: tool.title, mono: false }
  return message.toolName ? { object: message.toolName, mono: true } : { object: '工具调用', mono: false }
}

/** The row is the harness's own model reviewing a request, not a call of its own. */
export const isReview = (tool: Message['tool']) =>
  tool?.judged !== undefined && tool.judged.outcome !== 'unasked' && tool.blocked === undefined

/** A call the harness refused itself before it ran: it reports the call failed, but nothing ran and nothing broke. */
export const isBlocked = (message: Pick<Message, 'state' | 'tool'>) => message.state === 'failed' && message.tool?.blocked !== undefined

type Blocked = NonNullable<NonNullable<Message['tool']>['blocked']>

/** The first line of a blocked call's reason, at most 120 characters. */
function shortReason(block: Blocked): string | undefined {
  const reason = block.reason
    ?.split('\n')
    .map(part => part.trim())
    .find(Boolean)
  return reason && reason.length > 120 ? `${reason.slice(0, 120)}…` : reason
}

/** The line under a blocked call: who stopped it and, in the harness's own words, why. */
export function blockedLine(block: Blocked): string {
  const cut = shortReason(block)
  return block.source === 'model' ? JUDGED_COPY.blockedByModel(block.by, cut) : JUDGED_COPY.blockedByRule(block.by, cut)
}

/** The whole reason, for the call's details, when the line under it shows only part of it. */
export function blockedReason(block: Blocked): string | undefined {
  const reason = block.reason?.trim()
  return reason && reason !== shortReason(block) ? reason : undefined
}

/**
 * The words an approval card and an export name a call by: a titled tool's title and object (「写入文件 notes/plan.md」),
 * else the call's own summary or the tool's name.
 */
export function toolHeading(tool: Message['tool'], toolName: string | undefined): string {
  if (isReview(tool)) return JUDGED_COPY.review(tool!.judged!.by)
  if (tool?.toolTitle) {
    const found = titledObject(tool)
    return found ? `${tool.toolTitle} ${found.object}` : tool.toolTitle
  }
  return tool?.title || toolName || '工具调用'
}

/** What a row's edits add and remove, in lines; undefined when it edits nothing. */
export function diffStat(tool: Message['tool']): { add: number; del: number } | undefined {
  if (!tool?.diffs?.length) return undefined
  let add = 0
  let del = 0
  for (const diff of tool.diffs) {
    const view = diffLines(diff.oldText, diff.newText)
    add += view.added
    del += view.removed
  }
  return { add, del }
}

/** The code the built-in harness put before a rejection's tool result until the Host kept decision records. */
const LEGACY_REJECTED = 'APPROVAL_REJECTED:'
const legacyRejected = (message: Pick<Message, 'state' | 'tool' | 'text'>) =>
  message.state === 'failed' && message.tool?.decision === undefined && (message.tool?.output ?? message.text).startsWith(LEGACY_REJECTED)

/** A tool's output as shown: history recorded before decision records still carries the rejection's internal code. */
export function shownToolOutput(message: Pick<Message, 'state' | 'tool' | 'text'>): string {
  const output = message.tool?.output ?? message.text
  return legacyRejected(message) ? output.slice(LEGACY_REJECTED.length).trimStart() : output
}

/**
 * How an approval kept a call from running, as far as the reports go: the call settled failed or cancelled without
 * ever starting, and its approval was not given. History recorded before decision records counts the built-in harness's
 * old rejection code. A call that started or completed keeps its own state and its changes whatever its record says:
 * only the built-in harness holds a call back until it is allowed, and an agent's ask in a full-access session is
 * advisory, so a rejected call may still run.
 */
export function unrunOutcome(
  message: Pick<Message, 'state' | 'tool' | 'text' | 'startedAt'>,
): 'rejected' | 'expired' | 'cancelled' | undefined {
  if ((message.state !== 'failed' && message.state !== 'cancelled') || message.startedAt) return undefined
  const outcome = message.tool?.decision?.outcome
  if (outcome !== undefined) return outcome === 'allowed' ? undefined : outcome
  return legacyRejected(message) ? 'rejected' : undefined
}

/**
 * A decision the call's own reports contradict: its approval was not given, yet it started or completed. The ask was
 * advisory (an agent in a full-access session), and the row keeps what the agent reported.
 */
export function ranDespite(message: Pick<Message, 'state' | 'tool' | 'text' | 'startedAt'>): ToolDecision | undefined {
  const decision = message.tool?.decision
  if (!decision || decision.outcome === 'allowed') return undefined
  if (message.state === 'awaiting-approval' || message.state === 'queued') return undefined
  return unrunOutcome(message) === undefined ? decision : undefined
}

/** The diffs a call applied as far as the reports go: none while it waits or when its approval kept it from running. */
export function appliedDiffs(message: Pick<Message, 'state' | 'tool' | 'text' | 'startedAt'>) {
  if (message.state === 'awaiting-approval' || message.state === 'queued' || unrunOutcome(message) || isBlocked(message)) return []
  return message.tool?.diffs ?? []
}

/**
 * A tool row's state as shown: a call its approval kept from running reads by how the approval ended, and one the harness
 * refused itself reads 拦下.
 */
export type ShownToolState = NonNullable<Message['state']> | 'rejected' | 'expired' | 'blocked' | 'interrupted' | 'unknown'

/** A call that started and reported no result: nobody can say what it did, which is not a failure. */
export function outcomeUnknown(message: Pick<Message, 'state' | 'tool' | 'text'>): boolean {
  return message.state === 'failed' && (message.tool?.output ?? message.text).includes('TOOL_OUTCOME_UNKNOWN')
}

export function shownToolState(message: Pick<Message, 'state' | 'tool' | 'text' | 'startedAt' | 'interrupted'>): ShownToolState {
  const state = message.state ?? 'completed'
  // A review that came to 拦下 or to no verdict reports itself failed; it is a verdict, not a failure.
  if (isReview(message.tool) && state === 'failed') return 'completed'
  if (isBlocked(message)) return 'blocked'
  // The Host stopped before the call reported: it reads as interrupted whatever its approval record says.
  if (message.interrupted && (state === 'failed' || state === 'cancelled')) return 'interrupted'
  return unrunOutcome(message) ?? (outcomeUnknown(message) ? 'unknown' : state)
}

/**
 * The record line of a decided approval: 「已允许 · 14:32」 and 「已拒绝 · 昨天 09:15」 for a person's choice, with where
 * they decided in the tooltip; 「已过期」, 「已取消（会话停止）」 and 「已取消（子 Agent 停止）」 when nobody answered.
 */
export function decisionLine(decision: ToolDecision, now: number): { text: string; title: string; full: string } {
  const at = parseTime(decision.at)
  const when = at === undefined ? undefined : absoluteTime(at)
  const chosen = decision.outcome === 'allowed' || decision.outcome === 'rejected'
  const words = decision.subagentStopped ? DECISION_COPY.cancelledSubagent : DECISION_COPY[decision.outcome]
  const about = chosen
    ? decision.via === 'this-mac'
      ? DECISION_COPY.viaThisMac
      : decision.via === 'other-device'
        ? DECISION_COPY.viaOtherDevice
        : undefined
    : decision.outcome === 'expired'
      ? DECISION_COPY.expiredNote
      : undefined
  const title = [when, about].filter(Boolean).join(' · ')
  return {
    text: chosen && at !== undefined ? `${words} · ${messageTime(at, now)}` : words,
    title: title || words,
    // For an export, which is read later and elsewhere: the words, the full time and where or why.
    full: [words, when, about].filter(Boolean).join(' · '),
  }
}

/**
 * How long a tool ran: from its start (after any approval) to its end, or to now while it runs. A call that reported no
 * start is timed from when it was recorded, unless an approval was asked for it: that time is the wait for a person,
 * and a call its approval kept from running did not run at all.
 */
export function toolDuration(message: Message, now: number): { ms: number; live: boolean } | undefined {
  if (message.state === 'awaiting-approval' || message.state === 'queued') return undefined
  if (message.startedAt === undefined && (message.tool?.decision !== undefined || unrunOutcome(message) || isBlocked(message)))
    return undefined
  const start = parseTime(message.startedAt) ?? parseTime(message.createdAt)
  if (start === undefined) return undefined
  const end = parseTime(message.completedAt)
  if (end !== undefined) return { ms: Math.max(0, end - start), live: false }
  if (message.state === 'running') return { ms: Math.max(0, now - start), live: true }
  return undefined
}

/** Whether a tool's changes are evidence that stays in view: its diffs. */
export const hasDiffs = (message: Message) => (message.tool?.diffs?.length ?? 0) > 0

// ---- A turn's blocks and its fold --------------------------------------------------------------------------------

/** A row of the work: a tool, a block's reasoning, or the finished reads of a settled turn as one row. */
export type WorkItem = { kind: 'tool'; message: Message } | { kind: 'thinking'; message: Message } | { kind: 'reads'; messages: Message[] }

/**
 * A turn in reading order. The work is what folds; prose and notes never do, so they are blocks of their own, and an
 * answer keeps its place in the tree from its first word to its last.
 */
export type TurnBlock =
  | { kind: 'work'; key: string; items: WorkItem[] }
  | { kind: 'prose'; message: Message }
  | { kind: 'note'; message: Message }

/** A question stays in reading order: its card or its record 「你选了…」 is what the person said, not the agent's work. */
const isQuestion = (message: Message) => message.toolName === 'ask_user'

const itemKey = (item: WorkItem) => (item.kind === 'reads' ? item.messages[0]!.id : item.message.id)

/** Reads run together while nothing is decided about them; a read that failed or waited stays a row of its own. */
const plainRead = (message: Message) => message.state === 'completed' && toolKind(message) === 'read' && !message.tool?.decision

function joinReads(items: WorkItem[]): WorkItem[] {
  const out: WorkItem[] = []
  let reads: Message[] = []
  const flush = () => {
    if (reads.length > 1) out.push({ kind: 'reads', messages: reads })
    else if (reads[0]) out.push({ kind: 'tool', message: reads[0] })
    reads = []
  }
  for (const item of items) {
    if (item.kind === 'tool' && plainRead(item.message)) reads.push(item.message)
    else {
      flush()
      out.push(item)
    }
  }
  flush()
  return out
}

/**
 * The turn's blocks. `settled`: a turn that no longer runs joins its consecutive reads into 「读取 4 个文件」; a live turn
 * keeps each read on its own row, so rows do not jump as they finish.
 */
export function turnBlocks(turn: Turn, settled: boolean): TurnBlock[] {
  const blocks: TurnBlock[] = []
  let work: WorkItem[] = []
  const flush = () => {
    if (work.length === 0) return
    const items = settled ? joinReads(work) : work
    blocks.push({ kind: 'work', key: `work:${itemKey(items[0]!)}`, items })
    work = []
  }
  for (const message of turn.replies) {
    if (message.role === 'tool' && !isQuestion(message)) {
      work.push({ kind: 'tool', message })
      continue
    }
    if (message.role === 'assistant') {
      if (message.reasoning) work.push({ kind: 'thinking', message })
      if (!message.text && !message.attachments?.length) continue
      flush()
      blocks.push({ kind: 'prose', message })
      continue
    }
    flush()
    blocks.push({ kind: 'note', message })
  }
  flush()
  return blocks
}

/**
 * Whether a settled turn's work folds into 「已工作 … ›」: it finished, it did something, and it answered. A failed or
 * stopped turn stays open, and so does one that ended without a word, because its last row is all it said.
 */
export function workFolds(turn: Turn, outcome: TurnOutcome | undefined): boolean {
  if (outcome !== 'completed') return false
  return turn.replies.some(message => message.role === 'tool' && !isQuestion(message)) && turnText(turn).trim().length > 0
}

/** The fold's words: 「已工作 2 分 13 秒」 when the Host recorded it, 「已工作」 for older history, and what it must not hide. */
export function foldWords(turn: Turn): string {
  const spent = formatDuration(turnTimes(turn).activeMs ?? 0)
  const count = (state: ShownToolState) =>
    turn.replies.filter(message => message.role === 'tool' && shownToolState(message) === state).length
  const failed = count('failed')
  const rejected = count('rejected')
  // What the Harness's own model stopped happened without the person, so the fold says it, its subagents' too.
  const denied = countCalls(turn.replies, tool => tool.judged?.outcome === 'denied' || tool.blocked?.source === 'model')
  const ruled = countCalls(turn.replies, tool => tool.blocked?.source === 'rule')
  return [
    `已工作${spent ? ` ${spent}` : ''}`,
    ...(failed ? [`${failed} 步失败`] : []),
    ...(rejected ? [`${rejected} 步被拒绝`] : []),
    ...(denied ? [JUDGED_COPY.deniedCount(denied)] : []),
    ...(ruled ? [JUDGED_COPY.ruleBlockedCount(ruled)] : []),
  ].join(' · ')
}

/** The calls, its subagents' too, that match. */
function countCalls(messages: readonly Message[], matches: (tool: NonNullable<Message['tool']>) => boolean): number {
  return messages.reduce(
    (sum, message) =>
      message.role !== 'tool'
        ? sum
        : sum + (message.tool && matches(message.tool) ? 1 : 0) + countCalls(message.subagent?.steps ?? [], matches),
    0,
  )
}

/** One line for a failed row: the first line of what it reported, without the runtime's code, and cut. */
export function failureReason(message: Pick<Message, 'state' | 'tool' | 'text'>): string {
  // A call that reported nothing has its arguments or title as its text, which are no reason.
  const silent = message.tool?.output === undefined && (message.text === message.tool?.input || message.text === message.tool?.title)
  const line = (silent ? '' : shownToolOutput(message))
    .split('\n')
    .map(part => part.trim())
    .find(Boolean)
  const reason = line?.replace(/^TOOL_[A-Z_]+:\s*/u, '') ?? ''
  if (!reason) return '没有成功'
  return reason.length > 120 ? `${reason.slice(0, 120)}…` : reason
}

/** The answer's delivery under the person's latest bubble, until the agent starts answering. */
export function deliveryWords(detail: TaskDetail, turn: Turn): string | undefined {
  const activity = detail.summary.live?.activity
  if (activity === undefined || detail.liveText || turnText(turn)) return undefined
  return activity === 'starting' ? 'Mac 已收到' : 'Harness 已开始'
}

// ---- Retry ------------------------------------------------------------------------------------------------------

const HARMLESS: ReadonlySet<ToolKind> = new Set(['read', 'search', 'think', 'fetch'])

/** What resending a turn might repeat: tools that may have changed something, and those whose outcome is unknown. */
export interface SideEffects {
  edits: number
  commands: number
  others: number
  unknown: number
}

/**
 * A turn may have changed something when any tool that is not a read, search, think or fetch (a tool without a kind
 * included) ran, finished, failed or was cancelled: a failed command may still have written files. A tool still
 * running when the turn ended, or one whose result is marked unknown, may have run.
 */
export function sideEffects(turn: Turn): SideEffects {
  const effects: SideEffects = { edits: 0, commands: 0, others: 0, unknown: 0 }
  for (const message of turn.replies) {
    if (message.role !== 'tool') continue
    const kind = message.tool?.kind
    if (kind !== undefined && HARMLESS.has(kind)) continue
    if (message.state === 'queued' || message.state === 'awaiting-approval' || message.state === undefined) continue
    // A call its approval kept from running changed nothing, nor did one the harness refused; one that started anyway
    // counts like any other.
    if (unrunOutcome(message) || (isBlocked(message) && message.startedAt === undefined)) continue
    const unknown = message.state === 'running' || (message.tool?.output ?? message.text).includes('TOOL_OUTCOME_UNKNOWN')
    if (unknown) effects.unknown++
    else if (message.state === 'cancelled' && (message.tool?.output ?? message.text).includes('TOOL_NOT_STARTED')) continue
    else if (kind === 'edit' || kind === 'delete' || kind === 'move') effects.edits++
    else if (kind === 'execute') effects.commands++
    else effects.others++
  }
  return effects
}

/** The confirmation before resending a turn that may have changed something; undefined when it changed nothing. */
export function resendWarning(effects: SideEffects): string | undefined {
  const done = effects.edits + effects.commands + effects.others
  if (done === 0 && effects.unknown === 0) return undefined
  const parts: string[] = []
  if (done > 0) {
    const what = [
      effects.edits ? `修改 ${effects.edits} 个文件` : '',
      effects.commands ? `运行 ${effects.commands} 条命令` : '',
      effects.others ? `调用 ${effects.others} 次其他工具` : '',
    ].filter(Boolean)
    parts.push(`上一次已经执行了 ${done} 个操作：${what.join('、')}。`)
  }
  if (effects.unknown > 0) parts.push(`上一次有 ${effects.unknown} 个操作结果未知，可能已经执行。`)
  parts.push('重新发送后，Harness 可能再次执行它们。')
  return parts.join('')
}

/**
 * What resending a turn sends again: the person's words, without the Host's note about an undo. A fork's text record of
 * its source stays unless the Harness forked its own record, since the record may never have reached it otherwise.
 */
export function resendText(message: Pick<Message, 'text' | 'forkContext' | 'nativeFork' | 'importContext'>): string {
  // A text rebuild's conversation went with the first send; the session holds it from then on.
  const own = message.forkContext && message.nativeFork ? message.forkContext.prefixLength : (message.importContext?.prefixLength ?? 0)
  return splitChangeNote(message.text.slice(own)).text
}

/** Where the person's own words start in a user message: after a fork's or a text rebuild's carried conversation. */
export function ownTextStart(message: Pick<Message, 'forkContext' | 'importContext'>): number {
  return message.forkContext?.prefixLength ?? message.importContext?.prefixLength ?? 0
}

// ---- The live run -----------------------------------------------------------------------------------------------

/** The run's working time so far on the Host's clock, without approval waits; frozen while one is open. */
export function runElapsed(run: Pick<TaskDetail, 'runStartedAt' | 'runWaitMs' | 'runWaitingSince'>, hostNow: number): number | undefined {
  const started = parseTime(run.runStartedAt)
  if (started === undefined) return undefined
  const waited = parseDuration(run.runWaitMs) ?? 0
  const waiting = parseTime(run.runWaitingSince)
  const open = waiting === undefined ? 0 : Math.max(0, hostNow - waiting)
  return Math.max(0, hostNow - started - waited - open)
}

export type LivePhase =
  | { kind: 'cancelling' }
  | { kind: 'approval' }
  | { kind: 'question' }
  | { kind: 'tool'; text: string }
  | { kind: 'reply' }
  | { kind: 'thinking' }
  | { kind: 'starting'; slow: boolean }
  | { kind: 'model' }

export interface RunMessageFacts {
  running: Message | undefined
  trailing: Message | undefined
}

/** Read once per immutable message list; a late running row in old history is distinct from the latest turn's tool. */
function runMessageFacts(messages: Message[], turns = turnsOf(messages)): RunMessageFacts {
  return {
    running: messages.findLast(message => message.role === 'tool' && message.state === 'running'),
    trailing: turns.at(-1)?.replies.findLast(message => message.role === 'tool' && message.state === 'running'),
  }
}

export interface LivePhaseOptions {
  cancelling: boolean
  approvals: number
  hostNow: number
  messageFacts?: RunMessageFacts
}

/**
 * What the run is doing, in this order: stopping, waiting for you, running a tool (a running row of the latest turn
 * says so before the driver's own phase does), writing the reply, reasoning, starting an agent, or waiting for the
 * model.
 */
export function livePhase(detail: TaskDetail, opts: LivePhaseOptions): LivePhase {
  const activity = detail.activity
  if (opts.cancelling || activity?.phase === 'cancelling') return { kind: 'cancelling' }
  if (detail.questions?.length) return { kind: 'question' }
  if (opts.approvals > 0 || detail.summary.status === 'waiting-approval' || activity?.phase === 'approval') return { kind: 'approval' }
  const { trailing } = opts.messageFacts ?? runMessageFacts(detail.messages)
  if (trailing) return { kind: 'tool', text: toolText(trailing) }
  if (activity?.phase === 'tool') return { kind: 'tool', text: activity.toolName ? `正在执行 ${activity.toolName}` : '正在执行工具' }
  if (detail.liveText) return { kind: 'reply' }
  if (detail.liveReasoning) return { kind: 'thinking' }
  if (activity?.phase === 'starting') {
    const since = parseTime(activity.since)
    return { kind: 'starting', slow: since !== undefined && opts.hostNow - since >= 10_000 }
  }
  return { kind: 'model' }
}

/**
 * A running tool's words on one line, for a screen reader while its own row says it: its row's words
 * (「运行 pnpm test」, 「读取 a.ts」), or 「正在执行」 with its title when it has no kind Latch reads.
 */
function toolText(message: Message): string {
  if (message.subagent) return `子 Agent ${message.subagent.title} ${message.subagent.stopping ? '正在停止…' : '运行中'}`
  const label = toolLabel({ ...message, state: 'running' })
  if (label.verb) return `${label.verb} ${label.object}`
  return message.tool?.toolTitle ? `正在${message.tool.toolTitle}` : `正在执行 ${label.object}`
}

const PHASE_WORDS: Record<Exclude<LivePhase['kind'], 'tool' | 'starting'>, string> = {
  cancelling: '正在停止…',
  approval: APPROVAL_COPY.waiting,
  question: APPROVAL_COPY.waiting,
  reply: '正在回复',
  thinking: '正在思考',
  model: '等待模型…',
}

/** A phase in words. */
export function phaseText(phase: LivePhase, harness: string): string {
  if (phase.kind === 'tool') return phase.text
  if (phase.kind === 'starting') return phase.slow ? `${harness} 启动较慢…` : `正在启动 ${harness}…`
  return PHASE_WORDS[phase.kind]
}

/** The one running clock: 0:47, 12:03, 1:02:03. */
export function runClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const pad = (value: number) => String(value).padStart(2, '0')
  return minutes < 60 ? `${minutes}:${pad(seconds % 60)}` : `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds % 60)}`
}

type StatusAction = 'keep-waiting' | 'stop'

/**
 * The status line under a running turn: what is really happening, never only that time passes. `tone`: `plain` is the
 * ordinary line; `amber` asks the person, because nothing else would tell them the run went quiet; `quiet` is a phase
 * with no line of its own, since the card that waits on the person already says so.
 */
export type RunStatus = {
  tone: 'plain' | 'amber' | 'quiet'
  /** Announced to a screen reader and shown, except in the quiet tone, where only a screen reader gets it. */
  text: string
  /** The elapsed part, kept apart so the words stay still while it ticks. */
  clock?: string
  actions?: StatusAction[]
  /** The system message recording a request Latch did not recognise. */
  viewMessageId?: string
}

const minutesText = (ms: number) => `${Math.max(1, Math.floor(ms / 60_000))} 分钟`

export function runStatus(detail: TaskDetail, opts: LivePhaseOptions & { harness: string; fallbackElapsed?: number }): RunStatus {
  const phase = livePhase(detail, opts)
  if (phase.kind === 'cancelling') return { tone: 'plain', text: PHASE_WORDS.cancelling }
  if (phase.kind === 'approval' || phase.kind === 'question') return { tone: 'quiet', text: PHASE_WORDS[phase.kind] }
  const live = detail.summary.live
  const unknown = live?.unrecognized
  // A request after the engine's last sign of life is what the run is stuck on; one it went on from is only on record.
  const stuck = unknown !== undefined && (parseTime(unknown.at) ?? 0) >= (parseTime(live?.lastEventAt) ?? 0)
  if (stuck) {
    return {
      tone: 'amber',
      // The method, when the detail names it: what was asked is what the person looks up.
      text: unknown.method ? `${opts.harness} 发来不支持的请求 ${unknown.method}` : `${opts.harness} 发来不支持的请求`,
      actions: ['stop'],
      ...(unknown.messageId ? { viewMessageId: unknown.messageId } : {}),
    }
  }
  if (live?.silent) {
    const quiet = opts.hostNow - (parseTime(live.lastEventAt) ?? opts.hostNow)
    const commandLike = live.activity === 'command' || live.activity === 'tool'
    return {
      tone: 'amber',
      text: commandLike ? `${live.commandName ?? '命令'} · ${minutesText(quiet)}没有输出` : `等模型回应 · ${minutesText(quiet)}没有新内容`,
      actions: ['keep-waiting', 'stop'],
    }
  }
  if (phase.kind === 'starting') return { tone: 'plain', text: phaseText(phase, opts.harness) }
  // An older Host says nothing about silence; the time since its last output is all there is to go on.
  const lastOutput = live ? undefined : parseTime(detail.lastOutputAt)
  if (lastOutput !== undefined && opts.hostNow - lastOutput > 120_000)
    return { tone: 'amber', text: `${minutesText(opts.hostNow - lastOutput)}没有新输出`, actions: ['stop'] }
  const elapsed = runElapsed(detail, opts.hostNow) ?? opts.fallbackElapsed
  const clock = elapsed === undefined ? undefined : runClock(elapsed)
  const running = opts.messageFacts
    ? opts.messageFacts.running
    : detail.messages.findLast(message => message.role === 'tool' && message.state === 'running')
  // The row reads the command itself where the Host may only have the tool's title.
  const command =
    running && toolKind(running) === 'execute' ? toolLabel(running).object : live?.activity === 'command' ? live.commandName : undefined
  const words = command ? `命令运行中 · ${command}` : '运行中'
  return { tone: 'plain', text: words, ...(clock ? { clock } : {}) }
}

/** How a run ended when it took more than a plain answer, for the line that stays under the turn. */
export interface RunEndLine {
  tone: 'red' | 'amber'
  text: string
  /** What was running when it ended, and has no row of its own in the turn: nobody can vouch for these. */
  unknown: string[]
  retry: boolean
}

/** `shown`: the IDs of the turn's rows; a call with its own row already says 结果未知 there and is not listed twice. */
export function runEndLine(summary: TaskDetail['summary'], harness: string, shown?: ReadonlySet<string>): RunEndLine | undefined {
  const end = summary.runEnd
  if (!end) return undefined
  const results = end.unknownResults ?? []
  const unknown = results.filter(result => !shown?.has(result.messageId)).map(result => result.name)
  const count = end.unknownResultCount ?? results.length
  const uncertain = count > 0 ? ` · 这 ${count} 条命令结果未知，请核对` : ''
  switch (end.reason) {
    case 'process-exited':
      return { tone: 'red', text: `${harness} 已退出 · 这一轮没有完成${uncertain}`, unknown, retry: true }
    case 'forced-stop':
      return { tone: 'amber', text: `已强制停止${uncertain}`, unknown, retry: false }
    case 'host-stopped':
      return { tone: 'amber', text: `Latch 重启时中断${uncertain}`, unknown, retry: true }
    case 'login-required':
      return { tone: 'amber', text: `${harness} 还没登录 · 登录后重试`, unknown, retry: true }
    case 'turn-ended':
      return count > 0 ? { tone: 'amber', text: `${harness} 结束了这一轮${uncertain}`, unknown, retry: false } : undefined
  }
}
