import type { ModeGlyph, ModeTier, ModelCapabilities, ModelWire, SessionConfigOption } from '@latch/protocol'
import type { ModelRoute } from '@latch/sdk'
import type { QuotaReport } from '../quota.ts'
import type { TurnTokens } from '../protocol.ts'
import type { ReleaseLookup } from '../update-command.ts'
import type { WireKind } from '../wires/index.ts'

/**
 * How Latch drives one harness's own permission settings. Host-only: none of this reaches the browser except the
 * display fields copied into `SessionPermission` and `HarnessInfo.permission`. A profile narrows what the harness does by default; it is not an OS
 * sandbox, so every ACP session stays full access (L3).
 */
export interface AcpPermissionProfile {
  /** Whether the harness asks before running tools at all. */
  approvals: 'prompts' | 'none'
  /** Applied after the definition's own variables, so a definition cannot override them. */
  defaultEnv: Record<string, string>
  /** Mode the session must report before every prompt. */
  expectedMode?: string
  /** Strictest → widest. Modes outside the ladder count as wider. */
  modeLadder?: readonly string[]
  /**
   * Latch's word for each mode in the ladder and one line on what the harness really does there, at most one mode per
   * tier. Display only: clients order and title the menu by it, and a mode left out shows under the harness's own name.
   */
  modeTiers?: Readonly<Record<string, ModeTier>>
  /** Display only: what the harness documents a mode does, for its glyph (`SessionPermission.modeGlyphs`). */
  modeGlyphs?: Readonly<Record<string, ModeGlyph>>
  /**
   * The harness reports its own model reviewing a request as a tool call whose ID starts with this. Each verdict is
   * recorded on its own, so its other calls in a `model` tier mode are not recorded as run unasked.
   */
  reviewCallPrefix?: string
  /** Permission option IDs never shown; exact IDs, or prefixes ending in '*'. */
  hiddenOptionIds?: readonly string[]
  /**
   * Answers to an ask that move the harness to another mode, because the person chose that (leaving a plan, say). Matched
   * by option ID, and by the asked call's kind when the harness reuses a plain option ID. Latch records the mode as the
   * person's choice before the answer reaches the harness, so the switch that follows is not taken as the agent widening
   * its own mode. Only modes in `modeLadder`.
   */
  modeAnswers?: ReadonlyArray<{ optionId: string; toolKind?: string; mode: string }>
  /** Whether the harness reports its mode so Latch can read it back. */
  readback: 'mode' | 'none'
  /** `pattern` is a RegExp source tested against `initialize.agentInfo.version`. */
  versionRule?: { pattern: string; message: string }
  /**
   * Definition variables that change where the harness reads configuration Latch cannot override: exact names, or
   * prefixes ending in '*', compared case-insensitively. A definition that sets one is not verified.
   */
  configEnv?: readonly string[]
  /**
   * Variables taken from the person's environment when set: where this harness keeps its own home. Names only reach the
   * launch fingerprint, and none may hold a secret (`test/login.test.ts`). A definition cannot set the reserved ones.
   */
  inheritEnv?: readonly string[]
  /** Variable for the adapter to `command`, set to the path found on this computer; left out when it is not installed. */
  programEnv?: Readonly<Record<string, string>>
  /** Chinese display notes. */
  notes: string[]
}

/** One `session/update` as the agent sent it: `sessionUpdate` names the kind, the rest is untrusted. */
export type SessionUpdate = { sessionUpdate: string } & Record<string, unknown>

/** An ask put to the person like a permission request: one-time options only, read the same way. */
interface ExtensionAsk {
  toolCall: { toolCallId: string; title: string; name?: string; kind?: string; rawInput?: unknown }
  options: Array<{ optionId: string; name: string; kind: 'allow_once' | 'reject_once' }>
}

/**
 * A request a harness sends outside ACP. `ask`: put to the person as an approval in the session, and `answer` turns the
 * chosen option (undefined when nobody chose, as on a stop) into the harness's own reply. `decline`: answered at once,
 * with a line in the session that says what it asked. Either returns undefined for params it cannot read, which then
 * get the usual reply to an unknown request.
 */
