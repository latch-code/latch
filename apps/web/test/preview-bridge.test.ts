import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppBridgeMethod, AppShellMessage, PluginBuildDiagnostic, PluginPackageSummary } from '@latch/protocol'
import { createPreviewBridge, PREVIEW_TASKS } from '../src/plugin-pages/previewBridge.ts'
import { appPhase, diagnosticLine, handBackText, phaseMarks } from '../src/settings/NewAppCard.tsx'
import { joinDraft, handDraft, takeHandedDraft } from '../src/core/draftHandoff.ts'
import { fallbackVersion } from '../src/plugin-pages/model.ts'
import { reachLabel } from '../src/settings/PluginsSettings.tsx'

const INFO = { sdk: '1.0.0', appProtocol: 1, theme: 'light' as const, offline: false, canRun: false, harnesses: [], preview: true as const }

function bridge(capabilities = { 'tasks.read': true as const, 'tasks.start': { projects: 'any' as const }, storage: ['plugin' as const] }) {
  const sent: AppShellMessage[] = []
  const views: unknown[] = []
  const onPreviewOnly = vi.fn()
  const preview = createPreviewBridge({
    page: { pluginId: 'draft-app', appId: 'main', capabilities },
    info: () => INFO,
    send: message => sent.push(message),
    setView: state => views.push(state),
    onPreviewOnly,
  })
  let id = 0
  const call = async (method: AppBridgeMethod, params: unknown) => {
    const callId = ++id
    preview.call({ t: 'call', id: callId, method, params })
    await Promise.resolve()
    return sent.find(message => message.t === 'result' && message.id === callId)
  }
  return { preview, sent, views, onPreviewOnly, call }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the preview bridge', () => {
  it('never calls the Host, whatever the page asks', async () => {
    const fetch = vi.fn()
    const xhr = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('XMLHttpRequest', xhr)
    vi.stubGlobal('EventSource', xhr)
    const { call, onPreviewOnly } = bridge()
    const requestId = '00000000-0000-4000-8000-000000000001'
    const calls: Array<[AppBridgeMethod, unknown]> = [
      ['tasks.list', {}],
      ['tasks.subscribe', { filter: { limit: 2 } }],
      ['tasks.unsubscribe', { subscription: 1 }],
      ['tasks.start', { requestId, prompt: '开始' }],
      ['tasks.lookup', { requestId }],
      ['storage.list', { scope: 'plugin' }],
      ['storage.put', { scope: 'plugin', key: 'k', value: { a: 1 }, ifVersion: 0, requestId }],
      ['storage.get', { scope: 'plugin', key: 'k' }],
      ['storage.delete', { scope: 'plugin', key: 'k', ifVersion: 1, requestId }],
      ['storage.watch', {}],
      ['view.setState', { state: { open: true } }],
      ['nav.openSession', { sessionId: 'preview-1' }],
      ['diag.report', { message: 'hello' }],
    ]
    for (const [method, params] of calls) expect(await call(method, params), method).toBeDefined()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetch).not.toHaveBeenCalled()
    expect(xhr).not.toHaveBeenCalled()
    expect(onPreviewOnly).toHaveBeenCalledTimes(2)
  })

  it('lists samples, answers preview for starts, keeps storage in memory and checks the manifest’s capabilities', async () => {
    const { call, sent, views } = bridge()
    const list = await call('tasks.list', {})
    expect(list).toMatchObject({ ok: true })
    expect((list as { value: Array<{ title: string; harnessId: string }> }).value.map(task => task.title)).toEqual(
      PREVIEW_TASKS.map(task => task.title),
    )
    expect(await call('tasks.start', { requestId: '00000000-0000-4000-8000-000000000002', prompt: 'x' })).toMatchObject({
      ok: false,
      code: 'preview',
    })
    expect(await call('tasks.readReply', { sessionId: 'preview-1' })).toMatchObject({ ok: false, code: 'capability-denied' })
    expect(await call('storage.list', { scope: 'project:p1' })).toMatchObject({ ok: false, code: 'capability-denied' })
    expect(await call('storage.put', { scope: 'plugin', key: 'k', value: 1, ifVersion: 0 })).toMatchObject({
      ok: true,
      value: { version: 1 },
    })
    expect(await call('storage.put', { scope: 'plugin', key: 'k', value: 2, ifVersion: 0 })).toMatchObject({
      ok: false,
      code: 'invalid-input',
      version: 1,
    })
    expect(await call('storage.get', { scope: 'plugin', key: 'k' })).toMatchObject({
      ok: true,
      value: { document: { value: 1, version: 1 } },
    })
    await call('view.setState', { state: { scroll: 3 } })
    expect(views).toEqual([{ scroll: 3 }])
    await call('tasks.subscribe', {})
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sent.some(message => message.t === 'event' && message.name === 'tasks' && message.tasks.length === 3)).toBe(true)
  })

  it('uses the manifest’s preview sessions and forgets everything once disposed', async () => {
    const sent: AppShellMessage[] = []
    const preview = createPreviewBridge({
      page: { pluginId: 'p', appId: 'main', capabilities: { 'tasks.read': true } },
      tasks: [{ title: '样例', status: 'running', projectName: '项目' }],
      info: () => INFO,
      send: message => sent.push(message),
      setView: () => {},
      onPreviewOnly: () => {},
    })
    preview.call({ t: 'call', id: 1, method: 'tasks.list', params: {} })
    expect(sent[0]).toMatchObject({ ok: true, value: [{ title: '样例', running: true, projectName: '项目' }] })
    preview.dispose()
    preview.call({ t: 'call', id: 2, method: 'tasks.list', params: {} })
    expect(sent).toHaveLength(1)
  })
})

