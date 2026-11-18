import type { AgentMissedRun, AgentNotifications, HostComputerState } from '@latch/protocol'
import type { StatusTone } from '@latch/ui'
import { defineCopy } from '../core/i18n.ts'
import { whenWords } from './scheduleModel.ts'

const COPY = defineCopy(
  {
    completed: '完成',
    failed: '失败',
    waiting: '需要你处理',
    sleeping: '睡眠中',
    offline: '不在线',
    awake: '保持唤醒中',
    online: '在线',
    wakingForSchedule: '定时任务快到点了',
    wakingForSessions: '有会话在运行或等你处理',
    sleep: 'Mac 在睡眠',
    off: 'Mac 关机或 Latch 没有运行',
    unknown: '睡眠、关机或 Latch 没有运行',
    missed: (time: string, cause: string) => `${time}：${cause}`,
    appNotRunning: 'Latch 应用没有运行，现在不起作用',
  },
  {
    completed: 'Completed',
    failed: 'Failed',
    waiting: 'Needs you',
    sleeping: 'Asleep',
    offline: 'Offline',
    awake: 'Keeping awake',
    online: 'Online',
    wakingForSchedule: 'A scheduled run is due soon',
    wakingForSessions: 'Sessions are running or waiting for you',
    sleep: 'The Mac was asleep',
    off: 'The Mac was off or Latch wasn’t running',
    unknown: 'The Mac was asleep or off, or Latch wasn’t running',
    missed: (time: string, cause: string) => `${time} · ${cause}`,
    appNotRunning: 'Latch must be running to keep the Mac awake',
  },
)

/** Every notification on: what an Agent without its own choice gets, as before. */
export const ALL_NOTIFICATIONS: AgentNotifications = { completed: true, failed: true, waiting: true }

/** The three switches of 「通知」, in their order. */
export const NOTIFICATION_KINDS = ['completed', 'failed', 'waiting'] as const satisfies readonly (keyof AgentNotifications)[]
export const notificationLabel = (kind: keyof AgentNotifications) => COPY[kind]

/** The body of a change to one switch: back to the default (null) once every one is on again. */
export function notificationsPatch(
  current: AgentNotifications | undefined,
  key: keyof AgentNotifications,
  on: boolean,
): AgentNotifications | null {
  const next = { ...(current ?? ALL_NOTIFICATIONS), [key]: on }
  return next.completed && next.failed && next.waiting ? null : next
}

/** The times one schedule missed, for one row with its 立即运行. */
export interface MissedGroup {
  automationId: string
  name: string
  times: Array<{ at: string; words: string }>
}

export interface ComputerView {
  /** Only from what the Host recorded or announced: it answers, it said it sleeps, or the page cannot reach it. */
  status: { label: string; tone: StatusTone }
  /** Why it is kept awake, behind ⓘ. */
  awakeFor?: string
  /** 「上次唤醒 …」, when the desktop app reported a wake. */
  woke?: string
  missedTotal: number
  missed: MissedGroup[]
  /** Said next to 「到点前后保持唤醒」 when it is on but cannot work now. */
  keepAwakeNote?: string
}

/**
 * 「电脑」 of an Agent's profile. `sleeping`: the Host announced the computer going to sleep and the page has not reached
 * it since; `reachable`: the page reaches the Host now. Never 「永远在线」, and nothing the Host did not record.
 */
export function computerView(input: {
  reachable: boolean
  sleeping: boolean
  computer: HostComputerState | undefined
  missed: readonly AgentMissedRun[]
  keepAwakeOn: boolean
  now?: number
}): ComputerView {
  const { computer, now = Date.now() } = input
  const awake = !input.sleeping && input.reachable && Boolean(computer?.keepAwake)
  const status: ComputerView['status'] = input.sleeping
    ? { label: COPY.sleeping, tone: 'neutral' }
    : !input.reachable
      ? { label: COPY.offline, tone: 'warn' }
      : { label: awake ? COPY.awake : COPY.online, tone: 'done' }
  const groups = new Map<string, MissedGroup>()
  for (const run of input.missed) {
    const group = groups.get(run.automationId) ?? { automationId: run.automationId, name: run.name, times: [] }
    group.times.push({ at: run.at, words: COPY.missed(whenWords(run.at, now), COPY[run.cause]) })
    groups.set(run.automationId, group)
  }
  return {
    status,
    ...(awake ? { awakeFor: computer?.keepAwake === 'schedule' ? COPY.wakingForSchedule : COPY.wakingForSessions } : {}),
    ...(computer?.wokeAt ? { woke: whenWords(computer.wokeAt, now) } : {}),
    missedTotal: input.missed.length,
    missed: [...groups.values()],
    ...(input.keepAwakeOn && computer && !computer.desktop ? { keepAwakeNote: COPY.appNotRunning } : {}),
  }
}
