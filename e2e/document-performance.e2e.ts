import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { platform, arch, cpus } from 'node:os'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { chromium, type Browser, type Page, type CDPSession, type Locator } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { performanceDocumentFixtures } from '@latch/testkit'
import { browserLaunchOptions } from './helpers/browser.ts'
import { diffImages } from './helpers/visual.ts'
import { buildDocumentPerformanceHarness } from './helpers/document-performance.ts'

type Kind = 'pptx' | 'pdf' | 'xlsx'
const OUTPUT = resolve('test-results/document-performance'),
  REFERENCE = process.env.LATCH_DOCUMENT_REFERENCE_DIR ? resolve(process.env.LATCH_DOCUMENT_REFERENCE_DIR) : undefined,
  budgets = { pptx: 1500, pdf: 1000, xlsx: 3000 } as const,
  counts = { pptx: 30, pdf: 200, xlsx: 12001 } as const
interface PixelReport {
  page: number
  actual: string
  reference: 'not-provided' | 'missing' | 'compared' | 'unreadable' | 'size-mismatch' | 'unsupported-size'
  reason?: string
  sizeMatches?: boolean
  diffPixels?: number
  totalPixels?: number
  diff?: string
}
interface Sample {
  label: string
  parent: Record<string, number>
  office?: Record<string, number>
  officeUnavailable?: boolean
}
describe('real document performance and owner-reference capture', () => {
  let server: Server, browser: Browser, origin: string, inputs: Record<Kind, Uint8Array>
  beforeAll(async () => {
    const factory = performanceDocumentFixtures(files =>
      zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), {
        level: 6,
        mtime: new Date(2020, 0, 1),
      }),
    )
    inputs = { pptx: factory.presentation(), pdf: factory.pdf(), xlsx: factory.workbook() }
    const office = await readFile(resolve('dist/web/preview-frame/office.html')),
      manifest = JSON.parse(await readFile(resolve('dist/web/preview-frame/office.json'), 'utf8')) as { scriptHash: string }
    await mkdir(OUTPUT, { recursive: true })
    await Promise.all(Object.entries(inputs).map(([kind, bytes]) => writeFile(join(OUTPUT, `input.${kind}`), bytes)))
    const harness = await buildDocumentPerformanceHarness()
    server = createServer((req, res) => {
      void (async () => {
        const path = (req.url ?? '').split('?')[0]!,
          match = /^\/document-performance\/input\/(pptx|pdf|xlsx)$/u.exec(path)
        if (match) {
          const bytes = inputs[match[1] as Kind],
            range = req.headers.range,
            parsed = range && /^bytes=(\d+)-(\d*)$/u.exec(range)
          if (req.method !== 'GET' || (range && !parsed)) {
            res.statusCode = 416
            res.end()
            return
          }
          const start = parsed ? Number(parsed[1]) : 0,
            end = parsed && parsed[2] ? Number(parsed[2]) : bytes.length - 1
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= bytes.length) {
            res.statusCode = 416
            res.end()
            return
          }
          res.statusCode = parsed ? 206 : 200
          res.setHeader('content-type', 'application/octet-stream')
          res.setHeader('accept-ranges', 'bytes')
          res.setHeader('cache-control', 'no-store')
          res.setHeader('content-length', end - start + 1)
          if (parsed) res.setHeader('content-range', `bytes ${start}-${end}/${bytes.length}`)
          res.end(Buffer.from(bytes.buffer, bytes.byteOffset + start, end - start + 1))
          return
        }
        if (path === '/link/preview-frame/office.html') {
          res.setHeader('content-type', 'text/html')
          res.setHeader(
            'content-security-policy',
            `sandbox allow-scripts;default-src 'none';script-src '${manifest.scriptHash}';style-src 'unsafe-inline';img-src blob: data:;font-src blob: data:;media-src blob: data:;worker-src 'none';frame-src 'none';connect-src 'none';form-action 'none';base-uri 'none';frame-ancestors 'self'`,
          )
          res.end(office)
          return
        }
        if (/^\/link\/preview-assets\/pdf\/(fonts|cmaps)\/[A-Za-z0-9_.-]+$/u.test(path)) {
          try {
            res.end(await readFile(resolve('dist/web', path.replace('/link/', ''))))
          } catch {
            res.statusCode = 404
            res.end()
          }
          return
        }
        const asset = /^\/link\/assets\/([A-Za-z0-9_.-]+\.(?:js|mjs|css|woff2?|ttf))$/u.exec(path),
          file =
            path === '/link/test/document-performance.html'
              ? join(harness, 'test/document-performance.html')
              : asset
                ? join(harness, 'assets', asset[1]!)
                : undefined
        if (!file) {
          res.statusCode = 404
          res.end()
          return
        }
        res.setHeader(
          'content-type',
          path.endsWith('.html')
            ? 'text/html'
            : path.endsWith('.css')
              ? 'text/css'
              : /\.m?js$/u.test(path)
                ? 'text/javascript'
                : 'application/octet-stream',
        )
        res.setHeader('cache-control', 'no-store')
        res.end(await readFile(file))
      })().catch(() => {
        res.statusCode = 500
        res.end()
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
    browser = await chromium.launch(browserLaunchOptions())
  })
  afterAll(async () => {
    await browser?.close()
    if (server) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
  async function metrics(session: CDPSession): Promise<Record<string, number>> {
    const value = (await session.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> },
      dom = (await session.send('Memory.getDOMCounters')) as { documents: number; nodes: number; jsEventListeners: number }
    return {
      ...Object.fromEntries(
        value.metrics
          .filter(item =>
            ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents', 'LayoutCount', 'RecalcStyleCount'].includes(item.name),
          )
          .map(item => [item.name, item.value]),
      ),
      documents: dom.documents,
      nodes: dom.nodes,
      jsEventListeners: dom.jsEventListeners,
    }
  }
  async function capture(page: Page, kind: Kind, index: number, element: Locator): Promise<PixelReport> {
    const name = `${kind}-page-${String(index).padStart(3, '0')}.png`,
      actual = await element.screenshot({ animations: 'disabled', caret: 'hide' })
    await writeFile(join(OUTPUT, name), actual)
    const entry: PixelReport = { page: index, actual: name, reference: REFERENCE ? 'missing' : 'not-provided' }
    if (REFERENCE) {
      let expected: Buffer | undefined
      try {
        const path = join(REFERENCE, name),
          info = await stat(path)
        if (!info.isFile() || info.size > 8 * 1024 * 1024) {
          entry.reference = 'unsupported-size'
          entry.reason = 'Reference is not a regular PNG within 8 MiB'
          return entry
        }
        expected = await readFile(path)
      } catch (error) {
        entry.reference = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'
      }
      if (expected) {
        const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
        if (expected.length < 24 || !expected.subarray(0, 8).equals(signature)) {
          entry.reference = 'unreadable'
          entry.reason = 'Reference is not a PNG'
          return entry
        }
        if (expected.readUInt32BE(16) !== actual.readUInt32BE(16) || expected.readUInt32BE(20) !== actual.readUInt32BE(20)) {
          entry.reference = 'size-mismatch'
          entry.sizeMatches = false
          entry.reason = 'Pixel dimensions differ; no resize was applied'
          return entry
        }
        if (expected.readUInt32BE(16) * expected.readUInt32BE(20) > 2_000_000) {
          entry.reference = 'unsupported-size'
          entry.reason = 'Reference exceeds two million pixels'
          return entry
        }
        try {
          const difference = await diffImages(browser, actual, expected)
          entry.reference = 'compared'
          entry.sizeMatches = difference.sizeMatches
          entry.diffPixels = difference.diffPixels
          entry.totalPixels = difference.width * difference.height
          if (difference.image) {
            entry.diff = `diff-${name}`
            await writeFile(join(OUTPUT, entry.diff), difference.image)
          }
        } catch {
          entry.reference = 'unreadable'
          entry.reason = 'PNG comparison failed'
        }
      }
    }
    return entry
  }
  for (const kind of ['pptx', 'pdf', 'xlsx'] as const)
    it(`measures ${kind} first content with the original budget and captures ${kind === 'xlsx' ? 'bounded sheet windows' : 'every logical page'}`, async () => {
      const context = await browser.newContext({
          viewport: { width: 800, height: 1000 },
          deviceScaleFactor: 1,
          reducedMotion: 'reduce',
          locale: 'en-US',
        }),
        page = await context.newPage(),
        samples: Sample[] = [],
        screenshots: PixelReport[] = []
      let firstScreenMs: number | undefined,
        maxRenderedPages = 0,
        maxDomNodes = 0,
        reportError: string | undefined
      const target = await context.newCDPSession(page)
      await target.send('Performance.enable')
      await target.send('Network.enable')
      await target.send('Network.setCacheDisabled', { cacheDisabled: true })
      await context.addInitScript(() => {
        let scheduled = false
        const check = () => {
          if (scheduled || window.documentFirstVisible) return
          const office = location.pathname === '/link/preview-frame/office.html',
            ready = office
              ? document.body?.textContent?.includes('Performance slide 01')
              : Array.from(document.querySelectorAll('.pdf-page .pdf-text-layer,.sheet-grid-cell')).some(
                  node => node.textContent?.includes('Performance PDF page 001') || node.textContent === 'Record 00001',
                )
          if (!ready) return
          scheduled = true
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              window.documentFirstVisible = performance.timeOrigin + performance.now()
            }),
          )
        }
        new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true })
        document.addEventListener('DOMContentLoaded', check)
      })
      const sample = async (label: string) => {
        const result: Sample = { label, parent: await metrics(target) },
          frame = page.frames().find(value => value.url().includes('/link/preview-frame/office.html'))
        if (frame) {
          try {
            const session = await context.newCDPSession(frame)
            await session.send('Performance.enable')
            result.office = await metrics(session)
            await session.detach()
          } catch {
            result.officeUnavailable = true
          }
        }
        samples.push(result)
      }
      try {
        await page.goto(`${origin}/link/test/document-performance.html`)
        await page.waitForFunction(() => typeof window.openPerformanceDocument === 'function')
        await sample('before-open')
        await page.evaluate(({ kind, size }) => window.openPerformanceDocument(kind, size), { kind, size: inputs[kind].length })
        if (kind === 'pptx') {
          const frame = page.frameLocator('iframe[title="文档预览"]')
          await frame.getByText('Performance slide 01', { exact: true }).waitFor()
          const child = page.frames().find(value => value.url().includes('/link/preview-frame/office.html'))!
          await child.waitForFunction(() => typeof window.documentFirstVisible === 'number')
          firstScreenMs =
            (await child.evaluate(() => window.documentFirstVisible!)) - (await page.evaluate(() => window.documentPerformance.startedAt))
        } else {
          await page.waitForFunction(() => typeof window.documentFirstVisible === 'number')
          firstScreenMs = await page.evaluate(() => window.documentFirstVisible! - window.documentPerformance.startedAt)
        }
        expect.soft(firstScreenMs, `${kind} original first-screen budget`).toBeLessThanOrEqual(budgets[kind])
        await sample('first-visible')
        if (kind === 'pptx') {
          const frame = page.frameLocator('iframe[title="文档预览"]')
          await page.getByRole('status').filter({ hasText: '1 / 30 页' }).waitFor()
          for (let index = 1; index <= 30; index++) {
            await frame.getByText(`Performance slide ${String(index).padStart(2, '0')}`, { exact: true }).waitFor()
            const slide = frame.locator(`[data-slide-index="${index - 1}"]`).first()
            await slide.scrollIntoViewIfNeeded()
            const bound = await slide.evaluate(async element => {
              await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
              // Product listOptions use 1.5 viewport overscan on both ends, plus edge intersections.
              return Math.max(4, Math.ceil((window.innerHeight * 4) / element.getBoundingClientRect().height) + 2)
            })
            const titleCount = await frame.getByText(/^Performance slide \d+$/u).count(),
              nodes = await frame.locator('*').count()
            maxRenderedPages = Math.max(maxRenderedPages, titleCount)
            maxDomNodes = Math.max(maxDomNodes, nodes)
            expect.soft(bound).toBeLessThan(30)
            expect.soft(titleCount).toBeLessThanOrEqual(bound)
            expect.soft(nodes).toBeLessThanOrEqual(5000)
            screenshots.push(await capture(page, kind, index, slide))
            if (index < 30) {
              await frame.locator('body').evaluate(body => {
                body.tabIndex = -1
                body.focus({ preventScroll: true })
              })
              await page.keyboard.press('ArrowRight')
            }
          }
        } else if (kind === 'pdf') {
          await page.getByRole('status').filter({ hasText: '1 / 200 页' }).waitFor()
          for (let index = 1; index <= 200; index++) {
            const element = page.locator(`.pdf-page[aria-label="第 ${index} 页"]`)
            await element.waitFor()
            await element.scrollIntoViewIfNeeded()
            await element.getByText(`Performance PDF page ${String(index).padStart(3, '0')}`, { exact: true }).waitFor()
            const canvases = await page.locator('.pdf-page canvas').count(),
              nodes = await page.locator('*').count()
            maxRenderedPages = Math.max(maxRenderedPages, canvases)
            maxDomNodes = Math.max(maxDomNodes, nodes)
            expect.soft(canvases).toBeLessThanOrEqual(5)
            expect.soft(nodes).toBeLessThanOrEqual(5000)
            screenshots.push(await capture(page, kind, index, element))
          }
        } else {
          expect(inputs.xlsx.length).toBeGreaterThanOrEqual(10 * 1024 * 1024)
          const grid = page.getByRole('grid', { name: 'Performance data', exact: true })
          expect(await grid.getAttribute('aria-rowcount')).toBe('12002')
          maxRenderedPages = await page.getByRole('row').count()
          maxDomNodes = await page.locator('*').count()
          expect.soft(await page.getByRole('gridcell').count()).toBeLessThanOrEqual(512)
          screenshots.push(await capture(page, kind, 1, grid))
          await grid.evaluate(element => {
            element.scrollTop = element.scrollHeight
          })
          await page.getByRole('gridcell', { name: 'Record 12000', exact: true }).waitFor()
          expect.soft(await page.getByRole('gridcell').count()).toBeLessThanOrEqual(512)
          screenshots.push(await capture(page, kind, 12001, grid))
        }
        await sample('after-page-walk')
      } catch (error) {
        reportError = error instanceof Error ? error.message : 'Renderer test failed'
        throw error
      } finally {
        const reads = await page.evaluate(() => window.documentPerformance?.reads ?? []).catch(() => []),
          report = {
            kind,
            inputBytes: inputs[kind].length,
            inputSha256: createHash('sha256').update(inputs[kind]).digest('hex'),
            logicalCount: counts[kind],
            logicalUnit: kind === 'xlsx' ? 'rows' : 'pages',
            firstScreenMs,
            budgetMs: budgets[kind],
            reportError,
            timingScope:
              'Local HTTP fixture read through production DocumentPreview/FileSandbox to detected content and two animation frames; browser/app cold startup and fixture generation excluded. No Host authentication or remote-network latency measured.',
            browser: browser.version(),
            platform: platform(),
            arch: arch(),
            cpu: cpus()[0]?.model,
            viewport: { width: 800, height: 1000, scale: 1 },
            maxRenderedPages,
            maxDomNodes,
            memoryScope:
              'Three CDP renderer-target JS-heap/DOM samples. Parent and Office targets are separate, may overlap, are never summed. PDF workers, GPU/canvas native allocation and process RSS are not measured; this is not a peak-total-memory bound.',
            samples,
            reads,
            fidelity: {
              status: screenshots.some(value => value.reference === 'compared')
                ? 'owner-reference-pixels-reported'
                : 'unverified-original-application-fidelity',
              comparison:
                'Existing YIQ 0.1 comparison with anti-alias exclusion, no resize; differences and invalid/missing references are report-only. References limited to 8 MiB/two million pixels.',
              compared: screenshots.filter(value => value.reference === 'compared').length,
              completeReferenceSet: screenshots.length > 0 && screenshots.every(value => value.reference === 'compared'),
              pages: screenshots,
            },
          }
        await writeFile(join(OUTPUT, `${kind}.json`), JSON.stringify(report, null, 2) + '\n')
        console.info(
          'document-performance',
          JSON.stringify({
            kind,
            inputBytes: report.inputBytes,
            firstScreenMs,
            budgetMs: report.budgetMs,
            pages: screenshots.length,
            fidelity: report.fidelity.status,
          }),
        )
        await context.close()
      }
    }, 120000)
})
