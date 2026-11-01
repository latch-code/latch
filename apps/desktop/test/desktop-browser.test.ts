import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)

interface Verdict {
  ok: boolean
  reason?: string
}
interface Image {
  type: string
  width: number
  height: number
  data: Uint8Array
}
type Result = { ok: true; [key: string]: unknown } | { ok: false; error: string; reason?: string }
interface Controller {
  owns(contents: unknown): boolean
  guard(contents: unknown): void
  blockHost(state: unknown): void
  attach(window: unknown): void
  open(input: { projectId: string; url: string | null }): Result & { tabId?: string }
  close(input: { tabId: string }): Result
  navigate(input: { tabId: string; url: string }): Result
  go(input: { tabId: string; action: string }): Result
  setBounds(input: { tabId: string; bounds: { x: number; y: number; width: number; height: number } | null }): Result
  occlude(input: { tabId: string; occluded: boolean }): Promise<Result>
  focus(input: { tabId: string }): Result
  capture(input: { tabId: string }): Promise<Result>
  annotate(input: { tabId: string; point: { x: number; y: number } }): Promise<Result>
  zoom(input: { tabId: string; direction: string }): Result
  devTools(input: { tabId: string }): Result
  clearData(input: { projectId: string }): Promise<Result>
  state(input: { tabId: string }): Result
}
const browser = require('../src/browser.cjs') as {
  PROTOCOL_VERSION: number
  CHANNELS: Record<string, string>
  TAB_LIMIT: number
  CAPTURE_LIMITS: { edge: number; bytes: number }
  ANNOTATION_WORLD: number
  INPUTS: Record<string, (input: unknown) => unknown>
  isPrivateHost(hostname: string): boolean
  isLoopbackHost(hostname: string): boolean
  reachesHost(url: URL, ports: ReadonlySet<number>): boolean
  addressUrl(text: unknown): string | undefined
  navigationVerdict(
    request: { url: string; kind: 'typed' | 'page' | 'redirect'; from?: string; gesture?: boolean; frame?: boolean },
    ports: ReadonlySet<number>,
  ): Verdict
  requestAllowed(details: { url: string; webContentsId?: number }, ports: ReadonlySet<number>, devTools: ReadonlySet<number>): boolean
  viewBounds(
    rect: { x: number; y: number; width: number; height: number },
    zoom: number,
    content: { width: number; height: number },
  ): { x: number; y: number; width: number; height: number } | null
  forwardedShortcut(input: Record<string, unknown>, platform: string): { keyCode: string; alt: boolean } | undefined
  encodeImage(image: FakeImage, limits: { edge: number; bytes: number }): Image | undefined
  withGuestPolicy(headers: Record<string, string | string[]> | undefined): Record<string, string | string[]>
  annotationOf(raw: unknown): { tag: string; selector: string; text: string; rect: object } | undefined
  annotationScript(x: number, y: number): string
  nextZoom(current: number, direction: string): number
  createPreviewBrowser(options: Record<string, unknown>): Controller
  handleBrowserRequests(options: {
    ipcMain: { handle(channel: string, handler: Handler): void }
    trusted(event: unknown): boolean
    controller: object
  }): void
}
type Handler = (event: unknown, input: unknown) => unknown
/** `latchShell.browser` as the page sees it; arguments are unknown, since the preload checks them. */
interface PreloadBrowser {
  protocolVersion: number
  open(projectId?: unknown, url?: unknown): Promise<unknown>
  close(tabId: unknown): Promise<unknown>
  navigate(tabId: unknown, url: unknown): Promise<unknown>
  back(tabId: unknown): Promise<unknown>
  forward(tabId: unknown): Promise<unknown>
  reload(tabId: unknown): Promise<unknown>
  stop(tabId: unknown): Promise<unknown>
  setBounds(tabId: unknown, bounds: unknown): Promise<unknown>
  occlude(tabId: unknown, occluded: unknown): Promise<unknown>
  focus(tabId: unknown): Promise<unknown>
  capture(tabId: unknown): Promise<unknown>
  annotate(tabId: unknown, point: unknown): Promise<unknown>
  zoom(tabId: unknown, direction: unknown): Promise<unknown>
  devTools(tabId: unknown): Promise<unknown>
  clearData(projectId: unknown): Promise<unknown>
  state(tabId: unknown): Promise<unknown>
  subscribe(callback: (event: unknown) => void): () => void
}

const HOST = `h-${'a'.repeat(52)}.localhost`
const PORTS = new Set([4317, 4318])

/** A PNG header of the given size, padded to `bytes`. */
function png(width: number, height: number, bytes = 64): Buffer {
  const data = Buffer.alloc(Math.max(24, bytes))
  data.writeUInt32BE(0x89504e47, 0)
  data.writeUInt32BE(0x0d0a1a0a, 4)
  data.writeUInt32BE(13, 8)
  data.write('IHDR', 12, 'latin1')
  data.writeUInt32BE(width, 16)
  data.writeUInt32BE(height, 20)
  return data
}

class FakeImage {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly bytes = 64,
  ) {}
  isEmpty() {
    return this.width === 0 || this.height === 0
  }
  getSize() {
    return { width: this.width, height: this.height }
  }
  resize({ width, height }: { width: number; height: number }) {
    return new FakeImage(width, height, Math.ceil((this.bytes * width * height) / (this.width * this.height)))
  }
  toPNG() {
    return png(this.width, this.height, this.bytes)
  }
}

class FakeSession extends EventEmitter {
  permissionRequest?: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void
  permissionCheck?: () => boolean
  devicePermission?: () => boolean
  beforeRequest?: (details: { url: string; webContentsId?: number }, callback: (response: { cancel: boolean }) => void) => void
  headersReceived?: (
    details: { resourceType: string; responseHeaders?: Record<string, string[]> },
    callback: (response: { responseHeaders?: Record<string, string | string[]> }) => void,
  ) => void
  spellChecker = true
  cleared: string[] = []
  webRequest = {
    onBeforeRequest: (listener: FakeSession['beforeRequest']) => {
      this.beforeRequest = listener
    },
    onHeadersReceived: (listener: FakeSession['headersReceived']) => {
      this.headersReceived = listener
    },
  }
  setPermissionRequestHandler(handler: FakeSession['permissionRequest']) {
    this.permissionRequest = handler
  }
  setPermissionCheckHandler(handler: () => boolean) {
    this.permissionCheck = handler
  }
  setDevicePermissionHandler(handler: () => boolean) {
    this.devicePermission = handler
  }
  setSpellCheckerEnabled(enabled: boolean) {
    this.spellChecker = enabled
  }
  async clearData() {
    this.cleared.push('data')
  }
  async clearCache() {
    this.cleared.push('cache')
  }
  async clearAuthCache() {
    this.cleared.push('auth')
  }
  async clearHostResolverCache() {
    this.cleared.push('hosts')
  }
  /** The headers a response of this type arrives with in the page; undefined when they are left as they came. */
  headers(resourceType: string, responseHeaders: Record<string, string[]>) {
    let answer: Record<string, string | string[]> | undefined
    this.headersReceived?.({ resourceType, responseHeaders }, response => {
      answer = response.responseHeaders
    })
    return answer
  }
  /** What the request filter answers for one request. */
  allows(url: string, webContentsId?: number): boolean {
    let cancel = true
    this.beforeRequest?.({ url, ...(webContentsId === undefined ? {} : { webContentsId }) }, response => {
      cancel = response.cancel
    })
    return !cancel
  }
}

