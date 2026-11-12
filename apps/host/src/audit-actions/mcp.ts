import { z, type ZodType } from 'zod'
import { count, hex64, opaqueId, prefixed } from './fields.ts'

const serverId = prefixed('mcp')
const callId = z.string().uuid()

/**
 * Latch's own MCP servers (docs/MCP.md): their definitions changing, 测试, and every tool call that passes a `latch-mcp`
 * bridge, written before the call is sent. Never a server's or a tool's name, a command, an argument, a value or a
 * result: a tool is named by the SHA-256 of its server and name.
 */
export const MCP_ACTIONS = {
  'mcp.server.added': z.strictObject({
    serverId,
    specHash: hex64,
    envCount: count,
    scope: z.enum(['all', 'chosen']),
    projectCwd: z.boolean(),
  }),
  'mcp.server.changed': z.strictObject({
    serverId,
    kinds: z
      .array(z.enum(['spec', 'secret', 'scope', 'tools', 'enabled', 'name']))
      .min(1)
      .max(6),
    specHash: hex64,
    enabled: z.boolean(),
  }),
  'mcp.server.removed': z.strictObject({ serverId }),
  /** 测试 on this Mac: the Host runs the confirmed command once. */
  'mcp.server.test': z.strictObject({ serverId, specHash: hex64 }),
  /** A session's `latch-mcp` bridge took the launch: the person's program starts in that agent's process. */
  'mcp.server.started': z.strictObject({ serverId, sessionId: opaqueId, specHash: hex64 }),
  'mcp.tool.called': z.strictObject({ serverId, sessionId: opaqueId, callId, toolHash: hex64 }),
  'mcp.tool.settled': z.strictObject({
    serverId,
    sessionId: opaqueId,
    callId,
    result: z.enum(['ok', 'error', 'cancelled', 'failed']),
    ms: count,
  }),
} as const satisfies Record<string, ZodType>
