// What the engine hands its caller while it writes; the routes' answers are in @latch/protocol.
import type { FileMention } from '@latch/protocol'

/** What a discard covers: a turn's files (撤销此文件), or uncommitted changes (撤销全部改动…, or 撤销此文件 there). */
export type DiscardTarget = { scope: 'turn'; turnId: string; files: FileMention[] } | { scope: 'uncommitted'; files?: FileMention[] }

/**
 * An undo, redo or discard the engine is about to write. The caller records it in the audit log before any file
 * changes, and the engine writes nothing when that throws. Only ids, counts and a hash: never paths or content.
 */
export interface ChangeWritePlan {
  action: 'undo' | 'redo' | 'discard' | 'rewind'
  sessionId: string
  turnId?: string
  scope?: 'turn' | 'uncommitted'
  restore: number
  remove: number
  skipped: number
  /** SHA-256 over the folders, paths and target contents. */
  planHash: string
}
