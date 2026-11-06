import type { AgentPreset } from './agent-presets.ts'
import type { AgentProbeResult } from './features.ts'
import type { SessionConfigOption, TaskMode } from './sessions.ts'

/** How a person logs in to a harness: its own command, in a terminal. */
export interface HarnessLogin {
  /** What to run, as a person would type it. */
  command: string
  /** What to do once it opens, for a program that logs in from inside. */
  note?: string
  /** The Host can ask the program whether it is logged in. Absent: it finds out only when a session is refused. */
  checkable?: true
}

/** Only a clear answer from the program is `unauthenticated`; everything else is `unknown`, which no client treats as logged out. */
export type HarnessLoginStatus = 'authenticated' | 'unauthenticated' | 'unknown'

/** The built-in harness's name. Reserved: no other harness is shown under it. */
export const BUILTIN_HARNESS_LABEL = 'Latch 内置'

/** The wire protocols a model service can speak. */
export type ModelWire = 'chat-completions' | 'responses' | 'anthropic-messages' | 'gemini'

/**
 * What a harness really does, read by clients instead of asking what kind of driver it is. A driver declares these; the
 * Host fills what it left out with the weakest value and lowers what it cannot vouch for, so a client can state them as
 * facts. A fact a client states about safety (`permission.enforcement`, `tools.shell`, `display`) never rests on the
 * driver's word alone.
 */
export interface HarnessCapabilities {
  models: {
    /** `latch`: the Host's model services. `harness`: the harness's own login and configuration. */
    owner: 'latch' | 'harness'
    /** How the choices are known before a session starts. `none`: they are not. */
    catalogue: 'live' | 'session-check' | 'none'
    /** Protocols the harness can reach a model service over. Empty: Latch cannot route it to one. */
    wires: ModelWire[]
  }
  permission: {
    /** Who decides whether a tool call runs. Only the built-in harness can be `latch`. */
    enforcement: 'latch' | 'harness' | 'none'
    /** A rejection's note reaches the model. */
    rejectionNote: boolean
  }
  tools: {
    /** It can run commands. False only where Latch knows it cannot, so nothing unverified reads as safer than it is. */
    shell: boolean
    /** A project file named in a message reaches it. */
    fileMentions: boolean
  }
  display: {
    /** Never a built-in harness's name unless it is one. */
    label: string
    /** A key of the client's fixed set of icons, not a URL or an image. Absent: the neutral agent glyph. */
    mark?: string
  }
}

/**
 * What a harness offered when a session of its current definition last started: model, thinking, mode and its other
 * options, in the shape of a session's `config`, so a draft chooses from the same list a session does. The mode's current
 * value is the one a new session starts in. A start applies a choice only if the agent offers it again.
 */
export interface HarnessCatalogue {
  options: SessionConfigOption[]
  /** Options that follow the model, such as thinking, as a session running on that model reported them. */
  perModel: Array<{ model: string; options: SessionConfigOption[] }>
  /** When they were reported. */
  reportedAt: string
  /** `session`: a real session started with them. `check`: Latch read them without running a turn; see `CatalogueRead`. */
  source: 'session' | 'check'
}

/**
 * Reading what a harness offers before a session: an empty session in a private folder that never receives a prompt, or
 * the harness's own model list where it has one. Never on a timer.
 */
export interface CatalogueRead {
  /** `select`: a draft that selects the harness while it has no list reads it once by itself. `request`: only when asked. */
  when: 'select' | 'request'
  running?: true
  /** The last read of the current definition. Absent: none, so a `select` harness reads on its next selection. */
  last?: { at: string; ok: boolean; message?: string }
}

export interface HarnessInfo {
  /** What it really does; see `HarnessCapabilities`. */
  capabilities: HarnessCapabilities
  /** How an agent's instructions and memories reach this engine. Absent: they cannot, so no agent can run on it. */
  agentContext?: 'private' | 'first-turn'
  /** How an agent's skills reach it: loaded natively, or fetched from a read-only server. Absent: they do not. */
  skills?: 'native' | 'server'
  attachments?: { images?: boolean; text?: boolean; textBytes?: number }
  id: string
  description?: string
  /** `ready` can start sessions; `unavailable` explains why in `statusMessage`. */
  status: 'ready' | 'unavailable'
  statusMessage?: string
  /** Session modes the harness accepts. */
  modes: TaskMode[]
  /** L1: Latch decides each risky call. L3: unsandboxed. Always the Host's derivation, never a driver's word. */
  level: 'L1' | 'L3'
  /** Its command and environment are a saved definition that settings can open. */
  editable?: true
  /**
   * Which folders of a project the harness receives. `all`: every folder (at most `max`); `primary`: the primary folder
   * only; `primary-asks`: the primary folder, and it asks before using others; `primary-unbounded`: the primary folder,
   * and it does not limit which directories it reads. Absent: `primary`.
   */
  projectFolders?: { access: ProjectFolderAccess; max?: number }
  /**
   * Display only, known before a session starts: whether the harness asks before it acts, whether Latch can read its
   * mode back, and the modes in which it never asks. Absent: Latch has no profile for it and learns this only after it
   * starts.
   */
  permission?: { approvals: 'prompts' | 'none'; readback: 'mode' | 'none'; neverAskModes?: string[] }
  /** Absent: no session or read has told Latch what it offers, or its definition changed since. */
  catalogue?: HarnessCatalogue
  /** Absent: what it offers is known only once a session starts. */
  catalogueRead?: CatalogueRead
  /** Model IDs a person typed for this harness, offered with its own models; a session sends one even when not listed. */
  customModels?: string[]
  /** Absent: Latch knows no login command for it. */
  login?: HarnessLogin
  /**
   * A preset whose commands are on this computer and that has no saved definition yet: it can be chosen like any other,
   * and the first session saves the definition. Only a device that may save one receives these.
   */
  offer?: { presetId: string }
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
  /** Display only, see `AgentPreset.agentCommand`. */
  agent?: { command: string; found: boolean }
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
