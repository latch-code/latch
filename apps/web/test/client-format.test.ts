import { describe, expect, it } from 'vitest'
import {
  absoluteTime,
  argumentView,
  basename,
  currencyAmount,
  dayClockTime,
  formatDuration,
  formatElapsed,
  formatTokens,
  messageTime,
  middleEllipsis,
  middleFit,
  relativeTime,
  formatSize,
  separatorLabel,
  sumUsage,
  tokenAmount,
  tokenLines,
  tokenText,
} from '../src/format.ts'

/** A width in characters, for fitting text the way a monospaced line would. */
const chars = (value: string) => value.length

/** A local time in 2026, seven seconds past the minute. */
const localTime = (month: number, day: number, hours: number, minutes: number) => new Date(2026, month, day, hours, minutes, 7).getTime()

describe('client formatting', () => {
  const now = new Date(2026, 9, 23, 15, 0)
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()

  it('formats sidebar times relative to now', () => {
    expect(relativeTime(ago(20_000), now)).toBe('刚刚')
    expect(relativeTime(ago(5 * 60_000), now)).toBe('5 分钟')
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe('3 小时')
    expect(relativeTime(new Date(2026, 9, 22, 23).toISOString(), now)).toBe('昨天')
    expect(relativeTime(new Date(2026, 9, 19, 9).toISOString(), now)).toBe('4 天')
    expect(relativeTime(new Date(2026, 9, 14, 9).toISOString(), now)).toBe('上周')
    expect(relativeTime(new Date(2026, 8, 3).toISOString(), now)).toBe('09/03')
    expect(relativeTime(new Date(2025, 0, 2).toISOString(), now)).toBe('2025/01/02')
    expect(relativeTime('not a date', now)).toBe('')
  })

  it('abbreviates token counts and elapsed time', () => {
    expect([950, 1200, 9_100, 10_400, 12_400, 99_960, 124_000, 999_600, 1_240_000, 2_000_000].map(value => formatTokens(value))).toEqual([
      '950',
      '1.2k',
      '9.1k',
      '10.4k',
      '12.4k',
      '100k',
      '124k',
      '1M',
      '1.2M',
      '2M',
    ])
    expect([formatElapsed(0), formatElapsed(65_000), formatElapsed(3_725_000)]).toEqual(['0:00', '1:05', '1:02:05'])
  })

  it('says durations as a person would, with one decimal only for settled values under ten seconds', () => {
    expect(formatDuration(999)).toBeUndefined()
    expect(formatDuration(2400)).toBe('2.4 秒')
    expect(formatDuration(2400, true)).toBe('2 秒')
    expect(formatDuration(6000)).toBe('6 秒')
    expect(formatDuration(12_900)).toBe('12 秒')
    expect(formatDuration(65_000)).toBe('1 分 5 秒')
    expect(formatDuration(72_000)).toBe('1 分 12 秒')
    expect(formatDuration(3_725_000)).toBe('1 小时 2 分')
  })

  it('writes message times by how long ago they are, with the full time for the tooltip', () => {
    const today = localTime(9, 24, 15, 0)
    expect(messageTime(localTime(9, 24, 14, 32), today)).toBe('14:32')
    expect(messageTime(localTime(9, 24, 0, 1), today)).toBe('00:01')
    expect(messageTime(localTime(9, 23, 23, 59), today)).toBe('昨天 23:59')
    expect(messageTime(localTime(9, 3, 14, 32), today)).toBe('10月3日 14:32')
    expect(messageTime(new Date(2025, 9, 3, 14, 32).getTime(), today)).toBe('2025年10月3日 14:32')
    expect(dayClockTime(localTime(9, 24, 14, 31), today)).toBe('10月24日 14:31:07')
    expect(dayClockTime(new Date(2025, 9, 3, 9, 0, 12).getTime(), today)).toBe('2025年10月3日 09:00:12')
    expect(absoluteTime(localTime(9, 24, 14, 32))).toBe('2026年10月24日 周六 14:32:07')
    expect(separatorLabel(localTime(9, 24, 14, 2), today, false)).toBe('今天 14:02')
    expect(separatorLabel(localTime(9, 24, 16, 40), today, true)).toBe('16:40')
    expect(separatorLabel(localTime(9, 23, 9, 15), today, false)).toBe('昨天 09:15')
    expect(separatorLabel(localTime(9, 21, 9, 15), today, false)).toBe('周三 09:15')
    expect(separatorLabel(localTime(9, 2, 9, 15), today, false)).toBe('10月2日 09:15')
    expect(separatorLabel(new Date(2025, 2, 2, 10, 0).getTime(), today, false)).toBe('2025年3月2日 10:00')
  })

  it('names tokens in words, with the exact counts and the parts the Host reported for the tooltip', () => {
    // Every count carries its unit.
    expect(tokenText({ inputTokens: 12_400, outputTokens: 3100 })).toBe('输入 12.4k tokens · 输出 3.1k tokens')
    expect(tokenText({ inputTokens: 123, outputTokens: 69 })).toBe('输入 123 tokens · 输出 69 tokens')
    expect([tokenAmount(850), tokenAmount(124_000), tokenAmount(1_240_000)]).toEqual(['850 tokens', '124k tokens', '1.2M tokens'])
    expect(
      tokenLines({ inputTokens: 12_400, outputTokens: 3100, cacheReadTokens: 8000, cacheWriteTokens: 1200, reasoningTokens: 1000 }),
    ).toEqual(['输入 12,400 tokens（缓存读取 8,000 · 缓存写入 1,200）', '输出 3,100 tokens（推理 1,000）'])
    expect(tokenLines({ inputTokens: 5, outputTokens: 2 })).toEqual(['输入 5 tokens', '输出 2 tokens'])
    expect(sumUsage([])).toBeUndefined()
    expect(
      sumUsage([
        { inputTokens: 1, outputTokens: 2, cacheReadTokens: 1 },
        { inputTokens: 3, outputTokens: 4 },
      ]),
    ).toEqual({
      inputTokens: 4,
      outputTokens: 6,
    })
  })

  it('keeps both ends of long paths', () => {
    const path = '/private/tmp/latch-test/project/workspace/src/components/very-long-file-name.tsx'
    const short = middleEllipsis(path, 32)
    expect(short).toHaveLength(32)
    expect(short.startsWith('/private/tmp')).toBe(true)
    expect(short.endsWith('name.tsx')).toBe(true)
    expect(middleEllipsis('/short', 32)).toBe('/short')
    // Fitted to a measured width: one ellipsis, the last segment whole, or nothing when even that does not fit.
    expect(middleFit('/private/var/folders/latch-app', 40, chars)).toBe('/private/var/folders/latch-app')
    expect(middleFit('/private/var/folders/latch-app/', 20, chars)).toBe('/private/…/latch-app')
    expect(middleFit('/private/var/folders/latch-app', 11, chars)).toBe('…/latch-app')
    expect(middleFit('/private/var/folders/latch-app', 8, chars)).toBeUndefined()
    expect(basename('/work/app/')).toBe('app')
    expect(basename('C:\\work\\docs')).toBe('docs')
  })

  it('renders tool arguments as entries and empty objects as no arguments', () => {
    expect(argumentView('{}')).toEqual({ kind: 'empty' })
    expect(argumentView(undefined)).toEqual({ kind: 'empty' })
    expect(argumentView('{"path":"a.ts","lines":[1,2]}')).toEqual({
      kind: 'entries',
      entries: [
        ['path', 'a.ts'],
        ['lines', '[\n  1,\n  2\n]'],
      ],
    })
    expect(argumentView('ls -la')).toEqual({ kind: 'text', text: 'ls -la' })
  })
})

describe('file sizes', () => {
  it('reads as people say them', () => {
    expect([512, 12 * 1024, 1.8 * 1024 ** 2, 2 * 1024 ** 2, 1.2 * 1024 ** 3].map(formatSize)).toEqual([
      '512 B',
      '12 KB',
      '1.8 MB',
      '2 MB',
      '1.2 GB',
    ])
  })
})

describe('currency amounts', () => {
  it('formats in the currency it was given, and refuses a code that is not one', () => {
    expect(currencyAmount(1.5, 'USD')).toBe(currencyAmount(1.5, 'USD'))
    expect(currencyAmount(1.5, 'USD')).toContain('1.50')
    expect(currencyAmount(1.5, 'EUR')).toContain('€')
    expect(() => currencyAmount(1, 'not a currency')).toThrow(RangeError)
  })
})
