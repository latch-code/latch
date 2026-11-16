import type { BoardGroup, BoardPriority, BoardReason } from './board.ts'
import type { FileMention } from './file-refs.ts'
import type { ModelRef } from './settings.ts'

/**
 * Where the Host puts a 待办 on the board: `todo` (未开始) while it has no session, otherwise from its sessions
 * (docs/ARCHITECTURE.md#待办). `settled`: every session ended and the person has not marked it done.
 */
export interface WorkItemPlace {
  group: 'todo' | BoardGroup
  reason?: BoardReason | 'settled'
}

/** A 待办 as the snapshot lists it: everything but its prompt, which `GET /work/items/:id` and every write answer carry. */
export interface WorkItemSummary {
  /** `itm_` and 22 base64url characters. */
  id: string
  /** 1–120 code points, one line. */
  title: string
  /** The prompt is not empty: its first message when it starts. */
  hasPrompt?: true
  /** Suggestions for 开始; the start dialog shows them and the person may change them. A saved project, or `default`. */
  projectId?: string
  harnessId?: string
  model?: ModelRef
  /** `new`: start in a new worktree of the project; `project`: in the project's folder. */
  worktree?: 'new' | 'project'
  /** As for sessions: `normalizeBoardTags`, filters only. */
  tags?: string[]
  /** Set by a person only; absent is 中. */
  priority?: BoardPriority
  /** At most 16, in the order they joined. Code sessions only. */
  sessionIds: string[]
  /** Readable with the full data scope only: a session of it is or was private. Never cleared. */
  private?: true
  /** The person marked it done. */
  closedAt?: string
  createdAt: string
  updatedAt: string
  /** Grows with every change, membership included; `PATCH` and `DELETE` name the one they were made on. */
  revision: number
  /** Derived by the Host each time it is read, never stored. */
  board: WorkItemPlace
  /** Grows with every change of its thread (a post, a delivery settled); absent while it has none. Clients read it again. */
  threadRevision?: number
}

export interface WorkItem extends WorkItemSummary {
  /** 0–16,000 characters, as a session's first message. Read-only once it has a session. */
  prompt: string
}

export const WORK_ITEM_LIMITS = {
  items: 2000,
  sessions: 16,
  titleChars: 120,
  promptChars: 16_000,
} as const

/** `POST /link/api/work/items`: a 待办 that has not started. */
export interface WorkItemCreateInput {
  /** 8–128 of `A–Z a–z 0–9 _ -`; a retry with the same body gets the same 待办. */
  requestId: string
  title: string
  prompt?: string
  projectId?: string
  harnessId?: string
  model?: ModelRef
  worktree?: 'new' | 'project'
  tags?: string[]
  priority?: BoardPriority
}

/** `PATCH /link/api/work/items/:id`; null clears a suggestion. `prompt` only while it has no session. */
export interface WorkItemPatchInput {
  baseRevision: number
  title?: string
  prompt?: string
  projectId?: string | null
  harnessId?: string | null
  model?: ModelRef | null
  worktree?: 'new' | 'project' | null
  tags?: string[] | null
  /** `mid` is the default: the field goes. */
  priority?: BoardPriority | 'mid'
  /** 完成 (true) or 重新打开 (false). */
  closed?: boolean
}

/** `DELETE /link/api/work/items/:id`: the record only; its sessions stay. */
export interface WorkItemDeleteInput {
  baseRevision: number
}

/**
 * `POST /link/api/work/items/:id/start`: the choices of `POST /tasks`, without `customAgentId`, `forkOf`, `appDraft` or
 * `via`. Absent `prompt`, `workspaceId`, `harnessId`, `model` and `worktree` are taken from the 待办.
 */
export interface WorkItemStartInput {
  /** A UUID, as for `POST /tasks`; a retry with the same body gets the same session. */
  requestId: string
  /** The revision the person saw when pressing 开始; another is 409 `item-changed`, and nothing starts. */
  baseRevision: number
  prompt?: string
  harnessId?: string
  workspaceId?: string
  mode?: 'chat' | 'agent'
  model?: ModelRef
  ownModel?: true
  worktree?:
    | true
    | { from: 'head' }
    | { from: 'commit'; ref: string }
    | { from: 'branch'; branch: string }
    | { from: 'reuse'; name: string }
  config?: Array<{ configId: string; value: string }>
  fileRefs?: FileMention[]
  attachmentIds?: string[]
}

/** `POST /link/api/work/items/:id/sessions`: an existing session joins. */
export interface WorkItemSessionInput {
  sessionId: string
}

/** Every write but delete answers with the 待办 as it now stands. */
export interface WorkItemAnswer {
  item: WorkItem
}

export const WORK_THREAD_LIMITS = {
  posts: 500,
  postChars: 4000,
  /** What a delivered post's answer shows of the reply, and what an increment quotes of each part. */
  replyChars: 2000,
  /** All the quoted parts of one delivery together. */
  quotedChars: 8000,
} as const

/** Who a post is for: one session of the 待办, or one of 我的 Agent (`general` for 通用) in its one chat. */
export type WorkPostTarget = { sessionId: string } | { customAgentId: string }

/**
 * A delivered post: `sending` while the Host has not heard back; `sent` once the session holds it; `unknown` when that
 * could not be told (重试 sends the same request, and is never delivered twice); `failed` when it certainly was not.
 */
export interface WorkPostDelivery {
  /** The session it went to: for an Agent, its chat at the time. */
  sessionId: string
  state: 'sending' | 'sent' | 'unknown' | 'failed'
  /** Why it failed or is unknown, in the Host's words; never the text. */
  reason?: string
  code?: string
}

/** The session's answer to a delivered post: that turn's reply, cut to `replyChars`. Read from the session, never stored. */
export interface WorkPostReply {
  messageId: string
  text: string
  /** The reply goes on beyond `text`. */
  more?: true
  /** The turn is still running: `text` may grow. */
  live?: true
}

/** One post of a 待办's thread: only a person writes one. A reply is shown under it, never copied into the thread. */
export interface WorkPost {
  /** `pst_` and 22 base64url characters. */
  id: string
  at: string
  /** 1–4,000 characters, as the person wrote them. */
  text: string
  target?: WorkPostTarget
  delivery?: WorkPostDelivery
  reply?: WorkPostReply
  /** Only on the reading device's own posts: the request that made it, so 重试 can send it again. */
  requestId?: string
}

/** `GET /link/api/work/items/:id/posts`: oldest first. */
export interface WorkThreadAnswer {
  posts: WorkPost[]
  revision: number
}

/**
 * `POST /link/api/work/items/:id/posts`: one post, delivered to `target` when it names one. A retry with the same
 * `requestId` and body answers the same post and delivers it at most once.
 */
export interface WorkPostInput {
  /** 8–128 of `A–Z a–z 0–9 _ -`. */
  requestId: string
  text: string
  target?: WorkPostTarget
}

export interface WorkPostAnswer {
  post: WorkPost
}

/**
 * `POST /work/items/:id/start` answers 201 once the session exists. `outside`: it started but could not join (the 待办
 * filled up or was deleted meanwhile); it stands on its own, and `item` is absent when the 待办 is gone.
 */
export interface WorkItemStartAnswer {
  sessionId: string
  item?: WorkItem
  outside?: 'item-full' | 'item-gone'
}
