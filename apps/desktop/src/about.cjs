'use strict'
// 关于 Latch: one small window whose page main writes itself and serves at latch://app/about. The page is static: no
// script, no preload, no network and nothing to navigate to. Only the opening workbench supplies its colours.

const { defineCopy, currentLocale } = require('./locale.cjs')

const COPY = defineCopy(
  { title: '关于 Latch', version: '版本', licence: 'MIT 许可' },
  { title: 'About Latch', version: 'Version', licence: 'MIT License' },
)

/** Everything is refused but the page's own inline style and its inlined mark. */
const ABOUT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const ABOUT_SIZE = Object.freeze({ width: 300, height: 320 })
/** Monochrome floating surface before a workbench is available. */
const ABOUT_BACKGROUND = Object.freeze({ light: '#fcfcfc', dark: '#0c0c0c' })

/** Only four opaque colours can cross from a workbench into the static window's stylesheet. */
function parseAboutAppearance(value) {
  if (typeof value !== 'string' || value.length > 37) return undefined
  const [scheme, ...colors] = value.split(' ')
  if (scheme !== 'light' && scheme !== 'dark') return undefined
  if (colors.length !== 4 || !colors.every(color => /^#[0-9a-f]{6}$/u.test(color))) return undefined
  const [background, ink, muted, faint] = colors
  return { background, css: `html:root{color-scheme:${scheme};--bg:${background};--ink:${ink};--muted:${muted};--faint:${faint}}` }
}

/** Paint only this native window, before its first show. Changes during a paint use the latest owner's colours. */
function followAboutAppearance(window, appearanceOf, fallback) {
  let page
  let painting = false
  let reveal = true
  async function refresh(show = false) {
    reveal ||= show
    if (!page || painting) return
    painting = true
    try {
      while (!window.isDestroyed()) {
        const current = page
        const appearance = appearanceOf()
        if (appearance === current.appearance) break
        window.setBackgroundColor(appearance?.background ?? fallback())
        const oldKey = current.styleKey
        try {
          current.styleKey = appearance && (await window.webContents.insertCSS(appearance.css))
          if (oldKey && current === page && !window.isDestroyed()) await window.webContents.removeInsertedCSS(oldKey)
        } catch {
          // A reload can discard the stylesheet while it's being replaced.
          if (current === page) break
        }
        current.appearance = appearance
      }
    } finally {
      painting = false
      if (reveal && !window.isDestroyed()) {
        reveal = false
        window.show()
        window.focus()
      }
    }
  }
  window.webContents.on('did-finish-load', () => {
    page = {}
    void refresh()
  })
  return refresh
}

const escapeHtml = text => String(text).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)

/**
 * @param {{ version: string, icon?: string }} input  `icon` is a `data:image/png;base64,` URL of the application icon;
 * anything else is left out.
 */
function aboutPage({ version, icon }) {
  const mark =
    typeof icon === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(icon)
      ? `<img src="${icon}" alt="" width="84" height="84">`
      : ''
  return `<!doctype html><html lang="${escapeHtml(currentLocale())}"><head><meta charset="utf-8"><meta http-equiv="content-security-policy" content="${ABOUT_CSP}"><title>${escapeHtml(COPY.title)}</title><style>
:root{color-scheme:light dark;--bg:${ABOUT_BACKGROUND.light};--ink:#1e1e1e;--muted:#555555;--faint:#636363}
@media (prefers-color-scheme:dark){:root{--bg:${ABOUT_BACKGROUND.dark};--ink:#f0f0f0;--muted:#adadad;--faint:#a0a0a0}}
*{box-sizing:border-box;margin:0}
html,body{height:100%}
body{display:grid;grid-template-rows:1fr auto;justify-items:center;padding:44px 24px 20px;background:var(--bg);color:var(--ink);font:13px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;-webkit-app-region:drag;user-select:none;cursor:default}
main{display:grid;justify-items:center;align-content:center;gap:6px}
img{display:block;margin-block-end:14px;border-radius:19px}
h1{font-size:20px;line-height:26px;font-weight:600;letter-spacing:-0.01em}
p{color:var(--muted);font:12px/18px ui-monospace,"SF Mono",Menlo,monospace;font-variant-numeric:tabular-nums}
footer{color:var(--faint);font-size:11px;line-height:16px;text-align:center}
</style></head><body><main>${mark}<h1>Latch</h1><p>${escapeHtml(COPY.version)} ${escapeHtml(version)}</p></main><footer>© 2026 The Latch Authors · ${escapeHtml(COPY.licence)}</footer></body></html>`
}

/** Where the window loads it: Latch's own address, the only kind the app session lets a window load. */
const ABOUT_URL = 'latch://app/about'

/** The answer to a GET of ABOUT_URL, or undefined for any other request. */
function aboutResponse(request, input) {
  if (request.method !== 'GET' || request.url !== ABOUT_URL) return undefined
  return new Response(aboutPage(input), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': ABOUT_CSP, 'cache-control': 'no-store' },
  })
}

module.exports = {
  ABOUT_BACKGROUND,
  ABOUT_CSP,
  ABOUT_SIZE,
  ABOUT_URL,
  aboutCopy: COPY,
  aboutPage,
  aboutResponse,
  parseAboutAppearance,
  followAboutAppearance,
}
