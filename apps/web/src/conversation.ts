import type { Approval, Message, TaskDetail, TaskStatus, TokenUsage, ToolKind } from '@latch/protocol'
import { parseDuration, parseTime } from './core/hostClock.ts'
import { argumentView, clockTime, dayClockTime, exactTokens, formatDuration, sameDay, sumUsage, tokenAmount } from './format.ts'
import { toolKind } from './icons.tsx'

/*
 * What the conversation shows, derived from the Host's messages alone: turns, their footers, what a process row says,
 * when the process before an answer folds away, where time separators go and the live phase of a run. Every time and
 * count comes from a Host field; when a field is missing (an older Host, a plugin driver, older history) the part that
 * needs it is left out rather than estimated.
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

/** A prompt and everything that answered it, up to the next prompt. Content before any prompt is a turn of its own. */
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
    if (message.role === 'user') turns.push({ key: message.id, user: message, replies: [] })
    else {
      const last = turns.at(-1)
      if (last) last.replies.push(message)
      else turns.push({ key: `lead:${message.id}`, replies: [message] })
    }
  }
  return turns
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

/** The model the turn's first step used, for the source row. */
export const turnModel = (turn: Turn): Message | undefined =>
  turn.replies.find(message => message.role === 'assistant' && typeof message.model === 'string' && message.model)

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

