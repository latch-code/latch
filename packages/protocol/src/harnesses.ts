import type { AgentPreset, HelperCard } from './agent-presets.ts'
import type { HarnessExtensionSupport } from './extensions.ts'
import type { AgentProbeResult } from './features.ts'
import type { HarnessOwnMcp } from './mcp.ts'
import type { HarnessQuota, HarnessQuotaRead } from './quota.ts'
import type { ModeGlyph, ModeTier, SessionCommand, SessionConfigOption, SessionSkill, TaskMode } from './sessions.ts'

/** How a person logs in to a harness: its own program, in a terminal on the computer that runs it. */
export interface HarnessLogin {
  /** The preset's login command, as a person would type it, when the harness advertised no login of its own. */
  command?: string
  /** What to do: once `command` opens, for a program that logs in from inside; without one, how to sign in at all. */
  note?: string
  /** The Host can ask the program whether it is logged in. Absent: it finds out only when a session is refused. */
  checkable?: true
  /** The logins the harness itself advertised, each its own program run in a terminal; `command` as a person would type it. */
  methods?: Array<{ id: string; name: string; description?: string; command: string }>
  /** The harness logs out when asked, so a person can sign in with another account. */
  logout?: true
  /** What a running process of the harness last said: whether it holds a credential, and its own name for which kind. */
  reported?: { status: HarnessLoginStatus; label?: string }
}

/** Only a clear answer from the program is `unauthenticated`; everything else is `unknown`, which no client treats as logged out. */
export type HarnessLoginStatus = 'authenticated' | 'unauthenticated' | 'unknown'

/** One answer to `login-status`. `label`: the harness's name for the kind of credential. `expiresAt`: when a stored login ends. */
export interface HarnessLoginCheck {
  status: HarnessLoginStatus
  label?: string
  expiresAt?: string
}

const samePush = (a: HarnessLogin['reported'], b: HarnessLogin['reported']) => a?.status === b?.status && a?.label === b?.label

/**
 * One answer from a check and a running process's push, the newer clear one deciding. `pushedThen`: the push known when
 * the check was made; a push that differs from it came later. Otherwise the check's verdict stands, since an idle harness
 * may not notice a login or logout made in another terminal until its next turn. The label comes from the push and the
 * date from the check, each only when the answer and its own source both say logged in.
 */
export function settleLogin(
  check: HarnessLoginCheck,
  pushedThen: HarnessLogin['reported'],
  pushedNow: HarnessLogin['reported'],
): HarnessLoginCheck {
  const pushWins =
    pushedNow !== undefined && pushedNow.status !== 'unknown' && (check.status === 'unknown' || !samePush(pushedThen, pushedNow))
  const status = pushWins ? pushedNow.status : check.status
  if (status !== 'authenticated') return { status }
  const label = (pushWins || !check.label) && pushedNow?.status === 'authenticated' ? pushedNow.label : check.label
  const expiresAt = check.status === 'authenticated' ? check.expiresAt : undefined
  return { status, ...(label ? { label } : {}), ...(expiresAt ? { expiresAt } : {}) }
}

/** The built-in harness's name. Reserved: no other harness is shown under it. */
export const BUILTIN_HARNESS_LABEL = 'Latch 内置'

