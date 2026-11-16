import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot, BudgetProgress, ModelUsageRow } from '@latch/protocol'
import { TurnFooter } from '../src/components/TurnFooter.tsx'
import { BudgetProgressLine } from '../src/settings/ModelSpend.tsx'
import { usageRowDetail, usageRowName, usageTotals, mergeSources } from '../src/usage/usage.ts'
import { settingsSections } from '../src/settings/SettingsPage.tsx'
import {
  budgetProgressText,
  budgetWords,
  costText,
  costsText,
  parseAmount,
  pricedNote,
  priceFields,
  readBudget,
  readPrices,
  rowCost,
  rowTokens,
  turnCostWords,
} from '../src/settings/modelSpend.ts'

const row = (extra: Partial<ModelUsageRow> = {}): ModelUsageRow => ({
  providerId: 'deepseek',
  requests: 3,
  failed: 1,
  fallbacks: 0,
  measured: 2,
  usage: { inputTokens: 12_400, outputTokens: 3100, cacheReadTokens: 400 },
  partial: { cacheReadTokens: false, cacheWriteTokens: true, reasoningTokens: true },
  cost: [],
  uncosted: 2,
  ...extra,
})

const device = (scopes: AppSnapshot['device']['scopes']) =>
  ({
    id: 'd',
    name: '浏览器',
    status: 'active',
    listener: 'loopback-tcp',
    scopes,
    dataScope: 'work',
    fingerprint: 'ABCD EFGH IJKL MNOP QRST',
    createdAt: '',
    lastSeenAt: '',
    credentialExpiresAt: '',
    pairedBy: { method: 'lpc' },
    current: true,
    renewAfter: '',
  }) as AppSnapshot['device']
