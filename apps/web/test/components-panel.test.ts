import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, HostCatalog, Message, TaskSummary } from '@latch/protocol'
import { fileChanges, Inspector } from '../src/components/Inspector.tsx'

const noop = () => {}
afterEach(() => {
  vi.unstubAllGlobals()
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
