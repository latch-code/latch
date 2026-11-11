import { createElement, Fragment } from 'react'
import { testHarness } from '@latch/testkit'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { HostCatalog, TaskDetail, TaskSummary } from '@latch/protocol'
import { BranchSegment, ComposerStatus, FolderSegment, statusRoute } from '../src/composer/ComposerStatus.tsx'
import { contextWords } from '../src/composer/permission.ts'
import { sessionTotals } from '../src/composer/sessionTotals.ts'
import { SessionFacts } from '../src/shell/SessionEnvironment.tsx'

const builtin = testHarness('latch', { kind: 'builtin', label: 'Latch 内置' })
const opencode = testHarness('opencode', { label: 'OpenCode' })
const codex = testHarness('codex', { label: 'Codex' })
const openai = { id: 'openai', name: 'OpenAI', kind: 'openai-responses' as const, models: ['gpt-5.5'], defaultModel: 'gpt-5.5' }
const catalog: HostCatalog = {
  harnesses: [builtin, opencode, codex],
  providers: [openai],
  workspaces: [],
  defaults: { harnessId: builtin.id, mode: 'agent', workspaceId: 'default' },
}
const at = (minute: number) => new Date(Date.UTC(2026, 10, 11, 9, minute)).toISOString()
const summary = (extra: Partial<TaskSummary> = {}): TaskSummary =>
  ({ id: 's1', title: '修复', status: 'idle', updatedAt: at(9), harnessId: 'latch', cwd: '/work/latch', ...extra }) as TaskSummary