export type ExtensionRequest =
  | { readonly ask: (params: unknown) => ExtensionAsk | undefined; readonly answer: (optionId: string | undefined) => unknown }
  | {
      /** `rejected`: the request was an ask for the person, so it is also recorded as automatically refused. */
      readonly decline: (params: unknown, agentName: string) => { note: string; reply: unknown; rejected?: true } | undefined
    }

/**
 * What a harness sends outside ACP. A notification is rewritten into the `session/update` it means, for the session the
 * process runs (these carry no session ID); undefined drops it, as an unknown notification is.
 */
interface HarnessExtensions {
  readonly requests?: Readonly<Record<string, ExtensionRequest>>
  readonly notifications?: Readonly<Record<string, (params: unknown, sessionKey: string) => SessionUpdate | undefined>>
}

/**
 * A chunk in which the harness reports retrying a model call, rather than the model writing. `attempt`: it waits and
 * asks the service again. `interrupted`: the reply broke off and is being generated again. `restart`: the first text of
 * the reply generated again.
 */
export type RetryReport = { kind: 'attempt'; attempt: number; of: number; reason: string } | { kind: 'interrupted' } | { kind: 'restart' }

/**
 * A call the harness says it refused itself before it ran, without asking: its model reviewed it (`model`) or its own rules
 * or modes did (`rule`). `reason`: the harness's own words for why, untrusted.
 */
export interface ToolDenial {
  source: 'model' | 'rule'
  reason?: string
}

/** A subagent as a harness marks the work it sends on another session. `parentSessionId`: the session that started it. */
export interface ProjectedChild {
  sessionId: string
  parentSessionId: string
  title?: string
}

export type LoginStatus = 'authenticated' | 'unauthenticated' | 'unknown'

/** A status command's verdict. `expiresAt`: when a stored login ends, as an ISO date, where the program says. */
export interface LoginCheck {
  status: LoginStatus
  expiresAt?: string
}

/** How a profile fingerprints particular project files. */
export interface ProjectConfigManaged {
  /** Paths relative to the directory holding the entry (`.opencode/node_modules`), left out with everything below them. */
  skip?: readonly string[]
  /** Files compared after `reduce` removes what the harness adds; `undefined` leaves the file out. */
  reduce?: Readonly<Record<string, (text: string) => unknown>>
  /** Files relative to a project folder, compared only by identity, size and times, with no content read. */
  metadata?: readonly string[]
}

/**
 * How the harness receives the folders of a project besides the session directory. `acp`: the ACP
 * `additionalDirectories` field of session/new, session/load and session/resume, only when the agent advertises it.
 * `args`: `flag <real path>` once per folder after the definition's arguments, at most `maxExtra` folders.
 */
type ProfileFolders =
  | {
      readonly via: 'acp'
      /** Configuration the harness loads from every folder it receives, fingerprinted with `projectConfigPaths`. */
      readonly configPaths: readonly string[]
    }
  | { readonly via: 'args'; readonly flag: '--include-directories'; readonly maxExtra: number }

/** Where a launch puts what points the harness at the Host's gateway: the gateway's address, and its private files. */
export interface GatewayPlace {
  /** The base URL of the route's protocol on the Host's loopback gateway. */
  baseURL: string
  /** The selected per-session launch setting, when the profile implements one. */
  thinking?: { model: string; value: string }
  /** The service's model IDs and the owner's declared capabilities, without prices or inferred limits. */
  models: ReadonlyArray<{ id: string; capabilities?: ModelCapabilities }>
  /** Explicit adapter operating bounds; these are not claimed model capacities. */
  budget?: { contextTokens: number; outputTokens: number }
  /** The path a file of `files` is written to, in the session's private directory. */
  file(name: string): string
}

