import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Approval, AppSnapshot, Message, TaskDetail, TaskSummary } from '@latch/protocol'
import { sha256Hex } from '@latch/core/node-kit'
import { hashDisplay } from '@latch/host/crypto'
import { Inspector } from '../src/components/Inspector.tsx'
import { MessageRow } from '../src/components/MessageRow.tsx'
import { PlanList } from '../src/components/PlanCard.tsx'
import { DiffView } from '../src/components/DiffView.tsx'
import { ToolCard } from '../src/components/ToolCard.tsx'
import { Transcript } from '../src/components/Transcript.tsx'
import { renderedMessages } from '../src/conversation.ts'
import { escapeHiddenCharacters, hasHiddenCharacters, VisibleText } from '../src/components/VisibleText.tsx'
import { contentHash } from '../src/core/contentHash.ts'
import { revokeText } from '../src/settings/DevicesSettings.tsx'

const noop = () => {}
afterEach(() => {
  vi.unstubAllGlobals()
})
const approval = (extra: Partial<Approval> = {}): Approval => ({
  id: 'ap1',
  sessionId: 's',
  toolName: 'write_file',
  toolCallId: 'c1',
  reason: '写入需要确认',
  arguments: '{}',
  requestedAt: new Date().toISOString(),
  ...extra,
})
const tool = (extra: Partial<Message> = {}): Message => ({
  id: 'tool:c1',
  role: 'tool',
  toolName: 'write_file',
  state: 'awaiting-approval',
  text: '',
  ...extra,
})

const session = (extra: Partial<TaskSummary> = {}): TaskSummary => ({ id: 's', title: 't', status: 'idle', updatedAt: '', ...extra })
const appSnapshot = (extra: Partial<AppSnapshot> = {}): AppSnapshot => ({
  instanceId: 'host',
  device: {
    id: 'd',
    name: 'Mac',
    status: 'active',
    listener: 'loopback-tcp',
    scopes: ['view', 'run', 'approve:standard', 'admin'],
    dataScope: 'work',
    fingerprint: 'ABCD EFGH IJKL MNOP QRST',
    createdAt: '',
    lastSeenAt: '',
    credentialExpiresAt: '',
    pairedBy: { method: 'lpc' },
    current: true,
    renewAfter: '',
  },
  host: {
    hostId: 'h',
    devMode: true,
    presence: { status: 'available' },
    tls: null,
    policy: { localMaxLevel: 'L2', remoteMaxLevel: 'L1', allowL3: true },
  },
  tasks: [],
  approvals: [],
  demo: false,
  hostName: 'host',
  ...extra,
})

/**
 * The text of every element whose class list has `className`, tooltips left out: a small reader for the static markup
 * of a component.
 */
function textsOf(html: string, className: string): string[] {
  const found: string[] = []
  const stack: Array<{ capture: boolean; tooltip: boolean; text: string }> = []
  const empty = new Set(['img', 'br', 'input', 'link', 'meta', 'hr', 'path', 'rect', 'circle'])
  for (const match of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*?)(\/?)>|([^<]+)/gu)) {
    const [, closing, tag = '', attributes = '', selfClosing, text] = match
    if (text !== undefined) {
      if (stack.some(frame => frame.tooltip)) continue
      for (const frame of stack) if (frame.capture) frame.text += text
      continue
    }
    if (closing) {
      const frame = stack.pop()
      if (frame?.capture) found.push(frame.text)
      continue
    }
    if (selfClosing || empty.has(tag)) continue
    const classes = /class="([^"]*)"/u.exec(attributes)?.[1]?.split(/\s+/u) ?? []
    stack.push({ capture: classes.includes(className), tooltip: attributes.includes('role="tooltip"'), text: '' })
  }
  return found
}

/** Numbers left without a unit, after times of day, dates, money and the numerator of 「10 / 100 tokens」. */
const bareNumbers = (text: string) =>
  text
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/gu, '')
    .replace(/(?:\d{4}年)?\d{1,2}月\d{1,2}日/gu, '')
    .replace(/(?:US)?[$¥€£]\s?[\d.,]+/gu, '')
    .replace(/[\d.,]+[kM]?\s*\/\s*(?=\d)/gu, '')
    .replace(/[\d.,]+[kM]?\s*(?:tokens|秒|分|小时|个|条|次|轮|处|行|%)/gu, '')
    .match(/\d+/gu) ?? []

/** A local time on 24 October 2026, as the Host writes it. */
const localIso = (minutes: number) => new Date(2026, 9, 24, 14, minutes).toISOString()

