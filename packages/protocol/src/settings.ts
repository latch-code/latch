import type { TaskMode } from './sessions.ts'

/** A model offered by one of the Host's model providers. */
export interface ModelRef {
  providerId: string
  model: string
  /** One of the model's declared `thinking` levels; absent leaves the model's own default. */
  effort?: string
}

/** A thinking level as it goes on the wire: `low`, `xhigh`, … */
export const MODEL_EFFORT = /^[a-z][a-z0-9_-]{0,31}$/u
export const MAX_THINKING_LEVELS = 8

/** What one model of a service can do, as the owner declared it in settings; nothing is guessed from its name. */
export interface ModelCapabilities {
  vision?: boolean
  /** The thinking levels the model accepts, weakest first, as sent on the wire. Absent: none is ever sent. */
  thinking?: string[]
}

/**
 * The protocol a model service speaks: OpenAI's Chat Completions (`openai-compatible`, a name kept for saved data),
 * OpenAI's Responses or Anthropic's Messages.
 */
export const PROVIDER_KINDS = ['openai-compatible', 'openai-responses', 'anthropic'] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]
/**
 * Protocols a data directory may still name though Latch no longer speaks them. A service saved with one stays on disk
 * and can be removed; nothing is ever sent to it, and no device can save one.
 */
export const RETIRED_PROVIDER_KINDS = ['gemini'] as const
export type RetiredProviderKind = (typeof RETIRED_PROVIDER_KINDS)[number]
/** A model service's protocol as it may be on disk. */
export type StoredProviderKind = ProviderKind | RetiredProviderKind
export const isProviderKind = (kind: unknown): kind is ProviderKind => (PROVIDER_KINDS as readonly unknown[]).includes(kind)
/**
 * How a model request to a service ended, as the Host sorts it before it decides what happens next; never the service's
 * words. `request`: the request itself was refused (400, 404, 413, 422…). `auth`: 401, or a 403 that says the key is at
 * fault. `forbidden`: any other 403. `quota`: 402 or the
 * balance ran out. `rate`: 429. `server`: 5xx or 529. `network`: no connection. `timeout`: no first byte in time.
 * `stream`: the reply broke after it began. `unavailable`: the service is off, removed or changed. `circuit-open`: the
 * Host is not sending to it for now. `budget`: the service's monthly budget is used up.
 */
export const MODEL_FAILURE_CLASSES = [
  'request',
  'auth',
  'forbidden',
  'quota',
  'rate',
  'server',
  'network',
  'timeout',
  'stream',
  'unavailable',
  'circuit-open',
  'budget',
] as const
export type ModelFailureClass = (typeof MODEL_FAILURE_CLASSES)[number]

export const MODEL_FAILURE_NAMES: Readonly<Record<ModelFailureClass, string>> = {
  request: '请求被拒绝',
  auth: '密钥无效',
  forbidden: '服务拒绝',
  quota: '额度用完',
  rate: '请求过多',
  server: '服务出错',
  network: '连不上',
  timeout: '没有回应',
  stream: '回复中断',
  unavailable: '不能用',
  'circuit-open': '暂停发送',
  budget: '预算用完',
}

/**
 * What the Host's real model requests say of a service, never a probe. Absent while it works. `slow`: the first byte takes
 * three times as long as it used to. `failing`: requests keep failing, and the Host holds back for a minute at a time.
 * `quota`: the balance ran out, and the Host prefers other services until `until`. `rate`: the service answered 429, and
 * other services come first for the time it asked. `key-invalid`: the service refused the key.
 */
export interface ServiceHealth {
  state: 'slow' | 'failing' | 'quota' | 'rate' | 'key-invalid'
  /** The latest failure, by class. */
  last?: ModelFailureClass
  /** When it happened. */
  at?: string
  /** When the Host asks the service first again by a real request; absent while a trial request is under way or for `slow`. */
  until?: string
}

export const SERVICE_HEALTH_NAMES: Readonly<Record<ServiceHealth['state'], string>> = {
  slow: '变慢',
  failing: '出错中',
  quota: '额度用完',
  rate: '请求过多',
  'key-invalid': '密钥无效',
}

/** At most this many 「出错时改用」 entries per model. */
export const MAX_MODEL_FALLBACKS = 4
/** The most requests one service may be given at a time, when a limit is set. */
export const MAX_SERVICE_CONCURRENCY = 32

