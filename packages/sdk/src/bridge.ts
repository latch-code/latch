import type {
  AttachmentRef,
  FileMention,
  Approval,
  Message,
  MessageOrigin,
  ModelRef,
  AgentExecutionContext,
  RunLive,
  DriverTaskDetail,
  TaskMode,
  DriverTaskSummary,
  ModelWire,
  HarnessCatalogue,
  HarnessCommandCatalogue,
  HarnessPluginReport,
  HarnessOwnMcp,
  HarnessQuota,
  HarnessQuotaRead,
  CatalogueRead,
  ModelCapabilities,
  ServiceModelOptions,
} from '@latch/protocol/types'

/** One folder of a project: its ID inside the project (stable across reorders) and its absolute path. */
export interface ProjectFolder {
  id: string
  path: string
}

/**
 * A model service a harness's requests go to through the Host's gateway, as the Host derives it from its own records: the
 * service, the model chosen, the entry/upstream protocols and the service's `scheme://host:port`. Never a key or a token.
 */
export interface ModelRoute {
  providerId: string
  model: string
  wire: ModelWire
  /** Absent on existing same-protocol routes; then equal to wire. */
  upstream?: ModelWire
  origin: string
  /**
   * 「出错时改用」 as the settings had it when the session started, by a model of the route's service, in order. A request
   * the first service fails before its reply begins goes to these; one that is gone or changed since is passed over.
   */
  fallbacks?: Record<string, ModelRouteFallback[]>
}

/**
 * A saved service as a harness would reach it through the Host's gateway: the protocol the harness speaks to the gateway
 * (`entry`), the one the service speaks (`upstream`), its models and what the owner declared for them. Never a key.
 */
export interface ServiceDeclaration {
  providerId: string
  entry: ModelWire
  upstream: ModelWire
  models: readonly string[]
  modelCapabilities?: Readonly<Record<string, ModelCapabilities>>
}

/** One 「出错时改用」 candidate: another service's model, the protocol that service speaks and its `scheme://host:port`. */
export interface ModelRouteFallback {
  providerId: string
  model: string
  upstream: ModelWire
  origin: string
}

export interface CreateTaskInput {
  /** The Host made an authoring workspace. Give its guide to the engine while keeping the person's prompt as written. */
  pluginCreation?: true
  /** Authoritative Host-only agent context, transient for this run. */
  agentContext?: AgentExecutionContext
  /** Host-only: the ordinary report source may be checked once this session's Host metadata has settled. */
  extensionReportReady?: Promise<void>
  fileRefs?: FileMention[]
  attachments?: AttachmentRef[]
  prompt: string
  requestId: string
  /**
   * Set by the Host only: what the session is called from its start (a fork, a conversation moved to another Harness, a
   * scheduled run). A driver that names its sessions uses it instead of a name from `prompt`, which may begin with the
   * Host's record of another session. Not part of the request's identity: a retry answers with the session it made.
   */
  title?: string
  mode?: TaskMode
  /** Model for drivers that run on the Host's providers. Others may ignore it. */
  model?: ModelRef
  /**
   * Drivers that declare `models.wires`: the service this session's requests go to through `HarnessHostOptions.modelGateway`
   * instead of the harness's own login. Set by the Host only; part of the launch, so the start's fingerprint covers it.
   */
  modelRoute?: ModelRoute
  /** Absolute working directory chosen from the Host's workspaces. Absent means the driver default. */
  cwd?: string
  /**
   * Drivers that receive `folders`, or primary-only drivers implementing `commandCatalogue`: the project the session
   * starts in (`default` for the start directory). A catalogue reader uses this only to scope suggestions, not extra files.
   */
  workspaceId?: string
  /**
   * Drivers that declare `projectFolders: 'all'`, with `cwd` and `workspaceId`: every folder of that project in order;
   * `[0].path` is `cwd` (the primary folder). The driver checks them against `projects()` and keeps them for the
   * session's lifetime. Others never receive it and use `cwd` alone.
   */
  folders?: ReadonlyArray<ProjectFolder>
  /**
   * Choices from `HarnessCatalogue`, by option ID, to set after the session opens and before the first prompt: the model
   * first, then thinking and the others, then the mode. A model or mode the agent no longer offers fails the turn; any
   * other option it no longer offers is left at its default, and the session says so.
   */
  config?: ReadonlyArray<{ configId: string; value: string }>
  /**
   * Drivers that declare `fork: 'native'`, for a fork of one of their own sessions: the source and the last message of
   * the turn it forks after. `prompt` then begins with the Host's text record of that history, `prefixLength` characters
   * long; a driver that forks its own record instead leaves those characters out of what it sends, and marks the first
   * user message `nativeFork`. With `instead`, the source is an earlier session the conversation has since left: its own
   * record lacks what was said elsewhere, so a driver that forks it sends `instead` in place of those characters.
   */
  fork?: { taskId: string; upToMessageId: string; prefixLength: number; instead?: string }
  /**
   * Drivers that declare `seededStart`: the session is recorded idle with no turn, and this text goes before the person's
   * first message, which starts its first turn. `prompt` is then empty. A text rebuild of an earlier session uses it, so
   * nothing reaches the model service until the person sends.
   */
  seed?: string
  /**
   * Set by the Host only: the session's agent may propose for the board (`HarnessHostOptions.proposeWork`). The driver keeps
   * it for the session's life and offers only those tools for it; it gives no other permission.
   */
  workProposals?: true
  /** L3 drivers: the launch fingerprint this start recorded. ACP refuses when absent (409 l3-confirmation-missing) or different (409 agent-definition-changed). */
  expectedLaunchHash?: string
}

