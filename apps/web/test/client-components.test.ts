import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Approval, AppSnapshot, HostCatalog, Message, TaskDetail, TaskSummary } from '@latch/protocol'
import { sha256Hex } from '@latch/core/node-kit'
import { hashDisplay } from '@latch/host/crypto'
import { newSessionGroups, SessionControls } from '../src/components/ComposerControls.tsx'
import { RunSettingsGroups, workspaceSections } from '../src/components/Pickers.tsx'
import { Composer } from '../src/components/Composer.tsx'
import { fileChanges, Inspector } from '../src/components/Inspector.tsx'
import { ContextRow } from '../src/components/NewSession.tsx'
import { MessageRow } from '../src/components/MessageRow.tsx'
import { scrollMovesAnchor } from '../src/components/overlays.tsx'
import { PlanList } from '../src/components/PlanCard.tsx'
import { DiffView, PREVIOUS_UNAVAILABLE_TEXT, PREVIOUS_UNKNOWN_TEXT } from '../src/components/DiffView.tsx'
import { ApprovalStatuses, type ApprovalStatus } from '../src/components/ApprovalCard.tsx'
import { ToolCard } from '../src/components/ToolCard.tsx'
import { TopBar } from '../src/components/TopBar.tsx'
import { Transcript } from '../src/components/Transcript.tsx'
import { renderedMessages } from '../src/conversation.ts'
import { escapeHiddenCharacters, hasHiddenCharacters, VisibleText } from '../src/components/VisibleText.tsx'
import { contentHash } from '../src/core/contentHash.ts'
import type { ApprovalGate, DeviceAccess } from '../src/core/permissions.ts'
import {
  APPROVAL_COPY,
  CODE_ROOT_COPY,
  CONFIRMATION_COPY,
  CONFIRMATION_RESULT_TEXT,
  ENROLLMENT_COPY,
  NATIVE_LINK_COPY,
  PAIRING_COPY,
  PAIRING_WAITING_COPY,
} from '../src/core/securityCopy.ts'
import { ConfirmationContent, detailsOpenAtFirst } from '../src/components/InlineConfirm.tsx'
import type { ConfirmationActions, ConfirmationView } from '../src/core/confirmations.ts'
import { missingText } from '../src/settings/AgentsSettings.tsx'
import { revokeText } from '../src/settings/DevicesSettings.tsx'
import { PairingSection } from '../src/settings/PhonePairing.tsx'
import { ProjectCard, WorkspacesSettings } from '../src/settings/WorkspacesSettings.tsx'

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

/** An approval card as the page renders it, with what this device's last choice left on it. */
const approvalCard = (extra: Partial<Approval>, status?: ApprovalStatus, gate?: ApprovalGate) =>
  renderToStaticMarkup(
    createElement(
      ApprovalStatuses.Provider,
      { value: new Map(status ? [['ap1', status]] : []) },
      createElement(ToolCard, {
        message: tool(),
        approval: approval(extra),
        onDecide: noop,
        ...(gate ? { gateFor: () => gate } : {}),
      }),
    ),
  )
/** The words on a card's buttons, in order. */
const buttonLabels = (html: string) =>
  [...html.matchAll(/<button[^>]*class="ui-button"[^>]*>(?:<svg.*?<\/svg>)?([^<]+)<\/button>/g)].map(match => match[1])

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

