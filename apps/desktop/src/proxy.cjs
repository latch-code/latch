'use strict'
// The `latch://app/` scheme handler. Every renderer request is forwarded to the Host over host.sock;
// main adds the device credential and keeps keys, signatures and credentials out of the renderer. The credential
// routes, device links (POST /link/api/pairings) and the file routes (which answer with real paths) are main's own:
// the renderer gets 403 shell-managed.
// The exported helpers are pure so they can be unit-tested without Electron.
const { createHash } = require('node:crypto')
const { socketRequest, readBody } = require('./host.cjs')
const { generateDeviceKey, enrollSigningText, renewSigningText } = require('./credentials.cjs')

const APP_ORIGIN = 'latch://app'
const HTML_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; frame-src latch-frame: blob:; worker-src 'self'; object-src 'none'; require-trusted-types-for 'script'; trusted-types latch-runtime; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
/** Buffering bounded JSON lets a request be replayed once after renewal. */
const REQUEST_BODY_LIMIT = 1024 * 1024
const BROWSER_IMAGE_BODY_LIMIT = 5 * 1024 * 1024
const BROWSER_IMAGE_PATH = /^\/link\/api\/browser-provider\/results\/[0-9a-f-]{36}\/image$/u
const PLUGIN_DRAFT_BODY_LIMIT = 8 * 1024 * 1024 + 65536
/** A 1 MiB text file in JSON, every character escaped at worst: the Host's own limit for an edit. */
const FILE_EDIT_BODY_LIMIT = 6 * 1024 * 1024 + 4096
const FILE_EDIT_PATH = /^\/link\/api\/tasks\/[^/]+\/files\/[A-Za-z0-9_-]{22}$/
const UPLOAD_BODY_LIMIT = 25 * 1024 * 1024
const JSON_RESPONSE_LIMIT = 1024 * 1024
const RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000
const RENEW_CHECK_MS = 12 * 60 * 60 * 1000
const RENEW_RETRY_MS = 60 * 1000
/** Each further failed renewal doubles the wait, up to this. */
const RENEW_RETRY_MAX_MS = 10 * 60 * 1000
/** A small authenticated route the shell calls once with a renewed credential. */
const FIRST_USE_PATH = '/link/api/audit/head'
const CONTROL_TIMEOUT_MS = 15 * 1000
const PENDING_LIMIT = 16
const ENROLLMENT_ID = /^enr_[A-Za-z0-9_-]{22}$/
const ENROLLMENT_PATH = /^\/link\/api\/enrollments\/enr_[A-Za-z0-9_-]{22}$/
const PUBLIC_API = new Set(['GET /link/api/health', 'GET /link/api/enrollment-info'])
const NOT_ENROLLED = '请先在本机确认这台设备'
/** Longer links are refused rather than shortened, so the confirmation always shows the whole URL. */
const EXTERNAL_URL_LIMIT = 2048
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304])
const CLEARING_CODES = new Set(['device-revoked', 'credential-expired', 'listener-mismatch'])
/** The messages for links: open this Host's page in the default browser; copy a link for another computer. */
const OPEN_IN_BROWSER = 'latch:open-in-browser'
const COPY_COMPUTER_LINK = 'latch:copy-computer-link'
const PAIRINGS_PATH = '/link/api/pairings'
const HOST_INFO_PATH = '/link/api/host-info'
/**
 * What a browser on this computer may ask for at enrollment; the Host confirms whatever it does ask for. It starts without
 * 管理此 Host because the loopback port may be forwarded and the desktop app can raise it later on the 手机 page.
 * `pnpm latch device invite --loopback` offers more, for a Host with no desktop app to raise it (apps/host/scripts/latch.ts).
 */
const BROWSER_INVITATION = Object.freeze({
  target: 'loopback',
  scopes: Object.freeze(['view', 'run', 'approve:standard', 'approve:elevated']),
})
/** What another computer's browser may ask for: the same scopes, through the Host's HTTPS entry. */
const COMPUTER_INVITATION = Object.freeze({ target: 'tls', scopes: BROWSER_INVITATION.scopes })
const INVITATION_FRAGMENT = /^#pair=lpi1-[A-Z2-7]{26}$/
/** The Host's invitation lifetime (INVITATION_LIFETIME in apps/host/src/auth.ts): the copied link is dead by then. */
const COPIED_LINK_MS = 10 * 60 * 1000
/** The nspasteboard.org convention: clipboard managers and history tools do not keep an entry carrying this type. */
const CONCEALED_FORMAT = 'electron application/osclipboard;format="org.nspasteboard.ConcealedType"'
const HOST_UNAVAILABLE = '无法连接到 Latch Host，请确认 Host 仍在运行。'
/** How long the Host may be gone without a restart this app made before the proxy logs it (another launch's restart). */
const OUTAGE_GRACE_MS = 15_000
const LINK_MANAGED = '设备链接只由 Latch 桌面端申请'
const COPY_FAILED = '无法复制链接，请重试。'
const DROPPED_REQUEST_HEADERS = new Set([
  'cookie',
  'authorization',
  'host',
  'origin',
  'forwarded',
  'content-length',
  'expect',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const DROPPED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'set-cookie2',
  'connection',
  'keep-alive',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
])

class ProxyError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * Which computer a window shows: `app` is the Host on this Mac's host.sock (`latch://app/`), `h-<hostId>` another
 * computer's Host over HTTPS (`latch://h-<hostId>/`, remote-proxy.cjs), each in its own session partition.
 */
const LOCAL_HOME = 'app'
const REMOTE_HOME = /^h-[a-z2-7]{52}$/

/**
 * The renderer has no network of its own: every request it makes must use the `latch:` scheme of its own computer
 * (`home`), which main answers. `devtools:` is allowed only in unpackaged development runs.
 */
function isAllowedRendererRequest(raw, { packaged, home = LOCAL_HOME }) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol === 'latch:') return url.hostname === home
  return url.protocol === 'devtools:' && !packaged
}

function frameUrl(raw) {
  try {
    const url = new URL(raw)
    return url.protocol === 'latch-frame:' && !url.port && !url.username && !url.password && !url.search ? url : undefined
  } catch {
    return undefined
  }
}

/**
 * Only fixed document bootstraps can load as subframes: `latch-frame://preview/<name>.html` on this Mac,
 * `latch-frame://h-<hostId>/preview/<name>.html` on another computer, which never runs scripts the page did not bring.
 */
function isPreviewFrameUrl(raw, home = LOCAL_HOME) {
  return previewFrameName(raw, home) !== undefined
}

/** The bootstrap a preview frame URL names (`office`, `html`…), or undefined. */
function previewFrameName(raw, home = LOCAL_HOME) {
  const url = frameUrl(raw)
  if (!url) return undefined
  const match =
    home === LOCAL_HOME
      ? url.hostname === 'preview' && /^\/(office|diagram|html|html-script)\.html$/u.exec(url.pathname)
      : url.hostname === home && /^\/preview\/(office|diagram|html)\.html$/u.exec(url.pathname)
  return match ? match[1] : undefined
}

/** The plugin page runtime: one fixed file, framed only by the app page of the same computer. */
function isAppFrameUrl(raw, home = LOCAL_HOME) {
  const url = frameUrl(raw)
  if (!url) return false
  return home === LOCAL_HOME
    ? url.hostname === 'app' && url.pathname === '/runtime.html'
    : url.hostname === home && url.pathname === '/app/runtime.html'
}