/** What one launch of a session on a route gets, besides the token. None of it may hold the token. */
export interface GatewayLaunch {
  /** Variables, by the names `envNames` lists: addresses and paths. */
  env?: Record<string, string>
  /** Arguments after the definition's: addresses, paths and variable names only. */
  args?: string[]
  /** File name to content: written 0600 and replaced by rename before every spawn; names variables, never holds a value. */
  files?: Record<string, string>
  /** Public model settings for ACP session creation/restoration; never a token or another credential. */
  sessionMeta?: Record<string, unknown>
}

/** The exact value a routed model has in this harness's native configuration, not a suffix or display-name match. */
export interface GatewayModelValues {
  value(id: string, wire?: ModelWire): string
  id(value: string, wire?: ModelWire): string | undefined
  /** A service model needs native runtime metadata before it can be offered inside the session. */
  readonly reportedOnly?: true
}

/**
 * How the harness is pointed at the Host's gateway for a session on a model service, so that it sends that service's
 * protocol to Latch with a token instead of using its own login. `providers`: ACP `providers/set`, the token in a header,
 * only when the agent advertises `providers` and lists this provider ID with this API type (codex-acp only). `launch`:
 * one delivery at spawn: variables, an argument template and private files, written by `deliver`; the token goes in
 * the environment only, as `tokenEnv`, set by the runtime and never seen by `deliver`.
 */
type ProfileGateway = {
  /** The protocols it speaks to a model service, as `HarnessCapabilities.models.wires`. */
  readonly wires: readonly ModelWire[]
  /** Not yet proven in real use; clients say so. */
  readonly experimental?: true
  /** It uses only the service's models it knows itself, as `HarnessCapabilities.models.knownOnly`. */
  readonly knownOnly?: true
  /**
   * The harness has no documented way to keep the token's variable from the commands it runs, as
   * `HarnessCapabilities.models.credentialInherited`. Display only: nothing that runs changes.
   */
  readonly credentialInherited?: true
  /**
   * A session stays with where it began: on a service, it can move only to another service; on the harness's own login,
   * never onto one (`HarnessCapabilities.models.routeSwitch: 'services'`). Absent: a session can move either way.
   */
  readonly sessionBoundToRoute?: true
  /** A routed session's record lives in the session's private directory and goes with it: nothing is started to delete it. */
  readonly recordInPrivateHome?: true
  /**
   * A session moves between the harness's own login and a service only as a new session of the agent's with the same
   * history (`CARRY_METHOD`), since it resumes one only on the provider it began on (Codex).
   */
  readonly carriesAcrossLogin?: true
  /**
   * The oldest version of the preset's own command that works through the gateway, read the way `minimumVersion` is; a
   * session on a route refuses to start with an older one.
   */
  readonly minimumVersion?: NonNullable<HarnessProfile['minimumVersion']>
  /** The protocol app reports a separate internal version, so only the installed CLI can prove this minimum. */
  readonly commandVersionOnly?: true
  /** This harness guesses model capacity and price on custom routes; retain only its reported context token count. */
  readonly usage?: 'tokens-only'
} & (
  | { readonly via: 'providers'; readonly providerId: string; readonly apiType: string }
  | {
      readonly via: 'launch'
      /**
       * The variable that carries the token: `LMG_TOKEN` wherever the harness lets Latch name it, else the one the
       * harness reads. Never `LATCH_*`, which every agent environment drops.
       */
      readonly tokenEnv: string
      /**
       * For a harness whose provider fixes the variable its key is read from, so the name follows the route's protocol
       * (goose reads `ANTHROPIC_API_KEY` for Anthropic's); a protocol not listed uses `tokenEnv`.
       */
      readonly tokenEnvByWire?: Readonly<Partial<Record<ModelWire, string>>>
      /**
       * Options of the harness's own a session on a route never offers and never sets: one that would move the session
       * to another service the person configured in the harness (goose's `provider`). Exact option IDs.
       */
      readonly hiddenConfig?: readonly string[]
      /** The other variables `deliver` sets, for the launch fingerprint and preview; values never enter either. */
      readonly envNames: readonly string[]
      /** Versions of what `deliver` puts in the arguments and the files, in the launch fingerprint; bump on a change. */
      readonly templates: { readonly args?: number; readonly files?: number; readonly session?: number }
      /** When present, apply and read back this native model value before the first prompt. */
      readonly models?: GatewayModelValues
      /**
       * Its thinking value for 「no level of mine」 (Claude Agent's `default`). Present, the gateway decides what thinking
       * a route offers where it converts the level (`gatewayThinkingLevels`): this value and the declared levels, and
       * this value sends none. Absent, the harness's own list stands.
       */
      readonly defaultThinking?: string
      /** A verified serializer restriction; false removes the control and refuses retained non-default choices. */
      thinkingAllowed?(model: string, wire: ModelWire, level?: string): boolean
      runtimeBudget?(environment: Readonly<Record<string, string>>): GatewayPlace['budget']
      /** Recognizes only a fixed diagnostic marker from the profile's own extension, never forwards arbitrary stderr. */
      startupFailure?(stderr: string): string | undefined
      /**
       * A file `deliver` points the harness at, made from what the harness's own program prints before a launch (no
       * prompt, no session, its arguments hold no secret). `build` gets the standard output of `read`; the file is kept
       * only if the program then exits 0 on `check`, so one a later version no longer reads is left out, not launched.
       */
      readonly catalog?: {
        readonly file: string
        readonly read: { readonly args: readonly string[]; readonly timeoutMs: number; readonly maxOutput: number }
        build(stdout: string, place: GatewayPlace, route: ModelRoute): string | undefined
        check(path: string): readonly string[]
      }
      /** `catalog`: the path of the profile's catalog file, when one was built and accepted for this launch. */
      deliver(place: GatewayPlace, route: ModelRoute, catalog?: string): GatewayLaunch
    }
)

