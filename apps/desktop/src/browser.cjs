'use strict'
// The preview browser behind the 浏览器 tab. Each tab is a WebContentsView laid over the page's right panel, in a
// non-persistent partition of its project. A guest is untrusted web content: no preload and no Node, sandboxed with
// context isolation; every permission is refused, downloads are cancelled, `<webview>` and new windows are refused and
// WebRTC sends UDP only through a proxy. Its requests never reach a Latch Host: main refuses the Host's listener
// ports, every `h-<hostId>.localhost` name and every `/link/api` path, which also covers the `pnpm dev:web` proxy. A tab
// goes only to http(s) addresses, and a page cannot send it to another private address unless the person clicked.
// The page drives tabs through `latchShell.browser`; main answers only the main window's own page. See
// docs/PREVIEW-BROWSER.md. The exported helpers are pure so they can be unit-tested without Electron.
const { randomBytes } = require('node:crypto')
const { isIP } = require('node:net')
const { createExternalGesture } = require('./proxy.cjs')

const PROTOCOL_VERSION = 1
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
  /** Main to the page: a tab's state, a notice about something refused, or the end of a tab. */
  event: 'latch:browser:event',
})
const TAB_ID = /^brw_[A-Za-z0-9_-]{22}$/
/** As the Host hands out project IDs (and as the preload checks them). */
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/
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
const NOTICE_INTERVAL_MS = 1_000
const ZOOM_FACTORS = Object.freeze([0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3])
const GO_ACTIONS = new Set(['back', 'forward', 'reload', 'stop'])
const ZOOM_DIRECTIONS = new Set(['in', 'out', 'reset'])
/** A Latch Host's own loopback name, and names under it. */
const HOST_NAME = /(?:^|\.)h-[a-z2-7]{52}\.localhost$/u
/** C0 and C1 controls, line and paragraph separators, bidi controls and zero-width characters (as folders.cjs R8). */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u
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
 * the page, so a page never swallows them. ⌘K palette, ⌘J terminal, ⌘B sidebar, ⌥⌘B side panel, ⌘, settings.
 */
