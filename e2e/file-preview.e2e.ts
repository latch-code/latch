import { chromium, type Browser } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { openSession, closeActiveFile, openFileFind } from './helpers/layout.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

describe('authenticated file column', () => {
  let host: TestHost, browser: Browser, sessionId: string
  beforeAll(async () => {
    const plugin: HarnessPlugin = {
      id: 'file-preview-fixture',
      name: '文件预览测试',
      version: '1.0.0',
      description: '本地测试模型',
      activate(context) {
        context.registerProvider({
          id: 'files',
          name: 'Files',
          model: 'fixture',
          async *stream() {
            yield {
              type: 'text',
              text: '文件：[report.txt](report.txt)、[letter.docx](letter.docx)、[table.csv](table.csv)、[.env](.env)、[picture.svg](picture.svg)、[tone.wav](tone.wav)、[guide.md](docs/guide.md)、[pixel.png](pixel.png)。',
            }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    host = await startTestHost({ demo: false, plugins: [plugin] })
    await writeFile(join(host.workspaceRoot, 'report.txt'), 'first line\nsecond line\nthird line')
    await mkdir(join(host.workspaceRoot, 'docs'))
    await writeFile(
      join(host.workspaceRoot, 'pixel.png'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1kAAAAASUVORK5CYII=', 'base64'),
    )
    await writeFile(
      join(host.workspaceRoot, 'docs/guide.md'),
      '# Project guide\n\nEuler: $e^{i\\pi}+1=0$.\n\n![Local plot](../pixel.png)\n\n![Private](../.env)\n\n![External](https://example.invalid/beacon.png)\n\n[Read report](../report.txt)\n\n```mermaid\nflowchart LR\n  A[Input] --> B[Output]\n```\n\n```typescript\nconst answer = 42\n```',
    )
    await writeFile(
      join(host.workspaceRoot, 'picture.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><script>parent.PREVIEW_SCRIPT_RAN=true</script><rect width="40" height="20" fill="gray"/></svg>',
    )
    const audio = Buffer.alloc(44 + 16000)
    audio.write('RIFF', 0)
    audio.writeUInt32LE(audio.length - 8, 4)
    audio.write('WAVEfmt ', 8)
    audio.writeUInt32LE(16, 16)
    audio.writeUInt16LE(1, 20)
    audio.writeUInt16LE(1, 22)
    audio.writeUInt32LE(8000, 24)
    audio.writeUInt32LE(16000, 28)
    audio.writeUInt16LE(2, 32)
    audio.writeUInt16LE(16, 34)
    audio.write('data', 36)
    audio.writeUInt32LE(16000, 40)
    await writeFile(join(host.workspaceRoot, 'tone.wav'), audio)
    await writeFile(join(host.workspaceRoot, '.env'), 'MODEL_API_KEY=fixture-value-only')
    await writeFile(join(host.workspaceRoot, 'table.csv'), 'name,value\nhello,=1+1\n')
    await writeFile(
      join(host.workspaceRoot, 'letter.docx'),
      zipSync({
        '[Content_Types].xml': strToU8(
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        ),
        '_rels/.rels': strToU8(
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        ),
        'word/document.xml': strToU8(
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Document in isolated frame</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
        ),
      }),
    )
    ;({ sessionId } = await host.host.bridge.createTask({
      prompt: '列出测试文件',
      requestId: randomUUID(),
      mode: 'chat',
      model: { providerId: 'files', model: 'fixture' },
    }))
    for (let attempts = 0; (await host.host.bridge.detail(sessionId)).summary.status !== 'idle'; attempts++) {
      if (attempts > 100) throw new Error('The file preview fixture did not settle')
      await new Promise(done => setTimeout(done, 50))
    }
    browser = await chromium.launch(browserLaunchOptions())
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })
  it('keeps the chosen line input when deferred find focus runs', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    const page = await context.newPage()
    try {
      await enrollBrowser(page, host, { name: '查找焦点', scopes: ['admin'] })
      await openSession(page, sessionId)
      await page.getByRole('button', { name: '预览文件：report.txt', exact: true }).click()
      const preview = page.getByRole('region', { name: '文件预览', exact: true })
      await preview.getByText('second line', { exact: true }).waitFor()
      await preview.getByRole('button', { name: '文件操作', exact: true }).click()
      await page.evaluate(() => {
        const schedule = window.requestAnimationFrame
        const cancel = window.cancelAnimationFrame
        const held = new Map<number, FrameRequestCallback>()
        let id = 1_000_000
        window.requestAnimationFrame = callback => {
          held.set(++id, callback)
          return id
        }
        window.cancelAnimationFrame = id => {
          if (!held.delete(id)) cancel(id)
        }
        Object.assign(window, {
          releaseTextFindFrames() {
            window.requestAnimationFrame = schedule
            window.cancelAnimationFrame = cancel
            for (const callback of held.values()) callback(performance.now())
            held.clear()
          },
        })
      })
      // Hold the page's next frame so the person can move focus before the requested autofocus runs.
      await page.getByRole('menuitem', { name: '查找', exact: true }).dispatchEvent('click')
      const line = preview.getByLabel('跳到行', { exact: true })
      await line.focus()
      await page.keyboard.press('Meta+a')
      await page.evaluate(() => (window as unknown as { releaseTextFindFrames(): void }).releaseTextFindFrames())
      await page.keyboard.type('2')
      await expect.poll(() => line.inputValue()).toBe('2')
      expect(await preview.getByRole('searchbox', { name: '查找文件内容', exact: true }).inputValue()).toBe('')
      expect(await line.evaluate(element => document.activeElement === element)).toBe(true)
      await page.keyboard.press('Meta+f')
      await expect
        .poll(() =>
          preview.getByRole('searchbox', { name: '查找文件内容', exact: true }).evaluate(element => document.activeElement === element),
        )
        .toBe(true)
    } finally {
      await context.close()
    }
  })
  for (const [width, height, theme] of [
    [390, 844, 'light'],
    [900, 1000, 'dark'],
    [1440, 1000, 'light'],
  ] as const) {
    it(`reads text, office and CSV through the same column at ${width}px/${theme}`, async () => {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, locale: 'zh-CN' })
      context.setDefaultTimeout(15_000)
      const page = await context.newPage()
      try {
        await enrollBrowser(page, host, { name: `预览 ${width}`, scopes: ['admin'] })
        await openSession(page, sessionId)
        const transcript = page.locator('.transcript')
        await transcript.getByRole('button', { name: '预览文件：report.txt', exact: true }).click()
        const preview = page.getByRole('region', { name: '文件预览', exact: true })
        await preview.getByText('second line', { exact: true }).waitFor()
        await openFileFind(page)
        expect(await preview.getByLabel('跳到行', { exact: true }).inputValue()).toBe('1')
        await preview.getByLabel('跳到行', { exact: true }).fill('2')
        await expect.poll(() => preview.getByLabel('跳到行', { exact: true }).inputValue()).toBe('2')
        if (width === 1440) {
          await writeFile(join(host.workspaceRoot, 'report.txt'), 'updated first\nupdated second\nupdated third')
          await preview.getByText('updated second', { exact: true }).waitFor()
          await preview.getByRole('status', { name: '', exact: true }).filter({ hasText: '已更新' }).waitFor()
          expect(await preview.getByLabel('跳到行', { exact: true }).inputValue()).toBe('2')
        }
        const blocked = await page.evaluate(() => {
          try {
            Reflect.set(document.createElement('div'), 'innerHTML', '<img src=x onerror=alert(1)>')
            return false
          } catch {
            return true
          }
        })
        expect(blocked).toBe(true)
        await mkdir('test-results/file-preview', { recursive: true })
        await page.screenshot({ path: `test-results/file-preview/text-${width}-${theme}.png`, animations: 'disabled' })
        await closeActiveFile(page)
        await transcript.getByRole('button', { name: '预览文件：letter.docx', exact: true }).click()
        const frame = page.frameLocator('iframe[title="文档预览"]')
        await frame.getByText('Document in isolated frame', { exact: true }).waitFor()
        const documentFrame = page.frames().find(frame => frame.url().includes('/preview-frame/office.html'))!
        expect(
          await documentFrame.evaluate(() => {
            try {
              void parent.document.body
              return false
            } catch {
              return true
            }
          }),
        ).toBe(true)
        expect(
          await documentFrame.evaluate(async () => {
            try {
              await fetch('/link/api/snapshot')
              return false
            } catch {
              return true
            }
          }),
        ).toBe(true)
        await page.screenshot({ path: `test-results/file-preview/docx-${width}-${theme}.png`, animations: 'disabled' })
        await closeActiveFile(page)
        await transcript.getByRole('button', { name: '预览文件：table.csv', exact: true }).click()
        await preview.getByRole('gridcell', { name: '=1+1', exact: true }).waitFor()
        await closeActiveFile(page)
        await transcript.getByRole('button', { name: '预览文件：picture.svg', exact: true }).click()
        await expect.poll(() => preview.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(40)
        expect(await page.evaluate(() => Reflect.get(globalThis, 'PREVIEW_SCRIPT_RAN'))).toBeUndefined()
        await closeActiveFile(page)
        await transcript.getByRole('button', { name: '预览文件：tone.wav', exact: true }).click()
        await expect
          .poll(() =>
            preview.locator('audio').evaluate((audio: HTMLAudioElement) => (Number.isFinite(audio.duration) ? audio.duration : 0)),
          )
          .toBe(1)
        await closeActiveFile(page)
        await transcript.getByRole('button', { name: '预览文件：docs/guide.md', exact: true }).click()
        await preview.getByRole('heading', { name: 'Project guide' }).waitFor()
        await preview.locator('.katex').waitFor()
        await expect
          .poll(() =>
            preview.getByRole('img', { name: 'Local plot', exact: true }).evaluate((image: HTMLImageElement) => image.naturalWidth),
          )
          .toBe(1)
        expect(await preview.getByRole('img', { name: 'Private', exact: true }).count()).toBe(0)
        expect(await preview.getByRole('img', { name: 'External', exact: true }).count()).toBe(0)
        const showDiagram = preview.getByRole('button', { name: '显示图表', exact: true })
        if (await showDiagram.count()) await showDiagram.click()
        await preview.getByRole('img', { name: 'Mermaid 图表', exact: true }).waitFor()
        await preview.locator('.syn-keyword', { hasText: 'const' }).waitFor()
        await page.screenshot({ path: `test-results/file-preview/markdown-${width}-${theme}.png`, animations: 'disabled' })
        await preview.getByRole('button', { name: '源码', exact: true }).click()
        await preview.locator('.file-text').waitFor()
        await preview.getByRole('button', { name: '源码', exact: true }).click()
        await preview.getByRole('button', { name: 'Read report', exact: true }).click()
        await preview.getByText(width === 1440 ? 'updated second' : 'second line', { exact: true }).waitFor()
        await closeActiveFile(page)
        await page.getByRole('tab', { name: 'guide.md', exact: true }).click()
        await closeActiveFile(page)
        await transcript.getByRole('button', { name: '预览文件：.env', exact: true }).click()
        await preview.getByText('这个文件可能包含密钥。', { exact: false }).waitFor()
        expect(await preview.getByRole('button', { name: '显示内容', exact: true }).count()).toBe(0)
        expect(await preview.innerText()).not.toContain('fixture-value-only')
        await page.screenshot({ path: `test-results/file-preview/secret-${width}-${theme}.png`, animations: 'disabled' })
      } catch (cause) {
        await page
          .screenshot({ path: `test-results/file-preview/failed-${width}-${theme}.png`, animations: 'disabled' })
          .catch(() => undefined)
        console.error(
          await page
            .locator('.file-preview')
            .innerText()
            .catch(() => 'No preview'),
        )
        throw cause
      } finally {
        await context.close()
      }
    })
  }
})
