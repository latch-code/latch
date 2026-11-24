// @vitest-environment happy-dom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { ContextWindowBreakdown, SessionContext } from '@latch/protocol'
import * as ui from '@latch/ui'
import { SessionContextPanel } from '../src/panel/SessionContextPanel.tsx'
import { projectSessionContext } from '../src/panel/sessionContext.ts'

const at = '2026-11-24T00:00:00.000Z'
const privateTool = { kind: 'used', id: 'system_tools', tokens: 7800, name: 'PRIVATE_TOOL_NAME' } as const
const breakdown: ContextWindowBreakdown = {
  measurement: 'full',
  categories: [
    { kind: 'used', id: 'messages', tokens: 13000 },
    privateTool,
    { kind: 'used', id: 'system_prompt', tokens: 3200 },
    { kind: 'free', id: 'free_space', tokens: 164000 },
    { kind: 'buffer', id: 'autocompact_buffer', tokens: 12000 },
    { kind: 'deferred', id: 'mcp_tools_deferred', tokens: 14000 },
  ],
  messageBreakdown: { toolResults: 8000, userMessages: 1200 },
  providerUsage: { inputTokens: 5910, outputTokens: 48 },
}

function context(used: number, size?: number, composition = breakdown) {
  return projectSessionContext({
    harnessId: 'claude',
    messages: [{ id: 'PRIVATE_TURN_ID', role: 'user', text: 'PRIVATE_MESSAGE', createdAt: at }],
    usageReport: {
      at,
      contextUsed: used,
      ...(size === undefined ? {} : { contextSize: size }),
      contextSource: 'claude-sdk',
      breakdown: composition,
    },
  }).context
}

type RenderPanel = (value: SessionContext) => React.ReactElement | Promise<React.ReactElement>
const entries: Array<{ name: string; panel: RenderPanel }> = [
  { name: 'built-in Context', panel: value => React.createElement(SessionContextPanel, { context: value }) },
  {
    name: 'marketplace Context',
    async panel(value) {
      const modulePath = '../../../examples/context-insights/panel.mjs'
      const { default: Panel }: { default: React.ComponentType<ui.ContextPluginPanelProps<SessionContext>> } = await import(modulePath)
      return React.createElement(Panel, { react: React, ui, locale: 'zh-CN', context: value, revealTurn() {}, revealTool() {} })
    },
  },
]

const usedChart = '.context-window-used-parts'
const messageChart = '.context-window-message-parts'
const capacityChart = '.context-window-capacity-parts'
const bar = '.context-window-parts-bar'

function sectionFor(root: Element, title: string) {
  const heading = [...root.querySelectorAll('h4')].find(node => node.textContent === title)
  expect(heading, title).toBeDefined()
  return heading!.parentElement!
}

function expectChart(chart: Element, total: number, readings: ReadonlyArray<readonly [string, number, string]>) {
  const track = chart.querySelector(bar)!
  expect(track.getAttribute('aria-hidden')).toBe('true')
  const segments = [...track.querySelectorAll<HTMLElement>('span')]
  const rows = [...chart.querySelectorAll('.ui-share-parts li')]
  expect(segments).toHaveLength(readings.length)
  expect(rows).toHaveLength(readings.length)
  for (const [label, tokens, percent] of readings) {
    const index = rows.findIndex(row => row.querySelector('.ui-share-name')?.textContent === label)
    expect(index, label).toBeGreaterThanOrEqual(0)
    expect(rows[index]!.querySelector('.ui-share-value')?.textContent).toBe(`${tokens.toLocaleString('zh-CN')} tokens`)
    expect(rows[index]!.querySelector('.ui-share-percent')?.textContent).toBe(percent)
    const width = segments[index]!.style.width
    expect(width).toMatch(/%$/u)
    expect(Number.parseFloat(width)).toBeCloseTo((tokens / total) * 100, 6)
  }
}