/** The wire protocols a model service can speak. */
export const MODEL_WIRES = ['chat-completions', 'responses', 'anthropic-messages'] as const
export type ModelWire = (typeof MODEL_WIRES)[number]

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
    /**
     * Protocols over which Latch can forward this harness's requests to a model service (`pairRoute`). Empty: Latch
     * cannot route it to one.
     */
    wires: ModelWire[]
    /** Forwarding works for this harness but has not been proven in real use yet; clients say so. */
    experimental?: true
    /**
     * Through Latch it uses only those of a service's models it knows itself, as its own model list names them
     * (`modelIdKey`); a client offers no others.
     */
    knownOnly?: true
    /**
     * Through Latch, commands the harness runs inherit the session's gateway credential: it has no switch that keeps
     * its environment from them. Clients say so beside 经 Latch. The credential is not a service's key.
     */
    credentialInherited?: true
    /**
     * Latch does not forward this harness's requests to a model service and is not going to: it uses its own login and
     * models (a vendor's agent reached through its own route, or a command Latch knows nothing of). Clients say so
     * instead of calling the forwarding unfinished.
     */
    ownOnly?: true
    /**
     * It reports thinking levels for every model that has them, so a model it reports none for has none, rather than
     * leaving them to its own defaults.
     */
    thinkingPerModel?: true
    /** This CLI encodes thinking variants in its model IDs, rather than a separate setting. */
    thinkingInModel?: true
    /**
     * On a model of a service, its thinking is the service's declared levels and 默认 sends none, so the service's own
     * default applies (Codex's own wire, through the gateway's `setThinking`). Absent: what 默认 sends is the harness's.
     */
    serviceThinking?: true
    /**
     * A running session can move to a model of another service, or between a service and the harness's own login, by
     * choosing it in its model menu (`ownChoice`, `serviceChoice`): Latch restarts the idle agent on the new route and
     * resumes the same session (Codex: carries its thread onto the new provider as a fork with the same history).
     * `services`: only between services, since the harness keeps a session where it began (Grok keeps a routed session
     * in a private home).
     * Absent: a session stays on the route it started on.
     */
    routeSwitch?: 'any' | 'services'
    /**
     * Its own program reports its subscription's limits (`HarnessInfo.quota`): asked when someone looks, or as its turns
     * run (`HarnessInfo.quotaRead`). Absent: it never does, and a client says so rather than waiting for them.
     */
    quota?: true
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
  /**
   * `native`: a fork of one of its own sessions into a new one of it, in the same folder, carries the harness's own
   * record of the source up to that turn; where it cannot, the Host's text record does. Absent: always the text record.
   */
  fork?: 'native'
}

/**
 * A draft's pick from `HarnessInfo.permission.modes`, kept among its picks under this ID. Agents' option IDs never start
 * with `~`; a start sets it as the mode the agent reports, whatever that option is called.
 */
export const LADDER_MODE = '~mode'

