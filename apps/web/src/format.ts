import type { TaskStatus, TokenUsage } from '@latch/protocol'

export const statusLabels: Record<TaskStatus, string> = {
  idle: '已完成',
  running: '运行中',
  'waiting-approval': '待批准',
  cancelled: '已取消',
  failed: '失败',
  interrupted: '已中断',
}

export const isActive = (status: TaskStatus | undefined) => status === 'running' || status === 'waiting-approval'

function parse(value: string): number | null {
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : time
}

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
const pad = (value: number) => value.toString().padStart(2, '0')

/** Compact sidebar time: "刚刚", "5 分钟", "3 小时", "昨天", "4 天", "10/23", "2025/10/23". */
export function relativeTime(value: string, now = new Date()): string {
  const time = parse(value)
  if (time === null) return ''
  const elapsed = now.getTime() - time
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟`
  const days = Math.round((startOfDay(now) - startOfDay(new Date(time))) / 86_400_000)
  if (days <= 0) return `${Math.floor(elapsed / 3_600_000)} 小时`
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天`
  const date = new Date(time)
  const day = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
  return date.getFullYear() === now.getFullYear() ? day : `${date.getFullYear()}/${day}`
}

export function dateTime(value: string): string {
  const time = parse(value)
  if (time === null) return ''
  return new Date(time).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** Token counts: 850, 9.1k, 12.4k, 124k, 1.2M. Tooltips give the exact number (`exactTokens`). */
export function formatTokens(value: number): string {
  if (value < 1000) return `${value}`
  if (value < 999_500) return `${(value / 1000).toFixed(value < 99_950 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export const exactTokens = (value: number): string => value.toLocaleString('en-US')

/** A token count with its unit, abbreviated: 「850 tokens」, 「12.4k tokens」. Every count on screen carries the unit. */
export const tokenAmount = (value: number): string => `${formatTokens(value)} tokens`

/** 「输入 12.4k tokens」 and 「输出 3.1k tokens」: tokens in words, never arrows, each with its unit. */
export function tokenParts(usage: TokenUsage): [string, string] {
  return [`输入 ${tokenAmount(usage.inputTokens)}`, `输出 ${tokenAmount(usage.outputTokens)}`]
}

/** 「输入 12.4k tokens · 输出 3.1k tokens」. */
export const tokenText = (usage: TokenUsage): string => tokenParts(usage).join(' · ')

/**
 * The exact counts, with the cache and reasoning parts when the Host reported them for every step counted:
 * 「输入 12,400 tokens（缓存读取 8,000 · 缓存写入 1,200）」 and 「输出 3,100 tokens（推理 1,000）」.
 */
export function tokenLines(usage: TokenUsage): [string, string] {
  const parts = (items: Array<[string, number | undefined]>) => {
    const known = items.filter((item): item is [string, number] => typeof item[1] === 'number')
    return known.length ? `（${known.map(([name, value]) => `${name} ${exactTokens(value)}`).join(' · ')}）` : ''
  }
  return [
    `输入 ${exactTokens(usage.inputTokens)} tokens${parts([
      ['缓存读取', usage.cacheReadTokens],
      ['缓存写入', usage.cacheWriteTokens],
    ])}`,
    `输出 ${exactTokens(usage.outputTokens)} tokens${parts([['推理', usage.reasoningTokens]])}`,
  ]
}

/** Sums usage the way the Host does: a part survives only when every summed item reported it. */
export function sumUsage(items: TokenUsage[]): TokenUsage | undefined {
  if (items.length === 0) return undefined
  const sum: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  for (const item of items) {
    sum.inputTokens += item.inputTokens
    sum.outputTokens += item.outputTokens
  }
  for (const part of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    if (items.every(item => typeof item[part] === 'number')) sum[part] = items.reduce((total, item) => total + (item[part] ?? 0), 0)
  }
  return sum
}

/**
 * A duration: under a second it is not worth saying (undefined); then 「2.4 秒」 (one decimal while settled under ten
 * seconds, whole seconds while it still counts), 「12 秒」, 「1 分 5 秒」, 「1 小时 2 分」.
 */
export function formatDuration(ms: number, live = false): string | undefined {
  if (!Number.isFinite(ms) || ms < 1000) return undefined
  if (ms < 10_000) return live ? `${Math.floor(ms / 1000)} 秒` : `${(Math.floor(ms / 100) / 10).toFixed(1).replace(/\.0$/, '')} 秒`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`
/** Calendar days from `then` to `now`, by the local calendar. */
const daysBetween = (then: Date, now: Date) => Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000)

/** When a message was sent: 「14:32」 today, 「昨天 14:32」, 「10月3日 14:32」 this year, 「2025年10月3日 14:32」 earlier. */
export function messageTime(at: number, now: number): string {
  const date = new Date(at)
  const today = new Date(now)
  const days = daysBetween(date, today)
  if (days <= 0) return clock(date)
  if (days === 1) return `昨天 ${clock(date)}`
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${clock(date)}`
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock(date)}`
}

/** A day and a time with seconds, the year only when it is not this one: 「10月25日 14:31:05」, 「2025年10月3日 09:00:12」. */
export function dayClockTime(at: number, now: number): string {
  const date = new Date(at)
  const day = `${date.getMonth() + 1}月${date.getDate()}日`
  return `${date.getFullYear() === new Date(now).getFullYear() ? day : `${date.getFullYear()}年${day}`} ${clock(date)}:${pad(date.getSeconds())}`
}

/** Whether two times fall on the same local day. */
export function sameDay(a: number, b: number): boolean {
  return daysBetween(new Date(a), new Date(b)) === 0
}

/** The full time for a tooltip or `<time title>`: 「2026年10月24日 周五 14:32:07」. */
export function absoluteTime(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]} ${clock(date)}:${pad(date.getSeconds())}`
}

/** A time of day with seconds, for start and end lines: 「14:32:07」. */
export const clockTime = (at: number): string => {
  const date = new Date(at)
  return `${clock(date)}:${pad(date.getSeconds())}`
}

/**
 * A separator between messages: 「今天 14:02」, 「昨天 09:15」, 「周三 09:15」 within a week, 「10月22日 09:15」 this year,
 * 「2025年3月2日 10:00」 earlier; a later separator on the same day as the one before it says only 「16:40」.
 */
export function separatorLabel(at: number, now: number, sameDayAsPrevious: boolean): string {
  const date = new Date(at)
  const today = new Date(now)
  const days = daysBetween(date, today)
  if (sameDayAsPrevious) return clock(date)
  if (days <= 0) return `今天 ${clock(date)}`
  if (days === 1) return `昨天 ${clock(date)}`
  if (days < 7) return `${WEEKDAYS[date.getDay()]} ${clock(date)}`
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${clock(date)}`
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock(date)}`
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Keeps both ends of a path visible: "/Users/me/…/project/src". */
export function middleEllipsis(text: string, max = 48): string {
  if (text.length <= max) return text
  const keep = max - 1
  const head = Math.ceil(keep * 0.4)
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
}

/**
 * The longest form of a path that fits `width` (in the units `measure` returns): the whole path, or its start, one
 * ellipsis and its last segment whole (「/private/var/fol…/latch-app」). Undefined when not even the ellipsis and the
 * last segment fit, so the caller cuts the end instead.
 */
export function middleFit(text: string, width: number, measure: (value: string) => number): string | undefined {
  if (measure(text) <= width) return text
  const trimmed = text.length > 1 ? text.replace(/[\\/]+$/, '') : text
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const tail = at > 0 ? trimmed.slice(at) : trimmed
  if (measure(`…${tail}`) > width) return undefined
  let low = 0
  let high = Math.max(0, trimmed.length - tail.length)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (measure(`${trimmed.slice(0, middle)}…${tail}`) <= width) low = middle
    else high = middle - 1
  }
  return `${trimmed.slice(0, low)}…${tail}`
}

export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1) || trimmed || path
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export type ArgumentView = { kind: 'empty' } | { kind: 'entries'; entries: Array<[string, string]> } | { kind: 'text'; text: string }

/** Tool arguments as a key–value list; `{}` and blanks become "无参数" instead of an empty box. */
export function argumentView(text: string | undefined): ArgumentView {
  const trimmed = text?.trim() ?? ''
  if (!trimmed || trimmed === '{}' || trimmed === 'null') return { kind: 'empty' }
  try {
    const value: unknown = JSON.parse(trimmed)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const entries = Object.entries(value).map(([key, item]): [string, string] => [
        key,
        typeof item === 'string' ? item : JSON.stringify(item, null, 2),
      ])
      return entries.length === 0 ? { kind: 'empty' } : { kind: 'entries', entries }
    }
  } catch {
    /* Plain-text arguments are shown as written. */
  }
  return { kind: 'text', text: trimmed }
}

/** Short device glyph choice from the name the user gave it. */
export function looksLikePhone(name: string): boolean {
  return /手机|phone|android|ipad|pad|平板/i.test(name)
}
