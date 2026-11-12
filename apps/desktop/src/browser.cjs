'use strict'
// The preview browser behind the 浏览器 tab. Each tab is a WebContentsView laid over the page's right panel, in a
// non-persistent partition of its project. A guest is untrusted web content: no preload and no Node, sandboxed with
// context isolation; every permission is refused, downloads are cancelled, `<webview>` and new windows are refused and
// WebRTC sends UDP only through a proxy. Its requests never reach a Latch Host: main refuses the Host's listener
// ports, every `h-<hostId>.localhost` name and every `/link/api` path, which also covers the `pnpm dev:web` proxy. A tab
// goes only to http(s) addresses, and a page cannot send it to another private address unless the person clicked.
// The page drives tabs through `latchShell.browser`; main answers only the main window's own page. A tab belongs to a
// session of the page's: a reload of the page hides the tabs (the page lists them again), closing the window ends them.
// The built-in harness's Agent drives them too, through browser-agent.cjs, with a fixed list of actions: its input never
// counts as the person's click, and while it acts (and a second after) the tab's main frame goes nowhere but this Mac.
// See docs/PREVIEW-BROWSER.md. The exported helpers are pure so they can be unit-tested without Electron.
const { randomBytes } = require('node:crypto')
const { isIP } = require('node:net')
const { createExternalGesture } = require('./proxy.cjs')

const PROTOCOL_VERSION = 3
/** The IPC channels. preload.cjs names them literally: a sandboxed preload cannot load this file. */
const CHANNELS = Object.freeze({
  open: 'latch:browser:open',
  close: 'latch:browser:close',
  navigate: 'latch:browser:navigate',
  go: 'latch:browser:go',
  bounds: 'latch:browser:bounds',
  occlude: 'latch:browser:occlude',
  focus: 'latch:browser:focus',
  capture: 'latch:browser:capture',
  annotate: 'latch:browser:annotate',
  zoom: 'latch:browser:zoom',
  devTools: 'latch:browser:devtools',
  clearData: 'latch:browser:clear-data',
  state: 'latch:browser:state',
  list: 'latch:browser:list',
  viewport: 'latch:browser:viewport',
  colorScheme: 'latch:browser:color-scheme',
  hitTest: 'latch:browser:hit-test',
  logs: 'latch:browser:logs',
  takeOver: 'latch:browser:take-over',
  handBack: 'latch:browser:hand-back',
  showing: 'latch:browser:showing',
  /** Main to the page: a tab's state, a notice about something refused, or the end of a tab. */
  event: 'latch:browser:event',
})
const TAB_ID = /^brw_[A-Za-z0-9_-]{22}$/
/** As the Host hands out project IDs (and as the preload checks them). */
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/
/** As the Host hands out session IDs (and as folders.cjs and the preload check them). */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
/** The viewport presets, in CSS pixels upright; 「适应面板」 (`fit`) is the panel's own size. */
const VIEWPORTS = Object.freeze({
  phone: Object.freeze({ width: 390, height: 844 }),
  tablet: Object.freeze({ width: 820, height: 1180 }),
  desktop: Object.freeze({ width: 1280, height: 800 }),
})
const VIEWPORT_PRESETS = new Set(['fit', ...Object.keys(VIEWPORTS)])
/** What `prefers-color-scheme` a tab's pages see: the system's, or light or dark as the person chose. */
const COLOR_SCHEMES = new Set(['system', 'light', 'dark'])
/** Console messages and requests each tab keeps, the newest; the page gets the last `LOG_REPORTED` of each. */
const LOG_LIMIT = 500
const LOG_REPORTED = 200
const CONSOLE_TEXT_LIMIT = 500
const LOG_URL_LIMIT = 512
const CONSOLE_LEVELS = new Set(['info', 'warning', 'error', 'debug'])
/**
 * Warnings a tab shows only because it is a Latch preview, never in a normal browser: Chromium's about the sandbox
 * Latch adds to every document (GUEST_SANDBOX_POLICY), and Electron's own insecure-CSP warning for an unpackaged app.
 * Matched exactly, at the warning level, and left out of the 控制台 list and its counts.
 */
const SANDBOX_WARNING = 'An iframe which has both allow-scripts and allow-same-origin for its sandbox attribute can escape its sandboxing.'
const ELECTRON_CSP_WARNING = [
  '%cElectron Security Warning (Insecure Content-Security-Policy) font-weight: bold; This renderer process has either no Content Security',
  '  Policy set or a policy with "unsafe-eval" enabled. This exposes users of',
  '  this app to unnecessary security risks.',
  '',
  'For more information and help, consult',
  'https://electronjs.org/docs/tutorial/security.',
  'This warning will not show up',
  'once the app is packaged.',
].join('\n')
const LATCH_OWN_WARNINGS = new Set([SANDBOX_WARNING, ELECTRON_CSP_WARNING])
const latchOwnWarning = (level, message) => level === 'warning' && typeof message === 'string' && LATCH_OWN_WARNINGS.has(message)
/** Request starts kept for their durations; a request that never ends is forgotten with the oldest. */
const STARTS_LIMIT = 4096
const TAB_LIMIT = 8
/** In-memory sessions live until the app quits, so the projects that get one are bounded too. */
const PARTITION_LIMIT = 64
/** What the address field and a page's new window may ask for; a tab's own address is reported up to the second. */
const ADDRESS_LIMIT = 2048
const REPORTED_URL_LIMIT = 8192
const TITLE_LIMIT = 256
const PANEL_LIMIT = 100_000
/** 「截图发给 Agent」 and the frozen stand-in: PNG within the Host's image attachment limit of 5 MiB. */
const CAPTURE_LIMITS = Object.freeze({ edge: 4096, bytes: 5 * 1024 * 1024 })
/** The picture of an annotated element. */
const CROP_LIMITS = Object.freeze({ edge: 1600, bytes: 2 * 1024 * 1024 })
const CROP_PADDING = 8
const TEXT_LIMIT = 200
const SELECTOR_LIMIT = 512
/** The isolated world 标注 runs in: neither the page's own (0) nor the one Electron keeps for itself (999). */
const ANNOTATION_WORLD = 1037
const SCRIPT_TIMEOUT_MS = 3_000
const STATE_DELAY_MS = 32
/** After an Agent action, how long its effects still count as the Agent's: no click of the person's, no leaving this Mac. */
const AGENT_AFTERMATH_MS = 1_000
const NOTICE_INTERVAL_MS = 1_000
const ZOOM_FACTORS = Object.freeze([0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3])
const GO_ACTIONS = new Set(['back', 'forward', 'reload', 'stop'])
const ZOOM_DIRECTIONS = new Set(['in', 'out', 'reset'])
/** A Latch Host's own loopback name, and names under it. */
const HOST_NAME = /(?:^|\.)h-[a-z2-7]{52}\.localhost$/u
/**
 * C0 and C1 controls, format characters (bidi controls, zero-width characters, soft hyphens, Unicode tags), other
 * default-ignorable code points (variation selectors) and line and paragraph separators: what could hide or reorder
 * text a page hands the person.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u
const UNPRINTABLE_ALL = new RegExp(UNPRINTABLE.source, 'gu')
const PERMISSION_NAME = /^[A-Za-z][A-Za-z-]{0,39}$/u
const NET_ABORTED = -3
/**
 * Web APIs a guest page does not get, since each opens a native window over or beside Latch's: the File System Access
 * pickers (`showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`) and document picture-in-picture.
 */
const GUEST_BLINK_FEATURES_OFF = 'FileSystemAccessLocal,DocumentPictureInPictureAPI'
/**
 * The Permissions-Policy of every guest document, in place of the page's own: video picture-in-picture would open a
 * floating window over every app, and no setting turns it off.
 */
const GUEST_PERMISSIONS_POLICY = 'picture-in-picture=()'
/**
 * A further Content-Security-Policy on every guest document: without allow-modals Blink ignores `print()`, whose panel
 * no setting turns off. allow-popups keeps `window.open` coming to main, which decides what it opens.
 */
const GUEST_SANDBOX_POLICY = 'sandbox allow-scripts allow-same-origin allow-forms allow-popups'
/** Network schemes a guest request may use; data: and blob: never leave the page. */
const REQUEST_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:'])
/** Documents of a page's own that its frames may hold without the network. */
const FRAME_SCHEMES = new Set(['about:', 'data:', 'blob:'])
/**
 * App shortcuts that work while a tab has focus: main takes them from the guest (`before-input-event`) and gives them to
 * the page, so a page never swallows them. ⌘K palette, ⌘J terminal, ⌘B sidebar, ⌥⌘B side panel, ⌘, settings, ⇧⌘B
 * the 浏览器 tab and ⇧⌘S 选取元素.
 */
const FORWARDED_SHORTCUTS = Object.freeze(
  [
    { code: 'KeyK', keyCode: 'K', alt: false, shift: false },
    { code: 'KeyJ', keyCode: 'J', alt: false, shift: false },
    { code: 'KeyB', keyCode: 'B', alt: false, shift: false },
    { code: 'KeyB', keyCode: 'B', alt: true, shift: false },
    { code: 'Comma', keyCode: ',', alt: false, shift: false },
    { code: 'KeyB', keyCode: 'B', alt: false, shift: true },
    { code: 'KeyS', keyCode: 'S', alt: false, shift: true },
  ].map(item => Object.freeze(item)),
)

const isPlainObject = value =>
  value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))

/** Exactly these own keys and nothing else, so an input cannot carry anything main did not ask for. */
function hasOnlyKeys(value, keys) {
  if (!isPlainObject(value)) return false
  const own = Reflect.ownKeys(value)
  return own.length === keys.length && keys.every(key => own.includes(key))
}

const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

/** Lower case, without the one trailing dot that names the same host. */
function bareHost(hostname) {
  return String(hostname).toLowerCase().replace(/\.$/u, '')
}

function ipv4Bytes(text) {
  const parts = text.split('.')
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/u.test(part))) return undefined
  const bytes = parts.map(Number)
  return bytes.every(byte => byte <= 255) ? bytes : undefined
}

