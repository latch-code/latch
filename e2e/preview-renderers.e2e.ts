import { documentFixtures } from '@latch/testkit'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { strToU8, unzipSync, zipSync } from 'fflate'
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
          ...[...new Set((await readFile(resolve('apps/web/src/preview/highlight.worker.ts'), 'utf8')).match(/@shikijs\/langs\/[a-z]+/gu))],
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
  it('refuses a real slide with ten thousand shapes before rendering and remains usable for the next document', async () => {
    const files = unzipSync(Uint8Array.from(presentation(1)))
    const source = new TextDecoder().decode(files['ppt/slides/slide1.xml'])
    const shape = source.match(/<p:sp>[\s\S]*?<\/p:sp>/u)?.[0]
    expect(shape).toBeDefined()
    files['ppt/slides/slide1.xml'] = strToU8(
      source.replace(shape!, Array.from({ length: 10_000 }, (_, i) => shape!.replace('id="2"', 'id="' + (i + 2) + '"')).join('')),
    )
    await open('pptx', Array.from(zipSync(files)))
    await page.getByText('这份演示文稿的内容过于复杂，暂时无法预览。可以下载或在电脑上打开。', { exact: true }).waitFor()
    expect(
      await page.evaluate(() =>
        window.previewEvents.some(event => typeof event === 'object' && event !== null && 'type' in event && event.type === 'rendered'),
      ),
    ).toBe(false)
    expect(await page.locator('iframe').count()).toBe(0)
    await open('docx', word())
    await page.frameLocator('iframe').getByText('Hello DOCX', { exact: true }).waitFor()
  })
  it('renders PPTX as a windowed page list with fit, page navigation and expandable speaker notes', async () => {
    await open('pptx', presentation())
    const frame = page.frameLocator('iframe[title="文档沙箱"]')
    await frame.getByText('Page 1', { exact: true }).waitFor()
    await page.getByRole('status').filter({ hasText: '1 / 25 页' }).waitFor()
    expect(await frame.getByText('Page 25', { exact: true }).count()).toBe(0)
    await frame.getByText('备注', { exact: true }).first().click()
    await frame.getByText('Speaker note', { exact: true }).waitFor()
    await frame.getByText('1 / 25', { exact: true }).waitFor()
    await frame.locator('body').evaluate(body => {
      body.tabIndex = -1
      body.focus({ preventScroll: true })
    })
    await page.keyboard.press('ArrowRight')
    await page.getByRole('status').filter({ hasText: '2 / 25 页' }).waitFor()
    await page.getByRole('button', { name: '引用到对话', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.previewQuotes.at(-1)?.page)).toBe(1)
    expect(await page.evaluate(() => window.previewQuotes.at(-1)?.text)).toContain('Page 2')
    await page.getByRole('button', { name: '适应宽度', exact: true }).click()
    expect(await page.getByRole('button', { name: '适应宽度', exact: true }).getAttribute('aria-pressed')).toBe('false')
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
    expect(await page.getByRole('button', { name: '适应宽度', exact: true }).getAttribute('aria-pressed')).toBe('false')
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
    await page.evaluate(() => {
      window.open = url => {
        window.previewOpened.push(String(url))
        return null
      }
    })
    const link = page.frameLocator('iframe[title="文档沙箱"]').getByText('External link', { exact: true })
    await link.evaluate(element => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    expect(await page.evaluate(() => window.previewOpened)).toEqual([])
    await link.click()
    await expect.poll(() => page.evaluate(() => window.previewOpened.at(-1))).toBe('https://example.invalid/never-load')
    expect(await page.getByRole('button', { name: '打开链接', exact: true }).count()).toBe(0)
    expect(requested).toEqual([])
    expect(await page.evaluate(() => Reflect.get(window, 'PWNED'))).toBeUndefined()
    expect(await page.locator('iframe').getAttribute('sandbox')).toBe('allow-scripts')
    await page
      .frameLocator('iframe[title="文档沙箱"]')
      .getByText('Hello DOCX', { exact: true })
      .evaluate(element => {
        const range = element.ownerDocument.createRange()
        range.selectNodeContents(element)
        const selection = element.ownerDocument.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
      })
    await page.getByRole('button', { name: '引用到对话', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.previewQuotes.at(-1)?.text)).toBe('Hello DOCX')
    expect(await page.evaluate(() => window.previewQuotes.at(-1)?.page)).toBe(0)
    await open('docx', [80, 75, 3, 4])
    await page.getByText('文档压缩结构超出预览上限，可以下载或在电脑上打开。 之前读到的内容仍保留在这里。', { exact: true }).waitFor()
    await page.frameLocator('iframe[title="文档沙箱"]').getByText('Hello DOCX', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: '引用到对话', exact: true }).getAttribute('aria-disabled')).toBe('true')
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
    await page.getByRole('gridcell', { name: '999', exact: true }).click()
    await page.getByRole('button', { name: '引用到对话', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.previewQuotes.at(-1)?.cells)).toEqual({ sheet: '数据', start: [1, 1], end: [1, 1] })
    expect(await page.evaluate(() => window.previewQuotes.at(-1)?.text)).toBe('999')
    const frozen = await page.getByRole('gridcell', { name: '表格标题', exact: true }).boundingBox()
    const numeric = await page.getByRole('gridcell', { name: '999', exact: true }).boundingBox()
    expect(frozen!.y + frozen!.height).toBeLessThanOrEqual(numeric!.y + 1)
    const resize = page.getByRole('separator', { name: '调整 B 列宽', exact: true })
    const before = Number(await resize.getAttribute('aria-valuenow'))
    await resize.focus()
    await resize.press('ArrowRight')
    expect(Number(await resize.getAttribute('aria-valuenow'))).toBe(before + 8)
    await page.getByRole('gridcell', { name: '999', exact: true }).click()
    await mkdir('test-results/documents', { recursive: true })
    for (const [width, theme] of [
      [390, 'light'],
      [900, 'dark'],
      [1440, 'light'],
      [1440, 'dark'],
    ] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.getByRole('gridcell', { name: '999', exact: true }).waitFor()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: 'test-results/documents/quoted-grid-' + width + '-' + theme + '.png', animations: 'disabled' })
    }
    await page.setViewportSize({ width: 1000, height: 900 })
  })
  it('parses CSV in a worker and leaves formula-looking values as text', async () => {
    await open('csv', Array.from(strToU8('name,value\nhello,=1+1\n')))
    await page.getByRole('gridcell', { name: '=1+1', exact: true }).waitFor()
    await page.getByRole('grid', { name: '表格', exact: true }).focus()
    await page.keyboard.press('ArrowDown')
    expect(await page.getByRole('gridcell', { name: 'hello', exact: true }).getAttribute('aria-selected')).toBe('true')
    await page.getByRole('button', { name: '冻结首行首列', exact: true }).click()
    await page.getByRole('button', { name: '引用到对话', exact: true }).click()
    expect(await page.evaluate(() => window.previewQuotes.at(-1))).toMatchObject({
      text: 'hello',
      cells: { sheet: '表格', start: [1, 0], end: [1, 0] },
    })
    await open('csv', Array.from(strToU8('name,value\nupdated,=1+1\n')))
    await page.getByRole('gridcell', { name: 'updated', exact: true }).waitFor()
    expect(await page.getByRole('gridcell', { name: 'updated', exact: true }).getAttribute('aria-selected')).toBe('true')
    expect(await page.getByRole('button', { name: '冻结首行首列', exact: true }).getAttribute('aria-pressed')).toBe('false')
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
  it('keeps the unfinished line of a streaming fence plain until it is finished', async () => {
    await page.evaluate(() => window.startRichPreview('```ts\nconst streamingValue = 37', true))
    await page.getByText('streamingValue', { exact: false }).waitFor()
    await page.waitForTimeout(400)
    expect(await page.locator('.syn-keyword').count()).toBe(0)
    await page.evaluate(() => window.startRichPreview('```ts\nconst streamingValue = 37\nconst more', true))
    await page.locator('.syn-keyword', { hasText: 'const' }).first().waitFor()
    expect(await page.locator('.syn-keyword', { hasText: 'const' }).count()).toBe(1)
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
  it('releases a PDF worker when a document cannot be parsed', async () => {
    await open('pdf', pdf())
    await page.locator('.pdf-text-layer').getByText('Hello PDF', { exact: true }).waitFor()
    let created = false,
      closed = false
    page.once('worker', worker => {
      created = true
      worker.once('close', () => {
        closed = true
      })
    })
    await open('pdf', Array.from(strToU8('This is not a PDF document.')))
    await page.locator('.ui-notice').filter({ hasText: '无法显示这个 PDF，请下载或在执行端电脑上打开。' }).waitFor()
    await page.locator('.pdf-text-layer').getByText('Hello PDF', { exact: true }).waitFor()
    expect(created).toBe(true)
    await expect.poll(() => closed).toBe(true)
  })
  it('ignores a valid old-frame page reply after replacing the document version', async () => {
    await open('pptx', presentation(3))
    await page.getByRole('status').filter({ hasText: '1 / 3 页' }).waitFor()
    await page.evaluate(() => {
      window.previewHoldPages = true
      window.previewDeferred = []
    })
    const deck = page.frameLocator('iframe[title="文档沙箱"]')
    await deck.locator('body').evaluate(body => {
      body.tabIndex = -1
      body.focus({ preventScroll: true })
    })
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => page.evaluate(() => window.previewDeferred.length)).toBeGreaterThan(0)
    await page.evaluate(() => {
      window.previewHoldPages = false
    })
    await open('pptx', presentation(2))
    await page.getByRole('status').filter({ hasText: '1 / 2 页' }).waitFor()
    await page.evaluate(() => {
      window.previewDeferred.splice(0).forEach(deliver => deliver())
    })
    expect(await page.getByRole('status').filter({ hasText: '1 / 2 页' }).count()).toBe(1)
    expect(await page.getByRole('status').filter({ hasText: '2 / 3 页' }).count()).toBe(0)
  })
  it('lets a full diff reach the end of a long line, with its head still in view', async () => {
    const long = `const value = "${'x'.repeat(390)}" // END`
    const lines = Array.from({ length: 80 }, (_, index) => `line ${index}`)
    const after = [long, ...lines].join('\n') + '\n'
    for (const diff of [
      { path: 'src/new.ts', previous: 'none' as const, newText: after },
      { path: 'src/edit.ts', previous: 'text' as const, oldText: `first\n${lines.join('\n')}\n`, newText: after },
    ]) {
      await page.evaluate(file => {
        window.startFullDiff(file)
      }, diff)
      const reached = await page.locator('#diff-panel .diff-text', { hasText: '// END' }).evaluate(line => {
        const panel = document.getElementById('diff-panel')!
        const body = panel.querySelector<HTMLElement>('.diff-body')!
        body.scrollLeft = 1e6
        panel.scrollTop = 200
        const text = document.createRange()
        text.selectNodeContents(line)
        return {
          end: text.getBoundingClientRect().right - panel.getBoundingClientRect().right,
          head: panel.querySelector('.diff-file-head')!.getBoundingClientRect().top - panel.getBoundingClientRect().top,
          innerScroll: body.scrollHeight - body.clientHeight,
        }
      })
      expect(reached.end).toBeLessThanOrEqual(0)
      expect(reached.head).toBe(0)
      expect(reached.innerScroll).toBe(0)
    }
  })
})
