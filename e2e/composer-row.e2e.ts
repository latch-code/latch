import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeModels, type FakeModels, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { openSession } from './helpers/layout.ts'

const OUTPUT = 'test-results/composer-row'
const LONG_MODEL = 'a-model-with-a-very-long-identifier-2026-11-preview-extended'
const LONG_PROJECT = '一个名字非常非常长的项目用来检查输入框的控件行'
/** The composer's own widths, from a phone's to a wide column. */
const WIDTHS = [320, 400, 480, 560, 640, 700, 760, 820, 880, 960, 1040, 1200]

/**
 * The boxes of everything on the composer's control row: ＋, the place chips, the four controls, what sits before send,
 * and send. None may overlap another, and none may leave the composer.
 */
async function overlaps(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const stack = [...document.querySelectorAll<HTMLElement>('.composer-stack')].find(element => element.getClientRects().length > 0)
    if (!stack) return ['no composer']
    const bounds = stack.getBoundingClientRect()
    const boxes = [
      ...stack.querySelectorAll<HTMLElement>(
        '.composer-add, [data-composer-control], .home-composer-location > *, .composer-meta > *, .composer-slot > *, .send-button',
      ),
    ]
      .filter(element => element.getClientRects().length > 0 && !element.closest('[popover], dialog'))
      .filter((element, _, all) => !all.some(other => other !== element && other.contains(element)))
      .map(element => ({ name: element.className || element.tagName, rect: element.getBoundingClientRect() }))
      .filter(box => box.rect.width > 0 && box.rect.height > 0)
    const wrong: string[] = []
    for (const box of boxes)
      if (box.rect.left < bounds.left - 0.5 || box.rect.right > bounds.right + 0.5) wrong.push(`${box.name} leaves the composer`)
    for (const [index, a] of boxes.entries())
      for (const b of boxes.slice(index + 1)) {
        const x = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left)
        const y = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top)
        if (x > 0.5 && y > 0.5) wrong.push(`${a.name} × ${b.name}`)
      }
    return wrong
  })
}

describe('the composer control row at every width of its own', () => {
  let directory: string
  let host: TestHost
  let owner: TestDevice
  let models: FakeModels
  let browser: Browser

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'latch-e2e-composer-row-'))
    models = await startFakeModels()
    host = await startTestHost({ demo: false, sessionFolders: true })
    owner = await host.enroll({ listener: 'unix' })
    expect(
      (
        await owner.confirmed('providers', {
          method: 'POST',
          body: {
            id: 'row',
            name: '一个名字很长的模型服务',
            kind: 'openai-compatible',
            baseURL: `${models.origin}/v1`,
            models: [LONG_MODEL],
            defaultModel: LONG_MODEL,
            confirmOrigin: true,
            modelCapabilities: { [LONG_MODEL]: { thinking: ['low', 'xhigh'] } },
          },
        })
      ).status,
    ).toBe(201)
    const folder = join(directory, 'project')
    await mkdir(folder, { recursive: true })
    expect((await owner.addFolders({ name: LONG_PROJECT, paths: [folder] })).status).toBe(201)
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
    await models?.close()
    await rm(directory, { recursive: true, force: true })
  })

  const open = async (): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
    await connected(page)
    return page
  }
  /** The composer narrowed to `width` within a wide window, as a side panel or the sidebar narrows its column. */
  const narrow = async (page: Page, width: number) => {
    await page.evaluate(value => {
      let style = document.getElementById('row-width')
      if (!style) {
        style = document.createElement('style')
        style.id = 'row-width'
        document.head.append(style)
      }
      style.textContent = `.composer-stack { width: ${value}px !important; max-width: ${value}px !important; }`
    }, width)
    await page.waitForTimeout(50)
  }
  const sweep = async (page: Page, name: string) => {
    for (const width of WIDTHS) {
      await narrow(page, width)
      const wrong = await overlaps(page)
      if (wrong.length || width === 700) await page.screenshot({ path: `${OUTPUT}/${name}-${width}.png`, animations: 'disabled' })
      expect(wrong, `${name} at ${width}px`).toEqual([])
    }
  }

  it('keeps every control apart on the home, in both layouts, and in a running session', async () => {
    const page = await open()
    const home = page.locator('.workbench-home-composer')
    await home.waitFor()
    await expect.poll(() => home.innerText()).toContain(LONG_PROJECT)
    await expect.poll(() => home.innerText()).toContain(LONG_MODEL)
    await sweep(page, 'home-sidebar')
    const layout = page.getByRole('radiogroup', { name: '布局', exact: true }).filter({ visible: true }).first()
    await layout.getByRole('radio', { name: '顶栏', exact: true }).click()
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-workbench-layout')).toBe('triage')
    await sweep(page, 'home-triage')
    await layout.getByRole('radio', { name: '侧栏', exact: true }).click()

    const project = (await owner.json<{ workspaces: Array<{ id: string; name: string }> }>('workspaces')).workspaces.find(
      item => item.name === LONG_PROJECT,
    )!
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        prompt: '你好',
        mode: 'agent',
        workspaceId: project.id,
        model: { providerId: 'row', model: LONG_MODEL },
      },
    })
    await page.evaluate(() => document.getElementById('row-width')?.remove())
    // The overview's row for it, once it has one; otherwise the sidebar's.
    const row = page.locator(`[data-task-id="${sessionId}"]`).filter({ visible: true }).first()
    if (
      await row.waitFor({ timeout: 5_000 }).then(
        () => true,
        () => false,
      )
    )
      await row.click()
    else await openSession(page, sessionId)
    await page.locator('.transcript').getByText('你好', { exact: true }).first().waitFor()
    await sweep(page, 'session')
    await page.context().close()
  })
})
