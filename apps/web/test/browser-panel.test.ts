import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserTabState } from '../src/core/shell.ts'
import { shellBrowser } from '../src/core/shell.ts'
import { panelChoices } from '../src/panel/panelTabs.ts'
import {
  RETRY_FOR_MS,
  consoleLine,
  cropBox,
  networkLine,
  pointInside,
  endedTabs,
  elementDraft,
  footerParts,
  imageName,
  logsDraft,
  noticeText,
  placeView,
  presetCaption,
  redactText,
  safeAreaHint,
  refusalText,
  tabTitle,
  troubleOf,
  withEvent,
  withRecent,
  withState,
  type KnownTab,
} from '../src/panel/browser/model.ts'
import { workbenchShortcut } from '../src/workbenchShortcuts.ts'

const state = (patch: Partial<BrowserTabState> = {}): BrowserTabState => ({
  url: 'http://localhost:5173/',
  title: 'Vite App',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  zoom: 1,
  crashed: false,
  error: null,
  viewport: { preset: 'fit', rotated: false },
  colorScheme: 'system',
  logs: { errors: 0, warnings: 0, failed: 0 },
  ...patch,
})
const tab = (patch: Partial<BrowserTabState> = {}, extra: Partial<KnownTab> = {}): KnownTab => ({
  tabId: `brw_${'a'.repeat(22)}`,
  sessionId: 'ses_one',
  projectId: 'alpha',
  state: state(patch),
  ...extra,
})

/** A model-service key's shape, spelled apart for the repository's secret scan. */
const KEY = ['sk', '-ant-0123456789abcdefghijklmnop'].join('')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the 浏览器 tab is only where the desktop app can keep tabs for a session', () => {
  it('takes latchShell.browser from version 2 on, never from another computer’s page or an older shell', () => {
    const browser = { protocolVersion: 2, list: () => {}, open: () => {}, subscribe: () => {} }
    vi.stubGlobal('window', { latchShell: { kind: 'electron', browser } })
    expect(shellBrowser()).toBe(browser)
    vi.stubGlobal('window', { latchShell: { kind: 'electron', browser: { ...browser, protocolVersion: 1 } } })
    expect(shellBrowser()).toBeNull()
    vi.stubGlobal('window', { latchShell: { kind: 'electron', remote: true, browser } })
    expect(shellBrowser()).toBeNull()
    vi.stubGlobal('window', {})
    expect(shellBrowser()).toBeNull()
  })

  it('leads the panel’s 「+」 with B, and ⇧⌘B only in the desktop app', () => {
    expect(panelChoices({ changes: true, browser: true, delivery: true }).map(row => [row.label, row.letter])).toEqual([
      ['浏览器', 'B'],
      ['改动', 'D'],
      ['交付', 'P'],
    ])
    const stroke = { code: 'KeyB', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }
    expect(workbenchShortcut(stroke, true)).toBe('browser')
    expect(workbenchShortcut({ ...stroke, metaKey: false, altKey: true }, false)).toBe('side-panel')
    expect(workbenchShortcut({ ...stroke, shiftKey: false }, true)).toBe('sidebar')
  })
})

