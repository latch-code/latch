export interface CalendarDay {
  year: number
  month: number
  day: number
}
const key = ({ year, month, day }: CalendarDay) => year * 10_000 + month * 100 + day
const normalize = (year: number, month: number, day: number): CalendarDay => {
  const value = new Date(Date.UTC(year, month - 1, day))
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() }
}
const monthDate = (year: number, month: number, day: number) => {
  const first = normalize(year, month, 1),
    last = normalize(first.year, first.month + 1, 0)
  return { ...first, day: Math.min(day, last.day) }
}
/** Calendar boundaries use the operator's IANA time zone, including DST and short months. */
export function quotaCalendar(timezone: string, resetDay: number) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const date = (now: number): CalendarDay => {
    const parts = formatter.formatToParts(new Date(now))
    const part = (kind: string) => Number(parts.find(item => item.type === kind)?.value)
    return { year: part('year'), month: part('month'), day: part('day') }
  }
  const start = (target: CalendarDay): number => {
    const nominal = Date.UTC(target.year, target.month - 1, target.day)
    let low = nominal - 2 * 86_400_000,
      high = nominal + 2 * 86_400_000
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2)
      if (key(date(middle)) >= key(target)) high = middle
      else low = middle
    }
    return high
  }
  return {
    at(now: number) {
      const today = date(now),
        nextDay = normalize(today.year, today.month, today.day + 1)
      const thisReset = monthDate(today.year, today.month, resetDay)
      const cycle = key(today) >= key(thisReset) ? thisReset : monthDate(today.year, today.month - 1, resetDay)
      const nextReset = monthDate(cycle.year, cycle.month + 1, resetDay)
      const cycleStartedAt = start(cycle),
        nextResetAt = start(nextReset)
      return {
        dayStartedAt: start(today),
        cycleStartedAt,
        calendarProgress: (now - cycleStartedAt) / Math.max(1, nextResetAt - cycleStartedAt),
        day: key(today),
        cycle: key(cycle),
        nextDayAt: start(nextDay),
        nextResetAt,
        daysRemaining: Math.max(
          1,
          Math.round(
            (Date.UTC(nextReset.year, nextReset.month - 1, nextReset.day) - Date.UTC(today.year, today.month - 1, today.day)) / 86_400_000,
          ),
        ),
      }
    },
  }
}