const transcriptOf = (detail: TaskDetail, active: boolean) =>
  renderToStaticMarkup(createElement(Transcript, { detail, approvals: [], busy: new Map(), onDecide: noop, harnessName: 'Latch', active }))

describe('tool cards', () => {
  it('merges a pending approval into its tool card with the Host options, allow-once last', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCard, {
        message: tool({ tool: { kind: 'edit', title: '写入 a.ts' } }),
        approval: approval({
          options: [
            { id: 'allow_once', label: '允许一次', kind: 'allow_once' },
            { id: 'allow_always', label: '本会话始终允许', kind: 'allow_always' },
            { id: 'reject_once', label: '拒绝', kind: 'reject_once' },
          ],
        }),
        onDecide: noop,
      }),
    )
    expect(html).toContain('data-message-id="tool:c1"')
    expect(html).toContain('data-approval-id="ap1"')
    expect(html).toContain('写入 a.ts')
    expect(html).toContain('<code class="tool-card-name">write_file</code>')
    expect(html).toContain('无参数')
    expect(html).not.toContain('{}')
    // Two buttons at most: reject, then the blue allow once; the Host's other options wait behind ⋯.
    expect([...html.matchAll(/<button[^>]*class="ui-button"[^>]*>([^<]+)<\/button>/g)].map(match => match[1])).toEqual(['拒绝', '允许一次'])
    expect(html).toMatch(/<button[^>]*class="ui-button"[^>]*data-variant="primary"[^>]*>允许一次<\/button>/)
    expect(html).toContain('aria-label="更多批准选项"')
    expect(html).toContain('aria-haspopup="menu"')
  })

  it('offers allow once and reject when the driver sends no options', () => {
    const html = renderToStaticMarkup(createElement(ToolCard, { message: tool(), approval: approval(), onDecide: noop }))
    expect(html).toContain('>拒绝</button>')
    expect(html).toContain('>允许一次</button>')
  })

  it('shows the proposed diff in the approval and disables every option while one is in flight', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCard, {
        message: tool(),
        busy: 'allow_once',
        onDecide: noop,
        approval: approval({ arguments: '{"path":"a.ts"}', tool: { diffs: [{ path: 'a.ts', oldText: 'x\n', newText: 'y\n' }] } }),
      }),
    )
    // The diff's file header names the path, so it is not repeated as an argument.
    expect(html).toContain('<span class="diff-path" title="a.ts"><span class="diff-path-name">a.ts</span></span>')
    expect(html).not.toContain('<dt>path</dt>')
    expect(html).toContain('class="diff-stat-add">+1</span>')
    expect(html).toContain('class="diff-stat-remove">−1</span>')
    // The chosen option runs; the other stays focusable but takes no click.
    expect(html.match(/<button[^>]*class="ui-button"[^>]*aria-disabled="true"/g)).toHaveLength(1)
    expect(html.match(/<button[^>]*class="ui-button"[^>]*aria-busy="true"/g)).toHaveLength(1)
  })

  it("puts an opened card's changes in its paper and keeps a closed card's under its row, never a tray inside a tray", () => {
    const diffs = [{ path: 'src/a.ts', oldText: 'x\n', newText: 'y\n', previous: 'text' as const }]
    // A failure with output opens by itself: the changes are the paper's 变更, between 参数 and 输出.
    const open = renderToStaticMarkup(
      createElement(ToolCard, {
        message: tool({
          state: 'failed',
          text: '退出码 1',
          tool: { kind: 'edit', input: '{"path":"src/a.ts"}', output: '退出码 1', diffs },
        }),
        onDecide: noop,
      }),
    )
    expect(open.match(/class="diff-view"/g)).toHaveLength(1)
    const paper = open.slice(open.indexOf('class="tool-card-body"'))
    expect(paper.indexOf('<h4>参数</h4>')).toBeLessThan(paper.indexOf('<h4>变更</h4>'))
    expect(paper.indexOf('<h4>变更</h4>')).toBeLessThan(paper.indexOf('<h4>输出</h4>'))
    expect(paper.indexOf('class="diff-view"')).toBeGreaterThan(paper.indexOf('<h4>变更</h4>'))
    // Closed, the diff sits after the tray, outside it.
    const closed = renderToStaticMarkup(
      createElement(ToolCard, { message: tool({ state: 'completed', tool: { kind: 'edit', diffs } }), onDecide: noop }),
    )
    expect(closed.match(/class="diff-view"/g)).toHaveLength(1)
    expect(closed).not.toContain('<h4>变更</h4>')
    const tray = closed.indexOf('class="tool-tray"')
    expect(closed.indexOf('class="diff-view"')).toBeGreaterThan(closed.indexOf('</button>', tray))
    expect(closed.slice(tray, closed.indexOf('class="diff-view"'))).toMatch(/<\/div><\/div><\/div><div class="ui-collapse"/)
  })

  it('numbers a removed line by its old line in the single column phones keep', () => {
    const html = renderToStaticMarkup(
      createElement(DiffView, { diffs: [{ path: 'a.ts', oldText: 'a\nb\n', newText: 'a\nc\n', previous: 'text' }] }),
    )
    const removed = /<div class="diff-line diff-remove">(.*?)<\/div>/u.exec(html)?.[1] ?? ''
    expect(removed).toContain('<span class="diff-ln diff-ln-new" aria-hidden="true"></span>')
    expect(removed).toContain('<span class="diff-ln diff-ln-one" aria-hidden="true">2</span>')
    const added = /<div class="diff-line diff-add">(.*?)<\/div>/u.exec(html)?.[1] ?? ''
    expect(added).toContain('<span class="diff-ln diff-ln-one" aria-hidden="true">2</span>')
  })

  it('renders an approval without a matching tool row as its own card without a message anchor', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCard, { message: null, approval: approval({ toolCallId: undefined }), onDecide: noop }),
    )
    expect(html).not.toContain('data-message-id')
    expect(html).toContain('data-approval-id="ap1"')
  })
})