/**
 * Loopback, unspecified, private (RFC 1918), shared (RFC 6598), link-local, benchmarking, multicast and reserved.
 * @param {number[]} bytes
 */
function isPrivateIPv4(bytes) {
  const [a = 0, b = 0] = bytes
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
  )
}

/** The eight groups of an IPv6 address, the last two from a dotted IPv4 tail when it has one. */
function ipv6Groups(text) {
  let address = text.toLowerCase().replace(/%.*$/u, '')
  if (isIP(address) !== 6) return undefined
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/u.exec(address)
  if (dotted) {
    const bytes = ipv4Bytes(dotted[2] ?? '')
    if (!bytes) return undefined
    address = `${dotted[1]}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`
  }
  const compressed = address.includes('::')
  const [head = '', tail = ''] = address.split('::')
  const left = head ? head.split(':') : []
  const right = compressed && tail ? tail.split(':') : []
  const missing = 8 - left.length - right.length
  if (compressed ? missing < 1 : missing !== 0) return undefined
  return [...left, ...Array.from({ length: compressed ? missing : 0 }, () => '0'), ...right].map(group => Number.parseInt(group, 16))
}

/** An IPv4 address carried in an IPv6 one: compatible (::a.b.c.d), mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::/96). */
function embeddedIPv4(groups) {
  const zeros = (from, to) => groups.slice(from, to).every(group => group === 0)
  const carries = (zeros(0, 5) && (groups[5] === 0 || groups[5] === 0xffff)) || (groups[0] === 0x64 && groups[1] === 0xff9b && zeros(2, 6))
  if (!carries) return undefined
  const [high = 0, low = 0] = groups.slice(6)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff]
}

/** Unique local (fc00::/7), link-local (fe80::/10), multicast, and the IPv4 forms of a private IPv4 address. */
function isPrivateIPv6(text) {
  const groups = ipv6Groups(text)
  if (!groups) return false
  const first = groups[0] ?? 0
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return true
  const v4 = embeddedIPv4(groups)
  return v4 !== undefined && isPrivateIPv4(v4)
}

/** This Mac under any of its names: localhost, `*.localhost`, 127/8, 0.0.0.0 and ::1 (or ::, and IPv4 forms of these). */
function isLoopbackHost(hostname) {
  const host = bareHost(hostname)
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const v4 = isIP(host) === 4 ? ipv4Bytes(host) : undefined
  if (v4) return v4[0] === 127 || v4.every(byte => byte === 0)
  if (!host.startsWith('[')) return false
  const groups = ipv6Groups(host.slice(1, -1))
  if (!groups) return false
  if (groups.slice(0, 7).every(group => group === 0) && (groups[7] ?? 0) <= 1) return true
  const embedded = embeddedIPv4(groups)
  return embedded !== undefined && embedded[0] === 127
}

/**
 * Whether an address names this Mac or the local network rather than the internet: loopback, private and link-local
 * literals, `.local` and similar local names, and single-label names. By name only: a public name that resolves to a
 * private address is not caught here.
 */
function isPrivateHost(hostname) {
  const host = bareHost(hostname)
  if (host === '') return false
  if (host.startsWith('[')) return isPrivateIPv6(host.slice(1, -1))
  const v4 = isIP(host) === 4 ? ipv4Bytes(host) : undefined
  if (v4) return isPrivateIPv4(v4)
  return host === 'localhost' || /\.(?:localhost|local|lan|internal|home\.arpa)$/u.test(host) || !host.includes('.')
}

/** The address a page is on, for 「another private address」: every name of this Mac counts as one. */
function addressOf(hostname) {
  return isLoopbackHost(hostname) ? 'loopback' : bareHost(hostname)
}

function portOf(url) {
  if (url.port) return Number(url.port)
  return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80
}

const decoded = path => {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

/** A path as the Host's router reads it: `//x/link/api` is the path `/link/api` of a host `x` to `new URL`. */
const routed = path => {
  try {
    return new URL(path, 'http://latch.invalid').pathname
  } catch {
    return path
  }
}

/**
 * A path the Host's API, or the `pnpm dev:web` proxy in front of it, would answer, however it is spelled: as sent, as
 * the router reads it, and decoded, each with its slashes merged and in lower case.
 */
function isApiPath(pathname) {
  const spellings = [pathname, routed(pathname), decoded(pathname), routed(decoded(pathname))]
  return spellings.some(path =>
    path
      .replace(/[\\/]+/gu, '/')
      .toLowerCase()
      .startsWith('/link/api'),
  )
}

/**
 * Whether a request or navigation would reach a Latch Host: one of the attached Host's listener ports (on any name, so a
 * name that resolves to this Mac does not get around it; ports 80 and 443 only on local addresses), any Host loopback
 * name (the dev proxy's address too), or an API path on any port (the dev proxy answers it with the Host's own origin).
 * @param {URL} url
 * @param {ReadonlySet<number>} ports
 */
function reachesHost(url, ports) {
  const host = bareHost(url.hostname)
  if (HOST_NAME.test(host)) return true
  const port = portOf(url)
  if (ports.has(port) && (isPrivateHost(host) || (port !== 80 && port !== 443))) return true
  return isApiPath(url.pathname)
}

/** An http(s) address without credentials, at most `limit` characters long, as a URL; otherwise undefined. */
function previewUrl(raw, limit = ADDRESS_LIMIT) {
  if (typeof raw !== 'string' || raw.length > limit) return undefined
  let url
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || !url.hostname) return undefined
  return url.href.length > limit ? undefined : url
}

/**
 * What the address field 「输入网址或 localhost 端口」 means: a bare port is that port on localhost; an address without a
 * scheme is http on a local address and https elsewhere. Only http(s) addresses come back, normalized; there is no
 * search.
 */
function addressUrl(text) {
  if (typeof text !== 'string') return undefined
  const value = text.trim()
  if (value === '' || value.length > ADDRESS_LIMIT || /[\s\u0000-\u001f\u007f]/u.test(value)) return undefined
  if (/^\d{1,5}$/u.test(value)) {
    const port = Number(value)
    return port >= 1 && port <= 65_535 ? `http://localhost:${port}/` : undefined
  }
  let candidate = value
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    let local = false
    try {
      local = isPrivateHost(new URL(`http://${value}`).hostname)
    } catch {
      return undefined
    }
    candidate = `${local ? 'http' : 'https'}://${value}`
  }
  return previewUrl(candidate)?.href
}

/**
 * Whether a tab may go to `url`. `kind` says who asks:
 * - `typed`: the page (the address field, a local link the person opened in the tab); history and reload never ask;
 * - `page`: the guest itself (a link, a form, a script, a frame), with `gesture` when the person just clicked or pressed
 *   Enter in it;
 * - `redirect`: a server redirect during a navigation.
 * `from` is the origin of the frame that asked, or for a redirect the address redirected from. A private address loads
 * only when typed or clicked, or from that same address. A frame may also hold its page's own about:, data: and blob:
 * documents.
 * @param {{ url: string, kind: 'typed' | 'page' | 'redirect', from?: string, gesture?: boolean, frame?: boolean }} request
 * @param {ReadonlySet<number>} ports
 * @returns {{ ok: true } | { ok: false, reason: 'scheme' | 'credentials' | 'host' | 'private' }}
 */
function navigationVerdict({ url: raw, kind, from, gesture = false, frame = false }, ports) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'scheme' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return frame && FRAME_SCHEMES.has(url.protocol) ? { ok: true } : { ok: false, reason: 'scheme' }
  if (url.username || url.password) return { ok: false, reason: 'credentials' }
  if (reachesHost(url, ports)) return { ok: false, reason: 'host' }
  if (kind === 'typed' || (kind === 'page' && gesture) || !isPrivateHost(url.hostname)) return { ok: true }
  let source
  try {
    source = new URL(String(from))
  } catch {
    return { ok: false, reason: 'private' }
  }
  const same =
    (source.protocol === 'http:' || source.protocol === 'https:')
    && isPrivateHost(source.hostname)
    && addressOf(source.hostname) === addressOf(url.hostname)
  return same ? { ok: true } : { ok: false, reason: 'private' }
}

/**
 * Whether a guest session lets a request out: network schemes only, and nothing that reaches a Latch Host. The
 * developer tools that main opened for a tab (`devTools`, their WebContents IDs) may also load their own devtools: page.
 * @param {{ url: string, webContentsId?: number }} details
 * @param {ReadonlySet<number>} ports
 * @param {ReadonlySet<number>} devTools
 */
function requestAllowed(details, ports, devTools) {
  let url
  try {
    url = new URL(details.url)
  } catch {
    return false
  }
  if (url.protocol === 'devtools:') return typeof details.webContentsId === 'number' && devTools.has(details.webContentsId)
  if (!REQUEST_SCHEMES.has(url.protocol)) return false
  return url.protocol === 'data:' || url.protocol === 'blob:' || !reachesHost(url, ports)
}

const isTabId = value => typeof value === 'string' && TAB_ID.test(value)
const isProjectId = value => typeof value === 'string' && PROJECT_ID.test(value)
const isSessionId = value => typeof value === 'string' && SESSION_ID.test(value)

/** A point of the tab, from its top-left corner in CSS pixels of the page. */
function pointInput(input) {
  if (!hasOnlyKeys(input, ['tabId', 'point']) || !isTabId(input.tabId) || !hasOnlyKeys(input.point, ['x', 'y'])) return undefined
  const { x, y } = input.point
  return finite(x, 0, PANEL_LIMIT) && finite(y, 0, PANEL_LIMIT) ? { tabId: input.tabId, point: { x, y } } : undefined
}

function rectInput(value) {
  if (!hasOnlyKeys(value, ['x', 'y', 'width', 'height'])) return undefined
  const { x, y, width, height } = value
  if (!finite(x, -PANEL_LIMIT, PANEL_LIMIT) || !finite(y, -PANEL_LIMIT, PANEL_LIMIT)) return undefined
  return finite(width, 0, PANEL_LIMIT) && finite(height, 0, PANEL_LIMIT) ? { x, y, width, height } : undefined
}

