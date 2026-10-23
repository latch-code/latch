import type { Bridge } from '../host/bridge.ts'
import type { RuntimeRegistry } from './plugins.ts'
import type { HarnessInfo, ModelRef, RiskLevel } from '../shared/types.ts'

export interface ToolRiskInput { toolName: string; arguments: Record<string, unknown>; cwd: string; sessionId: string }

export type HarnessSecurityEvent =
  | { type: 'permission-drift'; sessionId: string; observedHash: string }
  | { type: 'permission-unverified'; sessionId: string }
  | { type: 'approval-auto-rejected'; sessionId: string; reason: 'persistent-only' | 'unknown-kind' }

/** Host capabilities offered to a driver, without prescribing its loop or persistence. */
export interface HarnessHostOptions {
  /** Private data directory assigned to the selected driver. */
  dataDir: string
  /** Default working directory for sessions created without `cwd`. */
  workspaceRoot: string
  /** Absolute directories a session may use as `cwd`. Defaults to `[workspaceRoot]`. */
  workspaces?: () => string[]
  /** A driver can use the app's providers/tools, or implement its own execution layer. */
  registry: RuntimeRegistry
  /** Read once when a new run begins; an existing run must retain its original selection. */
  providerId: string | (() => string)
  /** Default model for sessions that do not choose one. Read when a session is created. */
  defaultModel?: () => ModelRef | undefined
  maxSteps?: number
  /** Host classifier. R0: no approval. R1: approval; "本会话始终允许" allowed. R2: approval every time; no always option. Absent: legacy (requiresApproval → R1, else R0). */
  classifyToolCall?(input: ToolRiskInput): Promise<RiskLevel>
  /** Private 0700 directory for per-session temporary directories. */
  tmpRoot?: string
  /** Fire-and-forget security events; the Host audits them. Never throws into the driver. */
  securityEvent?(event: HarnessSecurityEvent): void
}

/** A complete harness implementation. This is distinct from a model API adapter. */
export interface HarnessDriver {
  id: string
  name: string
  version: string
  description?: string
  /** Modes and model ownership shown to clients. Defaults: both modes, agent-managed models. */
  capabilities?: Pick<HarnessInfo, 'modes' | 'models'>
  /** Optional readiness probe, e.g. whether an agent binary is installed. */
  status?(): { status: HarnessInfo['status']; statusMessage?: string }
  /** Creates an unstarted instance; asynchronous initialization belongs to Bridge.start(). */
  create(options: HarnessHostOptions): Bridge
}

export type { Bridge as HarnessInstance } from '../host/bridge.ts'