/** What bringing in this harness's sessions depends on, beyond the agent advertising `session/list` and `session/load`. */
export interface HistoryImportRule {
  /**
   * A RegExp source over `initialize.agentInfo.version`: the versions whose listing and replay were read in its source.
   * Absent: Latch's own wire lists and replays, through the SDK version Latch pins (Claude's direct wire).
   */
  readonly version?: string
  /**
   * Its `session/load` stores the `additionalDirectories` it is given as the session's own grants, so loading a session
   * that has some without the same list would rewrite it (OpenCode 2.x). Such a session is not listed, and its row is
   * read again on the loading process, where one that has grants, or is no longer listed, is not loaded.
   */
  readonly grants?: 'refuse'
  /**
   * It keeps no writer lock and reports no session as in use (OpenCode's server takes several clients), so a load that
   * succeeds does not show the session is open nowhere else; a preview says so.
   */
  readonly useUnknown?: true
  /**
   * Its `session/delete` deletes the agent's own record of a session. The person may then choose, per deletion, to delete
   * an imported session's original with it (off by default); the Host audits that choice first.
   */
  readonly deletes?: true
}

/** A command of the harness's own program that prints its limits and exits: no prompt, no model turn, no session. */
export interface QuotaCommand {
  /** After the preset's command. Never a secret: arguments are visible to every process of this person. */
  readonly args: readonly string[]
  /** Set for this run only, over the harness's environment. */
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs: number
  /** Standard output of a run that exited 0. Anything but the exact shape it knows is undefined. */
  read(stdout: string, now: number): QuotaReport | undefined
}

interface ProfileQuota {
  /** Reads a `usage_update` as the agent sent it. */
  update?(update: SessionUpdate, now: number): QuotaReport | undefined
  /** Reads the `data` of the error a failed turn ended with. */
  error?(data: unknown, now: number): QuotaReport | undefined
  /** An extension request the agent answers without a turn, sent on a process that runs a session. */
  readonly request?: {
    readonly method: string
    /** `null`: the agent answered that no plan limits apply to this login (an API key, say); undefined: no answer. */
    read(result: unknown, now: number): QuotaReport | null | undefined
    /**
     * Asked only on a session's process (as it opens and as a turn ends), never for someone looking: an answer this
     * harness may not give (an experimental request) then changes nothing anyone sees.
     */
    readonly openOnly?: true
  }
  readonly command?: QuotaCommand
}