/** A model another one falls back to: a service and one of its models, never a thinking level. */
export type ModelFallback = Pick<ModelRef, 'providerId' | 'model'>

/** Browser-safe provider listing. It never contains credentials. */
export interface ProviderSummary {
  modelCapabilities?: Record<string, ModelCapabilities>
  id: string
  name: string
  /** `demo` and `plugin` providers are not editable in settings. */
  kind: ProviderKind | 'demo' | 'plugin'
  models: string[]
  defaultModel: string
  /** 「出错时改用」 by model, in order; new sessions take it as it is when they start. */
  fallbacks?: Record<string, ModelFallback[]>
  health?: ServiceHealth
}

/** Neutral project glyphs (Lucide names); a project never has a colour. */
export const PROJECT_GLYPHS = [
  'folder',
  'code',
  'globe',
  'server',
  'smartphone',
  'book-open',
  'database',
  'flask-conical',
  'pen-tool',
  'wrench',
] as const
export type ProjectGlyph = (typeof PROJECT_GLYPHS)[number]

/**
 * How a folder was added: the desktop's native picker, a Finder drop it confirmed natively, `pnpm latch project`, or a
 * session's own folder that the desktop saved as a project after a native confirmation.
 */
export type FolderVia = 'picker' | 'drop' | 'cli' | 'session'

export interface WorkspaceFolder {
  /** Stable within the project across reorders and re-selection; never shown. */
  id: string
  /** Realpath. */
  path: string
  /** Chinese reason this folder cannot be used now, e.g. 找不到这个文件夹. */
  unavailable?: string
}

/** A project: a name and 1–8 ordered folders. `id: 'default'` is the Host's start directory (默认文件夹). */
export interface WorkspaceInfo {
  id: string
  name: string
  /** The primary folder (`folders[0].path`), where new sessions start. */
  path: string
  /** Chinese reason the project cannot start sessions now (the first failing folder); it can still be edited and removed. */
  unavailable?: string
  /** Ordered; `[0]` is the primary folder. Absent from older Hosts. */
  folders?: WorkspaceFolder[]
  glyph?: ProjectGlyph
  /** 「默认模型」: what a new session here starts on when neither the session nor its Agent chose one. Kept on the Host only. */
  defaultModel?: ModelRef
  /** Host-read, display-only Git branch of the primary folder; omitted when metadata cannot be verified. */
  branch?: string
  /** The project lies in Latch's program directory: every Latch 内置 write asks for local approval, and ACP agents cannot start there. */
  codeRoot?: true
}

/**
 * Where a new worktree starts (`POST /tasks` `worktree`; `true` is `head`): the project folder's HEAD on a new branch,
 * another local branch or commit on a new branch, an existing local branch checked out there, or an existing Latch
 * worktree of the project (by its folder name) reused.
 */
export type WorktreeStart =
  | { from: 'head' }
  | { from: 'commit'; ref: string }
  | { from: 'branch'; branch: string }
  | { from: 'reuse'; name: string }

/** A local branch a worktree can start from; `checkedOut`: checked out in a worktree already, so it cannot be checked out again. */
export interface WorktreeBranchChoice {
  name: string
  commit: string
  checkedOut?: true
}

/** A worktree Latch made for this project, by its folder name; `reason`: why it cannot be reused. */
export interface LatchWorktree {
  name: string
  /** Its current branch, as the Host shows branches; absent when HEAD is detached. */
  branch?: string
  /** `leftover`: no session owns it (a start that never finished, a crash); `archived`: its session is archived. */
  state: 'session' | 'archived' | 'leftover'
  sessionId?: string
  reusable: boolean
  reason?: string
}

/** `GET workspaces/:id/worktree`: where a new worktree of the project's folder would start, and the other start points. */
export interface WorktreeBase {
  /** The folder's branch, as the Host shows branches; absent when HEAD is detached. */
  branch?: string
  /** The commit HEAD names. */
  commit: string
  /** Local branches, most recently committed first (at most 200). */
  branches?: WorktreeBranchChoice[]
  /** Latch worktrees of this project a new session could reuse. */
  reusable?: LatchWorktree[]
}

