import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build as bundle } from 'esbuild'
import { resolve } from 'node:path'
import { defineConfig, type ProxyOptions, type UserConfig } from 'vite'
import { readHostState } from '@latch/host/host-state'
import { resolveLatchPaths } from '@latch/host/paths'

/**
 * Cookies are not isolated by port, so a device credential set while the page is on
 * 127.0.0.1 would be sent to every other local service on 127.0.0.1. The proxy passes
 * `Set-Cookie` on only when the page uses the Host's own name (`h-<hostId>.localhost`).
 */
export function passesCredentialCookie(requestHost: string | undefined, hostName: string): boolean {
  if (requestHost === undefined) return false
  try {
    return new URL(`http://${requestHost}`).hostname === hostName.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Development only: `pnpm dev:web` serves the client and forwards `/link/api` to a
 * running Host's loopback port. The Host accepts only its own loopback origin, so
 * the proxy rewrites `host` and `origin` to the origin recorded in `<data>/host.json`
 * (the data directory resolves like `pnpm start`: --data-dir is not available here,
 * so `HARNESS_DATA_DIR` or the default). Open the page as
 * `http://h-<hostId>.localhost:<port>/link/`; on any other name enrollment does not
 * keep its cookie. A production build never contains this.
 */
async function hostProxy(): Promise<ProxyOptions> {
  const { dataDir } = resolveLatchPaths({ env: process.env, cwd: process.cwd() })
  const state = await readHostState(dataDir)
  if (state === undefined) {
    const port = process.env.HARNESS_PORT ?? '4317'
    console.warn(
      `[Latch] 未找到运行中的 Host（${dataDir}/host.json）。先启动 Host，或用 HARNESS_DATA_DIR 指向它的数据目录；暂时转发到 127.0.0.1:${port}。`,
    )
    return { target: `http://127.0.0.1:${port}` }
  }
  const origin = new URL(state.loopbackOrigin)
  console.info(`[Latch] 开发页面请用 http://${origin.hostname}:<端口>/link/ 打开，设备凭据只在这个地址下保存。`)
  return {
    target: `http://127.0.0.1:${origin.port}`,
    configure(proxy) {
      proxy.on('proxyReq', request => {
        request.setHeader('host', origin.host)
        if (request.getHeader('origin') !== undefined) request.setHeader('origin', origin.origin)
      })
      proxy.on('proxyRes', (response, request) => {
        if (!passesCredentialCookie(request.headers.host, origin.hostname)) delete response.headers['set-cookie']
      })
    },
  }
}

export async function buildOfficeFrame(directory = resolve('dist/web/preview-frame')): Promise<void> {
  const result = await bundle({
    entryPoints: [fileURLToPath(new URL('./src/preview/office-frame.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2023',
    minify: true,
    write: false,
    legalComments: 'none',
  })
  const script = result.outputFiles[0]!.text.replace(/<\/script/giu, '<\\/script')
  const scriptHash = `sha256-${createHash('sha256').update(script).digest('base64')}`
  const tokens = await readFile(fileURLToPath(import.meta.resolve('@latch/ui/tokens.css')), 'utf8')
  const styles =
    'html,body{margin:0;min-height:100%;background:var(--bg-app);color:var(--text-1);font-family:var(--font-sans)}#document{min-height:100vh;box-sizing:border-box;padding:var(--sp-12)}[data-latch-notes]{font-size:var(--fs-label);line-height:var(--lh-label-para);color:var(--text-1);padding:var(--sp-12);background:var(--bg-pane);position:relative}[data-latch-notes] p{white-space:pre-wrap}section.docx{margin-inline:auto;max-width:100%;box-sizing:border-box}#document[data-fit=false] section.docx{max-width:none}.docx-wrapper{padding:var(--sp-8)!important;background:var(--bg-app)!important}'
  await mkdir(directory, { recursive: true })
  await writeFile(
    resolve(directory, 'office.html'),
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${tokens}${styles}</style></head><body><main id="document"></main><script>${script}</script></body></html>`,
  )
  await writeFile(resolve(directory, 'office.json'), JSON.stringify({ file: 'office.html', scriptHash }))
  const pdfDirectory = fileURLToPath(new URL('./', import.meta.resolve('pdfjs-dist/package.json')))
  await cp(resolve(pdfDirectory, 'cmaps'), resolve(directory, '../preview-assets/pdf/cmaps'), { recursive: true })
  await cp(resolve(pdfDirectory, 'standard_fonts'), resolve(directory, '../preview-assets/pdf/fonts'), { recursive: true })
}

export async function buildDiagramFrame(directory = resolve('dist/web/preview-frame')): Promise<void> {
  const result = await bundle({
    entryPoints: [fileURLToPath(new URL('./src/preview/diagram-frame.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2023',
    minify: true,
    write: false,
    legalComments: 'none',
  })
  const script = result.outputFiles[0]!.text.replace(/<\/script/giu, '<\\/script')
  const scriptHash = `sha256-${createHash('sha256').update(script).digest('base64')}`
  await mkdir(directory, { recursive: true })
  await writeFile(
    resolve(directory, 'diagram.html'),
    `<!doctype html><html><head><meta charset="utf-8"></head><body><main id="diagram"></main><script>${script}</script></body></html>`,
  )
  await writeFile(resolve(directory, 'diagram.json'), JSON.stringify({ file: 'diagram.html', scriptHash }))
}

export async function buildHtmlFrames(directory = resolve('dist/web/preview-frame')): Promise<void> {
  const result = await bundle({
    entryPoints: [fileURLToPath(new URL('./src/preview/html-frame.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2023',
    minify: true,
    write: false,
    legalComments: 'none',
  })
  const script = result.outputFiles[0]!.text.replace(/<\/script/giu, '<\\/script')
  const scriptHash = `sha256-${createHash('sha256').update(script).digest('base64')}`
  await mkdir(directory, { recursive: true })
  for (const name of ['html', 'html-script']) {
    await writeFile(
      resolve(directory, `${name}.html`),
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script>${script}</script></body></html>`,
    )
    await writeFile(resolve(directory, `${name}.json`), JSON.stringify({ file: `${name}.html`, scriptHash }))
  }
}

export default defineConfig(async ({ command }): Promise<UserConfig> => ({
  // The page lives in this directory, whichever working directory Vite starts in; the Host serves the build from the
  // repository root's dist/web, the path every Host build reads.
  plugins: [
    {
      name: 'latch-office-frame',
      apply: 'build',
      closeBundle: async () => {
        await buildOfficeFrame()
        await buildDiagramFrame()
        await buildHtmlFrames()
      },
    },
  ],
  root: import.meta.dirname,
  base: '/link/',
  worker: { format: 'es' },
  build: {
    outDir: resolve(import.meta.dirname, '../../dist/web'),
    emptyOutDir: true,
    rolldownOptions: {
      // Icon modules carry a "use client" directive that has no meaning in this single-page bundle.
      onwarn(warning, warn) {
        if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning)
      },
    },
  },
  server: {
    host: '127.0.0.1',
    // Model-written Markdown never loads images; this keeps the dev page as strict as the Host's own CSP.
    headers: { 'Content-Security-Policy': "img-src 'self' data:" },
    proxy: command === 'serve' ? { '/link/api': await hostProxy() } : {},
  },
}))