export interface PromptOptions {
  /** This turn was explicitly submitted from the team panel to the Harness's own subagents. */
  teamRequest?: true
  /** The agent's context as it stands for this turn; never accepted from an HTTP body. */
  agentContext?: AgentExecutionContext
  /** Host queue time, for the accepted user message. */
  queuedAt?: string
  fileRefs?: FileMention[]
  attachments?: AttachmentRef[]
  /** Switch the session to this model from this turn on. */
  model?: ModelRef
  /**
   * Drivers whose detail says `clearContext`: this turn starts a new context in which the agent sees none of the
   * session's earlier messages. They stay in the history, and the turn's user message carries `freshContext`.
   */
  freshContext?: true
  /**
   * The turn carries outside content the Host put in it (a 待办 thread's quotes): written with the turn's own record, as
   * `markOutsideContent` writes it, so what the context proposes from now until it starts over is external. Only drivers
   * with `markOutsideContent` take it; the Host refuses it for the others.
   */
  outsideContent?: true
  /**
   * Nobody pressed anything for this turn (a team round the lead's agent sent): what the person allowed for the whole
   * session (本会话始终允许) does not carry into it; every call that asks, asks.
   */
  unattended?: true
  /** The built-in runtime rechecks an automatic continuation at acceptance and leases only these approved plugin revisions. */
  authorizeUnattended?: () => { revisions: Record<string, string>; model: ModelRef; approvalTtlMs: number }
}

export interface DecideOptions {
  /** One of `Approval.options[].id`. */
  optionId?: string
  /** Where the person decided, for the call's decision record: the Host computer's desktop app or another device. */
  via?: 'this-mac' | 'other-device'
  /**
   * With a rejection: what the person wants done instead, printable and at most 500 characters. The built-in harness
   * hands it to the model with the rejection; drivers whose permission answer carries no text ignore it.
   */
  note?: string
}

export interface CancelOptions {
  /**
   * Cancel only while this is the session's current run (`TaskSummary.runId`). A driver that tracks runs checks it in
   * the same step that starts the cancel, so a run that began afterwards keeps running.
   */
  runId?: string
}