/** Public suggestions reported by an earlier real session; never current capability or permission evidence. */
export interface HarnessCommandCatalogue {
  commands: SessionCommand[]
  skills?: SessionSkill[]
  skillsTruncated?: true
  reportedAt: string
  source: 'previous-session'
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
 * What a draft that picks one model of a saved service offers before it starts: the options that follow the model, such
 * as thinking, in the shape a session on that model reports them, with the same IDs and values. `declared`: Latch derives
 * them from the levels the service declared, exactly as the session will offer them. `session`: a session on that model
 * through Latch reported them, while the service's declaration is still the one it ran with.
 */
export interface ServiceModelOptions {
  providerId: string
  model: string
  options: SessionConfigOption[]
  source: 'declared' | 'session'
}

/**
 * Reading what a harness offers before a session: an empty session in a private folder that never receives a prompt, or
 * the harness's own model list where it has one. Never on a timer.
 */
export interface CatalogueRead {
  /** `select`: a draft that selects the harness while it has no list reads it once by itself. `request`: only when asked. */
  when: 'select' | 'request'
  /**
   * The read reports the modes a session starts with, so a draft can offer them. False: it lists models only, and the
   * modes come with the first session.
   */
  modes: boolean
  running?: true
  /** The last read of the current definition. Absent: none, so a `select` harness reads on its next selection. */
  last?: {
    at: string
    ok: boolean
    message?: string
    /** It failed because the harness refused for want of a login, by the harness's own error code, not by its words. */
    loginRequired?: true
  }
}

export interface HarnessInfo {
  /** What it really does; see `HarnessCapabilities`. */
  capabilities: HarnessCapabilities
  /** The same public preset card on every client; availability and actual capabilities still filter its abilities. */
  helperCard?: HelperCard
  /** How an agent's instructions and memories reach this engine. Absent: they cannot, so no agent can run on it. */
  agentContext?: 'private' | 'first-turn'
  /** How an agent's skills reach it: loaded natively, or fetched from a read-only server. Absent: they do not. */
  skills?: 'native' | 'server'
  attachments?: { images?: boolean; text?: boolean; textBytes?: number }
  /**
   * What an agent said it takes in a prompt when it last started for its current definition: a session, a read before
   * one, or 测试启动. Absent: it has not started since, so whether it takes attachments is not known.
   */
  attachmentsReported?: { images: boolean; text: boolean }
  id: string
  description?: string
  /** `ready` can start sessions; `unavailable` explains why in `statusMessage`. */
  status: 'ready' | 'unavailable'
  statusMessage?: string
  /**
   * Why it is `unavailable`, when a client says it differently: `outdated`, its command is known to be older than Latch
   * supports (from a read of its version), so it is listed greyed with 需要升级 and `statusMessage` names the upgrade.
   */
  statusReason?: 'outdated'
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
   * mode back, and Latch's word for each of its modes. Absent: Latch has no profile for it and learns this only after it
   * starts.
   */
  permission?: {
    approvals: 'prompts' | 'none'
    readback: 'mode' | 'none'
    modeTiers?: Record<string, ModeTier>
    /** Display only: a glyph for a mode from what the harness documents it does, as `SessionPermission.modeGlyphs`. */
    modeGlyphs?: Record<string, ModeGlyph>
    /**
     * The modes Latch knows this harness has, strictest first, and the one a session starts in: a draft may choose one
     * before anything is read, as `LADDER_MODE`. A start the agent then does not offer it to fails before sending.
     */
    modes?: string[]
    startMode?: string
  }
  /** Absent: no session or read has told Latch what it offers, or its definition changed since. */
  catalogue?: HarnessCatalogue
  /** For models of saved services this harness can use through Latch; see `ServiceModelOptions`. Absent: none known. */
  serviceOptions?: ServiceModelOptions[]
  /** Absent: what it offers is known only once a session starts. */
  catalogueRead?: CatalogueRead
  /** A read-only previous-session command cache exists. Generation changes when its Host driver is replaced. */
  commandCatalogue?: { generation: string }
  /** Extension reports available from this mounted adapter, including when a plugin list is unavailable. */
  extensionSupport?: HarnessExtensionSupport
  /** Model IDs a person typed for this harness, offered with its own models; a session sends one even when not listed. */
  customModels?: string[]
  /**
   * Its own MCP servers, as it reports them over its protocol (Codex's app-server), with 读取 to ask again. Absent: it
   * does not report them, so Latch cannot say which it has.
   */
  ownMcp?: HarnessOwnMcp
  /** Absent: Latch knows no login command for it. */
  login?: HarnessLogin
  /**
   * What its own program last said about the subscription it is logged in to (docs/HARNESSES.md#额度). Kept in memory
   * only. Absent: it has said nothing that still holds, or it never does; a client then draws no limit beside it, and says
   * so in one line where it lists every Harness's limits.
   */
  quota?: HarnessQuota
  /** Reads of `quota` made when someone looks, for a harness that reports limits. Absent: none ran or failed. */
  quotaRead?: HarnessQuotaRead
  /**
   * 接入已有会话 (docs/HARNESSES.md#接入已有会话). `list`: it lists and brings in its own earlier sessions. `rebuild`: a
   * session brought in from another harness can be rebuilt as text on it. Absent: neither.
   */
  history?: { list?: true; rebuild?: true }
  /**
   * A preset whose commands are on this computer and that has no saved definition yet: it can be chosen like any other,
   * and the first session saves the definition. Only a device that may save one receives these.
   */
  offer?: { presetId: string }
  /**
   * The program its definition is bound to: `path` only for a device that may save definitions; `id`, a digest of it,
   * for every device, so what was said once about this program is said again when it is bound to another.
   */
  bound?: { id: string; path?: string }
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
  /**
   * The path the command resolved to when this Mac confirmed the definition (`harness.command.apply`). While set, the
   * Harness does not start once the command resolves elsewhere, until it is confirmed again. Absent on definitions saved
   * before confirmations, which start as before.
   */
  confirmedCommand?: string
  /**
   * What this definition was before the Host moved it from a preset's adapter to the preset's own program (Claude,
   * OpenCode): a session confirmed on exactly that earlier definition continues on this one.
   */
  migratedFrom?: { command: string; args: string[]; confirmedCommand?: string }
  /** The person saved or changed what runs after the presets had their own programs: the Host never moves it. */
  routeKept?: true
}

/** Result of resolving a command on the Host's PATH and install directories. */
export interface CommandDetection {
  found: boolean
  path?: string
  /** Display only, see `AgentPreset.agentCommand`. */
  agent?: { command: string; found: boolean }
  /** The command is here but older than Latch supports: what it needs, and the command that upgrades it. Older Hosts omit it. */
  outdated?: { need: string; upgrade: string }
  /** It has a version it must reach and nothing has read that yet (a preset is read once it is confirmed). */
  versionUnread?: true
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
