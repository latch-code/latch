import { z, type ZodType } from 'zod'
import { SIMULATOR_PRIVACY_ACTIONS, SIMULATOR_PRIVACY_SERVICES } from '@latch/protocol'
import { hex64, opaqueId } from './fields.ts'

const udid = z.string().regex(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u)
const direction = z.enum(['left', 'right'])

/**
 * This Mac's iOS simulators: each action of the person in the 设备 panel and each `device_*` call of an Agent, written
 * before it runs. Who, which device, which action; never a picture, a recording or a log line, of an opened address only
 * its scheme and the SHA-256 of its origin, of an app only the SHA-256 of its bundle id, and of a new device its type and
 * runtime identifiers but never the name the person typed. The panel's own frames are looking, not acting, and are not
 * recorded. `auto-shutdown` is the Host's own: a device it booted, shut down when idle or as the Host stops.
 */
export const SIMULATOR_ACTIONS = {
  'simulator.action': z
    .strictObject({
      action: z.enum([
        'boot',
        'shutdown',
        'screenshot',
        'open-url',
        'appearance',
        'device-hub',
        'rotate',
        'record',
        'create',
        'launch',
        'terminate',
        'privacy',
        'logs',
        'auto-shutdown',
      ]),
      /** Absent for `create` alone, which has no device yet; required for every other action (checked below). */
      udid: udid.optional(),
      appearance: z.enum(['light', 'dark']).optional(),
      direction: direction.optional(),
      privacy: z.enum(SIMULATOR_PRIVACY_ACTIONS).optional(),
      service: z.enum(SIMULATOR_PRIVACY_SERVICES).optional(),
      bundleHash: hex64.optional(),
      /** Whether a log stream is one app's. */
      filtered: z.boolean().optional(),
      deviceType: z
        .string()
        .regex(/^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9.-]{1,80}$/u)
        .optional(),
      runtime: z
        .string()
        .regex(/^com\.apple\.CoreSimulator\.SimRuntime\.[A-Za-z0-9.-]{1,80}$/u)
        .optional(),
      reason: z.enum(['idle', 'host-stop']).optional(),
      scheme: z
        .string()
        .regex(/^[a-z][a-z0-9+.-]{0,31}$/u)
        .optional(),
      originHash: hex64.optional(),
    })
    .refine(detail => (detail.action === 'create') === (detail.udid === undefined), {
      message: 'udid is absent for create and present for every other action',
      path: ['udid'],
    }),
  'simulator.call': z.strictObject({
    sessionId: opaqueId,
    callId: z.string().uuid(),
    tool: z.enum([
      'device_list',
      'device_screenshot',
      'device_open_url',
      'device_set_appearance',
      'device_rotate',
      'device_apps',
      'device_launch',
    ]),
    udid: udid.optional(),
    risk: z.enum(['R0', 'R1', 'R2']),
    appearance: z.enum(['light', 'dark']).optional(),
    direction: direction.optional(),
    bundleHash: hex64.optional(),
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
