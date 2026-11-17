import type { HarnessLoginStatus } from './harnesses.ts'
import type { TokenUsage } from './types.ts'

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
  filePreview?: true
  nativeBulk?: true
  nativeBulkStream?: true
  search?: true
  sessionBatch?: true
  fork?: true
  queue?: true
  questions?: true
  /** User messages retain the prompt's requestId, so a client may replace a pending bubble by identity. */
  messageIdentity?: true
  fileMentions?: true
  attachments?: true
  agentProbe?: true
  usage?: true
  /** `/model-usage`, `/model-spend`: the usage ledger's sums, prices and monthly budgets (docs/MODEL-GATEWAY.md). */
  modelUsage?: true
  /** Updating an existing address, protocol or key compares the service target inside the Host write lock. */
  providerUpdateTarget?: true
  changes?: true
  /** `/tasks/:id/review-notes`: line feedback kept on the Host (docs/CHANGES.md). */
  reviewNotes?: true
  gitWrites?: true
  /** `/tasks/:id/git` and its stage, unstage, commit and push routes (docs/GIT-DELIVERY.md). */
  gitDelivery?: true
  /** `…/git/diff`, `stage-lines`, `unstage-lines`, `history` and `compare`: staging by line and the history views. */
  gitHunks?: true
  /** `…/git/fetch`, `pull` (fast-forward only) and `abort`, and `POST /workspaces/clone` (docs/GIT-DELIVERY.md). */
  gitSync?: true
  /** Worktree start points (`POST /tasks` `worktree` objects), `…/worktree` inventories and removal (docs/BRANCHES.md). */
  worktreeLifecycle?: true
  terminal?: true
  /** A harness's login command can open in this computer's terminal: only on this computer, for a device with `run`. */
  loginTerminal?: true
  previewBrowser?: true
  /** `GET /tasks/:id/browser-tabs`: the session's tabs in this Mac's desktop app, read-only (docs/PREVIEW-BROWSER.md). */
  browserTabs?: true
  /** `/simulators`: this Mac's iOS simulators in the 设备 panel; only on host.sock, for `run` with all data (docs/DEVICE-PREVIEW.md). */
  simulators?: true
  customAgents?: true
  /** The Host owns the stable interactive conversation for each Personal Agent. */
  singleAgentChat?: true
  automations?: true
  /** `/handoffs` exists: hand chosen material to a code session and take its result back. */
  handoffs?: true
  /** `/work/items`: 待办 with 0–16 sessions, started through the same path as `POST /tasks` (docs/ARCHITECTURE.md#待办). */
  workItems?: true
  /** `GET /work/proposals/:id`, `…/accept`, `…/dismiss`, and `AppSnapshot.workProposals`: agents' proposals for the board. */
  workProposals?: true
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
  id: string
  text: string
  queuedAt: string
  state: 'waiting' | 'parked' | 'dropped'
  reason?: string
}
