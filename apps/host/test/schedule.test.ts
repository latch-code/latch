import { expect, test } from 'vitest'
import { nextRun, scheduleDate } from '../src/schedule.ts'

const at = (text: string) => Date.parse(text)

test('daily runs today while the time is ahead, otherwise tomorrow', () => {
  expect(nextRun({ kind: 'daily', time: '09:00' }, at('2026-11-02T08:30:00Z'), 'UTC')).toBe('2026-11-02T09:00:00.000Z')
  expect(nextRun({ kind: 'daily', time: '09:00' }, at('2026-11-02T09:00:00Z'), 'UTC')).toBe('2026-11-03T09:00:00.000Z')
})

test('weekdays skip the weekend and weekly finds its day, in local time', () => {
  // Friday evening in Shanghai is already Saturday morning there after 16:00 UTC.
  expect(nextRun({ kind: 'weekdays', time: '09:00' }, at('2026-11-06T10:00:00Z'), 'Asia/Shanghai')).toBe('2026-11-09T01:00:00.000Z')
  expect(nextRun({ kind: 'weekly', day: 5, time: '17:00' }, at('2026-11-02T00:00:00Z'), 'Asia/Shanghai')).toBe('2026-11-06T09:00:00.000Z')
  expect(nextRun({ kind: 'weekly', day: 1, time: '00:05' }, at('2026-11-01T23:59:00Z'), 'UTC')).toBe('2026-11-02T00:05:00.000Z')
})

test('a time the clock skips has no run that day, and a repeated one runs once', () => {
  // New York: 02:30 does not exist on 2026-03-08; 01:30 happens twice on 2026-11-01.
  expect(nextRun({ kind: 'daily', time: '02:30' }, at('2026-03-08T05:00:00Z'), 'America/New_York')).toBe('2026-03-09T06:30:00.000Z')
  const first = nextRun({ kind: 'daily', time: '01:30' }, at('2026-11-01T04:00:00Z'), 'America/New_York')
  expect(first).toBe('2026-11-01T05:30:00.000Z')
  const date = scheduleDate(Date.parse(first), 'America/New_York')
  expect(date).toBe('2026-11-01')
  expect(nextRun({ kind: 'daily', time: '01:30' }, Date.parse(first), 'America/New_York', date)).toBe('2026-11-02T06:30:00.000Z')
})

test('half-hour zones and invalid input', () => {
  expect(nextRun({ kind: 'daily', time: '09:15' }, at('2026-11-02T00:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-02T03:45:00.000Z')
  expect(() => nextRun({ kind: 'daily', time: '25:00' }, 0, 'UTC')).toThrow()
  expect(() => nextRun({ kind: 'weekly', day: 7, time: '09:00' }, 0, 'UTC')).toThrow()
  expect(() => nextRun({ kind: 'daily', time: '09:00' }, 0, 'Not/AZone')).toThrow()
})
