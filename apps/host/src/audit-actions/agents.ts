import { z } from 'zod'
import { hex64, opaqueId } from './fields.ts'

/** Engine definitions and their probes; 我的 Agent and 通用; 定时任务. */
export const AGENT_ACTIONS = {
  'agent.changed': z.strictObject({
    kind: z.enum(['agent', 'general', 'memory']),
    operation: z.enum(['create', 'update', 'delete']),
    before: hex64,
    after: hex64,
    customAgentId: opaqueId.optional(),
  }),
  'automation.changed': z.strictObject({ operation: z.enum(['create', 'update', 'delete']), before: hex64, after: hex64 }),
  'automation.ran': z.strictObject({ trigger: z.enum(['schedule', 'manual']), attempt: hex64 }),
  'agent.probe.requested': z.strictObject({ agentId: opaqueId, launchHash: hex64 }),
  'agent.probed': z.strictObject({ agentId: opaqueId, launchHash: hex64, status: z.enum(['ready', 'authentication-required', 'failed']) }),
  'agent.defined': z.strictObject({ agentId: opaqueId, definitionHash: hex64, created: z.boolean() }),
  'agent.deleted': z.strictObject({ agentId: opaqueId }),
} as const
