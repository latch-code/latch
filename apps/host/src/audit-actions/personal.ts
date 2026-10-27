import { z } from 'zod'
import { hex64, opaqueId } from './fields.ts'

/** 个人助手: assistants, memories, groups and routines. */
export const PERSONAL_ACTIONS = {
  'personal.changed': z.strictObject({
    kind: z.enum(['assistant', 'memory', 'group', 'routine']),
    operation: z.enum(['create', 'update', 'delete', 'start']),
    before: hex64,
    after: hex64,
    assistantId: opaqueId.optional(),
  }),
} as const