/** `GET …/worktree` of a session or a leftover: what removing it would lose, read without running the repository's programs. */
export interface WorktreeInventory {
  name: string
  branch?: string
  staged: number
  unstaged: number
  untracked: number
  /** Distinct files with uncommitted changes: what a forced removal discards. */
  files: number
  /** Ignored files and folders (as Git lists them), which removing the folder deletes as well; one of them as an example. */
  ignored: number
  ignoredExample?: string
  /** The largest ignored folders with how many files each holds (at most three). */
  ignoredFolders?: Array<{ path: string; files: number }>
  /** An untracked or ignored folder that is another Git repository: removal is refused. */
  nested?: string
  /** A folder with too many entries to look through for a repository: removal is refused. */
  tooLarge?: string
  /** Checked-out submodules: removal is refused until they are deinitialised. */
  submodules?: number
  /** Submodule clones in the worktree's Git data (`modules/`): removal is refused until the person checks and deletes them. */
  submoduleData?: { path: string }
  /** Of the listing above: a removal that discards anything sends it back and is refused (`worktree-changed`) if it moved. */
  digest: string
  /** Lines added and removed in tracked files against HEAD; absent when too large to count. */
  insertions?: number
  deletions?: number
  upstream?: string
  /** Commits ahead of the upstream. */
  ahead?: number
  /** Without an upstream: commits on this branch and on no other branch or remote ref (从未推送). */
  unpushed?: number
  /** Latch made its branch: removal deletes it only when it is merged and the person was shown that. */
  ownBranch: boolean
  /**
   * Of Latch's own branch, why removal may delete it: a default branch (`main`, `origin/main`…) holds all its commits, or
   * it has none of its own past where it started. Absent: no evidence it is merged, so it is kept.
   */
  merged?: { into: 'default'; ref: string } | { into: 'start' }
  /** Why it cannot be removed now. */
  busy?: 'turn' | 'delivery' | 'terminal' | 'starting' | 'removing'
}

/** `POST …/worktree/remove`: `branch` is what happened to the branch Latch made (`none` when it made none). */
export interface WorktreeRemoval {
  removed: true
  discarded: number
  branch: 'deleted' | 'kept' | 'none'
  branchName?: string
}

export interface SessionDefaults {
  harnessId: string
  mode: TaskMode
  workspaceId: string
  model?: ModelRef
  /** The engine and model were set on the Host computer as where every new session starts, not only a first-use fallback. */
  pinned?: true
}

/**
 * An enabled model service the Host does not offer, and why: its address is not confirmed on the Host computer yet, it
 * is at a preset provider's address, which always needs a key, and has none, or it speaks a protocol Latch no longer
 * does (`unsupported`: it can only be removed).
 */
export interface UnusableProvider {
  id: string
  name: string
  reason: 'origin-unconfirmed' | 'key-missing' | 'unsupported'
}

export type ProviderDestination = 'preset' | 'confirmed' | 'unconfirmed'

/** Owner-only provider configuration as returned to the browser. */
export interface ProviderSettings {
  modelCapabilities?: Record<string, ModelCapabilities>
  id: string
  name: string
  /** A retired protocol only for a service saved before it was: shown, removable, never editable or used. */
  kind: StoredProviderKind
  presetId?: string
  baseURL: string
  hasKey: boolean
  /** `scheme://host:port` the saved key may be sent to; present only with a usable key. */
  keyOrigin?: string
  /** The base URL path the saved key is bound to ('' at the root), with `keyOrigin`; absent from older Hosts. */
  keyPath?: string
  /**
   * Whether the Host sends requests to this address: a preset provider's HTTPS origin, an origin confirmed once on the
   * Host computer, or one not confirmed yet (saved, but never used until it is). Absent from older Hosts.
   */
  destination?: ProviderDestination
  enabled: boolean
  models: string[]
  defaultModel: string
  /** 「出错时改用」 by model, in order. */
  fallbacks?: Record<string, ModelFallback[]>
  /** The most requests this service is given at a time; absent, only the Host's own limit applies. */
  maxConcurrent?: number
  health?: ServiceHealth
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  activeRuns: number
  capabilities: string[]
  package?: { formatVersion: 1 | 2 }
  /** Local editable asset; its mutations use the plugin-packages receipt flow. */
  editable?: true
  /** Set when the Host manages the plugin from settings (model providers, agents). */
  managed?: 'provider' | 'agent' | 'core'
}
