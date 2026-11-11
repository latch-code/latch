import { createElement } from 'react'
import { GitCompare } from 'lucide-react'
import { testHarness } from '@latch/testkit'
import { entryOfSection, routeAtWidth, visibleEntries } from '../src/shell/routes.ts'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, TaskSummary } from '@latch/protocol'
import { scrollMovesAnchor } from '../src/components/overlays.tsx'
import { SessionHeader } from '../src/shell/ConversationHeader.tsx'

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
    expect(pill({ status: 'running', live })).toEqual(['running', '运行中 1:12'])
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
    const menu = [{ id: 'sync', items: [{ id: 'refresh', label: '同步最新状态', onSelect: noop }] }]
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
    // The title opens the session's menu (a sheet on a phone), 同步最新状态 included.
    expect(html).toMatch(/<h1[^>]*><button[^>]*aria-haspopup="(?:menu|dialog)"[^>]*class="topbar-title-button">/)
    expect(html).toMatch(
      /<div class="topbar-subline"><span class="topbar-source-text">Codex · latch-app<\/span><span class="ui-status-word" data-tone="failed"><svg[^>]*lucide-circle-alert[^>]*>.*?<\/svg>失败<\/span>/u,
    )
    expect(html).toMatch(/<button[^>]*aria-label="侧边面板"[^>]*>.*<\/header>$/)
    expect(html).not.toContain('新建会话')
    expect(html).not.toContain('aria-label="会话操作"')
  })

  it('keeps a phone page header for a session the Host has not listed yet, with no menu or panel until it does', () => {
    const menu = [{ id: 'sync', items: [{ id: 'refresh', label: '同步最新状态', onSelect: noop }] }]
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
  it('draws only the entries this device can use', () => {
    expect(visibleEntries(['general', 'about'], false)).toEqual(['sessions', 'settings'])
    expect(visibleEntries(['general', 'plugins', 'devices', 'workspaces'], false)).toEqual(['sessions', 'phone', 'settings'])
  })

  it('gives a phone 会话 and 设置, with every section inside 设置', () => {
    expect(visibleEntries(['general', 'plugins', 'devices', 'workspaces'], true)).toEqual(['sessions', 'settings'])
    expect(entryOfSection('workspaces', true)).toBe('settings')
    expect(entryOfSection('workspaces', false)).toBe('settings')
    expect(entryOfSection('devices', true)).toBe('settings')
    expect(entryOfSection('devices', false)).toBe('phone')
  })

  it('keeps the open section when the window crosses the phone breakpoint', () => {
    expect(routeAtWidth({ entry: 'phone' }, true)).toEqual({ entry: 'settings', section: 'devices' })
    expect(routeAtWidth({ entry: 'settings', section: 'devices' }, false)).toEqual({ entry: 'phone', section: 'devices' })
    expect(routeAtWidth({ entry: 'settings', section: 'plugins' }, true)).toEqual({ entry: 'settings', section: 'plugins' })
    expect(routeAtWidth({ entry: 'settings' }, true)).toEqual({ entry: 'settings' })
    expect(routeAtWidth({ entry: 'sessions' }, true)).toEqual({ entry: 'sessions' })
  })
})
