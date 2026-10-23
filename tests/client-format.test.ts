import { describe, expect, it } from 'vitest'
import { argumentView, basename, formatElapsed, formatTokens, middleEllipsis, relativeTime } from '../src/client/format.ts'

describe('client formatting', () => {
  const now = new Date(2026, 9, 23, 15, 0)
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()

  it('formats sidebar times relative to now', () => {
    expect(relativeTime(ago(20_000), now)).toBe('刚刚')
    expect(relativeTime(ago(5 * 60_000), now)).toBe('5 分钟')
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe('3 小时')
    expect(relativeTime(new Date(2026, 9, 22, 23).toISOString(), now)).toBe('昨天')
    expect(relativeTime(new Date(2026, 9, 19, 9).toISOString(), now)).toBe('4 天')
    expect(relativeTime(new Date(2026, 8, 3).toISOString(), now)).toBe('09/03')
    expect(relativeTime(new Date(2025, 0, 2).toISOString(), now)).toBe('2025/01/02')
    expect(relativeTime('not a date', now)).toBe('')
  })

  it('abbreviates token counts and elapsed time', () => {
    expect([formatTokens(950), formatTokens(1200), formatTokens(10_400), formatTokens(2_000_000)]).toEqual(['950', '1.2k', '10k', '2M'])
    expect([formatElapsed(0), formatElapsed(65_000), formatElapsed(3_725_000)]).toEqual(['0:00', '1:05', '1:02:05'])
  })

  it('keeps both ends of long paths', () => {
    const path = '/private/tmp/latch-test/project/workspace/src/components/very-long-file-name.tsx'
    const short = middleEllipsis(path, 32)
    expect(short).toHaveLength(32)
    expect(short.startsWith('/private/tmp')).toBe(true)
    expect(short.endsWith('name.tsx')).toBe(true)
    expect(middleEllipsis('/short', 32)).toBe('/short')
    expect(basename('/work/app/')).toBe('app')
    expect(basename('C:\\work\\docs')).toBe('docs')
  })

  it('renders tool arguments as entries and empty objects as no arguments', () => {
    expect(argumentView('{}')).toEqual({ kind: 'empty' })
    expect(argumentView(undefined)).toEqual({ kind: 'empty' })
    expect(argumentView('{"path":"a.ts","lines":[1,2]}')).toEqual({ kind: 'entries', entries: [['path', 'a.ts'], ['lines', '[\n  1,\n  2\n]']] })
    expect(argumentView('ls -la')).toEqual({ kind: 'text', text: 'ls -la' })
  })
})
