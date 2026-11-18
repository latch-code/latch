import { HOST_STATE_REASONS, type HostStateEvent, type HostStateReason } from '@latch/protocol'
import { ApiError } from './api.ts'
import { currentLocale, defineCopy } from './i18n.ts'

export const CONNECTION_COPY = defineCopy(
  {
    offline: '这台设备没有联网',
    sleeping: (computer: string, time: string) => `${computer} 已休眠（${time} 起）`,
    wake: '唤醒后自动重连',
    restarting: (computer: string) => `${computer} 上的 Latch 正在重启`,
    restart: '几秒后自动重连',
    updating: (computer: string) => `${computer} 上的 Latch 正在更新`,
    update: '更新完成后自动重连',
    stopped: (computer: string, time: string) => `${computer} 上的 Latch 已停止（${time} 起）`,
    start: 'Latch 启动后自动重连',
    error: (computer: string, status: number) => `${computer} 上的 Latch 出错（HTTP ${status}）`,
    reconnecting: (computer: string) => `连不上 ${computer}，正在重连…`,
  },
  {
    offline: 'This device is offline',
    sleeping: (computer: string, time: string) => `${computer} has been asleep since ${time}`,
    wake: 'Reconnecting when it wakes',
    restarting: (computer: string) => `Latch is restarting on ${computer}`,
    restart: 'Reconnecting in a few seconds',
    updating: (computer: string) => `Latch is updating on ${computer}`,
    update: 'Reconnecting after the update',
    stopped: (computer: string, time: string) => `Latch stopped on ${computer} at ${time}`,
    start: 'Reconnecting when Latch starts',
    error: (computer: string, status: number) => `Latch on ${computer} returned an error (HTTP ${status})`,
    reconnecting: (computer: string) => `Can’t reach ${computer}. Reconnecting…`,
  },
)

/** The Host's last announcement that it stopped answering: why, since when, and when to try again. */
export interface HostNotice {
  state: 'stopping' | 'sleeping'
  reason: HostStateReason
  /** ISO time the state began. */
  at: string
  /** Seconds between attempts until the Host answers again. */
  retryAfter: number
}

const STATES = new Set(['stopping', 'sleeping', 'awake'])
const MAX_RETRY_AFTER = 3600

/** A `host-state` frame, or undefined when it does not have the announced shape. */
export function parseHostState(data: string): HostStateEvent | undefined {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const event = value as Partial<HostStateEvent>
  if (event.type !== 'host-state' || typeof event.instanceId !== 'string' || !STATES.has(event.state ?? '')) return undefined
  if (typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) return undefined
  if (event.reason !== undefined && !HOST_STATE_REASONS.includes(event.reason)) return undefined
  if (
    event.retryAfter !== undefined
    && !(Number.isSafeInteger(event.retryAfter) && event.retryAfter >= 1 && event.retryAfter <= MAX_RETRY_AFTER)
  )
    return undefined
  if (event.state !== 'awake' && (event.reason === undefined || event.retryAfter === undefined)) return undefined
  return event as HostStateEvent
}

/** The notice a `stopping` or `sleeping` announcement leaves; null for `awake`. */
export function noticeOf(event: HostStateEvent): HostNotice | null {
  if (event.state === 'awake' || event.reason === undefined || event.retryAfter === undefined) return null
  return { state: event.state, reason: event.reason, at: event.at, retryAfter: event.retryAfter }
}

function clock(at: string): string {
  return new Date(at).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * The state line shown while the Host does not answer, instead of a generic reconnecting message. `computer` is
 * `computerLabel`: 「这台 Mac」 in the Latch app there, the computer's name on any other device.
 */
export function hostNoticeCopy(notice: HostNotice, computer = 'Mac'): { title: string; body: string } {
  if (notice.state === 'sleeping') return { title: CONNECTION_COPY.sleeping(computer, clock(notice.at)), body: CONNECTION_COPY.wake }
  switch (notice.reason) {
    case 'restart':
      return { title: CONNECTION_COPY.restarting(computer), body: CONNECTION_COPY.restart }
    case 'update':
      return { title: CONNECTION_COPY.updating(computer), body: CONNECTION_COPY.update }
    case 'sleep':
    case 'shutdown':
      return { title: CONNECTION_COPY.stopped(computer, clock(notice.at)), body: CONNECTION_COPY.start }
  }
}

/** Why the last read of the Host failed, as far as the page can tell. */
export type ConnectionFailure = { kind: 'unreachable' } | { kind: 'host-error'; status: number } | { kind: 'refused'; message: string }

/** A failed read: no answer at all (or none in time), the Host answering with an error of its own, or a refusal it explained. */
export function connectionFailure(cause: unknown): ConnectionFailure {
  if (!(cause instanceof ApiError)) return { kind: 'unreachable' }
  if (cause.status >= 500) return { kind: 'host-error', status: cause.status }
  return {
    kind: 'refused',
    get message() {
      return cause.message
    },
  }
}

/**
 * The connection banner's title and its one optional line, from what the page really knows and nothing more: the
 * browser says it has no network (`offline`), the Host announced why it stopped (`notice`), the desktop shell knows the
 * Host process (`hostProblem`), the Host answered with an error, or requests simply got no answer, which says nothing
 * about why.
 */
export function connectionWords(
  connection: 'offline' | 'reconnecting' | 'connecting' | 'connected',
  notice: { title: string; body: string } | null,
  hostProblem: { text: string } | null,
  failure: ConnectionFailure | null,
  computer: string,
): { title: string; text: string } {
  if (connection === 'offline') return { title: CONNECTION_COPY.offline, text: '' }
  if (hostProblem) return { title: hostProblem.text, text: notice?.body ?? '' }
  if (notice) return { title: notice.title, text: notice.body }
  if (failure?.kind === 'host-error') return { title: CONNECTION_COPY.error(computer, failure.status), text: '' }
  if (failure?.kind === 'refused') return { title: failure.message, text: '' }
  return { title: CONNECTION_COPY.reconnecting(computer), text: '' }
}
