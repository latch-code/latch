import { chromium, type Browser, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { layersInWindow, noHorizontalOverflow, openPanelTab, openSession, phoneStartScreen, reachable } from './helpers/layout.ts'

const OUT = 'test-results/branch-switch'
const LONG = 'fix/studio-sidebar-history-scroll'

function pauseRequest() {
  let release!: () => void
  const waiting = new Promise<void>(resolve => {
    release = resolve
  })
  return { waiting, release }
}

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
  let gitHome = ''
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
      cwd: project,
      stdio: 'pipe',
    }).toString('utf8')

  beforeAll(async () => {
    await mkdir(OUT, { recursive: true })
    // Git's own home is a fresh folder, so no global configuration of this computer's user is read.
    gitHome = await mkdtemp(join(tmpdir(), 'latch-e2e-branch-home-'))
    host = await startTestHost({ gitDelivery: { home: gitHome } })
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
    // A branch whose README differs, so an edit to it here is one a switch would overwrite.
    git('checkout', '-q', '-b', 'feature/one')
    await writeFile(join(project, 'README.md'), '# studio, feature\n')
    await writeFile(join(project, 'feature.txt'), 'only on feature/one\n')
    git('add', '-A')
    git('commit', '-qm', 'feature')
    git('checkout', '-q', 'main')
    for (const name of ['release/2026-11', 'chore/deps', 'docs/readme']) git('branch', name)
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
    if (gitHome) await rm(gitHome, { recursive: true, force: true })
  })

  async function open(width: number, theme: 'light' | 'dark', height = 900, hasTouch = false): Promise<Page> {
    const context = await browser.newContext({
      viewport: { width, height },
      hasTouch,
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

  it('keeps long names on one line and makes other worktrees reachable beside a long local branch list', async ({ onTestFinished }) => {
    const backups = Array.from({ length: 101 }, (_, index) => `backup/before-rebase-${index}`)
    const repeated = 'keepconversationhistoryscrollstable'.repeat(3)
    const longBranches = [
      [`feature/studio/${repeated}-after-search`, '-after-search'],
      [`feature/studio/${repeated}-after-switch`, '-after-switch'],
      [`workbench${repeated}touchvariant`, 'touchvariant'],
    ] as const
    const names = [...backups, ...longBranches.map(([name]) => name)]
    for (const name of names) git('branch', name)
    const other = join(host.root, 'studio-other')
    git('worktree', 'add', '-q', other, 'docs/readme')
    onTestFinished(() => {
      git('worktree', 'remove', other)
      git('branch', '-D', ...names)
    })
    for (const [width, theme, height = 900, hasTouch = false] of [
      [1440, 'light'],
      [1440, 'dark'],
      [1100, 'light', 480],
      [768, 'light', 900, true],
      [390, 'light', 900, true],
      [320, 'dark', 560, true],
    ] as const) {
      const page = await open(width, theme, height, hasTouch)
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
        // The worktree's branch sorts past the first hundred names.
        await page.locator('.home-place button.branch-switch').click()
        const list = page.getByRole('menu', { name: '分支' })
        const search = page.getByRole('searchbox', { name: '搜索分支' })
        const views = page.getByRole('radiogroup', { name: '分支位置' })
        const worktrees = views.getByRole('radio', { name: '其他工作树' })
        await reachable(worktrees)
        expect(await views.getByRole('radio', { name: '本地分支' }).getAttribute('aria-checked')).toBe('true')
        expect(await list.getByRole('menuitemradio', { name: LONG }).getAttribute('aria-checked')).toBe('true')
        expect(await list.getByRole('menuitemradio').count()).toBe(100)
        await page.screenshot({ path: `${OUT}/list--${width}--${theme}.png` })
        if (width === 1440 && theme === 'dark') {
          await views.getByRole('radio', { name: '本地分支' }).focus()
          await search.hover()
          await page.screenshot({ path: `${OUT}/search-hover--1440--dark.png` })
          await page.mouse.move(0, 0)
        }

        const searchTop = (await search.boundingBox())!.y
        await search.press('ArrowDown')
        await page.keyboard.press('End')
        const last = list.getByRole('menuitemradio').last()
        await expect.poll(() => last.evaluate(element => element.matches(':focus-visible'))).toBe(true)
        await expect.poll(() => page.locator('.branch-list-results').evaluate(element => element.scrollTop)).toBeGreaterThan(0)
        expect((await search.boundingBox())!.y).toBeCloseTo(searchTop, 0)
        await layersInWindow(page)
        if (hasTouch) {
          expect((await worktrees.boundingBox())!.height).toBeGreaterThanOrEqual(44)
          expect((await last.boundingBox())!.height).toBeGreaterThanOrEqual(44)
        }

        await search.fill('keepconversation')
        await expect.poll(() => list.getByRole('menuitemradio').count()).toBe(longBranches.length)
        for (const [name, suffix] of longBranches) {
          const row = list.getByRole('menuitemradio', { name, exact: true })
          expect(await row.locator('.middle-ellipsis-head').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
          const tail = row.locator('.middle-ellipsis-tail')
          expect(await tail.textContent()).toContain(suffix)
          expect(await tail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
        }
        await noHorizontalOverflow(page, page.locator('.branch-list-results'))
        await page.screenshot({ path: `${OUT}/long-names--${width}--${theme}.png` })

        if (width === 1100 || width === 320) {
          const [name] = longBranches[0]
          const row = list.getByRole('menuitemradio', { name, exact: true })
          const tip = page.getByRole('tooltip').filter({ hasText: name })
          if (hasTouch) {
            let switchRequests = 0
            page.on('request', request => {
              if (request.url().endsWith('/branches/switch')) switchRequests++
            })
            const box = (await row.boundingBox())!
            const cdp = await page.context().newCDPSession(page)
            try {
              await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
              })
              await tip.waitFor()
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
              await page.screenshot({ path: `${OUT}/full-name--320--dark.png` })
              await search.tap()
              expect(switchRequests).toBe(0)
            } finally {
              await cdp.detach()
            }
          } else {
            await row.hover()
            await tip.waitFor()
            await page.screenshot({ path: `${OUT}/full-name--1100--light.png` })
          }
        }

        await worktrees.click()
        const held = list.getByRole('menuitemradio', { name: 'docs/readme' })
        await reachable(held, { allowDisabled: true })
        expect(await held.isDisabled()).toBe(true)
        expect(await list.getByRole('menuitemradio').count()).toBe(1)
        await page.screenshot({ path: `${OUT}/worktrees--${width}--${theme}.png` })
        await page.keyboard.press('Escape')
        await openSession(page, session)
        await page.screenshot({ path: `${OUT}/long-session--${width}--${theme}.png` })
        await oneLine(page)
        await noHorizontalOverflow(page)
      } finally {
        await page.context().close()
      }
    }
  })

  it('opens the list, searches, switches, and the draft and the idle session say the new branch; a refusal says why', async () => {
    const page = await open(1440, 'light')
    try {
      await chooseProject(page)
      const chip = page.locator('.home-place button.branch-switch')
      await chip.waitFor()
      // Esc closes the list and gives focus back to the chip.
      await chip.click()
      const search = page.getByRole('searchbox', { name: '搜索分支' })
      await search.waitFor()
      expect(await search.evaluate(element => element === document.activeElement)).toBe(true)
      await page.keyboard.press('Escape')
      await expect.poll(() => chip.evaluate(element => element === document.activeElement)).toBe(true)
      await chip.click()
      const list = page.getByRole('menu', { name: '分支' })
      await expect.poll(() => list.getByRole('menuitemradio').count()).toBe(6)
      expect(await list.getByRole('menuitemradio').first().getAttribute('aria-checked')).toBe('true')
      const views = page.getByRole('radiogroup', { name: '分支位置' })
      expect(await views.count()).toBe(0)
      await page.waitForTimeout(400)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await page.screenshot({ path: `${OUT}/list-open--1440--${colorScheme}.png` })
      }
      await page.emulateMedia({ colorScheme: 'light' })
      // Anywhere in a name, ignoring case.
      await search.fill('FEAT')
      await expect.poll(() => list.getByRole('menuitemradio').count()).toBe(1)
      await page.screenshot({ path: `${OUT}/list-search--1440--light.png` })
      await search.press('Escape')
      expect(await search.inputValue()).toBe('')
      await expect.poll(() => list.getByRole('menuitemradio').count()).toBe(6)
      await search.fill('FEAT')
      // Held so the switching state can be seen.
      await page.route('**/branches/switch', async route => {
        await new Promise(done => setTimeout(done, 1200))
        await route.continue()
      })
      await search.press('Enter')
      await page.locator('.branch-list[data-switching]').waitFor()
      await page.screenshot({ path: `${OUT}/switching--1440--light.png` })
      await page.locator('.branch-list').waitFor({ state: 'hidden' })
      await page.unroute('**/branches/switch')
      await expect.poll(() => chip.innerText()).toContain('feature/one')
      expect(git('branch', '--show-current').trim()).toBe('feature/one')
      await expect.poll(() => chip.evaluate(element => element === document.activeElement)).toBe(true)

      // The idle session in that folder says the new branch, and its file tree shows the branch's files.
      await openSession(page, session)
      const header = page.locator('.topbar button.branch-switch').locator('visible=true').first()
      await expect.poll(() => header.textContent()).toBe('feature/one')
      await openPanelTab(page, '文件')
      const tree = page.getByRole('treeitem', { name: 'feature.txt', exact: true })
      await tree.waitFor()
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${OUT}/session-after--1440--light.png` })
      const isListing = (url: URL) => url.pathname.endsWith('/branches')
      const heldListings = Array.from({ length: 2 }, () => ({
        captured: pauseRequest(),
        response: pauseRequest(),
      }))
      let read = 0
      await page.route(
        isListing,
        async route => {
          const hold = heldListings[read++]!
          const response = await route.fetch()
          hold.captured.release()
          await hold.response.waiting
          await route.fulfill({ response }).catch(() => {})
        },
        { times: heldListings.length },
      )
      try {
        // Switch back from the cached menu while its refresh is held.
        await header.click()
        await heldListings[0]!.captured.waiting
        await page.getByRole('searchbox', { name: '搜索分支' }).fill('history')
        const branch = list.getByRole('menuitemradio', { name: LONG })
        await branch.waitFor()
        expect(await branch.getAttribute('aria-checked')).toBe('false')
        await page.keyboard.press('ArrowDown')
        await expect.poll(() => branch.evaluate(element => element === document.activeElement)).toBe(true)
        await page.keyboard.press('Enter')
        await expect.poll(() => git('branch', '--show-current').trim()).toBe(LONG)
        await expect.poll(() => header.textContent()).toBe(LONG)

        // A response read before switching back cannot roll back the next menu's cache.
        const previousListing = page.waitForResponse(response => isListing(new URL(response.url())) && response.ok())
        heldListings[0]!.response.release()
        await (await previousListing).finished()
        await header.click()
        await heldListings[1]!.captured.waiting
        await branch.waitFor()
        expect(await branch.getAttribute('aria-checked')).toBe('true')
        await page.keyboard.press('Escape')
      } finally {
        for (const hold of heldListings) hold.response.release()
      }
      await tree.waitFor({ state: 'detached' })

      const notice = page.locator('.branch-list-notice')
      const refuse = async (to: string, words: string, name: string, dark = false) => {
        await header.click()
        await page.getByRole('menu', { name: '分支' }).getByRole('menuitemradio', { name: to, exact: true }).click()
        await expect.poll(() => notice.innerText()).toContain(words)
        await page.waitForTimeout(300)
        await page.screenshot({ path: `${OUT}/refused-${name}--1440--light.png` })
        if (dark) {
          await page.emulateMedia({ colorScheme: 'dark' })
          await page.screenshot({ path: `${OUT}/refused-${name}--1440--dark.png` })
          await page.emulateMedia({ colorScheme: 'light' })
        }
        expect(git('branch', '--show-current').trim()).toBe(LONG)
        await page.keyboard.press('Escape')
      }
      // An edit a switch would overwrite: refused, with the reason in the list, and nothing moved.
      await writeFile(join(project, 'README.md'), '# studio, edited here\n')
      await refuse('feature/one', '未提交的改动', 'local-changes')
      expect(await readFile(join(project, 'README.md'), 'utf8')).toBe('# studio, edited here\n')
      git('checkout', '--', 'README.md')
      // Hooks the repository sets for itself, and a filter driver: refused, naming the kind of setting.
      git('config', 'core.hooksPath', '.husky')
      await refuse('feature/one', '钩子', 'hooks', true)
      git('config', '--unset', 'core.hooksPath')
      git('config', 'filter.lfs.smudge', 'git-lfs smudge -- %f')
      await refuse('feature/one', 'filter', 'filter')
      git('config', '--unset', 'filter.lfs.smudge')
      // A turn in a session of the folder: refused until it ends.
      await owner.json(`tasks/${session}/prompt`, { method: 'POST', body: { prompt: 'hang', requestId: randomUUID() } })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${session}`)).summary.status).toBe('running')
      await refuse('feature/one', '正在运行', 'turn-running')
      await owner.json(`tasks/${session}/cancel`, { method: 'POST', body: {} })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${session}`)).summary.status).not.toBe('running')
      // A branch another worktree holds: shown, not choosable, with why.
      const other = join(host.root, 'studio-other')
      git('worktree', 'add', '-q', other, 'docs/readme')
      await header.click()
      const local = views.getByRole('radio', { name: '本地分支' })
      await local.waitFor()
      const held = list.getByRole('menuitemradio', { name: 'docs/readme' })
      expect(await held.count()).toBe(0)
      await search.fill('readme')
      await page.getByText('没有匹配的分支', { exact: true }).waitFor()
      await views.getByRole('radio', { name: '其他工作树' }).click()
      expect(await search.inputValue()).toBe('')
      expect(await held.isDisabled()).toBe(true)
      await page.screenshot({ path: `${OUT}/held-elsewhere--1440--light.png` })
      let switchRequests = 0
      page.on('request', request => {
        if (request.url().endsWith('/branches/switch')) switchRequests++
      })
      await search.fill('readme')
      await search.press('Enter')
      await search.fill('feat')
      await page.getByText('没有匹配的分支', { exact: true }).waitFor()
      await search.press('Enter')
      await local.click()
      await list.getByRole('menuitemradio', { name: 'feature/one' }).waitFor()
      expect(switchRequests).toBe(0)
      await page.keyboard.press('Escape')
      git('worktree', 'remove', '--force', other)
    } finally {
      await page.context().close()
    }
  })

  it('opens the same list as a sheet on a phone, and the session’s line says the branch', async () => {
    const page = await open(390, 'light')
    try {
      await openSession(page, session)
      const chip = page.locator('.topbar-subline button.branch-switch')
      await chip.waitFor()
      await chip.click()
      const sheet = page.getByRole('dialog', { name: '分支' })
      await sheet.getByRole('menuitemradio').first().waitFor()
      await page.waitForTimeout(600)
      await page.screenshot({ path: `${OUT}/sheet--390--light.png` })
      await sheet.getByRole('searchbox').fill('feat')
      await expect.poll(() => sheet.getByRole('menuitemradio').count()).toBe(1)
      await sheet.getByRole('menuitemradio', { name: 'feature/one' }).click()
      await expect.poll(() => git('branch', '--show-current').trim()).toBe('feature/one')
      await expect.poll(() => chip.textContent()).toBe('feature/one')
      expect(await oneLine(page)).toBeGreaterThan(0)
      await noHorizontalOverflow(page)
      await page.waitForTimeout(600)
      await page.screenshot({ path: `${OUT}/sheet-after--390--light.png` })
    } finally {
      await page.context().close()
    }
  })
})
