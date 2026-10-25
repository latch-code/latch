import type { TaskDetail, TokenUsage, UsageSummary } from '@latch/protocol'
interface Source {
  list(): Promise<Array<{ id: string }>>
  detail(id: string): Promise<TaskDetail>
  now?: () => number
  budgetMs?: number
}
/** Counts only timestamped assistant usage the execution driver actually persisted. */
export async function reportedUsage(source: Source, days: 7 | 30): Promise<UsageSummary> {
  const now = source.now ?? Date.now,
    end = now(),
    start = end - days * 86_400_000,
    deadline = performance.now() + (source.budgetMs ?? 5000)
  const result: UsageSummary = {
    days,
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    rows: [],
    unattributedMessages: 0,
    truncated: false,
  }
  const rows = new Map<string, UsageSummary['rows'][number]>()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const summaries = await Promise.race([
      source.list(),
      new Promise<null>(done => {
        timer = setTimeout(() => done(null), Math.max(1, deadline - performance.now()))
      }),
    ])
    clearTimeout(timer)
    if (!summaries) return { ...result, truncated: true }
    for (const task of summaries) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        result.truncated = true
        break
      }
      try {
        const detail = await Promise.race([
          source.detail(task.id),
          new Promise<null>(done => {
            timer = setTimeout(() => done(null), remaining)
          }),
        ])
        clearTimeout(timer)
        if (!detail) {
          result.truncated = true
          break
        }
        for (const message of detail.messages) {
          if (performance.now() >= deadline) {
            result.truncated = true
            break
          }
          if (message.role !== 'assistant' || !message.usage) continue
          const at = Date.parse(message.completedAt ?? message.createdAt ?? '')
          if (!Number.isFinite(at)) {
            result.unattributedMessages++
            continue
          }
          if (at < start || at > end) continue
          const usage = message.usage
          if (![usage.inputTokens, usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
            result.unattributedMessages++
            continue
          }
          const harnessId = detail.summary.harnessId ?? 'standard',
            providerId = message.providerId,
            model = message.model
          const key = JSON.stringify([harnessId, providerId, model]),
            reportSource = providerId || harnessId === 'standard' ? 'provider' : 'agent'
          let row = rows.get(key)
          if (!row) {
            row = {
              harnessId,
              ...(providerId ? { providerId } : {}),
              ...(model ? { model } : {}),
              source: reportSource,
              messages: 0,
              usage: { inputTokens: 0, outputTokens: 0 },
              partial: { cacheReadTokens: false, cacheWriteTokens: false, reasoningTokens: false },
            }
            rows.set(key, row)
          }
          if (
            !Number.isSafeInteger(row.usage.inputTokens + usage.inputTokens)
            || !Number.isSafeInteger(row.usage.outputTokens + usage.outputTokens)
          ) {
            result.unattributedMessages++
            continue
          }
          row.messages++
          row.usage.inputTokens += usage.inputTokens
          row.usage.outputTokens += usage.outputTokens
          for (const part of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const satisfies ReadonlyArray<
            keyof TokenUsage
          >) {
            const value = usage[part]
            if (value === undefined || !Number.isSafeInteger(value) || value < 0) row.partial[part] = true
            else row.usage[part] = (row.usage[part] ?? 0) + value
          }
        }
      } catch {
        result.truncated = true
      } finally {
        clearTimeout(timer)
      }
    }
  } finally {
    clearTimeout(timer)
  }
  result.rows = [...rows.values()].toSorted(
    (a, b) => b.usage.inputTokens + b.usage.outputTokens - a.usage.inputTokens - a.usage.outputTokens,
  )
  return result
}
