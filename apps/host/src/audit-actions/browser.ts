import { z, type ZodType } from 'zod'
import { hex64, opaqueId } from './fields.ts'
import { BROWSER_TOOLS } from '../browser-broker.ts'

/**
 * The browser calls of the built-in harness and, through the tool gateway, of external harnesses, each written before it is sent to the desktop app, and the desktop app taking
 * and leaving the provider's place. Never what was typed, a selector or an address: where the tab was is a class and the
 * SHA-256 of its origin.
 */
export const BROWSER_ACTIONS = {
  'browser.call': z.strictObject({
    sessionId: opaqueId,
    callId: z.string().uuid(),
    tool: z.enum(BROWSER_TOOLS),
    tabId: z
      .string()
      .regex(/^brw_[A-Za-z0-9_-]{22}$/u)
      .optional(),
    origin: z.enum(['loopback', 'private', 'internet', 'none']),
    originHash: hex64.optional(),
    risk: z.enum(['R0', 'R1', 'R2']),
    /** The runtime's tool call ID, which `approval.decided` names too, and the approval the person gave it. */
    toolCallId: opaqueId.optional(),
    approvalId: opaqueId.optional(),
    /** From an external harness's `latch-browser` server, through the tool gateway; absent for the built-in harness. */
    via: z.literal('mcp').optional(),
  }),
  'browser.provider.registered': z.strictObject({}),
  'browser.provider.ended': z.strictObject({}),
} as const satisfies Record<string, ZodType>