let nextContentsId = 100
class FakeContents extends EventEmitter {
  readonly id = nextContentsId++
  type = 'window'
  url = ''
  title = ''
  destroyed = false
  focused = false
  zoom = 1
  loads: string[] = []
  sent: Array<[string, Record<string, unknown>]> = []
  inputs: unknown[] = []
  isolated: Array<{ world: number; code: string }> = []
  isolatedResult: unknown = null
  captures: unknown[] = []
  captureImage = new FakeImage(500, 400)
  policy?: string
  openHandler?: (details: Record<string, unknown>) => { action: string }
  devToolsOptions?: unknown
  devToolsWebContents: FakeContents | null = null
  devToolsOpen = false
  history = { back: 0, forward: 0, reload: 0, stop: 0 }
  mainFrame = { url: '', origin: '' }
  navigationHistory = {
    canGoBack: () => true,
    canGoForward: () => false,
    goBack: () => this.history.back++,
    goForward: () => this.history.forward++,
  }
  constructor(readonly session: FakeSession) {
    super()
  }
  getType() {
    return this.type
  }
  setWebRTCIPHandlingPolicy(policy: string) {
    this.policy = policy
  }
  setWindowOpenHandler(handler: FakeContents['openHandler']) {
    this.openHandler = handler
  }
  loadURL(url: string) {
    this.loads.push(url)
    this.url = url
    this.mainFrame.url = url
    return Promise.resolve()
  }
  getURL() {
    return this.url
  }
  getTitle() {
    return this.title
  }
  isLoading() {
    return false
  }
  isCrashed() {
    return false
  }
  isDestroyed() {
    return this.destroyed
  }
  close() {
    this.destroyed = true
    this.emit('destroyed')
  }
  focus() {
    this.focused = true
  }
  isFocused() {
    return this.focused
  }
  getZoomFactor() {
    return this.zoom
  }
  setZoomFactor(zoom: number) {
    this.zoom = zoom
  }
  reload() {
    this.history.reload++
  }
  stop() {
    this.history.stop++
  }
  capturePage(rect?: unknown) {
    this.captures.push(rect)
    return Promise.resolve(this.captureImage)
  }
  executeJavaScriptInIsolatedWorld(world: number, scripts: Array<{ code: string }>) {
    this.isolated.push({ world, code: scripts[0].code })
    return Promise.resolve(this.isolatedResult)
  }
  openDevTools(options: unknown) {
    this.devToolsOptions = options
    this.devToolsOpen = true
    this.devToolsWebContents = Object.assign(new FakeContents(this.session), { type: 'remote' })
  }
  isDevToolsOpened() {
    return this.devToolsOpen
  }
  closeDevTools() {
    this.devToolsOpen = false
  }
  sendInputEvent(input: unknown) {
    this.inputs.push(input)
  }
  send(channel: string, value: Record<string, unknown>) {
    this.sent.push([channel, value])
  }
}

class FakeView {
  static onCreate?: (contents: FakeContents) => void
  readonly webContents: FakeContents
  bounds = { x: 0, y: 0, width: 0, height: 0 }
  visible = true
  constructor(readonly options: { webPreferences: { session: FakeSession } & Record<string, unknown> }) {
    this.webContents = new FakeContents(options.webPreferences.session)
    FakeView.onCreate?.(this.webContents)
  }
  setBounds(bounds: FakeView['bounds']) {
    this.bounds = bounds
  }
  getBounds() {
    return this.bounds
  }
  setVisible(visible: boolean) {
    this.visible = visible
  }
}

class FakeWindow extends EventEmitter {
  destroyed = false
  children: FakeView[] = []
  readonly webContents = new FakeContents(new FakeSession())
  readonly contentView = {
    addChildView: (view: FakeView) => this.children.push(view),
    removeChildView: (view: FakeView) => {
      this.children = this.children.filter(child => child !== view)
    },
  }
  getContentSize() {
    return [1200, 800]
  }
  isDestroyed() {
    return this.destroyed
  }
}

/** A preview browser on fakes, for one test: the Host listens on 4317 (loopback) and 4318 (TLS). */
function setup() {
  const window = new FakeWindow()
  const sessions = new Map<string, FakeSession>()
  const external: string[] = []
  let time = 10_000
  let tabs = 0
  const controller = browser.createPreviewBrowser({
    WebContentsView: FakeView,
    fromPartition: (partition: string) => {
      let session = sessions.get(partition)
      if (!session) sessions.set(partition, (session = new FakeSession()))
      return session
    },
    window: () => window,
    openExternal: (url: string) => {
      external.push(url)
    },
    platform: 'darwin',
    now: () => time,
    newTabId: () => `brw_${String(++tabs).padStart(22, 'x')}`,
  })
  controller.blockHost({ loopbackOrigin: `http://${HOST}:4317`, tlsOrigin: 'https://192.168.1.20:4318' })
  const open = (url: string | null = 'localhost:5173', projectId = 'alpha') => {
    const result = controller.open({ projectId, url })
    if (!result.ok) throw new Error(`open failed: ${result.error}`)
    const view = window.children.at(-1)!
    return { tabId: String(result.tabId), view, contents: view.webContents }
  }
  /** The events main sent the page, by type. */
  const events = (type?: string) =>
    window.webContents.sent
      .filter(([channel]) => channel === browser.CHANNELS.event)
      .map(([, value]) => value)
      .filter(value => type === undefined || value.type === type)
  return { controller, window, sessions, external, open, events, advance: (ms: number) => (time += ms) }
}

const hostname = (url: string) => new URL(url).hostname
const reaches = (url: string, ports: ReadonlySet<number> = PORTS) => browser.reachesHost(new URL(url), ports)
const verdict = (request: Parameters<typeof browser.navigationVerdict>[0]) => browser.navigationVerdict(request, PORTS)
/** Whether the guest request filter lets a request out, when main opened developer tools with WebContents ID 7. */
const allowed = (url: string, webContentsId?: number) =>
  browser.requestAllowed({ url, ...(webContentsId === undefined ? {} : { webContentsId }) }, PORTS, new Set([7]))
/** A key press as `before-input-event` reports it: ⌘ and the key, unless `extra` says otherwise. */
const keyDown = (code: string, extra: Record<string, unknown> = {}) => ({
  type: 'keyDown',
  code,
  meta: true,
  control: false,
  alt: false,
  shift: false,
  isAutoRepeat: false,
  ...extra,
})

/** A navigation event as Electron emits it, with preventDefault recorded. */
function navigation(url: string, extra: Record<string, unknown> = {}) {
  return { url, isMainFrame: true, isSameDocument: false, frame: null, initiator: null, preventDefault: vi.fn(), ...extra }
}

/** A real click in the guest, as main sees it before the page does. */
function click(contents: FakeContents) {
  contents.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left', x: 1, y: 1 })
}

