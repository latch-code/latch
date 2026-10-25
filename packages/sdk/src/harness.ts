import type { Bridge, ProjectFolder } from './bridge.ts'
import type { RuntimeRegistry } from './plugins.ts'
import type { HarnessInfo, ModelRef, RiskLevel } from '@latch/protocol/types'

export interface ToolRiskInput {
  toolName: string
  arguments: Record<string, unknown>
  cwd: string
  sessionId: string
  /** The session's folders in order; `[0]` is the primary folder at `cwd`. Absent: one folder `{ id: 'default', path: cwd }`. */
  folders?: ReadonlyArray<ProjectFolder>
}

/** A project a session may use, as the Host lists it: `default` is the start directory. */
export interface HostProject {
  id: string
  /** Ordered; `[0]` is the primary folder. */
  folders: ReadonlyArray<ProjectFolder>
}

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
  /**
   * Drivers that declare `projectFolders: 'all'`: the projects sessions may use now, with their folders. The driver's
   * own second check of `CreateTaskInput.folders`, and of a session's folders before each later input.
   */
  projects?: () => HostProject[]
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
  /** Milliseconds since the epoch for the times a driver records on messages and runs. Default `Date.now`. */
  clock?: () => number
}

/** A complete harness implementation. This is distinct from a model API adapter. */
export interface HarnessDriver {
  id: string
  name: string
  version: string
  description?: string
  /** Modes and model ownership shown to clients. Defaults: both modes, agent-managed models. */
  capabilities?: Pick<HarnessInfo, 'modes' | 'models'>
  /**
   * `all`: sessions receive every folder of their project (`CreateTaskInput.folders`) and the driver gets `projects()`.
   * Absent: sessions receive the primary folder only, as `cwd`.
   */
  projectFolders?: 'all'
  /**
   * What clients are told about a project's other folders (`HarnessInfo.projectFolders`). With `projectFolders: 'all'`:
   * `access: 'all'`, and `max` caps the folders of a project a session can start in. Without it: how the harness treats
   * folders it never receives (`primary`, the default; `primary-asks`; `primary-unbounded`). The Host reports `all` only
   * for a driver that declares `projectFolders: 'all'`.
   */
  folderAccess?: NonNullable<HarnessInfo['projectFolders']>
  /** Optional readiness probe, e.g. whether an agent binary is installed. */
  status?(): { status: HarnessInfo['status']; statusMessage?: string }
  /** Creates an unstarted instance; asynchronous initialization belongs to Bridge.start(). */
  create(options: HarnessHostOptions): Bridge
}

export type { Bridge as HarnessInstance } from './bridge.ts'
