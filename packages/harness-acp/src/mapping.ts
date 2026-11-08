/** Pure conversions from ACP payloads to Latch's browser-safe types. */
import type {
  FileDiff,
  Message,
  PlanEntry,
  SessionConfigOption,
  ToolBlock,
  ToolDecision,
  ToolDetail,
  ToolJudgement,
  ToolKind,
} from '@latch/protocol'
import { configOption, toolContent, toolLocation, type ContentBlock, type SessionState, type ToolFields } from './protocol.ts'

export const TEXT_LIMIT = 2_000_000
export const TOOL_TEXT_LIMIT = 64 * 1024
/** A harness's reason for refusing a call is one line of its own words, not output. */
const BLOCK_REASON_LIMIT = 1000
/** Per side, so one diff stays within 256 KiB. */
const DIFF_SIDE_LIMIT = 128 * 1024
const TRUNCATED = '\n…（内容过长，已截断）'

export const OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN: 结果未知，请先核对它做了什么。Latch 不会自动重做。'
export const NOT_STARTED = 'TOOL_NOT_STARTED: 本轮已结束，工具没有开始执行。'

export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}${TRUNCATED}`
}

/** Appends streamed text; once the limit is reached the marker is added once and further text is dropped. */
export function append(current: string, piece: string, limit = TEXT_LIMIT): string {
  if (current.length >= limit) return current
  const next = current + piece
  return next.length > limit ? `${next.slice(0, limit)}${TRUNCATED}` : next
}

export function pretty(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text ?? ''
    case 'image':
      return '[图片]'
    case 'audio':
      return '[音频]'
    case 'resource_link':
      return `[${block.name || block.uri || '资源'}](${block.uri ?? ''})`
    case 'resource':
      return block.resource?.text !== undefined ? clip(block.resource.text, TOOL_TEXT_LIMIT) : `[${block.resource?.uri ?? '资源'}]`
    default:
      return ''
  }
}

export interface ToolState {
  /** Latch message ID, `tool:<turn>:<toolCallId>`. */
  id: string
  title?: string
  name?: string
  kind?: string
  status?: string
  rawInput?: unknown
  rawOutput?: unknown
  content: unknown[]
  locations: unknown[]
  /** Open permission requests for this call. */
  awaiting: number
  /** Latch's verdict for a call the agent left unfinished when its turn ended. */
  final?: { state: 'cancelled' | 'failed'; note: string }
  /** How the latest permission request for this call ended. */
  decision?: ToolDecision
  /** Decided without asking the person; `recorded` once its audit row was written. */
  judged?: ToolJudgement & { recorded?: true }
  /** The harness refused the call itself before it ran; kept once reported, since later reports leave it out. */
  blocked?: ToolBlock
  /** When Latch first saw the call, when the agent reported it in progress, and when it settled (ISO). */
  createdAt?: string
  startedAt?: string
  completedAt?: string
}

/** Merges an update into the call; `at` stamps when it was first seen, began to run and settled. */
export function mergeTool(state: ToolState, fields: ToolFields, at: string): void {
  state.createdAt ??= at
  if (fields.title != null) state.title = fields.title
  if (fields.name != null) state.name = fields.name
  if (fields.kind != null) state.kind = fields.kind
  if (fields.status != null) {
    state.status = fields.status
    if (fields.status === 'in_progress') state.startedAt ??= at
    // A report the agent sends after the turn ended still describes what happened.
    if (fields.status === 'completed' || fields.status === 'failed') {
      delete state.final
      state.completedAt ??= at
    }
  }
  if (fields.rawInput !== undefined) state.rawInput = fields.rawInput
  if (fields.rawOutput !== undefined) state.rawOutput = fields.rawOutput
  if (fields.content != null) state.content = fields.content.slice(0, 256)
  if (fields.locations != null) state.locations = fields.locations.slice(0, 256)
}

/**
 * Marks a call the turn left unfinished. Returns whether anything changed. A call that was running ends with the turn
 * at `at`; one that never started has no end time, so it shows no duration.
 */
export function settleTool(state: ToolState, at: string): boolean {
  if (state.final || state.status === 'completed' || state.status === 'failed') return false
  state.awaiting = 0
  state.final = state.status === 'in_progress' ? { state: 'failed', note: OUTCOME_UNKNOWN } : { state: 'cancelled', note: NOT_STARTED }
  if (state.status === 'in_progress') state.completedAt ??= at
  return true
}

/**
 * Marks a call asked about after its turn ended once the request is answered, as `settleTool` marks the calls a turn
 * left: allowed, it may run with no turn to report how it went, so its result is unknown; otherwise it never starts. A
 * report the agent sends later still wins.
 */
export function settleAskedTool(state: ToolState, allowed: boolean): boolean {
  if (state.final || state.status === 'completed' || state.status === 'failed') return false
  state.final = allowed ? { state: 'failed', note: OUTCOME_UNKNOWN } : { state: 'cancelled', note: NOT_STARTED }
  return true
}

const TOOL_KINDS = new Set<string>(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other'])
export function toolKind(kind: string | undefined): ToolKind | undefined {
  if (!kind) return undefined
  return TOOL_KINDS.has(kind) ? (kind as ToolKind) : 'other'
}

/** The tool's own name; else its kind, unless that says only `other`, where the agent's title names it better. */
export function toolLabel(state: ToolState): string {
  const kind = state.kind === 'other' ? undefined : state.kind
  return clip(state.name || kind || state.title || state.kind || 'tool', 200)
}

/** What a call runs, on one line: the command it was given when it says, otherwise what it calls itself. */
export function commandName(state: ToolState): string {
  const input =
    typeof state.rawInput === 'object' && state.rawInput !== null ? (state.rawInput as { command?: unknown }).command : undefined
  const given = Array.isArray(input) && input.every(part => typeof part === 'string') ? input.join(' ') : input
  const text = typeof given === 'string' && given.trim() ? given : state.title || toolLabel(state)
  return text.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim()
}

export function toolDetail(state: ToolState): ToolDetail {
  const texts: string[] = []
  const diffs: FileDiff[] = []
  for (const item of state.content) {
    const parsed = toolContent.safeParse(item)
    if (!parsed.success) continue
    const content = parsed.data
    if (content.type === 'content' && content.content) {
      const text = blockText(content.content)
      if (text) texts.push(text)
    } else if (content.type === 'diff' && content.path && content.newText !== undefined && diffs.length < 32) {
      // ACP marks a new file with an explicit null; an agent that leaves oldText out says nothing about the file.
      diffs.push({
        path: content.path,
        ...(typeof content.oldText === 'string' ? { oldText: clip(content.oldText, DIFF_SIDE_LIMIT), previous: 'text' as const } : {}),
        ...(content.oldText === null ? { previous: 'none' as const } : {}),
        newText: clip(content.newText, DIFF_SIDE_LIMIT),
      })
    }
  }
  let output = texts.length ? texts.join('\n') : state.rawOutput !== undefined ? pretty(state.rawOutput) : undefined
  if (state.final) output = output ? `${output}\n\n${state.final.note}` : state.final.note
  const locations = state.locations
    .flatMap(item => {
      const parsed = toolLocation.safeParse(item)
      if (!parsed.success) return []
      return [parsed.data.line != null ? `${parsed.data.path}:${parsed.data.line}` : parsed.data.path]
    })
    .slice(0, 64)
  const kind = toolKind(state.kind)
  return {
    ...(kind ? { kind } : {}),
    ...(state.title ? { title: clip(state.title, 1000) } : {}),
    ...(state.rawInput !== undefined ? { input: clip(pretty(state.rawInput), TOOL_TEXT_LIMIT) } : {}),
    ...(output !== undefined ? { output: clip(output, TOOL_TEXT_LIMIT) } : {}),
    ...(locations.length ? { locations } : {}),
    ...(diffs.length ? { diffs } : {}),
    ...(state.decision ? { decision: state.decision } : {}),
    ...(state.judged ? { judged: { by: state.judged.by, outcome: state.judged.outcome } } : {}),
    ...(state.blocked
      ? {
          blocked: {
            by: state.blocked.by,
            source: state.blocked.source,
            ...(state.blocked.reason ? { reason: clip(state.blocked.reason, BLOCK_REASON_LIMIT) } : {}),
          },
        }
      : {}),
  }
}

function toolMessageState(state: ToolState): Message['state'] {
  if (state.awaiting > 0) return 'awaiting-approval'
  if (state.final) return state.final.state
  switch (state.status) {
    case 'in_progress':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    default:
      return 'queued'
  }
}

export function toolMessage(state: ToolState): Message {
  const tool = toolDetail(state)
  return {
    id: state.id,
    role: 'tool',
    toolName: toolLabel(state),
    state: toolMessageState(state),
    text: tool.output ?? tool.input ?? tool.title ?? '',
    tool,
    ...(state.createdAt ? { createdAt: state.createdAt } : {}),
    ...(state.startedAt ? { startedAt: state.startedAt } : {}),
    ...(state.completedAt ? { completedAt: state.completedAt } : {}),
  }
}

/** Restart recovery for persisted tool rows whose turn can no longer report a result; a waiting ask was answered by nobody. */
export function settleToolMessage(message: Message, at: string): boolean {
  if (message.role !== 'tool') return false
  let note: string
  const asked = message.state === 'awaiting-approval'
  if (message.state === 'running') {
    message.state = 'failed'
    note = OUTCOME_UNKNOWN
  } else if (message.state === 'queued' || asked) {
    message.state = 'cancelled'
    note = NOT_STARTED
  } else return false
  const output = message.tool?.output ? `${message.tool.output}\n\n${note}` : note
  message.tool = { ...message.tool, output, ...(asked ? { decision: { outcome: 'cancelled' as const, at } } : {}) }
  message.text = output
  return true
}

const PLAN_STATUS = new Set(['pending', 'in_progress', 'completed'])
const PLAN_PRIORITY = new Set(['high', 'medium', 'low'])
export function planEntries(entries: Array<{ content: string; status?: string | null; priority?: string | null }>): PlanEntry[] {
  return entries.slice(0, 200).map(entry => ({
    content: clip(entry.content, 4000),
    status: PLAN_STATUS.has(entry.status ?? '') ? (entry.status as PlanEntry['status']) : 'pending',
    ...(PLAN_PRIORITY.has(entry.priority ?? '') ? { priority: entry.priority as NonNullable<PlanEntry['priority']> } : {}),
  }))
}

export type ConfigSource = 'options' | 'legacy'
export interface FoldedConfig {
  source: ConfigSource
  options: SessionConfigOption[]
}

function selectConfig(item: unknown): SessionConfigOption[] {
  const parsed = configOption.safeParse(item)
  if (!parsed.success) return []
  const option = parsed.data
  // Boolean options are only sent to clients that advertise them; Latch does not.
  if (option.type !== 'select' || typeof option.currentValue !== 'string' || !option.options) return []
  const values = option.options.flatMap(entry => ('group' in entry ? entry.options : [entry])).slice(0, 500)
  return [
    {
      id: option.id,
      name: clip(option.name, 200),
      currentValue: option.currentValue,
      ...(option.category ? { category: option.category } : {}),
      ...(option.description ? { description: clip(option.description, 1000) } : {}),
      options: values.map(value => ({
        value: value.value,
        name: clip(value.name, 200),
        ...(value.description ? { description: clip(value.description, 1000) } : {}),
      })),
    },
  ]
}

export function configFromOptions(items: unknown[]): SessionConfigOption[] {
  return items.slice(0, 32).flatMap(selectConfig)
}

/** Agents that send `configOptions` use them exclusively; older agents report `models` and `modes`. */
export function foldConfig(state: SessionState): FoldedConfig | undefined {
  if (state.configOptions?.length) return { source: 'options', options: configFromOptions(state.configOptions) }
  const options: SessionConfigOption[] = []
  if (state.models) {
    options.push({
      id: 'model',
      name: '模型',
      category: 'model',
      currentValue: state.models.currentModelId,
      options: state.models.availableModels.slice(0, 500).map(model => ({
        value: model.modelId,
        name: clip(model.name, 200),
        ...(model.description ? { description: clip(model.description, 1000) } : {}),
      })),
    })
  }
  if (state.modes) {
    options.push({
      id: 'mode',
      name: '模式',
      category: 'mode',
      currentValue: state.modes.currentModeId,
      options: state.modes.availableModes.slice(0, 100).map(mode => ({
        value: mode.id,
        name: clip(mode.name, 200),
        ...(mode.description ? { description: clip(mode.description, 1000) } : {}),
      })),
    })
  }
  return options.length ? { source: 'legacy', options } : undefined
}

/** Display name of the current value of the `model` category. */
export function modelName(config: SessionConfigOption[] | undefined): string | undefined {
  const option = config?.find(item => item.category === 'model')
  if (!option) return undefined
  return option.options.find(value => value.value === option.currentValue)?.name ?? option.currentValue
}

/** The thinking level the session runs at, as the agent names it. */
export function thinkingName(config: SessionConfigOption[] | undefined): string | undefined {
  const option = config?.find(item => item.category === 'thought_level')
  if (!option) return undefined
  return option.options.find(value => value.value === option.currentValue)?.name ?? option.currentValue
}
