import type { ModelRef, PluginInfo, TaskMode, TaskSummary } from './types.ts'
import type { AttachmentRef } from './attachments.ts'
import type { AutomationRunState, AutomationSchedule, ScheduleResultOutcome } from './automations.ts'

/** The Host's one interactive conversation for an Agent. Absent from the projection until it can verify old history. */
export type PersonalAgentChat = { state: 'empty' | 'starting' } | { state: 'ready'; sessionId: string }

/** The bracket face: a pair of brackets around two eyes on a soft plate. */
export const AGENT_BRACKETS = ['round', 'curly', 'square', 'angle'] as const
export type AgentBracket = (typeof AGENT_BRACKETS)[number]
export const AGENT_EYES = ['dot', 'arc', 'oval', 'sleepy'] as const
export type AgentEyes = (typeof AGENT_EYES)[number]
/** Muted hues only: red, orange, yellow, bright green and bright blue already say something in the interface. */
export const AGENT_HUES = ['ink', 'slate', 'pine', 'plum', 'wisteria', 'cocoa', 'sand', 'moss', 'mist'] as const
export type AgentHue = (typeof AGENT_HUES)[number]
/**
 * The Host assigns a face when an agent is created; the user changes it. `kind: 'image'`: a picture the person gave it,
 * named by the SHA-256 of the Host's own re-encoded copy and read through `custom-agents/avatar-images/<hash>`; the face
 * stays as what is shown wherever the picture cannot be.
 */
export type AgentAvatar = AgentFace & ({ kind: 'face' } | { kind: 'image'; image: string })
export interface AgentFace {
  bracket: AgentBracket
  eyes: AgentEyes
  hue: AgentHue
}
/**
 * A picture for an Agent: what a person may give (`bytes` and `maxSide` at most, `minSide` at least), and the one square
 * size the Host keeps and serves, as its own PNG.
 */
export const AGENT_AVATAR_IMAGE = { bytes: 2 * 1024 * 1024, maxSide: 1024, minSide: 16, size: 256 } as const

export const GENERAL_AGENT_ID = 'general'
/**
 * What every Agent's turn may carry of 通用's confirmed memories (「认识你」): whole entries only, the newest first, at
 * most this many and this many UTF-8 bytes together.
 */
export const GENERAL_FACT_LIMITS = { count: 24, bytes: 6 * 1024 } as const

/** The Host's verified home hint, visible only to devices allowed to read this Agent's private data. */
export interface AgentHome {
  owner: string
  path: string
  available: boolean
  reason?: string
}

