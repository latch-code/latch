/**
 * A computer the desktop app reaches: this Mac's Host over host.sock (`local`) or another computer's over HTTPS.
 * `stopping`/`sleeping` come from that Host's own announcement; `revoked`: that computer removed this device;
 * `wrong-host`: another Host answers at its address; `cert-error`: its certificate is not trusted; `cert-changed`: its
 * trusted certificate is not the one it was added with (renewed, or another server); `outdated`: its Latch is too old
 * to say who it is.
 */
export type ComputerState =
  | 'online'
  | 'connecting'
  | 'offline'
  | 'stopping'
  | 'sleeping'
  | 'revoked'
  | 'wrong-host'
  | 'cert-error'
  | 'cert-changed'
  | 'outdated'

/** What waits on the person in a session of another computer: a request, a question, or a run stuck or silent. */
export type AttentionKind = 'approval' | 'question' | 'stuck'

/**
 * One session of another computer that waits on the person, as main read it from that Host's authenticated snapshot.
 * Only these fields cross computers: no message, path, argument or project (the unified list's `ComputerSession`
 * carries a project's ID and name, to this Mac's page only).
 */
export interface AttentionItem {
  hostId: string
  taskId: string
  /** The session's title, one line of at most 80 characters; empty for an untitled session. */
  title: string
  kind: AttentionKind
  /** When it began to wait (ISO). */
  since: string
}

/** Where a session of another computer stands, in one word: as the sidebar's row would say it. */
export type ComputerSessionStatus = 'waiting' | 'running' | 'failed' | 'idle'

/**
 * One session of another computer for this Mac's unified list, as main read it from that Host's authenticated snapshot
 * through that Host's own connection. Only these fields cross: no message, path, folder, argument or model.
 */
export interface ComputerSession {
  taskId: string
  /** One line of at most 80 characters; empty for an untitled session. */
  title: string
  status: ComputerSessionStatus
  /** When it last changed (ISO). */
  updatedAt: string
  /** Its saved project there, by that Host's ID and name; absent for a session outside a project. */
  project?: { id: string; name: string }
}

/**
 * A computer as the desktop app's pages see it. `waiting` and `running` come only to this Mac's own page and only for
 * other computers; they are what main last read, live only while `state` is `online` (otherwise from before it went).
 */
export interface ComputerSummary {
  hostId: string
  name: string
  local: boolean
  state: ComputerState
  lastSeenAt?: string
  version?: string
  reason?: 'restart' | 'update' | 'sleep' | 'shutdown'
  /** Only on this Mac's own page. */
  origin?: string
  /** The newest 50 sessions that wait on the person there. */
  waiting?: AttentionItem[]
  /** Sessions running there without waiting on the person. */
  running?: number
  /** Only on this Mac's own page: its newest Code sessions as main last read them (stale unless `state` is `online`). */
  sessions?: ComputerSession[]
}
