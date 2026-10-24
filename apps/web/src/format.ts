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

export function formatTokens(value: number): string {
  if (value < 1000) return `${value}`
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export function usageText(usage: TokenUsage): string {
  return `↑${formatTokens(usage.inputTokens)} ↓${formatTokens(usage.outputTokens)}`
}

export function usageTitle(usage: TokenUsage): string {
  return `输入 ${usage.inputTokens.toLocaleString('zh-CN')} tokens · 输出 ${usage.outputTokens.toLocaleString('zh-CN')} tokens`
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
