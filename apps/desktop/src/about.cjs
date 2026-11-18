'use strict'
// 关于 Latch: one small window whose page main writes itself. The page is static: no script, no preload, no network
// and nothing to navigate to; it shows the mark, the name, the version and the licence line, in the system's light or dark.

const { defineCopy, currentLocale } = require('./locale.cjs')

const COPY = defineCopy(
  { title: '关于 Latch', version: '版本', licence: 'MIT 许可' },
  { title: 'About Latch', version: 'Version', licence: 'MIT License' },
)

/** Everything is refused but the page's own inline style and its inlined mark. */
const ABOUT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
const ABOUT_SIZE = Object.freeze({ width: 300, height: 320 })
/** The window's own colours (--sidebar and --ink of @latch/ui), so it never flashes before the first paint. */
const ABOUT_BACKGROUND = Object.freeze({ light: '#ebebef', dark: '#09090b' })

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
:root{color-scheme:light dark;--bg:${ABOUT_BACKGROUND.light};--ink:#18181b;--muted:#71717a;--faint:#a1a1aa}
@media (prefers-color-scheme:dark){:root{--bg:${ABOUT_BACKGROUND.dark};--ink:#f4f4f5;--muted:#a1a1aa;--faint:#71717a}}
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

/** The page as the URL the window loads: its whole content, so there is no address to fetch or to change. */
const aboutUrl = input => `data:text/html;charset=utf-8;base64,${Buffer.from(aboutPage(input), 'utf8').toString('base64')}`

module.exports = { ABOUT_BACKGROUND, ABOUT_CSP, ABOUT_SIZE, aboutCopy: COPY, aboutPage, aboutUrl }
