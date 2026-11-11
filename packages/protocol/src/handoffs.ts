import type { FileMention } from './file-refs.ts'
import type { TaskMode } from './sessions.ts'
import type { ModelRef } from './settings.ts'

/** What one handoff may carry. Text is counted in UTF-8 bytes by the Host. */
export const HANDOFF_LIMITS = {
  materials: 32,
  /** All `text` materials together, and the text of the `message` materials the Host copies in. */
  materialBytes: 64 * 1024,
  requirementsBytes: 8 * 1024,
  decisions: 16,
  decisionChars: 1000,
  summaryChars: 16_000,
  evidence: 32,
} as const

/** SHA-256 of the UTF-8 text of a message, or of a file's bytes, in lowercase hex: the version the handoff names. */
export type HandoffHash = string

/** One thing chosen in the source session, carried into the target's first message as it is. */
export type HandoffMaterial =
  /** Paragraphs the person picked out of the source session, verbatim. */
  | { kind: 'text'; text: string }
  /** One whole message of the source session, fixed at this version. */
  | { kind: 'message'; messageId: string; hash: HandoffHash }
  /** A file in one of the source session's folders, fixed at this version; it reaches the target as a file reference. */
  | { kind: 'file'; file: FileMention; hash: HandoffHash }

/** What the target may hand back: nothing, a summary, or a summary with evidence from the target session. */
export type HandoffReturnScope = 'none' | 'summary' | 'summary-and-evidence'
/** The language of the target's first message, which the Host writes from a fixed template. */
export type HandoffLocale = 'zh-CN' | 'en'

export interface HandoffTarget {
  kind: 'new-session' | 'session'
  /** `session`: the existing session that receives the first message. */
  sessionId?: string
  /** `new-session`: the same choices as `POST /tasks`. */
  projectId?: string
  harnessId?: string
  mode?: TaskMode
  model?: ModelRef
  /** Start in a new Git worktree of the project's only folder. */
  worktree?: true
}

/**
 * `start-unknown`: a start without an answer; it may have made a session. `start-failed`: it definitely did not start.
 * `withdrawn`: given up before a target existed. `closed`: given up after the target started, which stays as it is.
 */
export type HandoffStatus = 'starting' | 'started' | 'start-unknown' | 'start-failed' | 'returned' | 'withdrawn' | 'closed'

export type HandoffEvidence =
  | { kind: 'file'; file: FileMention; hash: HandoffHash }
  | { kind: 'message'; messageId: string; hash: HandoffHash }
  /** Kept on record, but the reader of this view may not read it; nothing about it is said. */
  | { kind: 'withheld' }

export interface HandoffResult {
  /** Absent with `summaryWithheld`: the reader may not read the target session. */
  summary?: string
  summaryWithheld?: true
  evidence: HandoffEvidence[]
  at: string
  requestId: string
}

/** A handoff as one reader sees it: fields of a session this reader may not read are left out. */
export interface Handoff {
  id: string
  requestId: string
  sourceSessionId: string
  target: HandoffTarget
  targetSessionId?: string
  /** Absent when the reader may not read the source session. */
  materials?: HandoffMaterial[]
  requirements?: string
  decisions?: string[]
  returnScope: HandoffReturnScope
  locale: HandoffLocale
  status: HandoffStatus
  /** One of the two sessions was deleted: only IDs and state are kept. */
  contentRemoved?: true
  /** With `start-failed`, why; with `start-unknown`, why the last retry was refused. */
  failure?: { code: string; message: string }
  result?: HandoffResult
  createdAt: string
  updatedAt: string
}

/** `POST /handoffs`. */
export interface HandoffCreate {
  requestId: string
  sourceSessionId: string
  target: HandoffTarget
  materials: HandoffMaterial[]
  requirements: string
  decisions: string[]
  returnScope: HandoffReturnScope
  /** Default `zh-CN`. */
  locale?: HandoffLocale
}

/** `POST /handoffs/:id/return`. Evidence comes from the target session. */
export interface HandoffReturn {
  requestId: string
  summary: string
  evidence: Array<{ kind: 'file'; file: FileMention; hash: HandoffHash } | { kind: 'message'; messageId: string; hash: HandoffHash }>
}

/** `POST /handoffs/:id/withdraw`. */
export interface HandoffWithdraw {
  requestId: string
}

export interface HandoffList {
  handoffs: Handoff[]
}

/** What the snapshot carries for handoffs of sessions the reader can see. */
export interface HandoffSummary {
  id: string
  sourceSessionId: string
  targetSessionId?: string
  status: HandoffStatus
  returnScope: HandoffReturnScope
  updatedAt: string
}