/**
 * The plugin page frame's policy, the same as the Host's (`apps/host/src/app-frame.ts`) with the app page as the only
 * ancestor: an opaque origin, the runtime's script by hash and page code only from the Blob it checked.
 */
function appFrameCsp(scriptHash, home = LOCAL_HOME) {
  return `sandbox allow-scripts; default-src 'none'; script-src '${scriptHash}' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data:; connect-src 'none'; media-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors latch://${home}`
}

/** A preview bootstrap's policy: its one script by hash (html-script: the document's own), framed only by the app page. */
function previewFrameCsp(name, scriptHash, home = LOCAL_HOME) {
  return `sandbox allow-scripts; default-src 'none'; script-src ${name === 'html-script' ? "'unsafe-inline' 'unsafe-eval'" : `'${scriptHash}'`}; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:; media-src blob: data:; worker-src 'none'; frame-src 'none'; object-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors latch://${home}`
}

function isAllowedRendererDetails(details, options) {
  const home = options.home ?? LOCAL_HOME
  if (isPreviewFrameUrl(details.url, home) || isAppFrameUrl(details.url, home)) return details.resourceType === 'subFrame'
  if (details.resourceType === 'subFrame') return false
  // A page's module: only the Blob the runtime made from the bytes the app page handed it.
  if (details.frame?.parent && isAppFrameUrl(details.frame.url, home) && details.resourceType === 'script')
    return details.url.startsWith('blob:')
  if (details.frame?.parent) return ['image', 'font', 'media'].includes(details.resourceType) && /^(?:blob:|data:)/u.test(details.url)
  if (details.initiatorOrigin === 'null') return false
  try {
    const url = new URL(details.url)
    if (isAppUrl(url.href, home) && url.pathname.startsWith('/link/api/')) {
      return details.frame !== undefined && details.frame !== null && details.frame.parent === null && isAppUrl(details.frame.url, home)
    }
  } catch {
    return false
  }
  return isAllowedRendererRequest(details.url, { ...options, home })
}

/** Navigation and redirects stay inside the window's own computer: `latch://app/`, or `latch://h-<hostId>/`. */
function isAppUrl(raw, home = LOCAL_HOME) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return url.protocol === 'latch:' && url.hostname === home && !url.port && !url.username && !url.password
}

/** How long after a native press another computer's page may still write the clipboard. */
const CLIPBOARD_GESTURE_MS = 5000

/**
 * The one browser permission an app page gets: `clipboard-sanitized-write`, which the async Clipboard API
 * (`navigator.clipboard.writeText`) asks the session's request and check handlers for. Only the top-level page of a
 * window on its own computer; never `clipboard-read`, a subframe, a plugin page or a document frame. These handlers
 * govern only that API: `execCommand('copy')` after a press is Chromium's own and does not reach them.
 */
function allowsAppPermission(permission, details, pageUrl, home = LOCAL_HOME) {
  return (
    permission === 'clipboard-sanitized-write'
    && details?.isMainFrame === true
    && isAppUrl(details.requestingUrl ?? '', home)
    && isAppUrl(pageUrl ?? '', home)
  )
}

/**
 * The request and check handlers for a window's session; everything but `allowsAppPermission` is refused. The asking
 * contents must be the window's own page (`fromWebContents`), of this computer (`homeOf`), not a preview tab
 * (`isPreviewTab`). Another computer's page (`h-<hostId>`) also needs a native press within five seconds (`gestureOf`,
 * not consumed); this Mac's own page does not.
 * @param {string} home
 * @param {{
 *   fromWebContents(contents: any): { webContents: any } | null,
 *   homeOf(contents: any): string,
 *   isPreviewTab(contents: any): boolean,
 *   gestureOf(contents: any): { recent(ms: number): boolean } | undefined,
 * }} window
 */
function appPermissionHandlers(home, window) {
  const pageOf = contents =>
    Boolean(contents)
    && !contents.isDestroyed()
    && !window.isPreviewTab(contents)
    && window.homeOf(contents) === home
    && window.fromWebContents(contents)?.webContents === contents
    && (home === LOCAL_HOME || window.gestureOf(contents)?.recent(CLIPBOARD_GESTURE_MS) === true)
  const allow = (contents, permission, details) => pageOf(contents) && allowsAppPermission(permission, details, contents.getURL(), home)
  return {
    request: (contents, permission, callback, details) => callback(allow(contents, permission, details)),
    check: (contents, permission, _origin, details) => allow(contents, permission, details),
  }
}

/**
 * Requested web/mail links use the system handler; unprompted requests are HTTPS-only with a confirmation.
 * The serialized URL is printable ASCII, without credentials or privileged system protocols.
 */
function externalUrl(raw, userGesture = false) {
  if (typeof raw !== 'string' || raw.length > EXTERNAL_URL_LIMIT) return undefined
  let url
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (!(userGesture ? ['https:', 'http:', 'mailto:'].includes(url.protocol) : url.protocol === 'https:') || url.username || url.password)
    return undefined
  return url.href.length > EXTERNAL_URL_LIMIT ? undefined : url.href
}

/** Native input is observed in main; document scripts cannot mint or reuse this one-shot allowance. */
function createExternalGesture(now = () => performance.now()) {
  let until = 0
  let last = -Infinity
  return {
    /** @param {Electron.MouseInputEvent} input */
    mouse(input) {
      if (input.type === 'mouseUp' && (input.button === 'left' || input.button === 'middle')) {
        last = now()
        until = last + 1000
      }
    },
    /** @param {Electron.Input} input */
    key(input) {
      if (input.type === 'keyDown' && !input.isAutoRepeat && ['Enter', ' ', 'Space'].includes(input.key)) {
        last = now()
        until = last + 1000
      }
    },
    take() {
      const allowed = until > now()
      until = 0
      return allowed
    },
    /** Whether a press came within `ms`, without using it up (a clipboard write does not spend a link's gesture). */
    recent(ms) {
      return now() - last <= ms
    },
    clear() {
      until = 0
      last = -Infinity
    },
  }
}

/**
 * The confirmation main shows before a link leaves the shell; cancel is the default and the Escape answer.
 * @returns {Electron.MessageBoxOptions}
 */
