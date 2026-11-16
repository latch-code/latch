import { afterEach, describe, expect, it } from 'vitest'
import type { UsageLine } from '../src/model-usage.ts'
import type { TurnLine } from '../src/turn-usage.ts'
import {
  bucketOf,
  compareOf,
  hourOfWeek,
  ledgerEntry,
  periodBuckets,
  projectsOf,
  seriesOf,
  summarizeEntries,
  turnEntry,
} from '../src/usage-stats.ts'

const zone = process.env.TZ
afterEach(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

const request = (at: number, extra: Partial<UsageLine> = {}): UsageLine => ({
  at: new Date(at).toISOString(),
  sessionId: 'gateway-session',
  harness: 'codex',
  providerId: 'deepseek',
  model: 'deepseek-chat',
  outcome: 'ok',
  attempts: 1,
  fallback: false,
  totalMs: 900,
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 800,
  ...extra,
})

const turn = (at: number, extra: Partial<TurnLine> = {}): TurnLine => ({
  at: new Date(at).toISOString(),
  startedAt: new Date(at - 5000).toISOString(),
  sessionId: 'own-session',
  harness: 'claude-agent',
  model: 'claude-sonnet-4-5',
  steps: 2,
  inputTokens: 500,
  outputTokens: 50,
  ...extra,
})

describe('usage buckets', () => {
  it('cuts days at the Host’s own midnight, wherever the test runs, across a month’s end', () => {
    process.env.TZ = 'Asia/Shanghai'
    // 2026-12-01 00:30 in Shanghai is 2026-11-30 16:30 UTC.
    const now = Date.parse('2026-11-30T16:30:00Z')
    const days = periodBuckets('7', now)
    expect(days.map(start => new Date(start).toISOString())).toEqual([
      '2026-11-24T16:00:00.000Z',
      '2026-11-25T16:00:00.000Z',
      '2026-11-26T16:00:00.000Z',
      '2026-11-27T16:00:00.000Z',
      '2026-11-28T16:00:00.000Z',
      '2026-11-29T16:00:00.000Z',
      '2026-11-30T16:00:00.000Z',
    ])
    // 23:59 on 30 November in Shanghai belongs to the 30th; a minute later, to December the 1st.
    expect(bucketOf(Date.parse('2026-11-30T15:59:00Z'), days)).toBe(5)
    expect(bucketOf(Date.parse('2026-11-30T16:00:00Z'), days)).toBe(6)
    expect(bucketOf(days[0] - 1, days)).toBe(-1)
  })

  it('keeps a day whole across a clock change: 23 or 25 hours, never a day cut in two', () => {
    process.env.TZ = 'America/New_York'
    // Daylight saving ended at 02:00 on 1 November 2026 in New York.
    const days = periodBuckets('7', Date.parse('2026-11-03T17:00:00Z'))
    const lengths = days.slice(1).map((start, index) => (start - days[index]) / 3_600_000)
    expect(lengths).toEqual([24, 24, 24, 24, 25, 24])
    for (const start of days) expect(new Date(start).getHours()).toBe(0)
  })

  it('counts the last 24 hours by the hour, the current one last', () => {
    process.env.TZ = 'Asia/Kolkata'
    const now = Date.parse('2026-11-16T10:47:00Z')
    const hours = periodBuckets('1', now)
    expect(hours).toHaveLength(24)
    // Kolkata is 5:30 ahead: its hours begin at :30 UTC.
    expect(new Date(hours.at(-1)!).toISOString()).toBe('2026-11-16T10:30:00.000Z')
    expect(hours.slice(1).every((start, index) => start - (hours[index] ?? 0) === 3_600_000)).toBe(true)
    expect(bucketOf(now, hours)).toBe(23)
  })

  it('puts an hour of the week in the Host’s own time, Monday morning first', () => {
    process.env.TZ = 'Asia/Shanghai'
    // Monday 16 November 2026, 00:10 in Shanghai.
    expect(hourOfWeek(Date.parse('2026-11-15T16:10:00Z'))).toBe(0)
    // Sunday 15 November, 23:10.
    expect(hourOfWeek(Date.parse('2026-11-15T15:10:00Z'))).toBe(167)
  })
})

describe('usage from the ledger and the own-login turns', () => {
  const now = Date.parse('2026-11-16T04:00:00Z')

  it('keeps the two apart: a request is a request of the gateway, a turn a turn of the own login, never both', () => {
    const entries = [ledgerEntry(request(now - 1000)), turnEntry(turn(now - 500))]
    const rows = summarizeEntries(entries, 'harness')
    expect(rows).toEqual([
      expect.objectContaining({
        by: 'gateway',
        harness: 'codex',
        requests: 1,
        turns: 0,
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800 },
      }),
      expect.objectContaining({ by: 'own', harness: 'claude-agent', requests: 0, turns: 1, usage: { inputTokens: 500, outputTokens: 50 } }),
    ])
    // A service groups gateway requests; an own-login turn has none, and stays under its Harness.
    expect(summarizeEntries(entries, 'service').map(row => [row.providerId, row.harness])).toEqual([
      ['deepseek', undefined],
      [undefined, 'claude-agent'],
    ])
  })

  it('counts a plugin’s provider as its own source, beside the gateway and the own login', () => {
    const entries = [turnEntry(turn(now, { harness: 'standard', via: 'plugin', providerId: 'plugged' })), turnEntry(turn(now))]
    expect(
      summarizeEntries(entries, 'service')
        .map(row => [row.by, row.providerId, row.harness])
        .toSorted(),
    ).toEqual([
      ['own', undefined, 'claude-agent'],
      ['plugin', 'plugged', undefined],
    ])
  })

  it('draws each bucket by Harness and source with the cache share only over uses that reported cache reads', () => {
    process.env.TZ = 'UTC'
    const buckets = periodBuckets('7', now)
    const entries = [
      ledgerEntry(request(now - 3_600_000)),
      ledgerEntry(request(now - 3_600_000, { cacheReadTokens: undefined })),
      ledgerEntry(
        request(now - 3 * 86_400_000, { inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined, outcome: 'server' }),
      ),
      turnEntry(turn(now - 60_000, { cacheReadTokens: 400 })),
    ]
    const { series, hours, buckets: starts } = seriesOf(entries, buckets)
    expect(starts).toHaveLength(7)
    expect(series).toEqual([
      expect.objectContaining({ bucket: 3, by: 'gateway', harness: 'codex', requests: 1, measured: 0, inputTokens: 0 }),
      {
        bucket: 6,
        by: 'gateway',
        harness: 'codex',
        providerId: 'deepseek',
        requests: 2,
        turns: 0,
        measured: 2,
        inputTokens: 2000,
        outputTokens: 200,
        cacheReadTokens: 800,
        cacheBase: 1000,
      },
      {
        bucket: 6,
        by: 'own',
        harness: 'claude-agent',
        requests: 0,
        turns: 1,
        measured: 1,
        inputTokens: 500,
        outputTokens: 50,
        cacheReadTokens: 400,
        cacheBase: 500,
      },
    ])
    expect(hours.reduce((sum, count) => sum + count, 0)).toBe(4)
    expect(JSON.stringify(series)).not.toContain('session')
  })

  it('sums tokens by project, and compares one model across Harnesses by its turns, whatever each calls it', () => {
    const entries = [
      turnEntry(turn(now, { projectId: 'latch' })),
      turnEntry(
        turn(now, { projectId: 'latch', harness: 'opencode', model: 'anthropic/claude-sonnet-4-5', inputTokens: 900, outputTokens: 90 }),
      ),
      turnEntry(turn(now, { harness: 'opencode', model: 'Claude-Sonnet-4-5-20250929', inputTokens: undefined, outputTokens: undefined })),
      ledgerEntry(request(now, { projectId: 'site' })),
    ]
    expect(projectsOf(entries)).toEqual([
      { projectId: 'latch', turns: 2, requests: 0, tokens: 1540 },
      { projectId: 'site', turns: 0, requests: 1, tokens: 1100 },
      { turns: 1, requests: 0, tokens: 0 },
    ])
    expect(compareOf(entries)).toEqual([
      { model: 'claude-sonnet-4-5', harness: 'opencode', turns: 2, measured: 1, inputTokens: 900, outputTokens: 90 },
      { model: 'claude-sonnet-4-5', harness: 'claude-agent', turns: 1, measured: 1, inputTokens: 500, outputTokens: 50 },
    ])
  })
})