describe.each(entries)('$name window breakdown', ({ panel }) => {
  async function render(value: SessionContext) {
    const element = await panel(value)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      await React.act(() => root.render(element))
      const composition = host.querySelector('.context-window-breakdown')
      expect(composition).not.toBeNull()
      return { composition: composition!.cloneNode(true) as Element, text: host.textContent }
    } finally {
      await React.act(() => root.unmount())
      vi.unstubAllGlobals()
    }
  }

  it('uses the three reported denominators and keeps deferred and provider tokens separate', async () => {
    const { composition, text } = await render(context(24000, 200000))
    expect(text).toContain('24,000 / 200,000 tokens')
    expect(text).not.toContain('PRIVATE_')
    const used = composition.querySelector(usedChart)!
    expect(used.parentElement?.textContent).toContain('已用 24,000 tokens')
    expectChart(used, 24000, [
      ['消息', 13000, '54.2%'],
      ['内置工具', 7800, '32.5%'],
      ['系统提示词', 3200, '13.3%'],
    ])

    const messages = composition.querySelector('details.context-window-messages')!
    expect(messages.querySelector('summary')?.textContent).toBe('其中，消息包含')
    expect(messages.textContent).toContain('消息共 13,000 tokens')
    expectChart(messages.querySelector(messageChart)!, 13000, [
      ['工具结果', 8000, '61.5%'],
      ['用户消息', 1200, '9.2%'],
      ['未细分', 3800, '29.2%'],
    ])

    const capacity = composition.querySelector(capacityChart)!
    expectChart(capacity, 200000, [
      ['已用', 24000, '12%'],
      ['空闲空间', 164000, '82%'],
      ['压缩预留', 12000, '6%'],
    ])

    const deferred = sectionFor(composition, '延迟加载')
    expect(deferred.textContent).toContain('未计入窗口占用')
    expect(deferred.textContent).toContain('14,000 tokens')
    expect(deferred.querySelector(bar)).toBeNull()
    const provider = sectionFor(composition, '最近一次模型服务用量')
    expect(provider.textContent).toMatch(/输入 tokens\s*5,910\s*输出 tokens\s*48/u)
    expect(provider.querySelector(bar)).toBeNull()
  })

  it.each([undefined, 0, 210000])('keeps reported amounts when capacity cannot be allocated (%s)', async size => {
    const { composition } = await render(context(24000, size))
    expect(composition.querySelector(`${usedChart} ${bar}`)).not.toBeNull()
    expect(composition.querySelector(`${messageChart} ${bar}`)).not.toBeNull()
    expect(composition.querySelector(`${capacityChart} ${bar}`)).toBeNull()
    expect(composition.textContent).toContain('164,000 tokens')
    expect(composition.textContent).toContain('12,000 tokens')
  })

  it('uses total usage even when some of it was not classified', async () => {
    const { composition } = await render(context(26000, 202000))
    const used = composition.querySelector(usedChart)!
    expect(used.parentElement?.textContent).toContain('已用 26,000 tokens · 已分类 24,000 tokens')
    expectChart(used, 26000, [
      ['消息', 13000, '50%'],
      ['内置工具', 7800, '30%'],
      ['系统提示词', 3200, '12.3%'],
    ])
  })

  it('keeps exact category counts when their subtotal exceeds the reported usage', async () => {
    const { composition } = await render(context(22000, 198000))
    const used = composition.querySelector(usedChart)!
    expect(used.parentElement?.textContent).toContain('已用 22,000 tokens · 已分类 24,000 tokens')
    expect(used.textContent).toContain('消息13,000 tokens')
    expect(used.textContent).not.toContain('%')
    expect(used.querySelector(bar)).toBeNull()
    expect(composition.querySelector(`${capacityChart} ${bar}`)).not.toBeNull()
  })

  it.each([
    { name: 'message subtotal exceeds its parent', categories: breakdown.categories, toolResults: 12000 },
    { name: 'message total was omitted', categories: breakdown.categories.filter(row => row.id !== 'messages'), toolResults: 12000 },
  ])('retains message counts without guessing their shares when $name', async ({ categories, toolResults }) => {
    const { composition } = await render(
      context(24000, 200000, { ...breakdown, categories, messageBreakdown: { toolResults, userMessages: 1200 } }),
    )
    const messages = composition.querySelector('details.context-window-messages')!
    expect(messages.textContent).toMatch(/工具结果\s*12,000 tokens/u)
    expect(messages.textContent).toMatch(/用户消息\s*1,200 tokens/u)
    expect(messages.textContent).not.toMatch(/未细分|%/u)
    expect(messages.querySelector(bar)).toBeNull()
  })

  it('keeps explicit zeros without making a proportion out of a zero total', async () => {
    const { composition } = await render(
      context(0, 0, {
        measurement: 'full',
        categories: [{ kind: 'used', id: 'messages', tokens: 0 }],
        messageBreakdown: { toolResults: 0 },
      }),
    )
    expect(composition.querySelector(bar)).toBeNull()
    expect(composition.textContent).toMatch(/工具结果\s*0 tokens/u)
    expect(composition.textContent).not.toMatch(/NaN|Infinity|%/u)
  })
})
