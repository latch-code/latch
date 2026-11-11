import type { HarnessInfo, TaskDetail, TaskSummary, TokenUsage, UsageReport } from '@latch/protocol'
import { turnsOf } from '../conversation.ts'
import { parseDuration } from '../core/hostClock.ts'
import { currencyAmount, formatDuration, tokenLines } from '../format.ts'

/** How full the context window is, only from what the Harness reported; never estimated. */
export interface ContextTotals {
  used: number
  /** Absent when the Harness reported no window size: then there is no share and no meter. */
  size?: number
  percent?: number
}

/**
 * What a whole session used, as the composer's status line and the title row's popover (and the right panel) both say
 * it: each field only when it was reported, and each with who reported it.
 */
export interface SessionTotals {
  /** The Harness's name, or 「Harness」 when it is not known: who reported the context and the cost. */
  by: string
  context?: ContextTotals
  /** Summed over the session; `reporter` when the Harness owns the model and so counted them itself. */
  tokens?: { usage: TokenUsage; lines: [string, string]; reporter?: string }
  /** What the Harness said it cost, never a bill: `reporter` always names who said so. */
  cost?: { text: string; reporter: string }
  /** The settled turns' working time and their count; a turn still running is not counted. */
  time?: { ms: number; turns: number; text: string }
}

/** The context report as a share of the window, when the Harness reported what it used. */
export function contextTotals(report: Pick<UsageReport, 'contextUsed' | 'contextSize'> | undefined): ContextTotals | undefined {
  const used = report?.contextUsed
  if (used === undefined || !Number.isFinite(used) || used < 0) return undefined
  const size = report?.contextSize
  if (size === undefined || !Number.isFinite(size) || size <= 0) return { used }
  return { used, size, percent: Math.min(100, Math.round((used / size) * 100)) }
}

/** 「由 Codex 报告，不是账单」: a cost is never shown without it. */
export const costClause = (reporter: string) => `由 ${reporter} 报告，不是账单`

/** The session's totals from its summary and, when it is the open one, its detail. */
export function sessionTotals(input: {
  summary: Pick<TaskSummary, 'id' | 'usage'>
  detail: Pick<TaskDetail, 'summary' | 'messages' | 'usageReport'> | null | undefined
  harness: Pick<HarnessInfo, 'capabilities'> | undefined
}): SessionTotals {
  const { summary, harness } = input
  const own = input.detail?.summary.id === summary.id ? input.detail : undefined
  const name = harness?.capabilities.display.label ?? 'Harness'
  const totals: SessionTotals = { by: name }
  const context = contextTotals(own?.usageReport)
  if (context) totals.context = context
  if (summary.usage)
    totals.tokens = {
      usage: summary.usage,
      lines: tokenLines(summary.usage),
      ...(harness?.capabilities.models.owner === 'harness' ? { reporter: name } : {}),
    }
  const cost = own?.usageReport?.cost
  if (cost && Number.isFinite(cost.amount))
    totals.cost = {
      text: cost.amount > 0 && cost.amount < 0.01 ? '<$0.01' : currencyAmount(cost.amount, cost.currency),
      reporter: name,
    }
  const timed = (own ? turnsOf(own.messages) : []).flatMap(turn => {
    const active = parseDuration(turn.user?.turn?.activeMs)
    return active === undefined || turn.user?.turn?.endedAt === undefined ? [] : [active]
  })
  if (timed.length > 0) {
    const ms = timed.reduce((sum, value) => sum + value, 0)
    totals.time = { ms, turns: timed.length, text: [formatDuration(ms), `${timed.length} 轮`].filter(Boolean).join(' · ') }
  }
  return totals
}