export interface SetConfigOptions {
  /** Host authority, checked after async preparation and immediately before an external configuration request. */
  authorize?: () => void
  /**
   * With a model option's `serviceChoice` value: the route the Host built for that service from its own records, as it
   * builds one for a start. Set by the Host only; absent for `ownChoice`, which leaves every service.
   */
  route?: ModelRoute
  /** With `route`: the service's name as the Host's settings give it, for the session's record of the move. */
  routeName?: string
}

/**
 * Where a refused config change stands, in `AppError.details.configOutcome`. `not-sent`: refused before anything reached
 * the agent. `refused`: the agent answered with an error and the session does not show the value. Either way the
 * change did not apply, and the Host records it as failed; any other error after the Host's receipt stays unknown.
 */
export type ConfigRefusal = 'not-sent' | 'refused'

/**
 * What the agent itself reports of one option now, for settling a change whose outcome is unknown. `read`: its value,
 * and `asked` when the driver counts it as the value asked for (the same, or the same written its own way). `busy`: a
 * turn, a request waiting on the person, another change, or a subagent that may still run holds the session, so
 * nothing was read. `unread`: the agent could not be asked or gave no value.
 */
export type ConfigReading =
  | { kind: 'read'; currentValue: string; asked: boolean }
  | { kind: 'busy'; reason: 'running' | 'subagents' }
  | { kind: 'unread' }

export type ConfigChangeClass = 'neutral' | 'stricter' | 'wider'

/**
 * What became of text added to a running turn. `injected`: the agent took it into the turn; nothing says it read it before
 * the turn ended. `prompt-required`: no turn could take it and nothing was sent, so it waits for the next turn instead.
 */
export type SteerOutcome = 'injected' | 'prompt-required'

export interface QueuedSteerOptions {
  runId: string
  queuedAt: string
  /** Recheck the queue's writers and the device requesting delivery immediately before sending. */
  authorize(): Promise<void>
}

/** What an L3 session would launch, for the audit and its start. */
export interface LaunchPreview {
  launchHash: string
  /**
   * The fingerprint without the project's configuration (command, arguments, variables, preset), so the Host can tell a
   * changed project configuration from a changed command; absent from drivers that do not say.
   */
  definitionHash?: string
  /** Absolute path. */
  command: string
  args: string[]
  /** Names only, sorted; values never leave the Host. */
  envNames: string[]
  /** The names the definition itself sets, sorted; absent from drivers that do not say. */
  definitionEnvNames?: string[]
  cwd: string
  /** Folders besides `cwd` the agent receives, as ordered absolute paths. Absent or empty: `cwd` only. */
  folders?: string[]
  presetId?: string
  /** The command is the preset's own, at the location the Host finds it, with the preset's arguments. */
  verified: boolean
  approvals: 'prompts' | 'none'
  readback: 'mode' | 'none'
}

/** One session the harness itself lists (ACP `session/list`): metadata only, as the harness reported it. */
export interface ExternalSession {
  agentSessionId: string
  /** Absolute, as the harness recorded it; the Host resolves it before trusting it. */
  cwd: string
  title?: string
  updatedAt?: string
}

/** What one listing found, at most 500 sessions or 20 seconds. */
export interface ExternalSessionList {
  sessions: ExternalSession[]
  /** The bound stopped the listing before the harness had no more. */
  truncated: boolean
  /**
   * Sessions the driver will not load because loading would rewrite what the session itself stores (folder grants of
   * its own), by directory only, so the Host can count those of a project; at most as many as `sessions` may hold.
   */
  withheld?: Array<{ cwd: string }>
}

/** Where an external session is loaded: its own directory, inside the project the Host checked it against. */
export interface ExternalSessionPlace {
  agentSessionId: string
  /** The session's directory, at or below `folders[0].path`. */
  cwd: string
  workspaceId: string
  /** Every folder of the project, as `CreateTaskInput.folders`; `[0]` is the primary folder. */
  folders: ReadonlyArray<ProjectFolder>
}

