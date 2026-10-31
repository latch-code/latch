import { z } from 'zod'
import type { ZodType } from 'zod'
import { count, hex64, opaqueId } from './fields.ts'

const plan = {
  sessionId: opaqueId,
  restore: count,
  remove: count,
  skipped: count,
  planHash: hex64,
}
const turnPlan = z.strictObject({ ...plan, turnId: opaqueId })

/** Written before any file changes; a failed write leaves every file as it is. Paths and contents never appear here. */
export const CHANGE_ACTIONS = {
  'change.undo': turnPlan,
  'change.redo': turnPlan,
  'change.discard': z.strictObject({ ...plan, scope: z.enum(['turn', 'uncommitted']), turnId: opaqueId.optional() }),
} as const satisfies Record<string, ZodType>
