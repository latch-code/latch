import type { AgentMissedRun, AgentNotifications, HostComputerState } from '@latch/protocol'
import type { StatusTone } from '@latch/ui'
import { whenWords } from './scheduleModel.ts'

/** Every notification on: what an Agent without its own choice gets, as before. */
export const ALL_NOTIFICATIONS: AgentNotifications = { completed: true, failed: true, waiting: true }

/** The three switches of 「通知」, in their order. */
export const NOTIFICATION_KINDS: ReadonlyArray<{ key: keyof AgentNotifications; label: string }> = [
  { key: 'completed', label: '完成' },
  { key: 'failed', label: '失败' },
  { key: 'waiting', label: '需要你处理' },
]

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
  status: { label: '在线' | '睡眠中' | '保持唤醒中' | '不在线'; tone: StatusTone }
  /** Why it is kept awake, behind ⓘ. */
  awakeFor?: string
  /** 「上次唤醒 …」, when the desktop app reported a wake. */
  woke?: string
  missedTotal: number
  missed: MissedGroup[]
  /** Said next to 「到点前后保持唤醒」 when it is on but cannot work now. */
  keepAwakeNote?: string
}

const CAUSE: Record<AgentMissedRun['cause'], string> = {
  sleep: 'Mac 在睡眠',
  off: 'Mac 关机或 Latch 没有运行',
  unknown: '睡眠、关机或 Latch 没有运行',
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
  const status: ComputerView['status'] = input.sleeping
    ? { label: '睡眠中', tone: 'neutral' }
    : !input.reachable
      ? { label: '不在线', tone: 'warn' }
      : computer?.keepAwake
        ? { label: '保持唤醒中', tone: 'done' }
        : { label: '在线', tone: 'done' }
  const groups = new Map<string, MissedGroup>()
  for (const run of input.missed) {
    const group = groups.get(run.automationId) ?? { automationId: run.automationId, name: run.name, times: [] }
    group.times.push({ at: run.at, words: `${whenWords(run.at, now)}：${CAUSE[run.cause]}` })
    groups.set(run.automationId, group)
  }
  const awake = status.label === '保持唤醒中'
  return {
    status,
    ...(awake ? { awakeFor: computer?.keepAwake === 'schedule' ? '定时任务快到点了' : '有会话在运行或等你处理' } : {}),
    ...(computer?.wokeAt ? { woke: whenWords(computer.wokeAt, now) } : {}),
    missedTotal: input.missed.length,
    missed: [...groups.values()],
    ...(input.keepAwakeOn && computer && !computer.desktop ? { keepAwakeNote: 'Latch 应用没有运行，现在不起作用' } : {}),
  }
}