describe('browser panel state', () => {
  it('names a tab by its title, else where it is, else 新标签', () => {
    expect(tabTitle(state())).toBe('Vite App')
    expect(tabTitle(state({ title: 'http://localhost:5173/' }))).toBe('localhost:5173')
    expect(tabTitle(state({ title: '', url: '' }))).toBe('新标签')
    expect(tabTitle(undefined)).toBe('新标签')
  })

  it('follows main’s events: a state replaces the tab’s, a closed tab goes, an unknown tab is not invented', () => {
    const one = tab()
    const two = tab({}, { tabId: `brw_${'b'.repeat(22)}` })
    const next = withEvent([one, two], { type: 'state', tabId: one.tabId, state: state({ title: '设置' }) }, 0)
    expect(next.map(item => item.state.title)).toEqual(['设置', 'Vite App'])
    expect(withEvent(next, { type: 'closed', tabId: one.tabId }, 0)).toEqual([two])
    expect(withEvent([two], { type: 'state', tabId: `brw_${'c'.repeat(22)}`, state: state() }, 0)).toEqual([two])
  })

  it('waits for a local dev server that refuses the connection for a minute, retrying, then says why it failed', () => {
    let current = withState(tab(), state({ error: -102 }), 1_000)
    expect(current.refusedSince).toBe(1_000)
    expect(troubleOf(current, 1_000)).toEqual({ kind: 'waiting', host: 'localhost:5173' })
    // The retry's own load keeps the wait, and a refusal again keeps when it started.
    current = withState(current, state({ loading: true }), 3_000)
    expect(troubleOf(current, 3_000)).toEqual({ kind: 'waiting', host: 'localhost:5173' })
    current = withState(current, state({ error: -102 }), 3_100)
    expect(current.refusedSince).toBe(1_000)
    expect(troubleOf(current, 1_000 + RETRY_FOR_MS)).toEqual({ kind: 'failed', host: 'localhost:5173', reason: 'ERR_CONNECTION_REFUSED' })
    // The server answers: the page shows.
    current = withState(current, state(), 9_000)
    expect(current.refusedSince).toBeUndefined()
    expect(troubleOf(current, 9_000)).toBeNull()
    // Not a local address, or another error: a failure at once, with Chromium's name for it.
    expect(troubleOf(withState(tab(), state({ url: 'https://example.com/', error: -102 }), 0), 0)).toMatchObject({ kind: 'failed' })
    expect(troubleOf(withState(tab(), state({ error: -105 }), 0), 0)).toEqual({
      kind: 'failed',
      host: 'localhost:5173',
      reason: 'ERR_NAME_NOT_RESOLVED',
    })
    expect(troubleOf(withState(tab(), state({ crashed: true }), 0), 0)).toEqual({ kind: 'crashed' })
    expect(troubleOf(withState(tab(), state({ loading: true }), 0), 0)).toBeNull()
  })

  it('fits a preset into the canvas without enlarging it, centered above its caption', () => {
    const canvas = { x: 600, y: 100, width: 432, height: 600 }
    expect(placeView(canvas, 'fit', true)).toEqual({ rect: canvas, scale: 1, size: null })
    const phone = placeView(canvas, 'phone', false)
    expect(phone.size).toEqual({ width: 390, height: 844 })
    // 16 around it, a 10 bezel and 24 for the caption: the height decides.
    expect(phone.scale).toBeCloseTo(524 / 844, 5)
    expect(phone.rect).toEqual({ x: 600 + Math.round((432 - 242) / 2), y: 126, width: 242, height: 524 })
    expect(placeView(canvas, 'tablet', false).rect.y).toBeGreaterThanOrEqual(116)
    const turned = placeView({ x: 0, y: 0, width: 2000, height: 2000 }, 'phone', true)
    expect(turned).toMatchObject({ scale: 1, size: { width: 844, height: 390 }, rect: { width: 844, height: 390 } })
    expect(presetCaption({ width: 390, height: 844 }, 0.75)).toBe('390 × 844 · 75%')
    expect(presetCaption({ width: 390, height: 844 }, 0.75, 3)).toBe('390 × 844 @3x · 75%')
    expect(safeAreaHint('phone', false, 0.5)).toEqual({ side: 'vertical', start: 24, end: 17 })
    expect(safeAreaHint('phone-large', true, 1)).toEqual({ side: 'horizontal', start: 62, end: 34 })
    expect(safeAreaHint('tablet', false, 1)).toBeUndefined()
  })

  it('writes the bottom row in tones: red only for errors and failed requests, amber only for warnings', () => {
    expect(footerParts({ errors: 0, warnings: 0, failed: 0 })).toEqual([{ text: '控制台' }, { text: '网络' }])
    expect(footerParts({ errors: 2, warnings: 1, failed: 1 })).toEqual([
      { text: '控制台' },
      { text: '2 个错误', tone: 'error' },
      { text: '1 个警告', tone: 'warn' },
      { text: '网络' },
      { text: '1 个失败', tone: 'error' },
    ])
  })

  it('says in a few words what main refused', () => {
    expect(noticeText('download')).toBe('页面想下载文件，已拦下')
    expect(noticeText('navigation', 'host')).toBe('页面想访问 Latch，已拦下')
    expect(refusalText('blocked', 'host')).toBe('不能在这里打开 Latch 自己的地址')
    expect(refusalText('tab-limit')).toBe('最多 8 个标签')
  })
})