describe('assistant messages', () => {
  it('shows reported reasoning only when it exists and labels the live row', () => {
    const live = renderToStaticMarkup(
      createElement(MessageRow, { message: { id: 'm', role: 'assistant', text: '', reasoning: '想一想' }, streaming: true }),
    )
    expect(live).toContain('aria-label="正在生成的回复"')
    expect(live).toContain('正在思考')
    expect(live).toMatch(/class="process-row thinking-toggle" aria-expanded="true"/)
    expect(live).toContain('想一想')
    const settled = renderToStaticMarkup(
      createElement(MessageRow, {
        message: { id: 'm', role: 'assistant', text: '答案', reasoning: '想一想', usage: { inputTokens: 1500, outputTokens: 20 } },
      }),
    )
    expect(settled).not.toContain('正在生成的回复')
    expect(settled).toContain('思考过程')
    // Folded once the answer started; the body stays in the page for the browser's find.
    expect(settled).toMatch(/class="process-row thinking-toggle" aria-expanded="false"/)
    const timed = renderToStaticMarkup(
      createElement(MessageRow, { message: { id: 'm', role: 'assistant', text: '答案', reasoning: '想一想', reasoningMs: 6200 } }),
    )
    expect(timed).toContain('思考了 6.2 秒')
    const plain = renderToStaticMarkup(createElement(MessageRow, { message: { id: 'm', role: 'assistant', text: '答案' } }))
    expect(plain).not.toContain('思考')
  })

  it('renders the live reply under the ID it keeps and labels the harness once per turn', () => {
    const detail: TaskDetail = {
      summary: { id: 's', title: 't', status: 'running', updatedAt: '' },
      messages: [
        { id: 'u1', role: 'user', text: '一' },
        { id: 'a1', role: 'assistant', text: '' },
        tool({ state: 'completed' }),
        { id: 'a2', role: 'assistant', text: '好' },
        { id: 'u2', role: 'user', text: '二' },
      ],
      approvals: [],
      liveText: '继续',
      liveMessageId: 'a3',
      cursor: 1,
    }
    expect(renderedMessages(detail).map(message => message.id)).toEqual(['u1', 'a1', 'tool:c1', 'a2', 'u2', 'a3'])
    const html = renderToStaticMarkup(
      createElement(Transcript, { detail, approvals: [], busy: new Map(), onDecide: noop, harnessName: 'Standard' }),
    )
    expect([...html.matchAll(/data-message-id="([^"]+)"/g)].map(match => match[1])).toEqual(['u1', 'a1', 'tool:c1', 'a2', 'u2', 'a3'])
    expect(html.match(/class="assistant-meta"/g)).toHaveLength(2)
    expect(html).toContain('data-message-id="a3" aria-label="正在生成的回复"')
  })
})

describe('system notes', () => {
  it('draws a note that reports a failure in red and any other note as neutral information', () => {
    const failed = renderToStaticMarkup(
      createElement(MessageRow, { message: { id: 'n1', role: 'system', text: '模型服务返回错误（HTTP 503）', state: 'failed' } }),
    )
    expect(failed).toMatch(/<article class="message message-system is-failed"[^>]*><svg[^>]*lucide-circle-x/)
    const note = renderToStaticMarkup(createElement(MessageRow, { message: { id: 'n2', role: 'system', text: '已自动拒绝' } }))
    expect(note).toMatch(/<article class="message message-system"[^>]*><svg[^>]*lucide-info/)
  })
})

describe('turn footers', () => {
  const turn: Message[] = [
    { id: 'u1', role: 'user', text: '一' },
    { id: 'before', role: 'assistant', text: 'before', usage: { inputTokens: 100, outputTokens: 10 } },
    tool({ state: 'completed' }),
    { id: 'after', role: 'assistant', text: 'after', usage: { inputTokens: 200, outputTokens: 20 } },
    { id: 'u2', role: 'user', text: '二' },
    { id: 'next', role: 'assistant', text: '进行中' },
  ]

  const render = (active: boolean) =>
    renderToStaticMarkup(
      createElement(Transcript, {
        detail: {
          summary: { id: 's', title: 't', status: active ? 'running' : 'idle', updatedAt: '' },
          messages: turn,
          approvals: [],
          liveText: '',
          cursor: 1,
        },
        approvals: [],
        busy: new Map(),
        onDecide: noop,
        harnessName: 'Agent',
        active,
      }),
    )

  it('gives only the block that ends a settled turn a footer, with the turn usage summed', () => {
    const settled = render(false)
    expect(settled.match(/class="turn-footer[ "]/g)).toHaveLength(2)
    expect(settled).toContain('>输入 300 tokens</span>')
    expect(settled).toContain('>输出 30 tokens</span>')
    // The latest turn of a running session ends with the live line instead.
    const running = render(true)
    expect(running.match(/class="turn-footer[ "]/g)).toHaveLength(2)
    expect(running.match(/class="turn-footer is-live"/g)).toHaveLength(1)
    expect(running).toContain('等待模型…')
  })

  it('renders no copy control between tool calls of one turn', () => {
    const detail: TaskDetail = {
      summary: { id: 's', title: 't', status: 'idle', updatedAt: '' },
      messages: turn.slice(0, 4),
      approvals: [],
      liveText: '',
      cursor: 1,
    }
    const html = renderToStaticMarkup(
      createElement(Transcript, { detail, approvals: [], busy: new Map(), onDecide: noop, harnessName: 'Agent' }),
    )
    expect(html.match(/class="turn-footer[ "]/g)).toHaveLength(1)
    expect(html.match(/aria-label="复制回复"/g)).toHaveLength(1)
    expect(html).toContain('>输入 300 tokens</span>')
  })
})