describe('the 新应用 card', () => {
  const record = (extra: Partial<PluginPackageSummary>): PluginPackageSummary => ({
    id: 'draft-app',
    name: '草稿应用',
    version: '0.1.0',
    description: '',
    revision: 'a'.repeat(64),
    enabled: false,
    trusted: true,
    capabilities: [],
    state: 'draft',
    ...extra,
  })
  const build = (status: 'ok' | 'failed') => ({
    id: 'bld_x',
    revision: 'a'.repeat(64),
    status,
    at: '2026-11-12T00:00:00.000Z',
    durationMs: 10,
    typeChecked: true,
    diagnostics: status === 'ok' ? 0 : 2,
    modules: [],
  })

  it('walks 草稿 › 构建 › 预览 › 应用 from the record and what is under way', () => {
    expect(appPhase(record({}), null)).toBe('draft')
    expect(appPhase(record({}), 'build')).toBe('building')
    expect(appPhase(record({ build: build('failed') }), null)).toBe('build-failed')
    expect(appPhase(record({ build: build('ok') }), null)).toBe('preview')
    expect(appPhase(record({ build: build('ok') }), 'apply')).toBe('confirm')
    expect(appPhase(record({ state: 'applied', build: build('ok') }), null)).toBe('applied')
    expect(phaseMarks('build-failed')).toEqual(['done', 'fail', '', ''])
    expect(phaseMarks('confirm')).toEqual(['done', 'done', 'done', 'wait'])
    expect(phaseMarks('applied')).toEqual(['done', 'done', 'done', 'done'])
  })

  it('hands the diagnostics back to the session’s draft without sending them', () => {
    const items: PluginBuildDiagnostic[] = [
      { tool: 'tsc', file: 'index.tsx', line: 42, column: 11, message: "TS2322: Type 'string' is not assignable to type 'number'." },
      { tool: 'build', message: '构建产物超过 2 MiB。' },
    ]
    expect(diagnosticLine(items[0]!)).toBe("index.tsx:42:11  TS2322: Type 'string' is not assignable to type 'number'.")
    const text = handBackText(items)
    expect(text).toContain('index.tsx:42:11')
    expect(text).toContain('构建产物超过 2 MiB。')
    handDraft('s1', text)
    expect(joinDraft('已有的话', takeHandedDraft('s1'))).toBe(`已有的话\n\n${text}`)
    expect(takeHandedDraft('s1')).toBeUndefined()
  })
})

describe('a new page version that will not open', () => {
  it('falls back once to the version this tab last drew, never to the same one', () => {
    const drawn = { revision: 'a'.repeat(64), bundleHash: 'b'.repeat(64) }
    expect(fallbackVersion(drawn, { revision: 'c'.repeat(64) }, false)).toEqual(drawn)
    expect(fallbackVersion(drawn, { revision: 'c'.repeat(64) }, true)).toBeUndefined()
    expect(fallbackVersion(drawn, { revision: drawn.revision }, false)).toBeUndefined()
    expect(fallbackVersion(null, { revision: 'c'.repeat(64) }, false)).toBeUndefined()
  })
})

describe('the installed list', () => {
  it('says what each package brings', () => {
    expect(reachLabel({ pages: 1, capabilities: [] })).toBe('页面 · 侧栏入口')
    expect(reachLabel({ capabilities: ['ui:notes'] })).toBe('面板 · 与页面同权')
    expect(reachLabel({ pages: 1, capabilities: ['tool:x'] })).toBe('代码 · 在 Mac 上运行')
    expect(reachLabel({ capabilities: ['skill:x'] })).toBeUndefined()
  })
})
