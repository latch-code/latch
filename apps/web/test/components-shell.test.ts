import { createElement } from 'react'
import { entryOfSection, routeAtWidth, visibleEntries } from '../src/shell/routes.ts'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskSummary } from '@latch/protocol'
import { scrollMovesAnchor } from '../src/components/overlays.tsx'
import { SessionHeader } from '../src/shell/ConversationHeader.tsx'

const noop = () => {}
afterEach(() => {
  vi.unstubAllGlobals()
})
const session = (extra: Partial<TaskSummary> = {}): TaskSummary => ({ id: 's', title: 't', status: 'idle', updatedAt: '', ...extra })

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
      const html = renderToStaticMarkup(createElement(SessionHeader, { ...topBar, connection: 'offline' as const, phone }))
      expect(html).toMatch(/<button[^>]*class="connection-pill connection-offline"[^>]*>离线<span class="connection-pill-retry">· 重试<svg/)
      expect(html).not.toContain('<i aria-hidden="true"></i>')
    }
    expect(renderToStaticMarkup(createElement(SessionHeader, topBar))).not.toContain('connection-pill')
  })

  it('names full access and leaves the default level, asking before each step, to the session details', () => {
    const full = renderToStaticMarkup(createElement(SessionHeader, { ...topBar, level: 'L3' }))
    expect(full).toMatch(
      /<span class="ui-status-word level-pill" data-tone="neutral" title="Agent 可以读写这台 Mac 上的文件并运行命令，不再询问"><svg[^>]*lucide-shield-alert[^>]*>.*<\/svg>完全访问<\/span>/,
    )
    const asking = renderToStaticMarkup(createElement(SessionHeader, { ...topBar, level: 'L1' }))
    expect(asking).not.toContain('需要时询问')
    expect(asking).not.toContain('level-pill')
  })

  it('shows the state only when it is not the default, and where the session runs', () => {
    const pill = (status: TaskSummary['status'], cancelling = false) =>
      /class="ui-status-word" data-tone="(\w+)">(?:<svg.*?<\/svg>)?([^<]+)</u
        .exec(renderToStaticMarkup(createElement(SessionHeader, { ...topBar, summary: session({ status }), cancelling })))
        ?.slice(1)
    expect(pill('running')).toBeUndefined()
    expect(pill('idle')).toBeUndefined()
    expect(pill('waiting-approval')).toBeUndefined()
    expect(pill('failed')).toEqual(['failed', '失败'])
    expect(pill('cancelled')).toEqual(['neutral', '已取消'])
    expect(pill('interrupted')).toEqual(['neutral', '已中断'])
    expect(pill('running', true)).toEqual(['neutral', '正在取消'])
    const html = renderToStaticMarkup(
      createElement(SessionHeader, {
        ...topBar,
        harness: { id: 'codex', name: 'Codex', source: 'acp' as const },
        project: 'latch-app',
      }),
    )
    expect(html).toContain('<span class="topbar-source-text">Codex</span>')
    expect(html).toContain('<span class="topbar-source-text">latch-app</span>')
    expect(html).toMatch(/<span class="topbar-source"[^>]*><span class="ui-tile"/)
  })

  it('heads a phone session page with the way back, the title over where it runs, and 会话信息', () => {
    const menu = [{ id: 'sync', items: [{ id: 'refresh', label: '同步最新状态', onSelect: noop }] }]
    const html = renderToStaticMarkup(
      createElement(SessionHeader, {
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
      /<div class="topbar-subline"><span class="topbar-source-text">Codex · latch-app<\/span><span class="ui-status-word" data-tone="failed"><svg[^>]*lucide-circle-alert[^>]*>.*?<\/svg>失败<\/span><span class="topbar-full-access"/u,
    )
    expect(html).toMatch(/<button[^>]*aria-label="会话信息"[^>]*>.*<\/header>$/)
    expect(html).not.toContain('新建会话')
    expect(html).not.toContain('aria-label="会话操作"')
  })

  it('keeps a phone page header for a session the Host has not listed yet, with no menu or 会话信息 until it does', () => {
    const menu = [{ id: 'sync', items: [{ id: 'refresh', label: '同步最新状态', onSelect: noop }] }]
    const html = renderToStaticMarkup(
      createElement(SessionHeader, {
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

describe('rail routes', () => {
  it('draws only the entries this device can use', () => {
    expect(visibleEntries(['general', 'about'], false)).toEqual(['sessions', 'settings'])
    expect(visibleEntries(['general', 'plugins', 'devices', 'routines'], false)).toEqual([
      'sessions',
      'automations',
      'plugins',
      'phone',
      'settings',
    ])
  })

  it('gives a phone three tabs, with 自动化 inside Agent and 插件 and 手机 inside 设置', () => {
    expect(visibleEntries(['general', 'plugins', 'devices', 'routines'], true)).toEqual(['sessions', 'agents', 'settings'])
    expect(entryOfSection('routines', true)).toBe('agents')
    expect(entryOfSection('routines', false)).toBe('automations')
    expect(entryOfSection('devices', true)).toBe('settings')
    expect(entryOfSection('devices', false)).toBe('phone')
  })

  it('keeps the open section when the window crosses the phone breakpoint', () => {
    expect(routeAtWidth({ entry: 'phone' }, true)).toEqual({ entry: 'settings', section: 'devices' })
    expect(routeAtWidth({ entry: 'settings', section: 'devices' }, false)).toEqual({ entry: 'phone', section: 'devices' })
    expect(routeAtWidth({ entry: 'automations' }, true)).toEqual({ entry: 'agents', section: 'routines' })
    expect(routeAtWidth({ entry: 'settings' }, true)).toEqual({ entry: 'settings' })
    expect(routeAtWidth({ entry: 'sessions' }, true)).toEqual({ entry: 'sessions' })
  })
})