describe('decided approvals', () => {
  const diffs = [{ path: 'notes/plan.md', newText: 'x', previous: 'none' as const }]
  const decided = (decision: NonNullable<Message['tool']>['decision'], state: Message['state'] = 'failed', extra: Partial<Message> = {}) =>
    renderToStaticMarkup(
      createElement(ToolCard, {
        message: tool({
          state,
          text: '用户拒绝了本次工具调用，未执行该操作。',
          tool: {
            kind: 'edit',
            toolTitle: '写入文件',
            title: 'write_file',
            input: '{"path":"notes/plan.md","content":"x"}',
            diffs,
            output: '用户拒绝了本次工具调用，未执行该操作。',
            ...(decision ? { decision } : {}),
          },
          ...extra,
        }),
        onDecide: noop,
      }),
    )
  const at = new Date().toISOString()
  /** The words in the row's state slot. */
  const stateSlot = (html: string) =>
    /<span class="ui-status-words tool-card-state[^"]*">(.*?)<\/span><\/span>(?:<svg|<\/div>)/u.exec(html)?.[1] ?? ''

  it('folds a rejection into its row: 已拒绝 with the time in the state slot, never a failure, and no diff', () => {
    const html = decided({ outcome: 'rejected', at, via: 'other-device' })
    expect(html).toContain('写入文件')
    expect(html).toContain('notes/plan.md')
    expect(stateSlot(html)).toMatch(
      /^<span class="tool-decision-words" title="[^"]*在其他设备上决定" data-outcome="rejected">已拒绝 · \d{2}:\d{2}<\/span>$/u,
    )
    expect(html).toContain('state-rejected')
    expect(html).toContain('lucide-circle-slash')
    expect(html).not.toMatch(/state-failed|process-failed|失败|lucide-triangle-alert/u)
    // One place says it: no second record line under the row.
    expect(html).not.toContain('class="tool-decision"')
    expect(html.match(/已拒绝/gu)).toHaveLength(1)
    // Folded, not opened by itself like a failure with output, and the proposed diff is no evidence of a change.
    expect(html).not.toContain('data-open=""')
    expect(html).not.toContain('diff-view')
    expect(html).not.toMatch(/APPROVAL_REJECTED|。。/u)
  })

  it('keeps an allowance in the row’s tooltip, and says nobody’s answer without claiming the call did not run', () => {
    const allowed = decided({ outcome: 'allowed', at, via: 'this-mac' }, 'completed', { startedAt: at, completedAt: at })
    expect(allowed).toMatch(/<button type="button" class="tool-card-header"[^>]*title="[^"]*已允许 · [^"]*在运行 Latch 的电脑上决定"/u)
    expect(allowed).not.toContain('tool-decision')
    expect(stateSlot(allowed)).toBe('')
    expect(allowed).toContain('diff-view')
    const cancelled = decided({ outcome: 'cancelled', at }, 'cancelled')
    expect(stateSlot(cancelled)).toMatch(/title="[^"]*会话停止时还没有人回答" data-outcome="cancelled">已取消（会话停止）<\/span>$/u)
    const expired = decided({ outcome: 'expired', at }, 'cancelled')
    expect(stateSlot(expired)).toMatch(/data-outcome="expired">已过期<\/span>$/u)
    for (const html of [cancelled, expired]) expect(html).not.toMatch(/已拒绝|决定"|失败|没有执行/u)
  })

  it('keeps the state and the diff an agent reports for a call that ran after a rejection, with one line that says so', () => {
    const html = decided({ outcome: 'rejected', at, via: 'other-device' }, 'completed', {
      text: '',
      toolName: 'edit',
      tool: { kind: 'edit', title: 'Edit src/app.ts', diffs, decision: { outcome: 'rejected', at, via: 'other-device' } },
    })
    expect(html).not.toContain('state-rejected')
    expect(stateSlot(html)).toBe('')
    expect(html).toContain('diff-view')
    expect(html).toMatch(
      /<p class="tool-decision" title="[^"]*在其他设备上决定\nAgent 的询问只是提示[^"]*" data-outcome="rejected">.*已拒绝 · \d{2}:\d{2} · Agent 报告仍执行了这次调用<\/p>/u,
    )
  })

  it('shows no record while the approval waits, and a failed call that was allowed still reads as a failure', () => {
    expect(approvalCard({ risk: 'R1' })).not.toContain('tool-decision')
    const failed = decided({ outcome: 'allowed', at }, 'failed', { startedAt: at })
    expect(stateSlot(failed)).toBe('失败')
    expect(failed).toContain('已允许 · ')
  })

  it('reads a rejection from before decision records as 已拒绝 without its internal code or a duration', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCard, {
        message: tool({
          state: 'failed',
          createdAt: at,
          completedAt: new Date(Date.parse(at) + 300_000).toISOString(),
          text: 'APPROVAL_REJECTED: 用户拒绝了本次工具调用，未执行该操作。',
          tool: { title: 'write_file', output: 'APPROVAL_REJECTED: 用户拒绝了本次工具调用，未执行该操作。' },
        }),
        onDecide: noop,
      }),
    )
    expect(stateSlot(html)).toBe('已拒绝')
    expect(html).not.toMatch(/失败|data-open=""|APPROVAL_REJECTED|process-time/u)
  })

  it('names a titled tool’s row by its title alone, with its ID in the tooltip, and keeps the ID on its approval card', () => {
    const row = decided({ outcome: 'allowed', at }, 'completed', { startedAt: at })
    expect(row).not.toContain('tool-card-name')
    expect(row).toMatch(/title="写入文件 notes\/plan.md\nwrite_file\n已允许 · /u)
    const card = renderToStaticMarkup(
      createElement(ToolCard, {
        message: tool({ tool: { kind: 'edit', toolTitle: '写入文件', title: 'write_file', input: '{"path":"notes/plan.md"}' } }),
        approval: approval(),
        onDecide: noop,
      }),
    )
    expect(card).toContain('<code class="tool-card-name">write_file</code>')
  })
})

describe('session changes', () => {
  it('lists a diff under 变更 only once it was applied: not while it waits, nor when its approval kept the call from running', () => {
    const diff = (path: string) => [{ path, newText: 'a\n', previous: 'none' as const }]
    const at = new Date().toISOString()
    const rows: Message[] = [
      tool({ id: 'tool:1', state: 'awaiting-approval', tool: { kind: 'edit', diffs: diff('docs/waiting.md') } }),
      tool({ id: 'tool:2', state: 'queued', tool: { kind: 'edit', diffs: diff('docs/queued.md') } }),
      tool({
        id: 'tool:3',
        state: 'failed',
        tool: { kind: 'edit', diffs: diff('docs/rejected.md'), decision: { outcome: 'rejected', at } },
      }),
      tool({ id: 'tool:4', state: 'completed', tool: { kind: 'edit', diffs: diff('docs/written.md') } }),
      // An agent that ran the call after the rejection: its reported change counts.
      tool({ id: 'tool:5', state: 'completed', tool: { kind: 'edit', diffs: diff('src/app.ts'), decision: { outcome: 'rejected', at } } }),
    ]
    expect(fileChanges(rows).map(change => change.path)).toEqual(['docs/written.md', 'src/app.ts'])
  })
})

