import { chromium, type Browser, type Page } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Message, TaskDetail } from '@latch/protocol'
import { browserLaunchOptions } from './helpers/browser.ts'

/**
 * The transcript under a long session and a stream, on the real worker and the real reading position, with no Host: a
 * frame is `window.showDetail`. Budgets are counts (renders, spans, coloured blocks), which load does not change.
 */

const FN = (index: number) =>
  `export function value${index}(input: string): string {\n  const answer = "text ${index}" // note\n  return answer + input\n}`
const block = (index: number) => `\`\`\`ts\n${FN(index)}\n\`\`\``
const SESSION = 'session-fixture'

function history(turns: number, blocksPerTurn = 2): Message[] {
  const messages: Message[] = []
  for (let turn = 0; turn < turns; turn++) {
    messages.push({ id: `user-${turn}`, role: 'user', text: `问题 ${turn}` })
    messages.push({
      id: `reply-${turn}`,
      role: 'assistant',
      model: 'fixture',
      text: Array.from(
        { length: blocksPerTurn },
        (_, index) => `第 ${turn} 轮说明 ${index}\n\n${block(turn * blocksPerTurn + index)}`,
      ).join('\n\n'),
    })
  }
  return messages
}
/** Replies of plain paragraphs, as tall as `paragraphs` makes them: no code, so nothing colours and moves them later. */
function prose(turns: number, paragraphs: number, prefix = ''): Message[] {
  const messages: Message[] = []
  for (let turn = 0; turn < turns; turn++) {
    messages.push({ id: `${prefix}user-${turn}`, role: 'user', text: `问题 ${turn}` })
    messages.push({
      id: `${prefix}reply-${turn}`,
      role: 'assistant',
      model: 'fixture',
      text: Array.from({ length: paragraphs }, (_, index) => `第 ${turn} 轮第 ${index} 段 word${turn}x${index} 说明文字。`).join('\n\n'),
    })
  }
  return messages
}
function detail(
  messages: Message[],
  options: { liveText?: string; running?: boolean; cursor?: number; liveId?: string; id?: string } = {},
): TaskDetail {
  return {
    summary: {
      id: options.id ?? SESSION,
      title: '夹具',
      status: options.running ? 'running' : 'idle',
      updatedAt: '2026-10-31T00:00:00.000Z',
    },
    messages,
    liveText: options.liveText ?? '',
    ...(options.liveId ? { liveMessageId: options.liveId } : {}),
    cursor: options.cursor ?? 1,
  } as unknown as TaskDetail
}

// React calls this hook on every commit. A fiber that rendered this commit has the PerformedWork flag; a subtree a memo
// bailed out of keeps its old child pointer and is not walked. The test also asserts the live turn counted, so a React
// that stopped reporting this would fail rather than pass with zero.
const COUNT_RENDERS = () => {
  const renders: Record<string, number> = {}
  const walk = (fiber: FiberNode | null) => {
    for (let node = fiber; node; node = node.sibling) {
      const label = node.type?.name
      if (label && node.flags & 1) renders[label] = (renders[label] ?? 0) + 1
      if (!node.alternate || node.child !== node.alternate.child) walk(node.child)
    }
  }
  interface FiberNode {
    type?: { name?: string }
    flags: number
    sibling: FiberNode | null
    child: FiberNode | null
    alternate: FiberNode | null
  }
  Object.assign(window, {
    renders,
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      supportsFiber: true,
      isDisabled: false,
      inject: () => 1,
      onCommitFiberUnmount: () => {},
      onCommitFiberRoot: (_id: number, root: { current: FiberNode }) => {
        walk(root.current.child)
      },
      checkDCE: () => {},
    },
  })
}
declare global {
  interface Window {
    renders: Record<string, number>
  }
}

