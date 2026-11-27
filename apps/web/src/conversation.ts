import {
  modelIdKey,
  splitChangeNote,
  type Approval,
  type Message,
  type RoutedModel,
  type TaskDetail,
  type TaskStatus,
  type TokenUsage,
  type ToolAction,
  type ToolDecision,
  type ToolKind,
} from '@latch/protocol'
import { checkSettle, unknownChecked } from './core/attend.ts'
import { parseDuration, parseTime } from './core/hostClock.ts'
import { unwrapShell, type UnwrappedCommand } from './core/shellUnwrap.ts'
import { stripAnsi } from './conversation/ansi.ts'
import { APPROVAL_COPY, DECISION_COPY, JUDGED_COPY } from './core/securityCopy.ts'
import { absoluteTime, argumentView, basename, clockTime, dayClockTime, formatDuration, messageTime, sameDay, sumUsage } from './format.ts'
import { diffCounts, previousState } from './diff.ts'
import { toolKind } from './icons.tsx'
import { thinkingWord } from './composer/modelReasoning.ts'
import { currentLocale, defineCopy, listText, plural } from './core/i18n.ts'
import { shownToolTitle } from './conversation/toolTitles.ts'

const COPY = defineCopy(
  {
    times: (note: string, count: number) => `${note} · ${count} 次`,
    failed: '失败',
    stopped: '已停止',
    partialReply: '保留了部分回复',
    interrupted: '回复中断',
    partialContent: '保留了部分内容',
    modelChange: (before: string, after: string) => `模型 ${before} → ${after}`,
    thinkingChange: (before: string, after: string) => `思考 ${before} → ${after}`,
    completed: '完成',
    stop: '停止',
    ended: '结束',
    started: (time: string) => `${time} 开始`,
    duration: (time: string, wait: string) => `用时 ${time}${wait}`,
    wait: (time: string) => `（不含等待批准 ${time}）`,
    read: '读取',
    edit: '编辑',
    delete: '删除',
    move: '移动',
    search: '搜索',
    execute: '运行',
    fetch: '获取',
    files: (count: number) => `${count} 个文件`,
    create: '新建',
    lines: (path: string, count: number) => `${path} · ${count} 行`,
    readFiles: (count: number) => `读取 ${count} 个文件`,
    listFolders: (count: number) => `列出 ${count} 个文件夹`,
    searches: (count: number) => `搜索 ${count} 次`,
    list: '列出',
    currentFolder: '当前文件夹',
    toolCall: '工具调用',
    worked: (time: string) => `已工作${time}`,
    failedSteps: (count: number) => `${count} 步失败`,
    deniedSteps: (count: number) => `${count} 步被拒绝`,
    unsuccessful: '没有成功',
    received: 'Mac 已收到',
    harnessStarted: 'Harness 已开始',
    changedFiles: (count: number) => `修改 ${count} 个文件`,
    commands: (count: number) => `运行 ${count} 条命令`,
    otherTools: (count: number) => `调用 ${count} 次其他工具`,
    executed: (count: number, details: string) => `上一次已经执行了 ${count} 个操作：${details}。`,
    unknown: (count: number) => `上一次有 ${count} 个操作结果未知，可能已经执行。`,
    mayRepeat: '重新发送后，Harness 可能再次执行它们。',
    executing: (name: string) => `正在执行 ${name}`,
    executingTool: '正在执行工具',
    stopping: '正在停止…',
    subagent: (name: string, status: string) => `子 Agent ${name} ${status}`,
    running: '运行中',
    doing: (name: string) => `正在${name}`,
    reply: '正在回复',
    reasoning: '正在思考',
    model: '等待模型…',
    slowStart: (harness: string) => `${harness} 启动较慢…`,
    starting: (harness: string) => `正在启动 ${harness}…`,
    minutes: (count: number) => `${count} 分钟`,
    unsupportedMethod: (harness: string, method: string) => `${harness} 发来不支持的请求 ${method}`,
    unsupported: (harness: string) => `${harness} 发来不支持的请求`,
    command: '命令',
    quietCommand: (command: string, duration: string) => `${command} · ${duration}没有输出`,
    quietModel: (duration: string) => `等模型回应 · ${duration}没有新内容`,
    quiet: (duration: string) => `${duration}没有新输出`,
    runningCommand: (command: string) => `命令运行中 · ${command}`,
    uncertainty: (count: number, note: string) => ` · 这 ${count} 条命令结果未知${note}`,
    checked: ' · 已核对',
    check: '，请核对',
    exited: (harness: string, uncertain: string) => `${harness} 已退出 · 这一轮没有完成${uncertain}`,
    forced: (uncertain: string) => `已强制停止${uncertain}`,
    restarted: (uncertain: string) => `Latch 重启时中断${uncertain}`,
    signedIn: '已登录',
    signIn: (harness: string) => `${harness} 还没登录 · 登录后重试`,
    turnEnded: (harness: string, uncertain: string) => `${harness} 结束了这一轮${uncertain}`,
  },
  {
    times: (note: string, count: number) => `${note} · ${count} times`,
    failed: 'Failed',
    stopped: 'Stopped',
    partialReply: 'Partial reply kept',
    interrupted: 'Reply interrupted',
    partialContent: 'Partial content kept',
    modelChange: (before: string, after: string) => `Model ${before} → ${after}`,
    thinkingChange: (before: string, after: string) => `Reasoning ${before} → ${after}`,
    completed: 'Completed',
    stop: 'Stopped',
    ended: 'Ended',
    started: (time: string) => `Started ${time}`,
    duration: (time: string, wait: string) => `Duration ${time}${wait}`,
    wait: (time: string) => ` (excluding ${time} for approval)`,
    read: 'Read',
    edit: 'Edit',
    delete: 'Delete',
    move: 'Move',
    search: 'Search',
    execute: 'Run',
    fetch: 'Fetch',
    files: (count: number) => `${count} files`,
    create: 'Create',
    lines: (path: string, count: number) => `${path} · ${count} lines`,
    readFiles: (count: number) => `Read ${count} files`,
    listFolders: (count: number) => plural(count, { one: 'Listed {n} folder', other: 'Listed {n} folders' }),
    searches: (count: number) => plural(count, { one: '{n} search', other: '{n} searches' }),
    list: 'List',
    currentFolder: 'Current folder',
    toolCall: 'Tool call',
    worked: (time: string) => `Worked ${time}`,
    failedSteps: (count: number) => plural(count, { one: '{n} step failed', other: '{n} steps failed' }),
    deniedSteps: (count: number) => plural(count, { one: '{n} step denied', other: '{n} steps denied' }),
    unsuccessful: 'Didn’t succeed',
    received: 'Received by Mac',
    harnessStarted: 'Harness started',
    changedFiles: (count: number) => plural(count, { one: 'Changed {n} file', other: 'Changed {n} files' }),
    commands: (count: number) => plural(count, { one: 'Ran {n} command', other: 'Ran {n} commands' }),
    otherTools: (count: number) => plural(count, { one: 'Called {n} other tool', other: 'Called {n} other tools' }),
    executed: (count: number, details: string) =>
      `Last time, ${plural(count, { one: '{n} action ran', other: '{n} actions ran' })}: ${details}.`,
    unknown: (count: number) =>
      plural(count, {
        one: 'Last time, {n} action had an unknown outcome and may have run.',
        other: 'Last time, {n} actions had unknown outcomes and may have run.',
      }),
    mayRepeat: 'The Harness may run them again if you resend.',
    executing: (name: string) => `Running ${name}`,
    executingTool: 'Running a tool',
    stopping: 'Stopping…',
    subagent: (name: string, status: string) => `Subagent ${name} · ${status}`,
    running: 'Running',
    doing: (name: string) => `Running ${name}`,
    reply: 'Replying',
    reasoning: 'Reasoning',
    model: 'Waiting for model…',
    slowStart: (harness: string) => `${harness} is taking longer to start…`,
    starting: (harness: string) => `Starting ${harness}…`,
    minutes: (count: number) => `${count} min`,
    unsupportedMethod: (harness: string, method: string) => `${harness} sent an unsupported request: ${method}`,
    unsupported: (harness: string) => `${harness} sent an unsupported request`,
    command: 'Command',
    quietCommand: (command: string, duration: string) => `${command} · No output for ${duration}`,
    quietModel: (duration: string) => `Waiting for model · No new content for ${duration}`,
    quiet: (duration: string) => `No new output for ${duration}`,
    runningCommand: (command: string) => `Running command · ${command}`,
    uncertainty: (count: number, note: string) =>
      ` · ${plural(count, { one: '{n} command with unknown outcome', other: '{n} commands with unknown outcomes' })}${note}`,
    checked: ' · Reviewed',
    check: '. Review the results',
    exited: (harness: string, uncertain: string) => `${harness} exited · This turn didn’t finish${uncertain}`,
    forced: (uncertain: string) => `Force stopped${uncertain}`,
    restarted: (uncertain: string) => `Interrupted when Latch restarted${uncertain}`,
    signedIn: 'Signed in',
    signIn: (harness: string) => `${harness} isn’t signed in · Sign in and retry`,
    turnEnded: (harness: string, uncertain: string) => `${harness} ended this turn${uncertain}`,
  },
)

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

