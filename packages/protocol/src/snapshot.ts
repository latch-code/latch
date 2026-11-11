import type { SkillInfo, UiPanelInfo } from './ui.ts'
import type { HostFeatures } from './features.ts'
import type { CustomAgentSummary } from './custom-agents.ts'
import type { AutomationSummary } from './automations.ts'
import type { HandoffSummary } from './handoffs.ts'
import type { Approval, TaskDetail, TaskSummary } from './sessions.ts'
import type { CurrentDevice, PermissionLevel, PresenceAvailability } from './devices.ts'
import type { HarnessInfo } from './harnesses.ts'
import type { ProviderSummary, SessionDefaults, UnusableProvider, WorkspaceInfo } from './settings.ts'

export interface HostView {
  hostId: string
  devMode: boolean
  /**
   * `reason` (absent from older Hosts) tells a system without local confirmation (`platform`, or `disabled` in the
   * policy) from a Mac whose confirmation component needs fixing; `message` says how.
   */
  presence: {
    status: 'available' | 'unavailable'
    message?: string
    reason?: Extract<PresenceAvailability, { status: 'unavailable' }>['reason']
  }
  tls: { origin: string } | null
  native?: { enabled: boolean; discoveryEpoch?: string; directoryEpoch?: string }
}

/** What a device may choose when it starts a session. */
export interface HostCatalog {
  promptTemplatesVersion?: string
  features?: HostFeatures
  harnesses: HarnessInfo[]
  providers: ProviderSummary[]
  /** Enabled services left out of `providers`, so a page can say why; absent from older Hosts. */
  unusableProviders?: UnusableProvider[]
  /** Session panels contributed by enabled plugins; absent from older Hosts. */
  uiPanels?: UiPanelInfo[]
  /** Enabled Standard skills. Contents remain on the Host. */
  skills?: SkillInfo[]
  workspaces: WorkspaceInfo[]
  defaults: SessionDefaults
  /** Present when the Host supports projects of several folders, added from the desktop only; `max` folders per project. */
  projectFolders?: { max: number }
  /** Agent sessions outside a saved project each get a new folder of their own inside the start directory. */
  sessionFolders?: true
}

export interface AppSnapshot {
  instanceId: string
  revision?: number
  device: CurrentDevice
  host: HostView
  tasks: TaskSummary[]
  approvals: Approval[]
  demo: boolean
  hostName: string
  /** Default harness for new sessions. */
  harness?: { id: string; name: string }
  /** Host-known prerequisites; external drivers own their backend configuration. */
  execution?: { ready: boolean; providerId?: string; modelConfigurationRequired?: boolean }
  catalog?: HostCatalog
  /** 我的 Agent, for devices that may read them; absent otherwise and on older Hosts. */
  customAgents?: CustomAgentSummary[]
  /** 定时任务, under the same condition. */
  automations?: AutomationSummary[]
  /** Handoffs whose source or target is among `tasks`; absent on older Hosts. */
  handoffs?: HandoffSummary[]
  version?: string
  /** The Host's clock when it answered. */
  hostTime?: string
}

export interface ChangeEvent {
  /** Optional SHA-256 discovery-key cache hint; does not unlock content or advance body cursors. */
  discoveryEpoch?: string
  directoryEpoch?: string
  type: 'refresh' | 'tasks-invalidated'
  instanceId: string
  revision: number
  sessionId?: string
}

export interface TaskStateEvent {
  type: 'task-state'
  instanceId: string
  revision: number
  sessionId: string
  detail: TaskDetail
  /** The Host's clock when it sent the event. */
  hostTime?: string
}

/** Why the Host is about to stop answering: restarting, updating, the computer going to sleep, or stopping. */
export type HostStateReason = 'restart' | 'update' | 'sleep' | 'shutdown'
export const HOST_STATE_REASONS: readonly HostStateReason[] = ['restart', 'update', 'sleep', 'shutdown']

/**
 * The Host's own announcement on the event stream. `stopping` and `sleeping` come just before the Host stops answering;
 * clients try again after `retryAfter` seconds instead of their usual backoff. `awake` follows the computer waking up.
 */
export interface HostStateEvent {
  type: 'host-state'
  instanceId: string
  state: 'stopping' | 'sleeping' | 'awake'
  /** With `stopping` and `sleeping` (always `sleep` there). */
  reason?: HostStateReason
  /** Seconds; with `stopping` and `sleeping`. */
  retryAfter?: number
  /** ISO time at which the state began. */
  at: string
}
