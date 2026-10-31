import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Approval, AppSnapshot, HostCatalog, Message, TaskSummary } from '@latch/protocol'
import { newSessionGroups, SessionControls } from '../src/components/ComposerControls.tsx'
import { RunSettingsGroups, workspaceSections } from '../src/components/Pickers.tsx'
import { Composer } from '../src/components/Composer.tsx'
import { Inspector } from '../src/components/Inspector.tsx'
import { ContextRow } from '../src/components/NewSession.tsx'
import { DiffView, PREVIOUS_UNAVAILABLE_TEXT, PREVIOUS_UNKNOWN_TEXT } from '../src/components/DiffView.tsx'
import { ApprovalStatuses, type ApprovalStatus } from '../src/components/ApprovalCard.tsx'
import { ToolCard } from '../src/components/ToolCard.tsx'
import type { ApprovalGate } from '../src/core/permissions.ts'
import { APPROVAL_COPY, CODE_ROOT_COPY, CONFIRMATION_COPY, CONFIRMATION_RESULT_TEXT } from '../src/core/securityCopy.ts'
import { ConfirmationContent } from '../src/components/InlineConfirm.tsx'
import type { ConfirmationActions, ConfirmationView } from '../src/core/confirmations.ts'
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
    expect(allowed).toMatch(/<button type="button" class="tool-card-header"[^>]*title="[^"]*已允许 · [^"]*在这台 Mac 上决定"/u)
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
    // The system sheet is the only window: nothing of its sentence, its details or a way to cancel appears in the card.
    const waiting = approvalCard({ risk: 'R2' }, { confirming: 'waiting' }, gate)
    expect(waiting).toContain(CONFIRMATION_COPY.waiting)
    expect(waiting).toMatch(/class="sr-only" role="status"/u)
    expect(waiting).not.toContain('确认详情')
    expect(buttonLabels(waiting)).toEqual(['拒绝', APPROVAL_COPY.allowLocal])
    const failed = approvalCard({ risk: 'R2' }, { failure: { text: CONFIRMATION_RESULT_TEXT.denied, tone: 'error' } }, gate)
    expect(failed).toMatch(/class="ui-notice approval-failure" data-tone="error"/)
    expect(failed).toContain(CONFIRMATION_RESULT_TEXT.denied)
    expect(buttonLabels(failed)).toEqual(['拒绝', APPROVAL_COPY.allowLocal])
  })

  it('shows no card of its own while the sheet is open: only the warnings the sheet leaves out, never its sentence or details', () => {
    const actions: ConfirmationActions = { cancel: () => {}, dismiss: () => {} }
    const render = (view: ConfirmationView) => renderToStaticMarkup(createElement(ConfirmationContent, { view, actions }))
    const ticket = {
      id: 'cfm_1',
      action: 'task.start-l3' as const,
      title: '开启完全访问会话',
      status: 'pending' as const,
      hashDisplay: 'a1b2-c3d4-e5f6-0718',
      expiresAt: new Date().toISOString(),
      reason: '允许「修复登录」改用「完全访问」',
      form: 'mode.widen' as const,
      lines: [{ label: '工作目录', value: '/Users/u/proj' }],
      warnings: ['这个地址不使用 HTTPS，发给它的内容会以明文经过网络。'],
    }
    const waiting = render({ phase: 'waiting', ticket })
    for (const warning of ticket.warnings) expect(waiting).toContain(warning)
    for (const hidden of [ticket.reason, ticket.title, ticket.lines[0]!.value, ticket.hashDisplay, '确认详情', '系统表单', '取消'])
      expect(waiting).not.toContain(hidden)
    expect(render({ phase: 'waiting', ticket: { ...ticket, warnings: [] } })).toBe('')
    expect(render({ phase: 'sending', ticket })).toBe('')
    const failed = render({ phase: 'failed', ticket, message: CONFIRMATION_RESULT_TEXT.denied, reason: 'denied' })
    expect(failed).toContain(CONFIRMATION_RESULT_TEXT.denied)
    expect(failed).not.toContain(ticket.reason)
    expect(failed).not.toContain(ticket.title)
  })

  it('shows what a system form leaves out for a start or a cut sentence, without hashes, and nothing beside a native sheet', () => {
    const actions: ConfirmationActions = { cancel: () => {}, dismiss: () => {} }
    const render = (view: ConfirmationView) => renderToStaticMarkup(createElement(ConfirmationContent, { view, actions }))
    const command = '/Users/u/a/very/long/path/that/did/not/fit/in/the/sentence/bin/codex-acp'
    const ticket = {
      id: 'cfm_2',
      action: 'task.start-l3' as const,
      title: '开启完全访问会话',
      status: 'pending' as const,
      hashDisplay: 'a1b2-c3d4-e5f6-0718',
      expiresAt: new Date().toISOString(),
      reason: '允许 Codex 读写这台 Mac 上的文件并运行命令：/opt/bin/codex-acp',
      form: 'start.first' as const,
      lines: [
        { label: '命令', value: command },
        { label: '工作目录', value: '/Users/u/proj' },
        { label: '说明', value: '项目配置可以覆盖询问设置' },
        { label: '启动指纹', value: 'f00d-f00d-f00d-f00d' },
      ],
    }
    // Every start: the system form names the program, not the folder or what the project can change.
    for (const form of ['start.first', 'start.first-mode', 'start.changed', 'start.changed-mode'] as const) {
      const waiting = render({ phase: 'waiting', ticket: { ...ticket, form } })
      expect(waiting).toContain('确认详情')
      for (const line of ticket.lines.slice(0, 3)) expect(waiting).toContain(line.value)
      expect(waiting).not.toContain('f00d-f00d-f00d-f00d')
      expect(waiting).not.toContain(ticket.reason)
    }
    // A slot the Host cut ends or begins with 「…」, the only mark a sentence carries.
    const cut = {
      ...ticket,
      action: 'provider.confirm-origin' as const,
      form: 'origin.confirm' as const,
      reason: '允许 Latch 连接 …a-very-long-subdomain-of-the-service.example.com',
      lines: [{ label: '地址', value: 'https://not-the-service.a-very-long-subdomain-of-the-service.example.com' }],
    }
    expect(render({ phase: 'waiting', ticket: cut })).toContain(cut.lines[0]!.value)
    expect(render({ phase: 'waiting', ticket: { ...cut, reason: '允许 Latch 连接 service.example.com' } })).toBe('')
    expect(render({ phase: 'waiting', ticket: { ...ticket, lines: [] } })).toBe('')
    expect(render({ phase: 'sending', ticket })).toBe('')
    // The native sheet lists the Host's lines itself.
    for (const sheet of [ticket, cut])
      expect(render({ phase: 'waiting', ticket: { ...sheet, confirmationMethod: 'shell-local' as const } })).toBe('')
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
    expect(named).toContain('正在运行「修复设置页密钥丢失」，结束后才能配对新设备。')
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
    expect(several).toContain('等 2 个会话，结束后才能放宽设置。')
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
      /<span class="ui-status-word tool-card-waiting" data-tone="waiting"><svg[^>]*lucide-shield[^>]*>.*?<\/svg>等你允许<\/span>/u,
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
            { id: 'allow_once', label: '在这台 Mac 上允许', kind: 'allow_once' },
          ],
          confirms: true,
        }),
      }),
    )
    expect(html).toContain('class="tool-card tool-awaiting-approval has-approval is-r2"')
    expect(html).not.toContain('data-variant="primary"')
    expect(html).toMatch(/<button type="button" class="ui-button" data-variant="secondary" data-size="sm">拒绝<\/button>/)
    expect(html).toMatch(
      /<button type="button" class="ui-button" data-variant="secondary" data-size="sm" data-leading="">(?:(?!<\/button>).)*?<svg[^>]*lucide-lock-keyhole[^>]*>.*?<\/svg>在这台 Mac 上允许<\/button>/,
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
    const html = renderToStaticMarkup(createElement(Composer, { ...base, variant: 'session', readOnly: '这台设备不能发送消息' }))
    expect(html).toContain('data-variant="read-only"')
    expect(html).toContain('这台设备不能发送消息')
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
