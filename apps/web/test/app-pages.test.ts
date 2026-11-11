import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AppShellMessage, AppSnapshot, AppSummary, TaskSummary } from '@latch/protocol'
import { appFrameCsp, readAppFrame } from '@latch/host/app-frame'
import { ApiError, ApiTimeoutError } from '../src/core/api.ts'
import { AppFrame, FRAME_ALLOW, frameSource, hostInfo, isFrameReady } from '../src/plugin-pages/AppFrame.tsx'
import { acceptFrameKey, openStep, appTasks, bridgeCode, frameShortcutAllowed, listedApps, originTitle } from '../src/plugin-pages/model.ts'
import { BRIDGE_LIMITS, createParentBridge, type ParentBridgeDeps } from '../src/plugin-pages/parentBridge.ts'
import { secureSurfaceOpen } from '../src/plugin-pages/secureCover.ts'
import { visibleEntries } from '../src/shell/routes.ts'
import { buildAppFrame } from '../vite.config.ts'

const PAGE: AppSummary & { bundleHash: string } = {
  pluginId: 'release-check',
  appId: 'main',
  title: '发布检查',
  pluginName: '发布检查',
  version: '1.0.0',
  revision: 'a'.repeat(64),
  capabilities: { 'tasks.read': true, 'tasks.start': { projects: 'any' }, 'tasks.readOwn': true, storage: ['plugin'] },
  dataVersion: 1,
  status: 'ready',
  bundleHash: 'b'.repeat(64),
}
const task = (extra: Partial<TaskSummary> = {}): TaskSummary => ({
  id: 's1',
  harnessId: 'standard',
  title: '检查',
  status: 'idle',
  updatedAt: '2026-11-12T00:00:00.000Z',
  cwd: '/Users/me/private/project',
  model: 'm',
  workspaceId: 'default',
  folders: [{ id: 'f', path: '/Users/me/private/project' }],
  ...extra,
})
const snapshot = (tasks: TaskSummary[], extra: Partial<AppSnapshot> = {}) =>
  ({
    tasks,
    approvals: [],
    device: { id: 'd', scopes: ['view', 'run'], dataScope: 'all' },
    catalog: { workspaces: [{ id: 'default', name: '默认项目', path: '/Users/me/private/project' }] },
    apps: [PAGE],
    ...extra,
  }) as unknown as AppSnapshot

function bridge(overrides: Partial<ParentBridgeDeps> = {}) {
  const sent: AppShellMessage[] = []
  let online = true
  let current = snapshot([task()])
  const api = vi.fn(async (_path: string, _options?: unknown): Promise<unknown> => ({}))
  const deps: ParentBridgeDeps = {
    page: PAGE,
    snapshot: () => current,
    online: () => online,
    info: () => hostInfo('light', online, true),
    api: api as ParentBridgeDeps['api'],
    send: message => sent.push(message),
    openSession: vi.fn(),
    setView: vi.fn(),
    ...overrides,
  }
  const parent = createParentBridge(deps)
  let id = 0
  const call = async (method: string, params: unknown) => {
    const before = sent.length
    parent.call({ t: 'call', id: ++id, method: method as never, params })
    await vi.waitFor(() => {
      expect(sent.slice(before).some(message => message.t === 'result' && message.id === id)).toBe(true)
    })
    return sent.slice(before).find(message => message.t === 'result' && message.id === id) as Extract<AppShellMessage, { t: 'result' }>
  }
  return {
    parent,
    sent,
    api,
    call,
    setOnline(value: boolean) {
      online = value
      parent.update()
    },
    setSnapshot(value: AppSnapshot) {
      current = value
      parent.update()
    },
  }
}

