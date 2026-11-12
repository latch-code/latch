import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Message, RunEnd, UnknownResult } from '@latch/protocol'

/** An error code as a failure note keeps it: what a client may match on, never words or a value. */
export const ERROR_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/u

/**
 * The code of an error a turn failed on, for its failure note: an AppError's, or a model service's (`http-401` for an
 * HTTP status). Anything else has none.
 */
export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') return undefined
  const status = 'status' in error && typeof error.status === 'number' ? error.status : undefined
  const code = error.code === 'http-error' && status !== undefined ? `http-${status}` : error.code
  return ERROR_CODE.test(code) ? code : undefined
}

/** What a turn the Host's stop or restart cut off says about itself. */
export const HOST_STOPPED = 'Latch 重启时中断'

/**
 * The note an interrupted turn keeps in its record, for both drivers: no failure, no cancel by anyone, and nothing claimed
 * about what its tools did.
 */
export function interruptedNote(at: string): Message {
  return {
    id: randomUUID(),
    role: 'system',
    text: `${HOST_STOPPED}。旧审批已失效；请核对工具做了什么，再决定是否重试。`,
    state: 'cancelled',
    interrupted: true,
    createdAt: at,
  }
}

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
  reason: z.enum(['process-exited', 'forced-stop', 'host-stopped', 'turn-ended', 'login-required']),
  at: z.string(),
  unknownResults: z.array(z.object({ messageId: z.string(), name: z.string() })).optional(),
  unknownResultCount: z.number().int().nonnegative().optional(),
  unknownResultsTruncated: z.literal(true).optional(),
})