/** 名称、图标、说明、指令、技能、Harness 与模型 of one of 我的 Agent. */
export interface CustomAgentConfig {
  name: string
  description: string
  /** The engine, chosen once at creation: the Host refuses to change it (409 `agent-harness-fixed`). */
  harnessId: string
  /** Default mode on an engine that has several. */
  mode: TaskMode
  /** On engines that run on the Host's model services. Absent: the Host's default model. */
  model?: ModelRef
  /**
   * External engines' own defaults (their model, 思考 and 权限), as `configId` to value. Saved here and offered to the
   * Host, which applies them through the Harness's start configuration and verifies them before its first prompt.
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
/** Which of this Agent's notifications the desktop app sends: its topics and its scheduled runs. Absent: all of them. */
export interface AgentNotifications {
  completed: boolean
  failed: boolean
  /** 需要你处理: a request or a question waiting for the person. */
  waiting: boolean
}
export interface CustomAgent extends CustomAgentConfig {
  id: string
  /** Host-allocated path relative to its start directory. Clients cannot choose or change it. */
  home?: string
  avatar: AgentAvatar
  notifications?: AgentNotifications
  /**
   * 「到点前后保持唤醒」: the desktop app, while it runs, keeps this Mac from idle sleep shortly before each of this Agent's
   * scheduled runs until the run settles, within a cap. Absent: off. It never wakes a Mac that already sleeps.
   */
  keepAwakeForSchedules?: true
  /**
   * 「认识你」 turned off: this Agent's turns leave out what the person confirmed in 通用 (`generalFacts`). Absent: on.
   * Stored only as off.
   */
  generalFactsOff?: true
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
  /**
   * How many of 通用's confirmed memories this Agent's turns carry now, within `GENERAL_FACT_LIMITS` (0 while it is
   * off), and how many there are. Absent from older Hosts.
   */
  generalFacts?: { sent: number; total: number }
}
/** `avatar`: the face chosen while creating (never a picture); absent, the Host assigns an unused one. */
export type CustomAgentCreate = CustomAgentConfig & { requestId: string; avatar?: AgentAvatar }
/** `harnessId` may only repeat the Agent's own: another one is refused with 409 `agent-harness-fixed`. */
export type CustomAgentPatch = Partial<Omit<CustomAgentConfig, 'model' | 'tools' | 'defaultProjectId' | 'engineOptions'>> & {
  requestId: string
  baseRevision: number
  /** A face: choosing one also puts the face back in a picture's place. A picture is set only by its upload. */
  avatar?: AgentAvatar
  /** Null: back to every notification. */
  notifications?: AgentNotifications | null
  keepAwakeForSchedules?: boolean
  /** 「认识你」: false leaves 通用's confirmed memories out of this Agent's turns; true puts them back. */
  generalFacts?: boolean
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
  /** The Host's fixed home for new Standard Agent topics; existing topics keep their original directory. */
  home?: string
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

/** Who a proposal came from: the person's own 「记住…」, or the agent's `propose_memory`. */
export type MemoryOrigin = 'user' | 'agent'

/** Where a memory or a proposal came from: a topic, and the turn in it. */
export interface MemorySource {
  sessionId: string
  /** The user message of the turn it came from, when the Host knew it. */
  messageId?: string
  /** The request of that user message, for a proposal made from the person's own words. */
  requestId?: string
}

/** A memory saved from a proposal remembers that proposal. */
export interface AgentMemoryOrigin extends MemorySource {
  proposalId: string
  origin: MemoryOrigin
  external: boolean
  /** When it was proposed; the memory's own `createdAt` is when it was saved. */
  proposedAt: string
}

/** Written by the user only, used only by that agent. A tool can only propose one; the person saves it. */
export interface AgentMemory {
  id: string
  content: string
  revision: number
  createdAt: string
  updatedAt: string
  /** Present when it was saved from a proposal; an edit keeps it. */
  source?: AgentMemoryOrigin
  /** The person changed its text since it was saved from that proposal. */
  edited?: true
  /** It came with an imported Agent file (shown as 「导入」): who wrote it there, and when it was saved there. */
  imported?: { origin: MemoryOrigin; external: boolean; savedAt: string }
  /**
   * 「设为我说的」: the person confirmed an imported memory, or one saved from outside content, as their own words. Until
   * then such a memory reaches the Agent as material, never under the person's own heading.
   */
  owned?: true
}

/**
 * Whether a memory is material rather than the person's own words: it came with an imported file or was saved from a
 * proposal marked as from outside content, and the person has not confirmed it as their own.
 */
export function outsideMemory(memory: Pick<AgentMemory, 'source' | 'imported' | 'owned'>): boolean {
  return memory.owned !== true && (memory.imported !== undefined || memory.source?.external === true)
}

/** The one file 「导出」 writes and 「导入」 reads. */
export const AGENT_FILE_FORMAT = 'latch-agent'
export const AGENT_FILE_VERSION = 1
/** The largest portable file that can be exported or imported, in bytes. */
export const AGENT_FILE_BYTES = 4 * 1024 * 1024
/** How many schedules a file may carry. */
export const AGENT_FILE_SCHEDULES = 16
export interface AgentFileMemory {
  content: string
  /** When it was saved on the computer it came from. */
  savedAt: string
  origin: MemoryOrigin
  external: boolean
}
/** A schedule as a definition: what and when. It is imported switched off. */
export interface AgentFileSchedule {
  name: string
  prompt: string
  schedule: AutomationSchedule
  notify: boolean
}
/**
 * An Agent as a file: its definition, its confirmed memories with where each came from, and its schedules as
 * definitions. Nothing of a computer's own: no model service, project, plugin, skill or MCP choice, no secret, token,
 * device or audit record, no topic, proposal or image.
 */
export interface AgentFile {
  format: typeof AGENT_FILE_FORMAT
  version: typeof AGENT_FILE_VERSION
  exportedAt: string
  agent: {
    name: string
    description: string
    harnessId: string
    mode: TaskMode
    instructions: string
    /** The bracket face only. */
    avatar: AgentFace
  }
  memories: AgentFileMemory[]
  schedules: AgentFileSchedule[]
  /** Left out by the export because their text looked like a secret: how many memories, and how many schedules. */
  omitted?: { secretMemories: number; secretSchedules?: number }
}
/** What 「导出」 shows before anything is downloaded: how much the file would hold and what would be left out. */
export interface AgentExportPreview {
  memories: number
  schedules: number
  omitted: { secretMemories: number; secretSchedules: number }
}
/** What the import page shows before anything is created: the file as the Host read it, and what this computer can do with it. */
export interface AgentImportPreview {
  file: AgentFile
  harness: { id: string; ready: boolean; label?: string }
  /** Whether its schedules can be imported here (switched off); otherwise they are left out. */
  canSchedule: boolean
  /** An Agent of this name exists already; the import still creates a new one. */
  nameTaken: boolean
}
/** `file`: the parsed JSON of the chosen file, as it is. */
export interface AgentImportRequest {
  requestId: string
  file: unknown
}
export interface AgentImportResult {
  agent: CustomAgent
  memories: number
  schedules: number
}

/**
 * What `propose_schedule` offers: a schedule for the person to open in the schedule editor and save there. `content` of
 * its proposal is the input each run would get.
 */
export interface ScheduleProposalPlan {
  name: string
  plan: AutomationSchedule
}

/**
 * Something the agent or the person's 「记住…」 offered to remember, or (`kind: 'schedule'`) a schedule the agent offered
 * to set up. Nothing is saved until the person saves it; there is no automatic saving. `external`: a tool that read
 * outside content ran in that turn before it, or the Host could not tell.
 */
export interface MemoryProposal {
  id: string
  /** Absent: a memory. */
  kind?: 'schedule'
  /** A schedule proposal: its name and when; `content` is each run's input. */
  schedule?: ScheduleProposalPlan
  content: string
  /** The agent's reason, when it gave one. */
  reason?: string
  origin: MemoryOrigin
  external: boolean
  source: MemorySource
  state: 'pending' | 'saved' | 'dismissed'
  createdAt: string
  updatedAt: string
  /** The memory it became. */
  memoryId?: string
  /** A schedule proposal: the schedule the person saved from it. */
  automationId?: string
}
export interface MemoryProposalList {
  proposals: MemoryProposal[]
}
/** Saving or dismissing a proposal; a retry with the same `requestId` gets the same answer. */
export interface MemoryProposalDecision {
  requestId: string
}
/**
 * What a save or dismiss answers. A retry is answered from its receipt alone, so `proposal` and `memory` are absent once
 * they are gone (the proposal dropped for room, the memory deleted since).
 */
export interface MemoryProposalResult {
  proposalId: string
  /** Save: the memory it became. */
  memoryId?: string
  proposal?: MemoryProposal
  memory?: AgentMemory
}
/** 撤销 and 清除 of a memory's last change: the revision the person saw, so a change made elsewhere since is not undone. */
export interface AgentMemoryUndo {
  requestId: string
  baseRevision: number
}

/** The last edit or delete of a memory, kept as one step to undo; a delete's text only for `MEMORY_UNDO_DAYS`. */
export const MEMORY_UNDO_DAYS = 7
export interface AgentMemoryChange {
  memoryId: string
  operation: 'update' | 'delete'
  at: string
  /** The memory as it was before. */
  previous: AgentMemory
}
/** What the snapshot says of an owner's proposals, so a page reads them again when they change. */
export interface AgentProposalState {
  pending: number
  /** When any of them last changed. */
  at: string
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
  /** Each memory's last edit or delete that can still be undone, newest first. */
  memoryChanges: AgentMemoryChange[]
  sessions: TaskSummary[]
}
export interface GeneralAgentDetail {
  general: GeneralAgent
  memories: AgentMemory[]
  memoryChanges: AgentMemoryChange[]
}

/**
 * One row of an Agent's 动态, derived from the Host's own records (sessions, schedule runs, result cards, memories and
 * proposals); never invented, never a memory's or a proposal's text.
 */
export type AgentActivityItem =
  | { kind: 'topic'; id: string; at: string; sessionId: string; title: string }
  | {
      kind: 'run'
      id: string
      at: string
      automationId: string
      name: string
      state: AutomationRunState
      sessionId?: string
    }
  | { kind: 'result'; id: string; at: string; resultId: string; name: string; outcome: ScheduleResultOutcome; topicId?: string }
  | { kind: 'memory'; id: string; at: string; change: 'added' | 'updated' | 'deleted'; memoryId: string }
  /** The agent searched its own saved memories (`recall_memory`) in a turn: how many times, never the words. */
  | { kind: 'recall'; id: string; at: string; sessionId: string; count: number }
  | {
      kind: 'proposal'
      id: string
      at: string
      proposalId: string
      proposal: 'memory' | 'schedule'
      state: MemoryProposal['state']
      sessionId: string
    }
export interface AgentActivityPage {
  items: AgentActivityItem[]
  /** Pass as `before` for the next page; absent on the last. */
  next?: string
}

/**
 * One file of an Agent's 资料库: a file one of its sessions changed or produced (from the session's changes and the turns'
 * observed outputs), or an attachment the person gave it. Opened through the session it belongs to, under that session's
 * file rules.
 */
export type AgentLibraryItem =
  | {
      kind: 'file'
      sessionId: string
      root: string
      path: string
      change: 'created' | 'modified' | 'deleted'
      at: string
    }
  | { kind: 'attachment'; sessionId: string; messageId: string; attachment: AttachmentRef; at: string }
/** The files of one session, newest session first. */
export interface AgentLibraryGroup {
  sessionId: string
  title: string
  at: string
  /** A run of this schedule, not a topic. */
  automationId?: string
  items: AgentLibraryItem[]
  /** More files than a group lists. */
  more?: number
}
export interface AgentLibraryPage {
  groups: AgentLibraryGroup[]
  next?: string
}

/**
 * What the Host recorded about the computer it runs on, from the desktop app's own reports (sleep, wake and what it keeps
 * awake). A Host without the desktop app knows only that it answers.
 */
export interface HostComputerState {
  /** When the desktop app last reported this Mac waking up. */
  wokeAt?: string
  /** The desktop app on this Mac reported within the last minute. */
  desktop: boolean
  /** What the desktop app keeps this Mac awake for now: sessions at work, or a scheduled time. Absent: nothing. */
  keepAwake?: 'busy' | 'schedule'
}
/** A scheduled time one of an Agent's schedules missed since that schedule last really ran. */
export interface AgentMissedRun {
  automationId: string
  name: string
  /** The scheduled time. */
  at: string
  /**
   * Only what the Host's records show: `sleep`, inside a sleep the desktop app reported from start to wake; `off`, while
   * this Host was stopped in order; `unknown`, no record covers it.
   */
  cause: 'sleep' | 'off' | 'unknown'
}
/** 「电脑」 of an Agent's profile: `GET /custom-agents/:id/computer`, for devices that may read Agents. */
export interface AgentComputer {
  computer: HostComputerState
  /** Newest first. */
  missed: AgentMissedRun[]
}

export interface SessionAgentRef {
  customAgentId: string
}

/**
 * What an external engine was sent as its first-turn context: each part keeps who wrote it, so a client can show Latch's
 * framing apart from the user's words, and both apart from `material` (imported memories and ones saved from outside
 * content, which are not the person's words). Joined with newlines, these are exactly the characters sent.
 */
export interface AgentBrief {
  segments: Array<{ source: 'latch' | 'user' | 'material'; text: string }>
}

/** A block a first-turn driver sends once per change: `key` is the SHA-256 of `segments`. */
export interface AgentNote {
  key: string
  segments: AgentBrief['segments']
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
  /** The explicit 通用 chat in Standard; persistent alongside the accepted first message. */
  generalChat?: true
  /** Profile model for a canonical Standard chat's next turn, overridden by an explicit request model. */
  defaultModel?: ModelRef
  /** Host-frozen capability revisions for delegated or scheduled execution. */
  expectedRevisions?: Record<string, string>
  /** System context for drivers with `agentContext: 'private'`. */
  instructions: string
  /** First-turn block for drivers with `agentContext: 'first-turn'`. */
  brief?: AgentBrief
  /**
   * For drivers with `agentContext: 'first-turn'`: what the Agent's own schedules and handoffs did lately
   * (docs/CUSTOM-AGENTS.md#它做过什么). Sent before the next turn's input whenever `key` differs from the last one this
   * context carried; a fresh context sends it again. Drivers with `private` get it inside `instructions`.
   */
  note?: AgentNote
  /** For a driver with `skills: 'server'`, which attaches a read-only skills server at session start. */
  skillBodies?: AgentSkillBody[]
  /** Plugins whose tools it may call, and with no `skillIds`, whose skills it may load. Absent: every enabled plugin. */
  pluginIds?: string[]
  /** `pluginId:skillId`. Absent: the skills of `pluginIds`. */
  skillIds?: string[]
  /**
   * A session of one of 我的 Agent or a conversation with 通用: its agent may propose memories (`propose_memory`), which
   * the Host keeps pending until the person saves one. Set by the Host only.
   */
  proposals?: true
  /** A scheduled run nobody is watching: whatever it proposes is marked external. Set by the Host only. */
  unattended?: true
  revision: string
}
