import { z } from 'zod'
import { count, hex64, opaqueId } from './fields.ts'

/** Engine definitions and their probes; 我的 Agent and 通用; 定时任务. */
export const AGENT_ACTIONS = {
  'agent.home.assigned': z.strictObject({ homeHash: hex64 }),
  'agent.changed': z.strictObject({
    kind: z.enum(['agent', 'general', 'memory', 'proposal']),
    operation: z.enum(['create', 'update', 'delete']),
    before: hex64,
    after: hex64,
    customAgentId: opaqueId.optional(),
    /** A memory saved from a proposal, put back by 撤销, or confirmed as the person's own (设为我说的). */
    via: z.enum(['proposal', 'undo', 'own']).optional(),
  }),
  /** An Agent written to a file for the person, and one created from such a file: IDs and counts only. */
  'agent.exported': z.strictObject({ customAgentId: opaqueId, memories: count, schedules: count }),
  'agent.imported': z.strictObject({ customAgentId: opaqueId, memories: count, schedules: count, fileHash: hex64 }),
  /** A memory proposal kept pending for the person; never its text. */
  'agent.memory.proposed': z.strictObject({
    origin: z.enum(['user', 'agent']),
    external: z.boolean(),
    customAgentId: opaqueId.optional(),
    /** A memory or a schedule; absent on records written before schedules could be proposed. */
    kind: z.enum(['memory', 'schedule']).optional(),
  }),
  'automation.changed': z.strictObject({ operation: z.enum(['create', 'update', 'delete']), before: hex64, after: hex64 }),
  'automation.ran': z.strictObject({ trigger: z.enum(['schedule', 'manual']), attempt: hex64 }),
  /** Opening an Agent's chat starts its process ahead of the next message: which Agent and its one chat, nothing else. */
  'agent.warm.requested': z.strictObject({ customAgentId: opaqueId, sessionId: opaqueId }),
  'agent.probe.requested': z.strictObject({ agentId: opaqueId, launchHash: hex64 }),
  'agent.probed': z.strictObject({ agentId: opaqueId, launchHash: hex64, status: z.enum(['ready', 'authentication-required', 'failed']) }),
  /** A harness started only to say what it offers: an empty session with no prompt, or its own model list. */
  'agent.catalogue.requested': z.strictObject({ agentId: opaqueId, auto: z.boolean() }),
  'agent.catalogue.read': z.strictObject({ agentId: opaqueId, ok: z.boolean() }),
  /** 读取 of a Harness's own MCP servers (Codex's app-server): it starts the servers it has configured to answer. */
  'agent.mcp.requested': z.strictObject({ agentId: opaqueId }),
  'agent.mcp.read': z.strictObject({ agentId: opaqueId, ok: z.boolean() }),
  'agent.models.changed': z.strictObject({ agentId: opaqueId, count: z.number().int().min(0).max(32) }),
  /** The program's status command is about to run. */
  'agent.login.requested': z.strictObject({ agentId: opaqueId }),
  /** The program's status command ran; the status is all that is kept of what it said. */
  'agent.login.checked': z.strictObject({ agentId: opaqueId, status: z.enum(['authenticated', 'unauthenticated', 'unknown']) }),
  /** A login opened in this computer's terminal: `harness`, one the harness advertised; otherwise the preset's command. */
  'agent.login.opened': z.strictObject({ agentId: opaqueId, source: z.literal('harness').optional() }),
  /**
   * The Host read a preset CLI's own key and is about to ask the vendor's official endpoint for its balance
   * (`cli-quota.ts`). Which Harness only: never the key, the balance or the account.
   */
  'agent.quota.read': z.strictObject({ agentId: opaqueId, presetId: z.literal('dsh') }),
  /** Someone looked at the limits and the harness is about to be asked: its command, a request, or the Host's own read. */
  'agent.quota.requested': z.strictObject({ agentId: opaqueId }),
  /** The harness is about to be asked to log out. */
  'agent.logout': z.strictObject({ agentId: opaqueId }),
  'agent.defined': z.strictObject({ agentId: opaqueId, definitionHash: hex64, created: z.boolean() }),
  'agent.deleted': z.strictObject({ agentId: opaqueId }),
} as const
