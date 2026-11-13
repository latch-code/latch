import { createHash, randomBytes } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build as bundle } from 'esbuild'
import { resolve } from 'node:path'
import { defineConfig, type ProxyOptions, type UserConfig } from 'vite'
import { latchEnv } from '@latch/host/env'
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
 * so `LATCH_DATA_DIR` or the default). Open the page as
 * `http://h-<hostId>.localhost:<port>/link/`; on any other name enrollment does not
 * keep its cookie. A production build never contains this.
 */
async function hostProxy(): Promise<ProxyOptions> {
  const { dataDir } = resolveLatchPaths({ env: process.env, cwd: process.cwd() })
  const state = await readHostState(dataDir)
  if (state === undefined) {
    const port = latchEnv(process.env, 'PORT') ?? '4317'
    console.warn(
      `[Latch] 未找到运行中的 Host（${dataDir}/host.json）。先启动 Host，或用 LATCH_DATA_DIR 指向它的数据目录；暂时转发到 127.0.0.1:${port}。`,
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
    'html,body{margin:0;min-height:100%;background:var(--sunken);color:var(--ink);font-family:var(--font)}body{box-sizing:border-box;padding:var(--sp-4) var(--sp-16) var(--sp-24)}#document{min-height:100vh}[data-slide-index]>:first-child{border-radius:var(--r-6);overflow:hidden;box-shadow:0 0 0 1px var(--line)}[data-slide-index]{position:relative;display:flex;flex-direction:column}[data-latch-slide-head]{order:-1;display:flex;align-items:center;height:28px;color:var(--muted);font-size:var(--fs-caption);line-height:var(--lh-caption);font-variant-numeric:tabular-nums}[data-latch-notes] summary{position:absolute;top:2px;right:0;height:24px;display:flex;align-items:center;gap:var(--sp-4);padding:0 var(--sp-6);border-radius:var(--r-6);color:var(--muted);font-size:var(--fs-caption);line-height:var(--lh-caption);cursor:pointer;list-style:none}[data-latch-notes] summary::-webkit-details-marker{display:none}[data-latch-notes] summary::before{content:"";width:5px;height:5px;margin-inline:1px 2px;border-block-start:1.5px solid;border-inline-end:1.5px solid;rotate:45deg;transition:rotate var(--m-micro) var(--e-micro)}[data-latch-notes][open] summary::before{rotate:135deg}[data-latch-notes] summary:hover{background:var(--hover);color:var(--ink)}[data-latch-notes] p{margin:var(--sp-8) 0 0;padding:var(--sp-12);border-radius:var(--r-6);background:var(--canvas);color:var(--ink);font-size:var(--fs-ui);line-height:var(--lh-ui-para);white-space:pre-wrap}section.docx{margin-inline:auto;max-width:100%;box-sizing:border-box}#document[data-fit=false] section.docx{max-width:none}.docx-wrapper{padding:var(--sp-8) 0!important;background:var(--sunken)!important}'
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

/**
 * The plugin page runtime: one inline script (React, the primitives and the bridge) whose hash the Host and the desktop
 * app put in the frame's CSP, and the design system's styles. The same sources give the same bytes, so the hash is
 * fixed for a build.
 */
export async function buildAppFrame(directory = resolve('dist/web/app-frame')): Promise<void> {
  const result = await bundle({
    entryPoints: [fileURLToPath(new URL('./src/app-frame/runtime.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2023',
    minify: true,
    write: false,
    legalComments: 'none',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const styles = await bundle({
    entryPoints: [fileURLToPath(import.meta.resolve('@latch/ui/tokens.css')), fileURLToPath(import.meta.resolve('@latch/ui/ui.css'))],
    bundle: true,
    minify: true,
    write: false,
    outdir: directory,
    legalComments: 'none',
  })
  const css = styles.outputFiles
    .map(file => file.text)
    .join('')
    .replace(/<\/style/giu, '<\\/style')
  const script = result.outputFiles[0]!.text.replace(/<\/script/giu, '<\\/script')
  const scriptHash = `sha256-${createHash('sha256').update(script).digest('base64')}`
  const page =
    'html,body{margin:0;min-height:100%;background:var(--canvas);color:var(--ink);font-family:var(--font);font-size:var(--fs-ui);line-height:var(--lh-ui)}#app{box-sizing:border-box;max-width:960px;padding:var(--sp-16) var(--sp-24) var(--sp-32)}@media (max-width:600px){#app{padding:var(--sp-12) var(--sp-16) var(--sp-24)}}'
  await mkdir(directory, { recursive: true })
  await writeFile(
    resolve(directory, 'runtime.html'),
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}${page}</style></head><body><div id="app"></div><script>${script}</script></body></html>`,
  )
  await writeFile(resolve(directory, 'runtime.json'), JSON.stringify({ file: 'runtime.html', scriptHash }))
}

/**
 * This build's ID: its UTC time, then a random part. The page carries it (`__LATCH_BUILD__`) and `build.json` next to the
 * page records it; a Host reads that file when it starts, so a page newer than the running Host knows (core/build.ts).
 */
function newBuildId(now = new Date()): string {
  return `${now
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, 'Z')}-${randomBytes(3).toString('hex')}`
}

export default defineConfig(async ({ command }): Promise<UserConfig> => {
  const build = command === 'build' ? newBuildId() : ''
  return {
    define: { __LATCH_BUILD__: JSON.stringify(build) },
    // The page lives in this directory, whichever working directory Vite starts in; the Host serves the build from the
    // repository root's dist/web, the path every Host build reads.
    plugins: [
      {
        name: 'latch-office-frame',
        apply: 'build',
        closeBundle: async () => {
          await writeFile(resolve(import.meta.dirname, '../../dist/web/build.json'), JSON.stringify({ build }))
          await buildOfficeFrame()
          await buildDiagramFrame()
          await buildHtmlFrames()
          await buildAppFrame()
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
  }
})
