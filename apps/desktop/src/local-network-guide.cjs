'use strict'
// The Local Network guide: after 「打开系统设置」 in the local-network hint, a small floating window at the bottom of
// the screen over System Settings shows what to do there (find Latch, turn its switch on). Main writes the page
// itself and serves it at latch://app/local-network-guide, like 关于: no network, no remote content, one inline
// script whose hash the policy names, and a preload that exposes only close(). Packaged app only: a Host started from
// a checkout never gets the access, so there the hint names scripts/desktop.sh instead.

const { createHash } = require('node:crypto')
const { defineCopy, currentLocale } = require('./locale.cjs')

const COPY = defineCopy(
  { ask: '在「本地网络」里找到 Latch，打开它的开关', allowed: '已允许', close: '关闭' },
  { ask: 'Find Latch under Local Network and turn its switch on', allowed: 'Allowed', close: 'Close' },
)

/** Where the window loads it: Latch's own address, the only kind the app session lets a window load. */
const GUIDE_URL = 'latch://app/local-network-guide'
/** Main loads this same-document address once the Host reports access: the page shows 已允许 through `:target`. */
const GUIDE_ALLOWED_URL = `${GUIDE_URL}#allowed`
/** The page's one message: close, nothing in it (local-network-guide-preload.cjs). */
const GUIDE_CLOSE_CHANNEL = 'latch:local-network-guide:close'
/** The hint's one call: open the Local Network settings page and show the guide; a boolean comes back. */
const LOCAL_NETWORK_OPEN_CHANNEL = 'latch:local-network:open-settings'

/** The card, and the transparent margin around it that holds its shadow. */
const CARD = Object.freeze({ width: 480, height: 88 })
const MARGIN = 16
const GUIDE_SIZE = Object.freeze({ width: CARD.width + 2 * MARGIN, height: CARD.height + 2 * MARGIN })
/** The card's bottom edge stands this far above the bottom of the work area. */
const BOTTOM_GAP = 48

const POLL_MS = 1000
const ALLOWED_MS = 1200
const TIMEOUT_MS = 5 * 60 * 1000
/** Focus can bounce back to Latch while System Settings opens; a focus this soon after showing is not the person's. */
const FOCUS_GRACE_MS = 1500

const SCRIPT = `document.getElementById('close').addEventListener('click',()=>window.latchGuide.close())`
const SCRIPT_HASH = createHash('sha256').update(SCRIPT).digest('base64')
/** Only the inline style, the inlined mark and the one script; no connection, frame, form or base. */
const GUIDE_CSP = `default-src 'none'; script-src 'sha256-${SCRIPT_HASH}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

const escapeHtml = text => String(text).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)

/**
 * The page. Colours and type are @latch/ui's (--pop, --ink, --muted, --sunken, --accent, --switch-off, --sh-pop);
 * light and dark follow the system appearance (nativeTheme), which Chromium reports as prefers-color-scheme.
 * @param {{ icon?: string }} input  `icon` is a `data:image/png;base64,` URL of the application icon; anything else is
 * left out.
 */
function guidePage({ icon } = {}) {
  const mark =
    typeof icon === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(icon)
      ? `<img src="${icon}" alt="" width="22" height="22">`
      : '<span class="mark"></span>'
  return `<!doctype html><html lang="${escapeHtml(currentLocale())}"><head><meta charset="utf-8"><meta http-equiv="content-security-policy" content="${GUIDE_CSP}"><title>Latch</title><style>