function externalLinkDialog(url) {
  return {
    type: 'question',
    title: 'Latch',
    message: '在浏览器中打开以下链接？',
    detail: url,
    buttons: ['打开', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
}

/**
 * One native dialog at a time across the shell: the external-link confirmation, the folder picker and the dropped
 * folders' confirmation share one gate, so the page cannot stack dialogs or slip one in while the owner reads another.
 */
function createDialogGate() {
  let open = false
  return {
    /** False while another dialog holds the gate. */
    enter() {
      if (open) return false
      open = true
      return true
    },
    leave() {
      open = false
    },
  }
}

/**
 * The Host's loopback invitation link, accepted only as `http://h-<hostId>.localhost:<port>/link/#pair=lpi1-…`: main
 * gives the system browser nothing but this Host's own page.
 */
function browserInvitationUrl(raw, hostId) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' || url.hostname !== `h-${hostId}.localhost` || !url.port || url.username || url.password) return undefined
  if (url.pathname !== '/link/' || url.search || !INVITATION_FRAGMENT.test(url.hash)) return undefined
  return url.href
}

/**
 * A link for another computer, accepted only as the Host's HTTPS origin (as host-info reports it) with path `/link/`
 * and an invitation fragment of the form `browserInvitationUrl` accepts.
 */
function computerInvitationUrl(raw, origin) {
  let url
  let expected
  try {
    url = new URL(raw)
    expected = new URL(origin)
  } catch {
    return undefined
  }
  if (expected.protocol !== 'https:' || url.protocol !== 'https:' || url.origin !== expected.origin) return undefined
  if (url.username || url.password || url.pathname !== '/link/' || url.search || !INVITATION_FRAGMENT.test(url.hash)) return undefined
  return url.href
}

/** An IPC message counts only from the app page in a window's top frame, never from a subframe or another origin. */
function isAppSender(event) {
  const frame = event?.senderFrame
  return Boolean(frame && !frame.parent && isAppUrl(frame.url))
}

/**
 * 「在这台电脑的浏览器中打开」. Main asks the Host for a one-time loopback invitation with the shell's own credential and
 * hands the link, the invitation in its fragment, to the default browser; the renderer only learns the outcome. macOS
 * passes the URL to the browser by Apple Event, while other systems start the browser with it on the command line,
 * where other processes can read it, so the action is refused there. Concurrent calls share one attempt.
 * @param {object} options
 * @param {() => Promise<{ ok: true, url: string } | { ok: false, status: number, error: string, message: string }>} options.invite
 * @param {(url: string) => Promise<unknown>} options.open  e.g. shell.openExternal
 * @param {string} options.platform
 * @param {(message: string) => void} [options.log]
 */
function createBrowserOpener({ invite, open, platform, log = () => {} }) {
  let opening
  return function openInBrowser() {
    if (platform !== 'darwin')
      return Promise.resolve(
        refusal(409, 'browser-open-unsupported', '此系统上不能从桌面端直接打开浏览器，请运行 pnpm latch device invite --loopback。'),
      )
    opening ??= (async () => {
      try {
        const result = await invite()
        if (!result.ok) return result
        await open(result.url)
        return { ok: /** @type {true} */ (true) }
      } catch {
        // The error could repeat the link, so only a fixed line is logged.
        log('无法在浏览器中打开 Latch')
        return refusal(502, 'browser-open-failed', '无法在浏览器中打开 Latch，请重试。')
      }
    })().finally(() => {
      opening = undefined
    })
    return opening
  }
}

/** One clipboard entry: the link as plain text, marked concealed. Main passes it to `new ClipboardItem()`. */
function concealedClipboardEntry(text) {
  return { 'text/plain': text, [CONCEALED_FORMAT]: '' }
}

/**
 * 「复制链接」 for another computer. Main asks the Host for a one-time invitation on its HTTPS entry and writes the link
 * to the clipboard as one concealed entry; the renderer only learns the outcome. When the invitation has expired, main
 * clears the clipboard if it still holds exactly that link: only the link's SHA-256 is kept for that check. macOS only,
 * like the browser opener, since the concealed type is a macOS convention. Concurrent calls share one attempt.
 * @param {object} options
 * @param {() => Promise<{ ok: true, url: string } | { ok: false, status: number, error: string, message: string }>} options.invite
 * @param {{ writeConcealed(text: string): Promise<void>, readText(): Promise<string>, clear(): void | Promise<void> }} options.clipboard
 * @param {string} options.platform
 * @param {(message: string) => void} [options.log]
 * @param {(callback: () => void, ms: number) => any} [options.setTimer]  a fake clock in tests
 * @param {(timer: any) => void} [options.clearTimer]
 */
function createLinkCopier({ invite, clipboard, platform, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let copying
  let clearing
  const digest = text => createHash('sha256').update(text).digest('hex')
  async function clearIfStill(expected) {
    try {
      const text = await clipboard.readText()
      if (typeof text === 'string' && digest(text) === expected) await clipboard.clear()
    } catch {
      log('无法清除剪贴板中的设备链接')
    }
  }
  return function copyLink() {
    if (platform !== 'darwin')
      return Promise.resolve(refusal(409, 'copy-link-unsupported', '此系统上不能从桌面端复制链接，请运行 pnpm latch device invite。'))
    copying ??= (async () => {
      try {
        const result = await invite()
        if (!result.ok) return result
        await clipboard.writeConcealed(result.url)
        const expected = digest(result.url)
        if (clearing !== undefined) clearTimer(clearing)
        clearing = setTimer(() => {
          clearing = undefined
          void clearIfStill(expected)
        }, COPIED_LINK_MS)
        return { ok: /** @type {true} */ (true) }
      } catch {
        // The error could repeat the link, so only a fixed line is logged.
        log('无法复制设备链接')
        return refusal(502, 'copy-link-failed', COPY_FAILED)
      }
    })().finally(() => {
      copying = undefined
    })
    return copying
  }
}

/** @returns {{ ok: false, status: number, error: string, message: string, retryAfter?: number }} */
function refusal(status, code, message, extra = {}) {
  return { ok: false, status, error: code, message, ...extra }
}

/**
 * Main's one-shot native gesture permits normal clicks without a second prompt. Other window.open requests
 * still need the owner to confirm the full URL before leaving the renderer's network confinement.
 * One confirmation at a time; links requested while it (or another native dialog sharing `gate`) is open are dropped.
 * @param {object} options
 * @param {(dialogOptions: Electron.MessageBoxOptions, parent?: Electron.BaseWindow) => Promise<{ response: number }>} options.confirm
 *   e.g. dialog.showMessageBox
 * @param {(url: string) => Promise<unknown>} options.open  e.g. shell.openExternal
 * @param {ReturnType<typeof createDialogGate>} [options.gate]  shared with the folder dialogs
 * @param {(message: string) => void} [options.log]
 */
function createExternalOpener({ confirm, open, gate = createDialogGate(), log = () => {} }) {
  return async function openExternal(raw, parent, { userGesture = false } = {}) {
    const url = externalUrl(raw, userGesture)
    if (url === undefined || !gate.enter()) return false
    try {
      if (!userGesture) {
        const { response } = await confirm(externalLinkDialog(url), parent)
        if (response !== 0) return false
      }
      await open(url)
      return true
    } catch {
      log('无法打开链接')
      return false
    } finally {
      gate.leave()
    }
  }
}

// Chromium also accepts a single leading dash, and Node and Electron spell the inspector switches several ways.
const DEBUG_SWITCH =
  /^--?(inspect(-brk|-wait)?(-node)?|inspect-port|inspect-publish-uid|debug|debug-brk|debug-port|remote-debugging-[a-z-]+|use-mock-keychain)(=|$)/i
const CODE_LOADING_OPTION = /^(-r|--require|--import|--loader|--experimental-loader)(=|$)/i
const SHELL_ARGUMENT = /^--latch-(host-state|user-data)=./

/**
 * Switches that would let another process attach to or run code in the shell (packaged builds refuse to
 * start with them). Switches that pause before main.cjs runs (the -brk variants) are only stopped by
 * disabling Electron's Node CLI inspect options at packaging time; this check runs too late for them.
 */
function debugFlagProblems(argv, env) {
  const found = new Set()
  for (const arg of argv) if (DEBUG_SWITCH.test(arg)) found.add(arg.split('=')[0])
  for (const arg of String(env.NODE_OPTIONS ?? '').split(/\s+/)) {
    if (DEBUG_SWITCH.test(arg) || CODE_LOADING_OPTION.test(arg)) found.add(`NODE_OPTIONS ${arg.split('=')[0]}`)
  }
  if (env.ELECTRON_RUN_AS_NODE !== undefined) found.add('ELECTRON_RUN_AS_NODE')
  return [...found]
}

/** A packaged shell accepts only its own two arguments, once each, after the executable. Returns the rest. */
function unexpectedArguments(args) {
  const seen = new Set()
  const problems = []
  for (const arg of args) {
    const name = arg.startsWith('-') ? arg.split('=')[0] : '（位置参数）'
    if (SHELL_ARGUMENT.test(arg) && !seen.has(name)) {
      seen.add(name)
      continue
    }
    problems.push(name)
  }
  return problems
}

/** Maps `latch://<home>/link/...` to the Host path. Anything outside `/link` is not served. */
function upstreamTarget(raw, home = LOCAL_HOME) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'latch:' || url.hostname !== home || url.port || url.username || url.password) return undefined
  if (url.pathname !== '/link' && !url.pathname.startsWith('/link/')) return undefined
  return { path: url.pathname + url.search, pathname: url.pathname }
}