/** Each IPC input: exactly its keys with values of its shape, copied; anything else is undefined (refused). */
const INPUTS = Object.freeze({
  open: input =>
    hasOnlyKeys(input, ['projectId', 'sessionId', 'url'])
    && isProjectId(input.projectId)
    && isSessionId(input.sessionId)
    && (input.url === null || (typeof input.url === 'string' && input.url.length <= ADDRESS_LIMIT))
      ? { projectId: input.projectId, sessionId: input.sessionId, url: input.url }
      : undefined,
  tab: input => (hasOnlyKeys(input, ['tabId']) && isTabId(input.tabId) ? { tabId: input.tabId } : undefined),
  navigate: input =>
    hasOnlyKeys(input, ['tabId', 'url']) && isTabId(input.tabId) && typeof input.url === 'string' && input.url.length <= ADDRESS_LIMIT
      ? { tabId: input.tabId, url: input.url }
      : undefined,
  go: input =>
    hasOnlyKeys(input, ['tabId', 'action']) && isTabId(input.tabId) && GO_ACTIONS.has(input.action)
      ? { tabId: input.tabId, action: input.action }
      : undefined,
  bounds: input => {
    if (!hasOnlyKeys(input, ['tabId', 'bounds']) || !isTabId(input.tabId)) return undefined
    if (input.bounds === null) return { tabId: input.tabId, bounds: null }
    const bounds = rectInput(input.bounds)
    return bounds ? { tabId: input.tabId, bounds } : undefined
  },
  occlude: input =>
    hasOnlyKeys(input, ['tabId', 'occluded']) && isTabId(input.tabId) && typeof input.occluded === 'boolean'
      ? { tabId: input.tabId, occluded: input.occluded }
      : undefined,
  annotate: pointInput,
  hitTest: pointInput,
  viewport: input =>
    hasOnlyKeys(input, ['tabId', 'preset', 'rotated'])
    && isTabId(input.tabId)
    && VIEWPORT_PRESETS.has(input.preset)
    && typeof input.rotated === 'boolean'
      ? { tabId: input.tabId, preset: input.preset, rotated: input.rotated }
      : undefined,
  colorScheme: input =>
    hasOnlyKeys(input, ['tabId', 'scheme']) && isTabId(input.tabId) && COLOR_SCHEMES.has(input.scheme)
      ? { tabId: input.tabId, scheme: input.scheme }
      : undefined,
  none: input => (hasOnlyKeys(input, []) ? {} : undefined),
  zoom: input =>
    hasOnlyKeys(input, ['tabId', 'direction']) && isTabId(input.tabId) && ZOOM_DIRECTIONS.has(input.direction)
      ? { tabId: input.tabId, direction: input.direction }
      : undefined,
  project: input => (hasOnlyKeys(input, ['projectId']) && isProjectId(input.projectId) ? { projectId: input.projectId } : undefined),
  showing: input =>
    hasOnlyKeys(input, ['sessionId']) && (input.sessionId === null || isSessionId(input.sessionId))
      ? { sessionId: input.sessionId }
      : undefined,
})

const clamp = (value, max) => Math.min(Math.max(value, 0), max)

/**
 * The panel rectangle the page sends (CSS pixels of the page) as view bounds in the window's content area: scaled by
 * the page's zoom, rounded and clamped to the content size. Null when nothing of it is left.
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {number} zoom  the page's zoom factor
 * @param {{ width: number, height: number }} content
 */
function viewBounds(rect, zoom, content) {
  const x = clamp(Math.round(rect.x * zoom), content.width)
  const y = clamp(Math.round(rect.y * zoom), content.height)
  const right = clamp(Math.round((rect.x + rect.width) * zoom), content.width)
  const bottom = clamp(Math.round((rect.y + rect.height) * zoom), content.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

/** The forwarded shortcut `input` is, if any: ⌘ on macOS and Ctrl elsewhere, Alt and Shift as listed. */
function forwardedShortcut(input, platform) {
  if (!input || (input.type !== 'keyDown' && input.type !== 'keyUp')) return undefined
  const command = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
  if (!command) return undefined
  return FORWARDED_SHORTCUTS.find(
    item => item.code === input.code && item.alt === Boolean(input.alt) && item.shift === Boolean(input.shift),
  )
}

/** A preset's size in CSS pixels, turned when rotated; null for 「适应面板」. */
function viewportSize(viewport) {
  const size = viewport && viewport.preset !== 'fit' ? VIEWPORTS[viewport.preset] : undefined
  if (!size) return null
  return viewport.rotated ? { width: size.height, height: size.width } : { width: size.width, height: size.height }
}

/** How far a preset's page is scaled to fit the view (its DIP), never up. */
function emulationScale(size, bounds) {
  if (!size || !bounds || bounds.width <= 0 || bounds.height <= 0) return 1
  return Math.min(1, bounds.width / size.width, bounds.height / size.height)
}

/** An address for the console and network lists: its origin and path, never the query (which may carry a token). */
function logUrl(raw) {
  if (typeof raw !== 'string' || raw === '') return ''
  try {
    const url = new URL(raw)
    if (url.protocol === 'data:' || url.protocol === 'blob:') return `${url.protocol}…`
    const text = url.origin === 'null' ? `${url.protocol}${url.pathname}` : `${url.origin}${url.pathname}`
    return cleanText(text, LOG_URL_LIMIT)
  } catch {
    return ''
  }
}

/** A console message, printable and at most 500 characters; its lines stay lines. */
function consoleText(value) {
  if (typeof value !== 'string') return ''
  return value
    .slice(0, CONSOLE_TEXT_LIMIT * 4)
    .split(/\r\n?|\n/u)
    .map(line => line.replace(UNPRINTABLE_ALL, ' ').trimEnd())
    .join('\n')
    .trim()
    .slice(0, CONSOLE_TEXT_LIMIT)
}

/** A response's own Content-Length, when it states one. */
function contentLength(headers) {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== 'content-length') continue
    const length = Number(Array.isArray(value) ? value[0] : value)
    return Number.isSafeInteger(length) && length >= 0 ? length : null
  }
  return null
}

/** A Chromium error name as webRequest gives it (`net::ERR_CONNECTION_REFUSED`), without the prefix. */
function netError(value) {
  const name = typeof value === 'string' ? value.replace(/^net::/u, '') : ''
  return /^ERR_[A-Z0-9_]{1,64}$/u.test(name) ? name : 'ERR_FAILED'
}

const failedRequest = entry => entry.error !== null || (entry.status !== null && entry.status >= 400)

/** A tab's 控制台 or 网络 list: the newest `LOG_LIMIT` entries in a ring, each with a sequence ID, and running counts. */
function createLog() {
  return { items: new Array(LOG_LIMIT), head: 0, size: 0, next: 1 }
}

/** Adds an entry with the next ID; returns the entry it pushed out, if the ring was full. */
function pushLog(log, entry) {
  const at = (log.head + log.size) % LOG_LIMIT
  const evicted = log.size === LOG_LIMIT ? log.items[at] : undefined
  log.items[at] = { id: log.next++, ...entry }
  if (evicted) log.head = (log.head + 1) % LOG_LIMIT
  else log.size++
  return evicted
}

/** The newest `count` entries, oldest first, as copies. */
function lastOf(log, count) {
  const take = Math.min(count, log.size)
  const out = []
  for (let index = log.size - take; index < log.size; index++) out.push({ ...log.items[(log.head + index) % LOG_LIMIT] })
  return out
}

/**
 * A document's response headers with Latch's policies. Its Permissions-Policy replaces the page's: appended to the
 * page's, a malformed policy of its own would void both. Its sandbox joins the page's Content-Security-Policy headers,
 * each of which browsers enforce on its own, under one spelling of the name.
 * @param {Record<string, string | string[]> | undefined} headers
 */
