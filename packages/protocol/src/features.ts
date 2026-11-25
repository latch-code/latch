import type { HarnessLoginStatus } from './harnesses.ts'
import type { TokenUsage } from './types.ts'

/** Metadata for a workspace view compiled into both the Host and Web distributions. */
export interface BundledWorkspacePage {
  pluginId: string
  pageId: string
  version: number
}

export const PLUGIN_MARKETPLACE_PAGE = {
  pluginId: 'latch-workspace:marketplace',
  pageId: 'marketplace',
  version: 1,
} as const satisfies BundledWorkspacePage

/** Optional feature discovery; older Hosts omit these fields. */
export interface HostFeatures {
  /** 设置 › MCP: Latch's own MCP servers (`/mcp/servers`). */
  mcp?: true
  /** 设置 › 扩展: `GET /extensions`, each Harness's reported commands and skills (docs/HARNESSES.md#扩展). */
  extensions?: true
  configReceipts?: true
  /** `/customization`: one appearance document for the Host, with revisions (docs/CUSTOMIZATION.md). */
  customization?: true
  /** `/shortcuts`: each device's own key bindings (docs/CUSTOMIZATION.md#快捷键). */
  shortcuts?: true
  /** 设置 › 数据: `/data`, `/audit/records` and the desktop's 导出全部 (docs/ARCHITECTURE.md#数据保留与导出). */
  data?: true
  /** `POST /tasks/:id/config-requests/:requestId/check`: an unknown config change settled from the agent's own reading. */
  configCheck?: true
  promptTemplates?: true
  fileSearch?: true
  /** `POST …/files/grep`: the lines of a project's text files that hold a literal text (docs/ARCHITECTURE.md#会话文件). */
  fileContentSearch?: true
  fileTree?: true
  pluginPackages?: true
  /** This Host supports a locally approved registry for previewing and staging npm releases. */
  pluginNpmRegistry?: true
  pluginExternalSources?: true
  /** This computer can prepare a fresh session with offline plugin-authoring material. */
  pluginCreation?: true
  filePreview?: true
  nativeBulk?: true
  nativeBulkStream?: true
  /** `POST /native/bulk-upload`: a relay phone sends one chunked upload's parts on a bulk connection, four in flight. */
  nativeBulkUpload?: true
  search?: true
  sessionBatch?: true
  fork?: true
  queue?: true
  /** An item can be steered into a specific running turn; queue order is compared and changed on the Host. */
  queueControl?: true
  queueAttachments?: true
  questions?: true
  /** User messages retain the prompt's requestId, so a client may replace a pending bubble by identity. */
  messageIdentity?: true
  fileMentions?: true
  attachments?: true
  agentProbe?: true
  usage?: true
  /** `/model-usage`, `/model-spend`: the usage ledger's sums, prices and monthly budgets. */
  modelUsage?: true
  /** Updating an existing address, protocol or key compares the service target inside the Host write lock. */
  providerUpdateTarget?: true
  changes?: true
  /** `/tasks/:id/review-notes`: line feedback kept on the Host. */
  reviewNotes?: true
  gitWrites?: true
  /** `/tasks/:id/git` and its stage, unstage, commit and push routes. */
  gitDelivery?: true
  /** `…/git/diff`, `stage-lines`, `unstage-lines`, `history` and `compare`: staging by line and the history views. */
  gitHunks?: true
  /** `…/git/fetch`, `pull` (fast-forward only) and `abort`, and `POST /workspaces/clone`. */
  gitSync?: true
  /** Worktree start points (`POST /tasks` `worktree` objects), `…/worktree` inventories and removal. */
  worktreeLifecycle?: true
  /** `GET /workspaces/:id/branches` and `…/branches/switch`: a project folder's local branches and switching. */
  branchSwitch?: true
  /** `GET /workspaces/:id/folder-branches`: the current branch labels in one project's folders. */
  projectFolderBranches?: true
  terminal?: true
  /** A harness's login command can open in this computer's terminal: only on this computer, for a device with `run`. */
  loginTerminal?: true
  previewBrowser?: true
  /** `GET /tasks/:id/browser-tabs`: the session's tabs in this Mac's desktop app, read-only. */
  browserTabs?: true
  /** `/simulators`: this Mac's iOS simulators in the 设备 panel; only on host.sock, for `run` with all data. */
  simulators?: true
  customAgents?: true
  /** The Host stores and enforces each assistant’s explicitly selected work computer. */
  agentWorkComputer?: true
  /** The Host owns the stable interactive conversation for each Personal Agent. */
  singleAgentChat?: true
  automations?: true
  /** `/handoffs` exists: hand chosen material to a code session and take its result back. */
  handoffs?: true
  /** Explicit questions between this Host's personal Agents, with a reply scoped to the addressed turn. */
  agentMentions?: true
  /** `/work/items`: 待办 with 0–16 sessions, started through the same path as `POST /tasks` (docs/ARCHITECTURE.md#待办). */
  workItems?: true
  /** A pending create can look up its original receipt without creating another item. */
  workItemCreateReceipt?: true
  /** Exact work-discussion turns and bounded reply reads. */
  workItemTurns?: true
  /** `GET /work/proposals/:id`, `…/accept`, `…/dismiss`, and `AppSnapshot.workProposals`: agents' proposals for the board. */
  workProposals?: true
  /** `POST /tasks/:id/team`, `GET /teams/:id`, `POST /teams/:id/stop`, `AppSnapshot.teams` and `TaskSummary.teamOf`. */
  teams?: true
  mentions?: true
  pairingV3?: true
  nativeElevation?: true
  /** Summaries carry `live` and `runEnd`, and `POST /tasks/:id/keep-waiting` exists. */
  runLiveness?: true
  /** `PUT /preferences` takes `pinned`, and `SessionDefaults.pinned` reports it. */
  pinnedDefaults?: true
  /** Plugin pages: `AppSnapshot.apps`, `via` on task starts and input, `/apps/:pluginId/...`; the value is the version. */
  appPages?: 1
  /** `/history/*`: bring a session a harness had before Latch into Latch (docs/HARNESSES.md#接入已有会话); the value is the version. */
  historyImport?: 1
}

