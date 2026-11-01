import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, FileDirectoryListing, HostCatalog, TaskDetail, TaskSummary } from '@latch/protocol'
import { launcherRows } from '../src/panel/PanelLauncher.tsx'
import { SessionPanels } from '../src/components/SessionPanels.tsx'
import { FileBreadcrumb, breadcrumbFolders } from '../src/preview/FileBreadcrumb.tsx'
import { soleFolder } from '../src/preview/treeFiles.ts'
import { SessionFacts, SessionFolders, liveFolder } from '../src/shell/SessionEnvironment.tsx'
import { closeTab, offerTab, type FileTab } from '../src/preview/useFileTabs.ts'
import { sessionMenuSections } from '../src/sessionMenu.ts'

const noop = () => {}
afterEach(() => {
  vi.unstubAllGlobals()
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

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element)

describe('the launcher', () => {
  it('offers only what this session can open, with the letter that opens it', () => {
    expect(launcherRows({ changes: true, files: true }).map(row => [row.label, row.letter])).toEqual([
      ['变更', 'D'],
      ['文件', 'F'],
    ])
    expect(launcherRows({ files: true, plugins: [{ id: 'p', title: '发布' }] }).map(row => [row.label, row.letter])).toEqual([
      ['文件', 'F'],
      ['发布', undefined],
    ])
    expect(launcherRows({})).toEqual([])
  })

  it('stands in for the panel when nothing is open, and says so when there is nothing to open', () => {
    const summary = session({ cwd: '/work/app' })
    const html = render(createElement(SessionPanels, { summary, changes: 'changes', fileContext: { kind: 'session', sessionId: 's' } }))
    expect(html).toContain('打开一个面板')
    expect(html).toContain('aria-label="会话面板"')
    // The tabs stand in the strip with none of them selected.
    expect(html).not.toContain('aria-selected="true"')
    // A tab left open keeps its content mounted and hidden; one never opened is not read at all.
    expect(html).not.toContain('session-panel-changes')
    expect(render(createElement(SessionPanels, { summary }))).toContain('这个会话没有可以打开的面板')
  })

  it('offers no way to maximise a launcher', () => {
    const html = render(createElement(SessionPanels, { summary: session(), onExpand: noop, onClose: noop }))
    expect(html).not.toContain('aria-label="铺满"')
    expect(html).toContain('aria-label="关闭"')
  })
})

describe('the file breadcrumb', () => {
  it('walks every folder of the path, from the root', () => {
    expect(breadcrumbFolders('latch', 'guide.md')).toEqual([{ name: 'latch', dir: '' }])
    expect(breadcrumbFolders('latch', 'apps/web/main.tsx')).toEqual([
      { name: 'latch', dir: '' },
      { name: 'apps', dir: 'apps' },
      { name: 'web', dir: 'apps/web' },
    ])
  })

  it('names an attachment as an attachment, with no folders to open', () => {
    const html = render(
      createElement(FileBreadcrumb, {
        context: { kind: 'session', sessionId: 's' },
        rootName: 'latch',
        path: 'note.txt',
        name: 'note.txt',
        attachment: true,
        browsable: true,
        onOpen: noop,
      }),
    )
    expect(html).toContain('消息附件')
    expect(html).not.toContain('file-crumb"')
  })
})

describe('a device that cannot list folders', () => {
  it('sees where the file lives, with no menu to open', () => {
    const html = render(
      createElement(FileBreadcrumb, {
        context: { kind: 'session', sessionId: 's' },
        root: 'r',
        rootName: 'latch',
        path: 'apps/note.txt',
        name: 'note.txt',
        attachment: false,
        browsable: false,
        onOpen: noop,
      }),
    )
    expect(html).toContain('latch')
    expect(html).toContain('apps')
    expect(html).not.toContain('aria-haspopup')
  })
})

describe('a folder with a single folder in it', () => {
  const listing = (entries: Array<{ name: string; kind: 'file' | 'directory' }>, truncated = false) =>
    ({ entries, truncated }) as unknown as FileDirectoryListing

  it('reads as one row only when the listing is whole and holds nothing else', () => {
    expect(soleFolder(listing([{ name: 'src', kind: 'directory' }]))).toBe('src')
    expect(soleFolder(listing([{ name: 'src', kind: 'directory' }], true))).toBeUndefined()
    expect(soleFolder(listing([{ name: 'a.ts', kind: 'file' }]))).toBeUndefined()
    expect(
      soleFolder(
        listing([
          { name: 'src', kind: 'directory' },
          { name: 'a.ts', kind: 'file' },
        ]),
      ),
    ).toBeUndefined()
    expect(soleFolder(undefined)).toBeUndefined()
  })
})

describe('the session in the breadcrumb', () => {
  it('lists what became of each folder and which ones the agent can reach', () => {
    const catalog = hostCatalog({
      harnesses: [
        {
          id: 'codex',
          name: 'Codex',
          source: 'acp',
          status: 'ready',
          modes: ['agent'],
          models: 'agent',
          projectFolders: { access: 'primary' },
        },
      ],
      workspaces: [
        {
          id: 'w',
          name: 'app',
          path: '/work/app',
          folders: [
            { id: 'a', path: '/work/app', primary: true },
            { id: 'b', path: '/work/lib', unavailable: true },
          ],
        },
      ],
    } as unknown as Partial<HostCatalog>)
    const html = render(
      createElement(SessionFolders, {
        summary: session({
          harnessId: 'codex',
          workspaceId: 'w',
          cwd: '/work/app',
          folders: [
            { id: 'a', path: '/work/app' },
            { id: 'b', path: '/work/lib' },
            { id: 'c', path: '/work/old' },
          ],
        }),
        snapshot: appSnapshot({ catalog }),
        local: false,
        admin: false,
      }),
    )
    expect(html).toContain('文件夹 · 3')
    expect(html).toContain('找不到')
    expect(html).toContain('已移出项目')
    expect(html).toContain('data-unused=""')
    expect(html).toContain('crumb-note')
  })

  it('has nothing to say of a chat session’s folders', () => {
    const html = render(
      createElement(SessionFolders, {
        summary: session({ mode: 'chat', cwd: '/work/app' }),
        snapshot: appSnapshot(),
        local: false,
        admin: false,
      }),
    )
    expect(html).toBe('')
  })
})

describe('a session the menu can save as a project', () => {
  it('offers 存为项目 only when the caller can do it', () => {
    const actions = { rename: noop, pin: noop, archive: noop, export: noop, remove: noop }
    const labels = (extra: object) =>
      sessionMenuSections(session(), { ...actions, ...extra }, true)
        .flatMap(section => section.items)
        .map(item => item.label)
    expect(labels({})).not.toContain('存为项目…')
    expect(labels({ saveProject: noop })).toContain('存为项目…')
  })
})

describe('a document offered behind the open file', () => {
  const tab = (id: string, fresh = false): FileTab => ({
    id,
    target: { sessionId: 's', reference: `${id}.md`, rootId: 'default' },
    ...(fresh ? { fresh } : {}),
  })
  const full = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => tab(id))

  it('waits in a tab while there is room, once', () => {
    expect(offerTab([tab('a')], tab('b', true)).map(item => item.id)).toEqual(['a', 'b'])
    expect(offerTab([tab('a')], { ...tab('x', true), target: tab('a').target }).map(item => item.id)).toEqual(['a'])
  })

  it('never pushes out a tab already in the strip', () => {
    expect(offerTab(full, tab('g', true))).toBe(full)
  })

  it('loses its dot when closing another tab puts it on show', () => {
    const closed = closeTab([tab('a'), tab('b', true)], 'a', 'a')
    expect(closed.selected).toBe('b')
    expect(closed.tabs[0]!.fresh).toBeUndefined()
    expect(closeTab([tab('a'), tab('b', true), tab('c')], 'a', 'c').tabs[1]!.fresh).toBe(true)
  })
})