const snapshot = (scopes: AppSnapshot['device']['scopes'], features: Record<string, true> = { modelUsage: true }) =>
  ({
    instanceId: 'host',
    device: device(scopes),
    host: { hostId: 'h', devMode: false, presence: { status: 'available' }, tls: null },
    catalog: {
      harnesses: [],
      providers: [
        { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', models: ['deepseek-chat'], defaultModel: 'deepseek-chat' },
      ],
      workspaces: [],
      defaults: { harnessId: 'standard', mode: 'agent' },
      features,
    },
    tasks: [{ id: 'session-1', title: '修登录页' }],
    customAgents: [{ id: 'agent-1', name: '资料整理' }],
    approvals: [],
    demo: false,
    hostName: 'studio-mini',
  }) as unknown as AppSnapshot

describe('what a cost and a budget read as', () => {
  it('writes an amount in its currency, small ones to four places, and nothing when none is known', () => {
    expect(costText({ currency: 'USD', micros: 2100 })).toBe('$0.0021')
    expect(costText({ currency: 'CNY', micros: 12_500_000 })).toBe('¥12.50')
    expect(costText({ currency: 'USD', micros: 0 })).toBe('$0.00')
    expect(costsText([])).toBeUndefined()
    expect(costsText(undefined)).toBeUndefined()
    expect(
      costsText([
        { currency: 'USD', micros: 2100 },
        { currency: 'CNY', micros: 300_000, priced: true },
      ]),
    ).toBe('$0.0021 + ¥0.3000')
    expect(pricedNote([{ currency: 'USD', micros: 1 }])).toBeUndefined()
    expect(pricedNote([{ currency: 'USD', micros: 1, priced: true }])).toBe('按你填的单价')
  })

  it('says a row’s tokens and cost only when a service reported them: 未报告, never 0', () => {
    expect(rowTokens(row(), 'inputTokens')).toBe('12.4k')
    expect(rowCost(row())).toBe('未报告')
    const silent = row({ usage: undefined, measured: 0, uncosted: 0 })
    expect(rowTokens(silent, 'inputTokens')).toBe('未报告')
    expect(rowTokens(silent, 'outputTokens')).toBe('未报告')
    expect(usageRowDetail(silent)).toBe('3 次请求没有报告用量')
    expect(usageRowDetail(row())).toContain('缓存读取 400')
    expect(usageRowDetail(row())).toContain('缓存写入 未报告')
    expect(usageRowDetail(row())).toContain('推理 未报告')
    const priced = row({ cost: [{ currency: 'CNY', micros: 5_000_000, priced: true }], uncosted: 1 })
    expect(rowCost(priced)).toBe('¥5.00')
    expect(usageRowDetail(priced)).toContain('1 次请求的花费未知')
    expect(usageRowDetail(priced)).toContain('按你填的单价')
  })

  it('totals what is shown: no token total when no row reported any', () => {
    expect(
      usageTotals([row({ cost: [{ currency: 'USD', micros: 5 }] }), row({ cost: [{ currency: 'USD', micros: 7, priced: true }] })]),
    ).toMatchObject({ turns: 0, requests: 6, tokens: 31_000, cost: [{ currency: 'USD', micros: 12, priced: true }] })
    expect(usageTotals([row({ usage: undefined })])).toEqual({ turns: 0, requests: 3, inputTokens: 0, outputTokens: 0, cost: [] })
    // Own-login turns count as turns, and cache reads only while every measured row reported them.
    const own = {
      ...row({ usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80 } }),
      by: 'own' as const,
      turns: 2,
      requests: 0,
    }
    expect(usageTotals([own])).toMatchObject({ turns: 2, requests: 0, tokens: 110, cacheReadTokens: 80 })
    expect(usageTotals([own, row()]).cacheReadTokens).toBe(own.usage!.cacheReadTokens! + 400)
    expect(usageTotals([own, row({ usage: { inputTokens: 1, outputTokens: 1 } })])).not.toHaveProperty('cacheReadTokens')
  })

  it('makes one row of a thing from every source, keeping each source’s tokens', () => {
    const gateway = {
      ...row({ providerId: undefined, harness: 'codex', cost: [{ currency: 'USD' as const, micros: 5, priced: true as const }] }),
      by: 'gateway' as const,
      turns: 0,
    }
    const own = {
      ...row({ providerId: undefined, harness: 'codex', requests: 0, usage: { inputTokens: 100, outputTokens: 10 } }),
      by: 'own' as const,
      turns: 2,
    }
    const other = { ...row({ providerId: undefined, harness: 'pi' }), by: 'own' as const, turns: 1 }
    const merged = mergeSources([gateway, own, other])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({
      harness: 'codex',
      requests: 3,
      turns: 2,
      usage: { inputTokens: 12_500, outputTokens: 3110 },
      split: { gateway: 15_500, own: 110 },
      cost: [{ currency: 'USD', micros: 5, priced: true }],
    })
    // A part one source did not report is not summed from the other.
    expect(merged[0]!.usage).not.toHaveProperty('cacheReadTokens')
    expect(merged[1]).toMatchObject({ harness: 'pi', split: { own: 15_500 } })
  })

  it('names a row by what it is of, and says so when that is gone', () => {
    const view = snapshot(['view'])
    expect(usageRowName(row(), 'service', view)).toEqual({ name: 'DeepSeek' })
    expect(usageRowName(row({ model: 'deepseek-chat' }), 'model', view)).toEqual({ name: 'deepseek-chat', detail: 'DeepSeek' })
    expect(usageRowName(row({ providerId: 'removed' }), 'service', view)).toEqual({ name: 'removed' })
    expect(usageRowName(row({ agentId: 'agent-1' }), 'agent', view)).toEqual({ name: '资料整理' })
    expect(usageRowName(row({ agentId: 'gone' }), 'agent', view)).toEqual({ name: '已删除的 Agent' })
    expect(usageRowName(row(), 'agent', view)).toEqual({ name: '其他' })
    expect(usageRowName(row({ providerId: undefined }), 'session', view)).toEqual({ name: '其他会话' })
    expect(usageRowName(row({ sessionId: 'session-1' }), 'session', view)).toEqual({ name: '修登录页' })
    expect(usageRowName(row({ sessionId: 'gone' }), 'session', view)).toEqual({ name: '已不在的会话' })
  })

  it('shows a budget’s use, amber words at 80% and red ones when it is used up', () => {
    const budget = (used: number, state?: BudgetProgress['state']): BudgetProgress => ({
      scope: 'service',
      id: 'deepseek',
      unit: 'tokens',
      limit: 100_000,
      used,
      ...(state ? { state } : {}),
    })
    expect(budgetProgressText(budget(12_400))).toBe('12.4k / 100k tokens')
    expect(budgetProgressText({ scope: 'agent', id: 'a', unit: 'cost', currency: 'CNY', limit: 5, used: 1.2 })).toBe('¥1.20 / ¥5.00')
    expect(budgetWords(undefined)).toBeUndefined()
    expect(budgetWords('near')).toEqual({ tone: 'warn', text: '预算已用 80%' })
    expect(budgetWords('over')).toEqual({ tone: 'failed', text: '本月预算已用完' })
    const calm = renderToStaticMarkup(createElement(BudgetProgressLine, { budget: budget(12_400) }))
    expect(calm).toContain('12%')
    expect(calm).not.toContain('data-tone')
    const near = renderToStaticMarkup(createElement(BudgetProgressLine, { budget: budget(85_000, 'near') }))
    expect(near).toContain('data-tone="warn"')
    expect(near).toContain('预算已用 80%')
    const over = renderToStaticMarkup(createElement(BudgetProgressLine, { budget: budget(120_000, 'over') }))
    expect(over).toContain('data-tone="failed"')
    expect(over).toContain('本月预算已用完')
    expect(over).toContain('role="meter"')
    // A cost budget says how many requests it could not count.
    expect(calm).not.toContain('未计入')
    const partial = renderToStaticMarkup(
      createElement(BudgetProgressLine, {
        budget: { scope: 'service', id: 'deepseek', unit: 'cost', currency: 'CNY', limit: 5, used: 1.2, uncounted: 3 },
      }),
    )
    expect(partial).toContain('未计入 3 次')
  })
})

