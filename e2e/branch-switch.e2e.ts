import { chromium, type Browser, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession, phoneStartScreen } from './helpers/layout.ts'

const OUT = 'test-results/branch-switch'
const LONG = 'fix/studio-sidebar-history-scroll'

/** Every place a branch name is drawn stays on one line, whatever the width. */
async function oneLine(page: Page): Promise<number> {
  return page.evaluate(() => {
    const shown = [
      ...document.querySelectorAll<HTMLElement>('.branch-name, [data-seg="branch"] .composer-status-value, .topbar-session-branch'),
    ].filter(element => element.getClientRects().length > 0)
    for (const element of shown) {
      const style = getComputedStyle(element)
      const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5
      if (element.getBoundingClientRect().height > line * 1.5) throw new Error(`wraps: ${element.className} ${element.innerText}`)
    }
    return shown.length
  })
}

describe('the branch chip', () => {
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let project = ''
  let session = ''
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
      cwd: project,
      stdio: 'pipe',
    }).toString('utf8')

  beforeAll(async () => {
    await mkdir(OUT, { recursive: true })
    host = await startTestHost()
    owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'fake-agent', name: 'Fake Agent', command: process.execPath, args: [FAKE_ACP_AGENT] },
    })
    project = join(host.root, 'studio')
    await mkdir(project)
    git('init', '-q')
    await writeFile(join(project, 'README.md'), '# studio\n')
    git('add', '-A')
    git('commit', '-qm', 'first')
    git('checkout', '-q', '-b', LONG)
    expect((await owner.addFolders({ paths: [project] })).ok).toBe(true)
    const workspaces = await owner.json<{ workspaces: Array<{ id: string; path: string }> }>('workspaces')
    const workspaceId = workspaces.workspaces.find(item => item.path.endsWith('/studio'))!.id
    session = (
      await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { harnessId: 'fake-agent', prompt: 'plan', requestId: randomUUID(), workspaceId },
      })
    ).sessionId
    for (let tries = 0; (await owner.json<TaskDetail>(`tasks/${session}`)).summary.status !== 'idle'; tries++) {
      if (tries > 300) throw new Error('the session did not settle')
      await new Promise(done => setTimeout(done, 50))
    }
    browser = await chromium.launch(browserLaunchOptions())
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  async function open(width: number, theme: 'light' | 'dark'): Promise<Page> {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: theme,
      reducedMotion: 'reduce',
      locale: 'zh-CN',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const name = `分支 ${width} ${theme} ${randomUUID().slice(0, 4)}`
    await enrollBrowser(page, host, { name })
    const devices = await owner.json<{ devices: Array<{ id: string; name: string }> }>('devices')
    const id = devices.devices.find(item => item.name === name)!.id
    expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    await page.reload()
    await connected(page)
    return page
  }

  /** The draft's project: the one Git project. */
  async function chooseProject(page: Page): Promise<void> {
    await phoneStartScreen(page)
    await page
      .getByRole('button', { name: /^项目：/u })
      .first()
      .click()
    await page
      .getByRole('menuitemradio', { name: /studio/u })
      .or(page.getByRole('radio', { name: /studio/u }))
      .first()
      .click()
  }

  it('keeps a long branch name on one line in the draft and in the session’s header', async () => {
    for (const [width, theme] of [
      [1440, 'light'],
      [1440, 'dark'],
      [1100, 'light'],
      [390, 'light'],
    ] as const) {
      const page = await open(width, theme)
      try {
        await chooseProject(page)
        await page.locator('[data-seg="branch"]').locator('visible=true').first().waitFor()
        await page.mouse.move(0, 0)
        await page
          .locator('.ui-popover:popover-open')
          .waitFor({ state: 'detached' })
          .catch(() => {})
        await page.screenshot({ path: `${OUT}/long-draft--${width}--${theme}.png` })
        expect(await oneLine(page)).toBeGreaterThan(0)
        await openSession(page, session)
        await page.screenshot({ path: `${OUT}/long-session--${width}--${theme}.png` })
        await oneLine(page)
        await noHorizontalOverflow(page)
      } finally {
        await page.context().close()
      }
    }
  })
})
