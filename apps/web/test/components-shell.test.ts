import { createElement } from 'react'
import { GitCompare } from 'lucide-react'
import { testHarness } from '@latch/testkit'
import { settingsSectionsAt, visibleEntries } from '../src/shell/routes.ts'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, TaskSummary } from '@latch/protocol'
import { scrollMovesAnchor } from '../src/components/overlays.tsx'
import { SessionHeader } from '../src/shell/ConversationHeader.tsx'
import { Sidebar } from '../src/components/Sidebar.tsx'
import { PhoneSessionList } from '../src/components/PhoneSessionList.tsx'
import { settingsSections } from '../src/settings/SettingsPage.tsx'

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

describe('top bar', () => {
  const topBar = {
    summary: session(),
    cancelling: false,
    demo: false,
    phone: false,
    onNew: noop,
    panelOpen: false,
    onPanel: noop,
    sessionMenu: [],
    menu: [],
    connection: 'connected' as const,
    onRefresh: noop,
  }

  it('names an unhealthy connection in a status pill without a dot, on phones too', () => {
    for (const phone of [true, false]) {
      const html = renderToStaticMarkup(createElement(SessionHeader, { ...topBar, connection: 'offline' as const, phone }))
      expect(html).toMatch(/<button[^>]*class="connection-pill connection-offline"[^>]*>离线<span class="connection-pill-retry">· 重试<svg/)
      expect(html).not.toContain('<i aria-hidden="true"></i>')
    }
    expect(renderToStaticMarkup(createElement(SessionHeader, topBar))).not.toContain('connection-pill')
  })

  it('says the state in the title row, running with its clock, and where the session runs', () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-11T10:01:12Z'), toFake: ['Date'] })
    const pill = (extra: Partial<TaskSummary>, { cancelling = false, connection = 'connected' as 'connected' | 'offline' } = {}) => {
      const html = renderToStaticMarkup(createElement(SessionHeader, { ...topBar, summary: session(extra), cancelling, connection }))
      const word = /<span class="ui-status-word" data-tone="(\w+)">(.*?)<\/span>(?=<\/div>)/u.exec(html)
      return word && [word[1], word[2]!.replace(/<svg.*?<\/svg>|<span[^>]*><\/span>|<!-- -->/gu, '').replace(/<[^>]+>/gu, '')]
    }
    const live = {
      runId: 'r',
      activity: 'model' as const,
      since: '2026-11-11T10:01:00Z',
      runStartedAt: '2026-11-11T10:00:00Z',
      lastEventAt: '2026-11-11T10:01:10Z',
    }
    expect(pill({ status: 'running', live })).toEqual(['running', '在等模型 1:12'])
    expect(pill({ status: 'running' })).toEqual(['running', '运行中'])
    expect(pill({ status: 'idle' })).toBeNull()
    expect(pill({ status: 'waiting-approval' })).toEqual(['waiting', '等你处理'])
    expect(pill({ status: 'running', pendingQuestions: 1 })).toEqual(['waiting', '等你处理'])
    expect(pill({ status: 'failed' })).toEqual(['failed', '失败'])
    expect(pill({ status: 'cancelled' })).toEqual(['neutral', '已停止'])
    expect(pill({ status: 'interrupted' })).toEqual(['neutral', '已中断'])
    expect(pill({ status: 'running' }, { cancelling: true })).toEqual(['neutral', '正在停止'])
    // While the connection is down nothing live is drawn: the connection says so on the right.
    expect(pill({ status: 'running', live }, { connection: 'offline' })).toBeNull()
    vi.useRealTimers()
    const html = renderToStaticMarkup(
      createElement(SessionHeader, {
        ...topBar,
        harness: testHarness('codex', { kind: 'agent', label: 'Codex' }),
        project: 'latch-app',
      }),
    )
    // The engine and branch live in the composer; the project opens where the session runs.
    expect(html).not.toContain('topbar-source')
    expect(html).toContain('aria-label="项目：latch-app"')
  })

  it('writes the change totals on 改动 only once the page has read them, keeping its name', () => {
    const changes = { label: '改动', icon: GitCompare, shortcut: '⌘D', pressed: false, onToggle: noop }
    const header = (changesTotals?: { add: number; del: number; files: number }) =>
      renderToStaticMarkup(createElement(SessionHeader, { ...topBar, slots: { changes }, ...(changesTotals ? { changesTotals } : {}) }))
    for (const html of [header(), header({ add: 0, del: 0, files: 0 })]) {
      expect(html).toMatch(/<button[^>]*class="ui-icon-button"[^>]*aria-label="改动"/u)
      expect(html).not.toContain('topbar-changes-stat')
    }
    const read = header({ add: 9, del: 3, files: 2 })
    expect(read).toMatch(/<button[^>]*aria-label="改动"[^>]*aria-pressed="false"/u)
    expect(read).toContain(
      '<span class="topbar-changes-stat" aria-hidden="true"><span data-tone="add">+9</span><span data-tone="remove">−3</span></span>',
    )
  })

  it('heads a phone session page with the way back, the title over where it runs, and the panel toggle', () => {
    const menu = [{ id: 'manage', items: [{ id: 'rename', label: '重命名', onSelect: noop }] }]
    const html = renderToStaticMarkup(
      createElement(SessionHeader, {
        ...topBar,
        phone: true,
        onBack: noop,
        menu,
        summary: session({ status: 'failed' }),
        harness: testHarness('codex', { kind: 'agent', label: 'Codex' }),
        project: 'latch-app',
      }),
    )
    expect(html).toMatch(/^<header class="topbar" data-phone=""><button[^>]*aria-label="返回会话列表"/)
    // The title opens the session's menu (a sheet on a phone); 同步最新状态 is the connection notice's 重试, not an item.
    expect(html).toMatch(/<h1[^>]*><button[^>]*aria-haspopup="(?:menu|dialog)"[^>]*class="topbar-title-button">/)
    expect(html).toMatch(
      /<div class="topbar-subline"><span class="topbar-source-text">Codex · latch-app<\/span><span class="ui-status-word" data-tone="failed"><svg[^>]*lucide-circle-alert[^>]*>.*?<\/svg>失败<\/span>/u,
    )
    expect(html).toMatch(/<button[^>]*aria-label="侧边面板"[^>]*>.*<\/header>$/)
    expect(html).not.toContain('新建会话')
    expect(html).not.toContain('aria-label="会话操作"')
  })

  it('keeps a phone page header for a session the Host has not listed yet, with no menu or panel until it does', () => {
    const menu = [{ id: 'manage', items: [{ id: 'rename', label: '重命名', onSelect: noop }] }]
    const html = renderToStaticMarkup(
      createElement(SessionHeader, {
        ...topBar,
        summary: undefined,
        phone: true,
        onBack: noop,
        menu,
        harness: testHarness('codex', { kind: 'agent', label: 'Codex' }),
        project: 'latch-app',
      }),
    )
    expect(html).toMatch(/^<header class="topbar" data-phone=""><button[^>]*aria-label="返回会话列表"/)
    expect(html).toContain('<h1 title="新会话"><span class="topbar-title-text">新会话</span></h1>')
    expect(html).not.toContain('topbar-subline')
    expect(html).not.toContain('侧边面板')
  })

  it('makes the title a button that opens the session menu', () => {
    const sessionMenu = [{ id: 'manage', items: [{ id: 'rename', label: '重命名', onSelect: noop }] }]
    const html = renderToStaticMarkup(createElement(SessionHeader, { ...topBar, sessionMenu }))
    expect(html).toMatch(/<h1[^>]*><button[^>]*aria-haspopup="menu"[^>]*class="topbar-title-button"><span class="topbar-title-text">/)
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

describe('shell routes', () => {
  it('draws 设置 when this device can use any of its sections, and nothing else beside the sessions', () => {
    expect(visibleEntries(['general', 'about'], false)).toEqual(['sessions', 'settings'])
    expect(visibleEntries(['general', 'plugins', 'devices', 'workspaces'], false)).toEqual(['sessions', 'settings'])
    expect(visibleEntries(['general', 'plugins', 'devices', 'workspaces'], true)).toEqual(['sessions', 'settings'])
    expect(visibleEntries(['shortcuts'], true)).toEqual(['sessions'])
  })

  it('lists 设备 among the sections, before 快捷键, which a phone does not have', () => {
    expect(settingsSectionsAt(false)).toEqual(['general', 'providers', 'engines', 'workspaces', 'plugins', 'devices', 'shortcuts', 'about'])
    expect(settingsSectionsAt(true)).toEqual(['general', 'providers', 'engines', 'workspaces', 'plugins', 'devices', 'about'])
  })
})

const device = (listener: AppSnapshot['device']['listener'], scopes: AppSnapshot['device']['scopes']): AppSnapshot['device'] => ({
  id: 'd',
  name: '浏览器',
  status: 'active',
  listener,
  scopes,
  dataScope: 'work',
  fingerprint: 'ABCD EFGH IJKL MNOP QRST',
  createdAt: '',
  lastSeenAt: '',
  credentialExpiresAt: '',
  pairedBy: { method: 'lpc' },
  current: true,
  renewAfter: '',
})
const snapshotOf = (listener: AppSnapshot['device']['listener'], scopes: AppSnapshot['device']['scopes'] = ['view', 'run', 'admin']) =>
  ({
    instanceId: 'host',
    device: device(listener, scopes),
    host: { hostId: 'h', devMode: false, presence: { status: 'available' }, tls: null },
    catalog: { harnesses: [], providers: [], workspaces: [], defaults: { harnessId: 'standard', mode: 'agent' } },
    tasks: [],
    approvals: [],
    demo: false,
    hostName: 'studio-mini',
  }) as unknown as AppSnapshot

describe('设置 sections', () => {
  it('gives a device that manages this Mac every section, and one that does not 通用 · 设备 · 快捷键 · 关于', () => {
    expect(settingsSections(snapshotOf('loopback-tcp'))).toEqual([
      'general',
      'providers',
      'engines',
      'workspaces',
      'plugins',
      'devices',
      'shortcuts',
      'about',
    ])
    expect(settingsSections(snapshotOf('loopback-tcp', ['view', 'run']))).toEqual(['general', 'devices', 'shortcuts', 'about'])
  })
})

describe('the sidebar foot and the computer name', () => {
  // Folded shelves are remembered per page origin.
  beforeEach(() => {
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:4317', host: '127.0.0.1:4317', pathname: '/link/' })
  })
  const sidebar = (snapshot: AppSnapshot, onCreateProject?: () => void) =>
    renderToStaticMarkup(
      createElement(Sidebar, {
        snapshot,
        selectedId: null,
        isUnread: () => false,
        cancelling: new Set<string>(),
        filter: 'all',
        onFilter: noop,
        onSelect: noop,
        onNew: noop,
        onSearch: noop,
        drawer: false,
        onClose: noop,
        connection: 'connected',
        onRefresh: noop,
        sessionMenu: () => [],
        now: 0,
        entries: ['sessions', 'settings'],
        onEntry: noop,
        hostProblem: null,
        ...(onCreateProject ? { onCreateProject } : {}),
      }),
    )
  const phoneList = (snapshot: AppSnapshot) =>
    renderToStaticMarkup(
      createElement(PhoneSessionList, {
        snapshot,
        connection: 'connected',
        selectedId: null,
        isUnread: () => false,
        cancelling: new Set<string>(),
        search: '',
        onSearch: noop,
        searchRef: { current: null },
        searching: false,
        onSearching: noop,
        filter: 'all',
        onFilter: noop,
        onSelect: noop,
        onNew: noop,
        sessionMenu: () => [],
        now: 0,
      }),
    )

  it('names the computer at the top for a browser, even one on this Mac over loopback', () => {
    const html = sidebar(snapshotOf('loopback-tcp'))
    expect(html).toContain('<span class="sidebar-host-name">studio-mini</span>')
    expect(html.indexOf('sidebar-host')).toBeLessThan(html.indexOf('新会话'))
    const phone = phoneList(snapshotOf('native-relay'))
    expect(phone).toContain('<span class="phone-list-host-name">studio-mini</span>')
    expect(phone.indexOf('phone-list-host')).toBeLessThan(phone.indexOf('<h1>会话</h1>'))
    expect(phone).not.toContain('同步最新状态')
  })

  it('does not name it in the Latch app on that Mac', () => {
    vi.stubGlobal('window', { latchShell: { kind: 'electron', platform: 'darwin' } })
    expect(sidebar(snapshotOf('unix'), noop)).not.toContain('sidebar-host')
    expect(phoneList(snapshotOf('unix'))).not.toContain('phone-list-host')
  })

  it('puts 设置 with its word at the foot, 添加项目 only where the app offers it, and no 手机', () => {
    const foot = (html: string) => html.slice(html.indexOf('<nav class="sidebar-foot"'))
    const remote = foot(sidebar(snapshotOf('loopback-tcp')))
    expect(remote).toMatch(/<button[^>]*class="ui-button sidebar-settings"[^>]*>.*设置<\/button>/)
    expect(remote).not.toContain('添加项目')
    expect(remote).not.toContain('手机')
    vi.stubGlobal('window', { latchShell: { kind: 'electron', platform: 'darwin' } })
    const local = foot(sidebar(snapshotOf('unix'), noop))
    expect(local.indexOf('添加项目')).toBeLessThan(local.indexOf('设置'))
  })
})