describe('what a person types', () => {
  it('becomes a price only as plain numbers, the two cache prices left out when empty', () => {
    expect(parseAmount('0.28', 100)).toBe(0.28)
    expect(parseAmount(' 2 ', 100)).toBe(2)
    for (const text of ['', '-1', '1e3', '1,000', 'abc', '1.', '.5', '101', '0.1234567']) expect(parseAmount(text, 100)).toBeUndefined()
    const empty = priceFields(undefined)
    expect(empty).toEqual({ currency: 'USD', input: '', output: '', cacheRead: '', cacheWrite: '' })
    expect(readPrices(empty)).toEqual({ invalid: 'input' })
    expect(readPrices({ ...empty, input: '2', output: 'x' })).toEqual({ invalid: 'output' })
    expect(readPrices({ ...empty, currency: 'CNY', input: '2', output: '8' })).toEqual({ prices: { currency: 'CNY', input: 2, output: 8 } })
    expect(readPrices({ currency: 'CNY', input: '2', output: '8', cacheRead: '0.2', cacheWrite: '' })).toEqual({
      prices: { currency: 'CNY', input: 2, output: 8, cacheRead: 0.2 },
    })
    expect(readPrices({ currency: 'CNY', input: '2', output: '8', cacheRead: '', cacheWrite: 'free' })).toEqual({ invalid: 'cacheWrite' })
    expect(priceFields({ currency: 'CNY', input: 2, output: 8, cacheRead: 0.2 })).toEqual({
      currency: 'CNY',
      input: '2',
      output: '8',
      cacheRead: '0.2',
      cacheWrite: '',
    })
  })

  it('becomes a budget of whole tokens, or of an amount in one currency', () => {
    expect(readBudget({ unit: 'tokens', currency: 'USD', limit: '1000000' })).toEqual({ unit: 'tokens', limit: 1_000_000 })
    expect(readBudget({ unit: 'tokens', currency: 'USD', limit: '1.5' })).toBeUndefined()
    expect(readBudget({ unit: 'tokens', currency: 'USD', limit: '0' })).toBeUndefined()
    expect(readBudget({ unit: 'tokens', currency: 'USD', limit: '' })).toBeUndefined()
    expect(readBudget({ unit: 'cost', currency: 'CNY', limit: '50' })).toEqual({ unit: 'cost', currency: 'CNY', limit: 50 })
    expect(readBudget({ unit: 'cost', currency: 'CNY', limit: '0.5' })).toEqual({ unit: 'cost', currency: 'CNY', limit: 0.5 })
    expect(readBudget({ unit: 'cost', currency: 'CNY', limit: '9999999' })).toBeUndefined()
  })
})

describe('the turn footer', () => {
  const footer = (turn: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(TurnFooter, {
        turn: { key: 'u', user: { id: 'u', role: 'user', text: 'hi', turnId: 't1', turn }, replies: [] } as never,
        actions: { onCopy: () => {} },
      }),
    )

  it('says what the turn cost when the Host knows, and nothing of cost when it does not', () => {
    expect(turnCostWords(undefined)).toBeUndefined()
    expect(turnCostWords({ budget: 'near' })).toBeUndefined()
    expect(turnCostWords({ cost: [{ currency: 'USD', micros: 2100 }] })).toEqual({ text: '花费 $0.0021' })
    expect(turnCostWords({ cost: [{ currency: 'CNY', micros: 80_000, priced: true }] })).toEqual({
      text: '花费 ¥0.0800',
      note: '按你填的单价',
    })
    expect(footer({})).not.toContain('花费')
    // A turn through Latch carries it on its routed record, a built-in turn on the turn itself.
    expect(footer({ routed: { requests: 1, models: [], spend: { cost: [{ currency: 'USD', micros: 2100 }] } } })).toContain('花费 $0.0021')
    expect(footer({ spend: { cost: [{ currency: 'CNY', micros: 12_500_000 }] } })).toContain('花费 ¥12.50')
  })

  it('notes a budget at 80% in amber and one that is used up in red, in words', () => {
    const near = footer({ spend: { budget: 'near' } })
    expect(near).toContain('预算已用 80%')
    expect(near).toContain('data-tone="warn"')
    const over = footer({ routed: { requests: 1, models: [], spend: { budget: 'over' } } })
    expect(over).toContain('本月预算已用完')
    expect(over).toContain('data-tone="failed"')
    expect(footer({})).not.toContain('预算')
  })
})

describe('设置', () => {
  it('keeps only configuration: what was used is in 额度与用量, not a section of its own', () => {
    expect(settingsSections(snapshot(['view', 'run']))).toEqual(['general', 'devices', 'shortcuts', 'about'])
    expect(settingsSections(snapshot(['view', 'run', 'admin']))).not.toContain('usage')
  })
})