/**
 * Whether main may forward the request with no credential. On host.sock a request without authorization
 * is the anonymous CLI, which may list and revoke devices and create invitations, so only what the Host
 * serves to anyone goes out bare: static files and the enrollment routes. API matching is exact on the
 * path the Host sees; any other spelling of an API path waits for a credential.
 */
function isPublicRoute(method, pathname, normalized) {
  const lower = normalized.toLowerCase()
  const api = pathname === '/link/api' || pathname.startsWith('/link/api/') || lower === '/link/api' || lower.startsWith('/link/api/')
  if (!api) return method === 'GET' || method === 'HEAD'
  if (PUBLIC_API.has(`${method} ${pathname}`)) return true
  return (method === 'GET' || method === 'DELETE') && ENROLLMENT_PATH.test(pathname)
}

/**
 * The routes that add folders to projects (new project, add or re-select a folder, a clone, and their nonce). Only main calls
 * them, after a native picker or confirmation and with its own signature; the page asks main through
 * `latchShell.folders`. `lower` is the decoded, slash-collapsed, lower-case path.
 */
function isFolderAddRoute(method, lower) {
  if (lower === '/link/api/folder-grants' || lower.startsWith('/link/api/folder-grants/')) return true
  if (/^\/link\/api\/workspaces\/[^/]+\/folders$/.test(lower)) return true
  // 克隆 makes a project folder where the native picker chose: main signs it too. Its progress and cancel are the page's.
  if (lower === '/link/api/workspaces/clone' && String(method).toUpperCase() === 'POST') return true
  // 导出全部 writes where the native picker chose: main signs it too. Its progress and cancel are the page's.
  if (lower === '/link/api/data/export' && String(method).toUpperCase() === 'POST') return true
  return lower === '/link/api/workspaces' && String(method).toUpperCase() === 'POST'
}

/** Route detection works on a decoded, slash-collapsed, case-folded path so encodings cannot slip past it. */
function classifyRoute(method, pathname) {
  let decoded = pathname
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    /* Keep the raw path; the Host rejects it. */
  }
  decoded = decoded.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1')
  const lower = decoded.toLowerCase()
  if (lower === '/link/api/credentials' || lower.startsWith('/link/api/credentials/')) return { kind: 'credentials' }
  if (method === 'POST' && pathname === '/link/api/attachments') return { kind: 'attachment-upload' }
  if (isFolderAddRoute(method, lower)) return { kind: 'folders' }
  // The browser provider is main itself (browser-agent.cjs): the page can neither register as one nor answer its calls.
  if (lower === '/link/api/browser-provider' || lower.startsWith('/link/api/browser-provider/')) return { kind: 'browser-provider' }
  // Sleep, wake and coming stops are reported by main itself (lifecycle.cjs), never on the page's behalf.
  if (lower === '/link/api/host/state' || lower.startsWith('/link/api/host/state/')) return { kind: 'host-state' }
  // The install window is main's alone (updater.cjs): the page can ask main to install, never hold the Host's starts.
  if (lower === '/link/api/host/update-window' || lower.startsWith('/link/api/host/update-window/')) return { kind: 'host-update' }
  // 诊断导出 is main's: it asks the Host and writes the file the person chose in a save panel; the page only asks main.
  if (lower === '/link/api/diagnostics' || lower.startsWith('/link/api/diagnostics/')) return { kind: 'diagnostics' }
  // A session ID with an encoded slash decodes into more than one segment, so any depth under /tasks/ counts.
  if (
    lower === '/link/api/files'
    || lower.startsWith('/link/api/files/')
    || /^\/link\/api\/(?:tasks|workspaces)\/.+\/files(?:\/|$)/.test(lower)
  ) {
    const content = (method === 'GET' || method === 'HEAD') && /^\/link\/api\/files\/[A-Za-z0-9_-]{22}(?:\/meta)?$/.test(decoded)
    const reference = method === 'POST' && /^\/link\/api\/(?:tasks|workspaces)\/[^/]+\/files\/(?:resolve|search|grep)$/.test(decoded)
    const listing = method === 'GET' && /^\/link\/api\/(?:tasks|workspaces)\/[^/]+\/files\/list$/.test(decoded)
    // The person's edit of a file they opened: the Host checks the handle, the version and the audit as for any device.
    const edit = method === 'PUT' && FILE_EDIT_PATH.test(decoded)
    if (!content && !reference && !listing && !edit) return { kind: 'shell-files' }
  }
  if (lower === '/link/api/enrollments' && method === 'POST') return { kind: 'enroll' }
  const complete = /^\/link\/api\/enrollments\/([^/]+)\/complete$/i.exec(decoded)
  if (complete) return { kind: 'complete', enrollmentId: complete[1] }
  const route = { kind: 'forward' }
  if (isPublicRoute(method, pathname, decoded)) route.public = true
  if (lower === '/link/api/pairings' && method === 'POST') route.pairing = true
  const enrollment = /^\/link\/api\/enrollments\/([^/]+)$/i.exec(decoded)
  if (enrollment && method === 'DELETE') route.cancelEnrollment = enrollment[1]
  if (lower === '/link/api/devices/current' && method === 'DELETE') route.selfRevoke = true
  return route
}

function forwardRequestHeaders(headers, credential) {
  const result = {}
  for (const [name, value] of new Headers(headers)) {
    const key = name.toLowerCase()
    if (DROPPED_REQUEST_HEADERS.has(key) || key.startsWith('proxy-') || key.startsWith('x-forwarded-')) continue
    result[key] = value
  }
  if (credential !== undefined) result.authorization = `Latch-Device ${credential}`
  return result
}

