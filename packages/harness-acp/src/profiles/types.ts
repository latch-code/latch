import type { ModeTier } from '@latch/protocol'
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
  /** Gemini only: written to a Host file whose path is passed in the environment. */
  systemSettings?: Record<string, unknown>
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
  | { readonly decline: (params: unknown, agentName: string) => { note: string; reply: unknown } | undefined }

/**
 * What a harness sends outside ACP. A notification is rewritten into the `session/update` it means, for the session the
 * process runs (these carry no session ID); undefined drops it, as an unknown notification is.
 */
interface HarnessExtensions {
  readonly requests?: Readonly<Record<string, ExtensionRequest>>
  readonly notifications?: Readonly<Record<string, (params: unknown, sessionKey: string) => SessionUpdate | undefined>>
}

export type LoginStatus = 'authenticated' | 'unauthenticated' | 'unknown'

/** A status command's verdict. `expiresAt`: when a stored login ends, as an ISO date, where the program says. */
export interface LoginCheck {
  status: LoginStatus
  expiresAt?: string
}

/** What the harness itself writes below its `projectConfigPaths` when it starts, so that is not a change. */
export interface ProjectConfigManaged {
  /** Paths relative to the directory holding the entry (`.opencode/node_modules`), left out with everything below them. */
  skip?: readonly string[]
  /** Files compared after `reduce` removes what the harness adds; `undefined` leaves the file out. */
  reduce?: Readonly<Record<string, (text: string) => unknown>>
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

export interface HarnessProfile {
  /** Equals `AgentPreset.id`. */
  readonly presetId: string
  /** Part of the launch fingerprint; bump it when the profile's behaviour changes. */
  readonly version: number
  /** The protocol the harness speaks. Absent: ACP. */
  readonly wire?: WireKind
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
   * How a draft's lists are read before a session. Absent: an empty session in a private folder, once, when a draft
   * first selects the harness with nothing known. `request`: the same, only when a person asks, because the process loads
   * more than the harness when it starts. `codexModels`: Codex's own `model/list` through the adapter's bundled CLI, with
   * these arguments after the definition's, which opens no session or thread.
   */
  readonly catalogueRead?: { readonly when: 'request' } | { readonly codexModels: readonly string[] }
  /**
   * Rewrites one `session/update` into what ACP says before Latch reads it, where this harness says the same thing its own
   * way. Returns the update to read; it never adds what the harness did not send.
   */
  normalizeUpdate?(update: SessionUpdate): SessionUpdate
  readonly extensions?: HarnessExtensions
  /** Host-only files the agent needs before spawn (e.g. Gemini system settings). Returns env entries to add. */
  materialize?(input: { dataDir: string }): Promise<Record<string, string>>
}
