import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { Window as HappyWindow } from 'happy-dom'
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
  blockHost(state: unknown, info?: unknown): void
  attach(window: unknown): void
  open(input: { projectId: string; sessionId: string; url: string | null }): Result & { tabId?: string }
  list(): Result
  viewport(input: { tabId: string; preset: string; rotated: boolean }): Result
  colorScheme(input: { tabId: string; scheme: string }): Promise<Result>
  hitTest(input: { tabId: string; point: { x: number; y: number } }): Promise<Result>
  logs(input: { tabId: string }): Result
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
  LOG_REPORTED: number
  SANDBOX_WARNING: string
  ELECTRON_CSP_WARNING: string
  latchOwnWarning(level: string, message: unknown): boolean
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
  hitOf(raw: unknown): { tag: string; rect: object } | undefined
  hitTestScript(x: number, y: number): string
  viewportSize(viewport: { preset: string; rotated: boolean }): { width: number; height: number } | null
  emulationScale(size: { width: number; height: number } | null, bounds: { width: number; height: number } | null): number
  logUrl(raw: unknown): string
  consoleText(raw: unknown): string
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
  open(projectId?: unknown, sessionId?: unknown, url?: unknown): Promise<unknown>
  list(): Promise<unknown>
  hitTest(tabId: unknown, point: unknown): Promise<unknown>
  setViewport(tabId: unknown, preset: unknown, rotated: unknown): Promise<unknown>
  setColorScheme(tabId: unknown, scheme: unknown): Promise<unknown>
  logs(tabId: unknown): Promise<unknown>
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
/** A query that carries a credential's value, which no list may keep (spelled apart for the repository's secret scan). */
const QUERY = ['to', 'ken=fixture-value'].join('')
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

type RequestDetails = Record<string, unknown> & { url: string; webContentsId?: number }
class FakeSession extends EventEmitter {
  completed?: (details: RequestDetails) => void
  errorOccurred?: (details: RequestDetails) => void
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
    onCompleted: (listener: FakeSession['completed']) => {
      this.completed = listener
    },
    onErrorOccurred: (listener: FakeSession['errorOccurred']) => {
      this.errorOccurred = listener
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
  allows(url: string, webContentsId?: number, extra: Record<string, unknown> = {}): boolean {
    let cancel = true
    this.beforeRequest?.({ url, ...extra, ...(webContentsId === undefined ? {} : { webContentsId }) }, response => {
      cancel = response.cancel
    })
    return !cancel
  }
}

/** The tab's debugger, which main attaches only for 外观. */
class FakeDebugger extends EventEmitter {
  attached = false
  commands: Array<[string, unknown]> = []
  failAttach = false
  isAttached() {
    return this.attached
  }
  attach(version: string) {
    if (this.failAttach) throw new Error('Another debugger is already attached')
    this.attached = version === '1.3'
  }
  detach() {
    this.attached = false
    this.emit('detach', {}, 'target closed')
  }
  sendCommand(method: string, params: unknown) {
    this.commands.push([method, params])
    return Promise.resolve({})
  }
}

let nextContentsId = 100
class FakeContents extends EventEmitter {
  readonly debugger = new FakeDebugger()
  emulation: Array<Record<string, unknown> | null> = []
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
    return Promise.resolve(
      typeof this.isolatedResult === 'function' ? (this.isolatedResult as (code: string) => unknown)(scripts[0].code) : this.isolatedResult,
    )
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
  throttled = true
  setBackgroundThrottling(allowed: boolean) {
    this.throttled = allowed
  }
  typed: string[] = []
  insertText(text: string) {
    this.typed.push(text)
    return Promise.resolve()
  }
  audioMuted = false
  setAudioMuted(muted: boolean) {
    this.audioMuted = muted
  }
  enableDeviceEmulation(parameters: Record<string, unknown>) {
    this.emulation.push(parameters)
  }
  disableDeviceEmulation() {
    this.emulation.push(null)
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
  const open = (url: string | null = 'localhost:5173', projectId = 'alpha', sessionId = 'ses_one') => {
    const result = controller.open({ projectId, sessionId, url })
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
    const sessionId = 'ses_one'
    expect(INPUTS.open({ projectId: 'alpha', sessionId, url: null })).toEqual({ projectId: 'alpha', sessionId, url: null })
    expect(INPUTS.open({ projectId: 'alpha', sessionId, url: 'localhost:5173' })).toEqual({
      projectId: 'alpha',
      sessionId,
      url: 'localhost:5173',
    })
    for (const bad of [
      { projectId: '../alpha', sessionId, url: null },
      { projectId: 'alpha', url: null },
      { projectId: 'alpha', sessionId: '../x', url: null },
      { projectId: 'alpha', sessionId: '', url: null },
      { projectId: 'alpha', sessionId },
      { projectId: 'alpha', sessionId, url: null, preload: '/tmp/x.js' },
      { projectId: 'alpha', sessionId, url: 'x'.repeat(2049) },
      Object.create({ projectId: 'alpha', sessionId, url: null }),
      null,
      'alpha',
    ])
      expect(INPUTS.open(bad)).toBeUndefined()
    expect(INPUTS.none({})).toEqual({})
    for (const bad of [{ tabId }, null, Object.create(null, { x: { value: 1, enumerable: true } })])
      expect(INPUTS.none(bad)).toBeUndefined()
    expect(INPUTS.viewport({ tabId, preset: 'phone', rotated: true })).toEqual({ tabId, preset: 'phone', rotated: true })
    expect(INPUTS.viewport({ tabId, preset: 'fit', rotated: false })).toEqual({ tabId, preset: 'fit', rotated: false })
    for (const bad of [
      { tabId, preset: 'watch', rotated: false },
      { tabId, preset: 'phone' },
      { tabId, preset: 'phone', rotated: 'yes' },
      { tabId, preset: 'phone', rotated: false, width: 10 },
      { tabId: 'brw_x', preset: 'phone', rotated: false },
    ])
      expect(INPUTS.viewport(bad)).toBeUndefined()
    expect(INPUTS.colorScheme({ tabId, scheme: 'dark' })).toEqual({ tabId, scheme: 'dark' })
    for (const bad of [{ tabId, scheme: 'sepia' }, { tabId }, { tabId, scheme: 'dark', media: 'print' }])
      expect(INPUTS.colorScheme(bad)).toBeUndefined()
    expect(INPUTS.hitTest({ tabId, point: { x: 1, y: 2 } })).toEqual({ tabId, point: { x: 1, y: 2 } })
    for (const bad of [{ tabId, point: { x: -1, y: 2 } }, { tabId, point: { x: 1, y: 2, z: 3 } }, { tabId }])
      expect(INPUTS.hitTest(bad)).toBeUndefined()
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
    const sessionId = 'ses_one'
    expect(controller.open({ projectId: 'alpha', sessionId, url: 'file:///etc/hosts' })).toEqual({ ok: false, error: 'invalid-url' })
    expect(controller.open({ projectId: 'alpha', sessionId, url: `${HOST}:4317` })).toEqual({ ok: false, error: 'blocked', reason: 'host' })
    expect(controller.open({ projectId: 'alpha', sessionId, url: '127.0.0.1:4317' })).toEqual({
      ok: false,
      error: 'blocked',
      reason: 'host',
    })
    expect(window.children).toHaveLength(0)
    for (let index = 0; index < browser.TAB_LIMIT; index++)
      expect(controller.open({ projectId: 'alpha', sessionId: `ses_${index % 2}`, url: null }).ok).toBe(true)
    expect(controller.open({ projectId: 'alpha', sessionId: 'ses_new', url: null })).toEqual({ ok: false, error: 'tab-limit' })
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
          viewport: { preset: 'fit', rotated: false },
          colorScheme: 'system',
          logs: { errors: 0, warnings: 0, failed: 0 },
          opener: 'person',
          control: null,
          activity: null,
        },
      },
    ])
    expect(controller.state({ tabId })).toMatchObject({ ok: true, state: { error: -202 } })
    expect(controller.navigate({ tabId, url: 'example.com' })).toEqual({ ok: true, url: 'https://example.com/' })
    expect(controller.navigate({ tabId, url: 'javascript:alert(1)' })).toEqual({ ok: false, error: 'invalid-url' })
    expect(controller.navigate({ tabId, url: `${HOST}:5173` })).toEqual({ ok: false, error: 'blocked', reason: 'host' })
    expect(controller.state({ tabId })).toMatchObject({ ok: true, state: { error: null } })
  })

  it('keeps tabs, hidden, when the page reloads or its renderer goes; ends them with the window or when a guest closes', async () => {
    const { controller, open, window, events } = setup()
    controller.attach(window)
    const first = open()
    const second = open('localhost:3000', 'beta', 'ses_two')
    first.contents.close()
    expect(window.children).toEqual([second.view])
    expect(events('closed')).toEqual([{ tabId: first.tabId, type: 'closed' }])
    expect(controller.state({ tabId: first.tabId })).toEqual({ ok: false, error: 'not-found' })
    controller.setBounds({ tabId: second.tabId, bounds: { x: 0, y: 0, width: 300, height: 300 } })
    await controller.occlude({ tabId: second.tabId, occluded: true })
    controller.setBounds({ tabId: second.tabId, bounds: { x: 0, y: 0, width: 300, height: 300 } })
    second.contents.focused = true
    await controller.occlude({ tabId: second.tabId, occluded: false })
    // A navigation that only starts (and that the app's rules may refuse) leaves the tabs where they are.
    window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(second.view.visible).toBe(true)
    expect(second.contents.audioMuted).toBe(false)
    window.webContents.emit('did-navigate')
    // Still there, hidden and without the keyboard, until the page that comes back lists and places it.
    expect(window.children).toEqual([second.view])
    expect(second.contents.destroyed).toBe(false)
    expect(second.view.visible).toBe(false)
    expect(window.webContents.focused).toBe(true)
    // Out of sight it is muted, and the page hears it was hidden so it places it again from scratch.
    expect(second.contents.audioMuted).toBe(true)
    expect(events('hidden')).toEqual([{ tabId: second.tabId, type: 'hidden' }])
    expect(controller.list()).toEqual({
      ok: true,
      tabs: [
        { tabId: second.tabId, projectId: 'beta', sessionId: 'ses_two', state: expect.objectContaining({ url: 'http://localhost:3000/' }) },
      ],
    })
    // Not occluded any more: placing it shows it at once.
    controller.setBounds({ tabId: second.tabId, bounds: { x: 0, y: 0, width: 300, height: 300 } })
    expect(second.view.visible).toBe(true)
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(second.view.visible).toBe(false)
    expect(second.contents.destroyed).toBe(false)
    expect(controller.close({ tabId: second.tabId })).toEqual({ ok: true })
    const third = open()
    expect(controller.close({ tabId: third.tabId })).toEqual({ ok: true })
    expect(controller.close({ tabId: third.tabId })).toEqual({ ok: false, error: 'not-found' })
    const fourth = open()
    window.destroyed = true
    window.emit('closed')
    expect(fourth.contents.destroyed).toBe(true)
  })
})

