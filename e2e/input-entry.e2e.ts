import { chromium, type Browser, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_CODEX_APP_SERVER, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import {
  composerEntry,
  noHorizontalOverflow,
  openSession,
  permissionControl,
  permissionModes,
  permissionWords,
  phoneStartScreen,
  reachable,
} from './helpers/layout.ts'

const OUTPUT = 'test-results/input-entry'

/**
 * The input's one entry (模型 · 思考 · 速度), the permission beside the Harness and the start page's headline, on Codex as the fake app-server: its
 * default model lists the Fast tier (FAKE_CODEX_TIERS), the other does not. Everything it receives goes to a log, so a
 * turn's tier, level and mode are read where Codex would read them. No program of this computer runs.
 */
describe('the input’s one entry and the start page’s headline', () => {
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let log = ''
  let gitHome = ''
  const projects: Record<string, string> = {}

  const settled = async (id: string) => {
    for (let tries = 0; (await owner.json<TaskDetail>(`tasks/${id}`)).summary.status !== 'idle'; tries++) {
      if (tries > 300) throw new Error('the session did not settle')
      await new Promise(done => setTimeout(done, 50))
    }
  }
  const begin = async (prompt: string, config?: Array<{ configId: string; value: string }>) => {
    const { sessionId } = await owner.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt, requestId: randomUUID(), harnessId: 'codex', workspaceId: projects.studio, ...(config ? { config } : {}) },
    })
    await settled(sessionId)
    return sessionId
  }
  const received = async (method: string) =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event: string; method?: string; params?: Record<string, unknown> })
      .filter(entry => entry.event === 'recv' && entry.method === method)
  const detail = (id: string) => owner.json<TaskDetail>(`tasks/${id}`)
  const current = (task: TaskDetail, id: string) => task.config?.find(option => option.id === id)?.currentValue
  const open = async (width: number, theme: 'light' | 'dark', name?: string): Promise<Page> => {
    const context = await browser.newContext({
      viewport: { width, height: width < 768 ? 844 : 900 },
      colorScheme: theme,
      locale: 'zh-CN',
      reducedMotion: 'reduce',
      ...(width < 768 ? { isMobile: true, hasTouch: true } : {}),
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'], ...(name ? { name } : {}) })
    await connected(page)
    return page
  }
  const shot = (page: Page, name: string) => page.screenshot({ path: `${OUTPUT}/${name}.png`, animations: 'disabled' })
  const panelOpen = (page: Page) => page.locator('.ui-board.is-entry, .ui-board.model-board.is-entry').filter({ visible: true }).count()

  beforeAll(async () => {
    gitHome = await mkdtemp(join(tmpdir(), 'latch-e2e-entry-home-'))
    host = await startTestHost({ demo: false, gitDelivery: { home: gitHome } })
    owner = await host.enroll({ listener: 'unix' })
    const bin = join(host.root, 'bin')
    await mkdir(bin)
    log = join(host.root, 'codex.log')
    const command = join(bin, 'codex')
    await writeFile(command, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`)
    await chmod(command, 0o755)
    await owner.confirmedJson('agents', {
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command, args: [], env: { FAKE_CODEX_TIERS: '1', FAKE_ACP_LOG: log } },
    })
    for (const name of ['studio', 'northwind']) {
      const dir = join(host.root, name)
      await mkdir(dir)
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
          cwd: dir,
          stdio: 'pipe',
          env: { ...process.env, HOME: gitHome },
        })
      git('init', '-q')
      await writeFile(join(dir, 'README.md'), `# ${name}\n`)
      git('add', '-A')
      git('commit', '-qm', 'first')
      expect((await owner.addFolders({ paths: [dir] })).ok).toBe(true)
      const list = await owner.json<{ workspaces: Array<{ id: string; path: string }> }>('workspaces')
      projects[name] = list.workspaces.find(item => item.path.endsWith(`/${name}`))!.id
    }
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
    if (gitHome) await rm(gitHome, { recursive: true, force: true })
  })

  it('sets a level and 速度 in one opening of the panel, the permission in its own popover, each staying open until Escape, and the turn runs on them', async () => {
    const sessionId = await begin('echo first')
    const page = await open(1440, 'light')
    try {
      await openSession(page, sessionId)
      const entry = composerEntry(page)
      expect(await entry.getAttribute('aria-label')).toBe('模型：GPT Fake')
      expect(await permissionWords(page)).toBe('权限：先问你')
      await entry.click()
      const board = page.locator('.ui-board.is-entry').filter({ visible: true })
      await board.waitFor()
      const foot = board.locator('.ui-board-foot')
      // 速度 only for a model that lists the Fast tier, with Codex's own words on what it costs as the hover.
      const speed = foot.getByRole('radiogroup', { name: '速度', exact: true })
      await speed.waitFor()
      // Within one model source a pick is drawn at once and nothing waits on screen: each write is held back 800 ms here,
      // and meanwhile the pick shows as chosen, no row is greyed and the entry does not say it is switching.
      await page.route('**/tasks/*/config', async route => {
        await new Promise(done => setTimeout(done, 800))
        await route.continue()
      })
      const calm = async () => ({
        locked: await board.locator('[aria-disabled="true"]').count(),
        busy: await page.locator('[aria-busy="true"]').filter({ visible: true }).count(),
        switching: await entry.locator('[data-pending][data-shown]').count(),
      })
      await speed.getByRole('radio', { name: '快速', exact: true }).click()
      expect(await speed.getByRole('radio', { name: '快速', exact: true }).getAttribute('aria-checked')).toBe('true')
      expect(await calm()).toEqual({ locked: 0, busy: 0, switching: 0 })
      await expect.poll(async () => current(await detail(sessionId), 'service_tier')).toBe('priority')
      expect(await panelOpen(page)).toBe(1)
      // The entry says the fast tier with a mark before the model, and the standard one with none.
      await expect.poll(() => entry.locator('.entry-fast').count()).toBe(1)
      await board.getByRole('menuitemradio', { name: 'High', exact: true }).click()
      expect(await board.getByRole('menuitemradio', { name: 'High', exact: true }).getAttribute('aria-checked')).toBe('true')
      await expect.poll(() => entry.locator('.model-level').innerText()).toBe('High')
      expect(await calm()).toEqual({ locked: 0, busy: 0, switching: 0 })
      await expect.poll(async () => current(await detail(sessionId), 'reasoning_effort')).toBe('high')
      await page.unroute('**/tasks/*/config')
      expect(await panelOpen(page)).toBe(1)
      // The foot holds the model's settings only: the permission is set beside the Harness.
      expect(await foot.locator('.permission-panel').count()).toBe(0)
      await expect.poll(() => entry.locator('.model-level').innerText()).toBe('High')
      await noHorizontalOverflow(page)
      await shot(page, 'one-opening-1440-light')
      await page.keyboard.press('Escape')
      await board.waitFor({ state: 'hidden' })

      // 权限 opens its modes in a popover of its own, which stays open on a choice: the strip says the chosen mode and
      // what it means, and the control follows.
      await permissionControl(page).click()
      const modes = permissionModes(page)
      await modes.waitFor()
      await modes.getByRole('radio', { name: '按规则放行', exact: true }).click()
      await expect.poll(async () => current(await detail(sessionId), 'mode')).toBe('workspace-write')
      expect(await modes.isVisible()).toBe(true)
      await expect.poll(() => modes.locator('.ui-mode-strip-name').innerText()).toBe('按规则放行')
      await expect.poll(() => permissionWords(page)).toBe('权限：按规则放行')
      await shot(page, 'permission-popover-1440-light')
      await page.keyboard.press('Escape')
      await modes.waitFor({ state: 'hidden' })

      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      await input.fill('echo fast')
      await input.press('Meta+Enter')
      await page.locator('.transcript').getByText('echo: echo fast', { exact: true }).waitFor({ timeout: 20_000 })
      expect((await received('turn/start')).at(-1)?.params).toMatchObject({
        serviceTier: 'priority',
        effort: 'high',
        approvalPolicy: 'on-request',
      })

      // A model without the tier: 速度 and with it the foot leave at once, the permission stays, and the panel stays open.
      await entry.click()
      await board.waitFor()
      await board.getByRole('menuitemradio', { name: /^GPT Fake Mini/u }).click()
      await expect.poll(async () => current(await detail(sessionId), 'model')).toBe('gpt-fake-mini')
      await expect.poll(() => board.getByRole('radiogroup', { name: '速度', exact: true }).count()).toBe(0)
      expect(await entry.locator('.entry-fast').count()).toBe(0)
      expect(await permissionWords(page)).toBe('权限：按规则放行')
      expect(await panelOpen(page)).toBe(1)
      await shot(page, 'no-speed-1440-light')
      // Clicking outside closes it as Escape does.
      await page.locator('.transcript').click({ position: { x: 8, y: 8 } })
      await board.waitFor({ state: 'hidden' })
    } finally {
      await page.context().close()
    }
  })

  it('fits the panel in a short window, its foot in view, on the start page and in a session', async () => {
    const sessionId = await begin('echo short')
    /** What of the open panel is outside the window, or scrolls as a whole instead of in its lists. */
    const outside = (board: ReturnType<Page['locator']>) =>
      board.evaluate(element => {
        const problems: string[] = []
        const layer = element.closest<HTMLElement>('.ui-popover')!
        const parts = [
          layer,
          ...element.querySelectorAll<HTMLElement>(
            '.ui-board-rail, .ui-board-search, .ui-board-rows, .ui-board-levels, .ui-board-footer, .ui-board-foot, .ui-board-foot [role="radio"]',
          ),
        ]
        for (const part of parts) {
          const box = part.getBoundingClientRect()
          if (box.height < 1) problems.push(`${part.className}: no height`)
          if (box.top < -0.5 || box.bottom > innerHeight + 0.5 || box.left < -0.5 || box.right > innerWidth + 0.5)
            problems.push(`${part.className}: ${Math.round(box.top)}–${Math.round(box.bottom)} of ${innerHeight}`)
        }
        if (layer.scrollHeight > layer.clientHeight + 1) problems.push(`the layer scrolls: ${layer.scrollHeight} > ${layer.clientHeight}`)
        if (problems.length) problems.push(`side ${layer.dataset.side}, max-height ${layer.style.maxHeight || 'none'}`)
        return problems
      })
    for (const [width, height] of [
      [1280, 720],
      [1440, 760],
    ] as const) {
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: 'dark',
        locale: 'zh-CN',
        reducedMotion: 'reduce',
      })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      try {
        await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'], name: `矮窗 ${width}` })
        await connected(page)
        const board = page.locator('.ui-board.is-entry').filter({ visible: true })
        // The start page: the input in the middle of the window, the panel opening where there is more room.
        const home = page.locator('.workbench-home')
        await composerEntry(home).click()
        await board.waitFor()
        await board.locator('.ui-board-foot').getByRole('radiogroup', { name: '速度', exact: true }).waitFor()
        await expect.poll(() => outside(board), { message: `start ${width}×${height}` }).toEqual([])
        await shot(page, `short-start-${width}x${height}-dark`)
        // A model without a foot keeps the board's fixed block, which gives way the same.
        await board.getByRole('menuitemradio', { name: /^GPT Fake Mini/u }).click()
        await expect.poll(() => board.locator('.ui-board-foot').count()).toBe(0)
        await expect.poll(() => outside(board), { message: `start, no foot ${width}×${height}` }).toEqual([])
        await page.keyboard.press('Escape')
        await board.waitFor({ state: 'hidden' })
        // A session: the input at the window's foot, the panel opening upward.
        await openSession(page, sessionId)
        await composerEntry(page).click()
        await board.waitFor()
        await board.locator('.ui-board-foot').getByRole('radiogroup', { name: '速度', exact: true }).waitFor()
        await expect.poll(() => outside(board), { message: `session ${width}×${height}` }).toEqual([])
        await shot(page, `short-session-${width}x${height}-dark`)
        await page.keyboard.press('Escape')
        await board.waitFor({ state: 'hidden' })
      } finally {
        await context.close()
      }
    }
  })

  it('starts a draft on the 速度 picked before the first message, and a model without the tier starts with none', async () => {
    const page = await open(1440, 'light')
    try {
      const home = page.locator('.workbench-home')
      const input = home.getByRole('textbox', { name: '新会话消息', exact: true })
      const draft = async (prompt: string, pick: (board: ReturnType<Page['locator']>) => Promise<void>) => {
        await home
          .getByRole('button', { name: /^项目：/u })
          .first()
          .click()
        await page
          .getByRole('menuitemradio', { name: /^studio/u })
          .first()
          .click()
        await composerEntry(home).click()
        const board = page.locator('.ui-board.is-entry').filter({ visible: true })
        await board.waitFor()
        await pick(board)
        await page.keyboard.press('Escape')
        await board.waitFor({ state: 'hidden' })
        const before = (await received('turn/start')).length
        await input.fill(prompt)
        await input.press('Meta+Enter')
        await page.locator('.transcript').getByText(`echo: ${prompt}`, { exact: true }).first().waitFor({ timeout: 20_000 })
        const turns = await received('turn/start')
        expect(turns.length).toBe(before + 1)
        return turns.at(-1)!.params!
      }
      // Codex's model list says which models take the Fast tier; a draft offers 速度 for them before any session.
      const fast = await draft('echo draft fast', async board => {
        await board.getByRole('radiogroup', { name: '速度', exact: true }).getByRole('radio', { name: '快速', exact: true }).click()
        await expect
          .poll(() =>
            board
              .getByRole('radiogroup', { name: '速度', exact: true })
              .getByRole('radio', { name: '快速', exact: true })
              .getAttribute('aria-checked'),
          )
          .toBe('true')
      })
      expect(fast).toMatchObject({ serviceTier: 'priority' })
      // 快速 picked, then a model that lists no such tier: the pick is not carried to it, and the start does not fail.
      await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
      const mini = await draft('echo draft mini', async board => {
        await board.getByRole('radiogroup', { name: '速度', exact: true }).getByRole('radio', { name: '快速', exact: true }).click()
        await board.getByRole('menuitemradio', { name: /^GPT Fake Mini/u }).click()
        await expect.poll(() => board.getByRole('radiogroup', { name: '速度', exact: true }).count()).toBe(0)
      })
      expect(mini).toMatchObject({ model: 'gpt-fake-mini' })
      expect(mini).not.toHaveProperty('serviceTier')
    } finally {
      await page.context().close()
    }
  })

  it('opens on a device that may only look: every model, level and mode stays, disabled, with why', async () => {
    const sessionId = await begin('echo look')
    const page = await open(1440, 'light', '只看的浏览器')
    try {
      const id = host.host.security.devices.list().find(device => device.name === '只看的浏览器')!.id
      await owner.json(`devices/${id}`, { method: 'PATCH', body: { scopes: ['view'] } })
      await page.reload()
      await connected(page)
      await openSession(page, sessionId)
      const entry = composerEntry(page)
      await entry.click()
      const board = page.locator('.ui-board.is-entry').filter({ visible: true })
      await board.waitFor()
      const why = async (row: ReturnType<Page['locator']>) =>
        row.evaluate(element =>
          (element.getAttribute('aria-describedby') ?? '')
            .split(' ')
            .map(item => document.getElementById(item)?.textContent ?? '')
            .join(''),
        )
      const other = board.getByRole('menuitemradio', { name: /^GPT Fake Mini/u })
      expect(await other.getAttribute('aria-disabled')).toBe('true')
      expect(await why(other)).not.toBe('')
      const level = board.getByRole('menuitemradio', { name: 'High', exact: true })
      expect(await level.getAttribute('aria-disabled')).toBe('true')
      await shot(page, 'read-only-panel-1440-light')
      await page.keyboard.press('Escape')
      await board.waitFor({ state: 'hidden' })
      // The permission opens too: every other mode stays, disabled, with why.
      await permissionControl(page).click()
      const modes = permissionModes(page)
      await modes.waitFor()
      const wider = modes.getByRole('radio', { name: '按规则放行', exact: true })
      expect(await wider.getAttribute('aria-disabled')).toBe('true')
      expect(await why(wider)).not.toBe('')
      await shot(page, 'read-only-permission-1440-light')
      await page.keyboard.press('Escape')
    } finally {
      await page.context().close()
    }
  })

  it('opens the permission’s popover for /permissions and the panel on its levels for /think, and moves between them by key', async () => {
    const sessionId = await begin('echo slash')
    const page = await open(1280, 'dark')
    try {
      await openSession(page, sessionId)
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      const focusIn = (selector: string) => page.evaluate(inside => !!document.activeElement?.closest(inside), selector)
      const board = page.locator('.ui-board.is-entry').filter({ visible: true })
      const modes = permissionModes(page)
      await input.fill('/permissions')
      await input.press('Enter')
      await modes.waitFor()
      await expect.poll(() => focusIn('.permission-panel')).toBe(true)
      expect(await board.count()).toBe(0)
      await shot(page, 'slash-permissions-1280-dark')
      await page.keyboard.press('Escape')
      await modes.waitFor({ state: 'hidden' })
      await input.fill('/think')
      await input.press('Enter')
      await board.waitFor()
      await expect.poll(() => focusIn('.ui-board-levels')).toBe(true)
      await shot(page, 'slash-think-1280-dark')
      await page.keyboard.press('Escape')
      await board.waitFor({ state: 'hidden' })
      // The key for 思考 opens the panel on its levels; the one for 权限 then opens the modes in their own popover.
      await page.locator('.transcript').click({ position: { x: 8, y: 8 } })
      await page.keyboard.press('Alt+Shift+3')
      await expect.poll(() => focusIn('.ui-board-levels')).toBe(true)
      await page.keyboard.press('Alt+Shift+4')
      await expect.poll(() => focusIn('.permission-panel')).toBe(true)
      await board.waitFor({ state: 'hidden' })
      await page.keyboard.press('Escape')
      await modes.waitFor({ state: 'hidden' })
    } finally {
      await page.context().close()
    }
  })

  it('shows a mode that never asks as the amber glyph and its name beside the Harness, kept under customisation', async () => {
    const sessionId = await begin('echo wide', [{ configId: 'mode', value: 'agent-full-access' }])
    for (const [width, theme] of [
      [1440, 'light'],
      [1440, 'dark'],
      [820, 'light'],
      [390, 'dark'],
    ] as const) {
      const page = await open(width, theme)
      try {
        await openSession(page, sessionId)
        const mark = permissionControl(page)
        await mark.waitFor()
        expect(await mark.getAttribute('data-amber')).toBe('')
        expect(await mark.getAttribute('data-lock')).toBe('')
        expect(await mark.innerText()).toBe('不再询问')
        expect(await permissionWords(page)).toBe('权限：不再询问')
        // It follows the Harness on the line; the entry no longer carries a permission.
        const order = await page.evaluate(() =>
          [...document.querySelectorAll('main.workspace:not([inert]) form.composer [data-composer-control]')]
            .filter(element => element.getClientRects().length > 0)
            .map(element => element.getAttribute('data-composer-control')),
        )
        expect(order).toEqual(['harness', 'permission', 'model'])
        expect(await composerEntry(page).locator('.entry-permission, .composer-permission').count()).toBe(0)
        const amber = await page.evaluate(() => {
          const probe = document.createElement('span')
          probe.style.color = 'var(--amber)'
          document.body.append(probe)
          const color = getComputedStyle(probe).color
          probe.remove()
          return color
        })
        const colours = () =>
          mark.evaluate(element => [getComputedStyle(element).color, getComputedStyle(element.querySelector('svg')!).color])
        // The chip's colour eases in as the page settles.
        await expect.poll(async () => (await colours())[0]).toBe(amber)
        const before = await colours()
        // A customised accent and warning colour do not reach it: the product's own tokens are pinned there.
        await page.addStyleTag({ content: ':root { --amber: rgb(1, 2, 3); --amber-icon: rgb(4, 5, 6); --muted: rgb(7, 8, 9); }' })
        expect(await colours()).toEqual(before)
        // The glyph and the whole name are inside the control, and the control inside the window: never cut.
        const inside = await mark.evaluate(button => {
          const own = button.getBoundingClientRect()
          const name = button.querySelector('.composer-permission-name')!
          const words = name.getBoundingClientRect()
          const glyph = button.querySelector('svg')!.getBoundingClientRect()
          return (
            glyph.width === 16
            && words.left >= own.left - 1
            && words.right <= own.right + 1
            && name.scrollWidth <= name.clientWidth + 1
            && own.left >= 0
            && own.right <= window.innerWidth
          )
        })
        expect(inside).toBe(true)
        await noHorizontalOverflow(page)
        await shot(page, `amber-${width}-${theme}`)
      } finally {
        await page.context().close()
      }
    }
  })

  it('changes the project from the headline, starts without one, and picks one again from the line under it', async () => {
    for (const [width, theme] of [
      [1440, 'light'],
      [390, 'light'],
    ] as const) {
      const page = await open(width, theme)
      try {
        if (width < 768) await phoneStartScreen(page)
        const headline = page.locator('.workbench-home .home-headline')
        await headline.waitFor()
        const pick = async (name: string) =>
          page
            .getByRole('menuitemradio', { name: new RegExp(`^${name}`, 'u') })
            .or(page.getByRole('radio', { name: new RegExp(`^${name}`, 'u') }))
            .filter({ visible: true })
            .first()
            .click()
        // With no project the headline asks plainly, and the small line under it opens the list.
        if (!(await headline.innerText()).startsWith('想做什么')) {
          await headline.getByRole('button', { name: '不选项目直接开始', exact: true }).click()
        }
        await expect.poll(() => headline.locator('.home-headline-ask').innerText()).toBe('想做什么？')
        await headline.getByRole('button', { name: /^项目：/u }).click()
        await pick('studio')
        await expect.poll(() => headline.locator('.home-headline-ask').innerText()).toMatch(/^想在\s*studio\s*里做什么？$/u)
        // The name is the control: underlined, opening the same list.
        const name = headline.locator('.home-headline-project').getByRole('button', { name: /^项目：/u })
        expect(await name.evaluate(element => getComputedStyle(element).textDecorationLine)).toContain('underline')
        await reachable(name)
        // Where in it the session starts is the quiet line under the input.
        await expect.poll(() => page.locator('.workbench-home .home-place').innerText()).toContain('当前文件夹')
        await shot(page, `headline-project-${width}-${theme}`)
        await name.click()
        await pick('northwind')
        await expect.poll(() => headline.locator('.home-headline-ask').innerText()).toMatch(/northwind/u)
        await headline.getByRole('button', { name: '不选项目直接开始', exact: true }).click()
        await expect.poll(() => headline.locator('.home-headline-ask').innerText()).toBe('想做什么？')
        await headline.getByRole('button', { name: /^项目：/u }).waitFor()
        expect(await headline.innerText()).toContain('选一个项目')
        await noHorizontalOverflow(page)
        await shot(page, `headline-none-${width}-${theme}`)
        // The skipped project is the draft's: the session starts in the Host's default folder.
        const input = page.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true })
        expect(await input.isVisible()).toBe(true)
      } finally {
        await page.context().close()
      }
    }
  })

  it('stacks the same parts in a phone’s sheet: models, levels and 速度, and the permission in a sheet of its own, choices keeping each open', async () => {
    const sessionId = await begin('echo phone')
    const page = await open(390, 'light')
    try {
      await openSession(page, sessionId)
      await composerEntry(page).click()
      const sheet = page.getByRole('dialog', { name: '模型', exact: true })
      await sheet.waitFor()
      const speed = sheet.getByRole('radiogroup', { name: '速度', exact: true })
      await speed.waitFor()
      expect(await sheet.locator('.permission-panel').count()).toBe(0)
      await speed.getByRole('radio', { name: '快速', exact: true }).click()
      await expect.poll(async () => current(await detail(sessionId), 'service_tier')).toBe('priority')
      expect(await sheet.isVisible()).toBe(true)
      await shot(page, 'phone-sheet-390-light')
      await sheet.getByRole('button', { name: '关闭', exact: true }).click()
      await sheet.waitFor({ state: 'hidden' })
      // The permission: its glyph alone on the line, its own sheet of modes, touch-sized.
      const control = permissionControl(page)
      expect(await control.innerText()).toBe('')
      await control.click()
      const modesSheet = page.getByRole('dialog', { name: '权限', exact: true })
      await modesSheet.waitFor()
      const modes = modesSheet.locator('.permission-panel[data-lock]').getByRole('radio')
      expect(await modes.count()).toBe(4)
      for (const mode of await modes.all()) expect((await mode.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await modesSheet.getByRole('radio', { name: '由模型判断', exact: true }).click()
      await expect.poll(async () => current(await detail(sessionId), 'mode')).toBe('agent')
      expect(await modesSheet.isVisible()).toBe(true)
      await shot(page, 'phone-permission-390-light')
      await modesSheet.getByRole('button', { name: '关闭', exact: true }).click()
      await modesSheet.waitFor({ state: 'hidden' })
      await expect.poll(() => permissionWords(page)).toBe('权限：由模型判断')
      await noHorizontalOverflow(page)
    } finally {
      await page.context().close()
    }
  })
})
