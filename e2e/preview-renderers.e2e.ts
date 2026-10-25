import { documentFixtures } from '@latch/testkit'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { browserLaunchOptions } from './helpers/browser.ts'
const { word, workbook, presentation, pdf } = documentFixtures(files =>
  Array.from(zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)])))),
)
describe('isolated document renderers', () => {
  let server: ViteDevServer, browser: Browser, page: Page, origin: string
  beforeAll(async () => {
    const office = await readFile(resolve('dist/web/preview-frame/office.html')),
      diagram = await readFile(resolve('dist/web/preview-frame/diagram.html')),
      diagramManifest = JSON.parse(await readFile(resolve('dist/web/preview-frame/diagram.json'), 'utf8')) as { scriptHash: string },
      manifest = JSON.parse(await readFile(resolve('dist/web/preview-frame/office.json'), 'utf8')) as { scriptHash: string }
    server = await createServer({
      configFile: false,
      root: resolve('apps/web'),
      server: { host: '127.0.0.1', port: 0 },
      optimizeDeps: {
        entries: ['test/preview-harness.tsx'],
        include: [
          'katex',
          'papaparse',
          '@shikijs/core',
          '@shikijs/engine-javascript',
          ...[
            ...new Set(
              (await readFile(resolve('apps/web/src/preview/highlight.worker.ts'), 'utf8')).match(/@shikijs\/langs-precompiled\/[a-z]+/gu),
            ),
          ],
        ],
      },
      plugins: [
        {
          name: 'preview-test-frame',
          configureServer(instance) {
            instance.middlewares.use(async (req, res, next) => {
              const path = (req.url ?? '').split('?')[0]!
              if (path === '/preview-frame/office.html' || path === '/preview-frame/diagram.html') {
                res.setHeader('content-type', 'text/html')
                res.setHeader(
                  'content-security-policy',
                  `sandbox allow-scripts;default-src 'none';script-src '${path.includes('diagram') ? diagramManifest.scriptHash : manifest.scriptHash}';style-src 'unsafe-inline';img-src blob: data:;font-src blob: data:;media-src blob: data:;worker-src 'none';frame-src 'none';connect-src 'none';form-action 'none';base-uri 'none';frame-ancestors 'self'`,
                )
                res.end(path.includes('diagram') ? diagram : office)
              } else if (path.startsWith('/link/preview-assets/pdf/')) {
                try {
                  res.end(await readFile(resolve('dist/web', path.replace('/link/', ''))))
                } catch {
                  res.statusCode = 404
                  res.end()
                }
              } else next()
            })
          },
        },
      ],
    })
    await server.listen()
    origin = server.resolvedUrls!.local[0]!.replace(/\/$/u, '')
    browser = await chromium.launch(browserLaunchOptions())
    page = await browser.newPage({ viewport: { width: 1000, height: 900 }, reducedMotion: 'reduce' })
    page.setDefaultTimeout(15_000)
    await page.goto(`${origin}/test/preview-harness.html`)
    await page.waitForFunction(() => typeof window.startPreview === 'function')
  })
  afterAll(async () => {
    await browser?.close()
    await server?.close()
  })
  const open = async (kind: 'pptx' | 'docx' | 'xlsx' | 'csv' | 'pdf', bytes: number[]) => {
    await page.evaluate(([kind, bytes]) => window.startPreview(kind, bytes), [kind, bytes] as const)
  }
  it('renders PPTX as a windowed page list with fit, page navigation and expandable speaker notes', async () => {
    await open('pptx', presentation())
    const frame = page.frameLocator('iframe[title="文档沙箱"]')
    await frame.getByText('Page 1', { exact: true }).waitFor()
    await page.getByRole('status').filter({ hasText: '1 / 25 页' }).waitFor()
    expect(await frame.getByText('Page 25', { exact: true }).count()).toBe(0)
    await frame.getByText('备注', { exact: true }).first().click()
    await frame.getByText('Speaker note', { exact: true }).waitFor()
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '2 / 25 页' }).waitFor()
    await page.getByRole('button', { name: '适应', exact: true }).click()
    expect(await page.getByRole('button', { name: '适应', exact: true }).getAttribute('aria-pressed')).toBe('false')
    await frame.locator('body').evaluate(body => {
      body.tabIndex = -1
      body.focus({ preventScroll: true })
    })
    await page.keyboard.press('Meta+=')
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.previewEvents.some(
            value =>
              !!value
              && typeof value === 'object'
              && 'type' in value
              && value.type === 'view'
              && 'zoomPercent' in value
              && value.zoomPercent === 110,
          ),
        ),
      )
      .toBe(true)
    await expect.poll(() => page.getByRole('status').allTextContents()).toContain('2 / 25 页')
    await open('pptx', presentation(24))
    await page.getByRole('status').filter({ hasText: '2 / 24 页' }).waitFor()
    expect(await page.getByRole('button', { name: '适应', exact: true }).getAttribute('aria-pressed')).toBe('false')
    await frame.locator('body').evaluate(body => {
      const start = new Event('touchstart', { bubbles: true }),
        end = new Event('touchend', { bubbles: true })
      Object.defineProperty(start, 'touches', { value: [{ clientX: 280, clientY: 200 }] })
      Object.defineProperty(end, 'touches', { value: [] })
      Object.defineProperty(end, 'changedTouches', { value: [{ clientX: 100, clientY: 200 }] })
      body.dispatchEvent(start)
      body.dispatchEvent(end)
    })
    await page.getByRole('status').filter({ hasText: '3 / 24 页' }).waitFor()
  })
  it('renders DOCX with no altChunk iframe, keeps an opaque origin, and never requests external relationships', async () => {
    const requested: string[] = []
    page.on('request', request => {
      if (request.url().includes('example.invalid')) requested.push(request.url())
    })
    await open('docx', word())
    await page.frameLocator('iframe[title="文档沙箱"]').getByText('Hello DOCX', { exact: true }).waitFor()
    expect(await page.frameLocator('iframe[title="文档沙箱"]').locator('iframe').count()).toBe(0)
    expect(await page.frameLocator('iframe[title="文档沙箱"]').locator('a[href^="https://example.invalid"]').count()).toBe(0)
    expect(requested).toEqual([])
    await page.frameLocator('iframe[title="文档沙箱"]').getByText('External link', { exact: true }).click()
    await page.getByRole('button', { name: '打开链接', exact: true }).waitFor()
    expect(requested).toEqual([])
    await page.evaluate(() => {
      window.open = url => {
        window.previewOpened.push(String(url))
        return null
      }
    })
    await page.getByRole('button', { name: '打开链接', exact: true }).click()
    expect(await page.evaluate(() => window.previewOpened.at(-1))).toBe('https://example.invalid/never-load')
    expect(await page.evaluate(() => Reflect.get(window, 'PWNED'))).toBeUndefined()
    expect(await page.locator('iframe').getAttribute('sandbox')).toBe('allow-scripts')
  })
  it('reads XLSX cached values, formulas, dates, hidden sheets and literal text without running formulas or markup', async () => {
    await open('xlsx', workbook())
    await page.getByRole('gridcell', { name: '表格标题', exact: true }).waitFor()
    await page.getByRole('gridcell', { name: '999', exact: true }).waitFor()
    expect(await page.getByRole('gridcell', { name: '<script>bad</script>', exact: true }).count()).toBe(1)
    expect(await page.getByRole('tab', { name: '隐藏', exact: true }).count()).toBe(0)
    expect(await page.getByRole('gridcell', { name: '999', exact: true }).getAttribute('title')).toContain('1+1')
    const metadata = (await page.evaluate(() =>
      window.previewEvents.find((value: any) => value.type === 'rendered' && value.kind === 'xlsx'),
    )) as { sheets: Array<{ frozen: { rows: number; cols: number } }> }
    expect(metadata.sheets[0]!.frozen).toEqual({ rows: 1, cols: 1 })
  })
  it('parses CSV in a worker and leaves formula-looking values as text', async () => {
    await open('csv', Array.from(strToU8('name,value\nhello,=1+1\n')))
    await page.getByRole('gridcell', { name: '=1+1', exact: true }).waitFor()
    await page.getByRole('grid', { name: '表格', exact: true }).focus()
    await page.keyboard.press('ArrowDown')
    expect(await page.getByRole('gridcell', { name: 'hello', exact: true }).getAttribute('aria-selected')).toBe('true')
  })
  it('highlights bounded closed code in a worker, marks hidden characters and renders trusted math DOM', async () => {
    await page.evaluate(() =>
      window.startRichPreview(
        '```ts\nconst answer = "safe" // note\nconst hidden = "a\u202Eb"\n```\n\nPrice $5 和 $10. Math $x^2$ and \\(y^2\\).\n\n$$\n\\frac{1}{2}\n$$',
      ),
    )
    await page.locator('.syn-keyword').first().waitFor()
    expect(await page.locator('.syn-comment').first().textContent()).toContain('// note')
    expect(await page.locator('.message-code').textContent()).toContain('\\u{202E}')
    expect(await page.locator('.message-code').textContent()).not.toContain('\u202E')
    await page.locator('.message-math .katex').first().waitFor()
    expect(await page.locator('.message-math .katex').count()).toBe(3)
    expect(await page.locator('.message-content').textContent()).toContain('Price $5 和 $10.')
    expect(
      await page
        .locator('.message-math')
        .evaluateAll(nodes => nodes.every(node => !node.querySelector('a,img,script,iframe,foreignObject'))),
    ).toBe(true)
  })
  it('renders Mermaid only through an opaque no-network frame and uses an inert SVG image', async () => {
    const external: string[] = []
    page.on('request', request => {
      if (request.url().includes('example.invalid')) external.push(request.url())
    })
    await page.evaluate(() => window.startRichPreview('```mermaid\ngraph TD\n A[Start] --> B[Finish]\n```'))
    const image = page.getByRole('img', { name: 'Mermaid 图表', exact: true })
    await image.waitFor()
    expect(await image.getAttribute('src')).toMatch(/^blob:/u)
    expect(await page.locator('.message-content svg').count()).toBe(0)
    expect(external).toEqual([])
    await page.getByRole('button', { name: '查看源码', exact: true }).click()
    await page.getByText('graph TD', { exact: false }).waitFor()
    await page.evaluate(() => window.startRichPreview('```mermaid\n%%{init:{"securityLevel":"loose"}}%%\ngraph TD;A-->B\n```'))
    await page.getByText('securityLevel', { exact: false }).waitFor()
    expect(await page.locator('iframe').count()).toBe(0)
    expect(await page.locator('.message-content').textContent()).toContain('securityLevel')
  })
  it('resolves local Markdown images and relative file links without requesting network images', async () => {
    const requests: string[] = []
    page.on('request', request => {
      if (request.url().includes('example.invalid')) requests.push(request.url())
    })
    await page.evaluate(() =>
      window.startRichPreview(
        '![local](images/a.svg)\n\n[Open file](../b.md)\n\n![external](https://example.invalid/never.png)',
        false,
        true,
      ),
    )
    const local = page.getByRole('img', { name: 'local', exact: true })
    await local.waitFor()
    expect(await local.getAttribute('width')).toBe('100')
    expect(await local.getAttribute('height')).toBe('50')
    expect(await page.evaluate(() => window.previewImages)).toEqual(['docs/images/a.svg'])
    await page.getByRole('button', { name: 'Open file', exact: true }).click()
    expect(await page.evaluate(() => window.previewOpened)).toEqual(['b.md'])
    expect(await page.getByRole('link', { name: '外部图片：external', exact: true }).count()).toBe(1)
    expect(requests).toEqual([])
  })
  it('refuses active math DOM and unsafe TeX commands', async () => {
    await page.evaluate(() =>
      window.startRichPreview('$\\href{javascript:alert(1)}{click}$ $\\includegraphics{https://example.invalid/pixel}$'),
    )
    await page.locator('.message-math :is(code,.katex)').first().waitFor()
    expect(await page.locator('.message-math a,.message-math img,.message-math script').count()).toBe(0)
    const refused = await page.evaluate(() =>
      ['script', 'img', 'iframe'].map(name => {
        const root = document.createElement('span')
        root.append(document.createElement(name))
        return window.validatePreviewMath(root)
      }),
    )
    expect(refused).toEqual([false, false, false])
  })
  it('keeps an unfinished streaming fence plain until it closes', async () => {
    await page.evaluate(() => window.startRichPreview('```ts\nconst streamingValue = 37', true))
    await page.getByText('streamingValue', { exact: false }).waitFor()
    await page.waitForTimeout(400)
    expect(await page.locator('.syn-keyword').count()).toBe(0)
    await page.evaluate(() => window.startRichPreview('```ts\nconst streamingValue = 37\n```', true))
    await page.locator('.syn-keyword').first().waitFor()
  })
  it('renders PDF canvas and selectable text using inclusive parent range reads', async () => {
    await open('pdf', pdf())
    await page.locator('.pdf-text-layer').getByText('Hello PDF', { exact: true }).waitFor()
    expect(await page.locator('.pdf-page canvas').evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0)
    const ranges = await page.evaluate(() => window.previewRanges)
    expect(ranges[0]).toEqual([0, 65535])
    expect(ranges.length).toBeGreaterThan(1)
    expect(ranges.some(([, end]) => end === pdf().length - 1)).toBe(true)
    await page.getByRole('searchbox', { name: '查找 PDF 文字', exact: true }).fill('Hello')
    await page.getByRole('button', { name: '1/1 匹配页', exact: true }).waitFor()
    expect(await page.evaluate(() => Reflect.get(window, 'PWNED'))).toBeUndefined()
    for (const [width, dark] of [
      [390, true],
      [768, false],
      [1440, false],
    ] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
      await page.locator('.pdf-text-layer').getByText('Hello PDF', { exact: true }).waitFor()
      await page.waitForFunction(() => {
        const canvas = document.querySelector('.pdf-page canvas') as HTMLCanvasElement | null
        if (!canvas || !canvas.width || !canvas.height) return false
        const viewport = canvas.closest('.pdf-scroll')!.getBoundingClientRect(),
          rect = canvas.getBoundingClientRect()
        if (rect.width > viewport.width || rect.top < viewport.top - 2) return false
        const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
        return pixels?.some((value, index) => index % 4 !== 3 && value < 100)
      })
      await page.screenshot({ path: `test-results/documents/pdf-${width}-${dark ? 'dark' : 'light'}.png`, fullPage: false })
    }
  })
})