describe('streaming render', () => {
  let server: ViteDevServer, browser: Browser, page: Page

  const open = async (width = 1000, height = 900) => {
    await page?.close()
    page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
    page.setDefaultTimeout(30_000)
    await page.addInitScript(COUNT_RENDERS)
    await page.goto(`${server.resolvedUrls!.local[0]!}test/transcript-harness.html`)
    await page.waitForFunction(() => typeof window.showDetail === 'function')
  }
  const show = (value: TaskDetail) => page.evaluate(next => window.showDetail(next), value)
  const scrollTop = (top: number) =>
    page.evaluate(value => {
      document.querySelector('.transcript')!.scrollTop = value
    }, top)

  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      root: resolve('apps/web'),
      server: { host: '127.0.0.1', port: 0 },
      logLevel: 'error',
      // Its own: the other Vite fixtures prebundle other sets, and would make each other's runs cold.
      cacheDir: resolve('node_modules/.vite-streaming-render'),
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
      await show(detail(history(2))).catch(() => {})
      if (
        (await page
          .locator('.syn-keyword')
          .count()
          .catch(() => 0)) > 0
      )
        return
      await new Promise(done => setTimeout(done, 1000))
    }
    throw new Error('The harness never coloured a block')
  })
  afterAll(async () => {
    await page?.close()
    await browser?.close()
    await server?.close()
  })

  it('colours the newest block of a 600-block session, only what is near the view, and the rest as they come', async () => {
    await open()
    await show(detail(history(300)))
    const last = page.locator('.message-code').last()
    await last.locator('.syn-keyword').first().waitFor()
    const coloured = () => page.locator('.message-code:has(.syn-keyword)').count()
    // A screen and the margin around it, out of 600 blocks.
    await expect.poll(coloured).toBeGreaterThan(0)
    const near = await coloured()
    expect(near).toBeLessThan(40)
    expect(await page.locator('[class^="syn-"]').count()).toBeLessThan(40 * 60)
    for (const top of [0, 60_000, 30_000]) {
      await scrollTop(top)
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const view = document.querySelector('.transcript')!.getBoundingClientRect()
              const visible = [...document.querySelectorAll('.message-code')].filter(code => {
                const rect = code.getBoundingClientRect()
                return rect.bottom > view.top && rect.top < view.bottom
              })
              return visible.length > 0 && visible.every(code => code.querySelector('.syn-keyword'))
            }),
          { timeout: 45_000 },
        )
        .toBe(true)
    }
    expect(await coloured()).toBeLessThan(600)
  })

  it('keeps settled turns from rendering during a stream, and spans bounded as a block grows', async () => {
    await open()
    const past = history(30)
    await show(detail(past, { running: true, cursor: 0 }))
    await page.locator('.message-code').last().locator('.syn-keyword').first().waitFor()
    await page.evaluate(() => {
      for (const key of Object.keys(window.renders)) delete window.renders[key]
    })
    const frames = 40
    const stream = Array.from({ length: frames * 5 }, (_, index) => `const line${index} = ${index} // comment`)
    const liveId = 'reply-live'
    const spans: number[] = []
    for (let frame = 1; frame <= frames; frame++) {
      const liveText = `说明\n\n\`\`\`ts\n${stream.slice(0, frame * 5).join('\n')}\nconst par`
      await show(detail([...past, { id: 'user-live', role: 'user', text: '继续' }], { running: true, liveText, liveId, cursor: frame }))
      if (frame % 10 === 0) spans.push(await page.locator('.message-code.is-open [class^="syn-"]').count())
    }
    const live = page.locator('[data-message-id="reply-live"]')
    await live.locator('.message-code .syn-keyword').first().waitFor()
    const renders = await page.evaluate(() => window.renders)
    // Each frame draws the live turn and its row, and no other. The new prompt's turn is the one added, once.
    expect(renders.TurnView).toBeGreaterThanOrEqual(frames)
    expect(renders.TurnView).toBeLessThanOrEqual(frames + 2)
    expect(renders.MessageContent).toBeLessThanOrEqual(frames + 2)
    // 200 lines arrived; the tail draws 17 of them, about ten spans each.
    expect(Math.max(...spans)).toBeLessThanOrEqual(17 * 12)
    expect(await live.locator('pre code').textContent()).not.toContain('line0 ')
  })

  it('copies the current raw Markdown during streaming and retains the same reply and copy control when it settles', async () => {
    await open(390)
    const user: Message = { id: 'user-copy', role: 'user', text: '写一个重点' }
    const text = '说明：**未闭合重点'
    await show(detail([user], { running: true, liveText: text, liveId: 'reply-copy', cursor: 1 }))
    const reply = page.locator('[data-message-id="reply-copy"]')
    await reply.locator('strong').waitFor()
    await reply.evaluate(element => element.setAttribute('data-owned-node', 'reply'))
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    const copy = page.locator('.turn-footer').getByRole('button', { name: '复制', exact: true })
    expect(await copy.count()).toBe(1)
    expect(await page.locator('.turn-footer .turn-facts').count()).toBe(0)
    expect(await page.locator('.turn-footer button:not(.ui-copy-button)').count()).toBe(0)
    await reply.click()
    await copy.click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text)
    await copy.evaluate(element => element.setAttribute('data-owned-node', 'copy'))
    const next = text + '继续到达'
    await show(detail([user], { running: true, liveText: next, liveId: 'reply-copy', cursor: 2 }))
    await reply.getByText('未闭合重点继续到达', { exact: true }).waitFor()
    await copy.click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(next)
    expect(await copy.getAttribute('data-owned-node')).toBe('copy')
    await mkdir('test-results/stream-copy', { recursive: true })
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await reply.hover()
        await copy.click({ trial: true })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: `test-results/stream-copy/live-${width}-${colorScheme}.png`, animations: 'disabled' })
      }
    }
    await show(detail([user, { id: 'reply-copy', role: 'assistant', text: next }], { cursor: 3 }))
    await expect.poll(() => reply.locator('.message-content').getAttribute('aria-busy')).toBe(null)
    expect(await reply.getAttribute('data-owned-node')).toBe('reply')
    expect(await reply.innerText()).toContain('**未闭合重点')
    expect(await copy.getAttribute('data-owned-node')).toBe('copy')
    await reply.click()
    await copy.click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(next)
  })

  it('does not rerender completed Markdown blocks while only the live tail changes', async () => {
    await open()
    const user: Message = { id: 'user-blocks', role: 'user', text: '写一段说明' }
    const prefix = '```text\n固定代码\n```\n\n'
    await show(detail([user], { running: true, liveText: prefix + '尾部', liveId: 'reply-blocks', cursor: 1 }))
    await page.getByText('固定代码', { exact: true }).waitFor()
    await page.evaluate(() => {
      for (const key of Object.keys(window.renders)) delete window.renders[key]
    })
    for (let frame = 2; frame <= 12; frame++) {
      await show(detail([user], { running: true, liveText: prefix + '尾部'.repeat(frame), liveId: 'reply-blocks', cursor: frame }))
      await expect.poll(() => page.locator('.message-content p').last().textContent()).toBe('尾部'.repeat(frame))
    }
    const renders = await page.evaluate(() => window.renders)
    expect(renders.MessageContent).toBeGreaterThanOrEqual(11)
    expect(renders.ClosedCode ?? 0).toBe(0)
    expect(renders.CodeBlock ?? 0).toBe(0)
  })

  it('shows the tail of an open fence, its finished lines coloured, its unfinished line plain, without moving when it closes', async () => {
    await open()
    const liveId = 'reply-live'
    const user: Message = { id: 'user-live', role: 'user', text: '写代码' }
    const lines = Array.from({ length: 40 }, (_, index) => `const line${index} = ${index}`)
    await show(detail([user], { running: true, liveText: `\`\`\`ts\n${lines.slice(0, 3).join('\n')}`, liveId, cursor: 1 }))
    const code = page.locator(`[data-message-id="${liveId}"] .message-code`)
    // Short: everything is there; the last line may still change, so it stays plain.
    await code.locator('.syn-keyword', { hasText: 'const' }).nth(1).waitFor()
    expect(await code.locator('.syn-keyword', { hasText: 'const' }).count()).toBe(2)
    const box = code.locator('.message-code-tail-note')
    expect(await box.count()).toBe(0)
    await show(detail([user], { running: true, liveText: `\`\`\`ts\n${lines.slice(0, 18).join('\n')}`, liveId, cursor: 2 }))
    await show(detail([user], { running: true, liveText: `\`\`\`ts\n${lines.join('\n')}`, liveId, cursor: 3 }))
    await expect.poll(() => box.textContent()).toBe('前 23 行已收起')
    await code.locator('.syn-keyword', { hasText: 'const' }).nth(15).waitFor()
    const shown = (await code.locator('pre code').textContent())!
    expect(shown.startsWith('const line23 = 23\n')).toBe(true)
    expect(shown.trimEnd().endsWith('const line39 = 39')).toBe(true)
    expect(await code.getByRole('button', { name: '展开全部 40 行', exact: true }).count()).toBe(1)
    // The last line is visible, with no scroll position written.
    const visible = await code.locator('pre').evaluate(pre => ({ top: pre.scrollTop, overflow: pre.scrollHeight - pre.clientHeight }))
    expect(visible.top).toBe(0)
    expect(visible.overflow).toBeLessThanOrEqual(0)
    const height = await code.evaluate(element => element.getBoundingClientRect().height)
    await show(detail([user], { running: true, liveText: `\`\`\`ts\n${lines.join('\n')}\n\`\`\`\n`, liveId, cursor: 4 }))
    await expect.poll(() => box.count()).toBe(0)
    expect(await code.evaluate(element => element.getBoundingClientRect().height)).toBe(height)
    expect((await code.locator('pre code').textContent())!.startsWith('const line0 = 0\n')).toBe(true)
    await code.locator('.syn-keyword', { hasText: 'const' }).first().waitFor()
    // Colours reach the first lines shown, not all forty.
    expect(await code.locator('.syn-keyword', { hasText: 'const' }).count()).toBeLessThanOrEqual(19)
  })

  it('keeps a finished line’s DOM nodes as more arrive and when the block closes, and the reply’s ID throughout', async () => {
    await open()
    const liveId = 'reply-live'
    const user: Message = { id: 'user-live', role: 'user', text: '写代码' }
    const text = (count: number, close = '') =>
      `\`\`\`ts\n${Array.from({ length: count }, (_, index) => `const line${index} = ${index}`).join('\n')}${close}`
    await show(detail([user], { running: true, liveText: text(4), liveId, cursor: 1 }))
    const code = page.locator(`[data-message-id="${liveId}"] pre code`)
    await code.locator('.syn-keyword').nth(2).waitFor()
    const first = await code.locator('.syn-keyword').first().elementHandle()
    const row = await page.locator(`[data-message-id="${liveId}"]`).elementHandle()
    await show(detail([user], { running: true, liveText: text(8), liveId, cursor: 2 }))
    await code.locator('.syn-keyword').nth(6).waitFor()
    expect(await first!.evaluate(element => element.isConnected)).toBe(true)
    await show(detail([user, { id: liveId, role: 'assistant', text: text(8, '\n```\n') }], { cursor: 3 }))
    await code.locator('.syn-keyword').nth(7).waitFor()
    await page.waitForTimeout(50)
    expect(await first!.evaluate(element => element.isConnected)).toBe(true)
    expect(await row!.evaluate(element => element.isConnected)).toBe(true)
  })

  it('reads a block spanning grammar state across lines, as the whole block would', async () => {
    await open()
    const liveId = 'reply-live'
    const user: Message = { id: 'user-live', role: 'user', text: '写代码' }
    await show(
      detail([user], { running: true, liveText: '```ts\n/* opened\nstill a comment\n*/ const after = 1\nconst tail', liveId, cursor: 1 }),
    )
    const code = page.locator(`[data-message-id="${liveId}"] pre code`)
    await code.locator('.syn-keyword', { hasText: 'const' }).first().waitFor()
    expect(await code.locator('.syn-comment').allTextContents()).toEqual(
      expect.arrayContaining([expect.stringContaining('still a comment')]),
    )
    expect(await code.locator('.syn-keyword', { hasText: 'still' }).count()).toBe(0)
  })

  it('colours past a Python docstring and through a shell pipe', async () => {
    await open()
    const python = '```python\ndef f(x):\n    """doc"""\n    return x + 1\n```'
    const shell = '```bash\necho "x" | grep y\n```'
    await show(
      detail([
        { id: 'u', role: 'user', text: '代码' },
        { id: 'a', role: 'assistant', text: `${python}\n\n${shell}` },
      ]),
    )
    const blocks = page.locator('.message-code')
    await blocks.nth(0).locator('.syn-keyword', { hasText: 'return' }).waitFor()
    expect(await blocks.nth(0).locator('.syn-comment').allTextContents()).toEqual(['"""doc"""'])
    await blocks.nth(1).locator('.syn-string', { hasText: '"x"' }).waitFor()
    await blocks.nth(1).locator('.syn-keyword', { hasText: '|' }).waitFor()
  })

  it('colours a CRLF fence, the shell and console labels, and both sides of a diff', async () => {
    await open()
    await show(
      detail([
        { id: 'u', role: 'user', text: '代码' },
        {
          id: 'a',
          role: 'assistant',
          text: [
            '```ts\r\nconst a = 1\r\nconst b = 2\r\n```',
            '```shell\necho "x"\n```',
            '```console\necho "y"\n```',
            '```diff\n+added\n-removed\n```',
          ].join('\n\n'),
        },
      ]),
    )
    const blocks = page.locator('.message-code')
    await blocks.nth(0).locator('.syn-keyword', { hasText: 'const' }).first().waitFor()
    expect(await blocks.nth(0).locator('code').textContent()).toContain('const a = 1\nconst b = 2')
    await blocks.nth(1).locator('.syn-string', { hasText: '"x"' }).waitFor()
    await blocks.nth(2).locator('.syn-string', { hasText: '"y"' }).waitFor()
    await blocks.nth(3).locator('.syn-string', { hasText: 'added' }).waitFor()
    await blocks.nth(3).locator('.syn-constant', { hasText: 'removed' }).waitFor()
  })

  it.each([
    [320, 700],
    [768, 1024],
    [1440, 900],
  ])('lets a long code line be read to its end at %dpx, and the page stays in place', async (width, height) => {
    await open(width, height)
    const long = `const ${'veryLongIdentifier'.repeat(20)}_END = 1`
    await show(
      detail([
        { id: 'u', role: 'user', text: '长行' },
        { id: 'a', role: 'assistant', text: `\`\`\`ts\n${long}\n\`\`\`\n\n行内 \`${long}\`` },
      ]),
    )
    const pre = page.locator('.message-code pre')
    await pre.locator('.syn-keyword').first().waitFor()
    const measured = await pre.evaluate(element => {
      const style = getComputedStyle(element)
      const before = {
        client: element.clientWidth,
        scroll: element.scrollWidth,
        overflow: style.overflowX,
        hint: style.backgroundAttachment,
      }
      element.scrollLeft = element.scrollWidth
      const range = document.createRange()
      range.selectNodeContents(element.querySelector('code')!)
      const text = range.getBoundingClientRect(),
        box = element.getBoundingClientRect()
      return {
        ...before,
        left: element.scrollLeft,
        endInView: text.right <= box.right + 1 && text.right > box.left,
        tabIndex: element.tabIndex,
      }
    })
    expect(measured.overflow).toBe('auto')
    expect(measured.hint).toContain('local')
    expect(measured.scroll).toBeGreaterThan(measured.client)
    expect(measured.left).toBeGreaterThan(0)
    expect(measured.endInView).toBe(true)
    expect(measured.tabIndex).toBe(0)
    const page_ = await page.evaluate(() => {
      const transcript = document.querySelector('.transcript')!
      return { doc: document.documentElement.scrollWidth - window.innerWidth, transcript: transcript.scrollWidth - transcript.clientWidth }
    })
    expect(page_.doc).toBeLessThanOrEqual(0)
    expect(page_.transcript).toBeLessThanOrEqual(0)
  })

  it('finds text across coloured tokens and in blocks not coloured yet, and keeps the match when a block colours', async () => {
    await open()
    await show(detail(history(120)))
    await page.locator('.message-code').last().locator('.syn-keyword').first().waitFor()
    await page.evaluate(() => window.openFind())
    await page.getByRole('searchbox').fill('value3(input')
    // Spans three tokens once coloured, in a block far above the view.
    await expect.poll(() => page.getByRole('search').getByRole('status').textContent()).toBe('1/1')
    await page.locator('[data-message-id="reply-1"] .message-code .syn-keyword').first().waitFor()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const current = CSS.highlights.get('latch-find-current')
          const range = current ? ([...current.values()][0] as Range | undefined) : undefined
          return range && !range.collapsed ? range.toString() : ''
        }),
      )
      .toBe('value3(input')
    const inView = await page.evaluate(() => {
      const code = document.querySelector('[data-message-id="reply-1"]')!.getBoundingClientRect(),
        view = document.querySelector('.transcript')!.getBoundingClientRect()
      return code.bottom > view.top && code.top < view.bottom
    })
    expect(inView).toBe(true)
  })

  it('keeps a match in a tool output current when a block colours', async () => {
    await open()
    await show(
      detail([
        ...history(40),
        { id: 'user-tool', role: 'user', text: '读取' },
        { id: 'tool', role: 'tool', text: 'the needle here', toolName: 'read_file', state: 'completed' },
        { id: 'reply-tool', role: 'assistant', model: 'fixture', text: '完成' },
      ]),
    )
    await page.locator('.message-code').last().locator('.syn-keyword').first().waitFor()
    await page.evaluate(() => window.openFind())
    await page.getByRole('searchbox').fill('needle')
    const current = () =>
      page.evaluate(() => {
        const highlight = CSS.highlights.get('latch-find-current')
        return highlight ? [...highlight.values()].map(range => (range as Range).toString()) : []
      })
    await expect.poll(current).toEqual(['needle'])
    await page.locator('.transcript').hover()
    await page.mouse.wheel(0, -100_000)
    await page.locator('.message-code').first().locator('.syn-keyword').first().waitFor()
    await page.waitForTimeout(200)
    expect(await current()).toEqual(['needle'])
  })

  it('finds the lines a plain open block brings back when expanded', async () => {
    await open()
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n')
    await show(
      detail([{ id: 'u', role: 'user', text: '继续' }], {
        running: true,
        liveId: 'a',
        liveText: `\`\`\`text\nhiddenword\n${lines}\nmore`,
      }),
    )
    await page.getByRole('button', { name: /展开全部/u }).waitFor()
    await page.evaluate(() => window.openFind())
    const status = page.getByRole('search').getByRole('status')
    await page.getByRole('searchbox').fill('hiddenword')
    await expect.poll(() => status.textContent()).toBe('0/0')
    await page.getByRole('button', { name: /展开全部/u }).click()
    await expect.poll(() => status.textContent()).toBe('1/1')
  })

  it('holds the reader’s place above a stream, and jumps back to the latest', async () => {
    await open()
    const past = history(30)
    const liveId = 'reply-live'
    await show(detail(past, { running: true, cursor: 0 }))
    await page.locator('.message-code').last().waitFor()
    const transcript = page.locator('.transcript')
    await transcript.hover()
    await page.mouse.wheel(0, -2000)
    await page.getByRole('button', { name: /回到最新/u }).waitFor()
    const anchor = page.locator('[data-message-id="reply-27"]')
    const before = await anchor.evaluate(element => element.getBoundingClientRect().top)
    await page.waitForTimeout(300)
    for (let frame = 1; frame <= 20; frame++) {
      const liveText = `\`\`\`ts\n${Array.from({ length: frame * 3 }, (_, index) => `const line${index} = ${index}`).join('\n')}\nconst x`
      await show(detail([...past, { id: 'user-live', role: 'user', text: '继续' }], { running: true, liveText, liveId, cursor: frame }))
    }
    const after = await anchor.evaluate(element => element.getBoundingClientRect().top)
    expect(Math.abs(after - before)).toBeLessThan(400)
    const settled = await anchor.evaluate(element => element.getBoundingClientRect().top)
    await show(detail([...past, { id: 'user-live', role: 'user', text: '继续' }], { running: true, liveText: '`x`', liveId, cursor: 21 }))
    expect(Math.abs((await anchor.evaluate(element => element.getBoundingClientRect().top)) - settled)).toBeLessThanOrEqual(1)
    await page.getByRole('button', { name: /回到最新/u }).click()
    await expect
      .poll(() => transcript.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop))
      .toBeLessThanOrEqual(2)
  })

  // Far turns are placeholders of a guessed height, and a turn's rows measure in full whether it is drawn or not.
  describe.each([
    ['barely taller than the placeholder', 10],
    ['several times the placeholder', 25],
    ['taller than the view', 60],
  ])('with turns %s', (_name, paragraphs) => {
    it('reveals a far row exactly where it asked, and it stays there', async () => {
      await open()
      await show(detail(prose(40, paragraphs)))
      const at = () =>
        page.evaluate(() => {
          const row = document.querySelector('[data-message-id="user-5"]')!.getBoundingClientRect()
          return row.top - document.querySelector('.transcript')!.getBoundingClientRect().top
        })
      await page.waitForTimeout(300)
      await page.evaluate(() => window.revealMessage('user-5'))
      await expect.poll(at).toBeCloseTo(24, 0)
      await page.waitForTimeout(800)
      expect(await at()).toBeCloseTo(24, 0)
    })

    it('reveals a far row near the end, though the turns after it are not drawn', async () => {
      await open()
      await show(detail(prose(40, paragraphs)))
      await page.waitForTimeout(300)
      await page.locator('.transcript').hover()
      await page.evaluate(() => {
        const view = document.querySelector('.transcript')!
        view.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }))
        view.scrollTop = 0
      })
      await page.waitForTimeout(500)
      await page.evaluate(() => window.revealMessage('user-38'))
      const at = () =>
        page.evaluate(() => {
          const row = document.querySelector('[data-message-id="user-38"]')!.getBoundingClientRect()
          return row.top - document.querySelector('.transcript')!.getBoundingClientRect().top
        })
      await page.waitForTimeout(800)
      expect(await at()).toBeLessThan(900)
    })

    it('finds a word in a far turn and lands on it', async () => {
      await open()
      await show(detail(prose(40, paragraphs)))
      await page.waitForTimeout(300)
      await page.evaluate(() => window.openFind())
      await page.getByRole('searchbox').fill('word5x0')
      await expect.poll(() => page.getByRole('search').getByRole('status').textContent()).toBe('1/1')
      const seen = () =>
        page.evaluate(() => {
          const current = [...CSS.highlights.get('latch-find-current')!.values()][0] as Range,
            view = document.querySelector('.transcript')!.getBoundingClientRect(),
            top = current.getBoundingClientRect().top
          return top >= view.top && top < view.top + 200
        })
      await expect.poll(seen).toBe(true)
      await page.waitForTimeout(800)
      expect(await seen()).toBe(true)
    })

    it('returns to the same paragraph after visiting another session', async () => {
      await open()
      const past = detail(prose(40, paragraphs))
      await show(past)
      await page.waitForTimeout(300)
      await page.locator('.transcript').hover()
      for (let step = 0; step < 6; step++) {
        await page.mouse.wheel(0, -900)
        await page.waitForTimeout(200)
      }
      await page.waitForTimeout(1000)
      const reading = () =>
        page.evaluate(() => {
          const view = document.querySelector('.transcript')!.getBoundingClientRect()
          for (let y = 300; y < 600; y += 20) {
            const paragraph = document.elementFromPoint(view.left + view.width / 2, view.top + y)?.closest('.message-content p')
            if (paragraph) return { text: paragraph.textContent, at: Math.round(paragraph.getBoundingClientRect().top - view.top) }
          }
          return null
        })
      const before = await reading()
      expect(before).not.toBeNull()
      await show(detail(prose(3, 5, 'other-'), { id: 'other' }))
      await page.waitForTimeout(300)
      await show(past)
      await page.waitForTimeout(1000)
      const after = await reading()
      expect(after?.text).toBe(before!.text)
      expect(Math.abs(after!.at - before!.at)).toBeLessThanOrEqual(1)
    })
  })

  it('moves by what the wheel asks when scrolling up through turns not drawn yet, and prints every turn', async () => {
    await open()
    await show(detail(history(80)))
    await page.locator('.message-code').last().locator('.syn-keyword').first().waitFor()
    await page.locator('.transcript').hover()
    const top = () => page.locator('.transcript').evaluate(element => element.scrollTop)
    const row = (id: string) => page.locator(`[data-message-id="${id}"]`).evaluate(element => element.getBoundingClientRect().top)
    const jumps: number[] = []
    for (let step = 0; step < 12; step++) {
      const before = await page.evaluate(() => {
        const view = document.querySelector('.transcript')!.getBoundingClientRect()
        const first = [...document.querySelectorAll<HTMLElement>('[data-message-id]')].find(
          element => element.getBoundingClientRect().bottom > view.top,
        )!
        return { id: first.dataset.messageId!, at: first.getBoundingClientRect().top }
      })
      await page.mouse.wheel(0, -900)
      await expect.poll(async () => (await row(before.id)) - before.at).toBeGreaterThan(0)
      await page.waitForTimeout(120)
      jumps.push((await row(before.id)) - before.at)
    }
    expect(
      jumps.every(jump => Math.abs(jump - 900) <= 2),
      jumps.join(','),
    ).toBe(true)
    expect(await top()).toBeGreaterThan(0)
    await page.emulateMedia({ media: 'print' })
    const printed = await page.evaluate(() => getComputedStyle(document.querySelector('.turn')!).contentVisibility)
    expect(printed).toBe('visible')
    await page.emulateMedia({ media: 'screen' })
  })

  it.each(['light', 'dark'] as const)('draws syntax in readable colours from the tokens in %s', async colorScheme => {
    await open()
    await page.emulateMedia({ colorScheme })
    await show(detail(history(2)))
    await page.locator('.message-code .syn-comment').last().waitFor()
    const ratios = await page.evaluate(() => {
      const channels = (value: string) => value.match(/[\d.]+/gu)!.map(Number)
      const linear = (value: number) => (value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4)
      const luminance = ([r = 0, g = 0, b = 0]: number[]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
      const ground = channels(getComputedStyle(document.querySelector('.message-code')!).backgroundColor)
      return Object.fromEntries(
        ['keyword', 'string', 'comment', 'plain'].flatMap(role => {
          const token = document.querySelector(`.message-code .syn-${role}`)
          if (!token) return []
          const a = luminance(channels(getComputedStyle(token).color)),
            b = luminance(ground)
          return [[role, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)]]
        }),
      )
    })
    expect(Object.keys(ratios).sort()).toEqual(['comment', 'keyword', 'plain', 'string'])
    for (const [role, ratio] of Object.entries(ratios)) expect(ratio, role).toBeGreaterThanOrEqual(role === 'comment' ? 3 : 4.5)
    await page.emulateMedia({ colorScheme: 'light' })
  })

  it('asks when a run goes quiet, says what it cannot read, and says what is unknown when the engine dies', async () => {
    await open()
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    const live = { runId: 'r', activity: 'model', since: ago(5), lastEventAt: ago(3) }
    const withSummary = (extra: object, running: boolean): TaskDetail => {
      const base = detail(prose(1, 2), { running })
      return { ...base, summary: { ...base.summary, ...extra } } as TaskDetail
    }

    await show(withSummary({ live: { ...live, silent: true, silenceThresholdMs: 120_000 } }, true))
    const line = page.locator('.status-line')
    await line.filter({ hasText: /等模型回应 · 3 分钟没有新内容/ }).waitFor()
    await line.getByRole('button', { name: '继续等', exact: true }).waitFor()

    await show(
      withSummary({ live: { ...live, unrecognized: { count: 1, at: ago(0), method: 'terminal/create', messageId: 'user-0' } } }, true),
    )
    await line.filter({ hasText: '发来不支持的请求 terminal/create' }).waitFor()
    await line.getByRole('button', { name: '查看', exact: true }).waitFor()
    expect(await line.getByRole('button', { name: '继续等', exact: true }).count()).toBe(0)

    await show(withSummary({ runEnd: { reason: 'process-exited', unknownResultCount: 1, unknownResults: [{ name: 'pnpm test' }] } }, false))
    const end = page.locator('.run-end')
    await end.filter({ hasText: '已退出 · 这一轮没有完成 · 这 1 条命令结果未知，请核对' }).waitFor()
    await end.getByText('pnpm test', { exact: true }).waitFor()
  })
})
