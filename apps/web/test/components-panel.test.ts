import { createElement } from 'react'
import { testHarness } from '@latch/testkit'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, FileDirectoryListing, HostCatalog, TaskDetail, TaskSummary } from '@latch/protocol'
import {
  closePanelTab,
  freshPanelMemory,
  openPanelTab,
  panelChoices,
  parsePanelMemory,
  shownPanelTabs,
  type PanelMemory,
} from '../src/panel/panelTabs.ts'
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

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element)

describe('what the panel can open', () => {
  it('offers only what exists and is allowed here, in one order, each fixed panel with its letter', () => {
    expect(
      panelChoices({ browser: true, terminal: true, files: true, changes: true, delivery: true, overview: true }).map(row => [
        row.label,
        row.letter,
      ]),
    ).toEqual([
      ['浏览器', 'B'],
      ['终端', 'T'],
      ['文件', 'F'],
      ['改动', 'D'],
      ['交付', 'P'],
      ['概要', 'O'],
    ])
    // A phone or another computer: no terminal; a read-only device: no 改动 or 交付.
    expect(panelChoices({ files: true, plugins: [{ id: 'p', title: '发布' }] }).map(row => [row.key, row.letter])).toEqual([
      ['files', 'F'],
      ['plugin:p', undefined],
    ])
    expect(panelChoices({})).toEqual([])
  })
})

describe('the open tabs', () => {
  const memory = (tabs: PanelMemory['tabs'], active?: PanelMemory['active']): PanelMemory => (active ? { tabs, active } : { tabs })

  it('start on 概要 where the session has one, else with nothing open', () => {
    expect(freshPanelMemory(true)).toEqual(memory(['overview'], 'overview'))
    expect(freshPanelMemory(false)).toEqual(memory([]))
  })

  it('focus a single-instance tab that is open instead of adding another, and add a new one at the end', () => {
    const open = memory(['overview', 'changes'], 'overview')
    expect(openPanelTab(open, 'changes')).toEqual(memory(['overview', 'changes'], 'changes'))
    expect(openPanelTab(open, 'terminal')).toEqual(memory(['overview', 'changes', 'terminal'], 'terminal'))
  })

  it('hand the selection to the next tab when the selected one closes, or the one before at the end, or to nothing', () => {
    const open = memory(['overview', 'changes', 'browser'], 'changes')
    expect(closePanelTab(open, 'changes')).toEqual(memory(['overview', 'browser'], 'browser'))
    expect(closePanelTab(memory(['overview', 'browser'], 'browser'), 'browser')).toEqual(memory(['overview'], 'overview'))
    expect(closePanelTab(memory(['overview'], 'overview'), 'overview')).toEqual(memory([]))
    expect(closePanelTab(open, 'overview')).toEqual(memory(['changes', 'browser'], 'changes'))
  })

  it('show only what this device may open of what was remembered', () => {
    const remembered = memory(['terminal', 'changes', 'plugin:gone'], 'terminal')
    // On a phone the terminal stays remembered but is not shown; the selection falls to the first shown.
    expect(shownPanelTabs(remembered, key => key === 'changes')).toEqual(memory(['changes'], 'changes'))
    expect(shownPanelTabs(remembered, () => false)).toEqual(memory([]))
  })

  it('read back only valid tabs from storage', () => {
    expect(parsePanelMemory({ tabs: ['changes', 'nope', 'plugin:x', 'changes', 3], active: 'plugin:x' })).toEqual(
      memory(['changes', 'plugin:x'], 'plugin:x'),
    )
    expect(parsePanelMemory({ tabs: ['changes'], active: 'browser' })).toEqual(memory(['changes']))
    expect(parsePanelMemory({ tabs: ['plugin:\u0007'] })).toEqual(memory([]))
    expect(parsePanelMemory('changes')).toBeUndefined()
  })
})

describe('the panel strip', () => {
  const summary = session({ cwd: '/work/app' })
  const choices = panelChoices({ files: true, changes: true, overview: true })

  it('shows the open tabs with a 「+」 and every one closable', () => {
    const html = render(
      createElement(SessionPanels, {
        summary,
        open: ['overview', 'changes'],
        active: 'overview',
        overview: 'overview',
        changes: 'changes',
        choices,
        onChoose: noop,
        onCloseTab: noop,
      }),
    )
    expect(html).toContain('aria-label="会话面板"')
    expect(html).toContain('aria-label="打开面板"')
    expect(html).toContain('aria-label="关闭概要"')
    expect(html).toContain('aria-label="关闭改动"')
    // A tab not yet shown is not read at all.
    expect(html).not.toContain('session-panel-changes')
    // 文件 was never opened: it waits in 「+」, not in the strip.
    expect(html).not.toMatch(/role="tab"[^>]*>[^<]*<[^>]*>[^<]*文件/u)
  })

  it('with nothing open shows the choices as icons and names with their keys, and no sentence', () => {
    const html = render(createElement(SessionPanels, { summary, open: [], choices, onChoose: noop, onCloseTab: noop, onExpand: noop }))
    expect(html).toContain('panel-empty-choice')
    for (const label of ['文件', '改动', '概要']) expect(html).toContain(label)
    expect(html).toContain('aria-keyshortcuts="F"')
    expect(html).not.toContain('aria-selected="true"')
    // Nothing to maximise and no close button: the panel's toggle shuts it.
    expect(html).not.toContain('aria-label="铺满"')
    expect(html).not.toMatch(/<p[ >]/u)
  })

  it('hides a remembered tab whose content this session lacks', () => {
    const html = render(createElement(SessionPanels, { summary, open: ['terminal', 'changes'], active: 'terminal', changes: 'changes' }))
    expect(html).not.toContain('终端')
    expect(html).toContain('session-panel-changes')
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
      harnesses: [testHarness('codex', { label: 'Codex', projectFolders: { access: 'primary' } })],
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