describe('preview browser addresses', () => {
  it('reads the address field as http(s) only, a bare port as localhost and no search', () => {
    expect(browser.addressUrl('5173')).toBe('http://localhost:5173/')
    expect(browser.addressUrl(' localhost:3000/settings ')).toBe('http://localhost:3000/settings')
    expect(browser.addressUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/')
    expect(browser.addressUrl('[::1]:3000')).toBe('http://[::1]:3000/')
    expect(browser.addressUrl('192.168.1.5:4000')).toBe('http://192.168.1.5:4000/')
    expect(browser.addressUrl('example.com/docs')).toBe('https://example.com/docs')
    expect(browser.addressUrl('http://example.com')).toBe('http://example.com/')
    for (const refused of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'latch://app/link/',
      'data:text/html,hi',
      'about:blank',
      'chrome://settings',
      'https://user:secret@example.com/',
      'user:secret@example.com',
      '',
      '   ',
      'two words',
      '0',
      '70000',
      `https://example.com/${'a'.repeat(2048)}`,
      42,
      null,
    ])
      expect(browser.addressUrl(refused)).toBeUndefined()
  })

  it('tells local and loopback addresses from the internet by name and literal', () => {
    for (const local of [
      'http://localhost/',
      'http://app.localhost/',
      'http://127.0.0.1/',
      'http://0.0.0.0/',
      'http://10.1.2.3/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://192.168.1.1/',
      'http://169.254.10.1/',
      'http://100.64.0.1/',
      'http://[::1]/',
      'http://[fc00::1]/',
      'http://[fd12:3456::1]/',
      'http://[fe80::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:192.168.0.1]/',
      'http://printer.local/',
      'http://nas.lan/',
      'http://router/',
      'http://box.home.arpa/',
      'http://2130706433/',
      'http://0x7f.1/',
    ])
      expect(browser.isPrivateHost(hostname(local)), local).toBe(true)
    for (const internet of [
      'https://example.com/',
      'http://8.8.8.8/',
      'http://172.32.0.1/',
      'http://100.128.0.1/',
      'http://[2606:4700::1111]/',
      'http://[::ffff:8.8.8.8]/',
    ])
      expect(browser.isPrivateHost(hostname(internet)), internet).toBe(false)
    for (const loopback of ['http://localhost/', 'http://a.localhost/', 'http://127.9.9.9/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/'])
      expect(browser.isLoopbackHost(hostname(loopback)), loopback).toBe(true)
    expect(browser.isLoopbackHost(hostname('http://192.168.1.1/'))).toBe(false)
  })

  it('refuses every way to the Host: its ports on any name, any Host name, and any API path however spelled', () => {
    for (const url of [
      `http://${HOST}:5173/`,
      `http://a.${HOST}/`,
      `http://${HOST.toUpperCase()}./`,
      'http://127.0.0.1:4317/anything',
      'http://[::1]:4317/',
      'http://localhost:4318/',
      'https://example.com:4318/',
      'http://rebound.example:4317/',
      'ws://127.0.0.1:4317/',
      'wss://192.168.1.20:4318/',
      'http://127.0.0.1:5173/link/api/health',
      'http://127.0.0.1:5173/LINK/API/enrollments',
      'http://127.0.0.1:5173/link%2Fapi/x',
      'http://127.0.0.1:5173//link//api',
      'http://127.0.0.1:5173/link/%61pi/x',
      'http://127.0.0.1:5173/x/../link/api',
      'https://example.com/link/api/health',
      // The Host's router reads `//x/link/api` as the path `/link/api` of a host `x`.
      'http://127.0.0.1:5173//x/link/api/health',
      'http://127.0.0.1:5173///x/link/api/health',
      'https://example.com//x/LINK/api',
      'http://127.0.0.1:5173/%2F%2Fx/link/api/health',
    ])
      expect(reaches(url), url).toBe(true)
    for (const url of [
      'http://127.0.0.1:5173/',
      'http://127.0.0.1:5173/link/',
      'https://example.com/link/abc',
      'http://localhost:3000/api',
      'http://127.0.0.1:5173//x/link/',
    ])
      expect(reaches(url), url).toBe(false)
    // A Host listening on 443 shuts that port on local addresses only, not the internet.
    expect(reaches('https://example.com/', new Set([443]))).toBe(false)
    expect(reaches('https://192.168.1.2/', new Set([443]))).toBe(true)
  })
})

describe('preview browser navigation', () => {
  it('loads only http(s) at the top, refuses the Host and credentials, and lets frames hold their own documents', () => {
    expect(verdict({ url: 'https://example.com/', kind: 'typed' })).toEqual({ ok: true })
    expect(verdict({ url: 'http://localhost:5173/', kind: 'typed' })).toEqual({ ok: true })
    for (const url of [
      'file:///etc/hosts',
      'latch://app/link/',
      'data:text/html,x',
      'javascript:alert(1)',
      'about:blank',
      'chrome://gpu',
      'not a url',
    ])
      expect(verdict({ url, kind: 'page', gesture: true }), url).toEqual({ ok: false, reason: 'scheme' })
    expect(verdict({ url: 'https://u:p@example.com/', kind: 'page' })).toEqual({ ok: false, reason: 'credentials' })
    expect(verdict({ url: `http://${HOST}:4317/link/`, kind: 'typed' })).toEqual({ ok: false, reason: 'host' })
    expect(verdict({ url: 'http://127.0.0.1:4317/', kind: 'page', gesture: true })).toEqual({ ok: false, reason: 'host' })
    for (const url of ['about:blank', 'about:srcdoc', 'data:text/html,x', 'blob:http://localhost:5173/x'])
      expect(verdict({ url, kind: 'page', frame: true }), url).toEqual({ ok: true })
    expect(verdict({ url: 'file:///etc/hosts', kind: 'page', frame: true })).toEqual({ ok: false, reason: 'scheme' })
  })

  it('sends a tab to a private address only when typed or clicked, or from that same address', () => {
    const internet = 'https://example.com'
    expect(verdict({ url: 'http://localhost:3000/', kind: 'page', from: internet })).toEqual({ ok: false, reason: 'private' })
    expect(verdict({ url: 'http://localhost:3000/', kind: 'page', from: internet, gesture: true })).toEqual({ ok: true })
    expect(verdict({ url: 'http://10.0.0.1/', kind: 'page', from: 'null' })).toEqual({ ok: false, reason: 'private' })
    expect(verdict({ url: 'http://10.0.0.1/', kind: 'page' })).toEqual({ ok: false, reason: 'private' })
    // Every name of this Mac is one address; another device on the network is another.
    expect(verdict({ url: 'http://localhost:8080/', kind: 'page', from: 'http://localhost:5173' })).toEqual({ ok: true })
    expect(verdict({ url: 'http://127.0.0.1:8080/', kind: 'page', from: 'http://localhost:5173' })).toEqual({ ok: true })
    expect(verdict({ url: 'http://192.168.1.1/', kind: 'page', from: 'http://localhost:5173' })).toEqual({ ok: false, reason: 'private' })
    expect(verdict({ url: 'http://192.168.1.6/', kind: 'page', from: 'http://192.168.1.5:3000' })).toEqual({ ok: false, reason: 'private' })
    expect(verdict({ url: 'http://192.168.1.5:9000/', kind: 'page', from: 'http://192.168.1.5:3000' })).toEqual({ ok: true })
    expect(verdict({ url: 'http://192.168.1.1/', kind: 'page', from: internet, frame: true })).toEqual({ ok: false, reason: 'private' })
    expect(verdict({ url: 'https://example.org/', kind: 'page', from: 'http://localhost:5173' })).toEqual({ ok: true })
    // Redirects: a server sends a navigation on only within the private address it came from.
    expect(verdict({ url: 'http://10.0.0.1/', kind: 'redirect', from: 'https://example.com/go' })).toEqual({ ok: false, reason: 'private' })
    expect(verdict({ url: 'http://localhost:3000/login', kind: 'redirect', from: 'http://localhost:3000/' })).toEqual({ ok: true })
    expect(verdict({ url: 'http://127.0.0.1:4317/', kind: 'redirect', from: 'http://localhost:3000/' })).toEqual({
      ok: false,
      reason: 'host',
    })
  })

  it('lets guest requests out on network schemes only, never to the Host, and devtools: only to the tools main opened', () => {
    for (const url of [
      'https://example.com/a.js',
      'http://localhost:5173/@vite/client',
      'ws://localhost:5173/',
      'data:image/png;base64,AA',
      'blob:http://localhost/x',
    ])
      expect(allowed(url), url).toBe(true)
    for (const url of [
      'http://127.0.0.1:4317/link/api/health',
      'ws://127.0.0.1:4318/',
      `http://${HOST}:5173/`,
      'http://127.0.0.1:5173/link/api/enrollments',
      'file:///etc/hosts',
      'latch://app/link/api/health',
      'latch-frame://preview/html.html',
      'chrome://version',
      'devtools://devtools/bundled/devtools_app.html',
    ])
      expect(allowed(url), url).toBe(false)
    expect(allowed('devtools://devtools/bundled/devtools_app.html', 7)).toBe(true)
    expect(allowed('devtools://devtools/bundled/devtools_app.html', 8)).toBe(false)
  })
})