const COMPACTED = /^\S.* 已压缩上下文$/u

/**
 * A Harness that compacts at the start of every turn (its context is still over its limit after a compaction) leaves the
 * same row in turn after turn. A run of such rows in consecutive turns keeps its last, with how many there were; a row
 * with a summary or another outcome, and one in a turn the person opened with /compact, stays as it is.
 */
export function collapseCompactions(messages: Message[]): Message[] {
  const runs: Message[][] = []
  let turn = 0
  let opener: Message | undefined
  let last: { text: string; turn: number } | undefined
  for (const message of messages) {
    if (message.role === 'user' && !message.steered) {
      turn += 1
      opener = message
      continue
    }
    if (message.role !== 'system' || !message.id.startsWith('compaction:') || !COMPACTED.test(message.text)) continue
    if (opener?.text.trim().startsWith('/compact')) {
      last = undefined
      continue
    }
    if (last && last.text === message.text && turn === last.turn + 1) runs.at(-1)!.push(message)
    else runs.push([message])
    last = { text: message.text, turn }
  }
  const dropped = new Set<Message>()
  const counted = new Map<Message, number>()
  for (const run of runs) {
    if (run.length < 2) continue
    for (const message of run.slice(0, -1)) dropped.add(message)
    counted.set(run.at(-1)!, run.length)
  }
  if (!dropped.size) return messages
  return messages.flatMap(message => {
    if (dropped.has(message)) return []
    const count = counted.get(message)
    return count === undefined ? [message] : [{ ...message, text: COPY.times(message.text, count) }]
  })
}

/**
 * A Harness that reports a failed model request writes the error as its reply as well (Claude's 「API Error: 400 …」),
 * and the turn's failure row says the same. A turn whose whole reply is that text, and nothing else of its own, keeps
 * only the failure row; a reply that says anything more, thinks or calls a tool stays as it is.
 */
