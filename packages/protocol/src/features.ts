import type { TokenUsage } from './types.ts'

/** Optional feature discovery; older Hosts omit these fields. */
export interface HostFeatures {
  personal?: true
  personalRoutines?: true
  personalGroups?: true
  personalQueue?: true
  configReceipts?: true
  promptTemplates?: true
  fileSearch?: true
  fileTree?: true
  pluginPackages?: true
  filePreview?: true
  nativeBulk?: true
  nativeBulkStream?: true
  search?: true
  sessionBatch?: true
  fork?: true
  queue?: true
  questions?: true
  /** User messages retain the prompt's requestId, so a client may replace a pending bubble by identity. */
  messageIdentity?: true
  fileMentions?: true
  attachments?: true
  agentProbe?: true
  usage?: true
  changes?: true
  gitWrites?: true
  terminal?: true
  previewBrowser?: true
  customAgents?: true
  automations?: true
  mentions?: true
  pairingV3?: true
  nativeElevation?: true
}

export interface SearchHit {
  sessionId: string
  messageId: string
  title: string
  snippet: string
  match: { start: number; end: number }
  updatedAt: string
  archived: boolean
}
export interface SearchResults {
  hits: SearchHit[]
  truncated: boolean
}
export interface SessionBatchResult {
  results: Array<{ id: string; ok: true } | { id: string; ok: false; code: string; message: string }>
}

export interface PromptTemplate {
  id: string
  name: string
  content: string
  scope: { kind: 'all' } | { kind: 'project'; id: string } | { kind: 'agent'; id: string }
}

export interface UsageSummary {
  days: 7 | 30
  from: string
  to: string
  rows: Array<{
    harnessId: string
    providerId?: string
    model?: string
    source: 'provider' | 'agent'
    messages: number
    usage: TokenUsage
    /** A missing/invalid/overflowing contribution omits this split from usage instead of publishing a partial sum. */
    partial: Record<'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens', boolean>
  }>
  unattributedMessages: number
  truncated: boolean
}

/** A bounded initialize-only diagnostic; a successful handshake does not verify login or model access. */
export interface AgentProbeResult {
  status: 'ready' | 'authentication-required' | 'failed'
  agent?: { name?: string; version?: string }
  capabilities: { embeddedContext?: boolean; images: boolean; resume: boolean; load: boolean; additionalDirectories: boolean }
  authMethods: Array<{ name: string; description?: string }>
  diagnostic?: string
  checkedAt: string
  launchHash: string
}

/** Visible queue state; authority and deduplication receipts remain private to the Host. */
export interface PromptQueueItem {
  id: string
  text: string
  queuedAt: string
  state: 'waiting' | 'parked' | 'dropped'
  reason?: string
}
