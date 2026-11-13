/** Fixed, non-identity capability header. Every consumer must opt in; a complete frame acknowledges its baseline. */
export const TASK_DELTA_HEADER = 'x-latch-state'
export const TASK_DELTA_PROTOCOL = 'delta-v1'
export const MAX_TASK_DELTA_BYTES = 65_536
export const MAX_TASK_TEXT_BYTES = 16_777_216

/** This sequence belongs only to one network subscription, independently of Host revisions and native replay. */
export interface TaskStreamStamp {
  protocol: typeof TASK_DELTA_PROTOCOL
  subscriptionId: string
  stateSeq: number
}

/** UTF-8 byte offset in the previous scalar string, followed by a scalar-only suffix. */
export interface TaskTextAppend {
  offset: number
  append: string
}

/** Only these clocks may change inside an otherwise identical live projection. Null preserves field absence. */
export interface TaskLiveTimes {
  lastEventAt: string
  lastOutputAt: string | null
}

/** A finite append operation; tools, history, permissions and terminal states are never represented by this event. */
export interface TaskDeltaEvent {
  type: 'task-delta'
  instanceId: string
  sessionId: string
  revision: number
  hostTime: string
  stream: TaskStreamStamp
  baseSeq: number
  runId: string
  liveMessageId: string
  text: TaskTextAppend
  /** Null means reasoning is absent in both baseline and result; an empty string is still present. */
  reasoning: TaskTextAppend | null
  cursor: number
  updatedAt: string
  lastOutputAt: string | null
  /** Null means the baseline and result both have no summary.live object. */
  live: TaskLiveTimes | null
}

/** Unlike TextEncoder, this rejects an unpaired surrogate instead of replacing it with U+FFFD. No platform globals. */
export function scalarUtf8Length(text: string): number | undefined {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes++
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return undefined
      bytes += 4
    } else if (code >= 0xdc00 && code <= 0xdfff) return undefined
    else bytes += 3
  }
  return bytes
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
const time = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
const optionalTime = (value: unknown) => value === null || time(value)

export function taskStreamStamp(value: unknown): TaskStreamStamp | undefined {
  if (
    !record(value)
    || !keys(value, ['protocol', 'subscriptionId', 'stateSeq'])
    || value.protocol !== TASK_DELTA_PROTOCOL
    || typeof value.subscriptionId !== 'string'
    || !/^[A-Za-z0-9_-]{8,128}$/u.test(value.subscriptionId)
    || !integer(value.stateSeq)
    || value.stateSeq === 0
  )
    return
  return value as unknown as TaskStreamStamp
}

function appendBytes(value: unknown): number | undefined {
  if (
    !record(value)
    || !keys(value, ['offset', 'append'])
    || !integer(value.offset, MAX_TASK_TEXT_BYTES)
    || typeof value.append !== 'string'
    || value.append.length > MAX_TASK_DELTA_BYTES
  )
    return
  const bytes = scalarUtf8Length(value.append)
  return bytes !== undefined && bytes <= MAX_TASK_DELTA_BYTES && value.offset + bytes <= MAX_TASK_TEXT_BYTES ? bytes : undefined
}

/** Reject unknown delta fields instead of silently pretending a newer operation was understood. */
export function taskDelta(value: unknown): TaskDeltaEvent | undefined {
  if (
    !record(value)
    || !keys(value, [
      'type',
      'instanceId',
      'sessionId',
      'revision',
      'hostTime',
      'stream',
      'baseSeq',
      'runId',
      'liveMessageId',
      'text',
      'reasoning',
      'cursor',
      'updatedAt',
      'lastOutputAt',
      'live',
    ])
    || value.type !== 'task-delta'
    || !id(value.instanceId)
    || !id(value.sessionId)
    || !id(value.runId)
    || !id(value.liveMessageId)
    || !integer(value.revision)
    || !integer(value.cursor)
    || !integer(value.baseSeq)
    || value.baseSeq === 0
    || !time(value.hostTime)
    || !time(value.updatedAt)
    || !optionalTime(value.lastOutputAt)
  )
    return
  const stream = taskStreamStamp(value.stream)
  if (!stream || stream.stateSeq !== value.baseSeq + 1) return
  const text = appendBytes(value.text)
  const reasoning = value.reasoning === null ? 0 : appendBytes(value.reasoning)
  if (text === undefined || reasoning === undefined || text + reasoning > MAX_TASK_DELTA_BYTES) return
  if (
    value.live !== null
    && (!record(value.live)
      || !keys(value.live, ['lastEventAt', 'lastOutputAt'])
      || !time(value.live.lastEventAt)
      || !optionalTime(value.live.lastOutputAt))
  )
    return
  return value as unknown as TaskDeltaEvent
}
