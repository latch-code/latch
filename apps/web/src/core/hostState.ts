import { HOST_STATE_REASONS, type HostStateEvent, type HostStateReason } from '@latch/protocol'
import { ApiError } from './api.ts'

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
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * The state line shown while the Host does not answer, instead of a generic reconnecting message. `computer` is
 * `computerLabel`: 「这台 Mac」 in the Latch app there, the computer's name on any other device.
 */
export function hostNoticeCopy(notice: HostNotice, computer = 'Mac'): { title: string; body: string } {
  if (notice.state === 'sleeping') return { title: `${computer} 已休眠（${clock(notice.at)} 起）`, body: '唤醒后自动重连' }
  switch (notice.reason) {
    case 'restart':
      return { title: `${computer} 上的 Latch 正在重启`, body: '几秒后自动重连' }
    case 'update':
      return { title: `${computer} 上的 Latch 正在更新`, body: '更新完成后自动重连' }
    case 'sleep':
    case 'shutdown':
      return { title: `${computer} 上的 Latch 已停止（${clock(notice.at)} 起）`, body: 'Latch 启动后自动重连' }
  }
}

/** What the page says while the Host is not reached, from `navigator.onLine` alone. */
export const DEVICE_OFFLINE = '这台设备没有联网'

/** Why the last read of the Host failed, as far as the page can tell. */
export type ConnectionFailure = { kind: 'unreachable' } | { kind: 'host-error'; status: number } | { kind: 'refused'; message: string }

/** A failed read: no answer at all (or none in time), the Host answering with an error of its own, or a refusal it explained. */
export function connectionFailure(cause: unknown): ConnectionFailure {
  if (!(cause instanceof ApiError)) return { kind: 'unreachable' }
  return cause.status >= 500 ? { kind: 'host-error', status: cause.status } : { kind: 'refused', message: cause.message }
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
  if (connection === 'offline') return { title: DEVICE_OFFLINE, text: '' }
  if (hostProblem) return { title: hostProblem.text, text: notice?.body ?? '' }
  if (notice) return { title: notice.title, text: notice.body }
  if (failure?.kind === 'host-error') return { title: `${computer} 上的 Latch 出错（HTTP ${failure.status}）`, text: '' }
  if (failure?.kind === 'refused') return { title: failure.message, text: '' }
  return { title: `连不上 ${computer}，正在重连…`, text: '' }
}
