import { z, type ZodType } from 'zod'
import { opaqueId } from './fields.ts'

/** Terminals: each one opened, before its shell starts. Input is never recorded. */
export const TERMINAL_ACTIONS = {
  'terminal.open': z.union([
    z.strictObject({ sessionId: opaqueId, terminalId: opaqueId }),
    z.strictObject({ workspaceId: opaqueId, terminalId: opaqueId }),
  ]),
} as const satisfies Record<string, ZodType>