describe('preview browser, version 2', () => {
  it('shuts the model gateway port host-info names, on any local name, and nothing for a malformed port', () => {
    const { controller, sessions, open } = setup()
    open()
    const session = sessions.get('latch-preview-alpha')!
    expect(session.allows('http://127.0.0.1:47123/v1/chat/completions')).toBe(true)
    controller.blockHost({ loopbackOrigin: `http://${HOST}:4317` }, { modelGatewayPort: 47123 })
    for (const url of ['http://127.0.0.1:47123/v1/chat/completions', 'http://localhost:47123/', 'ws://[::1]:47123/'])
      expect(session.allows(url), url).toBe(false)
    controller.blockHost(undefined, { modelGatewayPort: '47124' })
    controller.blockHost(undefined, { modelGatewayPort: 70_000 })
    expect(session.allows('http://127.0.0.1:47124/')).toBe(true)
    expect(verdict({ url: 'http://localhost:47123/', kind: 'typed' })).toEqual({ ok: true })
    expect(controller.navigate({ tabId: open().tabId, url: 'localhost:47123' })).toEqual({ ok: false, error: 'blocked', reason: 'host' })
  })

  it('lists every tab of the window with its session and project, and ties each new tab to its session', () => {
    const { controller, open } = setup()
    expect(controller.list()).toEqual({ ok: true, tabs: [] })
    const one = open('localhost:5173', 'alpha', 'ses_one')
    const two = open(null, 'alpha', 'ses_two')
    expect(controller.list()).toMatchObject({
      ok: true,
      tabs: [
        { tabId: one.tabId, projectId: 'alpha', sessionId: 'ses_one', state: { url: 'http://localhost:5173/' } },
        { tabId: two.tabId, projectId: 'alpha', sessionId: 'ses_two', state: { url: '' } },
      ],
    })
  })

  it('lays a preset out at its size, scaled into the view and never up, turned when rotated, and back to the panel', () => {
    expect(browser.viewportSize({ preset: 'phone', rotated: false })).toEqual({ width: 390, height: 844 })
    expect(browser.viewportSize({ preset: 'phone', rotated: true })).toEqual({ width: 844, height: 390 })
    expect(browser.viewportSize({ preset: 'fit', rotated: true })).toBeNull()
    expect(browser.emulationScale({ width: 390, height: 844 }, { width: 195, height: 422 })).toBe(0.5)
    expect(browser.emulationScale({ width: 390, height: 844 }, { width: 2000, height: 2000 })).toBe(1)
    const { controller, open, events } = setup()
    const { tabId, contents } = open()
    expect(controller.viewport({ tabId, preset: 'phone', rotated: false })).toMatchObject({
      ok: true,
      viewport: { preset: 'phone', rotated: false },
      size: { width: 390, height: 844 },
    })
    controller.setBounds({ tabId, bounds: { x: 100, y: 100, width: 195, height: 422 } })
    expect(contents.emulation.at(-1)).toEqual({
      screenPosition: 'mobile',
      screenSize: { width: 390, height: 844 },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: { width: 390, height: 844 },
      scale: 0.5,
    })
    controller.viewport({ tabId, preset: 'desktop', rotated: true })
    expect(contents.emulation.at(-1)).toMatchObject({ screenPosition: 'desktop', viewSize: { width: 800, height: 1280 } })
    // A new document keeps it.
    const before = contents.emulation.length
    contents.emit('did-navigate')
    expect(contents.emulation).toHaveLength(before + 1)
    // 适应面板 cannot be rotated, and ends the emulation.
    expect(controller.viewport({ tabId, preset: 'fit', rotated: true })).toMatchObject({
      ok: true,
      viewport: { preset: 'fit', rotated: false },
    })
    expect(contents.emulation.at(-1)).toBeNull()
    expect(controller.state({ tabId })).toMatchObject({ ok: true, state: { viewport: { preset: 'fit', rotated: false } } })
    expect(controller.viewport({ tabId: `brw_${'z'.repeat(22)}`, preset: 'phone', rotated: false })).toEqual({
      ok: false,
      error: 'not-found',
    })
    expect(events('state')).toBeDefined()
  })

  it('finds the element under a point with the preset scale, and annotates through it too', async () => {
    const { controller, open, window } = setup()
    const { tabId, contents } = open()
    window.webContents.zoom = 1
    controller.viewport({ tabId, preset: 'phone', rotated: false })
    controller.setBounds({ tabId, bounds: { x: 0, y: 0, width: 195, height: 422 } })
    contents.isolatedResult = { tag: 'BUTTON', rect: { x: 20, y: 40, width: 100, height: 20 } }
    const hit = await controller.hitTest({ tabId, point: { x: 10, y: 20 } })
    expect(contents.isolated.at(-1)!.world).toBe(browser.ANNOTATION_WORLD)
    // The page's point 10,20 is the guest's 20,40 at half scale; the box comes back halved.
    expect(contents.isolated.at(-1)!.code).toContain('"x":20,"y":40')
    expect(contents.isolated.at(-1)!.code).not.toContain('selector')
    expect(hit).toEqual({ ok: true, target: { tag: 'button', rect: { x: 10, y: 20, width: 50, height: 10 } } })
    contents.isolatedResult = { tag: 'button', rect: { x: 1, y: 2, width: 3, height: 4 }, text: 'secret' }
    expect(await controller.hitTest({ tabId, point: { x: 1, y: 1 } })).toEqual({ ok: false, error: 'no-target' })
    expect(browser.hitOf({ tag: '<img>', rect: { x: 0, y: 0, width: 1, height: 1 } })).toBeUndefined()
    // One hit test at a time; a second one meanwhile is answered busy.
    let finish: (value: unknown) => void = () => {}
    contents.executeJavaScriptInIsolatedWorld = () =>
      new Promise(done => {
        finish = done
      })
    const first = controller.hitTest({ tabId, point: { x: 1, y: 1 } })
    expect(await controller.hitTest({ tabId, point: { x: 1, y: 1 } })).toEqual({ ok: false, error: 'busy' })
    finish({ tag: 'p', rect: { x: 0, y: 0, width: 2, height: 2 } })
    expect(await first).toMatchObject({ ok: true, target: { tag: 'p' } })
    contents.executeJavaScriptInIsolatedWorld = (world: number, scripts: Array<{ code: string }>) => {
      contents.isolated.push({ world, code: scripts[0]!.code })
      return Promise.resolve({ tag: 'button', selector: '#save', text: '保存', rect: { x: 20, y: 40, width: 100, height: 20 } })
    }
    const marked = await controller.annotate({ tabId, point: { x: 10, y: 20 } })
    expect(contents.isolated.at(-1)!.code).toContain('"x":20,"y":40')
    expect(marked).toMatchObject({ ok: true, target: { selector: '#save', rect: { x: 10, y: 20, width: 50, height: 10 } } })
  })

  it('emulates the color scheme through the tab’s own debugger only while one is chosen, and says when it cannot', async () => {
    const { controller, open } = setup()
    const { tabId, contents } = open()
    expect(await controller.colorScheme({ tabId, scheme: 'dark' })).toEqual({ ok: true, colorScheme: 'dark' })
    expect(contents.debugger.attached).toBe(true)
    expect(contents.debugger.commands).toEqual([
      ['Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }],
    ])
    contents.emit('did-navigate')
    await new Promise(done => setTimeout(done, 0))
    expect(contents.debugger.commands).toHaveLength(2)
    expect(controller.state({ tabId })).toMatchObject({ ok: true, state: { colorScheme: 'dark' } })
    expect(await controller.colorScheme({ tabId, scheme: 'system' })).toEqual({ ok: true, colorScheme: 'system' })
    expect(contents.debugger.attached).toBe(false)
    expect(contents.debugger.commands.at(-1)).toEqual([
      'Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: '' }] },
    ])
    // Someone else's debugger session: no emulation, and the tab follows the system.
    contents.debugger.failAttach = true
    expect(await controller.colorScheme({ tabId, scheme: 'light' })).toEqual({ ok: false, error: 'emulation-failed' })
    expect(controller.state({ tabId })).toMatchObject({ ok: true, state: { colorScheme: 'system' } })
    contents.debugger.failAttach = false
    await controller.colorScheme({ tabId, scheme: 'light' })
    // A command that fails after main attached: main detaches again, and the tab follows the system.
    await controller.colorScheme({ tabId, scheme: 'system' })
    const send = contents.debugger.sendCommand.bind(contents.debugger)
    contents.debugger.sendCommand = () => Promise.reject(new Error('target closed'))
    expect(await controller.colorScheme({ tabId, scheme: 'dark' })).toEqual({ ok: false, error: 'emulation-failed' })
    expect(contents.debugger.attached).toBe(false)
    expect(controller.state({ tabId })).toMatchObject({ ok: true, state: { colorScheme: 'system' } })
    contents.debugger.sendCommand = send
    // Quick choices run one at a time and end on the last: attached and dark, never detached with dark chosen.
    const quick = [
      controller.colorScheme({ tabId, scheme: 'dark' }),
      controller.colorScheme({ tabId, scheme: 'system' }),
      controller.colorScheme({ tabId, scheme: 'dark' }),
    ]
    await Promise.all(quick)
    expect(contents.debugger.attached).toBe(true)
    expect(contents.debugger.commands.at(-1)).toEqual([
      'Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: 'dark' }] },
    ])
    expect(controller.state({ tabId })).toMatchObject({ ok: true, state: { colorScheme: 'dark' } })
    // The debugger going away (developer tools taking over) puts the tab back on the system's scheme.
    contents.debugger.attached = false
    contents.debugger.emit('detach', {}, 'replaced')
    expect(controller.state({ tabId })).toMatchObject({ ok: true, state: { colorScheme: 'system' } })
  })

  it('keeps the console and the request summaries per tab, bounded, cut and without queries, and counts what failed', async () => {
    const { controller, open, sessions, events } = setup()
    const { tabId, contents } = open()
    const other = open('localhost:3000')
    const session = sessions.get('latch-preview-alpha')!
    contents.emit('console-message', {
      level: 'error',
      message: `bad ${'x'.repeat(900)}‮\nsecond line`,
      lineNumber: 12,
      sourceId: `http://localhost:5173/src/app.ts?${QUERY}`,
    })
    contents.emit('console-message', { level: 'warning', message: 'careful', lineNumber: -1, sourceId: '' })
    contents.emit('console-message', { level: 'verbose', message: 42 })
    // Warnings only a Latch preview shows: left out, matched exactly.
    contents.emit('console-message', { level: 'warning', message: browser.SANDBOX_WARNING })
    contents.emit('console-message', { level: 'warning', message: browser.ELECTRON_CSP_WARNING })
    session.allows(`http://localhost:5173/api/items?${QUERY}`, contents.id, { id: 1, timestamp: 1000 })
    session.completed?.({
      id: 1,
      url: `http://localhost:5173/api/items?${QUERY}`,
      method: 'POST',
      webContentsId: contents.id,
      resourceType: 'xhr',
      statusCode: 500,
      timestamp: 1042,
      responseHeaders: { 'Content-Length': ['123'], 'Set-Cookie': ['sid=1'] },
    })
    session.errorOccurred?.({
      id: 2,
      url: 'http://127.0.0.1:4317/link/api/health',
      method: 'GET',
      webContentsId: contents.id,
      resourceType: 'other',
      timestamp: 2000,
      error: 'net::ERR_BLOCKED_BY_CLIENT',
    })
    session.completed?.({
      id: 3,
      url: 'http://localhost:3000/',
      method: 'GET',
      webContentsId: other.contents.id,
      resourceType: 'mainFrame',
      statusCode: 200,
      timestamp: 1,
    })
    session.completed?.({ id: 4, url: 'http://elsewhere/', method: 'GET', webContentsId: 999_999, statusCode: 200, timestamp: 1 })
    const logs = controller.logs({ tabId }) as unknown as {
      console: Array<Record<string, unknown>>
      network: Array<Record<string, unknown>>
    }
    expect(logs.console).toHaveLength(3)
    const [first, second, third] = logs.console
    expect(first).toMatchObject({ level: 'error', line: 12, source: 'http://localhost:5173/src/app.ts' })
    expect(String(first!.text).length).toBeLessThanOrEqual(500)
    expect(String(first!.text)).not.toContain('‮')
    expect(second).toMatchObject({ level: 'warning', text: 'careful', line: 0, source: '' })
    expect(third).toMatchObject({ level: 'info', text: '' })
    expect(logs.network).toEqual([
      {
        id: 1,
        method: 'POST',
        url: 'http://localhost:5173/api/items',
        type: 'xhr',
        status: 500,
        error: null,
        duration: 42,
        size: 123,
        time: 1042,
      },
      {
        id: 2,
        method: 'GET',
        url: 'http://127.0.0.1:4317/link/api/health',
        type: 'other',
        status: null,
        error: 'ERR_BLOCKED_BY_CLIENT',
        duration: null,
        size: null,
        time: 2000,
      },
    ])
    expect(JSON.stringify(logs)).not.toContain('fixture-value')
    expect(JSON.stringify(logs)).not.toContain('sid=1')
    expect(controller.state({ tabId })).toMatchObject({ ok: true, state: { logs: { errors: 1, warnings: 1, failed: 2 } } })
    expect(controller.logs({ tabId: other.tabId })).toMatchObject({ ok: true, console: [], network: [{ url: 'http://localhost:3000/' }] })
    await new Promise(done => setTimeout(done, 60))
    expect(events('state').some(event => (event.state as { logs: { errors: number } }).logs.errors === 1)).toBe(true)
    // Each tab keeps the newest 500 and hands the page the last 200.
    // Running counts follow what the ring pushes out; IDs keep rising.
    for (let index = 0; index < 600; index++)
      contents.emit('console-message', { level: index === 0 || index >= 590 ? 'error' : 'info', message: `line ${index}` })
    expect(controller.state({ tabId })).toMatchObject({ ok: true, state: { logs: { errors: 10, warnings: 0 } } })
    const many = controller.logs({ tabId }) as unknown as { console: Array<{ id: number; text: string }> }
    expect(many.console).toHaveLength(browser.LOG_REPORTED)
    expect(many.console.at(-1)).toMatchObject({ id: 603, text: 'line 599' })
    expect(many.console.at(0)!.id).toBe(404)
    for (let index = 0; index < 500; index++) contents.emit('console-message', { level: 'info', message: 'more' })
    expect(controller.state({ tabId })).toMatchObject({ ok: true, state: { logs: { errors: 0, warnings: 0 } } })
    // A new document starts the lists again.
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'http://localhost:5173/', initiator: null })
    expect(controller.logs({ tabId })).toMatchObject({ ok: true, console: [], network: [] })
    expect(browser.logUrl('data:text/html,<b>x</b>')).toBe('data:…')
    expect(browser.logUrl('not a url')).toBe('')
    expect(browser.logUrl(`http://${['user', 'pass'].join(':')}@localhost:5173/x?y=1`)).toBe('http://localhost:5173/x')
    expect(browser.consoleText(`a\u00adb\u200b${String.fromCodePoint(0xe0041)}c\ufe0fd`)).toBe('a b  c d')
    expect(browser.consoleText('a\r\nb')).toBe('a\nb')
    expect(browser.latchOwnWarning('warning', browser.SANDBOX_WARNING)).toBe(true)
    expect(browser.latchOwnWarning('error', browser.SANDBOX_WARNING)).toBe(false)
    expect(browser.latchOwnWarning('warning', `${browser.SANDBOX_WARNING} `)).toBe(false)
    expect(browser.latchOwnWarning('warning', browser.ELECTRON_CSP_WARNING.slice(0, 60))).toBe(false)
  })

  it('forwards ⇧⌘B and ⇧⌘S from a focused tab, and still no other shifted chord', () => {
    expect(browser.forwardedShortcut(keyDown('KeyB', { shift: true }), 'darwin')).toMatchObject({ keyCode: 'B', shift: true })
    expect(browser.forwardedShortcut(keyDown('KeyS', { shift: true }), 'darwin')).toMatchObject({ keyCode: 'S', shift: true })
    expect(browser.forwardedShortcut(keyDown('KeyS'), 'darwin')).toBeUndefined()
    expect(browser.forwardedShortcut(keyDown('KeyK', { shift: true }), 'darwin')).toBeUndefined()
    const { open, window } = setup()
    const { contents } = open()
    const event = { preventDefault: vi.fn() }
    contents.emit('before-input-event', event, keyDown('KeyS', { shift: true }))
    expect(event.preventDefault).toHaveBeenCalled()
    expect(window.webContents.inputs.at(-1)).toEqual({ type: 'keyUp', keyCode: 'S', modifiers: ['meta', 'shift'] })
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
    const sessionId = 'ses_one'
    expect(await call(browser.CHANNELS.open, 'guest', { projectId: 'alpha', sessionId, url: null })).toEqual({
      ok: false,
      error: 'shell-refused',
    })
    expect(await call(browser.CHANNELS.open, 'main-page', { projectId: 'alpha', sessionId, url: null, preload: 'x' })).toEqual({
      ok: false,
      error: 'invalid',
    })
    expect(await call(browser.CHANNELS.open, 'main-page', { projectId: 'alpha', sessionId, url: 'localhost:5173' })).toEqual({ ok: true })
    expect(await call(browser.CHANNELS.list, 'guest', {})).toEqual({ ok: false, error: 'shell-refused' })
    expect(await call(browser.CHANNELS.list, 'main-page', { all: true })).toEqual({ ok: false, error: 'invalid' })
    expect(await call(browser.CHANNELS.list, 'main-page', {})).toEqual({ ok: true })
    expect(await call(browser.CHANNELS.viewport, 'main-page', { tabId, preset: 'tablet', rotated: true })).toEqual({ ok: true })
    expect(await call(browser.CHANNELS.colorScheme, 'main-page', { tabId, scheme: 'print' })).toEqual({ ok: false, error: 'invalid' })
    expect(await call(browser.CHANNELS.colorScheme, 'main-page', { tabId, scheme: 'dark' })).toEqual({ ok: true })
    expect(await call(browser.CHANNELS.hitTest, 'main-page', { tabId, point: { x: 3, y: 4 } })).toEqual({ ok: true })
    expect(await call(browser.CHANNELS.logs, 'main-page', { tabId })).toEqual({ ok: true })
    expect(await call(browser.CHANNELS.logs, 'subframe', { tabId })).toEqual({ ok: false, error: 'shell-refused' })
    expect(await call(browser.CHANNELS.bounds, 'main-page', { tabId, bounds: { x: 0, y: 0, width: 10, height: 10 } })).toEqual({
      ok: true,
    })
    expect(await call(browser.CHANNELS.go, 'main-page', { tabId, action: 'back' })).toEqual({ ok: true })
    expect(await call(browser.CHANNELS.clearData, 'main-page', { projectId: 'alpha' })).toEqual({ ok: true })
    expect(await call(browser.CHANNELS.capture, 'subframe', { tabId })).toEqual({ ok: false, error: 'shell-refused' })
    expect(calls).toEqual([
      ['open', { projectId: 'alpha', sessionId, url: 'localhost:5173' }],
      ['list', undefined],
      ['viewport', { tabId, preset: 'tablet', rotated: true }],
      ['colorScheme', { tabId, scheme: 'dark' }],
      ['hitTest', { tabId, point: { x: 3, y: 4 } }],
      ['logs', { tabId }],
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
      'list',
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
      'hitTest',
      'setViewport',
      'setColorScheme',
      'logs',
      'zoom',
      'devTools',
      'clearData',
      'state',
      'takeOver',
      'handBack',
      'showing',
      'subscribe',
    ])
    for (const channel of Object.values(browser.CHANNELS)) expect(source).toContain(`'${channel}'`)
    const tabId = `brw_${'c'.repeat(22)}`
    const invalid = { ok: false, error: 'invalid' }
    for (const refused of [
      api.open('../x', 'ses_one'),
      api.open('alpha'),
      api.open('alpha', '../ses'),
      api.open('alpha', 'ses_one', 42),
      api.open('alpha', 'ses_one', ''),
      api.hitTest(tabId, { x: 1 }),
      api.hitTest(tabId, { x: 1, y: Number.POSITIVE_INFINITY }),
      api.setViewport(tabId, 'watch', false),
      api.setViewport(tabId, 'phone', 'yes'),
      api.setColorScheme(tabId, 'sepia'),
      api.logs('brw_short'),
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
    await api.open('alpha', 'ses_one')
    await api.open('alpha', 'ses_one', 'localhost:5173')
    await api.list()
    await api.hitTest(tabId, { x: 7, y: 8 })
    await api.setViewport(tabId, 'phone', true)
    await api.setColorScheme(tabId, 'dark')
    await api.logs(tabId)
    await api.setBounds(tabId, { x: 1, y: 2, width: 3, height: 4 })
    await api.setBounds(tabId, null)
    await api.annotate(tabId, { x: 5, y: 6 })
    await api.reload(tabId)
    await api.zoom(tabId, 'out')
    await api.occlude(tabId, false)
    expect(await (api as unknown as { takeOver(tabId: unknown): Promise<unknown> }).takeOver('brw_short')).toEqual(invalid)
    await (api as unknown as { takeOver(tabId: unknown): Promise<unknown> }).takeOver(tabId)
    await (api as unknown as { handBack(tabId: unknown): Promise<unknown> }).handBack(tabId)
    expect(invoke.mock.calls).toEqual([
      ['latch:browser:open', { projectId: 'alpha', sessionId: 'ses_one', url: null }],
      ['latch:browser:open', { projectId: 'alpha', sessionId: 'ses_one', url: 'localhost:5173' }],
      ['latch:browser:list', {}],
      ['latch:browser:hit-test', { tabId, point: { x: 7, y: 8 } }],
      ['latch:browser:viewport', { tabId, preset: 'phone', rotated: true }],
      ['latch:browser:color-scheme', { tabId, scheme: 'dark' }],
      ['latch:browser:logs', { tabId }],
      ['latch:browser:bounds', { tabId, bounds: { x: 1, y: 2, width: 3, height: 4 } }],
      ['latch:browser:bounds', { tabId, bounds: null }],
      ['latch:browser:annotate', { tabId, point: { x: 5, y: 6 } }],
      ['latch:browser:go', { tabId, action: 'reload' }],
      ['latch:browser:zoom', { tabId, direction: 'out' }],
      ['latch:browser:occlude', { tabId, occluded: false }],
      ['latch:browser:take-over', { tabId }],
      ['latch:browser:hand-back', { tabId }],
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
      viewport: { preset: 'phone', rotated: false },
      colorScheme: 'dark',
      logs: { errors: 2, warnings: 0, failed: 1 },
    }
    deliver({ tabId, type: 'state', state })
    deliver({ tabId, type: 'state', state: { ...state, url: 'x'.repeat(8193) } })
    deliver({ tabId, type: 'state', state: { ...state, error: 'boom' } })
    deliver({ tabId, type: 'state', state: { ...state, viewport: { preset: 'watch', rotated: false } } })
    deliver({ tabId, type: 'state', state: { ...state, colorScheme: 'sepia' } })
    deliver({ tabId, type: 'state', state: { ...state, logs: { errors: -1, warnings: 0, failed: 0 } } })
    deliver({ tabId: 'brw_short', type: 'closed' })
    deliver({ tabId, type: 'exec', code: 'x' })
    deliver({ tabId, type: 'notice', notice: 'permission', detail: 'geolocation' })
    deliver({ tabId, type: 'notice', notice: 'permission', detail: '<img onerror>' })
    deliver({ tabId, type: 'notice', notice: 'shell' })
    deliver({ tabId, type: 'closed', extra: true })
    deliver({ tabId, type: 'state', state: { ...state, opener: 'agent', control: 'agent', activity: '正在点击「保存」' } })
    deliver({ tabId, type: 'state', state: { ...state, control: 'robot' } })
    deliver({ tabId, type: 'opened', projectId: 'alpha', sessionId: 'ses_two', state })
    deliver({ tabId, type: 'opened', projectId: '../x', sessionId: 'ses_two', state })
    const full = { ...state, opener: 'person', control: null, activity: null }
    expect(received.mock.calls).toEqual([
      [{ type: 'state', tabId, state: full }],
      [{ type: 'notice', tabId, notice: 'permission', detail: 'geolocation' }],
      [{ type: 'notice', tabId, notice: 'permission' }],
      [{ type: 'closed', tabId }],
      [{ type: 'state', tabId, state: { ...state, opener: 'agent', control: 'agent', activity: '正在点击「保存」' } }],
      [{ type: 'opened', tabId, projectId: 'alpha', sessionId: 'ses_two', state: full }],
    ])
    unsubscribe()
    expect(listeners.has('latch:browser:event')).toBe(false)
  })
})

describe('host-info for the preview tabs', () => {
  it('takes the model gateway port only as a port number', () => {
    const { parseHostInfo } = require('../src/host.cjs') as { parseHostInfo(value: unknown): unknown }
    const info = { product: 'Latch', hostId: 'h', instanceId: 'i', pid: 1, devMode: false }
    expect(parseHostInfo({ ...info, modelGatewayPort: 47123 })).toMatchObject({ modelGatewayPort: 47123 })
    expect(parseHostInfo(info)).toMatchObject(info)
    for (const port of ['47123', 0, 70_000, 1.5, null])
      expect(parseHostInfo({ ...info, modelGatewayPort: port }), String(port)).toBeUndefined()
  })
})

const agent = require('../src/browser-agent.cjs') as {
  AGENT_TOOLS: readonly string[]
  AGENT_INPUTS: Record<string, (args: unknown) => boolean>
  callInput(raw: unknown): Record<string, unknown> | undefined
  simpleSelector(text: unknown): boolean
  agentWorld(scope: unknown, epoch: number, limits: Record<string, number>, task: Record<string, unknown>): any
  createAgentRunner(options: Record<string, unknown>): {
    run(call: unknown): Promise<Record<string, any> | undefined>
    cancel(callId: string): void
    turnEnded(sessionId: string): void
    sessionEnded(sessionId: string): void
    report(): Array<Record<string, unknown>>
  }
  createBrowserProvider(options: Record<string, unknown>): {
    start(): void
    stop(): void
    state(): { active: boolean; registered: boolean }
  }
}
const browserLocal = require('../src/browser.cjs') as { agentLocalHost(hostname: string): boolean }

/** The fixture page: a button, an ordinary field, a password field, a one-time code, a hidden field and a frame. */
const AGENT_PAGE = `<h1>本地开发页</h1>
<button id="save">保存设置</button>
<label>名字 <input id="name" value="Latch"></label>
<label>密码 <input id="pw" type="password"></label>
<label>验证码 <textarea id="otp" autocomplete="one-time-code">123456</textarea></label>
<input type="hidden" id="csrf" value="HIDDEN-1">
<iframe id="frame" src="about:blank"></iframe>`

/**
 * A page in happy-dom whose isolated world is the real `agentWorld`: each script main sends is run on it, the way
 * Electron runs it in the tab's isolated world. Boxes are fixed, since happy-dom does not lay out.
 */
function agentPage(html = AGENT_PAGE) {
  const window = new HappyWindow({ url: 'http://localhost:5173/' }) as unknown as any
  window.document.body.innerHTML = html
  let hit: unknown = 'self'
  const boxes = new Map<unknown, { x: number; y: number; width: number; height: number }>()
  window.Element.prototype.getBoundingClientRect = function (this: unknown) {
    return boxes.get(this) ?? { x: 10, y: 20, width: 100, height: 40 }
  }
  let last: unknown
  const original = window.Element.prototype.scrollIntoView
  window.Element.prototype.scrollIntoView = function (this: unknown) {
    last = this
    return original?.call(this)
  }
  window.Document.prototype.elementFromPoint = function () {
    return hit === 'self' ? last : hit
  }
  const run = (code: string) => {
    const at = code.lastIndexOf(', {"kind"')
    const task = JSON.parse(code.slice(at + 2, -1))
    const epoch = Number(/\(globalThis, (\d+),/u.exec(code)![1])
    return agent.agentWorld(window, epoch, { name: 100, value: 200, find: 20 }, task)
  }
  return {
    window,
    run,
    byId: (id: string) => window.document.getElementById(id),
    /** What `elementFromPoint` answers: the element scrolled to (`self`), or another one laid over it. */
    cover: (element: unknown) => (hit = element),
    boxes,
  }
}

describe('the Agent in the preview browser', () => {
  const CALL = '00000000-0000-4000-8000-00000000000'
  let calls = 0
  /** A tab of `ses_one` on localhost showing `html`, in sight, and the runner over the same controller. */
  function agentSetup(html?: string) {
    const base = setup()
    const tab = base.open('localhost:5173')
    tab.contents.url = tab.contents.loads.at(-1) ?? ''
    const dom = agentPage(html)
    tab.contents.isolatedResult = (code: string) => dom.run(code)
    const controller = base.controller as unknown as Record<string, (...args: any[]) => any>
    const runner = agent.createAgentRunner({ access: controller.agentAccess(), controller, now: () => 10_000 })
    controller.showing({ sessionId: 'ses_one' })
    controller.setBounds({ tabId: tab.tabId, bounds: { x: 0, y: 0, width: 800, height: 600 } })
    const call = (tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      runner.run({
        callId: `${CALL}${String(++calls % 10)}`,
        sessionId: 'ses_one',
        projectId: 'alpha',
        tool,
        args: tool === 'browser_open' || tool === 'browser_tabs' ? args : { tabId: tab.tabId, ...args },
        origin: 'http://localhost:5173',
        risk: 'R1',
        deadline: 15_000,
        ...extra,
      })
    /** The reference a read gave the line holding `words`. */
    const refOf = async (words: string) => {
      const read = await call('browser_read', {})
      return /\[(e\d+)\]/u.exec(
        String(read!.text)
          .split('\n')
          .find(line => line.includes(words)) ?? '',
      )![1]!
    }
    return { ...base, ...tab, dom, controller, runner, call, refOf }
  }

  it('carries out a fixed list of actions with exactly their arguments, and nothing the page’s interface has', () => {
    expect(agent.AGENT_TOOLS).toHaveLength(16)
    for (const tool of ['browser_eval', 'browser_devtools', 'browser_clear_data', 'browser_focus', 'browser_annotate', 'browser_cookies'])
      expect(
        agent.callInput({ callId: `${CALL}1`, sessionId: 's', projectId: 'p', tool, args: {}, origin: null, risk: 'R0', deadline: 1 }),
      ).toEqual({ callId: `${CALL}1`, invalid: true })
    const tabId = `brw_${'x'.repeat(22)}`
    expect(agent.AGENT_INPUTS.browser_click!({ tabId, ref: 'e1' })).toBe(true)
    expect(agent.AGENT_INPUTS.browser_click!({ tabId, ref: 'e1', script: 'alert(1)' })).toBe(false)
    expect(agent.AGENT_INPUTS.browser_navigate!({ tabId, url: 'localhost:5173', action: 'back' })).toBe(false)
    expect(agent.AGENT_INPUTS.browser_key!({ tabId, key: 'Meta+Q' })).toBe(false)
    expect(agent.AGENT_INPUTS.browser_find!({ tabId, role: 'button', name: '保存' })).toBe(true)
    expect(agent.AGENT_INPUTS.browser_find!({ tabId, name: '保存' })).toBe(false)
    expect(agent.AGENT_INPUTS.browser_find!({ tabId, text: 'x', selector: 'button' })).toBe(false)
  })

  it('finds by tags, ids and classes only: no selector that could test a field’s value', () => {
    for (const selector of ['button', '#save', 'form > input.name', 'main .card button', '*'])
      expect(agent.simpleSelector(selector), selector).toBe(true)
    for (const selector of [
      'input[type=password][value^="h"]',
      'input[value]',
      'form:has(input[value^="a"])',
      'input:is(.a)',
      ':where(input)',
      'input:not(.x)',
      'input:placeholder-shown',
      'a\\5b',
      '#a\\:b',
      'a, b',
      'a + b',
      'a ~ b',
      '',
    ])
      expect(agent.simpleSelector(selector), selector).toBe(false)
  })

  it('never reads a value of a password, one-time-code or hidden field, even after the page shows it as text', () => {
    const dom = agentPage()
    ;(dom.byId('pw') as { value: string }).value = 'hunter2'
    const read = () => dom.run(`(x)(globalThis, 0, {}, ${JSON.stringify({ kind: 'read', interactive: false, maxChars: 20_000 })})`)
    const first = read()
    expect(first.text).toContain('textbox "密码" （密码框，值不读取）')
    expect(first.text).toContain('textbox "验证码" （验证码，值不读取）')
    expect(first.text).toContain('textbox "名字" value="Latch"')
    for (const secret of ['hunter2', '123456', 'HIDDEN-1']) expect(first.text).not.toContain(secret)
    expect(Object.values(first.refs)).toEqual([false, false, true, true])
    // 「显示密码」: the page makes it type=text; it stays a field whose value is never read.
    dom.byId('pw').setAttribute('type', 'text')
    dom.byId('otp').removeAttribute('autocomplete')
    const second = read()
    expect(second.text).not.toContain('hunter2')
    expect(second.text).not.toContain('123456')
    expect(second.text).toContain('textbox "密码" （密码框，值不读取）')
    // Finding by words does not search values either.
    const found = dom.run(`(x)(globalThis, 0, {}, ${JSON.stringify({ kind: 'find', text: 'hunter2' })})`)
    expect(found.text).toBe('没有找到。')
    const byRole = dom.run(`(x)(globalThis, 0, {}, ${JSON.stringify({ kind: 'find', role: 'button', name: '保存' })})`)
    expect(byRole.text).toMatch(/^- button "保存设置" \[e\d+\]$/u)
  })

  it('refuses a printable key into a password field, as browser_type would, but lets Enter and Tab through', async () => {
    const { call, dom, contents } = agentSetup()
    dom.byId('pw').focus()
    expect(await call('browser_key', { key: 'h' })).toMatchObject({ ok: false, error: 'sensitive-field', dispatched: false })
    expect(await call('browser_key', { key: 'Space' })).toMatchObject({ ok: false, error: 'sensitive-field' })
    expect(contents.inputs).toEqual([])
    expect(await call('browser_key', { key: 'Enter' })).toMatchObject({ ok: true })
    dom.byId('name').focus()
    expect(await call('browser_key', { key: 'h' })).toMatchObject({ ok: true })
  })

  it('types into a password field only at R2, never says what, and checks again where the keyboard went after focusing', async () => {
    const { call, dom, contents, refOf } = agentSetup()
    const pw = await refOf('textbox "密码"')
    expect(await call('browser_type', { ref: pw, text: 'hunter2' })).toMatchObject({ ok: false, error: 'sensitive-field' })
    expect(contents.typed).toEqual([])
    const typed = await call('browser_type', { ref: pw, text: 'hunter2', submit: true }, { risk: 'R2' })
    expect(typed).toMatchObject({ ok: true, dispatched: true })
    expect(typed!.text).not.toContain('hunter2')
    expect(contents.typed).toEqual(['hunter2'])
    // An ordinary field whose page moves the keyboard to the password field as it gets focus: nothing is typed.
    const name = await refOf('textbox "名字"')
    dom.byId('name').addEventListener('focus', () => dom.byId('pw').focus())
    expect(await call('browser_type', { ref: name, text: 'secret' })).toMatchObject({ ok: false, error: 'focus-moved', dispatched: false })
    expect(contents.typed).toEqual(['hunter2'])
  })

  it('clicks only an element in sight at its centre, never a frame, and offsets nothing it cannot see', async () => {
    const { call, dom, contents, refOf, events, advance, external } = agentSetup()
    const save = await refOf('button "保存设置"')
    dom.cover(dom.byId('name'))
    expect(await call('browser_click', { ref: save })).toMatchObject({ ok: false, error: 'obscured', dispatched: false })
    dom.cover('self')
    const clicked = await call('browser_click', { ref: save })
    expect(clicked).toMatchObject({ ok: true, dispatched: true, text: expect.stringContaining('已点击 「保存设置」') })
    expect(contents.inputs).toEqual([
      { type: 'mouseMove', x: 60, y: 40 },
      { type: 'mouseDown', x: 60, y: 40, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x: 60, y: 40, button: 'left', clickCount: 1 },
    ])
    // A frame is never a target: its inside is read and acted on through its own elements.
    const frame = await call('browser_find', { selector: '#frame' })
    const ref = /\[(e\d+)\]/u.exec(String(frame!.text))![1]
    expect(await call('browser_click', { ref })).toMatchObject({ ok: false, error: 'frame-target' })
    // The Agent's click is no gesture: no popup, no system browser, and the page stays on this Mac.
    contents.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left', x: 1, y: 1 })
    expect(contents.openHandler!({ url: 'https://example.com/', postBody: undefined })).toEqual({ action: 'deny' })
    expect(external).toEqual([])
    // A page that leaves by a timer, long after the click: still refused for the rest of the turn.
    advance(30_000)
    const later = navigation('https://example.com/', { initiator: { origin: 'http://localhost:5173' } })
    contents.emit('will-frame-navigate', later)
    expect(later.preventDefault).toHaveBeenCalled()
    expect(events('notice').at(-1)).toMatchObject({ notice: 'navigation', detail: 'not-local' })
    const home = navigation('http://localhost:5173/next', { initiator: { origin: 'http://localhost:5173' } })
    contents.emit('will-frame-navigate', home)
    expect(home.preventDefault).not.toHaveBeenCalled()
  })

  it('goes back or forward only to an entry on this Mac, and a wait ends when the page leaves', async () => {
    const { call, contents } = agentSetup()
    const entries = ['https://example.com/', 'http://localhost:5173/', 'http://localhost:5173/next']
    let active = 1
    Object.assign(contents.navigationHistory, {
      canGoBack: () => active > 0,
      canGoForward: () => active < entries.length - 1,
      getActiveIndex: () => active,
      length: () => entries.length,
      getEntryAtIndex: (index: number) => ({ url: entries[index], title: '' }),
    })
    expect(await call('browser_navigate', { action: 'back' })).toMatchObject({ ok: false, error: 'not-local' })
    expect(contents.history.back).toBe(0)
    expect(await call('browser_navigate', { action: 'forward' })).toMatchObject({ ok: true })
    expect(contents.history.forward).toBe(1)
    active = 2
    const waiting = call('browser_wait', { text: '不会出现', timeoutMs: 5_000 })
    // The page leaves by its own timer while the Agent waits.
    setTimeout(() => (contents.url = 'https://example.com/elsewhere'), 400)
    expect(await waiting).toMatchObject({ ok: false, error: 'not-local' })
  })

  it('stops an action when the person takes the tab, and says the result is unknown once input reached the page', async () => {
    const { call, contents, controller, refOf, tabId } = agentSetup()
    const name = await refOf('textbox "名字"')
    // The text is going in when 接手 comes: the Enter after it is not sent, and nobody can say what the page did.
    let release!: () => void
    contents.insertText = (text: string) => {
      contents.typed.push(text)
      return new Promise<void>(done => (release = done))
    }
    const typing = call('browser_type', { ref: name, text: 'Latch', submit: true })
    await vi.waitFor(() => expect(contents.typed).toEqual(['Latch']))
    controller.takeOver({ tabId })
    release()
    expect(await typing).toMatchObject({ ok: false, error: 'result-unknown', dispatched: true })
    expect(contents.inputs.some(input => (input as { keyCode?: string }).keyCode === 'Enter')).toBe(false)
    // While the person has it, the next call does not start: the Host holds it until they hand it back.
    expect(await call('browser_click', { ref: name })).toMatchObject({ ok: false, error: 'taken-over', dispatched: false })
    expect(controller.handBack({ tabId })).toEqual({ ok: true })
    // Handing back voids the references from before.
    expect(await call('browser_click', { ref: name })).toMatchObject({ ok: false, error: 'stale-ref' })
    expect((await call('browser_read', {}))!.text).toContain('人操作过这个页面')
  })

  it('treats this Mac as the Host’s broker does', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.4.5.6', '[::1]', '[::ffff:7f00:1]'])
      expect(browserLocal.agentLocalHost(host), host).toBe(true)
    for (const host of ['0.0.0.0', '[::]', '[::ffff:a00:1]', '192.168.1.2', 'example.com', 'printer.local'])
      expect(browserLocal.agentLocalHost(host), host).toBe(false)
  })

  it('works only in a tab in sight: opens the Agent’s tab where the panel shows the session and waits for the page to place it', async () => {
    const { call, window, events, runner, controller, tabId } = agentSetup()
    controller.showing({ sessionId: null })
    expect(await call('browser_open', { url: '5173' }, {})).toMatchObject({ ok: false, error: 'panel-closed', dispatched: false })
    expect(await call('browser_read', { tabId })).toMatchObject({ ok: false, error: 'panel-closed' })
    expect(window.children).toHaveLength(1)
    expect(await call('browser_console', { tabId })).toMatchObject({ ok: true })
    controller.showing({ sessionId: 'ses_one' })
    const opening = runner.run({
      callId: `${CALL}9`,
      sessionId: 'ses_one',
      projectId: 'alpha',
      tool: 'browser_open',
      args: { url: '5173' },
      origin: null,
      risk: 'R1',
      deadline: 15_000,
    })
    await vi.waitFor(() => expect(events('opened')).toHaveLength(2))
    const opened = events('opened').at(-1)!
    await vi.waitFor(() => expect(events('reveal').map(event => event.tabId)).toContain(opened.tabId))
    controller.setBounds({ tabId: opened.tabId, bounds: { x: 0, y: 0, width: 800, height: 600 } })
    expect(await opening).toMatchObject({ ok: true, dispatched: true })
    expect(window.children.at(-1)!.webContents.loads).toEqual(['http://localhost:5173/'])
    expect(events('opened').at(-1)).toMatchObject({ sessionId: 'ses_one', projectId: 'alpha', state: { opener: 'agent' } })
    expect(runner.report().at(-1)).toMatchObject({ opener: 'agent', url: 'http://localhost:5173/' })
  })

  it('registers with a signed body naming its purpose, answers each call with its picture first, and stops with the window', async () => {
    const sent: Array<[string, string, unknown]> = []
    let push!: (text: string) => void
    const request = async (method: string, path: string, body?: unknown) => {
      sent.push([method, path, body])
      if (path.endsWith('/nonce')) return { status: 200, json: { nonce: 'n1' } }
      if (path.endsWith('/register')) return { status: 201, json: { providerId: `bpv_${'p'.repeat(22)}` } }
      return { status: 200, json: { ok: true } }
    }
    let aborted = false
    const stream = async (_path: string, _body: unknown, signal: AbortSignal) => {
      signal.addEventListener('abort', () => (aborted = true))
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = text => controller.enqueue(new TextEncoder().encode(text))
        },
      })
      return new Response(body, { status: 200 })
    }
    const images: string[] = []
    const provider = agent.createBrowserProvider({
      request,
      stream,
      putImage: async (path: string) => {
        images.push(path)
        sent.push(['PUT', path, undefined])
        return { status: 200 }
      },
      sign: (body: Record<string, unknown>) => `signed:${JSON.stringify(body)}`,
      runner: {
        run: async (call: { callId: string }) => ({
          callId: call.callId,
          ok: true,
          dispatched: false,
          text: '截图',
          image: { data: new Uint8Array([1]) },
        }),
        cancel() {},
        sessionEnded() {},
        turnEnded() {},
        report: () => [],
        stopAll() {},
      },
      onTabs: () => () => {},
    })
    provider.start()
    await vi.waitFor(() => expect(provider.state().registered).toBe(true))
    expect(sent[1]).toEqual([
      'POST',
      '/link/api/browser-provider/register',
      { nonce: 'n1', purpose: 'browser-provider', signature: 'signed:{"nonce":"n1","purpose":"browser-provider"}' },
    ])
    await vi.waitFor(() => expect(push).toBeDefined())
    push(`event: call\ndata: ${JSON.stringify({ callId: `${CALL}5` })}\n\n`)
    await vi.waitFor(() => expect(sent.some(([, path]) => path === '/link/api/browser-provider/results')).toBe(true))
    const order = sent.map(([method, path]) => `${method} ${path}`)
    expect(order.indexOf(`PUT /link/api/browser-provider/results/${CALL}5/image`)).toBeLessThan(
      order.indexOf('POST /link/api/browser-provider/results'),
    )
    expect(sent.find(([, path]) => path === '/link/api/browser-provider/results')![2]).toEqual({
      callId: `${CALL}5`,
      ok: true,
      dispatched: false,
      text: '截图',
      image: true,
    })
    provider.stop()
    expect(aborted).toBe(true)
    expect(provider.state()).toEqual({ active: false, registered: false })
  })
})
