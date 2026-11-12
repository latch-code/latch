import type { ModelRef, PluginInfo, TaskMode, TaskSummary } from './types.ts'

/** The bracket face: a pair of brackets around two eyes on a soft plate. */
export const AGENT_BRACKETS = ['round', 'curly', 'square', 'angle'] as const
export type AgentBracket = (typeof AGENT_BRACKETS)[number]
export const AGENT_EYES = ['dot', 'arc', 'oval', 'sleepy'] as const
export type AgentEyes = (typeof AGENT_EYES)[number]
/** Muted hues only: red, orange, yellow, bright green and bright blue already say something in the interface. */
export const AGENT_HUES = ['ink', 'slate', 'pine', 'plum', 'wisteria', 'cocoa', 'sand', 'moss', 'mist'] as const
export type AgentHue = (typeof AGENT_HUES)[number]
/** The Host assigns one when an agent is created; the user changes it. `kind` leaves room for another kind later. */
export interface AgentAvatar {
  kind: 'face'
  bracket: AgentBracket
  eyes: AgentEyes
  hue: AgentHue
}

export const GENERAL_AGENT_ID = 'general'

/** 名称、图标、说明、指令、技能、Harness 与模型 of one of 我的 Agent. */
export interface CustomAgentConfig {
  name: string
  description: string
  /** The engine. A session's engine is fixed once it starts. */
  harnessId: string
  /** Default mode on an engine that has several. */
  mode: TaskMode
  /** On engines that run on the Host's model services. Absent: the Host's default model. */
  model?: ModelRef
  /**
   * External engines' own defaults (their model, 思考 and 权限), as `configId` to value. Saved here and offered to the
   * client that starts the session, which sets them through the session's config route, under that route's checks.
   */
  engineOptions?: Record<string, string>
  /** What you wrote. The built-in engine gets it as a system prompt; external engines get it in the first-turn block. */
  instructions: string
  /** `pluginId:skillId` from `catalog.skills`. */
  skills: string[]
  /** 「可以使用」, built-in engine only: plugin IDs whose tools it may call. Absent: every enabled plugin. */
  tools?: string[]
  /** Project a new session starts in unless the client names another. */
  defaultProjectId?: string
}
export interface CustomAgent extends CustomAgentConfig {
  id: string
  avatar: AgentAvatar
  revision: number
  createdAt: string
  updatedAt: string
}
/** Without instructions or skills: they stay in the detail route, behind the same gates as the memories. */
export type CustomAgentSummary = Omit<CustomAgent, 'instructions' | 'skills' | 'tools' | 'createdAt' | 'updatedAt'> & {
  skillCount: number
  memoryCount: number
  sessionCount: number
  /** Whether a session can start on it now; `unavailableReason` says why not. */
  available: boolean
  unavailableReason?: string
  /** Automations run on the built-in engine only. */
  canAutomate: boolean
}
export type CustomAgentCreate = CustomAgentConfig & { requestId: string }
export type CustomAgentPatch = Partial<Omit<CustomAgentConfig, 'model' | 'tools' | 'defaultProjectId' | 'engineOptions'>> & {
  requestId: string
  baseRevision: number
  avatar?: AgentAvatar
  model?: ModelRef | null
  engineOptions?: Record<string, string> | null
  tools?: string[] | null
  defaultProjectId?: string | null
}

/**
 * 通用: the built-in agent. What you add applies to every session that picks no other agent; it has no engine of its
 * own, since those sessions choose one.
 */
export interface GeneralAgent {
  id: typeof GENERAL_AGENT_ID
  instructions: string
  /** Absent until you choose: such sessions load every enabled skill. An array, empty included, is exactly those. */
  skills?: string[]
  revision: number
  updatedAt?: string
}
export interface GeneralAgentPatch {
  requestId: string
  baseRevision: number
  instructions?: string
  skills?: string[] | null
}

/** Written by the user only, used only by that agent. No tool writes it and no other agent reads it. */
export interface AgentMemory {
  id: string
  content: string
  revision: number
  createdAt: string
  updatedAt: string
}
export interface AgentMemoryCreate {
  requestId: string
  content: string
}
export interface AgentMemoryPatch {
  requestId: string
  baseRevision: number
  content: string
}

export interface CustomAgentList {
  general: GeneralAgent & { memoryCount: number }
  agents: CustomAgentSummary[]
  /** Enabled plugins, for 「可以使用」: identity and capability names only, so no admin scope is needed to choose among them. */
  plugins: Array<Pick<PluginInfo, 'id' | 'name' | 'description' | 'capabilities'>>
}
export interface CustomAgentDetail {
  agent: CustomAgentSummary & Pick<CustomAgent, 'instructions' | 'skills' | 'tools' | 'createdAt' | 'updatedAt'>
  memories: AgentMemory[]
  sessions: TaskSummary[]
}
export interface GeneralAgentDetail {
  general: GeneralAgent
  memories: AgentMemory[]
}

export interface SessionAgentRef {
  customAgentId: string
}

/**
 * What an external engine was sent as its first-turn context: each part keeps who wrote it, so a client can show Latch's
 * framing apart from the user's words. Joined with newlines, these are exactly the characters sent.
 */
export interface AgentBrief {
  segments: Array<{ source: 'latch' | 'user'; text: string }>
}

/** A skill's text, handed only to a driver that serves skills to its engine (`HarnessInfo.skills: 'server'`). */
export interface AgentSkillBody {
  id: string
  name: string
  description: string
  content: string
}

/** Host-to-driver context; never accepted as authority from an HTTP client or included in public messages. */
export interface AgentExecutionContext {
  /** The session belongs to this agent. Absent on a 通用 session, which has no agent but is just as private. */
  agent?: SessionAgentRef
  /** Host-frozen capability revisions for delegated or scheduled execution. */
  expectedRevisions?: Record<string, string>
  /** System context for drivers with `agentContext: 'private'`. */
  instructions: string
  /** First-turn block for drivers with `agentContext: 'first-turn'`. */
  brief?: AgentBrief
  /** For a driver with `skills: 'server'`, which attaches a read-only skills server at session start. */
  skillBodies?: AgentSkillBody[]
  /** Plugins whose tools it may call, and with no `skillIds`, whose skills it may load. Absent: every enabled plugin. */
  pluginIds?: string[]
  /** `pluginId:skillId`. Absent: the skills of `pluginIds`. */
  skillIds?: string[]
  revision: string
}