export interface SearchHit {
  sessionId: string
  messageId: string
  title: string
  snippet: string
  match: { start: number; end: number }
  updatedAt: string
  archived: boolean
}
export interface SearchResults {
  hits: SearchHit[]
  truncated: boolean
}
export interface SessionBatchResult {
  results: Array<{ id: string; ok: true } | { id: string; ok: false; code: string; message: string }>
}

export interface PromptTemplate {
  id: string
  name: string
  content: string
  scope: { kind: 'all' } | { kind: 'project'; id: string } | { kind: 'agent'; id: string }
}

/** The longest a test start runs on the Host: the handshake, then the login and version reads in the time left. */
export const AGENT_PROBE_MAX_MS = 20_000

/** A bounded initialize-only diagnostic; a successful handshake does not verify login or model access. */
export interface AgentProbeResult {
  status: 'ready' | 'authentication-required' | 'failed'
  agent?: { name?: string; version?: string }
  /**
   * The program an adapter drives, as the person installed it or the definition names it, beside the adapter in
   * `agent`; absent when the adapter runs its own copy, or drives none. No `version`: it could not be read.
   * `unchecked`: both versions are known and the pair is not one the adapter was built for; a warning only, nothing is
   * refused.
   */
  program?: { name: string; version?: string; unchecked?: true }
  capabilities: { embeddedContext?: boolean; images: boolean; resume: boolean; load: boolean; additionalDirectories: boolean }
  authMethods: Array<{ name: string; description?: string }>
  /** What the program's own status command said; absent when it has none. */
  login?: HarnessLoginStatus
  diagnostic?: string
  checkedAt: string
  launchHash: string
}

/** Visible queue state; authority and deduplication receipts remain private to the Host. */
export interface PromptQueueItem {
  attachmentCount?: number
  id: string
  text: string
  queuedAt: string
  state: 'waiting' | 'parked' | 'dropped'
  reason?: string
  /** Also requires the live session to report steer and a run ID. */
  canSteer?: true
  delivery?: 'sending' | 'uncertain' | 'steer-unknown'
  /** Same for every item in this order. An existing queue starts at zero. */
  orderRevision?: number
  /** Changes only when the item is edited. Its original text has revision zero. */
  contentRevision?: number
}
