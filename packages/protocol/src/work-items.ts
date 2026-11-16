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

/**
 * `POST /work/items/:id/start` answers 201 once the session exists. `outside`: it started but could not join (the 待办
 * filled up or was deleted meanwhile); it stands on its own, and `item` is absent when the 待办 is gone.
 */
export interface WorkItemStartAnswer {
  sessionId: string
  item?: WorkItem
  outside?: 'item-full' | 'item-gone'
}
