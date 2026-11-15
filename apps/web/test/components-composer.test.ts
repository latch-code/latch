import { createElement } from 'react'
import { testHarness } from '@latch/testkit'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Approval, AppSnapshot, HostCatalog, Message, TaskSummary } from '@latch/protocol'
import { workspaceSections } from '../src/components/Pickers.tsx'
import { Composer } from '../src/composer/Composer.tsx'
import { SessionFolders } from '../src/shell/SessionEnvironment.tsx'
import { DiffView, PREVIOUS_UNAVAILABLE_TEXT, PREVIOUS_UNKNOWN_TEXT } from '../src/components/DiffView.tsx'
import { allowsByKey, approvalKeyCaps, ApprovalDrawer, type ApprovalStatus } from '../src/composer/ApprovalDrawer.tsx'
import { ToolCard } from '../src/components/ToolCard.tsx'
import { approvalActions, type ApprovalGate } from '../src/core/permissions.ts'
import { APPROVAL_COPY, CODE_ROOT_COPY, CONFIRMATION_COPY, CONFIRMATION_RESULT_TEXT } from '../src/core/securityCopy.ts'
import { ConfirmationContent } from '../src/components/InlineConfirm.tsx'
import type { ConfirmationActions, ConfirmationView } from '../src/core/confirmations.ts'
import { ProjectRow, WorkspacesSettings } from '../src/settings/WorkspacesSettings.tsx'

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

/** The approval drawer of one request, as the composer draws it. */
const Drawer = ({
  message,
  approval,
  gateFor,
  busy,
  status,
}: {
  message: Message | null
  approval: Approval
  gateFor?: (approval: Approval) => ApprovalGate
  busy?: string
  status?: ApprovalStatus
  onDecide?: unknown
}) =>
  createElement(ApprovalDrawer, {
    approvals: [approval],
    messages: message ? [message] : [],
    index: 0,
    onIndex: () => {},
    gateFor: gateFor ?? (item => approvalActions(item, null)),
    busy: new Map(busy ? [[approval.id, busy]] : []),
    statuses: new Map(status ? [[approval.id, status]] : []),
    onDecide: () => {},
  })

/** An approval card as the page renders it, with what this device's last choice left on it. */
const approvalCard = (extra: Partial<Approval>, status?: ApprovalStatus, gate?: ApprovalGate) =>
  renderToStaticMarkup(
    createElement(Drawer, {
      message: tool(),
      approval: approval(extra),
      ...(status ? { status } : {}),
      ...(gate ? { gateFor: () => gate } : {}),
    }),
  )
/** Whether 更多 offers the broader choice; folding an open preview is in the same menu and widens nothing. */
const offersMore = (html: string) =>
  /<button[^>]*class="ui-button approval-more"[^>]*>更多<svg/u.test(html) && html.includes(`data-label="${APPROVAL_COPY.allowSession}"`)
/** The words on a card's buttons, in order. */
const buttonLabels = (html: string) =>
  [...html.matchAll(/<button[^>]*class="ui-button"[^>]*>(?:<svg.*?<\/svg>)?([^<]+)<\/button>/g)].map(match => match[1])

