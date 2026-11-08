import { z } from 'zod'
import { hex64, opaqueId } from './fields.ts'

/** Assistants, memories, groups and routines, which Latch no longer has; an audit file holding these lines still opens. */
export const PERSONAL_ACTIONS = {
  'personal.changed': z.strictObject({
    kind: z.enum(['assistant', 'memory', 'group', 'routine']),
    operation: z.enum(['create', 'update', 'delete', 'start']),
    before: hex64,
    after: hex64,
    assistantId: opaqueId.optional(),
  }),
} as const