:root{color-scheme:light dark;--pop:#ffffff;--ink:#17171a;--muted:#56565f;--sunken:#f3f3f6;--line:rgba(18,18,28,.075);--hover:rgba(18,18,28,.05);--accent:#2461e0;--switch-off:rgba(18,18,28,.12);--sh-pop:0 12px 32px -12px rgba(0,0,0,.22),0 0 0 1px var(--line)}
@media (prefers-color-scheme:dark){:root{--pop:#27272c;--ink:#ececef;--muted:#a3a3ad;--sunken:#1b1b1f;--line:rgba(255,255,255,.06);--hover:rgba(255,255,255,.05);--accent:#2f6be6;--switch-off:rgba(255,255,255,.16);--sh-pop:0 16px 40px -12px rgba(0,0,0,.72),0 0 0 1px var(--line),inset 0 1px 0 rgba(255,255,255,.04)}}
*{box-sizing:border-box;margin:0}
html,body{height:100%;background:transparent}
body{padding:${MARGIN}px;font:13px/18px -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;color:var(--ink);user-select:none;cursor:default;overflow:hidden}
.card{height:${CARD.height}px;display:grid;grid-template-rows:20px 36px;align-content:center;gap:8px;padding:0 10px 0 14px;border-radius:12px;background:var(--pop);box-shadow:var(--sh-pop);animation:in .18s ease-out}
.top{display:flex;align-items:center;gap:8px;font-weight:600}
.top svg{flex:none}
.top .text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.done{display:none;color:var(--ink)}
.done svg{color:var(--accent)}
button{flex:none;display:grid;place-items:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:none;color:var(--muted)}
button:hover{background:var(--hover);color:var(--ink)}
.row{display:flex;align-items:center;gap:8px;margin-right:4px;padding:0 10px 0 8px;border-radius:8px;background:var(--sunken)}
.row img,.mark{display:block;width:22px;height:22px;border-radius:5px}
.row .name{flex:1}
.switch{position:relative;width:26px;height:15px;border-radius:8px;background:var(--switch-off);transition:background .2s}
.switch::after{content:"";position:absolute;top:1.5px;left:1.5px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .2s}
#allowed:target .ask{display:none}
#allowed:target .done{display:flex}
#allowed:target .switch{background:var(--accent)}
#allowed:target .switch::after{transform:translateX(11px)}
@keyframes in{from{opacity:0;transform:translateY(6px)}}
@media (prefers-reduced-motion:reduce){.card{animation:none}.switch,.switch::after{transition:none}}
</style></head><body><main class="card" id="allowed">
<div class="top"><span class="ask top text"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 12V2.5M2.75 6.75 7 2.5l4.25 4.25" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>${escapeHtml(COPY.ask)}</span><span class="done top text"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.75 7.25 5.75 10.25 11.25 3.75" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>${escapeHtml(COPY.allowed)}</span><button id="close" type="button" aria-label="${escapeHtml(COPY.close)}" title="${escapeHtml(COPY.close)}"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div>
<div class="row">${mark}<span class="name">Latch</span><span class="switch" aria-hidden="true"></span></div>
</main><script>${SCRIPT}</script></body></html>`
}

/** The answer to a GET of GUIDE_URL, or undefined for any other request. */
function guideResponse(request, input) {
  if (request.method !== 'GET' || request.url !== GUIDE_URL) return undefined
  return new Response(guidePage(input), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': GUIDE_CSP, 'cache-control': 'no-store' },
  })
}

/**
 * Bottom centre of a display's work area (the one nearest the cursor, where System Settings is likely to open), the
 * card's bottom edge BOTTOM_GAP above it.
 * @param {{ x: number, y: number, width: number, height: number }} workArea
 */
function guideBounds(workArea) {
  return {
    x: Math.round(workArea.x + (workArea.width - GUIDE_SIZE.width) / 2),
    y: Math.round(workArea.y + workArea.height - BOTTOM_GAP - CARD.height - MARGIN),
    ...GUIDE_SIZE,
  }
}

/**
 * The window: frameless, transparent, floating, never focused (System Settings keeps the keys) and never in the Dock
 * or the window list. Clicks reach it without focus (acceptFirstMouse), for ×. Its page is sandboxed and isolated,
 * runs no Node, and its preload exposes only close().
 * @param {{ preload: string, bounds: { x: number, y: number, width: number, height: number }, darwin: boolean }} input
 * @returns {Electron.BrowserWindowConstructorOptions}
 */
function guideWindowOptions({ preload, bounds, darwin }) {
  return {
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    acceptFirstMouse: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    // An NSPanel that does not take focus and stays over full-screen apps.
    ...(darwin ? { type: 'panel' } : {}),
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: false,
    },
  }
}

/**
 * When the guide opens and closes. It opens only in the packaged app and only from 「打开系统设置」; pressing it again
 * brings back the same window. While open it asks the Host once a second (`readAccess`, the same native/info the hint
 * reads); `allowed` shows 已允许 for ALLOWED_MS, then closes. It also closes on ×, after TIMEOUT_MS, and when this
 * Mac's window is focused again (back in Latch, the hint itself is in front of the person).
 * @param {object} options
 * @param {boolean} options.packaged
 * @param {(hooks: { onClosed: () => void }) => { contents: unknown, reveal(): void, allowed(): void, close(): void }} options.openWindow
 * @param {() => Promise<string | undefined>} options.readAccess  the Host's `localNetwork`, or undefined
 * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout, setInterval: typeof setInterval, clearInterval: typeof clearInterval }} [options.timers]
 * @param {() => number} [options.now]
 */
function createLocalNetworkGuide({ packaged, openWindow, readAccess, timers = globalThis, now = () => Date.now() }) {
  /** @type {{ contents: unknown, reveal(): void, allowed(): void, close(): void } | undefined} */
  let current
  let poll
  let ending
  let finishing
  let asking = false
  let shownAt = 0

  function stop() {
    if (poll !== undefined) timers.clearInterval(poll)
    if (ending !== undefined) timers.clearTimeout(ending)
    if (finishing !== undefined) timers.clearTimeout(finishing)
    poll = ending = finishing = undefined
  }

  function close() {
    const window = current
    stop()
    current = undefined
    window?.close()
  }

  function check(window) {
    if (asking || finishing !== undefined) return
    asking = true
    readAccess()
      .then(access => {
        if (access !== 'allowed' || current !== window || finishing !== undefined) return
        timers.clearInterval(poll)
        poll = undefined
        window.allowed()
        finishing = timers.setTimeout(close, ALLOWED_MS)
      })
      .catch(() => {})
      .finally(() => {
        asking = false
      })
  }

  return {
    /** 「打开系统设置」 was pressed and System Settings opened; whether the guide is showing. */
    show() {
      if (!packaged) return false
      shownAt = now()
      if (current) {
        if (finishing !== undefined) return true
        current.reveal()
        timers.clearTimeout(ending)
      } else {
        const window = openWindow({
          onClosed: () => {
            if (current === window) {
              stop()
              current = undefined
            }
          },
        })
        current = window
        poll = timers.setInterval(() => check(window), POLL_MS)
      }
      ending = timers.setTimeout(close, TIMEOUT_MS)
      return true
    },
    close,
    /** This Mac's window was focused. */
    mainFocused() {
      if (current && now() - shownAt >= FOCUS_GRACE_MS) close()
    },
    /** Whether `contents` is the guide's own page: only it may close the guide. */
    owns(contents) {
      return current !== undefined && contents !== undefined && contents !== null && current.contents === contents
    },
    isOpen: () => current !== undefined,
  }
}

module.exports = {
  ALLOWED_MS,
  FOCUS_GRACE_MS,
  GUIDE_ALLOWED_URL,
  GUIDE_CLOSE_CHANNEL,
  GUIDE_CSP,
  GUIDE_SIZE,
  GUIDE_URL,
  LOCAL_NETWORK_OPEN_CHANNEL,
  POLL_MS,
  TIMEOUT_MS,
  createLocalNetworkGuide,
  guideBounds,
  guideCopy: COPY,
  guidePage,
  guideResponse,
  guideWindowOptions,
}
