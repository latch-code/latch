import { z } from 'zod'
import type { RunEnd, UnknownResult } from '@latch/protocol'

/** Calls of a run that are named; a run can start more, and the rest are only counted as cut off. */
const UNKNOWN_RESULTS = 32

/** How a run ended, as both drivers record it with the session. */
export function runEndRecord(reason: RunEnd['reason'], at: string, unknown: UnknownResult[]): RunEnd {
  return {
    reason,
    at,
    ...(unknown.length ? { unknownResults: unknown.slice(0, UNKNOWN_RESULTS) } : {}),
    ...(unknown.length > UNKNOWN_RESULTS ? { unknownResultsTruncated: true as const } : {}),
  }
}

export const runEndSchema = z.object({
  reason: z.enum(['process-exited', 'forced-stop', 'host-stopped', 'turn-ended']),
  at: z.string(),
  unknownResults: z.array(z.object({ messageId: z.string(), name: z.string() })).optional(),
  unknownResultCount: z.number().int().nonnegative().optional(),
  unknownResultsTruncated: z.literal(true).optional(),
})
