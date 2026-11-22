import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

/**
 * `pnpm --filter @latch/site preview [port]`: serves dist/ on 127.0.0.1 the way a CDN would for measurement: gzip for
 * text, long caching for hashed assets, 404.html for missing paths. Port 0 picks a free one; the line it prints names
 * the port it bound.
 */
const ROOT = fileURLToPath(new URL('../dist', import.meta.url)).replace(/[\\/]$/u, '')
const PORT = process.argv[2] === undefined ? 4790 : Number(process.argv[2])
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
}
const TEXT = new Set(['.html', '.css', '.js', '.json', '.webmanifest', '.xml', '.txt', '.svg'])

async function find(url: string): Promise<string | undefined> {
  let path: string
  try {
    path = decodeURIComponent(url.split('?')[0])
  } catch {
    return undefined
  }
  let file = join(ROOT, normalize(path))
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return undefined
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html')
    return (await stat(file)).isFile() ? file : undefined
  } catch {
    return undefined
  }
}

const server = createServer((request, response) => {
  void (async () => {
    const url = request.url ?? '/'
    const file = await find(url)
    const target = file ?? join(ROOT, '404.html')
    const ext = extname(target)
    let body = await readFile(target)
    const headers: Record<string, string> = {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control':
        url.startsWith('/_astro/') || url.startsWith('/img/') || url.startsWith('/video/')
          ? 'public, max-age=31536000, immutable'
          : ext === '.html'
            ? 'no-cache'
            : 'public, max-age=604800',
    }
    if (TEXT.has(ext) && /\bgzip\b/u.test(request.headers['accept-encoding'] ?? '')) {
      body = gzipSync(body, { level: 9 })
      headers['Content-Encoding'] = 'gzip'
      headers.Vary = 'Accept-Encoding'
    }
    response.writeHead(file ? 200 : 404, headers)
    response.end(body)
  })().catch(() => {
    response.writeHead(500)
    response.end()
  })
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`dist on http://localhost:${(server.address() as AddressInfo).port}/`)
})
