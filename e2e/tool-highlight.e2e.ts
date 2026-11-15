import { chromium, type Browser, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Message, TaskDetail } from '@latch/protocol'
import { browserLaunchOptions } from './helpers/browser.ts'

/** Read rows in the real transcript and reading position, on the real worker, with no Host: a frame is `window.showDetail`. */

const RUST = 'use std::io;\n\n// entry\nfn main() {\n    let name = "latch";\n    println!("{}", name);\n}\n'
const HTML = `<!doctype html>\n<html lang="zh">\n<img src="data:image/png;base64,${'A'.repeat(4000)}">\n<script>\nconst a = 1\n</script>\n</html>\n`

const read = (id: string, path: string, output: string, extra: Partial<Message> = {}): Message =>
  ({
    id,
    role: 'tool',
    state: 'completed',
    toolName: 'read_file',
    text: output,
    tool: { kind: 'read', input: JSON.stringify({ path }), output },
    ...extra,
  }) as Message

function detail(messages: Message[], running = false): TaskDetail {
  return {
    summary: { id: 'session-fixture', title: '夹具', status: running ? 'running' : 'idle', updatedAt: '2026-11-01T00:00:00.000Z' },
    messages,
    liveText: '',
    cursor: 1,
  } as unknown as TaskDetail
}
const turn = (messages: Message[]): Message[] => [{ id: 'u', role: 'user', text: '读一下' } as Message, ...messages]

