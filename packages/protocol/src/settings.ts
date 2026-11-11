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
 * OpenAI's Responses, Anthropic's Messages or Gemini's generateContent.
 */
export const PROVIDER_KINDS = ['openai-compatible', 'openai-responses', 'anthropic', 'gemini'] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]
/** Browser-safe provider listing. It never contains credentials. */
export interface ProviderSummary {
  modelCapabilities?: Record<string, ModelCapabilities>
  id: string
  name: string
  /** `demo` and `plugin` providers are not editable in settings. */
  kind: ProviderKind | 'demo' | 'plugin'
  models: string[]
  defaultModel: string
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
  /** Host-read, display-only Git branch of the primary folder; omitted when metadata cannot be verified. */
  branch?: string
  /** The project lies in Latch's program directory: every Latch 内置 write asks for local approval, and ACP agents cannot start there. */
  codeRoot?: true
}

/** `GET workspaces/:id/worktree`: where a new worktree of the project's folder would start. */
export interface WorktreeBase {
  /** The folder's branch, as the Host shows branches; absent when HEAD is detached. */
  branch?: string
  /** The commit HEAD names. */
  commit: string
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
 * An enabled model service the Host does not offer, and why: its address is not confirmed on the Host computer yet, or
 * it is at a preset provider's address, which always needs a key, and has none.
 */
export interface UnusableProvider {
  id: string
  name: string
  reason: 'origin-unconfirmed' | 'key-missing'
}

export type ProviderDestination = 'preset' | 'confirmed' | 'unconfirmed'

/** Owner-only provider configuration as returned to the browser. */
export interface ProviderSettings {
  modelCapabilities?: Record<string, ModelCapabilities>
  id: string
  name: string
  kind: ProviderKind
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