export function withoutEchoedFailures(messages: Message[]): Message[] {
  const echoes = new Set<Message>()
  for (const turn of turnsOf(messages)) {
    const replies = turn.replies.filter(message => message.role === 'assistant' || message.role === 'tool')
    const reply = replies.length === 1 && replies[0]!.role === 'assistant' ? replies[0]! : undefined
    const said = reply?.text.trim()
    if (!reply || !said || reply.reasoning) continue
    const failure = turn.replies.find(
      message => message.role === 'system' && message.state === 'failed' && message.text.trim().endsWith(`：${said}`),
    )
    if (failure) echoes.add(reply)
  }
  return echoes.size ? messages.filter(message => !echoes.has(message)) : messages
}

/** The immutable committed history. A body-only frame can reuse this whole projection. */
export function projectTurns(messages: Message[], previous: readonly Turn[] = []) {
  const turns = stableTurns(previous, turnsOf(withoutEchoedFailures(collapseCompactions(messages))))
  return {
    turns,
    history: turns.slice(0, -1),
    ids: new Set(messages.map(message => message.id)),
    switches: settingSwitches(turns),
    index: turns.map(turn => ({ key: turn.key, at: turnTimes(turn).startedAt })),
    messageFacts: runMessageFacts(messages, turns),
  }
}

export type TranscriptProjection = ReturnType<typeof projectTurns>