describe('preview browser inputs', () => {
  const tabId = `brw_${'a'.repeat(22)}`

  it('takes exactly the keys of each call with values of their shape, and nothing inherited', () => {
    const { INPUTS } = browser
    expect(INPUTS.open({ projectId: 'alpha', url: null })).toEqual({ projectId: 'alpha', url: null })
    expect(INPUTS.open({ projectId: 'alpha', url: 'localhost:5173' })).toEqual({ projectId: 'alpha', url: 'localhost:5173' })
    for (const bad of [
      { projectId: '../alpha', url: null },
      { projectId: 'alpha' },
      { projectId: 'alpha', url: null, preload: '/tmp/x.js' },
      { projectId: 'alpha', url: 'x'.repeat(2049) },
      Object.create({ projectId: 'alpha', url: null }),
      null,
      'alpha',
    ])
      expect(INPUTS.open(bad)).toBeUndefined()
    expect(INPUTS.tab({ tabId })).toEqual({ tabId })
    for (const bad of [{ tabId: 'brw_short' }, { tabId, extra: 1 }, { tabId: 7 }]) expect(INPUTS.tab(bad)).toBeUndefined()
    expect(INPUTS.go({ tabId, action: 'back' })).toEqual({ tabId, action: 'back' })
    expect(INPUTS.go({ tabId, action: 'print' })).toBeUndefined()
    expect(INPUTS.bounds({ tabId, bounds: null })).toEqual({ tabId, bounds: null })
    expect(INPUTS.bounds({ tabId, bounds: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({
      tabId,
      bounds: { x: 1, y: 2, width: 3, height: 4 },
    })
    for (const bounds of [
      { x: 1, y: 2, width: -3, height: 4 },
      { x: Number.NaN, y: 2, width: 3, height: 4 },
      { x: 1, y: 2, width: 3 },
      { x: 1, y: 2, width: 3, height: 4, z: 0 },
    ])
      expect(INPUTS.bounds({ tabId, bounds })).toBeUndefined()
    expect(INPUTS.occlude({ tabId, occluded: true })).toEqual({ tabId, occluded: true })
    expect(INPUTS.occlude({ tabId, occluded: 'yes' })).toBeUndefined()
    expect(INPUTS.annotate({ tabId, point: { x: 10, y: 20 } })).toEqual({ tabId, point: { x: 10, y: 20 } })
    expect(INPUTS.annotate({ tabId, point: { x: -1, y: 20 } })).toBeUndefined()
    expect(INPUTS.annotate({ tabId, point: { x: 1, y: 2, z: 3 } })).toBeUndefined()
    expect(INPUTS.zoom({ tabId, direction: 'in' })).toEqual({ tabId, direction: 'in' })
    expect(INPUTS.zoom({ tabId, direction: 4 })).toBeUndefined()
    expect(INPUTS.project({ projectId: 'alpha' })).toEqual({ projectId: 'alpha' })
    expect(INPUTS.project({ projectId: '' })).toBeUndefined()
  })

  it('places the panel rectangle in the window: scaled by the page zoom, rounded and clamped', () => {
    expect(browser.viewBounds({ x: 700, y: 52, width: 500, height: 600 }, 1, { width: 1200, height: 800 })).toEqual({
      x: 700,
      y: 52,
      width: 500,
      height: 600,
    })
    expect(browser.viewBounds({ x: 100.4, y: 10, width: 200, height: 100 }, 1.25, { width: 1200, height: 800 })).toEqual({
      x: 126,
      y: 13,
      width: 250,
      height: 125,
    })
    expect(browser.viewBounds({ x: -50, y: 700, width: 2000, height: 400 }, 1, { width: 1200, height: 800 })).toEqual({
      x: 0,
      y: 700,
      width: 1200,
      height: 100,
    })
    expect(browser.viewBounds({ x: 1300, y: 0, width: 10, height: 10 }, 1, { width: 1200, height: 800 })).toBeNull()
  })

  it('forwards only the app shortcuts, with the platform command key and nothing else held', () => {
    const key = keyDown
    expect(browser.forwardedShortcut(key('KeyK'), 'darwin')).toMatchObject({ keyCode: 'K', alt: false })
    expect(browser.forwardedShortcut(key('KeyJ'), 'darwin')).toMatchObject({ keyCode: 'J' })
    expect(browser.forwardedShortcut(key('KeyB'), 'darwin')).toMatchObject({ keyCode: 'B', alt: false })
    expect(browser.forwardedShortcut(key('KeyB', { alt: true }), 'darwin')).toMatchObject({ keyCode: 'B', alt: true })
    expect(browser.forwardedShortcut(key('Comma'), 'darwin')).toMatchObject({ keyCode: ',' })
    expect(browser.forwardedShortcut(key('KeyK', { type: 'keyUp' }), 'darwin')).toBeDefined()
    for (const input of [
      key('KeyK', { shift: true }),
      key('KeyK', { alt: true }),
      key('KeyK', { control: true }),
      key('KeyA'),
      key('KeyR'),
      { ...key('KeyK'), type: 'char' },
    ])
      expect(browser.forwardedShortcut(input, 'darwin')).toBeUndefined()
    expect(browser.forwardedShortcut(key('KeyK', { meta: false, control: true }), 'darwin')).toBeUndefined()
    expect(browser.forwardedShortcut(key('KeyK'), 'linux')).toBeUndefined()
    expect(browser.forwardedShortcut(key('KeyK', { meta: false, control: true }), 'linux')).toMatchObject({ keyCode: 'K' })
  })

  it('bounds a capture: PNG within the edge and the byte limit, smaller until it fits, nothing when empty', () => {
    const small = browser.encodeImage(new FakeImage(520, 800, 1000), browser.CAPTURE_LIMITS)
    expect(small).toMatchObject({ type: 'image/png', width: 520, height: 800 })
    expect(small!.data).toBeInstanceOf(Uint8Array)
    expect(small!.data.length).toBe(1000)
    const wide = browser.encodeImage(new FakeImage(8192, 1024, 1000), { edge: 4096, bytes: 5 * 1024 * 1024 })
    expect(wide).toMatchObject({ width: 4096, height: 512 })
    const heavy = browser.encodeImage(new FakeImage(1000, 1000, 6 * 1024 * 1024), { edge: 4096, bytes: 5 * 1024 * 1024 })
    expect(heavy!.data.length).toBeLessThanOrEqual(5 * 1024 * 1024)
    expect(heavy!.width).toBeLessThan(1000)
    expect(browser.encodeImage(new FakeImage(0, 0), browser.CAPTURE_LIMITS)).toBeUndefined()
    expect(browser.encodeImage(new FakeImage(100, 100, 1e9), { edge: 4096, bytes: 10 })).toBeUndefined()
  })

  it('takes from the isolated world only a bounded, printable descriptor', () => {
    const rect = { x: 1, y: 2, width: 30, height: 40 }
    const controls = String.fromCharCode(0x202e, 0x200b, 0x0007)
    expect(browser.annotationOf({ tag: 'BUTTON', selector: '#save', text: `  保存${controls}设置  ${'x'.repeat(400)}`, rect })).toEqual({
      tag: 'button',
      selector: '#save',
      text: `保存 设置 ${'x'.repeat(194)}`,
      rect,
    })
    for (const raw of [
      null,
      { tag: 'button', selector: '#save', text: '', rect, extra: true },
      { tag: '<img>', selector: '#save', text: '', rect },
      { tag: 'button', selector: `#a${controls}`, text: '', rect },
      { tag: 'button', selector: 'x'.repeat(513), text: '', rect },
      { tag: 'button', selector: '#save', text: 'x'.repeat(801), rect },
      { tag: 'button', selector: '#save', text: '', rect: { ...rect, width: -1 } },
      { tag: 'button', selector: '#save', text: '', rect: { ...rect, x: Number.POSITIVE_INFINITY } },
    ])
      expect(browser.annotationOf(raw)).toBeUndefined()
    const script = browser.annotationScript(12.5, 40)
    expect(script).toContain('"x":12.5,"y":40')
    expect(script).not.toMatch(/\.value\b|innerHTML|addEventListener|setAttribute|appendChild|fetch\(/u)
    // Named form controls shadow members of their form in every world, and named elements can shadow those of document.
    expect(script).not.toMatch(/document\.\w|\b(?:node|element|parent|child)\.\w/u)
  })

  it('steps zoom through the usual factors and resets to 100%', () => {
    expect(browser.nextZoom(1, 'in')).toBe(1.1)
    expect(browser.nextZoom(1, 'out')).toBe(0.9)
    expect(browser.nextZoom(1.05, 'in')).toBe(1.1)
    expect(browser.nextZoom(3, 'in')).toBe(3)
    expect(browser.nextZoom(0.5, 'out')).toBe(0.5)
    expect(browser.nextZoom(2.5, 'reset')).toBe(1)
  })
})

describe('preview browser tabs', () => {
  it('opens a tab in its project’s in-memory partition without preload, Node or webviews, hidden until placed', () => {
    const { controller, sessions, window, open } = setup()
    const { tabId, view, contents } = open()
    expect(tabId).toMatch(/^brw_[A-Za-z0-9_-]{22}$/u)
    expect([...sessions.keys()]).toEqual(['latch-preview-alpha'])
    const preferences = view.options.webPreferences
    expect(preferences.session).toBe(sessions.get('latch-preview-alpha'))
    expect(preferences).not.toHaveProperty('preload')
    expect(preferences).not.toHaveProperty('partition')
    expect(preferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      focusOnNavigation: false,
      disableDialogs: true,
    })
    expect(String(preferences.disableBlinkFeatures).split(',')).toEqual(['FileSystemAccessLocal', 'DocumentPictureInPictureAPI'])
    expect(preferences).not.toHaveProperty('safeDialogs')
    expect(view.visible).toBe(false)
    expect(window.children).toEqual([view])
    expect(contents.loads).toEqual(['http://localhost:5173/'])
    expect(contents.policy).toBe('disable_non_proxied_udp')
    // The same project shares its partition; another project gets its own.
    open('example.com', 'alpha')
    open(null, 'beta')
    expect([...sessions.keys()]).toEqual(['latch-preview-alpha', 'latch-preview-beta'])
    expect(controller.owns(contents)).toBe(true)
    expect(controller.owns(window.webContents)).toBe(false)
  })

  it('counts a WebContents as a guest while it is being made, before the constructor returns', () => {
    const { controller, open } = setup()
    const seen: boolean[] = []
    FakeView.onCreate = contents => seen.push(controller.owns(contents))
    try {
      open()
    } finally {
      FakeView.onCreate = undefined
    }
    expect(seen).toEqual([true])
  })

  it('refuses addresses before making a tab, and stops at the tab limit', () => {
    const { controller, window } = setup()
    expect(controller.open({ projectId: 'alpha', url: 'file:///etc/hosts' })).toEqual({ ok: false, error: 'invalid-url' })
    expect(controller.open({ projectId: 'alpha', url: `${HOST}:4317` })).toEqual({ ok: false, error: 'blocked', reason: 'host' })
    expect(controller.open({ projectId: 'alpha', url: '127.0.0.1:4317' })).toEqual({ ok: false, error: 'blocked', reason: 'host' })
    expect(window.children).toHaveLength(0)
    for (let index = 0; index < browser.TAB_LIMIT; index++) expect(controller.open({ projectId: 'alpha', url: null }).ok).toBe(true)
    expect(controller.open({ projectId: 'alpha', url: null })).toEqual({ ok: false, error: 'tab-limit' })
  })

  it('refuses every permission, device, download and request to the Host in the partition, and says so quietly', () => {
    const { sessions, open, events } = setup()
    const { tabId, contents } = open()
    const session = sessions.get('latch-preview-alpha')!
    const granted = vi.fn()
    session.permissionRequest!(contents, 'geolocation', granted)
    session.permissionRequest!(contents, 'media', granted)
    session.permissionRequest!(contents, '<script>', granted)
    expect(granted.mock.calls).toEqual([[false], [false], [false]])
    expect(session.permissionCheck!()).toBe(false)
    expect(session.devicePermission!()).toBe(false)
    expect(session.spellChecker).toBe(false)
    expect(events('notice')).toEqual([
      { tabId, type: 'notice', notice: 'permission', detail: 'geolocation' },
      { tabId, type: 'notice', notice: 'permission', detail: 'media' },
      { tabId, type: 'notice', notice: 'permission', detail: 'unknown' },
    ])
    for (const [name, args, expected] of [
      ['select-hid-device', [{}], []],
      ['select-serial-port', [[], contents], ['']],
      ['select-usb-device', [{}], []],
      ['select-webauthn-account', [{}], []],
    ] as const) {
      const event = { preventDefault: vi.fn() }
      const callback = vi.fn()
      session.emit(name, event, ...args, callback)
      expect(event.preventDefault, name).toHaveBeenCalled()
      expect(callback, name).toHaveBeenCalledWith(...expected)
    }
    const download = { preventDefault: vi.fn() }
    const item = { cancel: vi.fn() }
    session.emit('will-download', download, item, contents)
    expect(download.preventDefault).toHaveBeenCalled()
    expect(item.cancel).toHaveBeenCalled()
    expect(events('notice').at(-1)).toEqual({ tabId, type: 'notice', notice: 'download' })
    expect(session.allows('http://localhost:5173/src/main.ts')).toBe(true)
    expect(session.allows('http://127.0.0.1:4317/link/')).toBe(false)
    expect(session.allows('http://127.0.0.1:5173/link/api/health')).toBe(false)
    expect(session.allows('latch://app/link/api/health')).toBe(false)
  })

  it('puts Latch’s policies on every document: no picture-in-picture in place of the page’s own, and a sandbox beside its CSP', () => {
    const { sessions, open } = setup()
    open()
    const session = sessions.get('latch-preview-alpha')!
    const sandbox = 'sandbox allow-scripts allow-same-origin allow-forms allow-popups'
    const policy = { 'Permissions-Policy': ['picture-in-picture=()'], 'Content-Security-Policy': [sandbox] }
    expect(
      session.headers('mainFrame', {
        'content-type': ['text/html'],
        'permissions-policy': ['picture-in-picture=*'],
        'Permissions-Policy': ['((('],
      }),
    ).toEqual({ 'content-type': ['text/html'], ...policy })
    expect(session.headers('subFrame', {})).toEqual(policy)
    expect(session.headers('script', { 'permissions-policy': ['picture-in-picture=*'] })).toBeUndefined()
    expect(browser.withGuestPolicy(undefined)).toEqual(policy)
    // The page keeps its own Content-Security-Policy, however the name is spelled; the sandbox has no allow-modals.
    for (const name of ['content-security-policy', 'Content-Security-Policy', 'CONTENT-SECURITY-POLICY'])
      expect(session.headers('mainFrame', { [name]: ["default-src 'self'", 'img-src data:'] })).toEqual({
        ...policy,
        'Content-Security-Policy': ["default-src 'self'", 'img-src data:', sandbox],
      })
    expect(session.headers('mainFrame', { 'content-security-policy': ['a-src x'], 'Content-Security-Policy': ['b-src y'] })).toEqual({
      ...policy,
      'Content-Security-Policy': ['a-src x', 'b-src y', sandbox],
    })
    expect(browser.withGuestPolicy({ 'content-security-policy': 'one-src x' })['Content-Security-Policy']).toEqual(['one-src x', sandbox])
    expect(sandbox).not.toContain('allow-modals')
  })

  it('repeats a notice at most once a second for each kind', () => {
    const { sessions, open, events, advance } = setup()
    const { contents } = open()
    const session = sessions.get('latch-preview-alpha')!
    for (let index = 0; index < 5; index++) session.permissionRequest!(contents, 'notifications', () => {})
    expect(events('notice')).toHaveLength(1)
    advance(1_000)
    session.permissionRequest!(contents, 'notifications', () => {})
    expect(events('notice')).toHaveLength(2)
  })

  it('never opens a window: without a click a page’s window.open is dropped; with one, local stays in the tab', () => {
    const { open, events, external } = setup()
    const { tabId, contents } = open()
    const request = (url: string, extra: Record<string, unknown> = {}) =>
      contents.openHandler!({ url, disposition: 'foreground-tab', ...extra })
    expect(request('http://localhost:5173/other')).toEqual({ action: 'deny' })
    expect(contents.loads).toEqual(['http://localhost:5173/'])
    expect(events('notice')).toEqual([{ tabId, type: 'notice', notice: 'popup' }])
    click(contents)
    expect(request('http://localhost:5173/other')).toEqual({ action: 'deny' })
    expect(contents.loads.at(-1)).toBe('http://localhost:5173/other')
    click(contents)
    expect(request('https://example.com/docs')).toEqual({ action: 'deny' })
    expect(external).toEqual(['https://example.com/docs'])
    // A click does not open the Host, a form's POST, a non-web scheme or credentials.
    for (const [url, extra] of [
      ['http://127.0.0.1:4317/link/', {}],
      ['https://example.com/form', { postBody: { data: [] } }],
      ['file:///etc/hosts', {}],
      ['https://u:p@example.com/', {}],
    ] as const) {
      click(contents)
      expect(request(url, extra)).toEqual({ action: 'deny' })
    }
    expect(external).toEqual(['https://example.com/docs'])
    expect(contents.loads.at(-1)).toBe('http://localhost:5173/other')
  })

  it('keeps a page to http(s), away from the Host, and off other private addresses unless the person clicked', () => {
    const { open, events } = setup()
    const { tabId, contents } = open('https://example.com/')
    const internet = { origin: 'https://example.com' }
    const refuse = (event: ReturnType<typeof navigation>) => {
      contents.emit('will-frame-navigate', event)
      return event.preventDefault.mock.calls.length > 0
    }
    expect(refuse(navigation('https://example.org/', { initiator: internet }))).toBe(false)
    expect(refuse(navigation('http://localhost:3000/', { initiator: internet }))).toBe(true)
    expect(refuse(navigation('file:///etc/hosts', { initiator: internet }))).toBe(true)
    expect(refuse(navigation('http://127.0.0.1:4317/', { initiator: internet }))).toBe(true)
    expect(refuse(navigation('http://192.168.1.1/', { initiator: internet, isMainFrame: false }))).toBe(true)
    expect(refuse(navigation('about:srcdoc', { initiator: internet, isMainFrame: false }))).toBe(false)
    expect(events('notice').map(event => event.detail)).toEqual(['private', 'scheme', 'host'])
    click(contents)
    expect(refuse(navigation('http://localhost:3000/', { initiator: internet }))).toBe(false)
    // The click is spent on that one navigation.
    expect(refuse(navigation('http://localhost:3000/', { initiator: internet }))).toBe(true)
    // Electron reports a navigation's start before it asks: one the page started keeps the click for that question,
    // one it did not (the address field, history) ends the click.
    click(contents)
    contents.emit('did-start-navigation', {
      url: 'http://localhost:3000/',
      isMainFrame: true,
      isSameDocument: false,
      frame: null,
      initiator: internet,
    })
    expect(refuse(navigation('http://localhost:3000/', { initiator: internet }))).toBe(false)
    click(contents)
    contents.emit('did-start-navigation', {
      url: 'https://example.org/',
      isMainFrame: true,
      isSameDocument: false,
      frame: null,
      initiator: null,
    })
    expect(refuse(navigation('http://localhost:3000/', { initiator: internet }))).toBe(true)
    const webview = { preventDefault: vi.fn() }
    contents.emit('will-attach-webview', webview)
    expect(webview.preventDefault).toHaveBeenCalled()
    expect(tabId).toBeTruthy()
  })

  it('follows a redirect to a private address only from that same address', () => {
    const { open } = setup()
    const { contents } = open('https://example.com/')
    contents.emit('did-start-navigation', { url: 'https://example.com/go', isMainFrame: true, isSameDocument: false, frame: null })
    const toPrivate = navigation('http://10.0.0.1/')
    contents.emit('will-redirect', toPrivate)
    expect(toPrivate.preventDefault).toHaveBeenCalled()
    contents.emit('did-start-navigation', { url: 'http://localhost:3000/', isMainFrame: true, isSameDocument: false, frame: null })
    const login = navigation('http://localhost:3000/login')
    contents.emit('will-redirect', login)
    expect(login.preventDefault).not.toHaveBeenCalled()
    const host = navigation('http://localhost:4317/')
    contents.emit('will-redirect', host)
    expect(host.preventDefault).toHaveBeenCalled()
  })

  it('fails certificate errors closed, offers no client certificate and lets no page block its own unload', () => {
    const { open, events } = setup()
    const { tabId, contents } = open('https://self-signed.example/')
    const event = { preventDefault: vi.fn() }
    const trust = vi.fn()
    contents.emit('certificate-error', event, 'https://self-signed.example/', 'net::ERR_CERT_AUTHORITY_INVALID', {}, trust)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(trust).toHaveBeenCalledWith(false)
    expect(events('notice')).toEqual([{ tabId, type: 'notice', notice: 'certificate' }])
    const select = vi.fn()
    contents.emit('select-client-certificate', { preventDefault: vi.fn() }, 'https://x.example/', [{ subjectName: 'me' }], select)
    expect(select).toHaveBeenCalledWith()
    const bluetooth = vi.fn()
    contents.emit('select-bluetooth-device', { preventDefault: vi.fn() }, [{ deviceId: 'a' }], bluetooth)
    expect(bluetooth).toHaveBeenCalledWith('')
    const unload = { preventDefault: vi.fn() }
    contents.emit('will-prevent-unload', unload)
    expect(unload.preventDefault).toHaveBeenCalled()
  })

  it('gives the app shortcuts to the page and keeps them from the guest; other keys stay with the guest', () => {
    const { open, window } = setup()
    const { contents } = open()
    const key = (code: string, extra: Record<string, unknown> = {}) => {
      const event = { preventDefault: vi.fn() }
      contents.emit('before-input-event', event, keyDown(code, extra))
      return event.preventDefault.mock.calls.length > 0
    }
    expect(key('KeyK')).toBe(true)
    expect(window.webContents.focused).toBe(true)
    expect(window.webContents.inputs).toEqual([
      { type: 'keyDown', keyCode: 'K', modifiers: ['meta'] },
      { type: 'keyUp', keyCode: 'K', modifiers: ['meta'] },
    ])
    expect(key('KeyB', { alt: true })).toBe(true)
    expect(window.webContents.inputs.at(-2)).toEqual({ type: 'keyDown', keyCode: 'B', modifiers: ['meta', 'alt'] })
    // A held key repeats into nothing; the release is kept from the guest too.
    const before = window.webContents.inputs.length
    expect(key('KeyK', { isAutoRepeat: true })).toBe(true)
    expect(key('KeyK', { type: 'keyUp' })).toBe(true)
    expect(window.webContents.inputs).toHaveLength(before)
    expect(key('KeyC')).toBe(false)
    expect(key('KeyK', { meta: false })).toBe(false)
    expect(window.webContents.inputs).toHaveLength(before)
  })

  it('places, hides and occludes a tab, with the frozen frame standing in and the keyboard back with the page', async () => {
    const { controller, open, window } = setup()
    const { tabId, view, contents } = open()
    window.webContents.zoom = 1.25
    expect(controller.setBounds({ tabId, bounds: { x: 560, y: 52, width: 400, height: 600 } })).toEqual({ ok: true })
    expect(view.bounds).toEqual({ x: 700, y: 65, width: 500, height: 735 })
    expect(view.visible).toBe(true)
    expect(controller.focus({ tabId })).toEqual({ ok: true })
    expect(contents.focused).toBe(true)
    window.webContents.focused = false
    const occluded = await controller.occlude({ tabId, occluded: true })
    expect(occluded).toMatchObject({ ok: true, image: { type: 'image/png', width: 500, height: 400 } })
    expect(contents.captures).toEqual([undefined])
    expect(view.visible).toBe(false)
    expect(window.webContents.focused).toBe(true)
    expect(controller.focus({ tabId })).toEqual({ ok: false, error: 'hidden' })
    expect(await controller.occlude({ tabId, occluded: true })).toEqual({ ok: true, image: null })
    expect(await controller.occlude({ tabId, occluded: false })).toEqual({ ok: true, image: null })
    expect(view.visible).toBe(true)
    expect(controller.setBounds({ tabId, bounds: null })).toEqual({ ok: true })
    expect(view.visible).toBe(false)
  })

  it('lets the last occlusion call win when a frozen frame is still being captured', async () => {
    const { controller, open } = setup()
    const { tabId, view, contents } = open()
    controller.setBounds({ tabId, bounds: { x: 0, y: 0, width: 100, height: 100 } })
    let finish: (image: FakeImage) => void = () => {}
    contents.capturePage = () =>
      new Promise<FakeImage>(done => {
        finish = done
      })
    const covering = controller.occlude({ tabId, occluded: true })
    expect(await controller.occlude({ tabId, occluded: false })).toEqual({ ok: true, image: null })
    finish(new FakeImage(100, 100))
    expect(await covering).toMatchObject({ ok: true, image: { type: 'image/png', width: 100, height: 100 } })
    expect(view.visible).toBe(true)
  })

  it('captures within the limits, one capture at a time', async () => {
    const { controller, open } = setup()
    const { tabId, contents } = open()
    contents.captureImage = new FakeImage(9000, 3000, 1000)
    const first = controller.capture({ tabId })
    expect(await controller.capture({ tabId })).toEqual({ ok: false, error: 'busy' })
    expect(await first).toMatchObject({ ok: true, image: { width: 4096, height: 1365 } })
    contents.captureImage = new FakeImage(0, 0)
    expect(await controller.capture({ tabId })).toEqual({ ok: false, error: 'capture-failed' })
  })

  it('annotates in its own isolated world, converting the point and the box between the page and the guest', async () => {
    const { controller, open, window } = setup()
    const { tabId, view, contents } = open()
    controller.setBounds({ tabId, bounds: { x: 700, y: 52, width: 500, height: 600 } })
    window.webContents.zoom = 1
    contents.zoom = 2
    contents.isolatedResult = { tag: 'button', selector: '#save', text: '保存', rect: { x: 10, y: 20, width: 50, height: 10 } }
    const result = await controller.annotate({ tabId, point: { x: 40, y: 60 } })
    expect(contents.isolated).toHaveLength(1)
    const [run] = contents.isolated
    expect(run.world).toBe(browser.ANNOTATION_WORLD)
    expect([0, 999]).not.toContain(run.world)
    expect(run.code).toContain('"x":20,"y":30')
    expect(contents.captures).toEqual([{ x: 12, y: 32, width: 116, height: 36 }])
    expect(result).toMatchObject({
      ok: true,
      target: {
        url: 'http://localhost:5173/',
        tag: 'button',
        selector: '#save',
        text: '保存',
        rect: { x: 20, y: 40, width: 100, height: 20 },
        image: { type: 'image/png' },
      },
    })
    expect(view.bounds.width).toBe(500)
    contents.isolatedResult = { tag: 'button', selector: '#save', text: '保存', rect: { x: 1, y: 2, width: 3, height: 4 }, extra: 'no' }
    expect(await controller.annotate({ tabId, point: { x: 1, y: 1 } })).toEqual({ ok: false, error: 'no-target' })
    contents.isolatedResult = null
    expect(await controller.annotate({ tabId, point: { x: 1, y: 1 } })).toEqual({ ok: false, error: 'no-target' })
  })

  it('zooms, opens detached developer tools that alone may load devtools:, and clears the partition', async () => {
    const { controller, open, sessions } = setup()
    const { tabId, contents } = open()
    expect(controller.zoom({ tabId, direction: 'in' })).toEqual({ ok: true, zoom: 1.1 })
    expect(contents.zoom).toBe(1.1)
    expect(controller.zoom({ tabId, direction: 'reset' })).toEqual({ ok: true, zoom: 1 })
    const session = sessions.get('latch-preview-alpha')!
    expect(session.allows('devtools://devtools/bundled/devtools_app.html', 999_999)).toBe(false)
    expect(controller.devTools({ tabId })).toEqual({ ok: true })
    expect(contents.devToolsOptions).toEqual({ mode: 'detach', activate: true })
    const tools = contents.devToolsWebContents!
    // Electron reports the tools' page in the tab's partition, and main.cjs guards it like any page there.
    expect(controller.owns(tools)).toBe(true)
    expect(session.allows('devtools://devtools/bundled/devtools_app.html', tools.id)).toBe(false)
    controller.guard(tools)
    expect(session.allows('devtools://devtools/bundled/devtools_app.html', tools.id)).toBe(true)
    expect(session.allows('devtools://devtools/bundled/devtools_app.html', contents.id)).toBe(false)
    // The tools' own page may navigate only within devtools:, and loses devtools: when it closes.
    const away = navigation('https://example.com/')
    tools.emit('will-frame-navigate', away)
    expect(away.preventDefault).toHaveBeenCalled()
    const inside = navigation('devtools://devtools/bundled/devtools_app.html')
    tools.emit('will-frame-navigate', inside)
    expect(inside.preventDefault).not.toHaveBeenCalled()
    tools.close()
    expect(session.allows('devtools://devtools/bundled/devtools_app.html', tools.id)).toBe(false)
    expect(await controller.clearData({ projectId: 'alpha' })).toEqual({ ok: true })
    expect(session.cleared.toSorted()).toEqual(['auth', 'cache', 'data', 'hosts'])
    expect(await controller.clearData({ projectId: 'never-opened' })).toEqual({ ok: true })
  })

  it('reports history, state and failures in bursts no faster than one per 32 ms', async () => {
    const { controller, open, events } = setup()
    const { tabId, contents } = open()
    expect(controller.go({ tabId, action: 'back' })).toEqual({ ok: true })
    expect(controller.go({ tabId, action: 'forward' })).toEqual({ ok: true })
    expect(controller.go({ tabId, action: 'reload' })).toEqual({ ok: true })
    expect(controller.go({ tabId, action: 'stop' })).toEqual({ ok: true })
    expect(contents.history).toEqual({ back: 1, forward: 0, reload: 1, stop: 1 })
    contents.title = `设置${String.fromCharCode(0x202e)}页`
    for (let index = 0; index < 10; index++) contents.emit('did-navigate-in-page')
    contents.emit('did-fail-load', {}, -202, 'ERR_CERT_AUTHORITY_INVALID', 'https://x/', true)
    contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://x/', true)
    await new Promise(done => setTimeout(done, 80))
    expect(events('state')).toEqual([
      {
        tabId,
        type: 'state',
        state: {
          url: 'http://localhost:5173/',
          title: '设置 页',
          loading: false,
          canGoBack: true,
          canGoForward: false,
          zoom: 1,
          crashed: false,
          error: -202,
        },
      },
    ])
    expect(controller.state({ tabId })).toMatchObject({ ok: true, state: { error: -202 } })
    expect(controller.navigate({ tabId, url: 'example.com' })).toEqual({ ok: true, url: 'https://example.com/' })
    expect(controller.navigate({ tabId, url: 'javascript:alert(1)' })).toEqual({ ok: false, error: 'invalid-url' })
    expect(controller.navigate({ tabId, url: `${HOST}:5173` })).toEqual({ ok: false, error: 'blocked', reason: 'host' })
    expect(controller.state({ tabId })).toMatchObject({ ok: true, state: { error: null } })
  })

  it('ends tabs with the page that opened them, and when a guest closes itself', () => {
    const { controller, open, window, events } = setup()
    controller.attach(window)
    const first = open()
    const second = open()
    first.contents.close()
    expect(window.children).toEqual([second.view])
    expect(events('closed')).toEqual([{ tabId: first.tabId, type: 'closed' }])
    expect(controller.state({ tabId: first.tabId })).toEqual({ ok: false, error: 'not-found' })
    window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(window.children).toEqual([second.view])
    window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(window.children).toEqual([])
    expect(second.contents.destroyed).toBe(true)
    const third = open()
    expect(controller.close({ tabId: third.tabId })).toEqual({ ok: true })
    expect(controller.close({ tabId: third.tabId })).toEqual({ ok: false, error: 'not-found' })
    const fourth = open()
    window.destroyed = true
    window.emit('closed')
    expect(fourth.contents.destroyed).toBe(true)
  })
})

describe('preview browser IPC', () => {
  it('answers only trusted senders, with exactly the inputs the preload sends', async () => {
    const handlers = new Map<string, Handler>()
    const calls: Array<[string, unknown]> = []
    const controller = new Proxy(
      {},
      {
        get: (_target, name) => (input: unknown) => {
          calls.push([String(name), input])
          return { ok: true }
        },
      },
    )
    browser.handleBrowserRequests({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      trusted: event => event === 'main-page',
      controller,
    })
    expect([...handlers.keys()].toSorted()).toEqual(
      Object.values(browser.CHANNELS)
        .filter(channel => channel !== browser.CHANNELS.event)
        .toSorted(),
    )
    const tabId = `brw_${'b'.repeat(22)}`
    const call = (channel: string, event: unknown, input: unknown) => handlers.get(channel)!(event, input)
    expect(await call(browser.CHANNELS.open, 'guest', { projectId: 'alpha', url: null })).toEqual({ ok: false, error: 'shell-refused' })
    expect(await call(browser.CHANNELS.open, 'main-page', { projectId: 'alpha', url: null, preload: 'x' })).toEqual({
      ok: false,
      error: 'invalid',
    })
    expect(await call(browser.CHANNELS.open, 'main-page', { projectId: 'alpha', url: 'localhost:5173' })).toEqual({ ok: true })
    expect(await call(browser.CHANNELS.bounds, 'main-page', { tabId, bounds: { x: 0, y: 0, width: 10, height: 10 } })).toEqual({
      ok: true,
    })
    expect(await call(browser.CHANNELS.go, 'main-page', { tabId, action: 'back' })).toEqual({ ok: true })
    expect(await call(browser.CHANNELS.clearData, 'main-page', { projectId: 'alpha' })).toEqual({ ok: true })
    expect(await call(browser.CHANNELS.capture, 'subframe', { tabId })).toEqual({ ok: false, error: 'shell-refused' })
    expect(calls).toEqual([
      ['open', { projectId: 'alpha', url: 'localhost:5173' }],
      ['setBounds', { tabId, bounds: { x: 0, y: 0, width: 10, height: 10 } }],
      ['go', { tabId, action: 'back' }],
      ['clearData', { projectId: 'alpha' }],
    ])
  })

  it('exposes latchShell.browser through the real preload, checking every argument and every event', async () => {
    const invoke = vi.fn(async (..._args: unknown[]) => ({ ok: true }))
    const listeners = new Map<string, (event: unknown, value: unknown) => void>()
    let shell: { browser: PreloadBrowser } | undefined
    const source = await readFile('apps/desktop/src/preload.cjs', 'utf8')
    runInNewContext(source, {
      process: { platform: 'darwin' },
      require: (name: string) => {
        if (name !== 'electron') throw new Error('unexpected preload import')
        return {
          contextBridge: {
            exposeInMainWorld: (_name: string, value: typeof shell) => {
              shell = value
            },
          },
          ipcRenderer: {
            invoke,
            on: (channel: string, listener: (event: unknown, value: unknown) => void) => listeners.set(channel, listener),
            removeListener: (channel: string) => listeners.delete(channel),
          },
          webUtils: { getPathForFile: () => '' },
        }
      },
    })
    const api = shell!.browser
    expect(api.protocolVersion).toBe(browser.PROTOCOL_VERSION)
    expect(Object.keys(api)).toEqual([
      'protocolVersion',
      'open',
      'close',
      'navigate',
      'back',
      'forward',
      'reload',
      'stop',
      'setBounds',
      'occlude',
      'focus',
      'capture',
      'annotate',
      'zoom',
      'devTools',
      'clearData',
      'state',
      'subscribe',
    ])
    for (const channel of Object.values(browser.CHANNELS)) expect(source).toContain(`'${channel}'`)
    const tabId = `brw_${'c'.repeat(22)}`
    const invalid = { ok: false, error: 'invalid' }
    for (const refused of [
      api.open('../x'),
      api.open('alpha', 42),
      api.open('alpha', ''),
      api.close('brw_short'),
      api.navigate(tabId, 'x'.repeat(2049)),
      api.setBounds(tabId, { x: 1, y: 2, width: 3, height: 4, z: 5 }),
      api.setBounds(tabId, { x: 1, y: 2, width: Number.NaN, height: 4 }),
      api.occlude(tabId, 'yes'),
      api.annotate(tabId, { x: -1, y: 2 }),
      api.annotate(tabId, { x: 1, y: 2, z: 3 }),
      api.zoom(tabId, 'huge'),
      api.clearData('../x'),
      api.back(7),
    ])
      expect(await refused).toEqual(invalid)
    expect(invoke).not.toHaveBeenCalled()
    await api.open('alpha')
    await api.open('alpha', 'localhost:5173')
    await api.setBounds(tabId, { x: 1, y: 2, width: 3, height: 4 })
    await api.setBounds(tabId, null)
    await api.annotate(tabId, { x: 5, y: 6 })
    await api.reload(tabId)
    await api.zoom(tabId, 'out')
    await api.occlude(tabId, false)
    expect(invoke.mock.calls).toEqual([
      ['latch:browser:open', { projectId: 'alpha', url: null }],
      ['latch:browser:open', { projectId: 'alpha', url: 'localhost:5173' }],
      ['latch:browser:bounds', { tabId, bounds: { x: 1, y: 2, width: 3, height: 4 } }],
      ['latch:browser:bounds', { tabId, bounds: null }],
      ['latch:browser:annotate', { tabId, point: { x: 5, y: 6 } }],
      ['latch:browser:go', { tabId, action: 'reload' }],
      ['latch:browser:zoom', { tabId, direction: 'out' }],
      ['latch:browser:occlude', { tabId, occluded: false }],
    ])
    const received = vi.fn()
    const unsubscribe = api.subscribe(received)
    const deliver = (value: unknown) => listeners.get('latch:browser:event')!({ sender: 'main' }, value)
    const state = {
      url: 'http://localhost:5173/',
      title: 'Vite',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      zoom: 1,
      crashed: false,
      error: null,
    }
    deliver({ tabId, type: 'state', state })
    deliver({ tabId, type: 'state', state: { ...state, url: 'x'.repeat(8193) } })
    deliver({ tabId, type: 'state', state: { ...state, error: 'boom' } })
    deliver({ tabId: 'brw_short', type: 'closed' })
    deliver({ tabId, type: 'exec', code: 'x' })
    deliver({ tabId, type: 'notice', notice: 'permission', detail: 'geolocation' })
    deliver({ tabId, type: 'notice', notice: 'permission', detail: '<img onerror>' })
    deliver({ tabId, type: 'notice', notice: 'shell' })
    deliver({ tabId, type: 'closed', extra: true })
    expect(received.mock.calls).toEqual([
      [{ type: 'state', tabId, state }],
      [{ type: 'notice', tabId, notice: 'permission', detail: 'geolocation' }],
      [{ type: 'notice', tabId, notice: 'permission' }],
      [{ type: 'closed', tabId }],
    ])
    unsubscribe()
    expect(listeners.has('latch:browser:event')).toBe(false)
  })
})
