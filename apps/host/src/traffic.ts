import type { ListenerClass } from '@latch/protocol'

/** Upper bounds in bytes of the size histogram's buckets; one more bucket counts anything larger. */
export const TRAFFIC_BUCKETS: readonly number[] = [256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304]
/** Event-stream frames by event type, then the two responses a client resynchronises with. */
export const TRAFFIC_KINDS = [
  'task-state',
  'task-delta',
  'tasks-invalidated',
  'refresh',
  'host-state',
  'app.data',
  'app.updated',
  'heartbeat',
  'snapshot',
  'detail',
] as const
export type TrafficKind = (typeof TRAFFIC_KINDS)[number]
export type FrameKind = Exclude<TrafficKind, 'snapshot' | 'detail'>

const MAX_SESSIONS = 1000
const MAX_CLOSED = 100

export interface TrafficCount {
  count: number
  bytes: number
  /** `TRAFFIC_BUCKETS.length + 1` counts. */
  histogram: number[]
}

export interface SessionTraffic {
  sessionId: string
  /** Event-stream frames naming this session (`task-state`, `task-delta`, `tasks-invalidated`), over all connections. */
  frames: number
  frameBytes: number
  /** Responses to `GET /tasks/:id`. */
  details: number
  detailBytes: number
}

/** One event stream. `frames` and `bytes` include its heartbeats. */
export interface ConnectionTraffic {
  /** Counts up from 1 within one Host run. */
  id: number
  listener: ListenerClass
  openedAt: string
  closedAt?: string
  frames: number
  bytes: number
  heartbeats: number
}

/**
 * Bytes the Host sent since it started: the text of each event-stream frame and the body of each snapshot and session
 * detail response. HTTP headers, chunked framing and TLS records are not counted. Numbers, enums and session IDs only.
 */
export interface TrafficSummary {
  since: string
  at: string
  buckets: number[]
  kinds: Record<TrafficKind, TrafficCount>
  /** At most 1000 sessions, most bytes first. */
  sessions: SessionTraffic[]
  /** Open streams, then up to 100 recently closed ones, newest first. */
  connections: ConnectionTraffic[]
}

/** The meter's handle for one event stream. */
export interface StreamMeter {
  readonly id: number
}

function emptyCount(): TrafficCount {
  return { count: 0, bytes: 0, histogram: Array.from({ length: TRAFFIC_BUCKETS.length + 1 }, () => 0) }
}

function bucketOf(bytes: number): number {
  const index = TRAFFIC_BUCKETS.findIndex(bound => bytes <= bound)
  return index < 0 ? TRAFFIC_BUCKETS.length : index
}

/** In-memory counters, reset when the Host restarts; the baseline for measuring later changes to synchronisation. */
export class TrafficMeter {
  private readonly since: number
  private readonly kinds: Record<TrafficKind, TrafficCount> = {
    'task-state': emptyCount(),
    'task-delta': emptyCount(),
    'tasks-invalidated': emptyCount(),
    refresh: emptyCount(),
    'host-state': emptyCount(),
    'app.data': emptyCount(),
    'app.updated': emptyCount(),
    heartbeat: emptyCount(),
    snapshot: emptyCount(),
    detail: emptyCount(),
  }
  /** Least recently counted first. */
  private readonly sessions = new Map<string, SessionTraffic>()
  private readonly open = new Map<number, ConnectionTraffic>()
  private readonly closed: ConnectionTraffic[] = []
  private nextId = 1

  constructor(private readonly now: () => number = Date.now) {
    this.since = now()
  }

  /** Starts counting a new event stream. */
  stream(listener: ListenerClass): StreamMeter {
    const connection: ConnectionTraffic = {
      id: this.nextId++,
      listener,
      openedAt: new Date(this.now()).toISOString(),
      frames: 0,
      bytes: 0,
      heartbeats: 0,
    }
    this.open.set(connection.id, connection)
    return { id: connection.id }
  }

  /** One frame written to a stream; `sessionId` for frames that name a session. */
  frame(stream: StreamMeter, kind: FrameKind, bytes: number, sessionId?: string): void {
    this.add(kind, bytes)
    const connection = this.open.get(stream.id)
    if (connection) {
      connection.frames++
      connection.bytes += bytes
      if (kind === 'heartbeat') connection.heartbeats++
    }
    if (sessionId !== undefined) {
      const session = this.session(sessionId)
      session.frames++
      session.frameBytes += bytes
    }
  }

  /** One response body: the snapshot, or a session's detail. */
  response(kind: 'snapshot' | 'detail', bytes: number, sessionId?: string): void {
    this.add(kind, bytes)
    if (kind === 'detail' && sessionId !== undefined) {
      const session = this.session(sessionId)
      session.details++
      session.detailBytes += bytes
    }
  }

  /** The stream ended; idempotent. */
  close(stream: StreamMeter): void {
    const connection = this.open.get(stream.id)
    if (!connection) return
    this.open.delete(stream.id)
    connection.closedAt = new Date(this.now()).toISOString()
    this.closed.unshift(connection)
    if (this.closed.length > MAX_CLOSED) this.closed.length = MAX_CLOSED
  }

  summary(): TrafficSummary {
    return structuredClone({
      since: new Date(this.since).toISOString(),
      at: new Date(this.now()).toISOString(),
      buckets: [...TRAFFIC_BUCKETS],
      kinds: this.kinds,
      sessions: [...this.sessions.values()].toSorted((a, b) => b.frameBytes + b.detailBytes - (a.frameBytes + a.detailBytes)),
      connections: [...[...this.open.values()].toReversed(), ...this.closed],
    })
  }

  private add(kind: TrafficKind, bytes: number): void {
    const count = this.kinds[kind]
    count.count++
    count.bytes += bytes
    const bucket = bucketOf(bytes)
    count.histogram[bucket] = (count.histogram[bucket] ?? 0) + 1
  }

  private session(sessionId: string): SessionTraffic {
    let session = this.sessions.get(sessionId)
    if (session) this.sessions.delete(sessionId)
    else session = { sessionId, frames: 0, frameBytes: 0, details: 0, detailBytes: 0 }
    this.sessions.set(sessionId, session)
    if (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!)
    return session
  }
}