const session = (extra: Partial<TaskSummary> = {}): TaskSummary => ({
  harnessId: 'standard',
  id: 's',
  title: 't',
  status: 'idle',
  updatedAt: '',
  ...extra,
})
const hostCatalog = (extra: Partial<HostCatalog> = {}): HostCatalog => ({
  harnesses: [testHarness('standard', { kind: 'builtin', label: 'Standard' })],
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
      }),
    )
  const at = new Date().toISOString()
  /** The words in the row's state slot. */
  const stateSlot = (html: string) =>
    /tool-card-state[^"]*">(?:<span class="ui-[^>]*>)?(.*?)<\/span>(?:<\/span>)?(?:<span class="process-time"|<\/span><\/button>)/u.exec(
      html,
    )?.[1] ?? ''

  it('folds a rejection into its row: 已拒绝 with the time in the state slot, never a failure, and no diff', () => {
    const html = decided({ outcome: 'rejected', at, via: 'other-device' })
    expect(html).toContain('写入文件')
    expect(html).toContain('notes/plan.md')
    expect(stateSlot(html)).toMatch(
      /^<span class="tool-decision-words" title="[^"]*在其他设备上决定" data-outcome="rejected">已拒绝 · \d{2}:\d{2}$/u,
    )
    expect(html).toContain('state-rejected')
    expect(html).toContain('latch-glyph-blocked')
    expect(html).not.toMatch(/state-failed|process-failed|tool-failure|失败/u)
    // One place says it: no second record line under the row.
    expect(html).not.toContain(' tool-decision"')
    expect(html.match(/已拒绝/gu)).toHaveLength(1)
    // Folded, not opened by itself like a failure with output, and the proposed diff is no evidence of a change.
    expect(html).not.toContain('data-open=""')
    expect(html).not.toContain('diff-view')
    expect(html).not.toMatch(/APPROVAL_REJECTED|。。/u)
  })

  it('records an allowance on its row, and says nobody’s answer without claiming the call did not run', () => {
    const allowed = decided({ outcome: 'allowed', at, via: 'this-mac' }, 'completed', { startedAt: at, completedAt: at })
    expect(allowed).toMatch(/<button type="button" class="tool-card-header"[^>]*title="[^"]*已允许 · [^"]*在这台 Mac 上决定"/u)
    expect(allowed).not.toContain(' tool-decision"')
    // The row's end keeps only how long it ran: the allowance and its time are in the tooltip.
    expect(stateSlot(allowed)).toBe('')
    expect(allowed.match(/已允许/gu)).toHaveLength(1)
    const cancelled = decided({ outcome: 'cancelled', at }, 'cancelled')
    // The words say nobody answered; the tooltip adds only when.
    expect(stateSlot(cancelled)).toMatch(/data-outcome="cancelled">已取消（会话停止）$/u)
    expect(cancelled).not.toContain('还没有人回答')
    const expired = decided({ outcome: 'expired', at }, 'cancelled')
    expect(stateSlot(expired)).toMatch(/data-outcome="expired">已过期$/u)
    for (const html of [cancelled, expired]) expect(html).not.toMatch(/已拒绝|决定"|失败|没有执行/u)
  })

  it('keeps the state an agent reports for a call that ran after a rejection, with one line that says so', () => {
    const html = decided({ outcome: 'rejected', at, via: 'other-device' }, 'completed', {
      text: '',
      toolName: 'edit',
      tool: { kind: 'edit', title: 'Edit src/app.ts', diffs, decision: { outcome: 'rejected', at, via: 'other-device' } },
    })
    expect(html).not.toContain('state-rejected')
    expect(stateSlot(html)).toBe('')
    // A Hint: the record and that the Harness reports it ran in view, where it was decided on the glyph, why behind ⓘ.
    expect(html).toMatch(
      /<div class="ui-hint tool-decision">.*title="[^"]*在其他设备上决定".*<span class="ui-hint-label">已拒绝 · \d{2}:\d{2} · Harness 报告仍执行了<\/span><button[^>]*aria-label="说明"/u,
    )
  })

  it('shows no record while the approval waits, and a failed call that was allowed still reads as a failure', () => {
    expect(approvalCard({ risk: 'R1' })).not.toContain('tool-decision')
    const failed = decided({ outcome: 'allowed', at }, 'failed', { startedAt: at })
    expect(failed).toContain('tool-failure')
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
      }),
    )
    expect(stateSlot(html)).toBe('已拒绝')
    expect(html).not.toMatch(/tool-failure|data-open=""|APPROVAL_REJECTED|process-time/u)
  })

  it('names a titled tool’s row by its title alone, with its ID in the tooltip, and keeps the ID on its approval card', () => {
    const row = decided({ outcome: 'allowed', at }, 'completed', { startedAt: at })
    expect(row).not.toContain('tool-card-name')
    expect(row).toMatch(/title="写入文件 notes\/plan.md\nwrite_file\n已允许 · /u)
    const card = renderToStaticMarkup(
      createElement(Drawer, {
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
      createElement(Drawer, {
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
    expect(html).not.toContain('内容见改动')
    expect(html.match(/SECRET_BODY/g)).toHaveLength(1)
  })

  it('never lets a tool’s own title stand alone: its ID shows, and only a routine diff starts folded', () => {
    const asked = (extra: Partial<Approval>, gate?: ApprovalGate) =>
      renderToStaticMarkup(
        createElement(ApprovalDrawer, {
          approvals: [
            approval({
              toolName: 'shell',
              arguments: JSON.stringify({ command: 'rm -rf build' }),
              tool: { title: '读取配置', input: JSON.stringify({ command: 'rm -rf build' }) },
              ...extra,
            }),
          ],
          messages: [],
          index: 0,
          onIndex: noop,
          gateFor: gate ? () => gate : item => approvalActions(item, null),
          busy: new Map(),
          statuses: new Map(),
          onDecide: noop,
        }),
      )
    const open = /class="approval-preview"[^>]*data-open=""/u
    for (const html of [asked({ risk: 'R1' }), asked({ risk: 'R2' }), asked({ advisory: true })]) {
      expect(html).toContain('读取配置')
      expect(html).toContain('<code class="tool-card-name">shell</code>')
      expect(html).toMatch(open)
    }
    const routine = asked({
      risk: 'R1',
      toolName: 'write_file',
      tool: { title: '写入文件', diffs: [{ path: 'a.ts', newText: 'x\n' }] },
      arguments: JSON.stringify({ path: 'a.ts', content: 'x\n' }),
    })
    expect(routine).toContain('<code class="tool-card-name">write_file</code>')
    expect(routine).not.toMatch(open)
    const riskyDiff = asked({
      risk: 'R2',
      toolName: 'write_file',
      tool: { title: '写入文件', diffs: [{ path: 'a.ts', newText: 'x\n' }] },
      arguments: JSON.stringify({ path: 'a.ts', content: 'x\n' }),
    })
    expect(riskyDiff).toMatch(open)
  })

  it('marks bidirectional and invisible characters so the reviewed text is the written text', () => {
    const content = 'if (accessLevel != "user\u202E \u2066// Check if admin\u2069 \u2066") { grant() }\n'
    const html = renderToStaticMarkup(
      createElement(Drawer, {
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
    expect(offersMore(html)).toBe(false)
    expect(buttonLabels(html)).toEqual(['拒绝', '允许'])
    expect(html).not.toContain('data-variant="primary"')
    // A clean request still offers it.
    expect(offersMore(approvalCard({ risk: 'R1', options: [...ALWAYS] }))).toBe(true)
  })

  it('names the choice whose outcome is unknown and leaves 重试 as the one clear action', () => {
    const html = approvalCard({ risk: 'R1', options: [...ALWAYS] }, { uncertain: { decision: 'reject', optionId: 'reject_once' } })
    expect(html).toContain(APPROVAL_COPY.uncertainTitle('拒绝'))
    expect(html).toContain('「拒绝」的结果未知')
    expect(buttonLabels(html)).toEqual(['拒绝', '允许', '重试'])
    expect(html).not.toContain('data-variant="primary"')
    expect(offersMore(html)).toBe(false)
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
    expect(buttonLabels(html)).toEqual(['拒绝', '允许'])
    // The agent's own words are only in the tooltip.
    expect(html).toContain('class="ui-tooltip"><span>Reject</span>')
    expect(html).not.toContain('>Reject</button>')
  })

  it('shows no card of its own while the sheet is open: only the warnings the sheet leaves out, never its sentence or details', () => {
    const actions: ConfirmationActions = { cancel: () => {}, dismiss: () => {} }
    const render = (view: ConfirmationView) => renderToStaticMarkup(createElement(ConfirmationContent, { view, actions }))
    const ticket = {
      id: 'cfm_1',
      action: 'plugin.package.apply' as const,
      title: '应用自定义插件',
      status: 'pending' as const,
      hashDisplay: 'a1b2-c3d4-e5f6-0718',
      expiresAt: new Date().toISOString(),
      reason: '应用插件「发布检查」',
      form: 'plugin.package.apply' as const,
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

  it('shows what a system form leaves out for a cut sentence, without hashes', () => {
    const actions: ConfirmationActions = { cancel: () => {}, dismiss: () => {} }
    const render = (view: ConfirmationView) => renderToStaticMarkup(createElement(ConfirmationContent, { view, actions }))
    const ticket = {
      id: 'cfm_2',
      action: 'provider.confirm-origin' as const,
      title: '确认模型服务地址',
      status: 'pending' as const,
      hashDisplay: 'a1b2-c3d4-e5f6-0718',
      expiresAt: new Date().toISOString(),
      reason: '允许 Latch 连接 service.example.com',
      form: 'origin.confirm' as const,
      lines: [{ label: '地址', value: 'https://service.example.com' }],
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
  })

  it('titles a request by what it asks to do, after the glyph of its kind, puts 更多 first, and pages through several requests', () => {
    const html = approvalCard({
      risk: 'R1',
      options: [...ALWAYS],
      tool: {
        toolTitle: '写入文件',
        input: JSON.stringify({ path: 'docs/notes.md', content: 'a\nb\n' }),
        diffs: [{ path: 'docs/notes.md', oldText: '', newText: 'a\nb\n' }],
      },
    })
    expect(html).toMatch(
      /<div class="approval-title"><span class="approval-kind" aria-hidden="true"><svg[^>]*latch-glyph-edit[^>]*>.*?<\/svg><\/span><span class="approval-object">写入文件 docs\/notes\.md<\/span><span class="approval-stat"><span class="stat-add">\+2<\/span>/u,
    )
    // No word of waiting stands in for the title, and the tool's ID and 查看改动 sit on the line under it.
    expect(html).not.toMatch(/等你处理|需要你允许/u)
    expect(html).toMatch(
      /<div class="approval-meta"><code class="tool-card-name">write_file<\/code><button[^>]*class="ui-button approval-see"[^>]*>查看改动<\/button>/u,
    )
    // 更多 · 拒绝 · 允许.
    const order = [...html.matchAll(/<button[^>]*class="ui-button(?: approval-more)?"[^>]*>([^<]+)/gu)].map(match => match[1])
    expect(order).toEqual(['更多', '拒绝', '允许'])
    const two = renderToStaticMarkup(
      createElement(ApprovalDrawer, {
        approvals: [approval({ risk: 'R1' }), approval({ id: 'ap2', risk: 'R1' })],
        messages: [],
        index: 1,
        onIndex: noop,
        gateFor: item => approvalActions(item, null),
        busy: new Map(),
        statuses: new Map(),
        onDecide: noop,
      }),
    )
    expect(two).toContain('<span>2/2</span>')
  })

  it('on the workbench marks a command by its glyph, keeps the tool ID for the title’s tooltip and folds from 更多', () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalDrawer, {
        presentation: 'workbench',
        approvals: [
          approval({
            risk: 'R1',
            toolName: 'shell',
            arguments: JSON.stringify({ command: 'pnpm test' }),
            tool: { kind: 'execute', title: '运行测试', input: JSON.stringify({ command: 'pnpm test' }) },
          }),
        ],
        messages: [],
        index: 0,
        onIndex: noop,
        gateFor: item => approvalActions(item, null),
        busy: new Map(),
        statuses: new Map(),
        onDecide: noop,
      }),
    )
    expect(html).toMatch(/<span class="approval-kind" aria-hidden="true"><svg[^>]*latch-glyph-terminal/u)
    // The ID is the tooltip of the title; the written copy is only for screens that cannot hover.
    expect(html).toMatch(/role="tooltip" class="ui-tooltip"><span>shell<\/span>/u)
    expect(html).not.toContain('tool-card-name')
    // An open preview has no link under the title: 收起 is one of 更多.
    expect(html).toMatch(/class="approval-preview"[^>]*data-open=""/u)
    expect(html).not.toContain('approval-see')
    expect(html).toContain(`data-label="${APPROVAL_COPY.hidePreview}"`)
  })

  it('takes no press until it has armed, so a click meant for what was there cannot land on it', () => {
    const html = renderToStaticMarkup(createElement(Drawer, { message: tool(), approval: approval({ risk: 'R1' }), onDecide: noop }))
    expect(html).toContain('data-arming=""')
    expect(buttonLabels(html)).toEqual(['拒绝', '允许'])
    expect(html.match(/<button[^>]*aria-disabled="true"/gu)).toHaveLength(2)
  })

  it('gives a high-risk request its reason on a line of its own, and allowing a lock', () => {
    const html = renderToStaticMarkup(
      createElement(Drawer, {
        message: tool(),
        approval: approval({ risk: 'R2' }),
        onDecide: noop,
        gateFor: (): ApprovalGate => ({
          kind: 'R2',
          badge: { label: '高风险', tone: 'err' },
          explicit: false,
          options: [
            { id: 'reject_once', label: '拒绝', kind: 'reject_once' },
            { id: 'allow_once', label: '允许一次', kind: 'allow_once' },
          ],
        }),
      }),
    )
    expect(html).toContain('data-risky=""')
    // The red reason, then the short fact; the Host's sentence is word for word behind ⓘ, not repeated in the details.
    expect(html).toContain('<div class="approval-clause"><span class="approval-clause-reason">高风险</span>')
    expect(html).toMatch(/class="ui-hint approval-clause-sentence"[^>]*>.*?每次都要确认/u)
    // Folded, the sentence is nowhere else on the card: only its ⓘ shows it.
    expect(html).toMatch(/class="ui-hint approval-clause-sentence"(?:(?!<\/div>).)*aria-expanded="false"/u)
    expect(html.match(/写入需要确认/gu) ?? []).toHaveLength(0)
    expect(html).toMatch(/data-variant="primary"[^>]*>(?:(?!<\/button>).)*?允许<\/button>/u)
  })

  it('draws a key cap only on a button its key presses now', () => {
    const allowOnce = { kind: 'allow_once' } as const
    // ⌘⏎ allows an ordinary request of Latch 内置 or an older Host, never a high-risk request or an agent's ask.
    expect(allowsByKey({ kind: 'R1' }, allowOnce)).toBe(true)
    expect(allowsByKey({ kind: 'legacy' }, allowOnce)).toBe(true)
    expect(allowsByKey({ kind: 'R2' }, allowOnce)).toBe(false)
    expect(allowsByKey({ kind: 'advisory' }, allowOnce)).toBe(false)
    expect(allowsByKey({ kind: 'R1' }, { kind: 'allow_always' })).toBe(false)
    const now = { phone: false, shortcut: true, escapes: true, inCard: true, escapeRefuses: true }
    expect(approvalKeyCaps(now)).toEqual({ allow: ['mod', 'enter'], reject: ['esc'] })
    // A high-risk request or an agent's ask: Esc still refuses, 允许 has no key.
    expect(approvalKeyCaps({ ...now, shortcut: false })).toEqual({ reject: ['esc'] })
    // Focus outside the card (in the input, say): ⌘⏎ sends there, so 允许 shows none.
    expect(approvalKeyCaps({ ...now, inCard: false })).toEqual({ reject: ['esc'] })
    // Writing a note to send with the rejection, or focus in another field: Esc does not refuse.
    expect(approvalKeyCaps({ ...now, rejectLabel: APPROVAL_COPY.rejectAndSend })).toEqual({ allow: ['mod', 'enter'] })
    expect(approvalKeyCaps({ ...now, inCard: false, escapeRefuses: false })).toEqual({})
    // Not armed yet, or a choice on its way: no key does anything.
    expect(approvalKeyCaps({ ...now, shortcut: false, escapes: false })).toEqual({})
    // A phone draws none.
    expect(approvalKeyCaps({ ...now, phone: true })).toEqual({})
    // Rendered before focus is known, a card claims no key.
    expect(approvalCard({ risk: 'R1' })).not.toContain('ui-button-keys')
  })

  it('never labels a write without previous text as a new file', () => {
    const html = renderToStaticMarkup(
      createElement(Drawer, {
        message: tool(),
        onDecide: noop,
        approval: approval({
          arguments: JSON.stringify({ path: 'data.sqlite', content: 'x' }),
          tool: { diffs: [{ path: 'data.sqlite', newText: 'x' }] },
        }),
      }),
    )
    expect(html).not.toContain('>新文件<')
    expect(html).toContain(`<span class="ui-status-word" data-tone="warn" data-lock="" title="${PREVIOUS_UNKNOWN_TEXT}">原内容未知</span>`)
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
    expect(hidden).toContain(
      `<span class="ui-status-word" data-tone="warn" data-lock="" title="${PREVIOUS_UNAVAILABLE_TEXT}">原内容未显示</span>`,
    )
    expect(hidden).toContain(`<p class="diff-note">${PREVIOUS_UNAVAILABLE_TEXT}</p>`)
    expect(hidden).toContain('@@ +1,1 @@')
    for (const html of [hidden, render({})]) expect(html).not.toContain('>新文件<')
    expect(render({})).toContain('>原内容未知</span>')
    const edited = render({ previous: 'text', oldText: 'y\n' })
    expect(edited).not.toMatch(/新文件|原内容/)
    expect(edited).toContain('−1')
    const card = renderToStaticMarkup(
      createElement(Drawer, {
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
  const folders = (onNewProject?: () => void) =>
    renderToStaticMarkup(
      createElement(SessionFolders, {
        snapshot: appSnapshot({ catalog: hostCatalog({ workspaces: [start] }) }),
        summary: session({ cwd: start.path }),
        local: true,
        admin: false,
        ...(onNewProject ? { onNewProject } : {}),
      }),
    )

  it('warns in the breadcrumb’s popover by the Host’s flag, with 添加项目… where this device can make one', () => {
    const html = folders(noop)
    expect(html).toContain('data-tone="warn"')
    expect(html).toContain(CODE_ROOT_COPY.notice)
    expect(html).toContain(CODE_ROOT_COPY.startDir)
    expect(html).toContain(`>${CODE_ROOT_COPY.newProject}</button>`)
    // Elsewhere only the reason; and nothing for a folder the Host does not flag.
    expect(folders()).not.toContain(CODE_ROOT_COPY.newProject)
    const plain = renderToStaticMarkup(
      createElement(SessionFolders, {
        snapshot: appSnapshot({ catalog: hostCatalog({ workspaces: [{ ...start, codeRoot: undefined }] }) }),
        summary: session({ cwd: start.path }),
        local: true,
        admin: false,
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
      createElement(ProjectRow, { workspace: { ...start, id: 'p1' }, owner: true, isDefault: false, folders: null, onRemove: noop }),
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
    expect(flagged).not.toContain('要在其他文件夹中工作，请添加项目。')
    const { codeRoot: _codeRoot, ...ordinary } = start
    const plain = settings(ordinary)
    expect(plain).not.toContain(CODE_ROOT_COPY.startDir)
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

  it('keeps an empty send focusable with its reason', () => {
    const empty = renderToStaticMarkup(createElement(Composer, { ...base, draft: '' }))
    expect(empty).toContain('aria-label="发送"')
    expect(empty).toContain('aria-disabled="true"')
    expect(empty).not.toMatch(/<button[^>]*aria-label="发送"[^>]*disabled=""/u)
  })

  it('puts stop in the send slot, and steps it back while an approval waits', () => {
    const html = renderToStaticMarkup(createElement(Composer, { ...base, variant: 'session', run: { cancel: 'idle', onCancel: noop } }))
    // Stop takes the send slot and is never red.
    expect(html).toContain('aria-label="停止"')
    expect(html).not.toContain('data-step-back')
    const waiting = renderToStaticMarkup(
      createElement(Composer, { ...base, draft: '', variant: 'session', stepBack: true, run: { cancel: 'idle', onCancel: noop } }),
    )
    expect(waiting).toContain('data-step-back')
  })

  it('keeps a way to stop while a question waits: stop until text is written, and beside send on touch', () => {
    const asking = {
      ...base,
      variant: 'session' as const,
      stepBack: true,
      answer: { kind: 'question' as const, onSubmit: noop },
      run: { cancel: 'idle' as const, onCancel: noop },
    }
    const empty = renderToStaticMarkup(createElement(Composer, { ...asking, draft: '' }))
    expect(empty).toContain('aria-label="停止"')
    expect(empty).toContain('data-step-back')
    expect(empty).not.toContain('aria-label="发送"')
    const written = renderToStaticMarkup(createElement(Composer, asking))
    expect(written).toContain('aria-label="发送"')
    expect(written).not.toContain('aria-label="停止"')
    const touch = renderToStaticMarkup(createElement(Composer, { ...asking, coarse: true }))
    expect(touch).toContain('aria-label="发送"')
    expect(touch).toContain('aria-label="停止"')
  })

  it('says a stop whose outcome is unknown once, in the bar with 重试, and leaves the stop button a square', () => {
    const html = renderToStaticMarkup(
      createElement(Composer, {
        ...base,
        variant: 'session',
        run: { cancel: 'uncertain', onCancel: noop },
      }),
    )
    expect(html.match(/尚未确认/gu)).toHaveLength(1)
    expect(html.match(/重试/gu)).toHaveLength(1)
    expect(html).toContain('stop-glyph')
    expect(html).not.toContain('取消')
  })

  it('puts Harness and 模型 at the start and 思考 and 权限 at the end, by send', () => {
    const controls = createElement('span', { 'data-composer-control': 'model' }, 'gpt-5.5')
    const trailing = createElement('span', { 'data-composer-control': 'thinking' }, '高')
    const order = (markup: string) =>
      [...markup.matchAll(/class="composer-(controls|end)"|data-composer-control="(\w+)"|aria-label="发送"/gu)].map(
        match => match[1] ?? match[2] ?? 'send',
      )
    expect(order(renderToStaticMarkup(createElement(Composer, { ...base, controls, trailing })))).toEqual([
      'controls',
      'model',
      'end',
      'thinking',
      'send',
    ])
    // What comes and goes by itself, as a Harness's limits mark, is given last, after every control and right before
    // send at either width: when it appears or leaves, no control before it moves.
    const meta = createElement('span', { 'data-composer-control': 'late' }, '68%')
    expect(order(renderToStaticMarkup(createElement(Composer, { ...base, controls, trailing, meta }))).slice(-3)).toEqual([
      'thinking',
      'late',
      'send',
    ])
    const chips = order(renderToStaticMarkup(createElement(Composer, { ...base, inline: true, controls, trailing, meta })))
    expect(chips).toEqual(['model', 'thinking', 'late', 'send'])
    // A phone: the four controls are one row of chips above the line of ＋, the input and send; no toolbar.
    const phone = renderToStaticMarkup(createElement(Composer, { ...base, variant: 'session', inline: true, controls, trailing }))
    expect(phone).not.toContain('composer-toolbar')
    expect(phone.indexOf('composer-chips')).toBeLessThan(phone.indexOf('composer-line'))
    expect(phone.indexOf('data-composer-control="thinking"')).toBeLessThan(phone.indexOf('composer-line'))
    expect(phone.indexOf('composer-line')).toBeLessThan(phone.indexOf('<textarea'))
    expect(phone.indexOf('<textarea')).toBeLessThan(phone.indexOf('aria-label="发送"'))
  })

  it('shows a device that may only watch a dashed frame with the reason instead of the input', () => {
    const html = renderToStaticMarkup(createElement(Composer, { ...base, variant: 'session', readOnly: '这台设备不能发送消息' }))
    expect(html).toContain('data-variant="read-only"')
    expect(html).toContain('这台设备不能发送消息')
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('aria-label="发送"')
  })
})
