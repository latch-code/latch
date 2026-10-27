import { z } from 'zod'
import { hex64, opaqueId } from './fields.ts'

/** Agent definitions and their probes. */
export const AGENT_ACTIONS = {
  'agent.probe.requested': z.strictObject({ agentId: opaqueId, launchHash: hex64 }),
  'agent.probed': z.strictObject({ agentId: opaqueId, launchHash: hex64, status: z.enum(['ready', 'authentication-required', 'failed']) }),
  'agent.defined': z.strictObject({ agentId: opaqueId, definitionHash: hex64, created: z.boolean() }),
  'agent.deleted': z.strictObject({ agentId: opaqueId }),
} as const