describe('plan', () => {
  const plan = [
    { content: 'Read', status: 'completed' as const },
    { content: 'Write', status: 'in_progress' as const },
  ]
  it('marks the step in progress with a still mark, which reads as unfinished once the session settles', () => {
    // The running tool turns its spinner on its own row; the plan adds none.
    const running = renderToStaticMarkup(createElement(PlanList, { plan, active: true }))
    expect(running).toContain('lucide-circle-dot')
    expect(running).toContain('，进行中')
    expect(running).not.toMatch(/ui-spinner/)
    const settled = renderToStaticMarkup(createElement(PlanList, { plan, active: false }))
    expect(settled).toContain('class="plan-list is-settled"')
    expect(settled).not.toMatch(/ui-spinner/)
    expect(settled).toContain('，未完成')
  })
})

describe('write diff presentation', () => {
  it('keeps changes readable without exposing digest metadata or a redundant new-file badge', async () => {
    const text = 'export const answer = 42\n'
    const expected = hashDisplay(sha256Hex(text))
    expect(await contentHash(text)).toBe(expected)
    for (const html of [
      renderToStaticMarkup(createElement(DiffView, { diffs: [{ path: 'src/a.ts', newText: text, previous: 'none' }] })),
      renderToStaticMarkup(
        createElement(ToolCard, {
          message: tool(),
          onDecide: noop,
          approval: approval({
            risk: 'R2',
            arguments: JSON.stringify({ path: 'src/a.ts', content: text }),
            tool: { diffs: [{ path: 'src/a.ts', newText: text, previous: 'none' }] },
          }),
        }),
      ),
    ]) {
      expect(html).toContain('a.ts')
      expect(html).toContain('export const answer = 42')
      expect(html).not.toContain('新内容哈希')
      expect(html).not.toContain(expected)
      expect(html).not.toContain('>新文件<')
    }
  })
})

