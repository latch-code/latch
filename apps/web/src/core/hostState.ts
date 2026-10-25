import { HOST_STATE_REASONS, type HostStateEvent, type HostStateReason } from '@latch/protocol'

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

/** The state line shown while the Host does not answer, instead of a generic reconnecting message. */
export function hostNoticeCopy(notice: HostNotice): { title: string; body: string } {
  if (notice.state === 'sleeping') return { title: `电脑已休眠（${clock(notice.at)} 起）`, body: '电脑唤醒后会自动重新连接。' }
  switch (notice.reason) {
    case 'restart':
      return { title: '电脑上的 Latch 正在重启', body: '几秒后会自动重新连接。' }
    case 'update':
      return { title: '电脑上的 Latch 正在更新', body: '更新完成后会自动重新连接。' }
    case 'sleep':
    case 'shutdown':
      return { title: `电脑上的 Latch 已停止（${clock(notice.at)} 起）`, body: 'Latch 再次启动后会自动重新连接。' }
  }
}
