// A Harness's subscription limits beside its control (`composer/HarnessQuota.tsx`): what the mark, its one line and
// its panel say in each state, and that a Harness with nothing to say draws nothing.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { HarnessQuota } from '@latch/protocol'
import { HarnessQuotaMark, QuotaPanel } from '../src/composer/HarnessQuota.tsx'
import { quotaView, resetWords } from '../src/composer/harnessQuota.ts'

const NOW = Date.parse('2026-11-15T03:00:00.000Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const at = (ms: number) => new Date(NOW + ms).toISOString()
const observedAt = at(0)

const ok: HarnessQuota = {
  windows: [
    { kind: 'five-hour', usedPercent: 12, resetsAt: at(2 * HOUR + 5 * MINUTE) },
    { kind: 'weekly', usedPercent: 68, resetsAt: at(143 * HOUR) },
  ],
  plan: 'plus',
  account: 'n•••@f•••.com',
  state: 'ok',
  observedAt,
}
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()

describe('when a window resets, in words', () => {
  it('uses two units at most, down to the minute', () => {
    expect(resetWords(at(143 * HOUR), NOW)).toBe('5 天 23 小时后重置')
    expect(resetWords(at(48 * HOUR), NOW)).toBe('2 天后重置')
    expect(resetWords(at(2 * HOUR + 5 * MINUTE), NOW)).toBe('2 小时 5 分钟后重置')
    expect(resetWords(at(12 * MINUTE + 30_000), NOW)).toBe('12 分钟后重置')
    expect(resetWords(at(20_000), NOW)).toBe('即将重置')
    expect(resetWords(at(143 * HOUR), NOW, true)).toBe('5 天后重置')
    expect(resetWords(at(2 * HOUR + 5 * MINUTE), NOW, true)).toBe('2 小时后重置')
    expect(resetWords(undefined, NOW)).toBeUndefined()
    expect(resetWords('soon', NOW)).toBeUndefined()
  })
})

describe('the mark and its one line', () => {
  it('draws nothing for a Harness that said nothing, or whose windows have all reset', () => {
    expect(quotaView(undefined, NOW)).toBeUndefined()
    expect(quotaView(ok, NOW + 200 * HOUR)).toBeUndefined()
    expect(renderToStaticMarkup(createElement(HarnessQuotaMark, { quota: undefined, harness: 'Codex' }))).toBe('')
  })

  it('shows the fullest window in ink below 80%', () => {
    expect(quotaView(ok, NOW)).toMatchObject({ state: 'ok', percent: 68, text: '68%', line: '7 天额度已用 68% · 5 天 23 小时后重置' })
  })

  it('turns to the warning state from 80%, with the figure', () => {
    const near: HarnessQuota = { ...ok, windows: [{ ...ok.windows[0]!, usedPercent: 86.4 }, ok.windows[1]!], state: 'near' }
    expect(quotaView(near, NOW)).toMatchObject({
      state: 'near',
      percent: 86,
      text: '86%',
      line: '5 小时额度已用 86% · 2 小时 5 分钟后重置',
    })
    // 99.6% is not the limit yet, and never reads as it.
    expect(quotaView({ ...near, windows: [{ kind: 'weekly', usedPercent: 99.6 }] }, NOW)?.text).toBe('99%')
  })

  it('says a window is used up at the limit, still with the figure', () => {
    const limited: HarnessQuota = { ...ok, windows: [ok.windows[0]!, { ...ok.windows[1]!, usedPercent: 100 }], state: 'limited' }
    expect(quotaView(limited, NOW)).toMatchObject({
      state: 'limited',
      percent: 100,
      text: '100%',
      line: '7 天额度已用尽 · 5 天 23 小时后重置',
    })
    // The account at a limit that no window shows: the same state, without naming a window.
    expect(quotaView({ ...ok, state: 'limited' }, NOW)).toMatchObject({ state: 'limited', text: '68%', line: '额度已用尽' })
  })

  it('shows a warning the Harness gave without a figure as its reset time, with no figure and no ring', () => {
    const warning: HarnessQuota = {
      windows: [{ kind: 'five-hour', state: 'near', resetsAt: at(2 * HOUR + 29 * MINUTE) }],
      state: 'near',
      observedAt,
    }
    const view = quotaView(warning, NOW)!
    // The mark keeps the larger unit; the line and the panel say it to the minute.
    expect(view).toMatchObject({ state: 'near', text: '2 小时后重置', line: '5 小时额度将用尽 · 2 小时 29 分钟后重置' })
    expect(view.percent).toBeUndefined()
    expect(view.rows).toEqual([{ key: ':five-hour:', name: '5 小时', state: 'near', status: '将用尽', reset: '2 小时 29 分钟后重置' }])
    const refused: HarnessQuota = { windows: [{ kind: 'weekly-opus', state: 'limited' }], state: 'limited', observedAt }
    expect(quotaView(refused, NOW)).toMatchObject({ state: 'limited', text: '已用尽', line: '7 天 Opus 额度已用尽' })
  })

  it('drops a window once it has reset and judges by the ones left', () => {
    const near: HarnessQuota = { ...ok, windows: [{ ...ok.windows[0]!, usedPercent: 95 }, ok.windows[1]!], state: 'near' }
    expect(quotaView(near, NOW + 3 * HOUR)).toMatchObject({ state: 'ok', text: '68%', rows: [{ name: '每周' }] })
  })
})

describe('a Harness that meters model groups apart', () => {
  const grouped: HarnessQuota = {
    windows: [
      { kind: 'five-hour', group: 'gemini', usedPercent: 10, resetsAt: at(2 * HOUR) },
      { kind: 'weekly', group: 'gemini', usedPercent: 30, resetsAt: at(100 * HOUR) },
      { kind: 'five-hour', group: 'claude-gpt', usedPercent: 85, resetsAt: at(3 * HOUR) },
      { kind: 'weekly', group: 'claude-gpt', usedPercent: 40, resetsAt: at(100 * HOUR) },
    ],
    state: 'near',
    observedAt,
  }

  it('shows the fullest window of any group in the mark, and names its group in Latch’s words', () => {
    expect(quotaView(grouped, NOW)).toMatchObject({
      state: 'near',
      text: '85%',
      line: 'Claude 与 GPT 模型 · 5 小时额度已用 85% · 3 小时后重置',
    })
  })

  it('lists each group as a section of the panel', () => {
    const panel = renderToStaticMarkup(createElement(QuotaPanel, { view: quotaView(grouped, NOW)! }))
    expect(text(panel)).toBe(
      'Gemini 模型 5 小时 10% 2 小时后重置 每周 30% 4 天 4 小时后重置 Claude 与 GPT 模型 5 小时 85% 3 小时后重置 每周 40% 4 天 4 小时后重置',
    )
    expect(panel.match(/class="quota-group"/gu)).toHaveLength(2)
  })
})

describe('what is drawn', () => {
  const mark = (quota: HarnessQuota) => renderToStaticMarkup(createElement(HarnessQuotaMark, { quota, harness: 'Codex' }))

  it('is a ring with the figure, and states its state for the colour', () => {
    const near: HarnessQuota = { ...ok, windows: [{ kind: 'weekly', usedPercent: 86, resetsAt: at(200 * HOUR) }], state: 'near' }
    const markup = mark(near)
    expect(markup).toContain('data-state="near"')
    expect(markup).toContain('class="quota-ring"')
    expect(markup).toContain('>86%<')
    expect(markup).toMatch(/aria-label="Codex 额度：7 天额度已用 86% · \d+ 天/u)
  })

  it('is the alert mark with the reset time for a warning without a figure', () => {
    const warning: HarnessQuota = { windows: [{ kind: 'five-hour', state: 'near', resetsAt: at(400 * HOUR) }], state: 'near', observedAt }
    const markup = mark(warning)
    expect(markup).not.toContain('quota-ring')
    expect(markup).not.toContain('%')
    expect(markup).toContain('后重置')
  })

  it('lists every window with its figure and reset time, then the plan, the masked account and the balance', () => {
    const view = quotaView(
      {
        ...ok,
        windows: [...ok.windows, { kind: 'billing-period', usedPercent: 41.5 }, { kind: 'rolling', usedPercent: 3, windowMinutes: 1440 }],
        balanceCents: 1234,
      },
      NOW,
    )!
    const panel = renderToStaticMarkup(createElement(QuotaPanel, { view }))
    expect(text(panel)).toBe(
      '5 小时 12% 2 小时 5 分钟后重置 每周 68% 5 天 23 小时后重置 本期 42% 1 天 3% Plus · n•••@f•••.com · 余额 $12.34',
    )
    expect(panel.match(/role="meter"/gu)).toHaveLength(4)
    expect(panel).toContain('aria-valuetext="已用 68%"')
  })
})
