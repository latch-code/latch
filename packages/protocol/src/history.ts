/**
 * Bringing a session a harness had before Latch into Latch (docs/HARNESSES.md#接入已有会话). Everything comes through the
 * harness's own adapter (`session/list`, `session/load`); the Host never reads a harness's own files.
 */

/** Why a harness cannot list its sessions here. */
export type HistorySourceReason = 'not-enabled' | 'unavailable'

/** `GET /history/sources?projectId=`. */
export interface HistorySources {
  sources: Array<{ harnessId: string; label: string; available: boolean; reason?: HistorySourceReason }>
}

/** One session the harness lists in the project's primary folder or below it: metadata only, no content. */
export interface HistoryRow {
  /** Opaque, for this device, for ten minutes. */
  handle: string
  title: string
  updatedAt?: string
  /** Relative to the project's primary folder; empty in the folder itself. */
  subdir: string
  /** Already brought in: open this session instead. */
  importedTaskId?: string
}

/** `POST /history/list` `{ projectId, harnessId }`. */
export interface HistoryList {
  rows: HistoryRow[]
  /** Sessions in the project's other folders, which cannot be brought in yet; never their titles. */
  otherFolders: number
  /**
   * Sessions in the primary folder or below it that are not listed because they hold folder grants of their own, which
   * bringing one in would rewrite; never their titles. Absent: none.
   */
  withheld?: number
  /** How many the harness listed before the Host filtered them. */
  scanned: number
  /** The scan stopped at its bound (500 sessions or 20 seconds). */
  truncated: boolean
}

/** One message of a preview: user and agent text, and tool calls by title and status only. */
export interface HistoryPreviewMessage {
  role: 'user' | 'assistant' | 'tool'
  text: string
  /** Tool: its output is never shown. */
  outputHidden?: true
  status?: 'running' | 'completed' | 'failed' | 'cancelled'
  /** The text was cut to 4 KiB. */
  clipped?: true
}

/** `POST /history/previews` `{ handle }`: one explicit `session/load`, read-only. */
export interface HistoryPreview {
  previewId: string
  title: string
  model?: string
  turns: number
  /** The last messages, at most 40, newest last. */
  messages: HistoryPreviewMessage[]
  /** Older messages exist than the preview shows. */
  truncated: boolean
  /** The harness does not say whether a session is in use: Latch cannot tell that this one is open nowhere else. */
  useUnknown?: true
}

/** `POST /history/imports` and `GET /history/imports/:requestId`. */
export interface HistoryImportResult {
  requestId: string
  taskId: string
  mode: 'native' | 'text'
}