const FORWARDED_SHORTCUTS = Object.freeze(
  [
    { code: 'KeyK', keyCode: 'K', alt: false },
    { code: 'KeyJ', keyCode: 'J', alt: false },
    { code: 'KeyB', keyCode: 'B', alt: false },
    { code: 'KeyB', keyCode: 'B', alt: true },
    { code: 'Comma', keyCode: ',', alt: false },
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

function rectInput(value) {
  if (!hasOnlyKeys(value, ['x', 'y', 'width', 'height'])) return undefined
  const { x, y, width, height } = value
  if (!finite(x, -PANEL_LIMIT, PANEL_LIMIT) || !finite(y, -PANEL_LIMIT, PANEL_LIMIT)) return undefined
  return finite(width, 0, PANEL_LIMIT) && finite(height, 0, PANEL_LIMIT) ? { x, y, width, height } : undefined
}

/** Each IPC input: exactly its keys with values of its shape, copied; anything else is undefined (refused). */
const INPUTS = Object.freeze({
  open: input =>
    hasOnlyKeys(input, ['projectId', 'url'])
    && isProjectId(input.projectId)
    && (input.url === null || (typeof input.url === 'string' && input.url.length <= ADDRESS_LIMIT))
      ? { projectId: input.projectId, url: input.url }
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
  annotate: input => {
    if (!hasOnlyKeys(input, ['tabId', 'point']) || !isTabId(input.tabId) || !hasOnlyKeys(input.point, ['x', 'y'])) return undefined
    const { x, y } = input.point
    return finite(x, 0, PANEL_LIMIT) && finite(y, 0, PANEL_LIMIT) ? { tabId: input.tabId, point: { x, y } } : undefined
  },
  zoom: input =>
    hasOnlyKeys(input, ['tabId', 'direction']) && isTabId(input.tabId) && ZOOM_DIRECTIONS.has(input.direction)
      ? { tabId: input.tabId, direction: input.direction }
      : undefined,
  project: input => (hasOnlyKeys(input, ['projectId']) && isProjectId(input.projectId) ? { projectId: input.projectId } : undefined),
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

/** The forwarded shortcut `input` is, if any: ⌘ on macOS and Ctrl elsewhere, without Shift, Alt as listed. */
function forwardedShortcut(input, platform) {
  if (!input || (input.type !== 'keyDown' && input.type !== 'keyUp') || input.shift) return undefined
  const command = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
  if (!command) return undefined
  return FORWARDED_SHORTCUTS.find(item => item.code === input.code && item.alt === Boolean(input.alt))
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
  }
}

/** Main's own load of an address it checked: the address field, or a local link the person clicked in the page. */
function load(tab, url) {
  tab.error = null
  tab.contents.loadURL(url).catch(() => {
    /* Failures arrive as did-fail-load. */
  })
}

const frameKey = (frame, main) => (main ? 'main' : `frame:${frame?.frameTreeNodeId ?? 'gone'}`)

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
  if (!visible && !tab.contents.isDestroyed() && tab.contents.isFocused() && !tab.window.isDestroyed()) tab.window.webContents.focus()
}

async function snapshot(tab, rect) {
  const image = await tab.contents.capturePage(rect)
  return encodeImage(image, rect ? CROP_LIMITS : CAPTURE_LIMITS)
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
    }, STATE_DELAY_MS)
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
      callback({ cancel: !requestAllowed(details, ports, devTools) })
    })
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
    const modifiers = [platform === 'darwin' ? 'meta' : 'control', ...(shortcut.alt ? ['alt'] : [])]
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
    /** Where each frame's navigation in flight has got to, for the redirects that follow. */
    const hops = new Map()
    contents.on('before-mouse-event', (_event, input) => gesture.mouse(input))
    contents.on('before-input-event', (event, input) => {
      gesture.key(input)
      const tab = tabOf(contents)
      const shortcut = tab ? forwardedShortcut(input, platform) : undefined
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
        if (tab) tab.error = null
      } else if (hops.size >= 64) hops.delete(hops.keys().next().value)
      hops.set(frameKey(details.frame, details.isMainFrame), details.url)
    })
    contents.on('will-redirect', event => {
      if (!tabOf(contents)) {
        if (!devToolsMayGo(event)) event.preventDefault()
        return
      }
      const key = frameKey(event.frame, event.isMainFrame)
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
    contents.once('destroyed', () => {
      const tab = tabOf(contents)
      if (tab) drop(tab)
    })
  }

  function drop(tab) {
    if (tabs.get(tab.id) !== tab) return
    tabs.delete(tab.id)
    if (tab.timer !== undefined) clearTimeout(tab.timer)
    if (!tab.window.isDestroyed()) tab.window.contentView.removeChildView(tab.view)
    if (!tab.contents.isDestroyed()) {
      if (tab.contents.isDevToolsOpened()) tab.contents.closeDevTools()
      tab.contents.close()
    }
    emit(tab, { type: 'closed' })
  }

  function closeAll() {
    for (const tab of tabs.values()) drop(tab)
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
    /** Shuts the listener ports a host.json names, for the life of the app. */
    blockHost(state) {
      for (const origin of [state?.loopbackOrigin, state?.tlsOrigin]) {
        if (typeof origin !== 'string') continue
        try {
          ports.add(portOf(new URL(origin)))
        } catch {
          /* Not an origin. */
        }
      }
    },
    /** Tabs belong to the page that opened them: a reload, a crash or closing the window ends them. */
    attach(window) {
      window.on('closed', closeAll)
      window.webContents.on('did-start-navigation', details => {
        if (details.isMainFrame && !details.isSameDocument) closeAll()
      })
      window.webContents.on('render-process-gone', closeAll)
    },
    closeAll,
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
      }
      tabs.set(tab.id, tab)
      tabByContents.set(contents, tab)
      guard(contents)
      view.setVisible(false)
      window.contentView.addChildView(view)
      if (target) load(tab, target)
      return { ok: true, tabId: tab.id, state: stateOf(tab) }
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
        const guestZoom = tab.contents.getZoomFactor()
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
}

module.exports = {
  PROTOCOL_VERSION,
  CHANNELS,
  TAB_LIMIT,
  ADDRESS_LIMIT,
  CAPTURE_LIMITS,
  CROP_LIMITS,
  TEXT_LIMIT,
  SELECTOR_LIMIT,
  ANNOTATION_WORLD,
  FORWARDED_SHORTCUTS,
  INPUTS,
  isPrivateHost,
  isLoopbackHost,
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
  cropRect,
  nextZoom,
  createPreviewBrowser,
  handleBrowserRequests,
}