const detail = (extra: Partial<TaskDetail> = {}, owner = summary()): TaskDetail => ({
  summary: owner,
  messages: [
    { id: 'u1', role: 'user', text: '一', createdAt: at(1), turn: { endedAt: at(2), activeMs: 72_000, waitMs: 0 } },
    { id: 'a1', role: 'assistant', text: '好', completedAt: at(2) },
    { id: 'u2', role: 'user', text: '二', createdAt: at(3), turn: { endedAt: at(8), activeMs: 300_000, waitMs: 0 } },
    { id: 'a2', role: 'assistant', text: '好', completedAt: at(8) },
  ],
  approvals: [],
  liveText: '',
  cursor: 1,
  ...extra,
})
const usage = { inputTokens: 212_000, outputTokens: 9400 }
/** The visible words of the line, segment by segment, without what their tooltips say. */
const segments = (markup: string) =>
  [...markup.matchAll(/data-seg="([a-z]+)">(.*?)<\/span>(?=<span class="composer-status-(?:seg|gap)"|<\/div>$)/gu)].map(
    ([, kind, inner]) => [
      kind,
      inner!
        .replace(/<span[^>]*role="tooltip"[^>]*>.*?<\/span>/gu, ' ')
        .replace(/<[^>]+>/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim(),
    ],
  )
const line = (props: Parameters<typeof ComposerStatus>[0]) => renderToStaticMarkup(createElement(ComposerStatus, props))

describe('the composer status line', () => {
  it('says what the built-in Harness reported: tokens without a reporter, no context it did not report, no route', () => {
    const owner = summary({ usage })
    const markup = line({
      place: createElement(FolderSegment, { name: 'latch', tip: '文件夹 /work/latch' }),
      route: statusRoute(catalog, builtin, {}),
      totals: sessionTotals({ summary: owner, detail: detail({}, owner), harness: builtin }),
    })
    expect(segments(markup)).toEqual([
      ['folder', 'latch'],
      ['tokens', '输入 212k 输出 9.4k'],
      ['time', '6 分 12 秒 · 2 轮'],
    ])
    expect(markup).not.toContain('role="meter"')
    expect(markup).not.toContain('报告')
  })

  it('names the external Harness that reported the tokens, and never shows its cost without saying it is not a bill', () => {
    const owner = summary({ usage, harnessId: 'opencode' })
    const totals = sessionTotals({
      summary: owner,
      detail: detail(
        { usageReport: { contextUsed: 41_000, contextSize: 256_000, cost: { amount: 0.21, currency: 'USD' }, at: at(8) } },
        owner,
      ),
      harness: opencode,
    })
    const markup = line({ route: statusRoute(catalog, opencode, {}), totals })
    expect(segments(markup)).toEqual([
      ['route', 'OpenCode 自己的模型'],
      ['context', '上下文 41k / 256k'],
      ['tokens', '输入 212k 输出 9.4k 由 OpenCode 报告'],
      ['cost', 'US$0.21 由 OpenCode 报告，不是账单'],
      ['time', '6 分 12 秒 · 2 轮'],
    ])
    expect(markup).toContain('role="meter"')
    expect(markup).toContain('aria-valuetext="41k / 256k"')
  })

  it('says a routed session goes through Latch by the service’s name, and the words its menu uses once the service is off', () => {
    const route = { providerId: 'openai', model: 'gpt-5.5', name: 'OpenAI' }
    expect(statusRoute(catalog, codex, { route })).toMatchObject({ text: 'OpenAI · 经 Latch', provider: { id: 'openai' } })
    // A turn that did not go through Latch is said in the conversation; the route keeps its words.
    expect(statusRoute(catalog, codex, { route: { ...route, bypassed: true } })?.text).toBe('OpenAI · 经 Latch')
    const off = { ...catalog, providers: [] }
    expect(statusRoute(off, codex, { route: { ...route, off: true } })).toMatchObject({
      text: 'OpenAI · 已停用',
      note: '这个会话开始时用的「OpenAI」已停用，下一轮会失败。在设置 › 模型里重新打开它，或新开一个会话。',
    })
    // A draft says the service it picked, or the Harness's own models.
    expect(statusRoute(catalog, codex, { picked: { providerId: 'openai', model: 'gpt-5.5' } })?.text).toBe('OpenAI · 经 Latch')
    expect(statusRoute(catalog, codex, {})?.text).toBe('Codex 自己的模型')
    expect(statusRoute(catalog, undefined, {})).toBeUndefined()
  })

  it('has nothing to say of a first turn still running: no tokens, no time', () => {
    const owner = summary({ status: 'running', harnessId: 'codex' })
    const running = detail({ messages: [{ id: 'u1', role: 'user', text: '一', createdAt: at(1) }] }, owner)
    const totals = sessionTotals({ summary: owner, detail: running, harness: codex })
    expect(totals).toEqual({ by: 'Codex' })
    expect(segments(line({ route: statusRoute(catalog, codex, {}), totals }))).toEqual([['route', 'Codex 自己的模型']])
  })

  it('writes the context without a meter when the Harness reported no window size', () => {
    const owner = summary()
    const totals = sessionTotals({
      summary: owner,
      detail: detail({ usageReport: { contextUsed: 74_210, at: at(8) } }, owner),
      harness: codex,
    })
    const markup = line({ totals })
    expect(segments(markup)).toContainEqual(['context', '上下文 74.2k'])
    expect(markup).not.toContain('role="meter"')
  })

  it('shows a draft where it would work and which way its model goes, and nothing of use', () => {
    const markup = line({
      place: createElement(
        Fragment,
        null,
        createElement(FolderSegment, { name: 'latch', tip: '项目 latch' }),
        createElement(BranchSegment, { branch: 'feat/enroll-check' }),
      ),
      route: statusRoute(catalog, codex, { picked: { providerId: 'openai', model: 'gpt-5.5' } }),
    })
    expect(segments(markup)).toEqual([
      ['folder', 'latch'],
      ['branch', 'feat/enroll-check'],
      ['route', 'OpenAI · 经 Latch'],
    ])
  })

  it('keeps only the context on a phone, and only with both numbers', () => {
    const owner = summary({ usage })
    const full = sessionTotals({
      summary: owner,
      detail: detail({ usageReport: { contextUsed: 62_000, contextSize: 272_000, at: at(8) } }, owner),
      harness: codex,
    })
    const place = createElement(FolderSegment, { name: 'latch', tip: '' })
    expect(segments(line({ place, route: statusRoute(catalog, codex, {}), totals: full, phone: true }))).toEqual([
      ['context', '上下文 62k / 272k'],
    ])
    const sizeless = sessionTotals({
      summary: owner,
      detail: detail({ usageReport: { contextUsed: 62_000, at: at(8) } }, owner),
      harness: codex,
    })
    expect(line({ place, totals: sizeless, phone: true })).toBe('')
  })

  it('reads the same totals as the title row’s popover, and the same share as its context words', () => {
    const owner = summary({ usage, harnessId: 'opencode' })
    const report = { contextUsed: 41_000, contextSize: 256_000, cost: { amount: 0.21, currency: 'USD' }, at: at(8) }
    const open = detail({ usageReport: report }, owner)
    const popover = renderToStaticMarkup(
      createElement(SessionFacts, { summary: owner, detail: open, harness: opencode, gate: { kind: 'open' } }),
    )
    const totals = sessionTotals({ summary: owner, detail: open, harness: opencode })
    expect(popover).toContain(`${totals.cost!.text} · 由 OpenCode 报告，不是账单`)
    expect(popover).toContain(totals.time!.text)
    expect(contextWords(report)?.percent).toBe(totals.context?.percent)
    // Another session's detail is never read as this one's.
    expect(sessionTotals({ summary: summary({ id: 'other', usage }), detail: open, harness: opencode })).not.toHaveProperty('cost')
  })
})
