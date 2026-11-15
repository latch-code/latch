import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { latchEnv } from '@latch/host/env'
import { chromium, type Browser } from '@playwright/test'
import type { TaskDetail } from '@latch/protocol'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, reachable, settleShell } from './helpers/layout.ts'
import { homeInput, layoutSwitch, switchLayout } from './helpers/workbench.ts'

const OUT = 'test-results/workbench-scroll'
const MODEL = { providerId: 'workbench-scroll', model: 'fixture' }
let browser: Browser
let host: TestHost

beforeAll(async () => {
  host = await startTestHost({
    uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
    demo: false,
    hostName: '验收电脑',
    providerId: MODEL.providerId,
    plugins: [
      {
        id: MODEL.providerId,
        name: '队列滚动验收',
        version: '1',
        description: 'Local fixture only.',
        activate(context) {
          context.registerProvider({
            id: MODEL.providerId,
            name: '队列验收模型',
            model: MODEL.model,
            async *stream({ messages }) {
              if (messages.at(-1)?.content === '为本地发布准备说明') {
                yield {
                  type: 'tool-call',
                  call: {
                    id: randomUUID(),
                    name: 'write_file',
                    arguments: { path: 'release.md', content: '长内容中的每一行都能在队列里查看。\n'.repeat(24) },
                  },
                }
                yield { type: 'finish', reason: 'tool-calls' }
                return
              }
              throw new Error('暂时无法生成工作记录，稍后可以在原会话重试。')
            },
          })
        },
      },
    ],
  })
  const owner = await host.enroll({ listener: 'unix' })
  for (const prompt of [...Array.from({ length: 8 }, (_, index) => `待重试的发布记录 ${index + 1}`), '为本地发布准备说明']) {
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt, model: MODEL, mode: 'agent' },
    })
    await vi.waitFor(
      async () => {
        expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe(
          prompt === '为本地发布准备说明' ? 'waiting-approval' : 'failed',
        )
      },
      { timeout: 10_000 },
    )
  }
  await mkdir(OUT, { recursive: true })
  browser = await chromium.launch(browserLaunchOptions())
})

afterAll(async () => {
  await browser?.close()
  await host?.close()
})

it.each(
  (
    [
      [1440, 560],
      [768, 700],
      [390, 700],
      [1440, 420],
    ] as const
  ).flatMap(([width, height]) => (['overview', 'triage'] as const).map(layout => ({ width, height, layout }))),
)('scrolls the queue while the composer and navigation stay put at $width x $height in $layout', async ({ width, height, layout }) => {
  const independent = width >= 1024 && height >= 480
  const shot = `${OUT}/${layout}-${width}${height === 420 ? 'x420' : ''}`
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    hasTouch: width === 390,
  })
  try {
    const page = await context.newPage()
    page.setDefaultTimeout(8_000)
    await enrollBrowser(page, host, { name: '队列滚动验收', scopes: ['admin'] })
    await switchLayout(page, layout)
    const home = page.getByRole('region', { name: '总览', exact: true })
    const attention = home.getByRole('region', { name: '等你处理', exact: true })
    const heading = attention.getByRole('heading')
    await heading.waitFor()
    const approval = attention.locator('.approval-panel')
    await approval.waitFor()
    await expect.poll(() => approval.getAttribute('data-arming')).toBeNull()
    await settleShell(page)
    if (width === 390) {
      const box = await approval.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(8)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width - 8)
      expect(box!.width).toBeGreaterThan(width * 0.8)
    }

    const outer = () => home.evaluate(element => ({ home: element.scrollTop, document: document.scrollingElement?.scrollTop }))
    const inner = () =>
      attention.evaluate((element, desktop) => {
        if (desktop) return element.scrollTop
        let offset = 0
        for (let node: Element | null = element; node && !node.matches('.workbench-home'); node = node.parentElement)
          offset += node.scrollTop
        return offset
      }, independent)
    const frame = async () => ({
      composer: await home.locator('.workbench-home-composer').boundingBox(),
      switch: await layoutSwitch(page).boundingBox(),
      otherLanes: independent
        ? await home
            .locator('.work-overview-group:not([data-group="attention"])')
            .evaluateAll(elements => elements.map(element => ({ top: element.getBoundingClientRect().top, scroll: element.scrollTop })))
        : [],
    })
    const wheelAtHeading = async (delta: number) => {
      const box = await heading.boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
      await page.mouse.wheel(0, delta)
    }

    const before = await frame()
    expect(before.composer).not.toBeNull()
    expect(before.switch).not.toBeNull()
    await page.screenshot({ path: `${shot}-start.png`, animations: 'disabled' })
    await wheelAtHeading(300)
    await expect.poll(async () => ({ moved: (await inner()) > 0, ...(await outer()) })).toEqual({ moved: true, home: 0, document: 0 })
    expect(await frame()).toEqual(before)

    const list = attention.getByRole('list').first()
    const more = attention.getByRole('button', { name: '还有 4 件', exact: true })
    await reachable(more)
    await more.click()
    const last = list.locator(':scope > li').last().getByRole('button').first()
    await reachable(last)
    expect(await list.locator(':scope > li').count()).toBe(9)
    // Continue wheeling at the end; the scroll must not chain to the composer.
    const lastBox = await last.boundingBox()
    await page.mouse.move(lastBox!.x + lastBox!.width / 2, lastBox!.y + lastBox!.height / 2)
    await page.mouse.wheel(0, 700)
    await settleShell(page)
    expect(await outer()).toEqual({ home: 0, document: 0 })
    expect(await frame()).toEqual(before)
    await page.screenshot({ path: `${shot}-end.png`, animations: 'disabled' })

    const input = homeInput(page)
    const draft = '发布说明仍可继续输入。\n'.repeat(24)
    await input.fill(draft)
    await home.getByLabel('选择附件', { exact: true }).setInputFiles({
      name: 'queue-notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('fixture notes'),
    })
    await reachable(home.getByRole('button', { name: 'queue-notes.txt', exact: true }))
    await reachable(home.getByRole('button', { name: '发送', exact: true }))
    await home.getByRole('button', { name: /^Harness：/u }).click()
    await reachable(page.getByRole(width === 390 ? 'radio' : 'menuitemradio', { name: /Latch.*内置/u }))
    await page.keyboard.press('Escape')
    expect(await input.inputValue()).toBe(draft)
    const drafted = await frame()
    await reachable(last)
    expect(await outer()).toEqual({ home: 0, document: 0 })
    expect(await frame()).toEqual(drafted)
    await noHorizontalOverflow(page, attention)
    await page.screenshot({ path: `${shot}-draft.png`, animations: 'disabled' })
  } finally {
    await context.close()
  }
})