/** Only the last turn owns the synthetic reply; a committed ID always wins, just as in renderedMessages. */
export function liveTurn(projection: TranscriptProjection, detail: TaskDetail): Turn | undefined {
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
  if (outcome === 'failed') return [COPY.failed]
  if (outcome === 'stopped') return turnText(turn) ? [COPY.stopped, COPY.partialReply] : [COPY.stopped]
  if (outcome === 'interrupted')
    return turnText(turn) || turn.replies.some(message => message.role === 'tool')
      ? [COPY.interrupted, COPY.partialContent]
      : [COPY.interrupted]
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
  /** A 「出错时改用」 service answered requests of the turn: the one whose reply came back last, and the model it said. */
  fallback?: { providerId: string; model?: string }
  /** The built-in harness: nothing went through the gateway, and only `fallback` says anything. */
  direct: boolean
  /** The Harness asked for a thinking level the model does not declare, and Latch sent the nearest one or none. */
  thinkingAdjusted: boolean
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
  const moved = main?.fallback && main.provider ? main : models.find(entry => entry.fallback && entry.provider)
  return {
    direct: routed.direct === true,
    thinkingAdjusted: routed.dropped?.includes('thinking-level') === true,
    ...(moved ? { fallback: { providerId: moved.provider!, ...(moved.used ? { model: moved.used } : {}) } } : {}),
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
    else if (modelChanged && model !== undefined) switches.set(turn.key, COPY.modelChange(model, step.model))
    else if (thinkingChanged && thinking !== undefined && nextThinking !== undefined)
      switches.set(turn.key, COPY.thinkingChange(thinking, nextThinking))
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

const END_WORDS: Record<TurnOutcome, string> = {
  get completed() {
    return COPY.completed
  },
  get stopped() {
    return COPY.stop
  },
  get failed() {
    return COPY.ended
  },
  get interrupted() {
    return COPY.ended
  },
}

/**
 * The tooltip of a settled turn's time: 「10月25日 14:31:05 开始 · 14:32:17 完成 · 用时 1 分 12 秒（不含等待批准 20 秒）」.
 * The end carries its day only when the turn crossed midnight; the duration (the Host's working time) and the approval
 * wait appear only when recorded, and an interrupted turn has no duration.
 */
export function turnTimeTip(times: TurnTimes, outcome: TurnOutcome, now: number): string | undefined {
  const parts: string[] = []
  const { startedAt, sentAt } = times
  if (startedAt !== undefined) parts.push(COPY.started(dayClockTime(startedAt, now)))
  if (sentAt !== undefined)
    parts.push(
      `${startedAt !== undefined && sameDay(startedAt, sentAt) ? clockTime(sentAt) : dayClockTime(sentAt, now)} ${END_WORDS[outcome]}`,
    )
  const duration = outcome === 'interrupted' || times.activeMs === undefined ? undefined : formatDuration(times.activeMs)
  if (duration) {
    const wait = times.waitMs !== undefined && times.waitMs >= 1000 ? formatDuration(times.waitMs) : undefined
    parts.push(COPY.duration(duration, wait ? COPY.wait(wait) : ''))
  }
  return parts.length ? parts.join(' · ') : undefined
}

// ---- Process rows ------------------------------------------------------------------------------------------------

const VERBS: Partial<Record<ToolKind, string>> = {
  get read() {
    return COPY.read
  },
  get edit() {
    return COPY.edit
  },
  get delete() {
    return COPY.delete
  },
  get move() {
    return COPY.move
  },
  get search() {
    return COPY.search
  },
  get execute() {
    return COPY.execute
  },
  get fetch() {
    return COPY.fetch
  },
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
  if (diffs.length > 1) return { verb: COPY.edit, object: COPY.files(diffs.length), mono: false }
  const diff = diffs[0]!
  if (previousState(diff) !== 'none') return { verb: COPY.edit, object: shortPath(diff.path), mono: false }
  const lines = diff.newText === '' ? 0 : diff.newText.replace(/\n$/, '').split('\n').length
  return { verb: COPY.create, object: COPY.lines(shortPath(diff.path), lines), mono: false }
}

/** A command call's line: as the agent reported it, as a row shows it, and the shell wrapper it came in, if any. */
export interface CommandLine extends UnwrappedCommand {
  reported: string
}

const COMMAND_KEYS = ['command', 'cmd']

/** The command line of a call that reports one on a single line; a wrapper Latch does not recognise is shown as it is. */
export function commandLine(tool: Message['tool']): CommandLine | undefined {
  const reported = argument(tool?.input, COMMAND_KEYS)
  return reported === undefined ? undefined : { reported, ...unwrapShell(reported) }
}

/**
 * The command an approval asks about, whole and on as many lines as it has: the person allows what they read, so
 * nothing is cut, and the wrapper it runs through is named beside it. Undefined when the call reports no command.
 */
export function approvalCommand(tool: Message['tool'], fallback?: string): CommandLine | undefined {
  const text = tool?.input ?? fallback
  if (!text) return undefined
  try {
    const input: unknown = JSON.parse(text)
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
    for (const key of COMMAND_KEYS) {
      const reported = (input as Record<string, unknown>)[key]
      if (typeof reported === 'string' && reported.trim()) return { reported, ...unwrapShell(reported) }
    }
  } catch {
    /* A plain-text or truncated argument block is kept as evidence but does not identify a command. */
  }
  return undefined
}

/**
 * What the Harness itself says a command does, when it classified all of it as reads, listings and searches (Codex).
 * A call that still waits to be allowed is always shown as the command it is.
 */
export function shownActions(message: Pick<Message, 'tool' | 'state'>): ToolAction[] | undefined {
  const tool = message.tool
  if (!tool?.actions?.length || (tool.kind !== undefined && tool.kind !== 'execute')) return undefined
  if (message.state === 'awaiting-approval' || message.state === 'queued') return undefined
  // A classification may only make a plain command quieter. One that pipes, chains, redirects or substitutes can
  // write or run something its classification does not name (`cat list | xargs rm`), so it stays the command it is.
  const line = commandLine(tool)
  if (!line || COMPOUND.test(line.command)) return undefined
  return tool.actions
}

/** What joins, redirects or nests commands in a shell line; a line with any of it is never read as its classification. */
const COMPOUND = /[|;&<>`\n]|\$\(/u

/** The kind a row is drawn as: a command its Harness classified reads as what it does. */
export function rowKind(message: Pick<Message, 'tool' | 'toolName' | 'state'>): ToolKind {
  const actions = shownActions(message)
  if (!actions) return toolKind(message)
  return actions.every(action => action.kind === 'read') ? 'read' : 'search'
}

/** How many quiet steps of each kind, in words: 「读取 3 个文件，搜索 2 次」. Only what was counted is said. */
export function quietWords(counts: { read: number; list: number; search: number }): string {
  return [
    ...(counts.read ? [COPY.readFiles(counts.read)] : []),
    ...(counts.list ? [COPY.listFolders(counts.list)] : []),
    ...(counts.search ? [COPY.searches(counts.search)] : []),
  ].join('，')
}

function actionLabel(actions: readonly ToolAction[]): ToolLabel {
  const [only] = actions
  if (actions.length === 1 && only) {
    if (only.kind === 'read' && only.path) return { verb: COPY.read, object: shortPath(only.path), mono: false }
    if (only.kind === 'list') {
      const folder = only.path?.replace(/[\\/]+$/u, '')
      return { verb: COPY.list, object: folder ? shortPath(folder) : COPY.currentFolder, mono: false }
    }
    if (only.kind === 'search' && only.query) return { verb: COPY.search, object: only.query, mono: true }
    if (only.kind === 'search' && only.path) return { verb: COPY.search, object: shortPath(only.path), mono: false }
  }
  const count = (kind: ToolAction['kind']) => actions.filter(action => action.kind === kind).length
  return { object: quietWords({ read: count('read'), list: count('list'), search: count('search') }), mono: false }
}

export function toolLabel(message: Pick<Message, 'tool' | 'toolName' | 'state'>): ToolLabel {
  const tool = message.tool
  if (isReview(tool)) return { object: JUDGED_COPY.review(tool!.judged!.by), mono: false }
  const edited = diffLabel(tool)
  if (edited) return edited
  const actions = shownActions(message)
  if (actions) return actionLabel(actions)
  if (tool?.toolTitle) {
    const found = titledObject(tool)
    const shown = shownToolTitle(tool.toolTitle, message.toolName)
    if (!found) return { object: shown, mono: false }
    return { verb: shown, object: found.path ? shortPath(found.object) : found.object, mono: !found.path }
  }
  const kind = toolKind(message)
  const verb = VERBS[kind]
  let object: string | undefined
  let mono = true
  // A shell wrapper is not the command: the row shows what it carried, and the reported line stays in its details.
  if (kind === 'execute') object = commandLine(tool)?.command
  else if (kind === 'read' || kind === 'edit' || kind === 'delete' || kind === 'move') {
    const path = tool?.locations?.[0] ?? argument(tool?.input, PATH_KEYS)
    object = path === undefined ? undefined : shortPath(path)
    mono = false
  } else if (kind === 'search') object = argument(tool?.input, ['query', 'pattern', 'q'])
  else if (kind === 'fetch') object = argument(tool?.input, ['url'])
  if (object !== undefined && verb !== undefined) return { verb, object, mono }
  // A title that only repeats the tool's identifier is the raw name.
  if (tool?.title && tool.title !== message.toolName) return { object: tool.title, mono: false }
  return message.toolName ? { object: message.toolName, mono: true } : { object: COPY.toolCall, mono: false }
}

/** The row is the harness's own model reviewing a request, not a call of its own. */
export const isReview = (tool: Message['tool']) =>
  tool?.judged !== undefined && tool.judged.outcome !== 'unasked' && tool.judged.own !== true && tool.blocked === undefined

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
 * How many lines of a scrolling box lie below what it shows, from its own measured geometry; none when it does not
 * scroll or is at its end.
 */
export function linesBelow(box: { scrollHeight: number; clientHeight: number; scrollTop: number }, lineHeight: number): number {
  const below = box.scrollHeight - box.clientHeight - box.scrollTop
  return lineHeight > 0 && below > 1 ? Math.max(1, Math.round(below / lineHeight)) : 0
}

/**
 * The words an approval card and an export name a call by: a titled tool's title and object (「写入文件 notes/plan.md」),
 * else the call's own summary or the tool's name.
 */
export function toolHeading(tool: Message['tool'], toolName: string | undefined, recorded = false): string {
  if (isReview(tool)) return JUDGED_COPY.review(tool!.judged!.by)
  if (tool?.toolTitle) {
    const found = titledObject(tool)
    // `recorded`: an approval card of another Harness shows the title as reported, which is its evidence.
    const shown = recorded ? tool.toolTitle : shownToolTitle(tool.toolTitle, toolName)
    return found ? `${shown} ${found.object}` : shown
  }
  return tool?.title || toolName || COPY.toolCall
}

/** The structured file path printed by toolHeading, if its object is a path. */
export function toolHeadingPath(tool: Message['tool']): string | undefined {
  if (!tool?.toolTitle || isReview(tool)) return undefined
  const found = titledObject(tool)
  return found?.path ? found.object : undefined
}

/** What a row's edits add and remove, in lines; undefined when it edits nothing. */
export function diffStat(tool: Message['tool']): { add: number; del: number } | undefined {
  if (!tool?.diffs?.length) return undefined
  let add = 0
  let del = 0
  for (const diff of tool.diffs) {
    const view = diffCounts(diff)
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
  // A call that reported nothing has its arguments or title as its text, which are not output.
  if (
    message.tool?.output === undefined
    && (message.text === message.tool?.input
      || message.text === message.tool?.title
      || (message.tool?.title !== undefined
        && message.tool?.input !== undefined
        && message.text === `${message.tool.title} · ${message.tool.input}`))
  )
    return ''
  const output = message.tool?.output ?? message.text
  return withoutToolCode(legacyRejected(message) ? output.slice(LEGACY_REJECTED.length).trimStart() : output)
}

/**
 * The runtime's codes in front of a tool's report and of each fact it adds after a blank line (`TOOL_ERROR: …`,
 * `TOOL_OUTCOME_UNKNOWN: …`) are for the model; a person reads what follows them.
 */
export const withoutToolCode = (text: string) => text.replace(/(^|\n\n)TOOL_[A-Z_]+:[^\S\n]*/gu, '$1')

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

// ---- Reasoning -------------------------------------------------------------------------------------------------------

/** A stretch of reported reasoning under the title its Harness gave it (Codex's summaries); one without a title has none. */
export interface ReasoningSection {
  title?: string
  body: string
}

/** A line that is one bold phrase and nothing else, after a blank line or at the start: a summary part's title. */
const SECTION_TITLE = /^\*\*([^*\n]+)\*\*[ \t]*$/u
/** The start of such a line while its end has not arrived. */
const PENDING_TITLE = /^\*\*[^*\n]*\*?$/u

/**
 * Reasoning as its sections. Text without a title line is one section, exactly as written. `live`: the last line may be
 * a title still arriving, which is left out until it is whole, so its asterisks never show.
 */
export function reasoningSections(text: string, live = false): ReasoningSection[] {
  if (!text.includes('**')) return text ? [{ body: text }] : []
  let source = text
  if (live) {
    const last = text.lastIndexOf('\n') + 1
    const before = text.slice(0, last)
    if (PENDING_TITLE.test(text.slice(last)) && !SECTION_TITLE.test(text.slice(last)) && /(?:^|\n[ \t]*\n)$/u.test(before)) source = before
  }
  const sections: ReasoningSection[] = []
  let title: string | undefined
  let body: string[] = []
  let blank = true
  let titled = false
  const flush = () => {
    const words = body.join('\n').trim()
    if (title !== undefined || words) sections.push({ ...(title !== undefined ? { title } : {}), body: words })
  }
  for (const line of source.split('\n')) {
    const found = blank ? SECTION_TITLE.exec(line)?.[1]?.trim() : undefined
    if (found) {
      flush()
      title = found
      titled = true
      body = []
      blank = true
      continue
    }
    body.push(line)
    blank = line.trim() === ''
  }
  if (!titled) return source.trim() ? [{ body: source === text ? text : source.trimEnd() }] : []
  flush()
  return sections
}

// ---- A turn's blocks and its fold --------------------------------------------------------------------------------

/**
 * A row of the work: a tool, a block's reasoning, a run of finished quiet steps (reads, listings, searches) as one row,
 * or, where the reader chose to keep the work folded, the steps between the rows that always show.
 */
export type WorkItem =
  | { kind: 'tool'; message: Message }
  | { kind: 'thinking'; message: Message }
  | { kind: 'reads'; messages: Message[] }
  | { kind: 'steps'; items: WorkItem[]; count: number }

/** How much of the work a reader keeps in view (设置 › 通用 › 工作过程). */
export type WorkLevel = 'all' | 'failures' | 'folded'

/**
 * A turn in reading order. The work is what folds; prose and notes never do, so they are blocks of their own, and an
 * answer keeps its place in the tree from its first word to its last.
 */
export type TurnBlock =
  | { kind: 'work'; key: string; items: WorkItem[] }
  | { kind: 'prose'; message: Message }
  | { kind: 'note'; message: Message }
  | { kind: 'picture'; message: Message }

/** A question stays in reading order: its card or its record 「你选了…」 is what the person said, not the agent's work. */
const isQuestion = (message: Message) => message.toolName === 'ask_user'

/**
 * The Harness's image tool (`ToolDetail.imageGeneration`): not work but the picture's place, a block of its own that
 * never folds, holding the picture once it is made.
 */
export const isPictureRow = (message: Message) => message.role === 'tool' && message.tool?.imageGeneration === true

const itemKey = (item: WorkItem): string =>
  item.kind === 'reads' ? item.messages[0]!.id : item.kind === 'steps' ? itemKey(item.items[0]!) : item.message.id

/**
 * A row that shows whatever the reader chose to hide: a call that waits for them, one that failed, was refused,
 * cancelled or interrupted, one whose result is unknown or contradicts its approval, and a subagent that can still be
 * stopped or that holds such a step. Questions and failure notes are not work and are never hidden at all.
 */
export function alwaysShown(message: Message): boolean {
  if (message.state === 'awaiting-approval') return true
  const shown = shownToolState(message)
  if (shown !== 'completed' && shown !== 'running' && shown !== 'queued') return true
  if (ranDespite(message)) return true
  const subagent = message.subagent
  if (!subagent) return false
  return subagent.stoppable === true || subagent.status === 'failed' || subagent.status === 'unknown' || subagent.steps.some(alwaysShown)
}

/** The tool steps a row stands for; a thought is no step. */
const itemSteps = (item: WorkItem): number =>
  item.kind === 'reads' ? item.messages.length : item.kind === 'steps' ? item.count : item.kind === 'tool' ? 1 : 0

/** The rows a level leaves: every one, only those that always show, or those with the rest folded between them. */
function atLevel(items: WorkItem[], level: WorkLevel): WorkItem[] {
  if (level === 'all') return items
  const out: WorkItem[] = []
  let rest: WorkItem[] = []
  const flush = () => {
    if (level === 'folded' && rest.length > 0)
      out.push({ kind: 'steps', items: rest, count: rest.reduce((sum, item) => sum + itemSteps(item), 0) })
    rest = []
  }
  for (const item of items) {
    if (item.kind === 'tool' && alwaysShown(item.message)) {
      flush()
      out.push(item)
    } else rest.push(item)
  }
  flush()
  return out
}

/** How many consecutive finished quiet steps run together into one row. */
export const QUIET_GROUP_MIN = 3

/**
 * A step that runs together with its neighbours: a read, a listing or a search that finished and that nobody had to
 * decide about. A command, an edit, a step that failed, was refused, was interrupted or has an unknown result, one
 * with pictures, a subagent and anything still running always stays a row of its own.
 */
function quietStep(message: Message): boolean {
  if (message.state !== 'completed' || shownToolState(message) !== 'completed') return false
  const tool = message.tool
  if (message.subagent || message.attachments?.length || tool?.decision || tool?.judged || tool?.blocked || tool?.diffs?.length)
    return false
  const kind = rowKind(message)
  return kind === 'read' || kind === 'search'
}

/** What a run of quiet steps did, counted from the steps themselves: 「读取 3 个文件，搜索 2 次」. */
export function quietGroupWords(messages: readonly Message[]): string {
  const counts = { read: 0, list: 0, search: 0 }
  for (const message of messages) {
    const actions = shownActions(message)
    if (actions) for (const action of actions) counts[action.kind]++
    else counts[rowKind(message) === 'read' ? 'read' : 'search']++
  }
  return quietWords(counts)
}

function joinQuiet(items: WorkItem[]): WorkItem[] {
  const out: WorkItem[] = []
  let run: Message[] = []
  const flush = () => {
    if (run.length >= QUIET_GROUP_MIN) out.push({ kind: 'reads', messages: run })
    else for (const message of run) out.push({ kind: 'tool', message })
    run = []
  }
  for (const item of items) {
    if (item.kind === 'tool' && quietStep(item.message)) run.push(item.message)
    else {
      flush()
      out.push(item)
    }
  }
  flush()
  return out
}

/**
 * The turn's blocks. Three or more consecutive finished quiet steps are one row, 「读取 4 个文件」, in a running turn as
 * in a settled one: the step still running stays below it and joins it once it finishes. The group is keyed by its
 * first step, so it keeps its place and whether it is open while it grows. `level` then leaves every row, only the rows
 * that always show (`alwaysShown`), or those with the rest folded between them; a block it leaves nothing of is gone.
 */
export function turnBlocks(turn: Turn, level: WorkLevel = 'all'): TurnBlock[] {
  const blocks: TurnBlock[] = []
  let work: WorkItem[] = []
  const flush = () => {
    if (work.length === 0) return
    const items = atLevel(joinQuiet(work), level)
    if (items.length > 0) blocks.push({ kind: 'work', key: `work:${itemKey(work[0]!)}`, items })
    work = []
  }
  for (const message of turn.replies) {
    if (isPictureRow(message)) {
      flush()
      blocks.push({ kind: 'picture', message })
      continue
    }
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
  return (
    turn.replies.some(message => message.role === 'tool' && !isQuestion(message) && !isPictureRow(message))
    && turnText(turn).trim().length > 0
  )
}

/** The fold's words: 「已工作 2 分 13 秒」 when the Host recorded it, 「已工作」 for older history, and what it must not hide. */
export function foldWords(turn: Turn): string {
  const spent = formatDuration(turnTimes(turn).activeMs ?? 0)
  const count = (state: ShownToolState) =>
    turn.replies.filter(message => message.role === 'tool' && !isPictureRow(message) && shownToolState(message) === state).length
  const failed = count('failed')
  const rejected = count('rejected')
  // What the Harness's own model stopped happened without the person, so the fold says it, its subagents' too.
  const denied = countCalls(turn.replies, tool => tool.judged?.outcome === 'denied' || tool.blocked?.source === 'model')
  const ruled = countCalls(turn.replies, tool => tool.blocked?.source === 'rule')
  return [
    COPY.worked(spent ? ` ${spent}` : ''),
    ...(failed ? [COPY.failedSteps(failed)] : []),
    ...(rejected ? [COPY.deniedSteps(rejected)] : []),
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

/** A line that names an error, which a test runner's output puts after the cases that passed. */
const ERROR_LINE = /(?:error|exception)\b|\b(?:fatal|panic)\b|错误/iu

/**
 * One line for a failed row: the first line of what it reported that names an error, else its first line, without the
 * runtime's code or terminal colours, and cut.
 */
export function failureReason(message: Pick<Message, 'state' | 'tool' | 'text'>): string {
  const lines = stripAnsi(shownToolOutput(message))
    .split('\n')
    .map(part => part.trim())
    .filter(Boolean)
  const line = lines.find(part => ERROR_LINE.test(part)) ?? lines[0]
  const reason = line ? withoutToolCode(line) : ''
  if (!reason) return COPY.unsuccessful
  return reason.length > 120 ? `${reason.slice(0, 120)}…` : reason
}

/** The answer's delivery under the person's latest bubble, until anything of the answer shows (text, thought or tool row). */
export function deliveryWords(detail: TaskDetail, turn: Turn): string | undefined {
  const activity = detail.summary.live?.activity
  if (activity === undefined || isLive(detail) || turn.replies.length > 0) return undefined
  return activity === 'starting' ? COPY.received : COPY.harnessStarted
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
      effects.edits ? COPY.changedFiles(effects.edits) : '',
      effects.commands ? COPY.commands(effects.commands) : '',
      effects.others ? COPY.otherTools(effects.others) : '',
    ].filter(Boolean)
    parts.push(COPY.executed(done, listText(what)))
  }
  if (effects.unknown > 0) parts.push(COPY.unknown(effects.unknown))
  parts.push(COPY.mayRepeat)
  return parts.join(currentLocale() === 'en' ? ' ' : '')
}

/**
 * What resending a turn sends again: the person's words, without the Host's note about an undo. A fork's text record of
 * its source stays unless the Harness forked its own record, since the record may never have reached it otherwise. A
 * conversation that came back to a Harness keeps it too: the fork it went on from lacks what was said elsewhere, which
 * went only with the first send.
 */
export function resendText(message: Pick<Message, 'text' | 'forkContext' | 'nativeFork' | 'importContext'>): string {
  // A text rebuild's conversation went with the first send; the session holds it from then on.
  const own =
    message.forkContext && message.nativeFork && !message.forkContext.moved
      ? message.forkContext.prefixLength
      : (message.importContext?.prefixLength ?? 0)
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
  if (activity?.phase === 'tool') return { kind: 'tool', text: activity.toolName ? COPY.executing(activity.toolName) : COPY.executingTool }
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
  if (message.subagent) return COPY.subagent(message.subagent.title, message.subagent.stopping ? COPY.stopping : COPY.running)
  const label = toolLabel({ ...message, state: 'running' })
  if (label.verb) return `${label.verb} ${label.object}`
  return message.tool?.toolTitle ? COPY.doing(shownToolTitle(message.tool.toolTitle, message.toolName)) : COPY.executing(label.object)
}

const PHASE_WORDS: Record<Exclude<LivePhase['kind'], 'tool' | 'starting'>, string> = {
  get cancelling() {
    return COPY.stopping
  },
  get approval() {
    return APPROVAL_COPY.waiting
  },
  get question() {
    return APPROVAL_COPY.waiting
  },
  get reply() {
    return COPY.reply
  },
  get thinking() {
    return COPY.reasoning
  },
  get model() {
    return COPY.model
  },
}

/** A phase in words. */
export function phaseText(phase: LivePhase, harness: string): string {
  if (phase.kind === 'tool') return phase.text
  if (phase.kind === 'starting') return phase.slow ? COPY.slowStart(harness) : COPY.starting(harness)
  return PHASE_WORDS[phase.kind]
}

/** The one running clock: 0:47, 12:03, 1:02:03. */
export function runClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const pad = (value: number) => String(value).padStart(2, '0')
  return minutes < 60 ? `${minutes}:${pad(seconds % 60)}` : `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds % 60)}`
}

/**
 * The status under a running turn: what is really happening, never only that time passes. `tone`: `plain` is the
 * ordinary line, including a lull in output. `amber` calls out a request Latch could not handle. `quiet` is a
 * phase with no line of its own, since the card that waits on the person already says so.
 */
export type RunStatus = {
  tone: 'plain' | 'amber' | 'quiet'
  /** Announced to a screen reader and shown, except in the quiet tone, where only a screen reader gets it. */
  text: string
  /** The elapsed part, kept apart so the words stay still while it ticks. */
  clock?: string
  /** The session's title row already says this (the activity with its clock, or 正在停止): the line draws nothing. */
  inHeader?: true
  noOutput?: true
  /** The system message recording a request Latch did not recognise. */
  viewMessageId?: string
}

const minutesText = (ms: number) => COPY.minutes(Math.max(1, Math.floor(ms / 60_000)))

/** New Hosts judge silence themselves. Older Hosts can only report the last visible output. */
function quietRunMs(detail: Pick<TaskDetail, 'summary' | 'lastOutputAt'>, now: number): number | undefined {
  const live = detail.summary.live
  if (live) return live.silent ? now - (parseTime(live.lastEventAt) ?? now) : undefined
  const lastOutput = parseTime(detail.lastOutputAt)
  return lastOutput !== undefined && now - lastOutput > 120_000 ? now - lastOutput : undefined
}

export function runStatus(detail: TaskDetail, opts: LivePhaseOptions & { harness: string; fallbackElapsed?: number }): RunStatus {
  const phase = livePhase(detail, opts)
  if (phase.kind === 'cancelling') return { tone: 'plain', text: PHASE_WORDS.cancelling, inHeader: true }
  if (phase.kind === 'approval' || phase.kind === 'question') return { tone: 'quiet', text: PHASE_WORDS[phase.kind] }
  const live = detail.summary.live
  const unknown = live?.unrecognized
  // A request after the engine's last sign of life is what the run is stuck on; one it went on from is only on record.
  const stuck = unknown !== undefined && (parseTime(unknown.at) ?? 0) >= (parseTime(live?.lastEventAt) ?? 0)
  if (stuck) {
    return {
      tone: 'amber',
      // The method, when the detail names it: what was asked is what the person looks up.
      text: unknown.method ? COPY.unsupportedMethod(opts.harness, unknown.method) : COPY.unsupported(opts.harness),
      ...(unknown.messageId ? { viewMessageId: unknown.messageId } : {}),
    }
  }
  const quiet = quietRunMs(detail, opts.hostNow)
  if (quiet !== undefined && live) {
    const commandLike = live.activity === 'command' || live.activity === 'tool'
    return {
      tone: 'plain',
      noOutput: true,
      text: commandLike
        ? COPY.quietCommand(live.commandName ? shownToolTitle(live.commandName) : COPY.command, minutesText(quiet))
        : COPY.quietModel(minutesText(quiet)),
    }
  }
  // The header writes the Host's own activity word, 正在启动 included; without one (an older Host) the line says it here.
  if (phase.kind === 'starting')
    return { tone: 'plain', text: phaseText(phase, opts.harness), ...(live ? { inHeader: true as const } : {}) }
  // An older Host says nothing about silence; the time since its last output is all there is to go on.
  if (quiet !== undefined) return { tone: 'plain', text: COPY.quiet(minutesText(quiet)), noOutput: true }
  const elapsed = runElapsed(detail, opts.hostNow) ?? opts.fallbackElapsed
  const clock = elapsed === undefined ? undefined : runClock(elapsed)
  const running = opts.messageFacts
    ? opts.messageFacts.running
    : detail.messages.findLast(message => message.role === 'tool' && message.state === 'running')
  // The row reads the command itself where the Host may only have the tool's title.
  const command =
    running && toolKind(running) === 'execute'
      ? toolLabel(running).object
      : live?.activity === 'command' && live.commandName
        ? shownToolTitle(live.commandName)
        : undefined
  const words = command ? COPY.runningCommand(command) : COPY.running
  return { tone: 'plain', text: words, inHeader: true, ...(clock ? { clock } : {}) }
}

/** How a run ended when it took more than a plain answer, for the line that stays under the turn. */
export interface RunEndLine {
  /** `plain`: nothing is left to warn of, as once the Harness says it is logged in after a turn it refused for that. */
  tone: 'red' | 'amber' | 'plain'
  text: string
  /** What was running when it ended, and has no row of its own in the turn: nobody can vouch for these. */
  unknown: string[]
  retry: boolean
  /** The Host holds the session in 等你处理 for these results: 已核对 takes it out. */
  check: boolean
}

/**
 * `shown`: the IDs of the turn's rows; a call with its own row already says 结果未知 there and is not listed twice.
 * `loggedIn`: the Harness itself said it is logged in since this run was refused for want of it; 重试 is what is left.
 */
export function runEndLine(
  summary: TaskDetail['summary'],
  harness: string,
  shown?: ReadonlySet<string>,
  loggedIn = false,
): RunEndLine | undefined {
  const end = summary.runEnd
  if (!end) return undefined
  const results = end.unknownResults ?? []
  const unknown = results.filter(result => !shown?.has(result.messageId)).map(result => shownToolTitle(result.name))
  const count = end.unknownResultCount ?? results.length
  const checked = unknownChecked(summary)
  const uncertain = count > 0 ? COPY.uncertainty(count, checked ? COPY.checked : COPY.check) : ''
  const check = count > 0 && checkSettle(summary) !== undefined
  switch (end.reason) {
    case 'process-exited':
      return { tone: 'red', text: COPY.exited(harness, uncertain), unknown, retry: true, check }
    case 'forced-stop':
      return { tone: 'amber', text: COPY.forced(uncertain), unknown, retry: false, check }
    case 'host-stopped':
      return { tone: 'amber', text: COPY.restarted(uncertain), unknown, retry: true, check }
    case 'login-required':
      return loggedIn
        ? { tone: 'plain', text: COPY.signedIn, unknown, retry: true, check: false }
        : { tone: 'amber', text: COPY.signIn(harness), unknown, retry: true, check: false }
    case 'turn-ended':
      return count > 0 ? { tone: 'amber', text: COPY.turnEnded(harness, uncertain), unknown, retry: false, check } : undefined
  }
}