describe('read output highlighting', () => {
  let server: ViteDevServer, browser: Browser, page: Page

  const open = async (width = 1000, height = 900, colorScheme: 'light' | 'dark' = 'light') => {
    await page?.close()
    page = await browser.newPage({ viewport: { width, height }, colorScheme, reducedMotion: 'reduce' })
    page.setDefaultTimeout(30_000)
    await page.goto(`${server.resolvedUrls!.local[0]!}test/transcript-harness.html`)
    await page.waitForFunction(() => typeof window.showDetail === 'function')
  }
  const show = (value: TaskDetail) => page.evaluate(next => window.showDetail(next), value)
  const row = (id: string) => page.locator(`[data-message-id="${id}"]`)
  const expand = async (id: string) => {
    // A run of finished reads folds into one row (「读取 3 个文件」): open it to reach the read itself.
    const group = page.locator('.reads-row', { has: row(id) }).locator('> .process-row[aria-expanded="false"]')
    if (await group.count()) await group.click()
    await row(id).locator('.tool-card-header').click()
    await row(id).locator('.tool-output').waitFor()
  }

  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      root: resolve('apps/web'),
      server: { host: '127.0.0.1', port: 0 },
      logLevel: 'error',
      cacheDir: resolve('node_modules/.vite-tool-highlight'),
      optimizeDeps: {
        entries: ['test/transcript-harness.tsx'],
        include: [
          '@shikijs/core',
          '@shikijs/engine-javascript',
          ...new Set((await readFile(resolve('apps/web/src/preview/highlight.worker.ts'), 'utf8')).match(/@shikijs\/langs\/[a-z]+/gu)),
        ],
      },
    })
    await server.listen()
    browser = await chromium.launch(browserLaunchOptions())
    // On a cold cache Vite finds dependencies as they load and reloads the page, which would lose a fixture mid-test.
    await open()
    for (let tries = 0; tries < 90; tries++) {
      await show(detail(turn([read('warm', 'a.rs', RUST)]))).catch(() => {})
      await row('warm')
        .locator('.tool-card-header')
        .click({ timeout: 1000 })
        .catch(() => {})
      if (
        await page
          .locator('.syn-keyword')
          .first()
          .isVisible()
          .catch(() => false)
      )
        return
      await new Promise(done => setTimeout(done, 1000))
    }
    throw new Error('The harness never coloured a row')
  })
  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await server?.close()
  })

  it('colours a read file by its name and keeps its text', async () => {
    await open()
    await show(detail(turn([read('r', 'src/main.rs', RUST)])))
    await expand('r')
    await row('r').locator('.syn-keyword', { hasText: 'fn' }).waitFor()
    expect(await row('r').locator('.syn-comment').first().textContent()).toBe('// entry')
    expect(await row('r').locator('.tool-output').textContent()).toBe(RUST)
    const colours = await row('r')
      .locator('.tool-output [class^="syn-"]')
      .evaluateAll(spans => [...new Set(spans.map(span => getComputedStyle(span).color))])
    expect(colours.length).toBeGreaterThan(2)
    // Colour only: the same weight as the plain text it replaced.
    expect(
      await row('r')
        .locator('.syn-keyword')
        .first()
        .evaluate(span => getComputedStyle(span).fontWeight),
    ).toBe(
      await row('r')
        .locator('.tool-output')
        .evaluate(pre => getComputedStyle(pre).fontWeight),
    )
  })

  it('keeps a long line from costing the rest of an HTML file its colours', async () => {
    await open()
    await show(detail(turn([read('h', 'public/index.html', HTML)])))
    await expand('h')
    await row('h').locator('.syn-keyword', { hasText: 'const' }).waitFor()
    expect(await row('h').locator('.tool-output').textContent()).toBe(HTML)
    expect(await row('h').locator('.tool-output').getByText('<img src=', { exact: false }).count()).toBeGreaterThan(0)
  })

  it('leaves an agent’s line numbers out of the grammar and in the row', async () => {
    const numbered = '<file>\n     1→fn main() {\n     2→    let a = 1;\n     3→}\n</file>'
    await open()
    await show(detail(turn([read('n', 'src/main.rs', numbered)])))
    await expand('n')
    await row('n').locator('.syn-keyword', { hasText: 'fn' }).waitFor()
    expect(await row('n').locator('.tool-output').textContent()).toBe(numbered)
    expect(await row('n').locator('.syn-comment').first().textContent()).toBe('     1→')
  })

  it('marks hidden characters and draws no markup from the output', async () => {
    const output = 'fn main() { // ‮abc\n  let tag = "<img src=x onerror=alert(1)>";\n}\n'
    await open()
    await show(detail(turn([read('s', 'src/main.rs', output)])))
    await expand('s')
    await row('s').locator('.syn-keyword', { hasText: 'fn' }).waitFor()
    expect(await row('s').locator('.hidden-char').textContent()).toBe('\\u{202E}')
    expect(await row('s').locator('.tool-output img').count()).toBe(0)
    expect(await row('s').locator('.tool-output').textContent()).not.toContain('‮')
  })

  it('colours only a finished read of a known file', async () => {
    const plain = [
      read('run', 'a.rs', RUST, { state: 'running' }),
      read('fail', 'a.rs', 'fn missing', { state: 'failed' }),
      read('unknown', 'LICENSE', RUST),
      read('secret', 'credentials.json', '{"a": 1}'),
      {
        ...read('cmd', 'a.rs', RUST),
        toolName: 'shell',
        tool: { kind: 'execute', input: '{"command":"cat a.rs"}', output: RUST },
      } as Message,
    ]
    await open()
    await show(detail(turn([...plain, read('ok', 'a.rs', RUST)]), true))
    for (const { id } of plain) await expand(id)
    await expand('ok')
    await row('ok').locator('.syn-keyword').first().waitFor()
    for (const { id } of plain) expect(await row(id).locator('[class^="syn-"]').count(), id).toBe(0)
    // The run ends and the same row colours.
    await show(detail(turn([read('run', 'a.rs', RUST), ...plain.slice(1), read('ok', 'a.rs', RUST)]), true))
    await row('run').locator('.syn-keyword').first().waitFor()
  })

  it('stays plain beyond the limit, and bounds the spans of what it colours', async () => {
    const large = 'let x = 1;\n'.repeat(20_000)
    const long = 'let x = 1;\n'.repeat(5000)
    await open()
    await show(detail(turn([read('big', 'a.rs', large), read('long', 'b.rs', long)]), true))
    await expand('big')
    await expand('long')
    await row('long').locator('.syn-keyword').first().waitFor()
    expect(await row('big').locator('[class^="syn-"]').count()).toBe(0)
    expect(await row('long').locator('.syn-keyword', { hasText: 'let' }).count()).toBe(1000)
    expect(await row('long').locator('.tool-output').textContent()).toBe(long)
  })

  it("colours a reply's fences written with a short name or an attribute", async () => {
    const fences = [
      ['rust,ignore', 'fn main() {}'],
      ['rb', 'def a\nend'],
      ['kt', 'fun a() {}'],
      ['golang', 'func a() {}'],
      ['htm', '<p class="a">b</p>'],
    ]
    await open()
    const text = fences.map(([language, code]) => `\`\`\`${language}\n${code}\n\`\`\``).join('\n\n')
    await show(detail(turn([{ id: 'a', role: 'assistant', model: 'fixture', text } as Message])))
    const blocks = row('a').locator('.message-code')
    await blocks.nth(fences.length - 1).waitFor()
    for (let index = 0; index < fences.length; index++) await blocks.nth(index).locator('[class^="syn-"]:not(.syn-plain)').first().waitFor()
  })

  it('bounds the spans of a dense read that is under the row limit', async () => {
    const dense = `${Array.from({ length: 195 }, () => `[${Array.from({ length: 330 }, (_, n) => n % 10).join(',')}],`).join('\n')}\n`
    await open()
    await show(detail(turn([read('dense', 'data.rs', dense)])))
    await expand('dense')
    await row('dense').locator('[class^="syn-"]').first().waitFor()
    expect(await row('dense').locator('[class^="syn-"]').count()).toBeLessThanOrEqual(20_000)
    expect(await row('dense').locator('.tool-output').textContent()).toBe(dense)
  })

  it('does not move the conversation when colour lands', async () => {
    // Long enough to wrap on a phone, short enough that the row's own height follows its text.
    const output = `${Array.from({ length: 4 }, (_, n) => `pub fn value_${n}(input: &str) -> String { let long_name = "text"; format!("{}{}", long_name, input) }`).join('\n')}\n`
    const filler = Array.from(
      { length: 12 },
      (_, n) => ({ id: `a${n}`, role: 'assistant', model: 'fixture', text: `第 ${n} 段说明文字。\n\n${'内容 '.repeat(120)}` }) as Message,
    )
    await open(390, 700)
    await show(detail(turn([...filler, read('t', 'a.rs', output), ...filler.map(item => ({ ...item, id: `b${item.id}` }))]), true))
    await page.locator('[data-message-id="a11"]').waitFor()
    // A reader who scrolled up is not following the end, so nothing but this row can move the view.
    await page.mouse.move(195, 350)
    for (let tries = 0; tries < 30 && !(await row('t').locator('.tool-card-header').isVisible()); tries++) await page.mouse.wheel(0, -600)
    await page.mouse.wheel(0, -1)
    await row('t').evaluate(element => element.scrollIntoView({ block: 'center' }))
    const place = () =>
      page.evaluate(() => {
        const box = document.querySelector('.transcript')!
        const pre = document.querySelector('[data-message-id="t"] .tool-output')!
        const next = document.querySelector('[data-message-id="ba0"]')!
        return { top: box.scrollTop, height: pre.getBoundingClientRect().height, next: next.getBoundingClientRect().top }
      })
    await row('t').locator('.tool-card-header').click()
    await row('t').locator('.tool-output').waitFor()
    const start = await place()
    await row('t').locator('.syn-keyword').first().waitFor()
    // The same text laid out with no tokens at all, whenever the tokens arrived.
    const plain = await row('t')
      .locator('.tool-output')
      .evaluate(pre => {
        const copy = pre.cloneNode() as HTMLElement
        copy.textContent = pre.textContent
        pre.after(copy)
        const height = copy.getBoundingClientRect().height
        copy.remove()
        return height
      })
    expect(start.height).toBe(plain)
    expect(await place()).toEqual(start)
  })

  it('colours without widening the page in every width and scheme', async () => {
    const shots = [
      [390, 844, 'phone'],
      [820, 1100, 'tablet'],
      [1280, 860, 'desktop'],
    ] as const
    for (const [width, height, name] of shots)
      for (const scheme of ['light', 'dark'] as const) {
        await open(width, height, scheme)
        await show(
          detail(
            turn([
              read('rs', 'src/main.rs', RUST),
              read('html', 'public/index.html', HTML),
              read(
                'num',
                'src/lib.rs',
                '     1→use std::fs;\n     2→\n     3→pub fn load() -> String {\n     4→    fs::read_to_string("a").unwrap()\n     5→}',
              ),
              read('fail', 'src/gone.rs', 'No such file', { state: 'failed' }),
              read('run', 'src/slow.rs', RUST, { state: 'running' }),
            ]),
            true,
          ),
        )
        for (const id of ['rs', 'html', 'num', 'run']) await expand(id)
        for (const id of ['rs', 'html', 'num']) await row(id).locator('.syn-keyword').first().waitFor()
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        expect(overflow, `${name} ${scheme}`).toBeLessThanOrEqual(0)
      }
  })
})