describe('names and text in security UI', () => {
  const visible = (text: string) => renderToStaticMarkup(createElement(VisibleText, { text }))

  it('keeps emoji joiners inside an emoji and still marks every other hidden character', () => {
    for (const name of ['❤️ iPhone', '👨‍💻 Mac', '1️⃣ 号机']) {
      expect(hasHiddenCharacters(name)).toBe(false)
      expect(visible(name)).toBe(name)
      expect(escapeHiddenCharacters(name)).toBe(name)
    }
    // A joiner or selector outside an emoji sequence is still shown.
    expect(visible('a\u200Db')).toBe('a<span class="hidden-char" title="不可见或改变显示方向的字符 U+200D">\\u{200D}</span>b')
    expect(escapeHiddenCharacters('x\uFE0F')).toBe('x\\u{FE0F}')
    expect(hasHiddenCharacters('👨\u200D')).toBe(true)
    // Tab, LF and CRLF stay as layout; a lone CR does not.
    expect(visible('a\tb\r\nc\nd')).toBe('a\tb\r\nc\nd')
    expect(escapeHiddenCharacters('a\rb\r\n')).toBe('a\\u{000D}b\r\n')
    // Combining marks beyond four in a row.
    expect(escapeHiddenCharacters('e\u0301\u0301\u0301\u0301\u0301')).toBe('e\u0301\u0301\u0301\u0301\\u{0301}')
    // A literal backslash-u written in the text is not mistaken for a mark.
    expect(visible('\\u{202E}\u202E')).toBe('\\u{202E}<span class="hidden-char" title="不可见或改变显示方向的字符 U+202E">\\u{202E}</span>')
  })

  it('shows device names escaped where a device is revoked', () => {
    expect(revokeText('Mac\u202Ekoob')).toBe('撤销「Mac\\u{202E}koob」？由它邀请配对的设备会降为仅查看，等待复核。')
    expect(revokeText('👨‍💻 Mac')).toBe('撤销「👨‍💻 Mac」？由它邀请配对的设备会降为仅查看，等待复核。')
    expect(revokeText('')).toContain('「未命名设备」')
  })
})

describe('units', () => {
  it('leaves no bare number in a footer, the live line or a row of the session information', () => {
    const usage = { inputTokens: 12_431, outputTokens: 3100 }
    const settled: TaskDetail = {
      summary: session({ status: 'cancelled' }),
      messages: [
        { id: 'u1', role: 'user', text: '一', createdAt: localIso(1), turn: { endedAt: localIso(2), activeMs: 72_000, waitMs: 20_000 } },
        { id: 'a1', role: 'assistant', text: '好', usage, completedAt: localIso(2) },
        { id: 'u2', role: 'user', text: '二', createdAt: localIso(3) },
        { id: 'a2', role: 'assistant', text: '部分', state: 'cancelled' },
      ],
      approvals: [],
      liveText: '',
      cursor: 1,
      usageReport: { contextUsed: 74_210, contextSize: 200_000, cost: { amount: 0.04, currency: 'USD' }, at: localIso(3) },
    }
    const running: TaskDetail = {
      summary: session({ status: 'running' }),
      messages: [
        { id: 'u', role: 'user', text: '一', createdAt: localIso(4) },
        { id: 'a', role: 'assistant', text: '一', usage },
      ],
      approvals: [],
      liveText: '二',
      liveMessageId: 'live',
      cursor: 1,
      runStartedAt: localIso(4),
      lastOutputAt: localIso(4),
    }
    const footers = [...textsOf(transcriptOf(settled, false), 'turn-facts'), ...textsOf(transcriptOf(running, true), 'turn-facts')]
    expect(footers.join(' | ')).toMatch(/输入 12\.4k tokens.*输出 3\.1k tokens.*上下文 74\.2k tokens.*输出 3\.1k tokens/u)
    const inspector = renderToStaticMarkup(
      createElement(Inspector, {
        snapshot: appSnapshot(),
        summary: session({ createdAt: localIso(1), usage, cwd: '/work/app' }),
        detail: settled,
        local: false,
        collapsed: new Set<string>(),
        onToggleBlock: noop,
        onReveal: noop,
      }),
    )
    const rows = textsOf(inspector, 'info-value')
    expect(rows.join(' | ')).toMatch(/12\.4k tokens.*3\.1k tokens.*74\.2k \/ 200k tokens/u)
    for (const text of [...footers, ...rows]) expect({ text, bare: bareNumbers(text) }).toEqual({ text, bare: [] })
    // The check itself finds a count without its unit.
    expect(bareNumbers('输入 12.4k · 输出 3.1k tokens · 用时 72')).toEqual(['12', '4', '72'])
  })
})
