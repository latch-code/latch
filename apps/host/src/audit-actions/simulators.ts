import { z, type ZodType } from 'zod'
import { hex64, opaqueId } from './fields.ts'

const udid = z.string().regex(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u)

/**
 * This Mac's iOS simulators: each action of the person in the 设备 panel and each `device_*` call of an Agent, written
 * before it runs. Who, which device, which action; never a picture, and of an opened address only its scheme and the
 * SHA-256 of its origin. The panel's own frames are looking, not acting, and are not recorded.
 */
export const SIMULATOR_ACTIONS = {
  'simulator.action': z.strictObject({
    action: z.enum(['boot', 'shutdown', 'screenshot', 'open-url', 'appearance', 'device-hub']),
    udid,
    appearance: z.enum(['light', 'dark']).optional(),
    scheme: z
      .string()
      .regex(/^[a-z][a-z0-9+.-]{0,31}$/u)
      .optional(),
    originHash: hex64.optional(),
  }),
  'simulator.call': z.strictObject({
    sessionId: opaqueId,
    callId: z.string().uuid(),
    tool: z.enum(['device_list', 'device_screenshot', 'device_open_url', 'device_set_appearance']),
    udid: udid.optional(),
    risk: z.enum(['R0', 'R1', 'R2']),
    appearance: z.enum(['light', 'dark']).optional(),
    scheme: z
      .string()
      .regex(/^[a-z][a-z0-9+.-]{0,31}$/u)
      .optional(),
    originHash: hex64.optional(),
    /** The runtime's tool call ID and the approval the person gave it, as `browser.call` names them. */
    toolCallId: opaqueId.optional(),
    approvalId: opaqueId.optional(),
    /** From an external harness through the tool gateway; absent for the built-in harness. */
    via: z.literal('mcp').optional(),
  }),
} as const satisfies Record<string, ZodType>
