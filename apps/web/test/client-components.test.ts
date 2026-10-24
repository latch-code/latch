import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Approval, AppSnapshot, HostCatalog, Message, TaskDetail, TaskSummary } from '@latch/protocol'
import { sha256Hex } from '@latch/core/node-kit'
import { hashDisplay } from '@latch/host/crypto'
import { newSessionGroups, SessionControls } from '../src/components/ComposerControls.tsx'
import { Inspector } from '../src/components/Inspector.tsx'
import { MessageRow } from '../src/components/MessageRow.tsx'
import { scrollMovesAnchor } from '../src/components/overlays.tsx'
import { RunSettingsGroups } from '../src/components/Pickers.tsx'
import { PlanList } from '../src/components/PlanCard.tsx'
import { DiffView, PREVIOUS_UNAVAILABLE_TEXT, PREVIOUS_UNKNOWN_TEXT } from '../src/components/DiffView.tsx'
import { HIDDEN_CHARACTERS_TEXT, ToolCard } from '../src/components/ToolCard.tsx'
import { TopBar } from '../src/components/TopBar.tsx'
import { Transcript, renderedMessages, turnFooters } from '../src/components/Transcript.tsx'
import { escapeHiddenCharacters, hasHiddenCharacters, VisibleText } from '../src/components/VisibleText.tsx'
import { contentHash } from '../src/core/contentHash.ts'
import { revokeText } from '../src/settings/DevicesSettings.tsx'
import { WorkspaceRow } from '../src/settings/WorkspacesSettings.tsx'

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
    expect([...html.matchAll(/<button[^>]*class="button [^"]*"[^>]*>([^<]+)<\/button>/g)].map(match => match[1])).toEqual([
      '拒绝',
      '本会话始终允许',
      '允许一次',
    ])
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
    expect(html).toContain('<dt>path</dt>')
    expect(html).toContain('class="diff-stat-add">+1</span>')
    expect(html).toContain('class="diff-stat-remove">−1</span>')
    expect(html.match(/<button[^>]*class="button [^"]*"[^>]*disabled=""/g)).toHaveLength(2)
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
    expect(live).toContain('思考中…')
    expect(live).toContain('想一想')
    const settled = renderToStaticMarkup(
      createElement(MessageRow, {
        message: { id: 'm', role: 'assistant', text: '答案', reasoning: '想一想', usage: { inputTokens: 1500, outputTokens: 20 } },
      }),
    )
    expect(settled).not.toContain('正在生成的回复')
    expect(settled).toContain('思考过程')
    expect(settled).not.toContain('想一想')
    expect(settled).toContain('↑1.5k ↓20')
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
    expect(html).toContain('<dt>path</dt>')
    expect(html).not.toContain('<dt>content</dt>')
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
    expect(html).toContain(HIDDEN_CHARACTERS_TEXT)
    expect(html).toContain('title="a\\u{200B}.ts"')
    // No allow option looks like the default choice.
    expect(html).not.toContain('class="button primary"')
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
    expect(html).toContain(`<span class="badge badge-warn" title="${PREVIOUS_UNKNOWN_TEXT}">原内容未知</span>`)
    expect(html).toContain(`<p class="approval-warning" role="note">${PREVIOUS_UNKNOWN_TEXT}</p>`)
    expect(html).toContain('@@ +1,1 @@')
    expect(html).not.toContain('−0')
    expect(html).not.toContain('-0,0')
  })

  it('labels a diff by what the producer reported about the previous file', () => {
    const render = (diff: { previous?: 'none' | 'text' | 'unavailable'; oldText?: string }) =>
      renderToStaticMarkup(createElement(DiffView, { diffs: [{ path: 'a.txt', newText: 'x\n', ...diff }] }))
    const created = render({ previous: 'none' })
    expect(created).toContain('<span class="badge badge-neutral">新文件</span>')
    expect(created).toContain('@@ -0,0 +1,1 @@')
    expect(created).not.toContain('badge-warn')
    const hidden = render({ previous: 'unavailable' })
    expect(hidden).toContain(`<span class="badge badge-warn" title="${PREVIOUS_UNAVAILABLE_TEXT}">原内容未显示</span>`)
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

describe('turn footers', () => {
  const turn: Message[] = [
    { id: 'u1', role: 'user', text: '一' },
    { id: 'before', role: 'assistant', text: 'before', usage: { inputTokens: 100, outputTokens: 10 } },
    tool({ state: 'completed' }),
    { id: 'after', role: 'assistant', text: 'after', usage: { inputTokens: 200, outputTokens: 20 } },
    { id: 'u2', role: 'user', text: '二' },
    { id: 'next', role: 'assistant', text: '进行中' },
  ]

  it('gives only the block that ends a settled turn a footer, with the turn usage summed', () => {
    expect([...turnFooters(turn, false)]).toEqual([
      ['after', { inputTokens: 300, outputTokens: 30 }],
      ['next', undefined],
    ])
    expect([...turnFooters(turn, true).keys()]).toEqual(['after'])
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
    expect(html.match(/class="message-footer"/g)).toHaveLength(1)
    expect(html.match(/aria-label="复制回复"/g)).toHaveLength(1)
    expect(html).toContain('↑300 ↓30')
  })
})

describe('plan', () => {
  const plan = [
    { content: 'Read', status: 'completed' as const },
    { content: 'Write', status: 'in_progress' as const },
  ]
  it('spins only while the session runs', () => {
    expect(renderToStaticMarkup(createElement(PlanList, { plan, active: true }))).toContain(' spin"')
    const settled = renderToStaticMarkup(createElement(PlanList, { plan, active: false }))
    expect(settled).not.toContain('spin')
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
        snapshot: appSnapshot(),
        summary: session({ cwd: '/Users/me/personal/harness-link' }),
        detail: null,
        onReveal: noop,
      }),
    )
    expect(html).toContain('<span class="inspector-path-name">harness-link</span>')
    expect(html).toContain('<span class="inspector-path-full">/Users/me/personal/harness-link</span>')
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
  }
  it('marks a switch that the next message will carry', () => {
    const idle = renderToStaticMarkup(createElement(SessionControls, { ...props, model: props.current, phone: false }))
    expect(idle).not.toContain('is-pending')
    const desktop = renderToStaticMarkup(
      createElement(SessionControls, { ...props, model: { providerId: 'fake', model: 'fake-coder-32k' }, phone: false }),
    )
    expect(desktop).toContain('class="chip is-pending"')
    expect(desktop).toContain('下一条：fake-coder-32k')
    const phone = renderToStaticMarkup(
      createElement(SessionControls, { ...props, model: { providerId: 'fake', model: 'fake-coder-32k' }, phone: true }),
    )
    expect(phone).toContain('run-settings-chip is-pending')
    expect(phone).toContain('aria-label="运行设置：下一条：fake-coder-32k"')
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
  it('keeps the connection state as a named dot on phones', () => {
    const base = {
      summary: session(),
      cancelling: false,
      demo: false,
      drawerOpen: false,
      onNew: noop,
      inspectorOpen: false,
      onInspector: noop,
      menu: [],
      connection: 'offline' as const,
      onRefresh: noop,
    }
    const phone = renderToStaticMarkup(createElement(TopBar, { ...base, phone: true }))
    expect(phone).toMatch(
      /<button[^>]*class="connection-pill connection-offline is-compact"[^>]*aria-label="离线"[^>]*><i aria-hidden="true"><\/i><svg/,
    )
    const desktop = renderToStaticMarkup(createElement(TopBar, { ...base, phone: false }))
    expect(desktop).toMatch(/<i aria-hidden="true"><\/i>离线<svg/)
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

describe('content hash next to a write diff', () => {
  const line = (shown: string) => `<span>新内容哈希</span>${shown}</p>`

  it('renders at once with a placeholder, then shows the hash the local confirmation shows for the new text', async () => {
    const text = 'export const answer = 42\n'
    const card = () =>
      renderToStaticMarkup(
        createElement(ToolCard, {
          message: tool(),
          onDecide: noop,
          approval: approval({
            risk: 'R2',
            arguments: JSON.stringify({ path: 'a.ts', content: text }),
            tool: { diffs: [{ path: 'a.ts', newText: text, previous: 'none' }] },
          }),
        }),
      )
    expect(card()).toContain(line('<span class="diff-hash-pending">计算中…</span>'))
    const expected = hashDisplay(sha256Hex(text))
    expect(await contentHash(text)).toBe(expected)
    expect(card()).toContain(line(`<code>${expected}</code>`))
    // Tool cards show their changes through the same diff view.
    expect(
      renderToStaticMarkup(createElement(DiffView, { diffs: [{ path: 'a.ts', oldText: 'x\n', newText: text, previous: 'text' }] })),
    ).toContain(line(`<code>${expected}</code>`))
  })

  it('leaves the line out without WebCrypto and for a diff side the agent clipped', () => {
    expect(
      renderToStaticMarkup(
        createElement(DiffView, { diffs: [{ path: 'big.txt', newText: 'x\n…（内容过长，已截断）', previous: 'none' }] }),
      ),
    ).not.toContain('新内容哈希')
    vi.stubGlobal('crypto', undefined)
    expect(
      renderToStaticMarkup(createElement(DiffView, { diffs: [{ path: 'b.ts', newText: 'only on an insecure origin' }] })),
    ).not.toContain('新内容哈希')
  })
})

describe('workspace settings', () => {
  it('lists a workspace the Host disabled with its reason and keeps the remove action', () => {
    const reason = '该目录位于受保护目录（如 .git）内，不能作为项目'
    const html = renderToStaticMarkup(
      createElement(
        'ul',
        null,
        createElement(WorkspaceRow, {
          workspace: { id: 'w1', name: 'hooks', path: '/w/.git/hooks', unavailable: reason },
          owner: true,
          onRemove: noop,
        }),
      ),
    )
    expect(html).toContain('class="workspace-row is-unavailable"')
    expect(html).toContain('<span class="badge badge-warn">不可用</span>')
    expect(html).toContain(`<span class="workspace-unavailable">${reason}</span>`)
    expect(html).toContain('>移除</button>')
    const usable = renderToStaticMarkup(
      createElement(
        'ul',
        null,
        createElement(WorkspaceRow, { workspace: { id: 'w2', name: 'app', path: '/w/app' }, owner: false, onRemove: noop }),
      ),
    )
    expect(usable).not.toMatch(/不可用|移除/)
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
