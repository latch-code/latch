import type { ServerResponse } from 'node:http'

/**
 * The page a browser gets for an address that is no Latch page, such as a file name in a reply that was opened as a
 * link. It reflects nothing from the request, loads only the app icon, runs no script, and uses the system's colours
 * (`color-scheme: light dark`) rather than copies of the app's tokens. API paths keep their JSON errors.
 */
const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px 16px;
  background: Canvas;
  color: CanvasText;
  font: 14px/22px -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei UI', 'Noto Sans SC', sans-serif;
}
main { width: 100%; max-width: 400px; text-align: center; }
img { display: block; width: 48px; height: 48px; margin: 0 auto 16px; border-radius: 12px; }
h1 { margin: 0 0 8px; font-size: 20px; line-height: 28px; font-weight: 600; }
p { margin: 0 0 24px; opacity: 0.72; }
a {
  display: inline-block;
  min-height: 36px;
  padding: 7px 16px;
  border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
  border-radius: 8px;
  color: CanvasText;
  font-weight: 500;
  text-decoration: none;
}
a:hover { background: color-mix(in srgb, CanvasText 4%, transparent); }
a:focus-visible { outline: 2px solid LinkText; outline-offset: 2px; }
`

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>找不到页面 · Latch</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<img src="/link/icon.png" alt="" width="48" height="48">
<h1>找不到这个页面</h1>
<p>这个地址不是 Latch 的页面。对话里提到的文件不是网页链接，在浏览器里打不开。</p>
<a href="/link/">回到 Latch</a>
</main>
</body>
</html>
`

/** Only the inline style and the app icon may load; nothing may frame the page, submit a form or change its base. */
export const NOT_FOUND_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

export function sendNotFoundPage(res: ServerResponse, method: string): void {
  res.setHeader('content-security-policy', NOT_FOUND_CSP)
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(method === 'HEAD' ? undefined : PAGE)
}
