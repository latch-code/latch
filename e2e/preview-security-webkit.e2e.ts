import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { webkit, type Browser, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { documentFixtures } from '@latch/testkit'
import { strToU8, zipSync } from 'fflate'
import { latchEnv } from '@latch/host/env'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

const fixtures = documentFixtures(files =>
  Array.from(zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])))),
)
/** Runs in the preview frame. Several landscape slides can tie for the largest visible fraction on a tall phone. */
function mostVisibleSlides(slides: Element[]): Promise<number[]> {
  return new Promise(resolve => {
    const observer = new IntersectionObserver(entries => {
      observer.disconnect()
      const largest = Math.max(...entries.map(entry => entry.intersectionRatio))
      const visible = entries.filter(entry => entry.intersectionRatio > 0 && entry.intersectionRatio === largest)
      resolve(visible.map(entry => Number(entry.target.getAttribute('data-slide-index'))))
    })
    slides.forEach(slide => observer.observe(slide))
  })
}

describe('WebKit actual document frames and product sandbox boundary', () => {
  let host: TestHost, server: ViteDevServer, browser: Browser, origin: string
  let probes = 0,
    hold = false,
    release: (() => void) | undefined
  beforeAll(async () => {
    host = await startTestHost({ uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web') })
    server = await createServer({
      configFile: false,
      root: resolve('apps/web'),
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        {
          name: 'actual-host-frame-proxy',
          configureServer(instance) {
            instance.middlewares.use(async (req, res, next) => {
              const path = (req.url ?? '').split('?')[0]!
              if (path.startsWith('/link/api/')) {
                probes++
                res.end('probe')
                return
              }
              if (
                /^\/link\/preview-frame\/(office|diagram|html)\.html$/u.test(path)
                || /^\/link\/preview-assets\/pdf\/(fonts|cmaps)\/[A-Za-z0-9_.-]+$/u.test(path)
              ) {
                try {
                  if (hold && path.includes('/preview-frame/'))
                    await new Promise<void>(done => {
                      release = done
                    })
                  const answer = await host.raw('loopback-tcp', path.slice('/link/'.length), { headers: { 'Sec-Fetch-Dest': 'iframe' } })
                  res.statusCode = answer.status
                  res.setHeader('cache-control', 'no-store')
                  for (const key of ['content-type', 'content-security-policy', 'x-content-type-options', 'cross-origin-resource-policy']) {
                    const value = answer.headers.get(key)
                    if (value) res.setHeader(key, value)
                  }
                  res.end(Buffer.from(await answer.arrayBuffer()))
                } catch {
                  res.statusCode = 503
                  res.end()
                }
                return
              }
              next()
            })
          },
        },
      ],
    })
    await server.listen()
    origin = server.resolvedUrls!.local[0]!.replace(/\/$/u, '')
    browser = await webkit.launch({ headless: true })
    await mkdir('test-results/preview-webkit', { recursive: true })
  })
  afterAll(async () => {
    release?.()
    await browser?.close()
    await server?.close()
    await host?.close()
  })
  async function open(page: Page, kind: 'pptx' | 'docx' | 'xlsx' | 'pdf' | 'html' | 'mermaid', bytes: number[]) {
    await page.evaluate(([kind, bytes]) => window.openSecurityDocument(kind, bytes), [kind, bytes] as const)
    await page.waitForFunction(kind => document.querySelector('main')?.getAttribute('data-security-kind') === kind, kind)
  }
  it.each([
    [390, 'light'],
    [900, 'dark'],
    [1440, 'light'],
  ] as const)('%s %s renders real formats and keeps WebKit diagrams click-to-render', async (width, theme) => {
    const context = await browser.newContext({
      viewport: { width, height: 960 },
      colorScheme: theme,
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      await page.goto(origin + '/test/preview-security.html')
      await page.waitForFunction(() => typeof window.openSecurityDocument === 'function')
      await open(page, 'docx', fixtures.word())
      const frame = () => page.frameLocator('iframe[title="文档预览"]')
      await frame().getByText('Hello DOCX', { exact: true }).waitFor()
      expect(await frame().locator('iframe,script[src],a[href^="https://"]').count()).toBe(0)
      expect(await page.locator('iframe').getAttribute('sandbox')).toBe('allow-scripts')
      await page.screenshot({ path: `test-results/preview-webkit/docx-${width}-${theme}.png`, animations: 'disabled' })
      await open(page, 'pptx', fixtures.presentation(6))
      await frame().getByText('Page 1', { exact: true }).waitFor()
      if (width === 390) {
        expect(await page.getByRole('button', { name: '下一页', exact: true }).count()).toBe(0)
        // The first slide mounts before open() finishes its initial scroll. Wait for that scroll's own page event.
        await page.waitForFunction(() => {
          const events = window.securityEvents as Array<{ type: string; kind?: string; index?: number }>
          const rendered = events.findLastIndex(event => event.type === 'rendered' && event.kind === 'pptx')
          return rendered >= 0 && events.slice(rendered + 1).some(event => event.type === 'page' && event.index === 0)
        })
        await frame()
          .locator('[data-slide-index="1"]')
          .evaluate(node => node.scrollIntoView({ behavior: 'instant', block: 'start' }))
        const mostVisible = await frame().locator('[data-slide-index]').evaluateAll(mostVisibleSlides)
        expect(mostVisible).not.toContain(0)
        await expect
          .poll(() =>
            page.evaluate(
              () => (window.securityEvents as Array<{ type: string; index?: number }>).findLast(event => event.type === 'page')?.index,
            ),
          )
          .toSatisfy((index: number | undefined) => index !== undefined && mostVisible.includes(index))
      } else {
        await frame()
          .locator('body')
          .evaluate(body => {
            body.tabIndex = -1
            body.focus({ preventScroll: true })
          })
        await page.keyboard.press('ArrowRight')
        await page.getByText('2 / 6 页', { exact: true }).waitFor()
      }
      await frame().getByText('Page 2', { exact: true }).waitFor()
      await page.screenshot({ path: `test-results/preview-webkit/pptx-${width}-${theme}.png`, animations: 'disabled' })
      await open(page, 'xlsx', fixtures.workbook())
      await page.getByRole('gridcell', { name: '表格标题', exact: true }).waitFor()
      await page.getByRole('gridcell', { name: '<script>bad</script>', exact: true }).waitFor()
      expect(await page.locator('.sheet-grid script').count()).toBe(0)
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `test-results/preview-webkit/xlsx-${width}-${theme}.png`, animations: 'disabled' })
      await open(page, 'pdf', fixtures.pdf())
      await page.locator('.pdf-text-layer').getByText('Hello PDF', { exact: true }).waitFor()
      expect(
        await page.locator('.pdf-page canvas').evaluate(node => {
          const canvas = node as HTMLCanvasElement
          return (
            canvas.width > 0
            && canvas.height > 0
            && canvas
              .getContext('2d')!
              .getImageData(0, 0, canvas.width, canvas.height)
              .data.some((value, i) => i % 4 !== 3 && value < 100)
          )
        }),
      ).toBe(true)
      expect(await page.evaluate(() => Reflect.get(window, 'PWNED'))).toBeUndefined()
      await page.screenshot({ path: `test-results/preview-webkit/pdf-${width}-${theme}.png`, animations: 'disabled' })
      await open(page, 'mermaid', Array.from(new TextEncoder().encode('graph TD\n A[Start] --> B[Finish]')))
      expect(await page.locator('iframe').count()).toBe(0)
      await page.getByRole('button', { name: '显示图表', exact: true }).click()
      const image = page.getByRole('img', { name: 'Mermaid 图表', exact: true })
      await image.waitFor()
      await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      expect(await image.getAttribute('src')).toMatch(/^blob:/u)
      expect(await page.locator('.message-diagram :is(svg:not(button .ui-icon), foreignObject)').count()).toBe(0)
      await page.screenshot({ path: `test-results/preview-webkit/mermaid-${width}-${theme}.png`, animations: 'disabled' })
      await open(
        page,
        'html',
        Array.from(
          new TextEncoder().encode(
            '<h1>Static HTML</h1><script>parent.PWNED=true</script><img src="https://example.invalid/never"><form action="https://example.invalid/"><button>Submit</button></form>',
          ),
        ),
      )
      await frame().getByRole('heading', { name: 'Static HTML', exact: true }).waitFor()
      expect(await frame().locator('script,form[action],[formaction],img[src^="http"]').count()).toBe(0)
      expect(await frame().locator('form').count()).toBe(1)
      expect(await page.evaluate(() => Reflect.get(window, 'PWNED'))).toBeUndefined()
      await page.screenshot({ path: `test-results/preview-webkit/html-${width}-${theme}.png`, animations: 'disabled' })
    } catch (error) {
      await page.screenshot({ path: `test-results/preview-webkit/failure-${width}-${theme}.png`, animations: 'disabled' })
      await writeFile(
        `test-results/preview-webkit/failure-${width}-${theme}.json`,
        JSON.stringify(
          { body: await page.locator('body').textContent(), events: await page.evaluate(() => window.securityEvents) },
          null,
          2,
        ),
      )
      throw error
    } finally {
      await context.close()
    }
  })
  it('rejects wrong ready identities, parent/API/worker/form/top access, invalid port messages and a second navigation', async () => {
    const context = await browser.newContext({ viewport: { width: 1000, height: 900 }, reducedMotion: 'reduce' })
    await context.addInitScript(() => {
      const original = MessagePort.prototype.postMessage
      Object.defineProperty(MessagePort.prototype, 'postMessage', {
        configurable: true,
        value: function (this: MessagePort, data: unknown, transfer: Transferable[] = []) {
          Reflect.set(window, 'observedSecurityPort', this)
          return Reflect.apply(original, this, [data, transfer])
        },
      })
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      await page.goto(origin + '/test/preview-security.html')
      await page.waitForFunction(() => typeof window.openSecurityDocument === 'function')
      hold = true
      await open(page, 'docx', fixtures.word())
      await page.locator('iframe').waitFor()
      await expect.poll(() => typeof release).toBe('function')
      await page.evaluate(() => {
        const frame = document.querySelector('iframe')!,
          nonce = new URL(frame.src).hash.slice('#nonce='.length)
        for (const [source, origin, value] of [
          [window, 'null', nonce],
          [frame.contentWindow, 'null', 'wrong-nonce'],
          [frame.contentWindow, location.origin, nonce],
        ] as const)
          window.dispatchEvent(new MessageEvent('message', { source, origin, data: { type: 'ready', protocol: 1, nonce: value } }))
      })
      expect(await page.evaluate(() => window.securityChannels)).toBe(0)
      hold = false
      release!()
      release = undefined
      const child = () => page.frames().find(frame => frame.url().includes('/link/preview-frame/office.html'))!
      await page.frameLocator('iframe').getByText('Hello DOCX', { exact: true }).waitFor()
      expect(await page.evaluate(() => window.securityChannels)).toBe(1)
      const before = probes,
        parentUrl = page.url()
      const blocked = await child().evaluate(async origin => {
        let parentDenied = false,
          storageDenied = false,
          apiDenied = false,
          handleDenied = false,
          topDenied = false
        try {
          void parent.document.body
        } catch {
          parentDenied = true
        }
        try {
          localStorage.getItem('credential')
        } catch {
          storageDenied = true
        }
        try {
          await fetch(origin + '/link/api/security-probe?api')
        } catch {
          apiDenied = true
        }
        try {
          await fetch(origin + '/link/api/files/' + 'A'.repeat(22))
        } catch {
          handleDenied = true
        }
        const workerDenied = await new Promise<boolean>(resolve => {
          const url = URL.createObjectURL(new Blob(['postMessage("ran")'], { type: 'text/javascript' }))
          let worker: Worker | undefined
          const finish = (denied: boolean) => {
            clearTimeout(timer)
            worker?.terminate()
            URL.revokeObjectURL(url)
            resolve(denied)
          }
          const timer = setTimeout(() => finish(false), 1000)
          try {
            worker = new Worker(url)
            worker.onmessage = () => finish(false)
            worker.onerror = event => {
              event.preventDefault()
              finish(true)
            }
          } catch {
            finish(true)
          }
        })
        const image = new Image()
        image.src = origin + '/link/api/security-probe?image'
        document.body.append(image)
        const beforeForm = location.href
        const form = document.createElement('form')
        form.action = origin + '/link/api/security-probe?form'
        form.method = 'POST'
        document.body.append(form)
        form.submit()
        try {
          top!.location.href = origin + '/link/api/security-probe?top'
        } catch {
          topDenied = true
        }
        await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
        return {
          parentDenied,
          storageDenied,
          apiDenied,
          handleDenied,
          workerDenied,
          topDenied,
          formStayed: location.href === beforeForm && form.isConnected,
        }
      }, origin)
      expect(blocked).toEqual({
        parentDenied: true,
        storageDenied: true,
        apiDenied: true,
        handleDenied: true,
        workerDenied: true,
        topDenied: true,
        formStayed: true,
      })
      expect(probes).toBe(before)
      expect(page.url()).toBe(parentUrl)
      await child().evaluate(() =>
        (Reflect.get(window, 'observedSecurityPort') as MessagePort).postMessage({ type: 'page', index: -1, count: 1 }),
      )
      await page.getByText('文档预览已停止，请关闭后重新打开。', { exact: true }).waitFor()
      expect(await page.locator('iframe').count()).toBe(0)
      await open(page, 'docx', fixtures.word())
      await page.frameLocator('iframe').getByText('Hello DOCX', { exact: true }).waitFor()
      await child()
        .evaluate(() => {
          location.href = 'about:blank'
        })
        .catch(() => {})
      await page.getByText('文档预览已停止，请关闭后重新打开。', { exact: true }).waitFor()
      expect(await page.locator('iframe').count()).toBe(0)
    } finally {
      hold = false
      release?.()
      release = undefined
      await context.close()
    }
  })
})
