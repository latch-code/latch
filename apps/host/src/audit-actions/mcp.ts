import { z, type ZodType } from 'zod'
import { COMPUTER_REFUSALS } from '@latch/protocol'
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
    /** Absent for a local command (`stdio`), as before remote addresses. */
    transport: z.literal('http').optional(),
    /** 从项目导入: the project whose `.mcp.json` prefilled it, by ID. */
    importedFrom: opaqueId.optional(),
    /** 「操控这台 Mac」: the Host wrote the definition for Cua Driver. */
    preset: z.enum(['computer', 'xcode']).optional(),
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
  /**
   * 「Xcode」: Latch's class of the tool, and the simulator a device tool names (its UDID), never a picture. 「操控这台
   * Mac」: `steps`, how many steps a `run_steps` carries, each checked by the Host before the call went.
   */
  'mcp.tool.called': z.strictObject({
    serverId,
    sessionId: opaqueId,
    callId,
    toolHash: hex64,
    risk: z.enum(['R0', 'R1', 'R2']).optional(),
    udid: z
      .string()
      .regex(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u)
      .optional(),
    steps: count.optional(),
  }),
  /** A 「操控这台 Mac」 call the Host refused by its arguments, before anything was sent; why, never the arguments. */
  'mcp.tool.refused': z.strictObject({ serverId, sessionId: opaqueId, toolHash: hex64, reason: z.enum(COMPUTER_REFUSALS) }),
  /** 停 in a session: the person ended that session's bridge to a server; written before it ends. */
  'mcp.server.stopped': z.strictObject({ serverId, sessionId: opaqueId }),
  'mcp.tool.settled': z.strictObject({
    serverId,
    sessionId: opaqueId,
    callId,
    result: z.enum(['ok', 'error', 'cancelled', 'failed']),
    ms: count,
  }),
  /**
   * A local bridge requested permission to forward `prompts/get`. Written before persisting the session marker.
   * The detail contains the prompt's hash, with no name, arguments or text.
   */
  'mcp.prompt.got': z.strictObject({ serverId, sessionId: opaqueId, promptHash: hex64 }),
  /**
   * A remote server's login (OAuth), started on this Mac: begun (before anything is listened for or opened), finished
   * (before the tokens are kept), refused or given up (by class), a renewal the authorization server refused, and the
   * tokens' end. Never a token, a code, a state, a client ID or an address.
   */
  'mcp.oauth.started': z.strictObject({ serverId }),
  'mcp.oauth.authorized': z.strictObject({ serverId, registered: z.boolean(), renewable: z.boolean() }),
  'mcp.oauth.failed': z.strictObject({
    serverId,
    reason: z.enum([
      'discovery',
      'resource',
      'metadata',
      'endpoint',
      'pkce',
      'client-required',
      'registration',
      'state',
      'issuer',
      'replay',
      'denied',
      'expired',
      'exchange',
      'token',
      'scope',
      'refused',
      'unreachable',
      'cancelled',
      'audit',
    ]),
  }),
  'mcp.oauth.refresh-failed': z.strictObject({ serverId }),
  'mcp.oauth.revoked': z.strictObject({ serverId, result: z.enum(['revoked', 'failed', 'unsupported', 'none', 'undeleted']) }),
} as const satisfies Record<string, ZodType>
