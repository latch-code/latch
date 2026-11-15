import type { SkillInfo, UiPanelInfo } from './ui.ts'
import type { HostFeatures } from './features.ts'
import type { AgentProposalState, CustomAgentSummary, HostComputerState, PersonalAgentChat } from './custom-agents.ts'
import type { AgentResultState, AutomationSummary } from './automations.ts'
import type { HandoffSummary } from './handoffs.ts'
import type { AppSummary } from './apps.ts'
import type { ReviewNoteCounts } from './review-notes.ts'
import type { Approval, TaskDetail, TaskSummary } from './sessions.ts'
import type { CurrentDevice, PermissionLevel, PresenceAvailability } from './devices.ts'
import type { HarnessInfo } from './harnesses.ts'
import type { FirstSetupStatus, ProviderSummary, SessionDefaults, UnusableProvider, WorkspaceInfo } from './settings.ts'
import type { TaskStreamStamp } from './task-delta.ts'
import type { CustomizationState } from './customization.ts'

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
  /**
   * Every Harness was mounted, listed its sessions and none is turned off, so a session missing from `tasks` (before the
   * scope and privacy filter) no longer exists. Absent: the list may be partial.
   */
  tasksComplete?: true
  approvals: Approval[]
  demo: boolean
  hostName: string
  /** Default harness for new sessions. */
  harness?: { id: string; name: string }
  /** Host-known prerequisites; external drivers own their backend configuration. */
  execution?: { ready: boolean; providerId?: string; modelConfigurationRequired?: boolean }
  catalog?: HostCatalog
  firstSetup?: FirstSetupStatus
  /** 我的 Agent, for devices that may read them; absent otherwise and on older Hosts. */
  customAgents?: CustomAgentSummary[]
  /** Stable interactive chats by Agent owner, under the same scope as customAgents. */
  agentChats?: Record<string, PersonalAgentChat>
  /** 定时任务, under the same condition. */
  automations?: AutomationSummary[]
  /** Memory proposals by owner (an Agent's ID or `general`), under the same condition: counts only, never their text. */
  agentProposals?: Record<string, AgentProposalState>
  /** Schedule result cards by owner, under the same condition: counts and a time only. */
  agentResults?: Record<string, AgentResultState>
  /** What the Host recorded about this computer, under the same condition: no IDs. */
  computer?: HostComputerState
  /** Handoffs whose source or target is among `tasks`; absent on older Hosts. */
  handoffs?: HandoffSummary[]
  /** Applied plugin pages; absent on older Hosts. */
  apps?: AppSummary[]
  /** Line feedback counts of sessions among `tasks` that have any; the notes themselves need data scope `all`. */
  reviewNotes?: ReviewNoteCounts[]
  /** The Host's customisation in force (docs/CUSTOMIZATION.md); absent on older Hosts. */
  customization?: CustomizationState
  version?: string
  /**
   * The build of the page that was beside the Host when it started (`build.json` in its page directory), which a newer
   * page compares with its own to say the Host needs a restart; absent from older Hosts and without that file.
   */
  build?: string
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
  /** Full-baseline acknowledgement, only on an explicitly negotiated non-native subscription. */
  stream?: TaskStreamStamp
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
