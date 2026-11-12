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
 * Only these fields cross computers: no message, path, argument or project.
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
}
