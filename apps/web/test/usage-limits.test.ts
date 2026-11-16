// 额度与用量 (`src/usage/`): one limit window everywhere, the composer's chip for the tightest window, and a budget
// read as the same kind of window.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { leadingQuotaWindow, type BudgetProgress, type HarnessQuota } from '@latch/protocol'
import { LimitWindow } from '../src/usage/LimitWindow.tsx'
import { HarnessLimitChip } from '../src/usage/UsageChip.tsx'
import { budgetLimit, chipWords, harnessLimits, resetWords, usedWords, type LimitView } from '../src/usage/limits.ts'
import { unpricedShare } from '../src/usage/usage.ts'

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
const window = (view: LimitView) => renderToStaticMarkup(createElement(LimitWindow, { view }))

describe('when a window resets, in words', () => {
  it('uses two units at most, down to the minute', () => {
    expect(resetWords(at(143 * HOUR), NOW)).toBe('5 天 23 小时后重置')
    expect(resetWords(at(48 * HOUR), NOW)).toBe('2 天后重置')
    expect(resetWords(at(2 * HOUR + 5 * MINUTE), NOW)).toBe('2 小时 5 分钟后重置')
    expect(resetWords(at(12 * MINUTE + 30_000), NOW)).toBe('12 分钟后重置')
    expect(resetWords(at(20_000), NOW)).toBe('即将重置')
    expect(resetWords(at(143 * HOUR), NOW, true)).toBe('5 天后重置')
    expect(resetWords(undefined, NOW)).toBeUndefined()
    expect(resetWords('soon', NOW)).toBeUndefined()
  })
})

describe('one limit window', () => {
  it('says 「已用 N%」 with the name, a continuous bar and the reset time, in ink below 80%', () => {
    const markup = window({ key: 'w', name: '每周', state: 'ok', percent: 68, reset: '5 天 23 小时后重置' })
    expect(text(markup)).toBe('每周 已用 68% 5 天 23 小时后重置')
    expect(markup).toContain('data-state="ok"')
    expect(markup).toContain('role="meter"')
    expect(markup).toContain('aria-valuetext="已用 68%"')
    expect(markup).toContain('--used:68%')
  })

  it('is amber from 80% and red at the limit, on the bar and the figure together', () => {
    for (const [percent, state] of [
      [86, 'near'],
      [100, 'limited'],
    ] as const) {
      const markup = window({ key: 'w', name: '5 小时', state, percent })
      // One state on the window colours the figure; the same state on the bar colours its fill.
      expect(markup.match(new RegExp(`data-state="${state}"`, 'gu'))).toHaveLength(2)
      expect(text(markup)).toBe(`5 小时 已用 ${percent}%`)
    }
  })

  it('says the state and reset time in one line where the source gave no figure, with no bar to read', () => {
    const markup = window({ key: 'w', name: '5 小时', state: 'near', status: '将用尽', reset: '2 小时后重置' })
    // One line: the name, then the state and when it resets.
    expect(text(markup)).toBe('5 小时 将用尽 · 2 小时后重置')
    expect(markup).toContain('data-words=""')
    expect(markup).not.toContain('role="meter"')
    expect(markup).not.toContain('%')
  })

  it('shows no moving reset time for a window that has not started', () => {
    const idle = (windows: HarnessQuota['windows']): HarnessQuota => ({ windows, state: 'ok', observedAt })
    const fresh = harnessLimits(
      idle([
        { kind: 'five-hour', usedPercent: 0, resetsAt: at(5 * HOUR - 20_000) },
        { kind: 'weekly', usedPercent: 0, resetsAt: at(7 * 24 * HOUR + 40_000) },
        { kind: 'rolling', usedPercent: 0, windowMinutes: 1440, resetsAt: at(24 * HOUR) },
      ]),
      NOW,
    )!
    expect(fresh.windows.map(item => item.reset)).toEqual([undefined, undefined, undefined])
    const started = harnessLimits(
      idle([
        { kind: 'five-hour', usedPercent: 0, resetsAt: at(3 * HOUR + 16 * MINUTE) },
        { kind: 'weekly', usedPercent: 1, resetsAt: at(7 * 24 * HOUR) },
        { kind: 'billing-period', usedPercent: 0, resetsAt: at(30 * 24 * HOUR) },
      ]),
      NOW,
    )!
    expect(started.windows.map(item => item.reset)).toEqual(['3 小时 16 分钟后重置', '7 天后重置', '30 天后重置'])
  })

  it('never reads 100 before the limit', () => {
    expect(harnessLimits({ ...ok, windows: [{ kind: 'weekly', usedPercent: 99.6 }] }, NOW)?.tightest?.percent).toBe(99)
  })
})

