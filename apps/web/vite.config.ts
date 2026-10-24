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

export default defineConfig(async ({ command }): Promise<UserConfig> => ({
  // The page lives in this directory, whichever working directory Vite starts in; the Host serves the build from the
  // repository root's dist/web, the path every Host build reads.
  root: import.meta.dirname,
  base: '/link/',
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