describe('what the 浏览器 tab puts into the draft', () => {
  it('quotes a picked element as what the page presents: page, selector, tag, words and size, redacted', () => {
    const draft = elementDraft({
      url: `http://localhost:5173/settings?${['to', 'ken=abc'].join('')}`,
      tag: 'button',
      selector: '#save',
      text: `保存 ${KEY}`,
      rect: { x: 1, y: 2, width: 120.4, height: 32 },
    })
    expect(draft.redacted).toBe(true)
    expect(draft.text).toContain('元素 · button「保存 [已隐藏]」（页面提供的内容）')
    expect(draft.text).toContain('页面：localhost:5173/settings')
    expect(draft.text).toContain('选择器：#save')
    expect(draft.text).toContain('尺寸：120 × 32')
    expect(draft.text).not.toContain('token')
    expect(draft.text).not.toContain('sk-ant-')
  })

  it('adds the chosen entries, or the latest errors, as a fenced block marked as the page’s, redacted', () => {
    const console = [
      { id: 7, level: 'info' as const, text: 'ready', source: '', line: 0, time: 0 },
      {
        id: 8,
        level: 'error' as const,
        text: `boom ${['gh', 'p_0123456789abcdefghijklmnopqrstuvwxyz01'].join('')}`,
        source: 'http://localhost:5173/app.ts',
        line: 3,
        time: 0,
      },
    ]
    const network = [
      { id: 3, method: 'GET', url: 'http://localhost:5173/', type: 'mainFrame', status: 200, error: null, duration: 5, size: 10, time: 0 },
      { id: 4, method: 'POST', url: 'http://localhost:5173/api', type: 'xhr', status: 500, error: null, duration: 40, size: null, time: 0 },
    ]
    const errors = logsDraft({ kind: 'console', page: 'localhost:5173', console, network, selected: [] })!
    expect(errors.text.split('\n')[0]).toBe('浏览器控制台 · localhost:5173（页面提供的内容）')
    expect(errors.text).toContain('[error] boom [已隐藏] (http://localhost:5173/app.ts:3)')
    expect(errors.text).not.toContain('ready')
    expect(errors.redacted).toBe(true)
    // Chosen by main's sequence ID: entries that arrived since (and the oldest leaving) do not change the choice.
    const later = [...console.slice(1), { id: 9, level: 'info' as const, text: 'newer', source: '', line: 0, time: 0 }]
    const chosen = logsDraft({ kind: 'console', page: 'x', console: later, network, selected: [8] })!.text
    expect(chosen).toContain('[error] boom')
    expect(chosen).not.toContain('newer')
    expect(logsDraft({ kind: 'console', page: 'x', console, network, selected: [7] })!.text).toContain('[info] ready')
    expect(logsDraft({ kind: 'console', page: 'x', console: later, network, selected: [7] })).toBeUndefined()
    expect(logsDraft({ kind: 'network', page: 'x', console, network, selected: [] })!.text).toContain(
      'POST http://localhost:5173/api 500 40 ms —',
    )
    expect(logsDraft({ kind: 'console', page: 'x', console: console.slice(0, 1), network, selected: [] })).toBeUndefined()
  })

  it('shows hidden characters as visible escapes, the same in the drawer and the draft, heading included', () => {
    const tag = String.fromCodePoint(0xe0041)
    const sneaky = `保\u00ad存\u200b${tag}\ufe0f设置`
    const line = consoleLine({ id: 1, level: 'error', text: `x${'\u202e'}y\nnext`, source: '', line: 0, time: 0 })
    expect(line).toBe('[error] x\\u{202E}y\nnext')
    const draft = elementDraft({
      url: 'http://localhost:5173/',
      tag: 'button',
      selector: '#save',
      text: sneaky,
      rect: { x: 0, y: 0, width: 1, height: 1 },
    })
    for (const hidden of ['\u00ad', '\u200b', tag, '\ufe0f']) expect(draft.text).not.toContain(hidden)
    expect(draft.text.split('\n')[0]).toMatch(/^元素 · button「保\\u\{00AD\}存\\u\{200B\}\\u\{E00…」（页面提供的内容）$/u)
    expect(draft.text).toContain('文字：保\\u{00AD}存\\u{200B}\\u{E0041}\\u{FE0F}设置')
    expect(
      networkLine({ id: 1, method: 'GET', url: 'http://x/\u2066a', type: 'xhr', status: 200, error: null, duration: 1, size: 1, time: 0 }),
    ).toContain('http://x/\\u{2066}a')
    expect(pointInside({ x: 10, y: 10, width: 20, height: 20 }, { x: 31, y: 20 }, 2)).toBe(true)
    expect(pointInside({ x: 10, y: 10, width: 20, height: 20 }, { x: 40, y: 20 }, 2)).toBe(false)
  })

  it('names images for what they show, and crops from the frozen frame in its own pixels', () => {
    expect(imageName('截图', 'http://localhost:5173/settings?x=1')).toBe('截图-localhost-5173-settings.png')
    expect(imageName('元素', '')).toBe('元素-blank.png')
    expect(cropBox({ x: 10, y: 20, width: 50, height: 10 }, { width: 800, height: 600 }, 400)).toEqual({
      x: 4,
      y: 24,
      width: 132,
      height: 52,
    })
    expect(cropBox({ x: 390, y: 290, width: 50, height: 50 }, { width: 400, height: 300 }, 400)).toEqual({
      x: 382,
      y: 282,
      width: 18,
      height: 18,
    })
    expect(cropBox({ x: 0, y: 0, width: 1, height: 1 }, { width: 10, height: 10 }, 0)).toBeNull()
  })

  it('keeps five recent addresses per project, origin and path only', () => {
    let list: string[] = []
    for (const url of [
      'http://localhost:1/',
      'http://localhost:2/a?page=2',
      'http://localhost:3/',
      'http://localhost:4/',
      'http://localhost:5/',
    ])
      list = withRecent(list, url)
    list = withRecent(list, 'http://localhost:1/')
    list = withRecent(list, 'http://localhost:6/')
    expect(list).toEqual([
      'http://localhost:6/',
      'http://localhost:1/',
      'http://localhost:5/',
      'http://localhost:4/',
      'http://localhost:3/',
    ])
    expect(withRecent([], 'http://localhost:2/a?page=2')).toEqual(['http://localhost:2/a'])
    expect(withRecent(list, 'about:blank')).toEqual(list)
    expect(redactText('plain').redacted).toBe(false)
  })
})

describe('tabs of sessions that ended', () => {
  it('closes tabs of archived sessions, and of deleted ones only by a whole listing this device sees all of', () => {
    const tabs = [
      { tabId: 'brw_1', sessionId: 'live' },
      { tabId: 'brw_2', sessionId: 'archived' },
      { tabId: 'brw_3', sessionId: 'gone' },
    ]
    const tasks = [{ id: 'live' }, { id: 'archived', archived: true }]
    expect(endedTabs(tabs, { tasks, tasksComplete: true }, true)).toEqual(['brw_2', 'brw_3'])
    expect(endedTabs(tabs, { tasks }, true)).toEqual(['brw_2'])
    expect(endedTabs(tabs, { tasks, tasksComplete: true }, false)).toEqual(['brw_2'])
  })
})
