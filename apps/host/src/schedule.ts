import type { AutomationSchedule } from '@latch/protocol'
import { AppError } from '@latch/sdk'

const TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MINUTE = 60_000
/** Coarse enough to skip most of a week cheaply, fine enough that no day-long gap can hide inside a step. */
const STEP = 15 * MINUTE
const HORIZON = 9 * 24 * 60 * MINUTE

function assertSchedule(schedule: AutomationSchedule): void {
  if (
    !TIME.test(schedule.time)
    || (schedule.kind === 'weekly' && !(Number.isInteger(schedule.day) && schedule.day >= 0 && schedule.day <= 6))
  )
    throw new AppError(400, 'automation-schedule-invalid', '请选择有效的时间。')
}

interface Local {
  date: string
  weekday: number
  hour: string
  time: string
}

function reader(timeZone: string): (at: number) => Local {
  let format: Intl.DateTimeFormat
  try {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
  } catch {
    throw new AppError(409, 'automation-time-zone', '无法读取这台电脑的时区。')
  }
  return at => {
    const parts = format.formatToParts(at),
      get = (name: string) => parts.find(part => part.type === name)?.value ?? ''
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      weekday: WEEKDAYS.indexOf(get('weekday')),
      hour: get('hour'),
      time: `${get('hour')}:${get('minute')}`,
    }
  }
}

function due(schedule: AutomationSchedule, local: Local, lastDate: string | undefined): boolean {
  if (lastDate !== undefined && local.date <= lastDate) return false
  if (schedule.kind === 'weekdays') return local.weekday >= 1 && local.weekday <= 5
  if (schedule.kind === 'weekly') return local.weekday === schedule.day
  return true
}

/** The local date of a moment, which an attempt records so a repeated wall time cannot run twice that day. */
export function scheduleDate(at: number, timeZone: string): string {
  return reader(timeZone)(at).date
}

/**
 * The next run after `after`, in `timeZone`. Searches real time rather than doing calendar arithmetic, so a time a clock
 * change skips simply has no run that day and a repeated one runs at its first occurrence.
 */
export function nextRun(schedule: AutomationSchedule, after: number, timeZone: string, lastDate?: string): string {
  assertSchedule(schedule)
  const read = reader(timeZone),
    hour = schedule.time.slice(0, 2),
    start = Math.floor(after / MINUTE) * MINUTE
  let previous = read(start)
  for (let edge = start + STEP; edge < start + HORIZON; edge += STEP) {
    const current = read(edge)
    if ((previous.hour === hour || current.hour === hour) && (due(schedule, previous, lastDate) || due(schedule, current, lastDate)))
      for (let at = edge - STEP + MINUTE; at <= edge; at += MINUTE) {
        const local = read(at)
        if (local.time === schedule.time && due(schedule, local, lastDate)) return new Date(at).toISOString()
      }
    previous = current
  }
  throw new AppError(409, 'automation-schedule-invalid', '无法计算下一次运行时间。')
}
