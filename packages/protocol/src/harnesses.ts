import type { AgentPreset } from './agent-presets.ts'
import type { AgentProbeResult } from './features.ts'
import type { TaskMode } from './sessions.ts'

export type HarnessSource = 'builtin' | 'acp' | 'plugin'
export interface HarnessInfo {
  /** How an agent's instructions and memories reach this engine. Absent: they cannot, so no agent can run on it. */
  agentContext?: 'private' | 'first-turn'
  /** How an agent's skills reach it: loaded natively, or fetched from a read-only server. Absent: they do not. */
  skills?: 'native' | 'server'
  attachments?: { images?: boolean; text?: boolean; textBytes?: number }
  id: string
  name: string
  description?: string
  source: HarnessSource
  /** `ready` can start sessions; `unavailable` explains why in `statusMessage`. */
  status: 'ready' | 'unavailable'
  statusMessage?: string
  /** Session modes the harness accepts. */
  modes: TaskMode[]
  /** `host`: uses the Host's model providers; `agent`: the agent manages its own models. */
  models: 'host' | 'agent'
  /** L1: builtin, Latch asks per risky call. L3: ACP or plugin harness, unsandboxed. */
  level?: 'L1' | 'L3'
  /**
   * Which folders of a project the harness receives. `all`: every folder (at most `max`); `primary`: the primary folder
   * only; `primary-asks`: the primary folder, and it asks before using others; `primary-unbounded`: the primary folder,
   * and it does not limit which directories it reads. Absent: an older Host, or `primary`.
   */
  projectFolders?: { access: ProjectFolderAccess; max?: number }
  /** Other devices may start sessions on this harness under the current policy; absent from older Hosts. */
  remoteStart?: boolean
}

export type ProjectFolderAccess = 'all' | 'primary' | 'primary-asks' | 'primary-unbounded'

/**
 * An ACP agent definition as the Host stores it in settings.json. Host-only: `env` holds values that never leave the
 * Host; browsers receive `AgentSettings` instead.
 */
export interface AgentRecord {
  id: string
  name: string
  presetId?: string
  command: string
  args: string[]
  env: Record<string, string>
  enabled: boolean
  /**
   * The definition's hash when a full-access session last started with it; null once saved and not started since.
   * Absent on definitions saved before the Host recorded starts, which were confirmed when they were saved.
   */
  startedHash?: string | null
  lastProbe?: AgentProbeResult
  probedDefinitionHash?: string
}

/**
 * Result of resolving a command on the Host's PATH and install directories; with a preset that names a companion (the
 * agent an adapter connects to), whether that was found too. Older Hosts send no `companion`.
 */
export interface CommandDetection {
  found: boolean
  path?: string
  companion?: { command: string; found: boolean }
}

/** A preset as the agent settings list it: with what the Host found of its commands. Older Hosts send no `detected`. */
export interface AgentPresetSettings extends AgentPreset {
  detected?: CommandDetection
}

/** Owner-only ACP agent definition as returned to the browser. Env values are never returned. */
export interface AgentSettings {
  id: string
  name: string
  presetId?: string
  command: string
  args: string[]
  envKeys: string[]
  enabled: boolean
  detected: CommandDetection
  /** Matches a preset's command and arguments exactly. */
  verified: boolean
  /** Chinese reason the definition cannot run, e.g. a reserved env name. */
  problem?: string
  /**
   * False until a full-access session has started with this exact definition (saving it asks for no confirmation; that
   * first start does). Absent on older Hosts and for definitions saved before the Host recorded starts.
   */
  started?: boolean
  /** Last handshake of this definition; not a promise about its current login state. */
  lastProbe?: AgentProbeResult
}
