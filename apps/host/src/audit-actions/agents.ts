import { z } from 'zod'
import { hex64, opaqueId } from './fields.ts'

/** Engine definitions and their probes; 我的 Agent and 通用; 定时任务. */
export const AGENT_ACTIONS = {
  'agent.changed': z.strictObject({
    kind: z.enum(['agent', 'general', 'memory', 'proposal']),
    operation: z.enum(['create', 'update', 'delete']),
    before: hex64,
    after: hex64,
    customAgentId: opaqueId.optional(),
    /** A memory saved from a proposal, or put back by 撤销. */
    via: z.enum(['proposal', 'undo']).optional(),
  }),
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
  'agent.probe.requested': z.strictObject({ agentId: opaqueId, launchHash: hex64 }),
  'agent.probed': z.strictObject({ agentId: opaqueId, launchHash: hex64, status: z.enum(['ready', 'authentication-required', 'failed']) }),
  /** A harness started only to say what it offers: an empty session with no prompt, or its own model list. */
  'agent.catalogue.requested': z.strictObject({ agentId: opaqueId, auto: z.boolean() }),
  'agent.catalogue.read': z.strictObject({ agentId: opaqueId, ok: z.boolean() }),
  'agent.models.changed': z.strictObject({ agentId: opaqueId, count: z.number().int().min(0).max(32) }),
  /** The program's status command is about to run. */
  'agent.login.requested': z.strictObject({ agentId: opaqueId }),
  /** The program's status command ran; the status is all that is kept of what it said. */
  'agent.login.checked': z.strictObject({ agentId: opaqueId, status: z.enum(['authenticated', 'unauthenticated', 'unknown']) }),
  /** A login opened in this computer's terminal: `harness`, one the harness advertised; otherwise the preset's command. */
  'agent.login.opened': z.strictObject({ agentId: opaqueId, source: z.literal('harness').optional() }),
  /** The harness is about to be asked to log out. */
  'agent.logout': z.strictObject({ agentId: opaqueId }),
  'agent.defined': z.strictObject({ agentId: opaqueId, definitionHash: hex64, created: z.boolean() }),
  'agent.deleted': z.strictObject({ agentId: opaqueId }),
} as const