/**
 * A session loaded with its replay kept, on a process held for it until `closeExternalSession` or its adoption. Never a
 * prompt: nothing runs. `messages` are the replay, newest last, within the driver's bound, with tool output redacted.
 */
export interface ExternalSessionLoad {
  loadId: string
  messages: Message[]
  /** Messages of the replay the bound left out before `messages`. */
  droppedBefore: number
  /** User turns in the whole replay. */
  turns: number
  model?: string
  /** The harness neither locks a session nor says one is in use, so this load does not show it is open nowhere else. */
  useUnknown?: true
}

/**
 * Binds a new session `sessionId` (chosen by the Host, so its record can exist first) to the external session, with the
 * replay as its history. Idempotent: the same `sessionId` for the same session answers again. The external session is
 * never deleted with it.
 */
export interface ExternalSessionAdopt extends ExternalSessionPlace {
  sessionId: string
  /** A load to reuse; without it, or once it is gone, the driver loads the session again. */
  loadId?: string
  title: string
}

export interface Bridge {
  start(): Promise<void>
  close(): Promise<void>
  listTasks(): Promise<DriverTaskSummary[]>
  detail(sessionId: string): Promise<DriverTaskDetail>
  createTask(input: CreateTaskInput): Promise<{ sessionId: string }>
  prompt(sessionId: string, prompt: string, requestId: string, options?: PromptOptions): Promise<void>
  /**
   * Resolves once the cancelled run has settled. `false`: nothing was cancelled, because no run was active or `runId`
   * named a run that is no longer current. Drivers that cannot tell resolve without a value.
   */
  cancel(sessionId: string, options?: CancelOptions): Promise<boolean | void>
  /**
   * Persists provenance before forwarding a local prompt through a `latch-mcp` bridge, or before the Host hands over
   * a referenced conversation (`origin`, by default `mcp-prompt`). Rejects if the session is missing or the write
   * fails. Proposals are external until the context starts over. The running turn, if any, gets `Message.origin`.
   * The marker records permission to fetch and may outlive a failed fetch.
   */
  markOutsideContent?(sessionId: string, origin?: MessageOrigin): Promise<void>
  /**
   * Optional, with `HarnessHostOptions.teamRoster`. The team this session leads changed (its members, their states, or
   * whether its agent may send them work): the driver reads `teamRoster` again for what its agent reads next.
   */
  teamChanged?(sessionId: string): Promise<void>
  /**
   * Optional. Starts the settled session's process ahead of its next turn, as that turn would, and sends nothing to the
   * model. A driver starts one only while it is under its process limit, never stopping another session's process for
   * it, and not while the session runs. `false`: nothing was started (already running, at the limit, or failed).
   */
  warm?(sessionId: string): Promise<boolean>
  /**
   * Optional, with `Subagent.stoppable`. Stops one subagent's current work, named by its row's message ID, and answers its
   * open requests as cancelled; the session's turn goes on. Resolves once the stop is sent, not once it took effect: the
   * row says `stopping` until the subagent reports how it ended. `false`: that row cannot be stopped now.
   */
  cancelSubagent?(sessionId: string, subagentId: string): Promise<boolean>
  approvals(): Approval[]
  decide(approvalId: string, decision: 'allow' | 'reject', options?: DecideOptions): Promise<boolean>
  subscribe(listener: (sessionId?: string) => void): () => void
  /**
   * Optional. The runs live now, from memory and without awaiting: the Host calls it on each change and when a silence
   * threshold falls due, so it must cost no more than the number of live runs. `TaskSummary.live` carries the same facts.
   */
  liveRuns?(): Array<{ sessionId: string; live: RunLive }>
  /**
   * Optional, with `TaskDetail.steer`. Adds text to the session's running turn. `requestId` names it as a prompt's does: a
   * retry answers what the first request got, and one whose answer was lost is never sent again (409 `steer-unknown`).
   */
  steer?(sessionId: string, prompt: string, requestId: string): Promise<SteerOutcome>
  /** As steer, targeting only the named run. A run that ended or stopped taking input leaves the item queued. */
  steerQueued?(sessionId: string, prompt: string, requestId: string, options: QueuedSteerOptions): Promise<SteerOutcome>
  /**
   * Optional. Delete a settled session's data; reject with 409 `task-running` while it runs. `original`: the person chose
   * to delete an imported session's original in the harness's own record too (`HarnessDriver.historyDelete`), and the
   * Host audited that choice first.
   */
  remove?(sessionId: string, options?: { original?: boolean }): Promise<void>
  /**
   * Optional. Change one of `TaskDetail.config` for later turns. Reject with 409 `task-running`, or with
   * `details.configOutcome` (`ConfigRefusal`), only when the change certainly did not apply: the Host records that change
   * as failed, where any other error after its receipt stays unknown.
   */
  setConfig?(sessionId: string, configId: string, value: string, options?: SetConfigOptions): Promise<void>
  /**
   * Optional. Reads one option's current value from the agent itself, never from what the driver last recorded, and only
   * while the session is idle: a request that never got its answer must not be able to land after the reading, so the
   * driver may end the process it went to first. It never changes a setting, and refuses turns, additions and changes
   * of the session while it reads. `value` is what the change asked for, for `asked`.
   */
  readConfig?(sessionId: string, configId: string, value: string): Promise<ConfigReading>
  /** Optional. How a config change relates to the session's expected permission mode. */
  classifyConfigChange?(sessionId: string, configId: string, value: string): Promise<ConfigChangeClass>
  /**
   * Optional. Only a cached real-session command report for this exact draft context; never starts a process or probes.
   * The source session ID is private to the Host, which must recheck source visibility and draft authorization after
   * awaiting this read. The catalogue is a previous-session suggestion, not present capabilities or execution authority.
   */
  commandCatalogue?(input: {
    cwd: string
    workspaceId?: string
    folders?: ReadonlyArray<ProjectFolder>
    modelRoute?: ModelRoute
    config?: ReadonlyArray<{ configId: string; value: string }>
  }): Promise<{ sourceSessionId: string; catalogue: HarnessCommandCatalogue } | undefined>
  /**
   * Optional, with `commandCatalogue`. The newest cached real-session report of the current definition from any folder,
   * whose source session passes synchronous `accept` and asynchronous `verifySource` if supplied. Never starts a
   * process or probes. The Host can only publish reports that supply `current`, a synchronous check of the definition,
   * report, source and real directory. The source session ID and the check never leave the Host.
   */
  latestCommandReport?(
    accept?: (sourceSessionId: string) => boolean,
    verifySource?: (sourceSessionId: string) => Promise<boolean>,
  ): Promise<
    | {
        sourceSessionId: string
        workspaceId?: string
        catalogue: HarnessCommandCatalogue
        plugins?: HarnessPluginReport
        current?(): boolean
      }
    | undefined
  >
  /** Optional. What the harness offered when a session of its current definition last started; see `HarnessCatalogue`. */
  catalogue?(): HarnessCatalogue | undefined
  /**
   * Optional. What a draft on a model of each service offers before it starts (`ServiceModelOptions`), from the Host's
   * saved service settings as they are now: derived from a declaration where the harness's options follow it exactly,
   * else what a session of the current definition on that model reported under the same declaration.
   */
  serviceOptions?(services: readonly ServiceDeclaration[]): ServiceModelOptions[]
  /**
   * Optional. What the harness said it takes in a prompt when it last started for its current definition (images; text
   * as embedded context). Undefined until it has started once since that definition was saved.
   */
  promptCapabilities?(): { images: boolean; text: boolean } | undefined
  /** Optional, with `readCatalogue`. How the catalogue is read before a session, and how the last read went. */
  catalogueRead?(): CatalogueRead | undefined
  /**
   * Optional. Reads the catalogue without running a turn; one read at a time, and a second call shares it. `auto`: only
   * when `catalogueRead().when` is `select` and nothing is known yet for this definition; `ran` is false otherwise.
   * `before` runs once, just before a process starts, and its failure stops the read. `model`: only what the harness
   * offers for that model of its list, such as thinking, added to the catalogue; with `auto`, only for a model nothing
   * is known of yet, and once per definition.
   */
  readCatalogue?(options: { auto: boolean; model?: string; before?: () => Promise<void> }): Promise<{ ran: boolean }>
  /**
   * Optional. The harness's own MCP servers as it reports them over its protocol (`HarnessInfo.ownMcp`); undefined for a
   * harness that does not report them.
   */
  ownMcp?(): HarnessOwnMcp | undefined
  /**
   * Optional. What the harness's own program last said about its subscription's limits (`HarnessInfo.quota`): numbers
   * and values of the protocol's fixed sets only. Undefined: nothing that still holds.
   */
  quota?(): HarnessQuota | undefined
  /** Optional, with `refreshQuota`. Reads of the limits made because someone looked (`HarnessInfo.quotaRead`). */
  quotaRead?(): HarnessQuotaRead | undefined
  /**
   * Optional. Someone looks at the limits: asks the harness's own program for them on a way that runs no model turn,
   * when what is known is missing or old. One read at a time, a second call shares it; at most one start a minute (ten
   * seconds with `retry`), bounded in time, any process it starts stopped after. `before` runs once, just before
   * anything is started or asked, and its failure stops the read.
   */
  refreshQuota?(options?: { retry?: boolean; before?: () => Promise<void> }): Promise<void>
  /**
   * Optional, with `ownMcp`. 读取: asks the harness, in a process with no session, for every MCP server it has
   * configured, which it starts to answer; one read at a time. `before` runs once, just before the process starts.
   */
  readOwnMcp?(options?: { before?: () => Promise<void> }): Promise<void>
  /**
   * Optional, with `HarnessLogin.logout`. Asks the harness to log out, so that a person can sign in with another account.
   * Refused while one of its sessions runs.
   */
  logout?(): Promise<void>
  /** Optional. Model IDs a person typed; see `HarnessInfo.customModels`. */
  customModels?(): string[]
  setCustomModels?(models: readonly string[]): Promise<void>
  /** Optional, L3 drivers. What a new session in `cwd` would launch; `workspaceId` and `folders` as in `CreateTaskInput`. */
  launchPreview?(input: {
    cwd: string
    workspaceId?: string
    folders?: ReadonlyArray<ProjectFolder>
    modelRoute?: ModelRoute
    /** Choices that affect process startup, included in the launch fingerprint. */
    config?: ReadonlyArray<{ configId: string; value: string }>
  }): Promise<LaunchPreview>
  /**
   * Optional, with `HarnessDriver.historyImport`. The harness's own sessions, from a process in a private empty folder that
   * is stopped afterwards; 409 `history-not-supported` when the running harness cannot list or load sessions.
   */
  listExternalSessions?(): Promise<ExternalSessionList>
  /** Loads one external session and keeps its replay; 409 `history-session-busy` when the harness says it is open elsewhere. */
  loadExternalSession?(place: ExternalSessionPlace): Promise<ExternalSessionLoad>
  /** Closes a load and stops its process; unknown IDs are ignored. */
  closeExternalSession?(loadId: string): Promise<void>
  adoptExternalSession?(
    input: ExternalSessionAdopt,
  ): Promise<{ sessionId: string; launchHash: string; messageCount: number; droppedBefore: number }>
  /**
   * Which record the IDs of `listExternalSessions` belong to, stable across definitions that read the same one; the Host
   * brings in each ID of a record once. Absent: the driver alone.
   */
  historyStore?(): string
  /** The harness sessions this driver's own sessions use or used, adopted ones aside: never offered for import. */
  agentSessionIds?(): string[]
}