describe('phone pairing', () => {
  const access = (local: boolean, admin = true): DeviceAccess => ({
    legacy: false,
    local,
    scopes: new Set(admin ? ['view', 'admin'] : ['view']),
    admin,
    device: null,
  })
  const FLAG = /(?:^|[\s「（(])--[a-z]/u

  it('names where to make the code, in words, on a device that cannot, and never a flag in any body text', () => {
    const html = renderToStaticMarkup(createElement(PairingSection, { access: access(false) }))
    // Read on the computer running Latch (in its browser) as well as on a phone.
    expect(html).toContain('配对二维码要在 Latch 桌面端生成：在运行 Latch 的电脑上打开桌面端的 设置 › 设备。')
    // A laptop has no camera flow: it uses the copied link.
    expect(ENROLLMENT_COPY.invitationRequired).toContain('其他电脑打开用「复制链接」得到的配对链接')
    expect(html).not.toContain('pnpm latch')
    const body = [
      NATIVE_LINK_COPY.intro,
      ...NATIVE_LINK_COPY.steps,
      PAIRING_COPY.computerRow,
      PAIRING_COPY.needsDesktop,
      PAIRING_COPY.needsAdmin,
      ENROLLMENT_COPY.invitationRequired,
    ]
    for (const text of body) {
      expect(text).not.toMatch(FLAG)
      expect(text).not.toContain('pnpm ')
    }
  })

  it('tells nothing of codes, countdowns, addresses or fingerprints in the pairing words', () => {
    const words = JSON.stringify([
      NATIVE_LINK_COPY.title,
      NATIVE_LINK_COPY.intro,
      NATIVE_LINK_COPY.steps,
      NATIVE_LINK_COPY.contended,
      NATIVE_LINK_COPY.offNetwork,
      PAIRING_WAITING_COPY.nativeConfirm,
    ])
    for (const word of ['六位', '核对码', '指纹', '剩余', '直连', '中继', '局域网']) expect(words).not.toContain(word)
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

describe('approval cards', () => {
  it('shows each argument once: no repeated reason, and file content only as the diff', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCard, {
        message: tool({ tool: { kind: 'edit', title: 'Run ls' } }),
        onDecide: noop,
        approval: approval({
          reason: 'Run ls',
          arguments: JSON.stringify({ path: 'a.ts', content: 'SECRET_BODY\n' }),
          tool: { title: 'Run ls', diffs: [{ path: 'a.ts', newText: 'SECRET_BODY\n' }] },
        }),
      }),
    )
    expect(html.match(/Run ls/g)).toHaveLength(1)
    // The diff names the file and shows its content, so neither is repeated as an argument.
    expect(html).not.toContain('<dt>path</dt>')
    expect(html).not.toContain('<dt>content</dt>')
    expect(html).not.toContain('内容见变更')
    expect(html.match(/SECRET_BODY/g)).toHaveLength(1)
    // With the approval open there is nothing else to expand.
    expect(html).toContain('<div class="tool-card-header">')
  })

  it('marks bidirectional and invisible characters so the reviewed text is the written text', () => {
    const content = 'if (accessLevel != "user\u202E \u2066// Check if admin\u2069 \u2066") { grant() }\n'
    const html = renderToStaticMarkup(
      createElement(ToolCard, {
        message: tool({ tool: { kind: 'edit', title: '写入 a\u200B.ts' } }),
        onDecide: noop,
        approval: approval({
          reason: '可能修改\u202Dworkspace',
          arguments: JSON.stringify({ path: 'a\u200B.ts', mode: 'x\u2067y', content }),
          options: [
            { id: 'allow_once', label: '允许一次', kind: 'allow_once' },
            { id: 'reject_once', label: '拒绝', kind: 'reject_once' },
          ],
          tool: { title: '写入 a\u200B.ts', diffs: [{ path: 'a\u200B.ts', oldText: '', newText: content }] },
        }),
      }),
    )
    expect(html).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B]/)
    for (const code of ['202E', '2066', '2069', '200B', '202D', '2067']) expect(html).toContain(`\\u{${code}}</span>`)
    expect(html).toContain(APPROVAL_COPY.hiddenCharacters)
    expect(html).toContain('title="a\\u{200B}.ts"')
    // No allow option looks like the default choice.
    expect(html).not.toContain('data-variant="primary"')
  })

  const ALWAYS = [
    { id: 'reject_once', label: '拒绝', kind: 'reject_once' },
    { id: 'allow_once', label: '允许一次', kind: 'allow_once' },
    { id: 'allow_always', label: '本会话始终允许', kind: 'allow_always' },
  ] as const
  it('keeps 本会话始终允许 out of reach when the content hides characters', () => {
    const html = approvalCard({ risk: 'R1', reason: '写入 a\u200B.ts', options: [...ALWAYS] })
    expect(html).toContain(APPROVAL_COPY.hiddenCharacters)
    expect(html).not.toContain(`aria-label="${APPROVAL_COPY.more}"`)
    expect(buttonLabels(html)).toEqual(['拒绝', '允许一次'])
    expect(html).not.toContain('data-variant="primary"')
    // A clean request still offers it.
    expect(approvalCard({ risk: 'R1', options: [...ALWAYS] })).toContain(`aria-label="${APPROVAL_COPY.more}"`)
  })

  it('names the choice whose outcome is unknown and leaves 重试 as the one clear action', () => {
    const html = approvalCard({ risk: 'R1', options: [...ALWAYS] }, { uncertain: { decision: 'reject', optionId: 'reject_once' } })
    expect(html).toContain(APPROVAL_COPY.uncertainTitle('拒绝'))
    expect(html).toContain('「拒绝」的结果未知')
    expect(buttonLabels(html)).toEqual(['重试', '拒绝', '允许一次'])
    expect(html).not.toContain('data-variant="primary"')
    expect(html).not.toContain(`aria-label="${APPROVAL_COPY.more}"`)
  })

  it("shows an agent's options in the product's words", () => {
    const html = approvalCard({ advisory: true, options: [{ id: 'r', label: 'Reject', kind: 'reject_once' }] }, undefined, {
      kind: 'advisory',
      badge: { label: APPROVAL_COPY.advisory, tone: 'warn' },
      note: APPROVAL_COPY.advisoryNote,
      explicit: true,
      options: [
        { id: 'r', label: 'Reject', kind: 'reject_once' },
        { id: 'a', label: 'Allow', kind: 'allow_once' },
      ],
    })
    expect(buttonLabels(html)).toEqual(['拒绝', '允许一次'])
    // The agent's own words are only in the tooltip.
    expect(html).toContain('class="ui-tooltip"><span>Reject</span>')
    expect(html).not.toContain('>Reject</button>')
  })

  it('keeps a high-risk allow in its words while it waits, and leaves a failed confirmation in the card', () => {
    const gate: ApprovalGate = {
      kind: 'R2',
      badge: { label: APPROVAL_COPY.highRisk, tone: 'err' },
      explicit: false,
      options: [
        { id: 'reject_once', label: '拒绝', kind: 'reject_once' },
        { id: 'allow_once', label: APPROVAL_COPY.allowLocal, kind: 'allow_once' },
      ],
      confirms: true,
    }
    const resting = approvalCard({ risk: 'R2' }, undefined, gate)
    expect(resting).toContain(APPROVAL_COPY.localNote)
    // An older Host's ticket has no sentence: the card still says it waits for Touch ID.
    const older = approvalCard({ risk: 'R2' }, { confirming: 'waiting' }, gate)
    expect(older).toContain(CONFIRMATION_COPY.waitingShell)
    expect(older).not.toContain(APPROVAL_COPY.localNote)
    expect(buttonLabels(older)).toEqual(['拒绝', APPROVAL_COPY.allowLocal])
    // With the ticket: the sentence the system sheet shows, 取消 and the Host's details, in the card itself.
    const waiting = approvalCard(
      { risk: 'R2' },
      {
        confirming: 'waiting',
        cancel: () => {},
        ticket: {
          id: 'cfm_1',
          action: 'approval.r2',
          title: '允许一次高风险操作',
          status: 'pending',
          hashDisplay: 'a1b2-c3d4-e5f6-0718',
          expiresAt: new Date().toISOString(),
          reason: '批准写入 slides.html（Latch 程序目录内）',
          form: 'approval.write',
          lines: [{ label: '工作目录', value: '/Users/u/latch' }],
          warnings: [],
        },
      },
      gate,
    )
    // Rendered here without the desktop shell, the sentence is introduced as one to read on the computer running Latch.
    expect(waiting).toContain(CONFIRMATION_COPY.browser)
    expect(waiting).toContain('批准写入 slides.html（Latch 程序目录内）')
    expect(waiting).toContain(CONFIRMATION_COPY.details)
    expect(waiting).toContain('/Users/u/latch')
    expect(waiting).toMatch(/class="ui-button approval-confirm-cancel"[^>]*>取消<\/button>/u)
    expect(buttonLabels(waiting)).toEqual(['拒绝', APPROVAL_COPY.allowLocal])
    const failed = approvalCard({ risk: 'R2' }, { failure: { text: CONFIRMATION_RESULT_TEXT.denied, tone: 'error' } }, gate)
    expect(failed).toMatch(/class="ui-notice approval-failure" data-tone="error"/)
    expect(failed).toContain(CONFIRMATION_RESULT_TEXT.denied)
    expect(buttonLabels(failed)).toEqual(['拒绝', APPROVAL_COPY.allowLocal])
  })

  it('shows a confirmation in place: the sheet sentence, the warnings in view and the details, never a check code', () => {
    const actions: ConfirmationActions = { cancel: () => {}, dismiss: () => {} }
    const render = (view: ConfirmationView) => renderToStaticMarkup(createElement(ConfirmationContent, { view, actions }))
    const ticket = {
      id: 'cfm_1',
      action: 'task.start-l3' as const,
      title: '开启完全访问会话',
      status: 'pending' as const,
      hashDisplay: 'a1b2-c3d4-e5f6-0718',
      expiresAt: new Date().toISOString(),
      reason: '允许 Codex 读写这台 Mac 上的文件并运行命令（项目「Acme」）：~/proj/node_modules/.bin/codex-acp',
      form: 'start.first' as const,
      lines: [
        { label: '命令', value: '/Users/u/proj/node_modules/.bin/codex-acp' },
        { label: '工作目录', value: '/Users/u/proj' },
        { label: '说明', value: '项目配置可以覆盖询问设置' },
      ],
      warnings: ['该会话可以读写 Latch 数据和 Host 身份私钥。', 'Harness 自己发起的询问只是提示，不是安全边界。'],
    }
    const waiting = render({ phase: 'waiting', ticket })
    expect(waiting).toContain(CONFIRMATION_COPY.waiting)
    expect(waiting).toContain(ticket.reason)
    for (const warning of ticket.warnings) expect(waiting).toContain(warning)
    // A first start opens its details at once: the full command, the folder and the notes.
    expect(detailsOpenAtFirst(ticket)).toBe(true)
    expect(waiting).toMatch(/aria-expanded="true"[^>]*>[\s\S]*确认详情/u)
    for (const line of ticket.lines) expect(waiting).toContain(line.value)
    expect(waiting).not.toContain('核对码')
    expect(waiting).not.toContain(ticket.hashDisplay)
    // Another confirmation keeps them folded, and a sentence cut short opens them again.
    expect(detailsOpenAtFirst({ form: 'mode.widen', reason: '允许「修复登录」改用「完全访问」' })).toBe(false)
    expect(detailsOpenAtFirst({ form: 'approval.tool', reason: '批准运行工具 a（未登记的工具）：{…；完整参数见 Latch 里的确认详情' })).toBe(
      true,
    )
    const sending = render({ phase: 'sending', ticket })
    expect(sending).toContain(`${CONFIRMATION_COPY.confirmed}开启会话…`)
    const failed = render({ phase: 'failed', ticket, message: CONFIRMATION_RESULT_TEXT.denied, reason: 'denied' })
    expect(failed).toContain(CONFIRMATION_RESULT_TEXT.denied)
    expect(failed).not.toContain(ticket.reason)
  })

  it('names the session a refused confirmation waits for, in one line', () => {
    const actions: ConfirmationActions = { cancel: () => {}, dismiss: () => {} }
    const render = (view: ConfirmationView) => renderToStaticMarkup(createElement(ConfirmationContent, { view, actions }))
    const named = render({
      phase: 'paused',
      reason: 'blocked',
      message: 'x',
      blocked: { action: 'device.enroll', tasks: [{ id: 'acp-1', title: '修复设置页密钥丢失', harnessId: 'codex' }] },
    })
    expect(named).toContain('要等「修复设置页密钥丢失」结束，才能配对新设备。')
    const several = render({
      phase: 'paused',
      reason: 'blocked',
      message: 'x',
      blocked: {
        action: 'policy.change',
        tasks: [
          { id: 'a', title: '\u202E改名', harnessId: 'codex' },
          { id: 'b', title: '', harnessId: 'codex' },
        ],
      },
    })
    expect(several).toContain('等 2 个会话结束，才能放宽安全策略。')
    // A title that hides characters shows them as markers.
    expect(several).toContain('\\u{202E}')
    const unnamed = render({ phase: 'paused', reason: 'blocked', message: 'x', blocked: { tasks: [] } })
    expect(unnamed).toContain(CONFIRMATION_COPY.blocked)
  })

  it('keeps the preview short: a long diff shows its first rows and a fold bar for the rest', () => {
    const newText = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'
    const html = approvalCard({
      risk: 'R1',
      arguments: JSON.stringify({ path: 'docs/notes.md', content: newText }),
      tool: { diffs: [{ path: 'docs/notes.md', oldText: '', newText }] },
    })
    expect(html).toContain('展开其余 12 行')
    expect(html).toContain('line 6')
    expect(html).not.toContain('line 7<')
    // The rows that fit open by default on wider screens (this render has no viewport, so it is the desktop).
    expect(html).toMatch(/class="approval-preview" id="[^"]+" data-open=""/)
  })

  it('carries the waiting in the header as one amber status word after its shield', () => {
    const html = renderToStaticMarkup(createElement(ToolCard, { message: tool(), approval: approval({ risk: 'R1' }), onDecide: noop }))
    expect(html).toMatch(
      /<span class="ui-status-word tool-card-waiting" data-tone="waiting"><svg[^>]*lucide-shield[^>]*>.*?<\/svg>待批准<\/span>/u,
    )
  })

  it('keeps blue off a high-risk card: allowing is a secondary button led by a lock', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCard, {
        message: tool(),
        approval: approval({ risk: 'R2' }),
        onDecide: noop,
        gateFor: (): ApprovalGate => ({
          kind: 'R2',
          badge: { label: '高风险', tone: 'err' },
          explicit: false,
          options: [
            { id: 'reject_once', label: '拒绝', kind: 'reject_once' },
            { id: 'allow_once', label: '用 Touch ID 允许', kind: 'allow_once' },
          ],
          confirms: true,
        }),
      }),
    )
    expect(html).toContain('class="tool-card tool-awaiting-approval has-approval is-r2"')
    expect(html).not.toContain('data-variant="primary"')
    expect(html).toMatch(/<button type="button" class="ui-button" data-variant="secondary" data-size="sm">拒绝<\/button>/)
    expect(html).toMatch(
      /<button type="button" class="ui-button" data-variant="secondary" data-size="sm" data-leading="">(?:(?!<\/button>).)*?<svg[^>]*lucide-lock-keyhole[^>]*>.*?<\/svg>用 Touch ID 允许<\/button>/,
    )
  })

  it('never labels a write without previous text as a new file', () => {
    const html = renderToStaticMarkup(
      createElement(ToolCard, {
        message: tool(),
        onDecide: noop,
        approval: approval({
          arguments: JSON.stringify({ path: 'data.sqlite', content: 'x' }),
          tool: { diffs: [{ path: 'data.sqlite', newText: 'x' }] },
        }),
      }),
    )
    expect(html).not.toContain('>新文件<')
    expect(html).toContain(`<span class="ui-status-word" data-tone="warn" title="${PREVIOUS_UNKNOWN_TEXT}">原内容未知</span>`)
    expect(html).toContain(`<p class="approval-warning" role="note">${PREVIOUS_UNKNOWN_TEXT}</p>`)
    expect(html).toContain('@@ +1,1 @@')
    expect(html).not.toContain('−0')
    expect(html).not.toContain('-0,0')
  })

  it('labels a diff by what the producer reported about the previous file', () => {
    const render = (diff: { previous?: 'none' | 'text' | 'unavailable'; oldText?: string }) =>
      renderToStaticMarkup(createElement(DiffView, { diffs: [{ path: 'a.txt', newText: 'x\n', ...diff }] }))
    const created = render({ previous: 'none' })
    expect(created).not.toContain('>新文件<')
    expect(created).toContain('@@ -0,0 +1,1 @@')
    expect(created).not.toContain('data-tone="warn"')
    const hidden = render({ previous: 'unavailable' })
    expect(hidden).toContain(`<span class="ui-status-word" data-tone="warn" title="${PREVIOUS_UNAVAILABLE_TEXT}">原内容未显示</span>`)
    expect(hidden).toContain(`<p class="diff-note">${PREVIOUS_UNAVAILABLE_TEXT}</p>`)
    expect(hidden).toContain('@@ +1,1 @@')
    for (const html of [hidden, render({})]) expect(html).not.toContain('>新文件<')
    expect(render({})).toContain('>原内容未知</span>')
    const edited = render({ previous: 'text', oldText: 'y\n' })
    expect(edited).not.toMatch(/新文件|原内容/)
    expect(edited).toContain('−1')
    const card = renderToStaticMarkup(
      createElement(ToolCard, {
        message: tool(),
        onDecide: noop,
        approval: approval({
          tool: {
            diffs: [
              { path: 'big.bin', newText: 'x', previous: 'unavailable' },
              { path: 'new.txt', newText: 'y', previous: 'none' },
            ],
          },
        }),
      }),
    )
    expect(card).toContain(`<p class="approval-warning" role="note">${PREVIOUS_UNAVAILABLE_TEXT}</p>`)
    expect(card).not.toContain(PREVIOUS_UNKNOWN_TEXT)
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

const session = (extra: Partial<TaskSummary> = {}): TaskSummary => ({ id: 's', title: 't', status: 'idle', updatedAt: '', ...extra })
const hostCatalog = (extra: Partial<HostCatalog> = {}): HostCatalog => ({
  harnesses: [{ id: 'standard', name: 'Standard', source: 'builtin', status: 'ready', modes: ['chat', 'agent'], models: 'host' }],
  providers: [{ id: 'fake', name: 'Fake', kind: 'openai-compatible', models: ['fake-chat', 'fake-coder-32k'], defaultModel: 'fake-chat' }],
  workspaces: [{ id: 'default', name: 'app', path: '/work/app' }],
  defaults: { harnessId: 'standard', mode: 'agent', workspaceId: 'default', model: { providerId: 'fake', model: 'fake-chat' } },
  ...extra,
})
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

describe('inspector', () => {
  it('leads the project row with the directory name and keeps the whole path', () => {
    const html = renderToStaticMarkup(
      createElement(Inspector, {
        snapshot: appSnapshot({ catalog: hostCatalog() }),
        summary: session({ cwd: '/Users/me/code/latch', harnessId: 'standard' }),
        detail: null,
        local: false,
        collapsed: new Set<string>(),
        onToggleBlock: noop,
        onReveal: noop,
      }),
    )
    expect(html).toContain('<span class="info-path-name">latch</span>')
    // 「Latch 内置」 already says it is built in: no second 「内置」 under the name.
    expect(html).toContain('<span class="info-who-name">Latch 内置</span>')
    expect(html).not.toContain('info-who-source')
    // The whole path until the line is measured (then it is cut in the middle to fit, see middleFit).
    expect(html).toContain(
      '<span class="middle-text info-path-full" title="/Users/me/code/latch"><span aria-hidden="true">/Users/me/code/latch</span><span class="sr-only">/Users/me/code/latch</span></span>',
    )
  })
})

describe('a folder inside Latch’s program directory', () => {
  const start = { id: 'default', name: 'app', path: '/repo/latch/.runtime/workspace', codeRoot: true as const }
  const inspector = (onNewProject?: () => void) =>
    renderToStaticMarkup(
      createElement(Inspector, {
        snapshot: appSnapshot({ catalog: hostCatalog({ workspaces: [start] }) }),
        summary: session({ cwd: start.path }),
        detail: null,
        local: true,
        collapsed: new Set<string>(),
        onToggleBlock: noop,
        onReveal: noop,
        ...(onNewProject ? { onNewProject } : {}),
      }),
    )

  it('warns in 会话信息 › 环境 by the Host’s flag, with 新建项目… where this device can make one', () => {
    const html = inspector(noop)
    expect(html).toContain('class="ui-notice info-code-root" data-tone="warn"')
    expect(html).toContain(CODE_ROOT_COPY.notice)
    expect(html).toContain(CODE_ROOT_COPY.startDir)
    expect(html).toContain(`>${CODE_ROOT_COPY.newProject}</button>`)
    // Elsewhere only the reason; and nothing for a folder the Host does not flag.
    expect(inspector()).not.toContain(CODE_ROOT_COPY.newProject)
    const plain = renderToStaticMarkup(
      createElement(Inspector, {
        snapshot: appSnapshot({ catalog: hostCatalog({ workspaces: [{ ...start, codeRoot: undefined }] }) }),
        summary: session({ cwd: start.path }),
        detail: null,
        local: true,
        collapsed: new Set<string>(),
        onToggleBlock: noop,
        onReveal: noop,
      }),
    )
    expect(plain).not.toContain(CODE_ROOT_COPY.notice)
  })

  it('marks the folder in the new session’s project picker and in 设置 › 项目', () => {
    const sections = workspaceSections(
      hostCatalog({ workspaces: [start, { id: 'w2', name: 'site', path: '/work/site' }] }),
      'default',
      noop,
    )
    const items = sections.flatMap(section => section.items)
    const flagged = items.find(item => item.id === 'default')
    expect(renderToStaticMarkup(createElement('div', null, flagged?.tag))).toContain(`data-tone="warn">${CODE_ROOT_COPY.badge}</span>`)
    expect(items.find(item => item.id === 'w2')?.tag).toBeUndefined()
    const card = renderToStaticMarkup(
      createElement(ProjectCard, { workspace: { ...start, id: 'p1' }, owner: true, isDefault: false, folders: null, onRemove: noop }),
    )
    expect(card).toContain(CODE_ROOT_COPY.notice)
    // A saved project cannot be moved from here yet: no start-directory sentence and no action.
    expect(card).not.toContain(CODE_ROOT_COPY.startDir)
  })

  it('says the way out of the start directory once in 设置 › 项目', () => {
    const settings = (workspace: typeof start | Omit<typeof start, 'codeRoot'>) =>
      renderToStaticMarkup(
        createElement(WorkspacesSettings, {
          snapshot: appSnapshot({ catalog: hostCatalog({ workspaces: [workspace] }) }),
          access: { admin: true },
          onChanged: noop,
        }),
      )
    const flagged = settings(start)
    expect(flagged).toContain(CODE_ROOT_COPY.startDir)
    expect(flagged).toContain('Host 启动时使用的目录，不能移除。')
    expect(flagged).not.toContain('要在其他文件夹中工作，请新建项目。')
    const { codeRoot: _codeRoot, ...ordinary } = start
    const plain = settings(ordinary)
    expect(plain).not.toContain(CODE_ROOT_COPY.startDir)
    expect(plain).toContain('Host 启动时使用的目录，不能移除；要在其他文件夹中工作，请新建项目。')
  })
})

describe('session model switch', () => {
  const props = {
    catalog: hostCatalog(),
    summary: session({ harnessId: 'standard', providerId: 'fake', model: 'fake-chat' }),
    harness: hostCatalog().harnesses[0],
    current: { providerId: 'fake', model: 'fake-chat' },
    onModel: noop,
    config: [],
    configBusy: null,
    onConfig: noop,
    access: { legacy: false, local: false, admin: true },
  }
  it('marks a switch that the next message will carry', () => {
    const idle = renderToStaticMarkup(createElement(SessionControls, { ...props, model: props.current, phone: false }))
    expect(idle).not.toContain('is-pending')
    const desktop = renderToStaticMarkup(
      createElement(SessionControls, { ...props, model: { providerId: 'fake', model: 'fake-coder-32k' }, phone: false }),
    )
    expect(desktop).toContain('model-picker is-pending')
    expect(desktop).toContain('aria-label="模型：下一条：fake-coder-32k"')
    const phone = renderToStaticMarkup(
      createElement(SessionControls, { ...props, model: { providerId: 'fake', model: 'fake-coder-32k' }, phone: true }),
    )
    expect(phone).toMatch(/^<span class="chip chip-static is-pending" title="下一条消息使用：fake-coder-32k">.*下一条：fake-coder-32k/)
    expect(renderToStaticMarkup(createElement(SessionControls, { ...props, model: props.current, phone: true }))).toBe('')
  })
})

describe('phone run settings', () => {
  it('places each manage link inside the group it manages', () => {
    const groups = newSessionGroups(
      hostCatalog(),
      { mode: 'agent', harnessId: 'standard', workspaceId: 'default', model: { providerId: 'fake', model: 'fake-chat' } },
      noop,
      { providers: noop, workspaces: noop },
    )
    expect(groups.map(group => [group.id, group.links?.map(link => link.label)])).toEqual([
      ['model', ['管理模型服务…']],
      ['workspace', ['管理项目…']],
    ])
    const html = renderToStaticMarkup(createElement(RunSettingsGroups, { groups, close: noop }))
    expect(html.indexOf('管理模型服务…')).toBeLessThan(html.indexOf('<h3>项目</h3>'))
    expect(html.indexOf('管理项目…')).toBeGreaterThan(html.indexOf('<h3>项目</h3>'))
  })
})

describe('top bar', () => {
  const topBar = {
    summary: session(),
    cancelling: false,
    demo: false,
    phone: false,
    onNew: noop,
    inspectorOpen: false,
    onInspector: noop,
    sessionMenu: [],
    menu: [],
    connection: 'connected' as const,
    onRefresh: noop,
  }

  it('names an unhealthy connection in a status pill without a dot, on phones too', () => {
    for (const phone of [true, false]) {
      const html = renderToStaticMarkup(createElement(TopBar, { ...topBar, connection: 'offline' as const, phone }))
      expect(html).toMatch(/<button[^>]*class="connection-pill connection-offline"[^>]*>离线<span class="connection-pill-retry">· 重试<svg/)
      expect(html).not.toContain('<i aria-hidden="true"></i>')
    }
    expect(renderToStaticMarkup(createElement(TopBar, topBar))).not.toContain('connection-pill')
  })

  it('names full access and leaves the default level, asking before each step, to the session details', () => {
    const full = renderToStaticMarkup(createElement(TopBar, { ...topBar, level: 'L3' }))
    expect(full).toMatch(
      /<span class="ui-status-word level-pill" data-tone="warn" title="完全访问（L3）"><svg[^>]*lucide-shield-alert[^>]*>.*<\/svg>完全访问<\/span>/,
    )
    const asking = renderToStaticMarkup(createElement(TopBar, { ...topBar, level: 'L1' }))
    expect(asking).not.toContain('逐项询问')
    expect(asking).not.toContain('level-pill')
  })

  it('shows the state only when it is not the default, and where the session runs', () => {
    const pill = (status: TaskSummary['status'], cancelling = false) =>
      /class="ui-status-word" data-tone="(\w+)">(?:<svg.*?<\/svg>)?([^<]+)</u
        .exec(renderToStaticMarkup(createElement(TopBar, { ...topBar, summary: session({ status }), cancelling })))
        ?.slice(1)
    expect(pill('running')).toBeUndefined()
    expect(pill('idle')).toBeUndefined()
    expect(pill('waiting-approval')).toBeUndefined()
    expect(pill('failed')).toEqual(['failed', '失败'])
    expect(pill('cancelled')).toEqual(['neutral', '已取消'])
    expect(pill('interrupted')).toEqual(['neutral', '已中断'])
    expect(pill('running', true)).toEqual(['neutral', '正在取消'])
    const html = renderToStaticMarkup(
      createElement(TopBar, { ...topBar, harness: { id: 'codex', name: 'Codex', source: 'acp' as const }, project: 'latch-app' }),
    )
    expect(html).toContain('<span class="topbar-source-text">Codex · latch-app</span>')
    expect(html).toMatch(/<span class="topbar-source"[^>]*><span class="ui-tile"/)
  })

  it('heads a phone session page with the way back, the centred title over where it runs, and 会话信息', () => {
    const menu = [{ id: 'sync', items: [{ id: 'refresh', label: '同步最新状态', onSelect: noop }] }]
    const html = renderToStaticMarkup(
      createElement(TopBar, {
        ...topBar,
        phone: true,
        onBack: noop,
        menu,
        level: 'L3',
        summary: session({ status: 'failed' }),
        harness: { id: 'codex', name: 'Codex', source: 'acp' as const },
        project: 'latch-app',
      }),
    )
    expect(html).toMatch(/^<header class="topbar" data-phone=""><button[^>]*aria-label="返回会话列表"/)
    // The title opens the session's menu (a sheet on a phone), 同步最新状态 included.
    expect(html).toMatch(/<h1[^>]*><button[^>]*aria-haspopup="(?:menu|dialog)"[^>]*class="topbar-title-button">/)
    expect(html).toMatch(
      /<div class="topbar-subline"><span class="topbar-source-text">Codex · latch-app<\/span><span class="ui-status-word" data-tone="failed"><svg[^>]*lucide-circle-alert[^>]*>.*?<\/svg>失败<\/span><span class="ui-status-word level-pill"/u,
    )
    expect(html).toMatch(/<button[^>]*aria-label="会话信息"[^>]*>.*<\/header>$/)
    expect(html).not.toContain('新建会话')
    expect(html).not.toContain('aria-label="会话操作"')
  })

  it('keeps a phone page header for a session the Host has not listed yet, with no menu or 会话信息 until it does', () => {
    const menu = [{ id: 'sync', items: [{ id: 'refresh', label: '同步最新状态', onSelect: noop }] }]
    const html = renderToStaticMarkup(
      createElement(TopBar, {
        ...topBar,
        summary: undefined,
        phone: true,
        onBack: noop,
        menu,
        level: 'L3',
        harness: { id: 'codex', name: 'Codex', source: 'acp' as const },
        project: 'latch-app',
      }),
    )
    expect(html).toMatch(/^<header class="topbar" data-phone=""><button[^>]*aria-label="返回会话列表"/)
    expect(html).toContain('<h1 title="新会话"><span class="topbar-title-text">新会话</span></h1>')
    expect(html).not.toContain('topbar-subline')
    expect(html).not.toContain('会话信息')
  })

  it('makes the title a button that opens the session menu, and offers to open a shut sidebar', () => {
    const sessionMenu = [{ id: 'manage', items: [{ id: 'rename', label: '重命名', onSelect: noop }] }]
    const html = renderToStaticMarkup(createElement(TopBar, { ...topBar, sessionMenu, sidebarCollapsed: true, onExpandSidebar: noop }))
    expect(html).toMatch(/<h1[^>]*><button[^>]*aria-haspopup="menu"[^>]*class="topbar-title-button"><span class="topbar-title-text">/)
    expect(html).toContain('aria-label="展开侧栏"')
    expect(renderToStaticMarkup(createElement(TopBar, topBar))).not.toContain('展开侧栏')
  })
})

describe('popover anchoring', () => {
  const node = (children: unknown[] = []) => ({ contains: (other: unknown) => other === node || children.includes(other) })
  it('closes only for scrolls that move its trigger', () => {
    const trigger = node()
    const topBar = node([trigger])
    const transcript = node()
    const popover = node()
    expect(scrollMovesAnchor(topBar as unknown as EventTarget, trigger as unknown as Node)).toBe(true)
    expect(scrollMovesAnchor(transcript as unknown as EventTarget, trigger as unknown as Node)).toBe(false)
    expect(scrollMovesAnchor(popover as unknown as EventTarget, trigger as unknown as Node)).toBe(false)
    expect(scrollMovesAnchor(topBar as unknown as EventTarget, null)).toBe(false)
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

/** An adapter preset's detection: the adapter `found`, and the agent it connects to when `companion` is given. */
const adapter = (found: boolean, companion?: boolean) => ({
  command: 'pi-acp',
  detected: { found, ...(companion === undefined ? {} : { companion: { command: 'pi', found: companion } }) },
})

describe('agent settings', () => {
  it('names both programs when an adapter preset is missing one of them', () => {
    const agent = adapter
    expect(missingText(agent(true))).toBeUndefined()
    expect(missingText(agent(false))).toBe('未找到命令 pi-acp')
    expect(missingText(agent(true, true))).toBeUndefined()
    expect(missingText(agent(true, false))).toBe('已找到适配器 pi-acp，还没找到 pi')
    expect(missingText(agent(false, true))).toBe('已安装 pi，还差让 Latch 连接它的适配器 pi-acp')
    expect(missingText(agent(false, false))).toBe('未找到 pi 和它的适配器 pi-acp')
  })
})

describe('workspace settings', () => {
  it('lists a workspace the Host disabled with its reason and keeps the remove action', () => {
    const reason = '该目录位于受保护目录（如 .git）内，不能作为项目'
    const html = renderToStaticMarkup(
      createElement(ProjectCard, {
        workspace: { id: 'w1', name: 'hooks', path: '/w/.git/hooks', unavailable: reason },
        owner: true,
        isDefault: false,
        folders: null,
        onRemove: noop,
      }),
    )
    expect(html).toContain('class="settings-card project-card is-unavailable"')
    expect(html).toContain('<span class="ui-status-word" data-tone="warn">不可用</span>')
    expect(html).toContain(`<span class="workspace-unavailable">${reason}</span>`)
    // Removing is in the project's ⋯ menu; a browser copies the folder's path instead of showing it in Finder.
    expect(html).toContain('aria-label="hooks 的操作"')
    expect(html).toContain('aria-label="复制路径"')
    const usable = renderToStaticMarkup(
      createElement(ProjectCard, {
        workspace: { id: 'w2', name: 'app', path: '/w/app' },
        owner: false,
        isDefault: true,
        folders: null,
        onRemove: noop,
      }),
    )
    expect(usable).not.toMatch(/不可用|的操作/)
    expect(usable).toContain('默认')
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

describe('composer', () => {
  const base = {
    textareaRef: { current: null },
    variant: 'new' as const,
    label: '新会话消息',
    placeholder: '描述任务…',
    draft: '列出项目根目录',
    onDraft: noop,
    pending: null,
    sending: false,
    error: '',
    onRetry: noop,
    canSend: true,
    onSubmit: noop,
    sendKey: 'enter' as const,
    coarse: false,
    controls: null,
  }

  it('says in the send slot that starting takes the local confirmation, and keeps an empty send focusable with its reason', () => {
    const start = renderToStaticMarkup(createElement(Composer, { ...base, confirmStart: '开始会话' }))
    expect(start).toContain('开始会话')
    expect(start).toContain('start-button')
    expect(start).not.toContain('aria-label="发送"')
    const empty = renderToStaticMarkup(createElement(Composer, { ...base, draft: '' }))
    expect(empty).toContain('aria-label="发送"')
    expect(empty).toContain('aria-disabled="true"')
    expect(empty).not.toMatch(/<button[^>]*aria-label="发送"[^>]*disabled=""/u)
  })

  it('names what the oldest waiting request would do in the run bar, with hidden characters marked', () => {
    const html = renderToStaticMarkup(
      createElement(Composer, {
        ...base,
        variant: 'session',
        run: { approvals: 2, approvalTitle: '写入 notes\u200b.md', onRevealApprovals: noop, cancel: 'idle', onCancel: noop },
      }),
    )
    expect(html).toContain('2 项待批准')
    expect(html).toContain('\\u{200B}')
    expect(html).toContain('查看')
    // Stop takes the send slot and is never red.
    expect(html).toContain('aria-label="停止"')
  })

  it('keeps the bar quiet while a waiting card is in view, which says so itself', () => {
    const html = renderToStaticMarkup(
      createElement(Composer, {
        ...base,
        variant: 'session',
        run: {
          approvals: 1,
          approvalsInView: true,
          approvalTitle: '写入 notes.md',
          onRevealApprovals: noop,
          cancel: 'idle',
          onCancel: noop,
        },
      }),
    )
    expect(html).not.toContain('项待批准')
    expect(html).not.toContain('is-waiting')
  })

  it('says a stop whose outcome is unknown once, in the bar with 重试, and leaves the stop button a square', () => {
    const html = renderToStaticMarkup(
      createElement(Composer, {
        ...base,
        variant: 'session',
        run: { approvals: 0, onRevealApprovals: noop, cancel: 'uncertain', onCancel: noop },
      }),
    )
    expect(html.match(/尚未确认/gu)).toHaveLength(1)
    expect(html.match(/重试/gu)).toHaveLength(1)
    expect(html).toContain('stop-glyph')
    expect(html).not.toContain('取消')
  })

  it('shows a device that may only watch a dashed frame with the reason instead of the input', () => {
    const html = renderToStaticMarkup(
      createElement(Composer, { ...base, variant: 'session', readOnly: '此设备没有「发起和继续会话」权限' }),
    )
    expect(html).toContain('data-variant="read-only"')
    expect(html).toContain('此设备没有「发起和继续会话」权限')
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('aria-label="发送"')
  })
})

describe('context row', () => {
  it('names the computer and shows the level only when it is full access, leading to the ceilings', () => {
    const asking = renderToStaticMarkup(createElement(ContextRow, { hostName: 'MacBook Pro', fullAccess: false, onComputer: noop }))
    expect(asking).toContain('MacBook Pro')
    expect(asking).not.toContain('完全访问')
    const full = renderToStaticMarkup(createElement(ContextRow, { hostName: 'MacBook Pro', fullAccess: true, onComputer: noop }))
    expect(full).toContain('aria-label="权限：完全访问，查看电脑与权限上限"')
    expect(full).toContain('context-risk')
  })
})
