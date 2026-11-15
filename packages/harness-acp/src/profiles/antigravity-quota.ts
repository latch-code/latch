/**
 * Antigravity's limits, by its own `/usage` run once without a session: `agy -p /usage --output-format json`. Checked on
 * agy 1.5.8 (2026-11-15): it asks nothing, exits 0 in about six seconds, and reports `num_turns: 0` with every token
 * count 0, so it starts no model turn. It prints one JSON object whose `command.data.groups` hold what is left of each
 * window.
 */
import { z } from 'zod'
import type { QuotaGroup, QuotaWindow, QuotaWindowKind } from '@latch/protocol'
import type { QuotaReport } from '../quota.ts'
import type { QuotaCommand } from './types.ts'

const KINDS: Readonly<Record<string, QuotaWindowKind>> = { '5h': 'five-hour', weekly: 'weekly' }
/**
 * The two general groups, by the name agy gives them. A group of any other name (one model's own, or one added later)
 * is left out: Latch shows no name a vendor wrote.
 */
const GROUPS: Readonly<Record<string, QuotaGroup>> = { 'Gemini Models': 'gemini', 'Claude and GPT models': 'claude-gpt' }

const usage = z.object({
  // A run that turned out to start a turn is not a status read; nothing of it is used.
  num_turns: z.literal(0),
  command: z.object({
    name: z.literal('usage'),
    data: z.object({
      groups: z
        .array(
          z.object({
            name: z.string().max(200),
            buckets: z
              .array(
                z.object({
                  window: z.string().max(32),
                  remaining_fraction: z.number().min(0).max(1),
                  reset_time: z.iso.datetime().optional(),
                }),
              )
              .max(16),
          }),
        )
        .max(32),
    }),
  }),
})

/**
 * One window per known group and kind: used is one minus what agy says is left. `now` bounds the reset time to the
 * coming five weeks. Anything but the shape above is undefined, whole.
 */
export function readAntigravityUsage(stdout: string, now: number): QuotaReport | undefined {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    return undefined
  }
  const parsed = usage.safeParse(value)
  if (!parsed.success) return undefined
  const windows = new Map<string, QuotaWindow>()
  for (const listed of parsed.data.command.data.groups) {
    const group = Object.hasOwn(GROUPS, listed.name) ? GROUPS[listed.name] : undefined
    if (!group) continue
    for (const bucket of listed.buckets) {
      const kind = Object.hasOwn(KINDS, bucket.window) ? KINDS[bucket.window] : undefined
      if (!kind) continue
      const resets = bucket.reset_time === undefined ? Number.NaN : Date.parse(bucket.reset_time)
      windows.set(`${group}:${kind}`, {
        kind,
        group,
        usedPercent: Math.round((1 - bucket.remaining_fraction) * 1000) / 10,
        ...(resets > now && resets < now + 35 * 86_400_000 ? { resetsAt: new Date(resets).toISOString() } : {}),
      })
    }
  }
  return windows.size ? { windows: [...windows.values()], whole: true } : undefined
}

export const antigravityQuotaCommand: QuotaCommand = {
  args: ['-p', '/usage', '--output-format', 'json'],
  // A status read must not start an update of the program; the value is the lower-case word.
  env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
  timeoutMs: 20_000,
  read: readAntigravityUsage,
}
