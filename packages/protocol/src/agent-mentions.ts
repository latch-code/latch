/** A question directed to one other local personal Agent, before or after either Agent has a chat. */
export interface AgentMentionCreate {
  requestId: string
  target: { kind: 'agent'; customAgentId: string }
  text: string
}

export type AgentConsultationMode = 'text-only' | 'own-permissions'

export interface AgentMention {
  id: string
  requestId: string
  sourceAgentId: string
  sourceSessionId?: string
  targetAgentId: string
  targetSessionId?: string
  initiator: 'person' | 'agent'
  /** Pinned by the Host on agent-initiated exchanges. Older records omit it. */
  consultationMode?: AgentConsultationMode
  text: string
  createdAt: string
  status: 'sending' | 'running' | 'waiting-approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'
  /** Read from the addressed turn only; never persisted in the source chat. */
  reply?: { messageId: string; text: string; more?: true }
  /** An unconfirmed submission made by the device reading this view. */
  canRetry?: true
  failure?: string
}