const VERBS: Partial<Record<ToolKind, readonly [string, string]>> = {
  read: ['正在读取', '读取'],
  edit: ['正在修改', '修改'],
  delete: ['正在删除', '删除'],
  move: ['正在移动', '移动'],
  search: ['正在搜索', '搜索'],
  execute: ['正在运行', '运行'],
  fetch: ['正在获取', '获取'],
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
 * What a process row says: a verb by the tool's kind (in the present while it runs) and its object, a path or command
 * in mono and a query or address in text; or, when the tool names no object Latch can read, its own title alone.
 */
export interface ToolLabel {
  verb?: string
  object: string
  mono: boolean
}

export function toolLabel(message: Pick<Message, 'tool' | 'toolName' | 'state'>): ToolLabel {
  const kind = toolKind(message)
  const tool = message.tool
  const title = tool?.title || message.toolName || '工具调用'
  const verbs = VERBS[kind]
  const running = message.state === 'running'
  let object: string | undefined
  let mono = true
  if (kind === 'execute') object = argument(tool?.input, ['command', 'cmd'])
  else if (kind === 'read' || kind === 'edit' || kind === 'delete' || kind === 'move')
    object = tool?.locations?.[0] ?? argument(tool?.input, ['path', 'file', 'file_path', 'filePath'])
  else if (kind === 'search') {
    object = argument(tool?.input, ['query', 'pattern', 'q'])
    mono = false
  } else if (kind === 'fetch') object = argument(tool?.input, ['url'])
  if (object === undefined || verbs === undefined) return { object: title, mono: false }
  return { verb: verbs[running ? 0 : 1], object, mono }
}

/** How long a tool ran: from its start (after any approval) to its end, or to now while it runs. */
export function toolDuration(message: Message, now: number): { ms: number; live: boolean } | undefined {
  if (message.state === 'awaiting-approval' || message.state === 'queued') return undefined
  const start = parseTime(message.startedAt) ?? parseTime(message.createdAt)
  if (start === undefined) return undefined
  const end = parseTime(message.completedAt)
  if (end !== undefined) return { ms: Math.max(0, end - start), live: false }
  if (message.state === 'running') return { ms: Math.max(0, now - start), live: true }
  return undefined
}

/** Whether a tool's changes are evidence that stays in view: its diffs. */
export const hasDiffs = (message: Message) => (message.tool?.diffs?.length ?? 0) > 0

// ---- The fold after a turn ---------------------------------------------------------------------------------------

/**
 * Which rows of a settled, completed turn fold into 「已处理 · …」: the process before the answer, from the first reply
 * block up to the first thing that must stay in view (a tool's diffs, a failed or waiting tool, a note) or the answer.
 * The prose block that introduces what follows stays out. Nothing folds while a turn streams, when it failed or was
 * stopped, or when no tool would fold.
 */
export function foldedRows(turn: Turn, outcome: TurnOutcome | undefined): Message[] {
  if (outcome !== 'completed') return []
  const last = turn.replies.at(-1)
  if (!last || last.role !== 'assistant' || !last.text.trim()) return []
  let end = turn.replies.length - 1
  for (let index = 0; index < turn.replies.length - 1; index++) {
    const message = turn.replies[index]
    const keep = message.role === 'system' || (message.role === 'tool' && (hasDiffs(message) || message.state !== 'completed'))
    if (keep) {
      end = index
      break
    }
  }
  let rows = turn.replies.slice(0, end)
  // The prose right before what stays out introduces it.
  while (rows.length > 0 && rows.at(-1)!.role === 'assistant' && rows.at(-1)!.text.trim()) rows = rows.slice(0, -1)
  return rows.some(message => message.role === 'tool') ? rows : []
}

const FOLD_WORDS: Record<ToolKind, (count: number) => string> = {
  read: count => `读取 ${count} 个文件`,
  edit: count => `修改 ${count} 个文件`,
  delete: count => `删除 ${count} 个文件`,
  move: count => `移动 ${count} 个文件`,
  execute: count => `运行 ${count} 条命令`,
  search: count => `搜索 ${count} 次`,
  fetch: count => `获取 ${count} 个网页`,
  think: count => `思考 ${count} 次`,
  other: count => `调用 ${count} 次工具`,
}

/** 「已处理 · 思考 6 秒 · 读取 4 个文件 · 运行 2 条命令 · 用时 2.4 秒」: counts and times only from the folded rows. */
export function foldSummary(rows: Message[]): string {
  const parts = ['已处理']
  const thinking = rows.reduce((sum, message) => sum + (parseDuration(message.reasoningMs) ?? 0), 0)
  const thought = formatDuration(thinking)
  if (thought) parts.push(`思考 ${thought}`)
  const counts = new Map<ToolKind, number>()
  for (const message of rows) if (message.role === 'tool') counts.set(toolKind(message), (counts.get(toolKind(message)) ?? 0) + 1)
  const kinds = [...counts]
  for (const [kind, count] of kinds.slice(0, 3)) parts.push(FOLD_WORDS[kind](count))
  if (kinds.length > 3) parts.push(`等 ${kinds.slice(3).reduce((sum, [, count]) => sum + count, 0)} 项`)
  const toolTime = rows.reduce((sum, message) => sum + (message.role === 'tool' ? (toolDuration(message, 0)?.ms ?? 0) : 0), 0)
  const spent = formatDuration(toolTime)
  if (spent) parts.push(`用时 ${spent}`)
  return parts.join(' · ')
}

// ---- Time separators ---------------------------------------------------------------------------------------------

/**
 * The prompts that open a time separator: the first message of the transcript, and a prompt on another day than the
 * message before it or more than an hour after it. Only prompts open one, so a separator never splits a turn; a
 * message without a time opens none and leaves the gaps around it alone.
 */
export function separators(messages: Message[]): Map<string, { at: number; sameDay: boolean }> {
  const found = new Map<string, { at: number; sameDay: boolean }>()
  let previous: number | undefined
  let previousSeparator: number | undefined
  messages.forEach((message, index) => {
    const at = parseTime(message.createdAt)
    if (
      message.role === 'user'
      && at !== undefined
      && (index === 0 || (previous !== undefined && (newDay(previous, at) || at - previous > 3_600_000)))
    ) {
      found.set(message.id, { at, sameDay: previousSeparator !== undefined && !newDay(previousSeparator, at) })
      previousSeparator = at
    }
    previous = parseTime(message.completedAt) ?? at
  })
  return found
}

const newDay = (a: number, b: number) => {
  const first = new Date(a)
  const second = new Date(b)
  return first.getFullYear() !== second.getFullYear() || first.getMonth() !== second.getMonth() || first.getDate() !== second.getDate()
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
export function resendWarning(effects: SideEffects, fullAccess: boolean): string | undefined {
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
  parts.push('重新发送后，Agent 可能再次执行它们。')
  if (fullAccess) parts.push('完全访问会话不会逐项询问。')
  return parts.join('')
}

// ---- The live run -----------------------------------------------------------------------------------------------

/** The run's working time so far on the Host's clock, without approval waits; frozen while one is open. */
export function runElapsed(detail: TaskDetail, hostNow: number): number | undefined {
  const started = parseTime(detail.runStartedAt)
  if (started === undefined) return undefined
  const waited = parseDuration(detail.runWaitMs) ?? 0
  const waiting = parseTime(detail.runWaitingSince)
  const open = waiting === undefined ? 0 : Math.max(0, hostNow - waiting)
  return Math.max(0, hostNow - started - waited - open)
}

export type LivePhase =
  | { kind: 'cancelling' }
  | { kind: 'approval' }
  | { kind: 'tool'; text: string }
  | { kind: 'reply' }
  | { kind: 'thinking' }
  | { kind: 'starting'; slow: boolean }
  | { kind: 'model' }

/**
 * What the run is doing, in this order: stopping, waiting for you, running a tool (a running row of the latest turn
 * says so before the driver's own phase does), writing the reply, reasoning, starting an agent, or waiting for the
 * model.
 */
export function livePhase(detail: TaskDetail, opts: { cancelling: boolean; approvals: number; hostNow: number }): LivePhase {
  const activity = detail.activity
  if (opts.cancelling || activity?.phase === 'cancelling') return { kind: 'cancelling' }
  if (opts.approvals > 0 || detail.summary.status === 'waiting-approval' || activity?.phase === 'approval') return { kind: 'approval' }
  const running = detail.messages.findLast(message => message.role === 'tool' && message.state === 'running')
  const trailing = turnsOf(detail.messages).at(-1)
  if (running && trailing?.replies.includes(running)) return { kind: 'tool', text: toolText(running) }
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
 * A running tool's words on one line, for the phase of the live footer and the jump pill: its row's present tense
 * (「正在运行 pnpm test」, 「正在读取 src/a.ts」), or 「正在执行」 with its title when it has no kind Latch reads.
 */
function toolText(message: Message): string {
  const label = toolLabel({ ...message, state: 'running' })
  return label.verb ? `${label.verb} ${label.object}` : `正在执行 ${label.object}`
}

const PHASE_WORDS: Record<Exclude<LivePhase['kind'], 'tool' | 'starting'>, string> = {
  cancelling: '正在停止…',
  approval: '等你批准',
  reply: '正在回复',
  thinking: '正在思考',
  model: '等待模型…',
}

/** A phase in words. */
export function phaseText(phase: LivePhase, harness: string): string {
  if (phase.kind === 'tool') return phase.text
  if (phase.kind === 'starting') return phase.slow ? `${harness} 启动较慢，仍在等待进程就绪…` : `正在启动 ${harness}…`
  return PHASE_WORDS[phase.kind]
}

/** The facts of the live line after the phase: output so far, or the context an agent reported, and a stall. */
export function liveFacts(
  detail: TaskDetail,
  turn: Turn | undefined,
  hostNow: number,
): { tokens?: string; tokensTitle?: string; stalled?: string } {
  const usage = turn ? turnUsage(turn) : undefined
  const report = detail.usageReport
  const facts: { tokens?: string; tokensTitle?: string; stalled?: string } = {}
  if (usage) {
    facts.tokens = `输出 ${tokenAmount(usage.outputTokens)}`
    facts.tokensTitle = `已完成的步骤：输入 ${exactTokens(usage.inputTokens)} tokens · 输出 ${exactTokens(usage.outputTokens)} tokens（输入是累计计费输入，每一步都重新发送上下文）`
  } else if (typeof report?.contextUsed === 'number') {
    facts.tokens = `上下文 ${tokenAmount(report.contextUsed)}`
    facts.tokensTitle = `由 Agent 报告：${exactTokens(report.contextUsed)} tokens`
  }
  const last = parseTime(detail.lastOutputAt)
  const quiet = last === undefined ? 0 : hostNow - last
  if (quiet > 120_000 && detail.activity?.phase !== 'approval' && detail.summary.status !== 'waiting-approval')
    facts.stalled = `${Math.floor(quiet / 60_000)} 分钟没有新输出`
  return facts
}