describe('the tightest window, which the composer stands for', () => {
  it('is the one the protocol leads with: the worst state, then the fullest', () => {
    const cases: HarnessQuota[] = [
      ok,
      { ...ok, windows: [{ ...ok.windows[0]!, usedPercent: 86 }, ok.windows[1]!], state: 'near' },
      {
        ...ok,
        windows: [
          { kind: 'five-hour', state: 'near' },
          { kind: 'weekly', usedPercent: 70 },
        ],
        state: 'near',
      },
      { ...ok, windows: [ok.windows[0]!, { ...ok.windows[1]!, usedPercent: 100 }], state: 'limited' },
    ]
    for (const quota of cases) {
      const lead = leadingQuotaWindow(quota.windows)!
      expect(harnessLimits(quota, NOW)!.tightest?.key).toBe(`:${lead.kind}:`)
    }
  })

  it('reads by name and number, never a bare percent', () => {
    expect(chipWords(harnessLimits(ok, NOW)!)).toBe('每周已用 68%')
    const near: HarnessQuota = { ...ok, windows: [{ ...ok.windows[0]!, usedPercent: 86.4 }, ok.windows[1]!], state: 'near' }
    expect(chipWords(harnessLimits(near, NOW)!)).toBe('5 小时已用 86%')
  })

  it('says it is the limit when the Harness gave a warning without a figure, or the account is at one no window shows', () => {
    const warning: HarnessQuota = { windows: [{ kind: 'five-hour', state: 'near', resetsAt: at(2 * HOUR) }], state: 'near', observedAt }
    expect(chipWords(harnessLimits(warning, NOW)!)).toBe('5 小时额度将用尽')
    const refused: HarnessQuota = { windows: [{ kind: 'weekly-opus', state: 'limited' }], state: 'limited', observedAt }
    expect(chipWords(harnessLimits(refused, NOW)!)).toBe('每周 · Opus额度已用尽')
    expect(chipWords(harnessLimits({ ...ok, state: 'limited' }, NOW)!)).toBe('额度已用尽')
  })

  it('draws nothing for a Harness that said nothing, or whose windows have all reset', () => {
    expect(harnessLimits(undefined, NOW)).toBeUndefined()
    expect(harnessLimits(ok, NOW + 200 * HOUR)).toBeUndefined()
    const harness = { id: 'codex', capabilities: { display: { label: 'Codex' } } } as never
    expect(renderToStaticMarkup(createElement(HarnessLimitChip, { harness }))).toBe('')
  })

  it('drops a window once it has reset and judges by the ones left', () => {
    const near: HarnessQuota = { ...ok, windows: [{ ...ok.windows[0]!, usedPercent: 95 }, ok.windows[1]!], state: 'near' }
    expect(harnessLimits(near, NOW + 3 * HOUR)).toMatchObject({ state: 'ok', tightest: { name: '每周', percent: 68 } })
  })
})

describe('what a Harness reports beside its windows', () => {
  it('names model groups in Latch’s words and lists plan, masked account and a balance above zero', () => {
    const grouped: HarnessQuota = {
      windows: [
        { kind: 'five-hour', group: 'gemini', usedPercent: 10, resetsAt: at(2 * HOUR) },
        { kind: 'five-hour', group: 'claude-gpt', usedPercent: 85, resetsAt: at(3 * HOUR) },
      ],
      state: 'near',
      observedAt,
    }
    expect(harnessLimits(grouped, NOW)!.windows.map(item => item.group)).toEqual(['Gemini 模型', 'Claude 与 GPT 模型'])
    expect(harnessLimits({ ...ok, balanceCents: 1234 }, NOW)).toMatchObject({
      facts: ['Plus', 'n•••@f•••.com', '余额 $12.34'],
      who: 'n•••@f•••.com',
    })
    expect(harnessLimits({ ...ok, plan: 'supergrok', balanceCents: 0 }, NOW)!.facts).toEqual(['SuperGrok', 'n•••@f•••.com'])
  })

  it('shows a balance reported alone in its currency, and the composer says nothing until the account cannot be used', () => {
    const balance: HarnessQuota = { windows: [], balanceCents: 11_000, currency: 'CNY', state: 'ok', observedAt }
    expect(harnessLimits(balance, NOW)).toMatchObject({ windows: [], account: false, facts: ['余额 ¥110.00'] })
    expect(harnessLimits(balance, NOW)).not.toHaveProperty('tightest')
    expect(harnessLimits({ ...balance, balanceCents: 0 }, NOW)!.facts).toEqual(['余额 ¥0.00'])
    // Still there a day later: a balance has no reset.
    expect(harnessLimits(balance, NOW + 24 * HOUR)).toBeDefined()
    const chip = (quota: HarnessQuota) =>
      renderToStaticMarkup(
        createElement(HarnessLimitChip, {
          harness: { id: 'dsh', capabilities: { display: { label: 'DeepSeek Harness' } }, quota } as never,
        }),
      )
    expect(chip(balance)).toBe('')
    const spent = { ...balance, balanceCents: 0, state: 'limited' as const }
    expect(harnessLimits(spent, NOW)).toMatchObject({ account: true })
    expect(chip(spent)).toContain('额度已用尽')
  })
})

describe('a monthly budget', () => {
  const budget = (used: number, state?: BudgetProgress['state']): BudgetProgress => ({
    scope: 'service',
    id: 'p',
    unit: 'tokens',
    limit: 100,
    used,
    ...(state ? { state } : {}),
  })

  it('is a limit window with the same word, amber from 80%, red when used up, resetting with the month', () => {
    expect(budgetLimit(budget(42), '主服务', '2026-11')).toEqual({
      key: 'service:p',
      name: '主服务',
      state: 'ok',
      percent: 42,
      reset: '12 月 1 日重置',
    })
    expect(budgetLimit(budget(85, 'near'), '主服务', '2026-12')).toMatchObject({ state: 'near', percent: 85, reset: '1 月 1 日重置' })
    expect(budgetLimit(budget(130, 'over'), '主服务', '2026-11')).toMatchObject({ state: 'limited', percent: 100 })
    expect(usedWords(budgetLimit(budget(42), '本月预算', '2026-11'))).toBe('已用 42%')
  })
})

describe('the estimate', () => {
  it('says what share of the measured requests has no known cost', () => {
    const row = (measured: number, uncosted: number) =>
      ({ requests: measured, failed: 0, fallbacks: 0, measured, uncosted, cost: [], partial: {} }) as never
    expect(unpricedShare([row(3, 1), row(1, 0)])).toBe(25)
    expect(unpricedShare([row(2, 0)])).toBe(0)
    expect(unpricedShare([])).toBe(0)
  })
})