function isHtmlContentType(value) {
  const type = String(value ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  return type === 'text/html' || type === 'application/xhtml+xml'
}

/** `raw` is Node's IncomingHttpHeaders (or anything Headers accepts). */
function forwardResponseHeaders(raw) {
  const headers = new Headers()
  const entries = raw instanceof Headers || Array.isArray(raw) ? [...new Headers(raw)] : Object.entries(raw ?? {})
  for (const [name, value] of entries) {
    const key = name.toLowerCase()
    if (DROPPED_RESPONSE_HEADERS.has(key) || value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(key, String(item))
  }
  if (isHtmlContentType(headers.get('content-type'))) headers.set('content-security-policy', HTML_CSP)
  return headers
}

/** The renderer's enrollment request with main's public key in place of anything it supplied. */
function rewriteEnrollmentBody(text, publicKey) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new ProxyError(400, 'invalid-json', '请求不是有效的 JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProxyError(400, 'invalid-input', '输入格式不正确，请检查必填内容')
  return JSON.stringify({ ...value, publicKey })
}

function stripCredential(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const { credential: _credential, ...rest } = value
  return rest
}

/** What main does about a 401 from the Host: renew and retry, forget the device, or nothing. */
function authFailureAction(status, body) {
  if (status !== 401 || !body || typeof body !== 'object') return undefined
  if (body.error === 'renewal-required') return 'renew'
  if (CLEARING_CODES.has(body.error)) return 'clear'
  return undefined
}

function errorBody(code, message) {
  return { error: code, message }
}

function jsonResponse(status, value, base) {
  const headers = new Headers(base)
  headers.delete('content-length')
  headers.set('content-type', 'application/json; charset=utf-8')
  headers.set('cache-control', 'no-store')
  headers.set('x-content-type-options', 'nosniff')
  return new Response(JSON.stringify(value), { status, headers })
}

function errorResponse(status, code, message) {
  return jsonResponse(status, errorBody(code, message))
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
}

function htmlErrorPage(message) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Latch</title><style>body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:48px;color:#18181b;background:#EBEBEF}@media (prefers-color-scheme:dark){body{color:#f4f4f5;background:#09090B}}</style></head><body><p>${escapeHtml(message)}</p></body></html>`
}

function unavailableResponse(pathname) {
  const message = HOST_UNAVAILABLE
  if (pathname?.startsWith('/link/api/')) return errorResponse(502, 'host-unavailable', message)
  return new Response(htmlErrorPage(message), {
    status: 502,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': HTML_CSP, 'cache-control': 'no-store' },
  })
}

async function readRequestBody(request, limit) {
  if (!request.body) return undefined
  const reader = request.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      throw new ProxyError(413, 'body-too-large', '请求内容过长')
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
  }
  return Buffer.concat(chunks)
}

async function discardRequestBody(request) {
  if (request.body) await request.body.cancel().catch(() => {})
}

/** Reads a whole (small) upstream response; `json` is undefined when the body is not JSON. */
async function bufferUpstream({ response }) {
  const buffer = await readBody(response, JSON_RESPONSE_LIMIT)
  let json
  if (/json/i.test(String(response.headers['content-type'] ?? ''))) {
    try {
      json = JSON.parse(buffer.toString('utf8'))
    } catch {
      json = undefined
    }
  }
  return { status: response.statusCode, headers: response.headers, buffer, json }
}

function bufferedResponse(result, method) {
  const body = method === 'HEAD' || NULL_BODY_STATUS.has(result.status) ? null : result.buffer
  return new Response(body, { status: result.status, headers: forwardResponseHeaders(result.headers) })
}

/**
 * Streams the upstream body; cancelling the renderer's reader destroys the socket to the Host. `observe` sees each
 * chunk as it passes (remote-proxy.cjs reads the Host's own `host-state` frames from the event stream).
 */
function streamedResponse({ request: upstreamRequest, response }, method, observe) {
  const status = response.statusCode
  const headers = forwardResponseHeaders(response.headers)
  if (method === 'HEAD' || NULL_BODY_STATUS.has(status)) {
    response.resume()
    return new Response(null, { status, headers })
  }
  let finished = false
  const body = new ReadableStream({
    start(controller) {
      response.on('data', chunk => {
        if (finished) return
        observe?.(chunk)
        controller.enqueue(new Uint8Array(chunk))
        if ((controller.desiredSize ?? 1) <= 0) response.pause()
      })
      response.once('end', () => {
        if (!finished) {
          finished = true
          controller.close()
        }
      })
      response.once('error', error => {
        if (!finished) {
          finished = true
          controller.error(error)
        }
      })
      response.once('close', () => {
        if (!finished) {
          finished = true
          controller.error(new Error('Latch 服务连接中断'))
        }
      })
    },
    pull() {
      response.resume()
    },
    cancel() {
      finished = true
      upstreamRequest.destroy()
      response.destroy()
    },
  })
  return new Response(body, { status, headers })
}

const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json', accept: 'application/json' })

/**
 * @param {object} options
 * @param {string} options.hostId
 * @param {() => Promise<string>} options.resolveSocket  socket path of the verified Host
 * @param {() => void} [options.invalidateSocket]  called after a connection error so the next request re-verifies the Host
 * @param {() => boolean} [options.hostTransitioning]  whether the Host is being stopped or started on purpose right now
 * @param {Awaited<ReturnType<typeof import('./credentials.cjs').openCredentialStore>>} options.store
 * @param {(message: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {typeof generateDeviceKey} [options.generateKey]
 */