function withGuestPolicy(headers) {
  /** @type {Record<string, string | string[]>} */
  const result = {}
  const contentPolicies = []
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase()
    if (lower === 'content-security-policy') contentPolicies.push(...(Array.isArray(value) ? value : [value]))
    else if (lower !== 'permissions-policy') result[name] = value
  }
  result['Permissions-Policy'] = [GUEST_PERMISSIONS_POLICY]
  result['Content-Security-Policy'] = [...contentPolicies, GUEST_SANDBOX_POLICY]
  return result
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(data) {
  if (!data || data.length < 24 || data.readUInt32BE(0) !== 0x89504e47 || data.toString('latin1', 12, 16) !== 'IHDR') return undefined
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

/**
 * A NativeImage as PNG with at most `edge` pixels a side and `bytes` bytes, made smaller until it fits (four tries);
 * undefined when it is empty or will not fit.
 * @param {Electron.NativeImage | undefined} image
 * @param {{ edge: number, bytes: number }} limits
 */
function encodeImage(image, { edge, bytes }) {
  if (!image || image.isEmpty()) return undefined
  let current = image
  for (let attempt = 0; attempt < 4; attempt++) {
    const data = current.toPNG()
    const size = pngSize(data)
    if (!size || size.width === 0 || size.height === 0) return undefined
    const scale = Math.min(edge / Math.max(size.width, size.height), data.length > bytes ? 0.7 : 1)
    if (scale >= 1) return { type: 'image/png', width: size.width, height: size.height, data: new Uint8Array(data) }
    const { width, height } = current.getSize()
    current = current.resize({
      width: Math.max(1, Math.floor(width * scale)),
      height: Math.max(1, Math.floor(height * scale)),
      quality: 'good',
    })
    if (current.isEmpty()) return undefined
  }
  return undefined
}

/** What 标注 reports of a page, printable and bounded: the page decides the words, never their size or controls. */
function cleanText(value, limit) {
  return typeof value === 'string' ? value.replace(UNPRINTABLE_ALL, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit) : ''
}

/**
 * The isolated world's answer, checked again: a tag, a selector and up to 200 characters of text, and the element's box
 * in the guest's CSS pixels. Anything else is undefined.
 */
function annotationOf(raw) {
  if (!hasOnlyKeys(raw, ['tag', 'selector', 'text', 'rect']) || !hasOnlyKeys(raw.rect, ['x', 'y', 'width', 'height'])) return undefined
  const { tag, selector, text } = raw
  const { x, y, width, height } = raw.rect
  if (typeof tag !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(tag)) return undefined
  if (typeof selector !== 'string' || selector.length === 0 || selector.length > SELECTOR_LIMIT || UNPRINTABLE.test(selector))
    return undefined
  if (typeof text !== 'string' || text.length > TEXT_LIMIT * 4) return undefined
  if (![x, y].every(value => finite(value, -1e7, 1e7)) || ![width, height].every(value => finite(value, 0, 1e7))) return undefined
  return { tag: tag.toLowerCase(), selector, text: cleanText(text, TEXT_LIMIT), rect: { x, y, width, height } }
}

/**
 * The script 标注 runs in the guest's isolated world: the element at a point of the viewport, a CSS selector for it
 * (an id it alone has, else tags with up to two classes and :nth-of-type, at most eight levels), its visible words or
 * label, and its box. It reads the page and changes nothing, and never reads form values. The page's scripts run in
 * another world and cannot replace what it calls, but a named form control shadows members of its form in that world
 * too (the DOM's named properties can also apply to `document`), so it calls DOM members through this world's prototypes.
 */
function annotationScript(x, y) {
  const args = JSON.stringify({ x, y, textLimit: TEXT_LIMIT, selectorLimit: SELECTOR_LIMIT })
  return `((options) => {
  const method = (type, name) => {
    const run = type.prototype[name]
    return (target, ...args) => run.apply(target, args)
  }
  const getter = (type, name) => {
    const read = Object.getOwnPropertyDescriptor(type.prototype, name).get
    return target => read.call(target)
  }
  const elementFromPoint = method(Document, 'elementFromPoint')
  const querySelectorAll = method(Document, 'querySelectorAll')
  const createTreeWalker = method(Document, 'createTreeWalker')
  const getAttribute = method(Element, 'getAttribute')
  const getBox = method(Element, 'getBoundingClientRect')
  const localName = getter(Element, 'localName')
  const idOf = getter(Element, 'id')
  const classList = getter(Element, 'classList')
  const childrenOf = getter(Element, 'children')
  const parentOf = getter(Node, 'parentElement')
  const dataOf = getter(CharacterData, 'data')
  const escape = value => CSS.escape(value)
  const element = elementFromPoint(document, options.x, options.y)
  if (!(element instanceof Element)) return null
  const partOf = node => {
    const name = localName(node)
    let part = escape(name)
    for (const value of Array.from(classList(node)).slice(0, 2)) if (value.length <= 32) part += '.' + escape(value)
    const parent = parentOf(node)
    if (parent && childrenOf(parent).length <= 1000) {
      let index = 0
      let count = 0
      for (const child of childrenOf(parent)) {
        if (localName(child) !== name) continue
        count += 1
        if (child === node) index = count
      }
      if (count > 1) part += ':nth-of-type(' + index + ')'
    }
    return part
  }
  const parts = []
  for (let node = element, depth = 0; node && depth < 8; node = parentOf(node), depth += 1) {
    const id = idOf(node)
    if (id && id.length <= 64) {
      const anchor = '#' + escape(id)
      let unique = false
      try {
        unique = querySelectorAll(document, anchor).length === 1
      } catch {}
      if (unique) {
        parts.unshift(anchor)
        break
      }
    }
    parts.unshift(partOf(node))
  }
  while (parts.length > 1 && parts.join(' > ').length > options.selectorLimit) parts.shift()
  let selector = parts.join(' > ')
  if (selector.length > options.selectorLimit) selector = escape(localName(element))
  const skipped = new Set(['script', 'style', 'noscript', 'template'])
  const walker = createTreeWalker(document, element, NodeFilter.SHOW_TEXT)
  let text = ''
  for (let count = 0; count < 2000 && text.length < options.textLimit * 2; count += 1) {
    const node = walker.nextNode()
    if (!node) break
    const parent = parentOf(node)
    if (parent && skipped.has(localName(parent))) continue
    text += ' ' + dataOf(node).slice(0, options.textLimit * 2)
  }
  text = text.replace(/\\s+/g, ' ').trim()
  if (!text) {
    for (const name of ['aria-label', 'alt', 'title', 'placeholder']) {
      const label = getAttribute(element, name)
      if (label && label.trim()) {
        text = label.replace(/\\s+/g, ' ').trim()
        break
      }
    }
  }
  const box = getBox(element)
  return {
    tag: localName(element),
    selector,
    text: text.slice(0, options.textLimit * 2),
    rect: { x: box.x, y: box.y, width: box.width, height: box.height },
  }
})(${args})`
}

/** What `hitTest` takes from the isolated world: a tag and a box. Anything else is undefined. */
function hitOf(raw) {
  if (!hasOnlyKeys(raw, ['tag', 'rect']) || !hasOnlyKeys(raw.rect, ['x', 'y', 'width', 'height'])) return undefined
  const { tag } = raw
  const { x, y, width, height } = raw.rect
  if (typeof tag !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(tag)) return undefined
  if (![x, y].every(value => finite(value, -1e7, 1e7)) || ![width, height].every(value => finite(value, 0, 1e7))) return undefined
  return { tag: tag.toLowerCase(), rect: { x, y, width, height } }
}

/**
 * The script `hitTest` runs in the isolated world 标注 uses: only the element at a point of the viewport, its tag and its
 * box, through this world's prototypes. It reads nothing else and changes nothing.
 */
function hitTestScript(x, y) {
  const args = JSON.stringify({ x, y })
  return `((options) => {
  const elementFromPoint = Document.prototype.elementFromPoint
  const localName = Object.getOwnPropertyDescriptor(Element.prototype, 'localName').get
  const getBox = Element.prototype.getBoundingClientRect
  const element = elementFromPoint.call(document, options.x, options.y)
  if (!(element instanceof Element)) return null
  const box = getBox.call(element)
  return { tag: localName.call(element), rect: { x: box.x, y: box.y, width: box.width, height: box.height } }
})(${args})`
}

/** The annotated element's box with some room around it, in the view's DIP, clamped to the view; undefined if empty. */
function cropRect(rect, zoom, view) {
  const x = Math.max(0, Math.floor(rect.x * zoom) - CROP_PADDING)
  const y = Math.max(0, Math.floor(rect.y * zoom) - CROP_PADDING)
  const right = Math.min(view.width, Math.ceil((rect.x + rect.width) * zoom) + CROP_PADDING)
  const bottom = Math.min(view.height, Math.ceil((rect.y + rect.height) * zoom) + CROP_PADDING)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined
}

function nextZoom(current, direction) {
  if (direction === 'reset') return 1
  if (direction === 'in') return ZOOM_FACTORS.find(factor => factor > current + 0.001) ?? ZOOM_FACTORS.at(-1) ?? 1
  return ZOOM_FACTORS.findLast(factor => factor < current - 0.001) ?? ZOOM_FACTORS[0] ?? 1
}

/** A tab's address for the page: long addresses lose their query, then their path, rather than being cut. */
function reportedUrl(raw) {
  if (typeof raw !== 'string') return ''
  if (raw.length <= REPORTED_URL_LIMIT) return raw
  try {
    const url = new URL(raw)
    const short = `${url.origin}${url.pathname}`
    return short.length <= REPORTED_URL_LIMIT ? short : `${url.origin}/`
  } catch {
    return ''
  }
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const failure = error => Object.freeze({ ok: false, error })
const INVALID = failure('invalid')
const NOT_FOUND = failure('not-found')

function emit(tab, value) {
  const window = tab.window
  if (window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send(CHANNELS.event, { tabId: tab.id, ...value })
}

function stateOf(tab) {
  const contents = tab.contents
  if (contents.isDestroyed()) return undefined
  return {
    url: reportedUrl(contents.getURL()),
    title: cleanText(contents.getTitle(), TITLE_LIMIT),
    loading: contents.isLoading(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    zoom: Math.round(contents.getZoomFactor() * 100) / 100,
    crashed: contents.isCrashed(),
    error: tab.error,
    viewport: { preset: tab.viewport.preset, rotated: tab.viewport.rotated },
    colorScheme: tab.scheme,
    logs: { errors: tab.counts.errors, warnings: tab.counts.warnings, failed: tab.counts.failed },
    opener: tab.opener,
    control: tab.control,
    activity: tab.activity,
  }
}

function clearLogs(tab) {
  tab.console = createLog()
  tab.network = createLog()
  tab.counts = { errors: 0, warnings: 0, failed: 0 }
}

/** Main's own load of an address it checked: the address field, or a local link the person clicked in the page. */
function load(tab, url) {
  tab.error = null
  tab.contents.loadURL(url).catch(() => {
    /* Failures arrive as did-fail-load. */
  })
}

const frameKey = (frame, main) => (main ? 'main' : `frame:${frame?.frameTreeNodeId ?? 'gone'}`)

/**
 * This Mac as the Agent may use it, exactly the set the Host's broker uses (`originClass` in browser-broker.ts):
 * localhost, `*.localhost`, 127/8, ::1 and IPv4-mapped 127/8. Not 0.0.0.0 or ::, which name no one address.
 */
function agentLocalHost(hostname) {
  const host = bareHost(hostname)
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const v4 = isIP(host) === 4 ? ipv4Bytes(host) : undefined
  if (v4) return v4[0] === 127
  if (!host.startsWith('[')) return false
  const groups = ipv6Groups(host.slice(1, -1))
  if (!groups) return false
  if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return true
  return groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff && (groups[6] ?? 0) >> 8 === 127
}

/** Where a tab's main frame may go while the Agent drives it: http(s) on this Mac alone. */
function agentMayGo(raw) {
  try {
    const url = new URL(raw)
    return (url.protocol === 'http:' || url.protocol === 'https:') && agentLocalHost(url.hostname)
  } catch {
    return false
  }
}

/** What a developer tools window may show: its own devtools: pages, and about:, data: and blob: documents in frames. */
function devToolsMayGo(event) {
  let protocol
  try {
    protocol = new URL(event.url).protocol
  } catch {
    return false
  }
  return protocol === 'devtools:' || (!event.isMainFrame && FRAME_SCHEMES.has(protocol))
}

/** The page sees a tab only while it has bounds and no overlay of the page covers it; a hidden tab gives up focus. */
function applyVisibility(tab) {
  const visible = tab.bounds !== null && !tab.occluded
  if (visible) tab.view.setBounds(tab.bounds)
  tab.view.setVisible(visible)
  // A tab out of sight makes no sound; a frozen frame (an overlay, 选取元素) still counts as in sight.
  if (!tab.contents.isDestroyed()) tab.contents.setAudioMuted(tab.bounds === null)
  if (!visible && !tab.contents.isDestroyed() && tab.contents.isFocused() && !tab.window.isDestroyed()) tab.window.webContents.focus()
}

/** A capture of the tab; a tab out of sight (the Agent's, the panel shut) stays hidden while it is taken. */
async function snapshot(tab, rect, limits) {
  const shown = tab.bounds !== null && !tab.occluded
  const image = shown ? await tab.contents.capturePage(rect) : await tab.contents.capturePage(rect, { stayHidden: true })
  return encodeImage(image, limits ?? (rect ? CROP_LIMITS : CAPTURE_LIMITS))
}

/** One capture or hit test at a time per tab. */
async function exclusive(tab, run) {
  if (tab.busy) return failure('busy')
  tab.busy = true
  try {
    return await run()
  } finally {
    tab.busy = false
  }
}

/**
 * The preview tabs of the app's main window.
 * @param {object} options
 * @param {new (options: object) => any} options.WebContentsView  Electron's
 * @param {(partition: string) => any} options.fromPartition  e.g. session.fromPartition
 * @param {() => any} options.window  the main window, or undefined
 * @param {(url: string) => unknown} options.openExternal  the system browser, for a page's links to the internet
 * @param {string} [options.platform]
 * @param {(message: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {() => string} [options.newTabId]
 */
function createPreviewBrowser(options) {
  const {
    WebContentsView,
    fromPartition,
    openExternal,
    platform = process.platform,
    log = () => {},
    now = () => performance.now(),
    newTabId = () => `brw_${randomBytes(16).toString('base64url')}`,
  } = options
  /** @type {Map<string, any>} */
  const tabs = new Map()
  const tabByContents = new WeakMap()
  /** @type {Map<string, any>} */
  const sessions = new Map()
  const owned = new WeakSet()
  const guarded = new WeakSet()
  /** The developer tools pages of tabs, by WebContents ID; they alone may load devtools: URLs. */
  const devTools = new Set()
  /** Every listener port host.json has named: a Host that starts again may listen elsewhere, and the old one stays shut. */
  const ports = new Set()
  /** Set around `new WebContentsView`, in case Electron reports the new WebContents before the constructor returns. */
  let constructing = false
  /** The tabs by their WebContents ID, for the partition's request events. */
  const tabByContentsId = new Map()
  /** When each request in flight started, by webRequest ID, for its duration. */
  const starts = new Map()

  const liveWindow = () => {
    const window = options.window()
    return window && !window.isDestroyed() ? window : undefined
  }

  /** State changes come in bursts (a page can push history in a loop); the page gets at most one per 32 ms a tab. */
  function changed(tab) {
    if (tab.timer !== undefined) return
    tab.timer = setTimeout(() => {
      tab.timer = undefined
      const state = tabs.get(tab.id) === tab ? stateOf(tab) : undefined
      if (state) emit(tab, { type: 'state', state })
      tabsChanged(false)
    }, STATE_DELAY_MS)
  }

  /** Who hears that the tab table changed (the provider's report): `urgent` for who acts in a tab. */
  const tabListeners = new Set()
  function tabsChanged(urgent) {
    for (const listener of tabListeners) {
      try {
        listener(urgent)
      } catch {
        /* One listener cannot keep the others from hearing. */
      }
    }
  }

  /**
   * The session whose 浏览器 panel the page shows now, or null. A tab out of sight neither lays out, paints nor takes
   * input on macOS, so the Agent works only in a session whose panel is open, in a tab the panel shows.
   */
  let showingSession = null

  /** The gesture recorder of each tab's WebContents, so an Agent action can drop a click the person made before it. */
  const gestures = new WeakMap()

  /** Whether the Agent's input is going into a tab now, or did less than a second ago. */
  function agentWindow(tab) {
    return tab !== undefined && (tab.agentBusy || now() < tab.agentUntil)
  }

  /**
   * Whether the tab's main frame must stay on this Mac: while the Agent's input goes in and a second after, and for
   * the rest of a turn in which the Agent worked in it (a page can leave later, by a timer), unless the person took it.
   */
  function agentHolds(tab) {
    return tab !== undefined && (agentWindow(tab) || (tab.touched && tab.control !== 'person'))
  }

  /** Who hears that the person took a tab over (browser-agent.cjs stops what the Agent was doing in it). */
  const controlListeners = new Set()
  function controlChanged(tab) {
    for (const listener of controlListeners) {
      try {
        listener(tab)
      } catch {
        /* One listener cannot keep the others from hearing. */
      }
    }
  }

  /**
   * The person clicked or pressed a key in a tab the Agent has worked in this turn, while no Agent action ran: they
   * take it over, and the Agent's calls to it wait.
   */
  function personActed(tab) {
    if (!tab.touched || tab.control === 'person') return
    tab.control = 'person'
    tab.activity = null
    changed(tab)
    tabsChanged(true)
    controlChanged(tab)
  }

  /** A quiet line for the chrome, at most once a second for each kind (and permission or reason). */
  function notice(tab, kind, detail) {
    const key = `${kind}:${detail ?? ''}`
    const time = now()
    if (time - (tab.notices.get(key) ?? -Infinity) < NOTICE_INTERVAL_MS) return
    tab.notices.set(key, time)
    emit(tab, { type: 'notice', notice: kind, ...(detail === undefined ? {} : { detail }) })
  }

  const tabOf = contents => tabByContents.get(contents)
  const noticeFor = (contents, kind, detail) => {
    const tab = contents ? tabOf(contents) : undefined
    if (tab) notice(tab, kind, detail)
  }

  /** Refused once per partition, before any page loads in it. */
  function hardenSession(ses) {
    ses.setPermissionRequestHandler((contents, permission, callback) => {
      callback(false)
      noticeFor(contents, 'permission', typeof permission === 'string' && PERMISSION_NAME.test(permission) ? permission : 'unknown')
    })
    ses.setPermissionCheckHandler(() => false)
    ses.setDevicePermissionHandler(() => false)
    ses.on('select-hid-device', (event, _details, callback) => {
      event.preventDefault()
      callback()
    })
    ses.on('select-serial-port', (event, _ports, _contents, callback) => {
      event.preventDefault()
      callback('')
    })
    ses.on('select-usb-device', (event, _details, callback) => {
      event.preventDefault()
      callback()
    })
    ses.on('select-webauthn-account', (event, _details, callback) => {
      event.preventDefault()
      callback()
    })
    ses.on('will-download', (event, item, contents) => {
      event.preventDefault()
      try {
        item.cancel()
      } catch {
        /* Already gone with the default prevented. */
      }
      noticeFor(contents, 'download')
    })
    ses.setSpellCheckerEnabled(false)
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (typeof details.webContentsId === 'number' && tabByContentsId.has(details.webContentsId)) {
        if (starts.size >= STARTS_LIMIT) starts.delete(starts.keys().next().value)
        starts.set(details.id, details.timestamp)
        const tab = tabByContentsId.get(details.webContentsId)
        tab.inflight++
        tab.quietSince = now()
      }
      callback({ cancel: !requestAllowed(details, ports, devTools) })
    })
    // The 网络 list: what each request came to, never its headers or bodies; the address without its query.
    const finished = (details, error) => {
      const started = starts.get(details.id)
      starts.delete(details.id)
      const tab = typeof details.webContentsId === 'number' ? tabByContentsId.get(details.webContentsId) : undefined
      if (!tab || tabs.get(tab.id) !== tab) return
      tab.inflight = Math.max(0, tab.inflight - 1)
      tab.quietSince = now()
      const status = !error && Number.isInteger(details.statusCode) && details.statusCode > 0 ? details.statusCode : null
      const entry = {
        method: typeof details.method === 'string' && /^[A-Z]{1,16}$/u.test(details.method) ? details.method : 'GET',
        url: logUrl(details.url),
        type: typeof details.resourceType === 'string' && /^[A-Za-z]{1,32}$/u.test(details.resourceType) ? details.resourceType : 'other',
        status,
        error: error ? netError(details.error) : null,
        duration:
          typeof started === 'number' && typeof details.timestamp === 'number'
            ? Math.max(0, Math.round(details.timestamp - started))
            : null,
        size: error ? null : contentLength(details.responseHeaders),
        time: typeof details.timestamp === 'number' ? Math.round(details.timestamp) : Date.now(),
      }
      const evicted = pushLog(tab.network, entry)
      if (failedRequest(entry)) tab.counts.failed++
      if (evicted && failedRequest(evicted)) tab.counts.failed--
      changed(tab)
    }
    ses.webRequest.onCompleted(details => finished(details, false))
    ses.webRequest.onErrorOccurred(details => finished(details, true))
    ses.webRequest.onHeadersReceived((details, callback) => {
      const document = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame'
      callback(document ? { responseHeaders: withGuestPolicy(details.responseHeaders) } : {})
    })
  }

  function previewSession(projectId) {
    const known = sessions.get(projectId)
    if (known) return known
    if (sessions.size >= PARTITION_LIMIT) return undefined
    // No `persist:` prefix: the partition lives in memory and is gone when the app quits.
    const ses = fromPartition(`latch-preview-${projectId}`)
    hardenSession(ses)
    sessions.set(projectId, ses)
    owned.add(ses)
    return ses
  }

  function forward(tab, shortcut) {
    const page = tab.window.webContents
    if (tab.window.isDestroyed() || page.isDestroyed()) return
    const modifiers = [platform === 'darwin' ? 'meta' : 'control', ...(shortcut.alt ? ['alt'] : []), ...(shortcut.shift ? ['shift'] : [])]
    page.focus()
    page.sendInputEvent({ type: 'keyDown', keyCode: shortcut.keyCode, modifiers })
    page.sendInputEvent({ type: 'keyUp', keyCode: shortcut.keyCode, modifiers })
  }

  /**
   * A page's window.open, form or link with a target: never a new window. Without a click just before it, it is dropped.
   * With one, a local address opens in this tab and an internet address in the system browser.
   */
  function openFromPage(tab, details, gesture) {
    const url = previewUrl(details.url)
    if (!gesture || !url || details.postBody || reachesHost(url, ports)) {
      notice(tab, 'popup')
      return
    }
    if (isPrivateHost(url.hostname)) load(tab, url.href)
    else void Promise.resolve(openExternal(url.href)).catch(() => log('无法在浏览器中打开预览页面的链接'))
  }

  function refuseNavigation(contents, event, reason) {
    event.preventDefault()
    noticeFor(contents, 'navigation', reason)
  }

  /**
   * Rules for every WebContents in a preview partition: the tabs, and the developer tools main opens for them (which
   * may only show their own devtools: page). Idempotent; main.cjs applies it when Electron reports the WebContents, and
   * a tab applies it again before it loads anything.
   */
  function guard(contents) {
    if (guarded.has(contents)) return
    guarded.add(contents)
    // Besides the tabs, the only pages Electron makes in a preview partition are the developer tools main opens for one.
    if (!constructing && !tabOf(contents) && contents.getType() === 'remote') {
      const id = contents.id
      devTools.add(id)
      contents.once('destroyed', () => devTools.delete(id))
    }
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    const gesture = createExternalGesture(now)
    gestures.set(contents, gesture)
    /** Where each frame's navigation in flight has got to, for the redirects that follow. */
    const hops = new Map()
    // While the Agent acts and a second after, input is the Agent's: never the person's click, never a takeover.
    contents.on('before-mouse-event', (_event, input) => {
      const tab = tabOf(contents)
      if (tab && agentWindow(tab)) {
        gesture.clear()
        return
      }
      gesture.mouse(input)
      if (tab && input.type === 'mouseDown') personActed(tab)
    })
    contents.on('before-input-event', (event, input) => {
      const tab = tabOf(contents)
      const shortcut = tab ? forwardedShortcut(input, platform) : undefined
      if (tab && agentWindow(tab)) gesture.clear()
      else {
        gesture.key(input)
        if (tab && !shortcut && input.type === 'keyDown') personActed(tab)
      }
      if (!shortcut) return
      event.preventDefault()
      if (input.type === 'keyDown' && !input.isAutoRepeat) forward(tab, shortcut)
    })
    contents.on('blur', () => gesture.clear())
    contents.setWindowOpenHandler(details => {
      const tab = tabOf(contents)
      if (tab) openFromPage(tab, details, gesture.take())
      return { action: 'deny' }
    })
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('will-frame-navigate', event => {
      if (!tabOf(contents)) {
        if (!devToolsMayGo(event)) event.preventDefault()
        return
      }
      const tab = tabOf(contents)
      if (event.isMainFrame && agentHolds(tab) && !agentMayGo(event.url)) {
        refuseNavigation(contents, event, 'not-local')
        return
      }
      const verdict = navigationVerdict(
        {
          url: event.url,
          kind: 'page',
          from: event.initiator?.origin,
          gesture: event.isMainFrame ? gesture.take() : false,
          frame: !event.isMainFrame,
        },
        ports,
      )
      if (!verdict.ok) refuseNavigation(contents, event, verdict.reason)
    })
    // will-frame-navigate decides first; this keeps the scheme and Host rules if a main-frame navigation only gets here.
    contents.on('will-navigate', event => {
      if (!tabOf(contents)) {
        if (!devToolsMayGo(event)) event.preventDefault()
        return
      }
      if (agentHolds(tabOf(contents)) && !agentMayGo(event.url)) {
        refuseNavigation(contents, event, 'not-local')
        return
      }
      const verdict = navigationVerdict({ url: event.url, kind: 'typed' }, ports)
      if (!verdict.ok) refuseNavigation(contents, event, verdict.reason)
    })
    contents.on('did-start-navigation', details => {
      if (details.isSameDocument) return
      if (details.isMainFrame) {
        hops.clear()
        // Electron emits this before will-frame-navigate: a navigation the page started keeps the click for that check,
        // and one it did not (the address field, reload, history) ends any click left on the old page.
        if (!details.initiator) gesture.clear()
        const tab = tabOf(contents)
        if (tab) {
          tab.error = null
          clearLogs(tab)
        }
      } else if (hops.size >= 64) hops.delete(hops.keys().next().value)
      hops.set(frameKey(details.frame, details.isMainFrame), details.url)
    })
    contents.on('will-redirect', event => {
      if (!tabOf(contents)) {
        if (!devToolsMayGo(event)) event.preventDefault()
        return
      }
      const key = frameKey(event.frame, event.isMainFrame)
      if (event.isMainFrame && agentHolds(tabOf(contents)) && !agentMayGo(event.url)) {
        refuseNavigation(contents, event, 'not-local')
        return
      }
      const verdict = navigationVerdict({ url: event.url, kind: 'redirect', from: hops.get(key), frame: !event.isMainFrame }, ports)
      if (verdict.ok) hops.set(key, event.url)
      else refuseNavigation(contents, event, verdict.reason)
    })
    contents.on('will-prevent-unload', event => event.preventDefault())
    contents.on('certificate-error', (event, _url, _error, _certificate, callback) => {
      event.preventDefault()
      callback(false)
      noticeFor(contents, 'certificate')
    })
    contents.on('select-client-certificate', (event, _url, _list, callback) => {
      event.preventDefault()
      callback()
    })
    contents.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault()
      callback('')
    })
    for (const name of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) {
      contents.on(name, () => {
        const tab = tabOf(contents)
        if (tab) changed(tab)
      })
    }
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      const tab = tabOf(contents)
      if (!tab || !isMainFrame || code === NET_ABORTED) return
      tab.error = Number.isInteger(code) ? code : null
      changed(tab)
    })
    contents.on('render-process-gone', () => {
      const tab = tabOf(contents)
      if (tab) changed(tab)
    })
    // The 控制台 list: what the page logged, printable and cut to 500 characters.
    contents.on('console-message', event => {
      const tab = tabOf(contents)
      if (!tab) return
      const level = CONSOLE_LEVELS.has(event?.level) ? event.level : 'info'
      if (latchOwnWarning(level, event?.message)) return
      const evicted = pushLog(tab.console, {
        level,
        text: consoleText(event?.message),
        source: logUrl(event?.sourceId),
        line: Number.isSafeInteger(event?.lineNumber) && event.lineNumber >= 0 ? event.lineNumber : 0,
        time: Date.now(),
      })
      const count = (entry, step) => {
        if (entry.level === 'error') tab.counts.errors += step
        else if (entry.level === 'warning') tab.counts.warnings += step
      }
      count({ level }, 1)
      if (evicted) count(evicted, -1)
      changed(tab)
    })
    // A new document keeps the tab's viewport and color scheme.
    contents.on('did-navigate', () => {
      const tab = tabOf(contents)
      if (!tab) return
      applyEmulation(tab)
      if (tab.scheme !== 'system') void queueScheme(tab).catch(() => {})
    })
    contents.once('destroyed', () => {
      const tab = tabOf(contents)
      if (tab) drop(tab)
    })
  }

  function drop(tab) {
    if (tabs.get(tab.id) !== tab) return
    tabs.delete(tab.id)
    tabByContentsId.delete(tab.contentsId)
    if (tab.timer !== undefined) clearTimeout(tab.timer)
    if (!tab.window.isDestroyed()) tab.window.contentView.removeChildView(tab.view)
    if (!tab.contents.isDestroyed()) {
      if (tab.contents.isDevToolsOpened()) tab.contents.closeDevTools()
      tab.contents.close()
    }
    emit(tab, { type: 'closed' })
    tabsChanged(false)
  }

  function closeAll() {
    for (const tab of tabs.values()) drop(tab)
  }

  /**
   * The page went away (a reload, its renderer gone): its tabs stay, hidden and without the keyboard, until the page
   * lists them again and places them.
   */
  function hideAll() {
    showingSession = null
    for (const tab of tabs.values()) {
      tab.bounds = null
      tab.occluded = false
      tab.occlusions++
      if (!tab.contents.isDestroyed()) applyVisibility(tab)
      emit(tab, { type: 'hidden' })
    }
  }

  /** Lays a preset's page out at its size, scaled into the view; 「适应面板」 lets the view's own size be the page's. */
  function applyEmulation(tab) {
    if (tab.contents.isDestroyed()) return
    const size = viewportSize(tab.viewport)
    if (!size) {
      tab.scale = 1
      if (tab.emulated) tab.contents.disableDeviceEmulation()
      tab.emulated = false
      return
    }
    tab.scale = emulationScale(size, tab.bounds)
    tab.contents.enableDeviceEmulation({
      screenPosition: tab.viewport.preset === 'desktop' ? 'desktop' : 'mobile',
      screenSize: size,
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: size,
      scale: tab.scale,
    })
    tab.emulated = true
  }

  /**
   * `prefers-color-scheme` as the person chose, through the tab's own debugger, which main attaches only for this and
   * only while a scheme is chosen. Nothing else is ever sent over it.
   */
  async function applyScheme(tab) {
    const debug = tab.contents.debugger
    if (tab.scheme === 'system') {
      if (tab.debugging && debug.isAttached()) {
        try {
          await debug.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: '' }] })
        } finally {
          tab.debugging = false
          debug.detach()
        }
      }
      tab.debugging = false
      return
    }
    if (!debug.isAttached()) {
      debug.attach('1.3')
      tab.debugging = true
    } else if (!tab.debugging) throw new Error('attached elsewhere')
    await debug.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: tab.scheme }] })
  }

  /**
   * One scheme change at a time per tab, each applying the scheme chosen last when it runs, so quick choices end on the
   * last one with the debugger attached only if that one needs it. A failure leaves the tab on the system's scheme.
   */
  function queueScheme(tab) {
    const run = tab.schemes
      .catch(() => {})
      .then(async () => {
        if (tabs.get(tab.id) !== tab || tab.contents.isDestroyed()) return
        try {
          await applyScheme(tab)
        } catch (error) {
          schemeLost(tab)
          throw error
        }
      })
    tab.schemes = run
    return run
  }

  /**
   * The debugger went away, or a command failed: the tab follows the system again, main lets go of a debugger it
   * attached, and the page hears so.
   */
  function schemeLost(tab) {
    const ours = tab.debugging
    tab.scheme = 'system'
    tab.debugging = false
    if (ours && !tab.contents.isDestroyed() && tab.contents.debugger.isAttached()) {
      try {
        tab.contents.debugger.detach()
      } catch {
        /* Already gone. */
      }
    }
    changed(tab)
  }

  /** The tab named by a checked input, while its page is still there. */
  function tabFor(input) {
    const tab = tabs.get(input.tabId)
    return tab && !tab.contents.isDestroyed() ? tab : undefined
  }

  return {
    /** Whether a WebContents lives in a preview partition (so main.cjs gives it these rules, not the app's). */
    owns(contents) {
      if (constructing) return true
      try {
        return owned.has(contents.session)
      } catch {
        return false
      }
    },
    guard,
    /**
     * Shuts the listener ports a host.json names, and the model gateway's loopback port that host-info reports, for
     * the life of the app.
     */
    blockHost(state, info) {
      const gateway = info?.modelGatewayPort
      if (Number.isInteger(gateway) && gateway > 0 && gateway <= 65_535) ports.add(gateway)
      for (const origin of [state?.loopbackOrigin, state?.tlsOrigin]) {
        if (typeof origin !== 'string') continue
        try {
          ports.add(portOf(new URL(origin)))
        } catch {
          /* Not an origin. */
        }
      }
    },
    /** Tabs live as long as the window: a new document or a crash of its page hides them, closing the window ends them. */
    attach(window) {
      window.on('closed', () => {
        showingSession = null
        closeAll()
      })
      // Only a navigation of the page that commits: one the app's rules refuse leaves the page, and its tabs, in place.
      window.webContents.on('did-navigate', () => hideAll())
      window.webContents.on('render-process-gone', hideAll)
    },
    closeAll,
    /** Every tab of the window, with the session and project it belongs to, for a page that comes back. */
    list() {
      if (!liveWindow()) return failure('unavailable')
      const listed = []
      for (const tab of tabs.values()) {
        const state = stateOf(tab)
        if (state) listed.push({ tabId: tab.id, projectId: tab.projectId, sessionId: tab.sessionId, state })
      }
      return { ok: true, tabs: listed }
    },
    open(input) {
      const window = liveWindow()
      if (!window) return failure('unavailable')
      if (tabs.size >= TAB_LIMIT) return failure('tab-limit')
      let target
      if (input.url !== null) {
        target = addressUrl(input.url)
        if (!target) return failure('invalid-url')
        const verdict = navigationVerdict({ url: target, kind: 'typed' }, ports)
        if (!verdict.ok) return { ok: false, error: 'blocked', reason: verdict.reason }
      }
      const ses = previewSession(input.projectId)
      if (!ses) return failure('project-limit')
      let view
      constructing = true
      try {
        view = new WebContentsView({
          webPreferences: {
            session: ses,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInWorker: false,
            nodeIntegrationInSubFrames: false,
            webviewTag: false,
            navigateOnDragDrop: false,
            spellcheck: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            experimentalFeatures: false,
            plugins: false,
            // alert and confirm return at once (prompt throws): their sheets would sit on the Latch window as its own.
            disableDialogs: true,
            disableBlinkFeatures: GUEST_BLINK_FEATURES_OFF,
            // A page that reloads itself (a dev server's full reload) must not take the keyboard from the composer.
            focusOnNavigation: false,
            devTools: true,
          },
        })
      } finally {
        constructing = false
      }
      const contents = view.webContents
      const tab = {
        id: newTabId(),
        projectId: input.projectId,
        sessionId: input.sessionId,
        contentsId: contents.id,
        viewport: { preset: 'fit', rotated: false },
        scale: 1,
        emulated: false,
        scheme: 'system',
        debugging: false,
        hitting: false,
        console: createLog(),
        network: createLog(),
        counts: { errors: 0, warnings: 0, failed: 0 },
        schemes: Promise.resolve(),
        window,
        view,
        contents,
        bounds: null,
        occluded: false,
        occlusions: 0,
        error: null,
        busy: false,
        timer: undefined,
        notices: new Map(),
        opener: input.opener === 'agent' ? 'agent' : 'person',
        /** `agent` while an Agent action runs in it, `person` once the person took it over. */
        control: null,
        /** What the Agent is doing in it, for the panel's foot: 「正在点击「保存」」. */
        activity: null,
        agentBusy: false,
        agentUntil: 0,
        /** The Agent worked in it this turn: the person's own click then takes it over. */
        touched: false,
        /** Bumped when the person hands it back: every element reference handed out before is void. */
        refEpoch: 0,
        handedBack: false,
        inflight: 0,
        quietSince: now(),
      }
      tabs.set(tab.id, tab)
      tabByContents.set(contents, tab)
      tabByContentsId.set(contents.id, tab)
      contents.debugger.on('detach', () => {
        if (tab.debugging) schemeLost(tab)
      })
      guard(contents)
      view.setVisible(false)
      window.contentView.addChildView(view)
      if (target) load(tab, target)
      const state = stateOf(tab)
      // Every page hears of a new tab, so another session's list stays whole, and so does a tab the Agent opened.
      emit(tab, { type: 'opened', projectId: tab.projectId, sessionId: tab.sessionId, state })
      tabsChanged(false)
      return { ok: true, tabId: tab.id, state }
    },
    /** Which session's 浏览器 panel the page shows now, or null when it shows none. */
    showing(input) {
      showingSession = input.sessionId
      return { ok: true }
    },
    /** 接手: the person takes a tab; the Agent's calls to it wait until they hand it back. */
    takeOver(input) {
      const tab = tabFor(input)
      if (!tab) return NOT_FOUND
      if (tab.control !== 'person') {
        tab.control = 'person'
        tab.activity = null
        changed(tab)
        tabsChanged(true)
        controlChanged(tab)
      }
      return { ok: true }
    },
    /** 交还给 Agent: the Agent's calls go on, and the references it holds are void (the person may have changed the page). */
    handBack(input) {
      const tab = tabFor(input)
      if (!tab) return NOT_FOUND
      if (tab.control === 'person') {
        tab.control = null
        tab.refEpoch++
        tab.handedBack = true
        changed(tab)
        tabsChanged(true)
      }
      return { ok: true }
    },
    /**
     * What browser-agent.cjs works with: the tabs themselves and main's own ways to load, show and capture them. Only
     * main holds it; the page never reaches it.
     */
    agentAccess() {
      return {
        tabs: () => [...tabs.values()].filter(tab => !tab.contents.isDestroyed()),
        tab: tabId => tabFor({ tabId }),
        stateOf,
        load,
        drop,
        changed: (tab, urgent = false) => {
          changed(tab)
          if (urgent) tabsChanged(true)
        },
        verdict: url => navigationVerdict({ url, kind: 'typed' }, ports),
        snapshot,
        gesture: tab => gestures.get(tab.contents),
        showing: () => showingSession,
        /** Asks the page to show a tab of the session its panel shows. */
        reveal: tab => emit(tab, { type: 'reveal' }),
        aftermath: AGENT_AFTERMATH_MS,
        onControl: listener => {
          controlListeners.add(listener)
          return () => controlListeners.delete(listener)
        },
        onTabs: listener => {
          tabListeners.add(listener)
          return () => tabListeners.delete(listener)
        },
      }
    },
    close(input) {
      const tab = tabs.get(input.tabId)
      if (!tab) return NOT_FOUND
      drop(tab)
      return { ok: true }
    },
    navigate(input) {
      const tab = tabFor(input)
      if (!tab) return NOT_FOUND
      const url = addressUrl(input.url)
      if (!url) return failure('invalid-url')
      const verdict = navigationVerdict({ url, kind: 'typed' }, ports)
      if (!verdict.ok) return { ok: false, error: 'blocked', reason: verdict.reason }
      load(tab, url)
      return { ok: true, url }
    },
    go(input) {
      const tab = tabFor(input)
      if (!tab) return NOT_FOUND
      const history = tab.contents.navigationHistory
      if (input.action === 'back' && history.canGoBack()) history.goBack()
      else if (input.action === 'forward' && history.canGoForward()) history.goForward()
      else if (input.action === 'reload') tab.contents.reload()
      else if (input.action === 'stop') tab.contents.stop()
      return { ok: true }
    },
    setBounds(input) {
      const tab = tabFor(input)
      if (!tab) return NOT_FOUND
      if (input.bounds === null) tab.bounds = null
      else {
        const [width = 0, height = 0] = tab.window.getContentSize()
        tab.bounds = viewBounds(input.bounds, tab.window.webContents.getZoomFactor(), { width, height })
        if (tab.emulated) applyEmulation(tab)
      }
      applyVisibility(tab)
      return { ok: true }
    },
    /**
     * While an overlay of the page covers the panel, the view hides; the frame it showed stands in for it. Each call
     * supersedes the ones before it, so a capture that finishes after the page showed the tab again does not hide it.
     */
    async occlude(input) {
      const tab = tabFor(input)
      if (!tab) return NOT_FOUND
      const call = ++tab.occlusions
      if (!input.occluded || tab.occluded || tab.bounds === null) {
        tab.occluded = input.occluded
        applyVisibility(tab)
        return { ok: true, image: null }
      }
      /** @type {ReturnType<typeof encodeImage> | null} */
      let image = null
      try {
        image = (await snapshot(tab)) ?? null
      } catch {
        image = null
      }
      if (tabs.get(tab.id) === tab && tab.occlusions === call) {
        tab.occluded = true
        applyVisibility(tab)
      }
      return { ok: true, image }
    },
    focus(input) {
      const tab = tabFor(input)
      if (!tab) return NOT_FOUND
      if (tab.bounds === null || tab.occluded) return failure('hidden')
      tab.contents.focus()
      return { ok: true }
    },
    capture(input) {
      const tab = tabFor(input)
      if (!tab) return Promise.resolve(NOT_FOUND)
      return exclusive(tab, async () => {
        try {
          const image = await snapshot(tab)
          return image ? { ok: true, image } : failure('capture-failed')
        } catch {
          return failure('capture-failed')
        }
      })
    },
    /**
     * 标注: the element under a point of the tab (CSS pixels of the page, from the view's corner), as the isolated world
     * reports it, with its box in the same units and a picture of it.
     */
    annotate(input) {
      const tab = tabFor(input)
      if (!tab) return Promise.resolve(NOT_FOUND)
      return exclusive(tab, async () => {
        const pageZoom = tab.window.isDestroyed() ? 1 : tab.window.webContents.getZoomFactor()
        // A guest CSS pixel is this many view pixels: its own zoom, and a preset's page scaled into the view.
        const guestZoom = tab.contents.getZoomFactor() * tab.scale
        const scale = pageZoom / guestZoom
        let raw
        try {
          const code = annotationScript(input.point.x * scale, input.point.y * scale)
          raw = await withTimeout(tab.contents.executeJavaScriptInIsolatedWorld(ANNOTATION_WORLD, [{ code }]), SCRIPT_TIMEOUT_MS)
        } catch {
          return failure('no-target')
        }
        const target = annotationOf(raw)
        if (!target || tabs.get(tab.id) !== tab || tab.contents.isDestroyed()) return failure('no-target')
        const crop = cropRect(target.rect, guestZoom, tab.view.getBounds())
        /** @type {ReturnType<typeof encodeImage> | null} */
        let image = null
        try {
          image = crop ? ((await snapshot(tab, crop)) ?? null) : null
        } catch {
          image = null
        }
        const { x, y, width, height } = target.rect
        return {
          ok: true,
          target: {
            url: reportedUrl(tab.contents.mainFrame.url),
            tag: target.tag,
            selector: target.selector,
            text: target.text,
            rect: { x: x / scale, y: y / scale, width: width / scale, height: height / scale },
            image,
          },
        }
      })
    },
    /** The element under a point as the person moves over a frozen frame: only its tag and its box. */
    async hitTest(input) {
      const tab = tabFor(input)
      if (!tab) return NOT_FOUND
      if (tab.hitting) return failure('busy')
      tab.hitting = true
      try {
        const pageZoom = tab.window.isDestroyed() ? 1 : tab.window.webContents.getZoomFactor()
        const scale = pageZoom / (tab.contents.getZoomFactor() * tab.scale)
        let raw
        try {
          const code = hitTestScript(input.point.x * scale, input.point.y * scale)
          raw = await withTimeout(tab.contents.executeJavaScriptInIsolatedWorld(ANNOTATION_WORLD, [{ code }]), SCRIPT_TIMEOUT_MS)
        } catch {
          return failure('no-target')
        }
        const hit = hitOf(raw)
        if (!hit || tabs.get(tab.id) !== tab) return failure('no-target')
        const { x, y, width, height } = hit.rect
        return { ok: true, target: { tag: hit.tag, rect: { x: x / scale, y: y / scale, width: width / scale, height: height / scale } } }
      } finally {
        tab.hitting = false
      }
    },
    /** A preset size for the tab's page (or the panel's own), turned when rotated. */
    viewport(input) {
      const tab = tabFor(input)
      if (!tab) return NOT_FOUND
      tab.viewport = { preset: input.preset, rotated: input.preset === 'fit' ? false : input.rotated }
      applyEmulation(tab)
      changed(tab)
      return { ok: true, viewport: { ...tab.viewport }, size: viewportSize(tab.viewport) }
    },
    async colorScheme(input) {
      const tab = tabFor(input)
      if (!tab) return NOT_FOUND
      tab.scheme = input.scheme
      changed(tab)
      try {
        await queueScheme(tab)
      } catch {
        return failure('emulation-failed')
      }
      return { ok: true, colorScheme: tab.scheme }
    },
    /** The 控制台 and 网络 lists, the newest last. */
    logs(input) {
      const tab = tabFor(input)
      if (!tab) return NOT_FOUND
      return {
        ok: true,
        console: lastOf(tab.console, LOG_REPORTED),
        network: lastOf(tab.network, LOG_REPORTED),
      }
    },
    zoom(input) {
      const tab = tabFor(input)
      if (!tab) return NOT_FOUND
      const zoom = nextZoom(tab.contents.getZoomFactor(), input.direction)
      tab.contents.setZoomFactor(zoom)
      changed(tab)
      return { ok: true, zoom }
    },
    /** The developer tools in their own window; only main opens them, for the tab it is asked about. */
    devTools(input) {
      const tab = tabFor(input)
      if (!tab) return NOT_FOUND
      tab.contents.openDevTools({ mode: 'detach', activate: true })
      return { ok: true }
    },
    /** 清除数据: everything the project's partition holds (storage, cookies, cache, credentials, resolved names). */
    async clearData(input) {
      const ses = sessions.get(input.projectId)
      if (!ses) return { ok: true }
      try {
        await ses.clearData()
        await Promise.all([ses.clearCache(), ses.clearAuthCache(), ses.clearHostResolverCache()])
      } catch {
        log('无法清除预览浏览器的数据')
        return failure('clear-failed')
      }
      return { ok: true }
    },
    state(input) {
      const tab = tabFor(input)
      const state = tab ? stateOf(tab) : undefined
      return state ? { ok: true, state } : NOT_FOUND
    },
  }
}

