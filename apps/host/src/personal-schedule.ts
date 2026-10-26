import { AppError } from '@latch/sdk'

export interface DailySchedule {
  kind: 'daily'
  time: string
  timeZone: string
}
function formatter(schedule: DailySchedule): Intl.DateTimeFormat {
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u.test(schedule.time) || schedule.timeZone.length > 80)
    throw new AppError(400, 'personal-schedule-invalid', '请选择有效的每日时间与时区。')
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: schedule.timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
  } catch {
    throw new AppError(400, 'personal-schedule-invalid', '请选择有效的每日时间与时区。')
  }
}
export function dailyDate(schedule: DailySchedule, at: number): string {
  const parts = formatter(schedule).formatToParts(at),
    get = (name: string) => parts.find(part => part.type === name)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}
/** Searches UTC minutes, so gaps are skipped and repeated wall times cannot run twice on one local date. */
export function nextDaily(schedule: DailySchedule, after: number, lastDate?: string): string {
  const format = formatter(schedule)
  for (let stamp = Math.floor(after / 60000) * 60000 + 60000, end = stamp + 72 * 3600000; stamp < end; stamp += 60000) {
    const parts = format.formatToParts(stamp),
      get = (name: string) => parts.find(part => part.type === name)?.value,
      date = `${get('year')}-${get('month')}-${get('day')}`
    if (`${get('hour')}:${get('minute')}` === schedule.time && (lastDate === undefined || date > lastDate))
      return new Date(stamp).toISOString()
  }
  throw new AppError(400, 'personal-schedule-invalid', '无法计算这个时区的下一次时间。')
}