describe('a project folder the session froze', () => {
  const project = { id: 'p', name: 'app', path: '/work/app', folders: [{ id: 'default', path: '/work/moved' }] }

  it('opens only while it is still the folder the session names', () => {
    expect(liveFolder(project, [{ id: 'default', path: '/work/moved' }], 'default')).toBeDefined()
    expect(liveFolder(project, [{ id: 'default', path: '/work/app' }], 'default')).toBeUndefined()
    expect(liveFolder(project, undefined, 'default')).toBeDefined()
    expect(liveFolder(undefined, undefined, 'default')).toBeUndefined()
  })
})

describe('the facts below the folders', () => {
  const detail = (config: NonNullable<TaskDetail['config']>) =>
    ({ summary: session(), messages: [], approvals: [], config }) as unknown as TaskDetail
  const option = { id: 'speed', name: 'Speed', currentValue: 'fast', options: [{ value: 'fast', name: 'Fast' }] }

  it('state the options of a session that takes no input, with the reason', () => {
    const text = render(
      createElement(SessionFacts, {
        summary: session(),
        detail: detail([option]),
        harness: undefined,
        gate: { kind: 'read-only', text: '只能查看' },
      }),
    )
    expect(text).toContain('Speed')
    expect(text).toContain('Fast')
    expect(text).toContain('只能查看')
  })

  it('leave them to the composer while it is open', () => {
    const text = render(
      createElement(SessionFacts, { summary: session(), detail: detail([option]), harness: undefined, gate: { kind: 'open' } }),
    )
    expect(text).not.toContain('Speed')
  })
})