describe('the page frame element', () => {
  it('is an opaque frame of the fixed runtime with no features of the browser and inert while covered', () => {
    const html = renderToStaticMarkup(
      createElement(AppFrame, {
        page: PAGE,
        snapshot: snapshot([]),
        online: true,
        info: hostInfo('light', true, true),
        covered: true,
        onOutcome: () => {},
        onOpenSession: () => {},
        onShortcut: () => {},
        onEscape: () => {},
      }),
    )
    expect(html).toMatch(/sandbox="allow-scripts"/u)
    expect(html).not.toContain('allow-same-origin')
    expect(html).toMatch(/src="\/link\/app-frame\/runtime\.html#nonce=[a-f0-9]{32}"/u)
    expect(html).toContain('referrerPolicy="no-referrer"')
    expect(html).toContain('inert=""')
    for (const feature of ['fullscreen', 'camera', 'microphone', 'clipboard-read', 'clipboard-write', 'display-capture'])
      expect(FRAME_ALLOW).toContain(`${feature} 'none'`)
    expect(frameSource('c'.repeat(32), true)).toBe(`latch-frame://app/runtime.html#nonce=${'c'.repeat(32)}`)
    const open = renderToStaticMarkup(
      createElement(AppFrame, {
        page: PAGE,
        snapshot: snapshot([]),
        online: true,
        info: hostInfo('light', true, true),
        covered: false,
        onOutcome: () => {},
        onOpenSession: () => {},
        onShortcut: () => {},
        onEscape: () => {},
      }),
    )
    expect(open).not.toContain('inert')
  })

  it('accepts ready only from its own frame, from an opaque origin, with its nonce and nothing else', () => {
    const frame = {}
    const nonce = 'd'.repeat(32)
    const ready = { type: 'ready', protocol: 1, nonce }
    expect(isFrameReady({ source: frame as never, origin: 'null', data: ready }, frame, nonce)).toBe(true)
    expect(isFrameReady({ source: {} as never, origin: 'null', data: ready }, frame, nonce)).toBe(false)
    expect(isFrameReady({ source: frame as never, origin: 'http://127.0.0.1:4317', data: ready }, frame, nonce)).toBe(false)
    expect(isFrameReady({ source: frame as never, origin: 'null', data: { ...ready, nonce: 'e'.repeat(32) } }, frame, nonce)).toBe(false)
    expect(isFrameReady({ source: frame as never, origin: 'null', data: { ...ready, extra: 1 } }, frame, nonce)).toBe(false)
    expect(isFrameReady({ source: frame as never, origin: 'null', data: { ...ready, protocol: 2 } }, frame, nonce)).toBe(false)
    expect(isFrameReady({ source: null, origin: 'null', data: ready }, null, nonce)).toBe(false)
  })

  it('goes inert for a security surface, a dialog or a toast on screen, but not for one behind an inert part', () => {
    const element = (inert: boolean, shown = true) => ({
      closest: (selector: string) => (selector === '[inert]' && inert ? {} : null),
      getClientRects: () => ({ length: shown ? 1 : 0 }),
    })
    expect(secureSurfaceOpen({ querySelectorAll: () => [] })).toBe(false)
    expect(secureSurfaceOpen({ querySelectorAll: () => [element(false)] })).toBe(true)
    expect(secureSurfaceOpen({ querySelectorAll: () => [element(true)] })).toBe(false)
    expect(secureSurfaceOpen({ querySelectorAll: () => [element(false, false)] })).toBe(false)
    const asked: string[] = []
    secureSurfaceOpen({
      querySelectorAll: selector => {
        asked.push(selector)
        return []
      },
    })
    expect(asked[0]).toContain('[data-secure]')
    expect(asked[0]).toContain('dialog[open]')
    expect(asked[0]).toContain('.ui-toast')
  })
})