/**
 * Where a preset's own program is published (`update-command.ts`). The install's real path picks the source: a Homebrew
 * formula or cask named in `brew` is asked of Homebrew, a global copy of `npm` (or any other layout) of npm. `native`
 * recognises the program's own installer layout and names the command that updates it; `release`, where that command
 * looks for the release it installs, when that is not npm. `channel`: the Host reads which npm dist-tag the program
 * follows from its own settings (`claude`: `autoUpdatesChannel`).
 */
export interface ReleaseSource {
  readonly npm?: string
  readonly brew?: readonly string[]
  readonly native?: { readonly matches: (file: string) => boolean; readonly command: string; readonly release?: ReleaseLookup }
  readonly channel?: 'claude'
}

export interface HarnessProfile {
  /** Equals `AgentPreset.id`. */
  readonly presetId: string
  /** Part of the launch fingerprint; bump it when the profile's behaviour changes. */
  readonly version: number
  /** A process-level mode. An official service may report it, or a launch flag augments the ACP-reported mode. */
  readonly processMode?: {
    /** Only entering or leaving this mode needs a new process. All other choices use native ACP mode changes. */
    readonly only?: string
    prepare(directory: string, mode?: string, consultationExecution?: string): Promise<{ args: string[]; env: Record<string, string> }>
    read?(method: string, params: unknown): { sessionId: string; mode: string } | undefined
    /** A launch flag that ACP cannot report; a restart cannot independently verify the old flag. */
    readonly unread?: true
    fromMode?(option: SessionConfigOption, launchMode: string | undefined): SessionConfigOption
    agentMode?(mode: string): string
  }
  /** The protocol the harness speaks. Absent: ACP. */
  readonly wire?: WireKind
  /**
   * Whether a value the agent reports for `configId` is the one asked for though written differently (OpenCode 1.4 to
   * 1.14 reads a model back with its level appended). 核对 counts only such a match, or the same value, as applied.
   */
  configValueMatches?(configId: string, asked: string, reported: string): boolean
  readonly permission: AcpPermissionProfile
  /**
   * Set: the driver takes every folder of a project and passes the others this way; the folders it passes are part of
   * the launch fingerprint, so sessions of one folder are unaffected. Absent: sessions get the session directory only.
   */
  readonly folders?: ProfileFolders
  /** What clients are told about the folders a harness without `folders` never receives. Absent: `primary`. */
  readonly folderAccess?: 'primary' | 'primary-asks' | 'primary-unbounded'
  /**
   * Files or directories the harness loads as configuration when it finds them in the session directory or a
   * directory above it. Their contents are part of the launch fingerprint; a directory counts with everything below it.
   */
  readonly projectConfigPaths?: readonly string[]
  readonly projectConfigManaged?: ProjectConfigManaged
  /**
   * The Host may bring in this harness's own earlier sessions (`session/list`, `session/load`), once its adapter's
   * listing and replay were checked against its source (docs/HARNESSES.md#接入已有会话). A rule adds what that check
   * found the import to depend on.
   */
  readonly historyImport?: true | HistoryImportRule
  /**
   * Its `session/load` goes on by itself with a turn that stopped on a tool confirmation, a turn nobody sent in this
   * session (goose: it asks again, or applies an answer it holds, then calls the model). A session is opened again only
   * when the Host's read of the harness's own record says nothing is left to go on with
   * (`AcpAgentOptions.storeAccess.resumeState`); without that read it is not opened again.
   */
  readonly loadResumesTurn?: true
  /**
   * The harness keeps its subagents' sessions as sessions of their own that deleting the parent leaves; the Host reads
   * them from its record (`storeAccess.childSessions`) and they are deleted with it (goose).
   */
  readonly childSessionsInRecord?: true
  /**
   * The harness has no way to delete a session, so the Host removes its record of the sessions Latch opened itself
   * (`storeAccess.removeSession`), after the process is gone (DeepSeek Harness).
   */
  readonly removesOwnSessions?: true
  /** Its own delete request (`deleteMethod`) also takes the folder the session was opened in (Qwen Code's `deleteSession`). */
  readonly deleteWithFolder?: true
  /**
   * The harness keeps the MCP servers a session was given in its own record, so resuming it outside Latch would start
   * Latch's. Before a process stops gracefully, each server Latch gave a session is removed with this request.
   */
  readonly mcpRemoval?: { readonly method: string; params(sessionId: string, name: string): unknown }
  /**
   * The installed program may run another version it downloaded itself; the Host's digest of that
   * (`storeAccess.launchCode`) is part of the definition's fingerprint, as the program's path is (Qwen Code).
   */
  readonly selfUpdates?: true
  /**
   * A command that says whether the harness is logged in, without a prompt or a session. Only a clear answer is an answer:
   * `read` returns `unknown` for anything else. The output never leaves `read`, since it may hold an account or part of a key.
   */
  readonly loginStatus?: {
    /**
     * `adapter`: the preset's own command runs it, for a harness whose login Latch does not offer. Otherwise the program
     * `AgentPreset.login` runs.
     */
    readonly program?: 'adapter'
    /** It says when a stored login ends, which nothing the harness pushes does; so it runs even then. */
    readonly expires?: true
    /** After that program, or the adapter's own with `bundledArgs`. */
    readonly args: readonly string[]
    readonly bundledArgs?: readonly string[]
    read(result: { code: number | null; output: string }): LoginStatus | LoginCheck
  }
  /**
   * For an adapter that drives a program the person installed (`AgentPreset.agentCommand`): how a launch test reads that
   * program's version, beside the adapter's own, by the rules `loginStatus` follows. `checked`: the pairs, as RegExp
   * sources over the adapter's `agentInfo.version` and the program's, that the adapter was built for; a page warns about
   * any other pair and never refuses it.
   */
  readonly programVersion?: {
    readonly args: readonly string[]
    read(output: string): string | undefined
    readonly checked: ReadonlyArray<{ readonly adapter: string; readonly program: string }>
  }
  /**
   * The oldest version of the preset's own command this profile works with, read by running the command with `args`
   * (no shell, no prompt, the rules `loginStatus` follows). An older one is not ready: detection says so with `upgrade`,
   * and a session refuses to start. A version that cannot be read blocks nothing; the bounded handshake still applies.
   */
  readonly minimumVersion?: {
    readonly args: readonly string[]
    read(output: string): string | undefined
    readonly minimum: string
    /** Every launch needs fresh proof from the native command because an unsupported CLI can use other credentials. */
    readonly requireKnown?: true
    /** The command a person runs to upgrade; Latch never runs it. */
    readonly upgrade: string
    /**
     * Where this very program is published, for telling a person a newer one exists (`update-command.ts`); Latch never
     * runs the update. Absent: no update hint.
     */
    readonly source?: ReleaseSource
  }
  /**
   * For a program with no `minimumVersion` of its own: how its version is read (by the same rules, the same cache) and
   * where it is published, only to tell a person a newer one exists. It never blocks or refuses anything.
   */
  readonly releases?: {
    readonly args: readonly string[]
    read(output: string): string | undefined
    readonly source: ReleaseSource
  }
  /**
   * How a draft's lists are read before a session, decided per preset (docs/HARNESSES.md「什么时候读」). A draft reads by
   * itself (`select`) only where the read runs no turn, calls no model and starts none of the person's own session hooks
   * or extensions; otherwise only when a person asks (`request`). Both open an empty session in a private folder, once.
   * `codexModels`: Codex's own `model/list` with these arguments after the definition's, which opens no session or
   * thread, so a draft reads it by itself.
   */
  readonly catalogueRead:
    | { readonly when: 'select' | 'request' }
    | { readonly codexModels: readonly string[] }
    | {
        /**
         * Its own `initialize._meta` already lists its models and their thinking, as `session/new` reports them: read
         * from a process that opens no session, so a draft reads it by itself. Undefined for a shape it does not know.
         */
        readonly fromInitialize: (
          meta: unknown,
        ) => { options: SessionConfigOption[]; perModel: Array<{ model: string; options: SessionConfigOption[] }> } | undefined
      }
  /**
   * Rewrites one `session/update` into what ACP says before Latch reads it, where this harness says the same thing its own
   * way. Returns the update to read; it never adds what the harness did not send.
   */
  normalizeUpdate?(update: SessionUpdate): SessionUpdate
  /** Reads a chunk that reports a retry. Absent, or undefined for a chunk: it is the model's text or thinking. */
  readRetry?(update: SessionUpdate): RetryReport | undefined
  /** Reads a tool call update that reports the harness refusing the call itself. Absent, or undefined: it says no such thing. */
  readDenial?(update: SessionUpdate): ToolDenial | undefined
  /**
   * Reads a permission request that asks the person to approve a plan before the harness goes on, as the harness asks
   * it: the plan's text (Markdown). Its own options answer it. Absent, or undefined: it is no plan.
   */
  /**
   * The only options that may answer a plan with 「按计划执行」, by ID. An option that also switches the mode
   * (`permission.modeAnswers`) is offered only when that mode is not wider than the profile's `expectedMode`; every other
   * allowing option of a plan's ask is hidden. Absent or empty: a plan has no allowing answer.
   */
  planAnswers?: readonly string[]
  readPlan?(
    toolCall: { name?: string | null | undefined; kind?: string | null | undefined; rawInput?: unknown },
    options: ReadonlyArray<{ optionId: string }>,
  ): string | undefined
  /**
   * For a harness that sends a subagent's updates and requests on the session that started it, each marked as the
   * subagent's, instead of on the subagent's own session: the subagent, and the update or asked call as it would arrive
   * on the subagent's own session. Absent, or undefined: it is the session's own.
   */
  readProjectedChild?(value: Record<string, unknown>): { child: ProjectedChild; value: Record<string, unknown> } | undefined
  /**
   * Reads an update of a session's own call that says how a subagent the call started ended, for a harness that reports
   * no state of its subagents otherwise. Undefined: it says no such thing, or the subagent goes on.
   */
  readChildEnd?(update: SessionUpdate): { sessionId: string; outcome: 'done' | 'failed' } | undefined
  readonly extensions?: HarnessExtensions
  /**
   * Its own commands that change its permission mode without reporting the change over ACP (Grok's
   * `/always-approve`): left out of the commands a session lists, and a prompt that starts with one is refused, so the
   * mode Latch records cannot silently stop being the one the harness runs in.
   */
  readonly modeCommands?: readonly string[]
  /**
   * Chinese notes on what of the person's own the harness applies in a session in `cwd` beyond what Latch shows, read
   * from its home when a session on its own login binds (Grok's saved 「Always allow」 answers). `env`: the session's
   * environment. Read only: nothing is written, and contents never leave this function.
   */
  savedRules?(cwd: string, env: Readonly<Record<string, string>>): Promise<string[]>
  /**
   * A request a launch test sends after initialize, with no parameters, that needs a login but opens no session and runs
   * no turn (Antigravity's `session/list`): an answer is a login, `Authentication required` is none, anything else is
   * unknown. Taken before `loginStatus`, which then does not run.
   */
  readonly loginRequest?: string
  /**
   * For a harness with no way to delete a session over its protocol that keeps each session in a folder of its own named
   * by the session ID (Cursor's `acp-sessions/<id>/`): where those folders are for the environment its process had
   * (`HOME` and the definition's variables), and whether a folder's record says it is the session Latch started in
   * `cwd`. Latch removes the folder of each session it started, after the process exited, when a removed session is
   * deleted; never one it brought in, one outside that folder or behind a link.
   */
  readonly sessionFolders?: {
    root(env: Readonly<Record<string, string>>): string | undefined
    owns(folder: string, cwd: string): Promise<boolean>
  }
  /** It reports its version as `initialize._meta.agentVersion` rather than in `agentInfo` (Grok Build). */
  readonly versionInMeta?: true
  /**
   * The harness's own method that deletes one of its sessions (`{ sessionId }`), for one that does not advertise ACP's
   * `session/delete`: Latch uses it where it would use that, checked against the real program.
   */
  readonly deleteMethod?: string
  readonly gateway?: ProfileGateway
  /**
   * `_meta` sent with every `session/set_config_option` for the model, where the harness reads there that the choice is
   * the session's alone. With it set, a session never falls back to the legacy `session/set_model`: Qwen
   * Code's writes the person's own settings unless told otherwise.
   */
  readonly modelSetMeta?: Readonly<Record<string, unknown>>
  /**
   * How the harness's own program reports the limits of its subscription (docs/HARNESSES.md#额度). Latch only listens
   * to a process it already runs for a session; it changes nothing that runs, so the version stays.
   */
  readonly quota?: ProfileQuota
  /**
   * What the token counts the harness reports cover: the whole session (the default) or the turn they end. Checked
   * against the real program; it changes nothing that runs, so the version stays. `none`: what it reports is neither
   * (goose's is its last model call's context), so it is not recorded and the Host may read the turn's tokens itself.
   */
  readonly usageScope?: 'session' | 'turn' | 'none'
  /** Its `inputTokens` leave out the cached input it reports beside them (ACP counts it in): Latch adds it back. */
  readonly inputExcludesCache?: true
  /** Token counts its prompt answer carries outside ACP's `usage`, read from the whole answer. */
  turnUsage?(result: unknown): TurnTokens | undefined
  /**
   * Token counts of one model call that a session update carries while a turn runs, summed over the turn when its
   * answer carries none. Read only from updates of a sent turn, never from a replayed history.
   */
  callUsage?(update: SessionUpdate): TurnTokens | undefined
  /**
   * Latch never points this harness at the gateway: it reaches its vendor's models through its own login only. Shown
   * to clients as `HarnessCapabilities.models.ownOnly`; it changes nothing that runs, so the version stays.
   */
  readonly ownModelsOnly?: true
  /**
   * It reports thinking levels (`thought_level`) for every model that has them, checked in its source: a model without
   * them has none. Shown to clients as `HarnessCapabilities.models.thinkingPerModel`; nothing that runs changes.
   */
  readonly thinkingPerModel?: true
  /**
   * A session it opens again (`session/resume`, `session/load`) reports its default model and thinking, not what the
   * session was set to. The driver sets what the session last showed again before the next prompt, as it sets a draft's
   * choices, and a reading of such an option after a restart says nothing about an unanswered change.
   */
  readonly resumeResetsOptions?: true
  /**
   * Its ACP server steers a running turn when given another `session/prompt` (text or attachments), answering the
   * superseded `session/prompt` with `end_turn` and the turn's usage so far while the new request owns the rest of the
   * turn; it refuses while a permission or question waits (Antigravity 1.5.8+). Changes nothing at launch, so `version` stays.
   */
  readonly promptSteer?: true
  /**
   * The replies its CLI sends, ending the turn as `end_turn`, for a turn it terminated without saying why over ACP. A
   * turn whose whole reply is one of them ends as failed; a reply that only contains the text stays a reply.
   */
  readonly terminatedReplies?: readonly string[]
  readonly thinkingInModel?: true
  /** A documented process setting, presented as configured rather than independently reported by the Agent. */
  launchThinking?(model: string | undefined, selected?: { model: string; value: string }): SessionConfigOption | undefined
  /**
   * Host-only files the agent needs before spawn (e.g. a settings file of its own). Returns env entries to add. A process of
   * a session on a gateway route also gets the route and the session's private temporary directory, rewritten before every
   * spawn and removed with the session.
   */
  materialize?(input: {
    dataDir: string
    route?: { route: ModelRoute; directory: string }
    session?: { directory: string; thinking?: { model: string; value: string } }
  }): Promise<Record<string, string>>
}