function createShellProxy(options) {
  const { hostId, store, log = () => {}, now = Date.now, generateKey = generateDeviceKey } = options
  const pending = new Map()
  let renewing
  /** When the current credential should be rotated; 0 = unknown (renew at the next opportunity). */
  let renewAfter = 0
  /** After a failed renewal no new attempt starts before this time, not even for a 401 renewal-required. */
  let retryAt = 0
  /** Consecutive failed renewals; the wait doubles with each one. */
  let failures = 0
  /** Errors from reaching the Host at all (no verified Host, or the socket failed), as opposed to the proxy's own. */
  const unreachable = new WeakSet()
  /** When the Host stopped answering, unless a restart this app made explains it; whether that was logged. */
  let outageSince
  let outageLogged = false

  function hostUnreachable(error) {
    if (error && typeof error === 'object') unreachable.add(error)
    return error
  }

  function hostAnswered() {
    outageSince = undefined
    outageLogged = false
  }

  /**
   * A request the Host did not answer. While a restart is under way (this app's, or another launch's that ends within
   * OUTAGE_GRACE_MS) that is expected and the page shows it is reconnecting; a Host still gone after that is logged once
   * per outage.
   */
  function hostFailed(error) {
    if (options.hostTransitioning?.()) {
      outageSince = now()
      return
    }
    outageSince ??= now()
    if (outageLogged || now() - outageSince < OUTAGE_GRACE_MS) return
    outageLogged = true
    log(`转发请求失败：${error instanceof Error ? error.message : '未知错误'}`)
  }

  async function upstream(method, path, headers, body, timeoutMs) {
    let socketPath
    try {
      socketPath = await options.resolveSocket()
    } catch (error) {
      throw hostUnreachable(error)
    }
    try {
      const result = await socketRequest(socketPath, { method, path, headers, body, timeoutMs })
      hostAnswered()
      return result
    } catch (error) {
      options.invalidateSocket?.()
      throw hostUnreachable(error)
    }
  }

  async function control(path, credential, value) {
    const headers = { ...JSON_HEADERS, authorization: `Latch-Device ${credential}` }
    return bufferUpstream(await upstream('POST', path, headers, Buffer.from(JSON.stringify(value)), CONTROL_TIMEOUT_MS))
  }

  async function forget(credential) {
    if (store.current()?.credential !== credential) return
    await store.clear()
    renewAfter = 0
    log('设备凭据已失效，已删除本地凭据与密钥')
  }

  /** Challenge, sign and renew. Resolves true when a fresh credential is stored. */
  function renew() {
    renewing ??= (async () => {
      const current = store.current()
      if (!current) return false
      const renewed = await renewCredential(current)
      failures = renewed ? 0 : failures + 1
      retryAt = renewed ? 0 : now() + Math.min(RENEW_RETRY_MAX_MS, RENEW_RETRY_MS * 2 ** Math.min(failures - 1, 10))
      return renewed
    })().finally(() => {
      renewing = undefined
    })
    return renewing
  }

  /** Joins a running renewal, or starts one unless a failed renewal's wait is still running. */
  function renewUnlessWaiting() {
    if (renewing || now() >= retryAt) return renew()
    return Promise.resolve(false)
  }

  function renewDue() {
    return store.current() !== undefined && now() >= retryAt && (renewAfter === 0 || now() >= renewAfter)
  }

  async function renewCredential(current) {
    try {
      const challenge = await control('/link/api/credentials/challenge', current.credential, {})
      if (challenge.status !== 200 || typeof challenge.json?.nonce !== 'string') {
        if (authFailureAction(challenge.status, challenge.json) === 'clear') await forget(current.credential)
        return false
      }
      const signature = store.sign(renewSigningText(hostId, current.deviceId, challenge.json.nonce))
      // The Host keeps the presented credential current until the new one is first used, so a lost answer or
      // a failed write below only means renewing again later with the stored credential.
      const result = await control('/link/api/credentials/renew', current.credential, { nonce: challenge.json.nonce, signature })
      if (result.status !== 200 || typeof result.json?.credential !== 'string') {
        if (authFailureAction(result.status, result.json) === 'clear') await forget(current.credential)
        return false
      }
      try {
        await store.setCredential(result.json.credential)
      } catch (error) {
        log(`设备凭据已续期，但保存失败，继续使用原凭据：${error instanceof Error ? error.message : '未知错误'}`)
        return false
      }
      const next = Date.parse(result.json.device?.renewAfter ?? '')
      renewAfter = Number.isFinite(next) ? next : now() + RENEW_INTERVAL_MS
      await useOnce(result.json.credential)
      return store.current() !== undefined
    } catch (error) {
      log(`设备凭据续期失败：${error instanceof Error ? error.message : '未知错误'}`)
      return false
    }
  }

  /**
   * The Host drops a renewed credential that stays unused for 10 minutes, so it is presented once right away
   * rather than at the renderer's next request. If this fails, that next request presents it instead.
   */
  async function useOnce(credential) {
    try {
      const headers = { accept: 'application/json', authorization: `Latch-Device ${credential}` }
      const result = await bufferUpstream(await upstream('GET', FIRST_USE_PATH, headers, undefined, CONTROL_TIMEOUT_MS))
      if (authFailureAction(result.status, result.json) === 'clear') await forget(credential)
    } catch (error) {
      log(`无法立即使用续期后的设备凭据，将在下一个请求时使用：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  /**
   * One of main's own Host calls with the shell's credential (`send(credential)` answers buffered). Renews once on
   * renewal-required, and forgets a credential the Host reports revoked or expired, as forwarding does. Anything but
   * `status` comes back as a refusal carrying the Host's code and message.
   */
  async function shellCall(send, status) {
    if (!store.current()) return { refused: refusal(401, 'unauthorized', NOT_ENROLLED) }
    if (renewAfter !== 0 && renewDue()) await renew()
    for (let attempt = 0; ; attempt++) {
      const used = store.current()?.credential
      if (used === undefined) return { refused: refusal(401, 'unauthorized', NOT_ENROLLED) }
      const result = await send(used)
      if (result.status === status) return { result }
      const action = authFailureAction(result.status, result.json)
      if (action === 'renew' && attempt === 0) {
        const latest = store.current()?.credential
        if ((latest !== undefined && latest !== used) || (await renewUnlessWaiting())) continue
      }
      if (action === 'clear') await forget(used)
      const body = result.json && typeof result.json === 'object' ? result.json : {}
      return {
        refused: refusal(
          result.status,
          typeof body.error === 'string' ? body.error : 'request-failed',
          typeof body.message === 'string' ? body.message : '',
          typeof body.retryAfter === 'number' ? { retryAfter: body.retryAfter } : {},
        ),
      }
    }
  }

  /** A one-time invitation for a browser on this computer, made over host.sock with the shell's own credential. */
  async function browserInvitation() {
    try {
      const { result, refused } = await shellCall(used => control(PAIRINGS_PATH, used, BROWSER_INVITATION), 201)
      if (refused) return refused
      const url = browserInvitationUrl(result.json?.invitation?.url, hostId)
      return url ? { ok: /** @type {true} */ (true), url } : refusal(502, 'browser-open-failed', '无法在浏览器中打开 Latch，请重试。')
    } catch (error) {
      log(`生成浏览器链接失败：${error instanceof Error ? error.message : '未知错误'}`)
      return refusal(502, 'host-unavailable', HOST_UNAVAILABLE)
    }
  }

  /**
   * A one-time invitation for another computer's browser, on the Host's HTTPS entry: main first reads that entry's
   * origin from host-info, and accepts only a link on it. A Host without the entry is refused before any invitation.
   */
  async function computerInvitation() {
    try {
      const headers = { accept: 'application/json' }
      const info = await shellCall(
        async used =>
          bufferUpstream(await upstream('GET', HOST_INFO_PATH, forwardRequestHeaders(headers, used), undefined, CONTROL_TIMEOUT_MS)),
        200,
      )
      if (info.refused) return info.refused
      const origin = info.result.json?.hostId === hostId ? info.result.json.tlsOrigin : undefined
      if (typeof origin !== 'string') return refusal(409, 'tls-not-configured', '尚未配置 HTTPS 入口，无法生成链接')
      const { result, refused } = await shellCall(used => control(PAIRINGS_PATH, used, COMPUTER_INVITATION), 201)
      if (refused) return refused
      const url = computerInvitationUrl(result.json?.invitation?.url, origin)
      return url ? { ok: /** @type {true} */ (true), url } : refusal(502, 'copy-link-failed', COPY_FAILED)
    } catch {
      // A fixed line: nothing from the answer, which may carry the link.
      log('生成另一台电脑的链接失败')
      return refusal(502, 'host-unavailable', HOST_UNAVAILABLE)
    }
  }

  function prunePending() {
    const time = now()
    for (const [id, entry] of pending) if (entry.until <= time) pending.delete(id)
    while (pending.size > PENDING_LIMIT) pending.delete(pending.keys().next().value)
  }

  async function enroll(request) {
    const text = (await readRequestBody(request, 64 * 1024))?.toString('utf8') ?? ''
    const key = generateKey()
    const body = Buffer.from(rewriteEnrollmentBody(text, key.publicKey))
    const result = await bufferUpstream(await upstream('POST', '/link/api/enrollments', { ...JSON_HEADERS }, body))
    const enrollment = result.json?.enrollment
    if (result.status >= 200 && result.status < 300 && ENROLLMENT_ID.test(enrollment?.id ?? '') && typeof enrollment.nonce === 'string') {
      if (enrollment.fingerprint !== key.fingerprint) {
        await upstream('DELETE', `/link/api/enrollments/${enrollment.id}`, { accept: 'application/json' }, undefined, CONTROL_TIMEOUT_MS)
          .then(bufferUpstream)
          .catch(() => {})
        return errorResponse(502, 'fingerprint-mismatch', '这台设备的密钥和 Mac 读到的不一致，已停止连接。')
      }
      const expires = Date.parse(enrollment.expiresAt ?? '')
      pending.set(enrollment.id, {
        key,
        nonce: enrollment.nonce,
        until: Math.max(Number.isFinite(expires) ? expires : 0, now() + 120_000) + 30_000,
      })
      prunePending()
    }
    return bufferedResponse(result, 'POST')
  }

  async function complete(request, enrollmentId) {
    await discardRequestBody(request)
    if (request.method !== 'POST') return errorResponse(405, 'method-not-allowed', '不支持此操作')
    prunePending()
    const entry = pending.get(enrollmentId)
    if (!entry) return errorResponse(404, 'enrollment-not-found', '找不到这个连接请求')
    const signature = entry.key.sign(enrollSigningText(hostId, enrollmentId, entry.nonce))
    const result = await bufferUpstream(
      await upstream(
        'POST',
        `/link/api/enrollments/${enrollmentId}/complete`,
        { ...JSON_HEADERS },
        Buffer.from(JSON.stringify({ signature })),
      ),
    )
    const device = result.json?.device
    if (result.status === 200 && typeof result.json?.credential === 'string' && typeof device?.id === 'string') {
      pending.delete(enrollmentId)
      try {
        await store.commit({ key: entry.key, deviceId: device.id, credential: result.json.credential })
      } catch (error) {
        log(`保存设备凭据失败：${error instanceof Error ? error.message : '未知错误'}`)
        return errorResponse(500, 'credential-store-failed', '无法保存设备凭据，请重新连接。')
      }
      renewAfter = now() + RENEW_INTERVAL_MS
      retryAt = 0
      failures = 0
      return jsonResponse(200, { device }, forwardResponseHeaders(result.headers))
    }
    if (result.status === 403 || result.status === 404 || result.status === 410 || result.json?.error === 'enrollment-completed')
      pending.delete(enrollmentId)
    if (result.json !== undefined) return jsonResponse(result.status, stripCredential(result.json), forwardResponseHeaders(result.headers))
    return bufferedResponse(result, 'POST')
  }

  async function forwardUpload(request, target) {
    if (!store.current()) {
      await discardRequestBody(request)
      return errorResponse(401, 'unauthorized', NOT_ENROLLED)
    }
    if (renewDue()) await renew()
    const current = store.current()
    if (!current) {
      await discardRequestBody(request)
      return errorResponse(401, 'unauthorized', NOT_ENROLLED)
    }
    const headers = forwardRequestHeaders(request.headers, current.credential)
    let socketPath
    try {
      socketPath = await options.resolveSocket()
    } catch (error) {
      throw hostUnreachable(error)
    }
    let result
    try {
      result = await socketRequest(socketPath, {
        method: 'POST',
        path: target.path,
        headers,
        bodyStream: request.body,
        bodyLimit: UPLOAD_BODY_LIMIT,
        timeoutMs: 60_000,
        signal: request.signal,
        check: () => {
          if (store.current()?.deviceId !== current.deviceId) throw new ProxyError(401, 'unauthorized', NOT_ENROLLED)
        },
      })
    } catch (error) {
      if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'body-too-large')
        throw new ProxyError(413, 'body-too-large', '请求内容过长')
      options.invalidateSocket?.()
      throw error instanceof ProxyError ? error : hostUnreachable(error)
    }
    hostAnswered()
    if (result.response.statusCode !== 401) return finish(result, 'POST', { kind: 'forward' })
    const failure = await bufferUpstream(result),
      action = authFailureAction(401, failure.json)
    if (action === 'renew' && (await renewUnlessWaiting())) return errorResponse(409, 'upload-retry', '连接凭据已更新，请重试上传。')
    if (action === 'clear') await forget(current.credential)
    return bufferedResponse(failure, 'POST')
  }

  async function forward(request, target, route) {
    if (!route.public && !store.current()) {
      await discardRequestBody(request)
      return errorResponse(401, 'unauthorized', NOT_ENROLLED)
    }
    const pluginDraft =
      (request.method === 'POST' && target.pathname === '/link/api/plugin-packages')
      || (request.method === 'PUT' && /^\/link\/api\/plugin-packages\/[A-Za-z0-9_-]{1,64}$/u.test(target.pathname))
    // Every link to connect a device is main's: the phone sheet asks native/pairings, and main asks this route itself.
    if (route.pairing) {
      await discardRequestBody(request)
      return errorResponse(403, 'shell-managed', LINK_MANAGED)
    }
    const fileEdit = request.method === 'PUT' && FILE_EDIT_PATH.test(target.pathname)
    // Only main reaches this path (classifyRoute): an Agent's screenshot, at most 5 MiB.
    const browserImage = request.method === 'PUT' && BROWSER_IMAGE_PATH.test(target.pathname)
    const body = await readRequestBody(
      request,
      pluginDraft
        ? PLUGIN_DRAFT_BODY_LIMIT
        : fileEdit
          ? FILE_EDIT_BODY_LIMIT
          : browserImage
            ? BROWSER_IMAGE_BODY_LIMIT
            : REQUEST_BODY_LIMIT,
    )
    if (renewAfter !== 0 && renewDue()) await renew()
    let used = store.current()?.credential
    const send = () => {
      // The credential can be gone by now: revoked or expired during renewal, or a concurrent self-revoke.
      if (used === undefined && !route.public) throw new ProxyError(401, 'unauthorized', NOT_ENROLLED)
      const headers = forwardRequestHeaders(request.headers, used)
      return upstream(request.method, target.path, headers, body)
    }
    let result = await send()
    if (result.response.statusCode === 401) {
      let failure = await bufferUpstream(result)
      let action = authFailureAction(401, failure.json)
      if (action === 'renew' && used !== undefined) {
        // Another request may already have renewed the credential this one was sent with.
        const latest = store.current()?.credential
        const renewed = latest !== undefined && latest !== used ? true : await renewUnlessWaiting()
        const current = renewed ? store.current() : undefined
        if (current) {
          used = current.credential
          result = await send()
          if (result.response.statusCode !== 401) return finish(result, request.method, route)
          failure = await bufferUpstream(result)
          action = authFailureAction(401, failure.json)
        }
      }
      if (action === 'clear' && used !== undefined) await forget(used)
      return bufferedResponse(failure, request.method)
    }
    return finish(result, request.method, route)
  }

  async function finish(result, method, route) {
    const status = result.response.statusCode
    if (route.cancelEnrollment) pending.delete(route.cancelEnrollment)
    if (route.selfRevoke && status >= 200 && status < 300) {
      const current = store.current()
      if (current) await forget(current.credential)
    }
    return streamedResponse(result, method)
  }

  /** @param {'renderer' | 'shell'} origin  Main alone can reach native actions and signed folder registration. */
  async function dispatch(request, origin) {
    if (origin !== 'shell' && request.headers.get('origin') === 'null') {
      await discardRequestBody(request)
      return errorResponse(403, 'untrusted-frame', '文档预览不能访问工作台接口')
    }
    const target = upstreamTarget(request.url)
    if (!target) {
      await discardRequestBody(request)
      return errorResponse(404, 'not-found', '页面不存在')
    }
    try {
      const route = classifyRoute(request.method, target.pathname)
      if (route.kind === 'attachment-upload') return await forwardUpload(request, target)
      if (route.kind === 'credentials') {
        await discardRequestBody(request)
        return errorResponse(403, 'shell-managed', '设备凭据由 Latch 桌面端管理')
      }
      if (route.kind === 'host-state') {
        await discardRequestBody(request)
        return errorResponse(403, 'shell-managed', '电脑的运行状态由 Latch 桌面端报告')
      }
      if (route.kind === 'host-update') {
        if (origin !== 'shell') {
          await discardRequestBody(request)
          return errorResponse(403, 'shell-managed', '更新由 Latch 桌面端处理')
        }
        return await forward(request, target, { kind: 'forward' })
      }
      if (route.kind === 'diagnostics') {
        if (origin !== 'shell') {
          await discardRequestBody(request)
          return errorResponse(403, 'shell-managed', '诊断导出由 Latch 桌面端处理')
        }
        return await forward(request, target, { kind: 'forward' })
      }
      if (route.kind === 'shell-files') {
        if (origin !== 'shell') {
          await discardRequestBody(request)
          return errorResponse(403, 'shell-managed', '文件操作由 Latch 桌面端管理')
        }
        return await forward(request, target, { kind: 'forward' })
      }
      if (route.kind === 'browser-provider') {
        if (origin !== 'shell') {
          await discardRequestBody(request)
          return errorResponse(403, 'shell-managed', '浏览器由 Latch 桌面端提供')
        }
        return await forward(request, target, { kind: 'forward' })
      }
      if (route.kind === 'folders') {
        if (origin !== 'shell') {
          await discardRequestBody(request)
          return errorResponse(403, 'shell-managed', '添加文件夹由 Latch 桌面端处理')
        }
        return await forward(request, target, { kind: 'forward' })
      }
      if (route.kind === 'enroll') return await enroll(request)
      if (route.kind === 'complete') return await complete(request, route.enrollmentId)
      return await forward(request, target, route)
    } catch (error) {
      if (error instanceof ProxyError) return errorResponse(error.status, error.code, error.message)
      if (error && typeof error === 'object' && unreachable.has(error)) hostFailed(error)
      else log(`转发请求失败：${error instanceof Error ? error.message : '未知错误'}`)
      return unavailableResponse(target.pathname)
    }
  }

  /** The `latch:` scheme handler: everything the renderer requests. */
  function handle(request, { shell = false } = {}) {
    return dispatch(request, shell ? 'shell' : 'renderer')
  }

  /**
   * A Host API call of main's own, with the shell's credential (renewed and retried like a renderer request). Only
   * main can make it, so it alone reaches the folder-add routes. Resolves `{ status, json }`; `json` is undefined
   * when the answer is not JSON.
   * @param {string} method
   * @param {string} path  e.g. /link/api/workspaces
   * @param {unknown} [body]  sent as JSON
   */
  async function shellRequest(method, path, body) {
    const response = await dispatch(
      new Request(`${APP_ORIGIN}${path}`, {
        method,
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      'shell',
    )
    const json = await response.json().catch(() => undefined)
    return { status: response.status, json }
  }

  /** Renews when due: checks at least every 12 h, and again once a failed attempt's wait has passed. */
  function startRenewalTimer({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let timer
    let stopped = false
    const nextWait = () => {
      if (!store.current()) return RENEW_CHECK_MS
      const due = Math.max(renewAfter, retryAt)
      return Math.min(RENEW_CHECK_MS, Math.max(RENEW_RETRY_MS, due - now()))
    }
    const tick = async () => {
      if (renewDue()) await renew()
      if (!stopped) timer = setTimer(tick, nextWait())
    }
    timer = setTimer(tick, nextWait())
    return () => {
      stopped = true
      clearTimer(timer)
    }
  }

  /** Public bootstrap only; no credentials, caller headers or caller-controlled upstream path. */
  async function previewFrame(request) {
    if (!['GET', 'HEAD'].includes(request.method)) return errorResponse(404, 'not-found', '页面不存在')
    if (isAppFrameUrl(request.url)) return appFrame(request)
    if (!isPreviewFrameUrl(request.url)) return errorResponse(404, 'not-found', '页面不存在')
    const name = new URL(request.url).pathname.slice(1)
    try {
      const result = await upstream('GET', `/link/preview-frame/${name}`, {}, undefined)
      const bytes = await readBody(result.response, 32 * 1024 * 1024)
      const hash = result.response.headers['x-latch-frame-hash']
      const scripts = [...bytes.toString('utf8').matchAll(/<script>([\s\S]*?)<\/script>/gu)]
      if (
        result.response.statusCode !== 200
        || typeof hash !== 'string'
        || !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(hash)
        || scripts.length !== 1
        || `sha256-${createHash('sha256').update(scripts[0][1]).digest('base64')}` !== hash
      )
        return errorResponse(404, 'preview-unavailable', '文档预览器不可用')
      return new Response(request.method === 'HEAD' ? null : bytes, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': previewFrameCsp(name.replace(/\.html$/u, ''), hash),
        },
      })
    } catch {
      return errorResponse(404, 'preview-unavailable', '文档预览器不可用')
    }
  }

  /** The plugin page runtime, checked against its hash like a preview bootstrap; nothing of the caller goes upstream. */
  async function appFrame(request) {
    try {
      const result = await upstream('GET', '/link/app-frame/runtime.html', {}, undefined)
      const bytes = await readBody(result.response, 16 * 1024 * 1024)
      const hash = result.response.headers['x-latch-frame-hash']
      const scripts = [...bytes.toString('utf8').matchAll(/<script>([\s\S]*?)<\/script>/gu)]
      if (
        result.response.statusCode !== 200
        || typeof hash !== 'string'
        || !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(hash)
        || scripts.length !== 1
        || `sha256-${createHash('sha256').update(scripts[0][1]).digest('base64')}` !== hash
      )
        return errorResponse(404, 'app-frame-unavailable', '插件页面运行环境不可用')
      return new Response(request.method === 'HEAD' ? null : bytes, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': appFrameCsp(hash),
        },
      })
    } catch {
      return errorResponse(404, 'app-frame-unavailable', '插件页面运行环境不可用')
    }
  }

  return {
    handle,
    previewFrame,
    shellRequest,
    renew,
    browserInvitation,
    computerInvitation,
    startRenewalTimer,
    /** Test and diagnostics view; never contains keys or credentials. */
    state() {
      return { renewAfter, retryAt, pendingEnrollments: pending.size }
    },
  }
}

module.exports = {
  APP_ORIGIN,
  LOCAL_HOME,
  REMOTE_HOME,
  CLEARING_CODES,
  JSON_RESPONSE_LIMIT,
  PLUGIN_DRAFT_BODY_LIMIT,
  FILE_EDIT_BODY_LIMIT,
  FILE_EDIT_PATH,
  HTML_CSP,
  OPEN_IN_BROWSER,
  COPY_COMPUTER_LINK,
  BROWSER_INVITATION,
  COMPUTER_INVITATION,
  COPIED_LINK_MS,
  REQUEST_BODY_LIMIT,
  UPLOAD_BODY_LIMIT,
  RENEW_INTERVAL_MS,
  RENEW_CHECK_MS,
  RENEW_RETRY_MS,
  RENEW_RETRY_MAX_MS,
  EXTERNAL_URL_LIMIT,
  ProxyError,
  isAllowedRendererRequest,
  isAllowedRendererDetails,
  isPreviewFrameUrl,
  isAppFrameUrl,
  previewFrameName,
  appFrameCsp,
  previewFrameCsp,
  isAppUrl,
  appPermissionHandlers,
  externalUrl,
  externalLinkDialog,
  createDialogGate,
  createExternalGesture,
  createExternalOpener,
  browserInvitationUrl,
  computerInvitationUrl,
  isAppSender,
  createBrowserOpener,
  concealedClipboardEntry,
  createLinkCopier,
  debugFlagProblems,
  unexpectedArguments,
  upstreamTarget,
  classifyRoute,
  forwardRequestHeaders,
  forwardResponseHeaders,
  isHtmlContentType,
  rewriteEnrollmentBody,
  stripCredential,
  authFailureAction,
  errorBody,
  errorResponse,
  jsonResponse,
  readRequestBody,
  discardRequestBody,
  bufferUpstream,
  bufferedResponse,
  streamedResponse,
  refusal,
  htmlErrorPage,
  escapeHtml,
  createShellProxy,
}