describe('the runtime build', () => {
  it('is reproducible, and the script hash in its policy is the hash of the one script in the file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-runtime-'))
    try {
      await buildAppFrame(join(root, 'a', 'app-frame'))
      await buildAppFrame(join(root, 'b', 'app-frame'))
      const first = await readFile(join(root, 'a', 'app-frame', 'runtime.html'))
      expect((await readFile(join(root, 'b', 'app-frame', 'runtime.html'))).equals(first)).toBe(true)
      const frame = await readAppFrame(join(root, 'a'))
      expect(frame.csp).toBe(appFrameCsp(frame.hash))
      expect(first.toString('utf8').match(/<script>[\s\S]*?<\/script>/gu)).toHaveLength(1)
      expect(JSON.parse(await readFile(join(root, 'a', 'app-frame', 'runtime.json'), 'utf8'))).toEqual({
        file: 'runtime.html',
        scriptHash: frame.hash,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('the parent bridge', () => {
  it('gives the page only the whitelisted session fields, never a private session or a path', async () => {
    const { call } = bridge({
      snapshot: () =>
        snapshot([
          task({ origin: { app: 'release-check/main', requestId: 'r' } }),
          task({ id: 'private', agentPrivate: true }),
          task({ id: 'agent', agent: { id: 'a', name: 'A' } as never }),
          task({ id: 'archived', archived: true }),
        ]),
    })
    const result = await call('tasks.list', { filter: {} })
    expect(result.ok).toBe(true)
    const tasks = (result as { value: Array<Record<string, unknown>> }).value
    expect(tasks.map(item => item.id)).toEqual(['s1'])
    expect(Object.keys(tasks[0]!).sort()).toEqual([
      'harnessId',
      'id',
      'originApp',
      'projectId',
      'projectName',
      'running',
      'status',
      'title',
      'updatedAt',
    ])
    expect(JSON.stringify(tasks)).not.toContain('/Users/me')
  })

  it('answers a call the manifest does not declare with capability-denied and never asks the Host', async () => {
    const { call, api } = bridge()
    expect(await call('tasks.continue', { sessionId: 's1', requestId: crypto.randomUUID(), prompt: 'x' })).toMatchObject({
      ok: false,
      code: 'capability-denied',
    })
    expect(await call('storage.list', { scope: 'project:default' })).toMatchObject({ ok: false, code: 'capability-denied' })
    expect(api).not.toHaveBeenCalled()
  })

  it('adds via to what it asks the Host and strips what comes back to the listed fields', async () => {
    const api = vi.fn(async (path: string, _options?: unknown): Promise<unknown> => {
      if (path.includes('last-reply'))
        return { sessionId: 's1', status: 'idle', reply: { messageId: 'm', text: '好了', secret: 'x' }, cwd: '/Users/me' }
      if (path.startsWith('apps/release-check/data/plugin/'))
        return { document: { scope: 'plugin', key: 'k', version: 2, value: 1, updatedAt: 't', owner: 'x' } }
      return { sessionId: 's2', cwd: '/Users/me' }
    })
    const { call } = bridge({ api: api as ParentBridgeDeps['api'] })
    const requestId = crypto.randomUUID()
    expect(await call('tasks.start', { requestId, prompt: '检查', projectId: 'default' })).toMatchObject({
      ok: true,
      value: { sessionId: 's2' },
    })
    expect(api.mock.calls[0]).toEqual([
      'tasks',
      expect.objectContaining({
        method: 'POST',
        body: { via: { app: 'release-check/main', revision: PAGE.revision }, requestId, prompt: '检查', workspaceId: 'default' },
      }),
    ])
    const reply = await call('tasks.readReply', { sessionId: 's1' })
    expect((reply as { value: unknown }).value).toEqual({ sessionId: 's1', status: 'idle', reply: { messageId: 'm', text: '好了' } })
    const document = await call('storage.get', { scope: 'plugin', key: 'k' })
    expect((document as { value: unknown }).value).toEqual({
      document: { scope: 'plugin', key: 'k', version: 2, value: 1, updatedAt: 't' },
    })
  })

  it('maps the Host to the seven codes and keeps the request ID of an unknown result', async () => {
    expect(bridgeCode(new ApiError(403, 'app-capability-denied', 'x'))).toBe('capability-denied')
    expect(bridgeCode(new ApiError(409, 'app-revision-stale', 'x'))).toBe('capability-denied')
    expect(bridgeCode(new ApiError(409, 'app-disabled', 'x'))).toBe('capability-denied')
    expect(bridgeCode(new ApiError(403, 'scope-required', 'x'))).toBe('forbidden')
    expect(bridgeCode(new ApiError(403, 'native-verification-required', 'x'))).toBe('forbidden')
    expect(bridgeCode(new ApiError(429, 'app-rate-limited', 'x'))).toBe('rate-limited')
    expect(bridgeCode(new ApiError(400, 'invalid-input', 'x'))).toBe('invalid-input')
    expect(bridgeCode(new ApiError(404, 'app-not-found', 'x'))).toBe('not-found')
    expect(bridgeCode(new ApiError(503, 'app-origin-unknown', 'x'))).toBe('unknown')
    expect(bridgeCode(new ApiTimeoutError())).toBe('unknown')
    expect(bridgeCode(new TypeError('Failed to fetch'))).toBe('unknown')
    const { call } = bridge({
      api: (async () => {
        throw new ApiError(503, 'app-origin-unknown', 'Host 原文')
      }) as ParentBridgeDeps['api'],
    })
    const requestId = crypto.randomUUID()
    const failed = await call('tasks.start', { requestId, prompt: 'x' })
    expect(failed).toEqual({ t: 'result', id: 1, ok: false, code: 'unknown', requestId })
    expect(JSON.stringify(failed)).not.toContain('Host 原文')
  })

  it('refuses before the Host: bad input, a device without run, offline, and past the per-minute limit', async () => {
    const { call, api, setOnline } = bridge()
    expect(await call('tasks.start', { requestId: 'not-a-uuid', prompt: 'x' })).toMatchObject({ code: 'invalid-input' })
    expect(await call('tasks.start', { requestId: crypto.randomUUID(), prompt: 'x', extra: 1 })).toMatchObject({ code: 'invalid-input' })
    for (let index = 0; index < BRIDGE_LIMITS.starts; index++)
      expect(await call('tasks.start', { requestId: crypto.randomUUID(), prompt: 'x' })).toMatchObject({ ok: true })
    expect(await call('tasks.start', { requestId: crypto.randomUUID(), prompt: 'x' })).toMatchObject({ code: 'rate-limited' })
    expect(api).toHaveBeenCalledTimes(BRIDGE_LIMITS.starts)
    setOnline(false)
    expect(await call('tasks.readReply', { sessionId: 's1' })).toMatchObject({ code: 'offline' })
    const viewer = bridge({ snapshot: () => snapshot([], { device: { id: 'd', scopes: ['view'], dataScope: 'all' } as never }) })
    expect(await viewer.call('tasks.start', { requestId: crypto.randomUUID(), prompt: 'x' })).toMatchObject({ code: 'forbidden' })
    expect(await viewer.call('nav.openSession', { sessionId: 'missing' })).toMatchObject({ code: 'not-found' })
  })

  it('announces offline once, and sends one full list once the shell is back', async () => {
    const { call, sent, setOnline, setSnapshot } = bridge()
    const { value } = (await call('tasks.subscribe', { filter: {} })) as { value: { subscription: number } }
    const events = () =>
      sent.filter((message): message is Extract<AppShellMessage, { name: 'tasks' }> => message.t === 'event' && message.name === 'tasks')
    await vi.waitFor(() => {
      expect(events()).toHaveLength(1)
    })
    expect(events()[0]).toMatchObject({ subscription: value.subscription, offline: false })
    setOnline(false)
    setOnline(false)
    setSnapshot(snapshot([task(), task({ id: 's2' })]))
    expect(events()).toHaveLength(2)
    expect(events()[1]).toMatchObject({ offline: true, tasks: [{ id: 's1' }] })
    setOnline(true)
    expect(events()).toHaveLength(3)
    expect(events()[2]).toMatchObject({ offline: false })
    expect(
      events()[2]!
        .tasks.map(item => item.id)
        .sort(),
    ).toEqual(['s1', 's2'])
    // An unchanged list is not sent again.
    setSnapshot(snapshot([task(), task({ id: 's2' })]))
    expect(events()).toHaveLength(3)
  })

  it('sends the current list right after the reply that names the subscription, with sessions already there', async () => {
    const { call, sent } = bridge({ snapshot: () => snapshot([task(), task({ id: 's2' })]) })
    const reply = await call('tasks.subscribe', { filter: {} })
    const subscription = (reply as { value: { subscription: number } }).value.subscription
    const replyAt = sent.indexOf(reply)
    const first = sent.findIndex(message => message.t === 'event' && message.name === 'tasks')
    expect(first).toBeGreaterThan(replyAt)
    expect(sent[first]).toMatchObject({ subscription, offline: false, tasks: [{ id: 's1' }, { id: 's2' }] })
  })

  it('opens a session only at a gesture and never while the shell covers the frame', async () => {
    const open = vi.fn()
    let covered = false
    let activated = true
    const { call } = bridge({ openSession: open, covered: () => covered, activated: () => activated })
    expect(await call('nav.openSession', { sessionId: 's1' })).toMatchObject({ ok: true })
    covered = true
    expect(await call('nav.openSession', { sessionId: 's1' })).toMatchObject({ ok: false, code: 'forbidden' })
    covered = false
    activated = false
    expect(await call('nav.openSession', { sessionId: 's1' })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('never takes the person to a session that waits for them: an approval or a question', async () => {
    const open = vi.fn()
    let current = snapshot([
      task({ id: 'asks', status: 'waiting-approval' }),
      task({ id: 'question', status: 'running', pendingQuestions: 1 }),
    ])
    const { call, api } = bridge({ openSession: open, snapshot: () => current })
    for (const sessionId of ['asks', 'question'])
      expect(await call('nav.openSession', { sessionId })).toMatchObject({ ok: false, code: 'forbidden' })
    current = snapshot([task({ id: 'idle' })], { approvals: [{ id: 'a', sessionId: 'idle' }] as never })
    expect(await call('nav.openSession', { sessionId: 'idle' })).toMatchObject({ ok: false, code: 'forbidden' })
    expect(open).not.toHaveBeenCalled()
    expect(api.mock.calls.at(-1)?.[1]).toMatchObject({ body: { source: 'bridge', message: '等你处理的会话请从列表打开' } })
    current = snapshot([task({ id: 'idle' })])
    expect(await call('nav.openSession', { sessionId: 'idle' })).toMatchObject({ ok: true })
  })

  it('keeps only JSON view state', async () => {
    const setView = vi.fn()
    const { call } = bridge({ setView })
    await call('view.setState', { state: { at: new Date(0), open: ['a'] } })
    expect(setView).toHaveBeenLastCalledWith({ at: '1970-01-01T00:00:00.000Z', open: ['a'] })
    expect(await call('view.setState', { state: 'x'.repeat(70 * 1024) })).toMatchObject({ code: 'invalid-input' })
  })

  it('sends nothing more once disposed: no results, no lists, no storage changes', async () => {
    const { parent, call, sent, setSnapshot } = bridge()
    await call('tasks.subscribe', { filter: {} })
    await call('storage.watch', {})
    const before = sent.length
    parent.dispose()
    parent.call({ t: 'call', id: 99, method: 'tasks.list', params: { filter: {} } })
    setSnapshot(snapshot([task({ id: 'later' })]))
    parent.dataChanged({ pluginId: PAGE.pluginId, scope: 'plugin', key: 'k', version: 3 })
    parent.hostChanged()
    await new Promise(done => setTimeout(done, 10))
    expect(sent.length).toBe(before)
  })

  it('passes on only the storage changes of its own plugin, in the scopes it declares', async () => {
    const { parent, call, sent } = bridge()
    await call('storage.watch', {})
    parent.dataChanged({ pluginId: 'other', scope: 'plugin', key: 'k', version: 1 })
    parent.dataChanged({ pluginId: PAGE.pluginId, scope: 'project:default', key: 'k', version: 1 })
    parent.dataChanged({ pluginId: PAGE.pluginId, scope: 'plugin', key: 'k', version: 2 })
    expect(sent.filter(message => message.t === 'event')).toEqual([{ t: 'event', name: 'storage', scope: 'plugin', key: 'k', version: 2 }])
  })
})

describe('keys from a frame', () => {
  it('takes them only while the frame has the focus, uncovered and not migrating; Cmd/Ctrl only at a fresh gesture', () => {
    const base = { key: 'n', covered: false, migrating: false, focused: true, activated: true }
    expect(acceptFrameKey(base)).toBe(true)
    expect(acceptFrameKey({ ...base, activated: false })).toBe(false)
    expect(acceptFrameKey({ ...base, focused: false })).toBe(false)
    expect(acceptFrameKey({ ...base, covered: true })).toBe(false)
    expect(acceptFrameKey({ ...base, migrating: true })).toBe(false)
    expect(acceptFrameKey({ ...base, key: 'Escape', activated: false })).toBe(true)
    expect(acceptFrameKey({ ...base, key: 'Escape', covered: true })).toBe(false)
  })

  it('runs only shortcuts that move between places, never one that focuses a field', () => {
    for (const action of ['sidebar', 'settings']) expect(frameShortcutAllowed(action)).toBe(true)
    for (const action of ['new', 'compose', 'file-search', 'files', 'shortcuts', 'next', 'previous', 'changes', 'side-panel', null])
      expect(frameShortcutAllowed(action)).toBe(false)
    expect(frameShortcutAllowed({ kind: 'session', index: 1 })).toBe(false)
  })
})

describe('opening a page', () => {
  it('stops after three failures in a row even when the page drew in between', () => {
    let failures = 0
    const steps: string[] = []
    for (const outcome of ['failed', 'ready', 'failed', 'ready', 'failed', 'ready'] as const) {
      const step = openStep(failures, outcome)
      failures = step.failures
      steps.push(step.next)
    }
    expect(steps).toEqual(['retry', 'ready', 'retry', 'ready', 'give-up', 'ready'])
    expect(failures).toBe(3)
  })
})

describe('the shell around pages', () => {
  it('lists only pages that are not disabled, shows 应用 only when there are some, and names where a session came from', () => {
    const disabled = { ...PAGE, appId: 'off', status: 'disabled' as const }
    const current = snapshot([], { apps: [PAGE, disabled] })
    expect(listedApps(current).map(page => page.appId)).toEqual(['main'])
    expect(visibleEntries([], true, true, true)).toEqual(['sessions', 'agents', 'apps'])
    expect(visibleEntries([], true, false, false)).toEqual(['sessions'])
    expect(originTitle(task({ origin: { app: 'release-check/main', requestId: 'r' } }), current)).toBe('发布检查')
    expect(originTitle(task({ origin: { app: 'gone/main', requestId: 'r' } }), current)).toBe('插件页面')
    expect(originTitle(task(), current)).toBeUndefined()
    expect(appTasks(current, { mine: true }, PAGE)).toEqual([])
  })
})