/**
 * `latchShell.browser`: every channel answers only `trusted` senders (the main window's own top-level page), with
 * inputs of exactly the shape the preload sends; a guest has no preload and cannot send at all.
 */
function handleBrowserRequests({ ipcMain, trusted, controller }) {
  const refused = failure('shell-refused')
  const route = (channel, parse, action) => {
    ipcMain.handle(channel, (event, input) => {
      if (!trusted(event)) return refused
      const value = parse(input)
      return value === undefined ? INVALID : action(value)
    })
  }
  route(CHANNELS.open, INPUTS.open, input => controller.open(input))
  route(CHANNELS.close, INPUTS.tab, input => controller.close(input))
  route(CHANNELS.navigate, INPUTS.navigate, input => controller.navigate(input))
  route(CHANNELS.go, INPUTS.go, input => controller.go(input))
  route(CHANNELS.bounds, INPUTS.bounds, input => controller.setBounds(input))
  route(CHANNELS.occlude, INPUTS.occlude, input => controller.occlude(input))
  route(CHANNELS.focus, INPUTS.tab, input => controller.focus(input))
  route(CHANNELS.capture, INPUTS.tab, input => controller.capture(input))
  route(CHANNELS.annotate, INPUTS.annotate, input => controller.annotate(input))
  route(CHANNELS.zoom, INPUTS.zoom, input => controller.zoom(input))
  route(CHANNELS.devTools, INPUTS.tab, input => controller.devTools(input))
  route(CHANNELS.clearData, INPUTS.project, input => controller.clearData(input))
  route(CHANNELS.state, INPUTS.tab, input => controller.state(input))
  route(CHANNELS.list, INPUTS.none, () => controller.list())
  route(CHANNELS.viewport, INPUTS.viewport, input => controller.viewport(input))
  route(CHANNELS.colorScheme, INPUTS.colorScheme, input => controller.colorScheme(input))
  route(CHANNELS.hitTest, INPUTS.hitTest, input => controller.hitTest(input))
  route(CHANNELS.logs, INPUTS.tab, input => controller.logs(input))
  route(CHANNELS.takeOver, INPUTS.tab, input => controller.takeOver(input))
  route(CHANNELS.handBack, INPUTS.tab, input => controller.handBack(input))
  route(CHANNELS.showing, INPUTS.showing, input => controller.showing(input))
}

module.exports = {
  PROTOCOL_VERSION,
  CHANNELS,
  TAB_LIMIT,
  ADDRESS_LIMIT,
  CAPTURE_LIMITS,
  CROP_LIMITS,
  VIEWPORTS,
  LOG_LIMIT,
  LOG_REPORTED,
  TEXT_LIMIT,
  SELECTOR_LIMIT,
  ANNOTATION_WORLD,
  FORWARDED_SHORTCUTS,
  INPUTS,
  isPrivateHost,
  isLoopbackHost,
  agentMayGo,
  agentLocalHost,
  cleanText,
  reportedUrl,
  reachesHost,
  previewUrl,
  addressUrl,
  navigationVerdict,
  requestAllowed,
  viewBounds,
  forwardedShortcut,
  encodeImage,
  withGuestPolicy,
  annotationOf,
  annotationScript,
  hitOf,
  hitTestScript,
  viewportSize,
  emulationScale,
  logUrl,
  consoleText,
  latchOwnWarning,
  createLog,
  pushLog,
  lastOf,
  ELECTRON_CSP_WARNING,
  SANDBOX_WARNING,
  cropRect,
  nextZoom,
  createPreviewBrowser,
  handleBrowserRequests,
}
