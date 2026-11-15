import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Locator, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { TaskDetail, TaskStatus, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { backToPhoneSessions, closeSettings, noHorizontalOverflow, openSection, reachable, settleShell } from './helpers/layout.ts'
import { VISUAL_TIME, visualContext } from './helpers/visual.ts'
import { LAYOUT_NAMES, homeInput as homeInputOf, layoutSwitch, switchLayout, returnFromHomeFocus } from './helpers/workbench.ts'

const OUTPUT = 'test-results/workbench-layout'
const MODEL = { providerId: 'workbench-fixture', model: 'fixture' }
const PROMPTS = {
  recent: '整理工作台验收记录',
  failed: '核对失败后的重试入口',
  waiting: '保存需要批准的报告',
  running: '继续检查布局与阅读位置',
}

async function choose(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Meta+k')
  const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
  await palette.getByRole('searchbox').fill(title)
  await palette.getByRole('option', { name: title, exact: true }).click()
  await palette.waitFor({ state: 'hidden' })
}

async function openHome(page: Page): Promise<void> {
  if (await page.locator('.workbench-home').isVisible()) return
  if ((await page.locator('.phone-tabs').count()) > 0) {
    if (await page.locator('.settings-page').isVisible()) {
      await closeSettings(page.locator('.settings-page'))
    }
    await backToPhoneSessions(page)
    await page.locator('.phone-list .phone-overview-link').getByRole('button', { name: '返回总览', exact: true }).click()
  } else {
    await page.getByRole('button', { name: '总览', exact: true }).locator('visible=true').first().click()
  }
  await page.locator('.workbench-home').waitFor({ state: 'visible' })
  await settleShell(page)
}

const layoutMenu = switchLayout

async function generalSettings(page: Page): Promise<void> {
  await layoutSwitch(page).getByRole('radio', { checked: true }).focus()
  await page.keyboard.press('Alt+,')
  const settings = page.locator('.settings-page')
  await settings.waitFor({ state: 'visible' })
  await openSection(settings, '通用')
  await settings.getByRole('radiogroup', { name: '工作台布局', exact: true }).waitFor({ state: 'visible' })
}

async function capture(page: Page, surface: string, width: number, theme: 'light' | 'dark'): Promise<void> {
  await page.mouse.move(0, 0)
  await page.evaluate(() => document.fonts.ready)
  await settleShell(page)
  await expect.poll(() => page.locator('.approval-panel[data-arming], .question-card[data-arming]').count()).toBe(0)
  await noHorizontalOverflow(page)
  await page.screenshot({ path: `${OUTPUT}/${surface}--${width}--${theme}.png`, animations: 'disabled', caret: 'hide' })
}

function paintedBackground(locator: Locator): Promise<string> {
  return locator.evaluate(element => {
    for (let layer: Element | null = element; layer; layer = layer.parentElement) {
      const color = getComputedStyle(layer).backgroundColor
      if (color !== 'rgba(0, 0, 0, 0)') return color
    }
    throw new Error('No painted background')
  })
}

it('keeps real sessions and drafts through layout changes, and shows both homes across widths and themes', async () => {
  let calls = 0
  let toolExecutions = 0
  const releases = new Set<() => void>()
  const plugin: HarnessPlugin = {
    id: 'workbench-fixture',
    name: '工作台验收模型',
    version: '1',
    description: 'Local scripted replies only.',
    activate(context) {
      context.registerTool({
        name: 'save_workbench_report',
        description: '保存验收报告。',
        kind: 'edit',
        requiresApproval: true,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute() {
          toolExecutions++
          return { text: '报告已保存。' }
        },
      })
      context.registerProvider({
        id: MODEL.providerId,
        name: '本地验收模型',
        model: MODEL.model,
        async *stream({ messages, signal }) {
          calls++
          const prompt = messages.findLast(message => message.role === 'user')?.content
          if (prompt === PROMPTS.failed) throw new Error('本地验收模型暂时不可用')
          if (prompt === PROMPTS.waiting && messages.at(-1)?.role !== 'tool') {
            yield { type: 'tool-call', call: { id: randomUUID(), name: 'save_workbench_report', arguments: {} } }
            yield { type: 'finish', reason: 'tool-calls' }
            return
          }
          if (prompt === PROMPTS.running) {
            yield { type: 'reasoning', text: '正在检查工作台布局。' }
            await new Promise<void>((done, fail) => {
              const release = () => {
                releases.delete(release)
                done()
              }
              releases.add(release)
              signal.addEventListener(
                'abort',
                () => {
                  releases.delete(release)
                  fail(signal.reason)
                },
                { once: true },
              )
            })
            signal.throwIfAborted()
          }
          // The session the checks read is long enough to stand in its middle.
          if (prompt === PROMPTS.recent) yield { type: 'text', text: '这一段用来核对切换布局后仍停在原处阅读。\n\n'.repeat(80) }
          yield { type: 'text', text: '工作台验收记录已整理。切换布局不会发送草稿。' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({
    uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
    demo: false,
    plugins: [plugin],
    providerId: MODEL.providerId,
    hostName: '验收电脑',
    now: () => VISUAL_TIME,
    clock: () => VISUAL_TIME + 60_000,
  })
  const browser = await chromium.launch(browserLaunchOptions())
  const active: string[] = []
  const owner = await host.enroll({ listener: 'unix' })
  try {
    const projectPath = join(host.root, 'workbench-project')
    await mkdir(projectPath)
    const added = await owner.addFolders({ name: '工作台项目', paths: [projectPath] })
    expect(added.status).toBe(201)
    const { workspace: project }: { workspace: WorkspaceInfo } = await added.json()
    const create = async (prompt: string, status: TaskStatus): Promise<TaskDetail> => {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), prompt, mode: 'agent', workspaceId: project.id, model: MODEL },
      })
      active.push(sessionId)
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, { timeout: 10_000 }).toBe(status)
      return owner.json<TaskDetail>(`tasks/${sessionId}`)
    }
    const recent = await create(PROMPTS.recent, 'idle')
    const failed = await create(PROMPTS.failed, 'failed')
    const waiting = await create(PROMPTS.waiting, 'waiting-approval')
    const running = await create(PROMPTS.running, 'running')
    await expect.poll(() => calls).toBe(4)
    const callsBefore = calls
    await mkdir(OUTPUT, { recursive: true })

    const context = await visualContext(browser, { name: 'desktop', width: 1440, height: 1000, touch: false })
    try {
      const page = await context.newPage()
      await enrollBrowser(page, host, { name: '布局切换验收', scopes: ['view', 'run'] })
      const writes: string[] = []
      page.on('request', request => {
        // The 顶栏 queue's own read (`POST /api/workbench/delivery`) is a read; nothing that starts, continues, answers
        // or stops work may leave while a layout changes.
        if (
          request.method() !== 'GET'
          && /\/api\/(?:tasks(?:\/[^/]+\/(?:prompt|cancel|queue))?|approvals\/[^/]+|questions\/[^/]+)$/u.test(
            new URL(request.url()).pathname,
          )
        )
          writes.push(request.url())
      })
      await choose(page, recent.summary.title)
      const input = page.locator('.workspace textarea').first()
      const draft = '这段草稿在两种布局之间保留，不发送。'
      await input.fill(draft)
      const original = await input.elementHandle()
      if (!original) throw new Error('The conversation has no composer')
      const sameComposer = async () => {
        expect(await original.evaluate(element => element.isConnected)).toBe(true)
        expect(await page.evaluate(element => document.querySelector('.workspace textarea') === element, original)).toBe(true)
        expect(await input.inputValue()).toBe(draft)
      }
      const shell = page.locator('.app-shell')
      const home = page.locator('.workbench-home')
      const homeInput = homeInputOf(page)
      const settings = page.locator('.settings-page')
      const nowhere = async () => expect(await page.evaluate(() => document.body.innerText)).not.toContain('分拣台')
      const marked = () => page.evaluate(() => (window as unknown as { layoutSwitchMarks: number }).layoutSwitchMarks)
      const watchLayout = () =>
        page.evaluate(() => {
          const state = window as unknown as { layoutSwitchMarks: number }
          state.layoutSwitchMarks = 0
          new MutationObserver(() => {
            if (document.documentElement.hasAttribute('data-layout-switch')) state.layoutSwitchMarks++
          }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-layout-switch'] })
        })
      await watchLayout()
      const fades = await page.evaluate(() => typeof document.startViewTransition === 'function')
      const still = () => expect.poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-layout-switch'))).toBe(false)

      // In a session: read from the middle, with a draft and the panel open.
      if ((await shell.getAttribute('data-inspector')) !== 'open') await page.keyboard.press('Alt+Shift+b')
      await expect.poll(() => shell.getAttribute('data-inspector')).toBe('open')
      const transcript = page.locator('.workspace .transcript').first()
      const bottom = await transcript.evaluate(element => element.scrollTop)
      await transcript.hover()
      await page.mouse.wheel(0, -1200)
      await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeLessThan(bottom - 600)
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
      const reading = await transcript.evaluate(element => element.scrollTop)
      expect(reading).toBeGreaterThan(200)
      const sameSession = async () => {
        await sameComposer()
        expect(Math.abs((await transcript.evaluate(element => element.scrollTop)) - reading)).toBeLessThanOrEqual(2)
        expect(await shell.getAttribute('data-inspector')).toBe('open')
        expect(await home.isVisible()).toBe(false)
        expect(await settings.count()).toBe(0)
      }
      const place = async () => {
        const control = page.locator('.shell-layout-switch:visible')
        expect(await control.count()).toBe(1)
        const box = await control.boundingBox()
        if (!box) throw new Error('The layout switch is not drawn')
        return box
      }
      const places: Array<{ x: number; y: number; width: number; height: number }> = [await place()]
      await nowhere()
      const retainedTranscript = await transcript.elementHandle()
      if (!retainedTranscript) throw new Error('The conversation has no transcript')
      await generalSettings(page)
      await sameComposer()
      expect(await retainedTranscript.evaluate(element => element.isConnected)).toBe(true)
      expect(Math.abs((await retainedTranscript.evaluate(element => element.scrollTop)) - reading)).toBeLessThanOrEqual(2)
      await closeSettings(settings)
      await sameSession()
      expect(await transcript.evaluate((element, retained) => element === retained, retainedTranscript)).toBe(true)
      // The key, from the input: the same input keeps the focus and its text.
      await input.focus()
      await page.keyboard.press('Alt+Shift+L')
      await expect.poll(() => shell.getAttribute('data-workbench-layout')).toBe('triage')
      await still()
      if (fades) expect(await marked()).toBe(1)
      await sameSession()
      expect(await original.evaluate(element => element === document.activeElement)).toBe(true)
      places.push(await place())
      await nowhere()
      // The switch itself: the chosen segment keeps the focus.
      await layoutMenu(page, 'overview')
      await still()
      if (fades) expect(await marked()).toBe(2)
      await sameSession()
      await layoutMenu(page, 'triage')
      await still()
      if (fades) expect(await marked()).toBe(3)
      await sameSession()
      // The palette's command names the layout it leads to.
      await choose(page, '切换到侧栏布局')
      await expect.poll(() => shell.getAttribute('data-workbench-layout')).toBe('overview')
      await still()
      await sameSession()
      await choose(page, '切换到顶栏布局')
      await expect.poll(() => shell.getAttribute('data-workbench-layout')).toBe('triage')
      await still()
      await sameSession()
      // Reduced motion: the layout changes at once, with no transition to mark.
      const marksBefore = await marked()
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await layoutMenu(page, 'overview')
      await layoutMenu(page, 'triage')
      expect(await marked()).toBe(marksBefore)
      await sameSession()
      await page.emulateMedia({ reducedMotion: 'no-preference' })

      // 新会话 is the home with its input focused; the session stays open under it, and its row leads back.
      await input.focus()
      await page.keyboard.press('Alt+n')
      await home.waitFor({ state: 'visible' })
      await expect.poll(() => homeInput.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await page.locator('.new-session, .new-session-sheet').count()).toBe(0)
      expect(await page.locator('main.workspace').getAttribute('inert')).toBe('')
      await sameComposer()
      expect(await home.getAttribute('aria-label')).toBe('总览')
      places.push(await place())
      await nowhere()
      await homeInput.fill('首页自己的新任务草稿')
      await sameComposer()
      await returnFromHomeFocus(page)
      // Home stays home, with its own draft, in either layout.
      await layoutMenu(page, 'overview')
      await still()
      expect(await home.isVisible()).toBe(true)
      expect(await home.getAttribute('aria-label')).toBe('总览')
      expect(await homeInput.inputValue()).toBe('首页自己的新任务草稿')
      // The home is a place of its own: 返回 from settings finds it again, over the same session.
      await layoutSwitch(page).getByRole('radio', { name: LAYOUT_NAMES.overview, exact: true }).focus()
      await page.keyboard.press('Alt+,')
      await page.locator('.settings-page').waitFor({ state: 'visible' })
      await closeSettings(settings)
      await home.waitFor({ state: 'visible' })
      expect(await page.locator('main.workspace').getAttribute('inert')).toBe('')
      await sameComposer()
      places.push(await place())
      await nowhere()
      const row = page.locator(`.sidebar [data-task-id="${recent.summary.id}"]`).filter({ visible: true })
      expect(await row.getAttribute('aria-current')).not.toBeNull()
      await row.click()
      await home.waitFor({ state: 'hidden' })
      await sameSession()
      await layoutMenu(page, 'triage')
      await openHome(page)
      expect(await homeInput.inputValue()).toBe('首页自己的新任务草稿')
      await sameComposer()

      // Settings can change the layout without replacing the current workbench or its forms.
      await generalSettings(page)
      const tiles = settings.getByRole('radiogroup', { name: '工作台布局', exact: true })
      places.push(await place())
      await nowhere()
      for (const layout of ['overview', 'triage', 'overview'] as const) {
        const tile = tiles.getByRole('radio', { name: new RegExp(`^${LAYOUT_NAMES[layout]}`, 'u') })
        await tile.click()
        await expect.poll(() => shell.getAttribute('data-workbench-layout')).toBe(layout)
        await still()
        expect(await settings.isVisible()).toBe(true)
        await expect.poll(() => tile.getAttribute('aria-checked')).toBe('true')
        places.push(await place())
        await nowhere()
      }
      await closeSettings(settings)
      await page.keyboard.press('Alt+Shift+L')
      await expect.poll(() => shell.getAttribute('data-workbench-layout')).toBe('triage')
      await still()
      await page.keyboard.press('Alt+/')
      const overlay = page.getByRole('dialog', { name: '快捷键', exact: true })
      await overlay.waitFor()
      expect(await overlay.locator('.shortcuts-overlay-row', { hasText: '切换侧栏、顶栏布局' }).count()).toBe(1)
      expect(await overlay.locator('.shortcuts-overlay-row', { hasText: '顶栏布局：拒绝、允许聚焦的请求' }).count()).toBe(1)
      await page.keyboard.press('Escape')
      await overlay.waitFor({ state: 'hidden' })
      await openHome(page)
      // One place for the switch: the end of the window's top row, whatever the layout and the page.
      for (const box of places)
        for (const side of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(box[side] - places[0]![side])).toBeLessThanOrEqual(1)
      expect(places[0]!.x + places[0]!.width).toBeGreaterThan(1440 - 24)
      expect(places[0]!.y).toBeLessThan(52)
      expect(writes).toEqual([])
      expect(await home.locator('[data-group="attention"]').textContent()).toContain(waiting.summary.title)
      expect(await home.locator('[data-group="attention"]').textContent()).toContain(failed.summary.title)
      expect(await home.locator('[data-group="running"]').textContent()).toContain(running.summary.title)
      expect(await home.locator('[data-group="delivery"]').textContent()).not.toContain(recent.summary.title)
      const resume = home.getByRole('region', { name: '接着做', exact: true })
      const recentRow = resume.getByRole('button', { name: new RegExp(recent.summary.title, 'u') })
      expect(await recentRow.textContent()).toContain(project.name)
      expect(await resume.textContent()).not.toContain(waiting.summary.title)
      expect(await resume.textContent()).not.toContain(running.summary.title)
      await recentRow.click()
      await sameComposer()
      await layoutMenu(page, 'overview')
      await sameComposer()
      // A retained desktop conversation must not cover the phone's navigation while its overview is in front.
      for (const [label, entry] of [
        ['Code', 'sessions'],
        ['我的 Agent', 'agents'],
        ['设置', 'settings'],
      ] as const) {
        await choose(page, recent.summary.title)
        await openHome(page)
        await page.setViewportSize({ width: 390, height: 900 })
        await settleShell(page)
        const navigation = page.getByRole('navigation', { name: '主导航', exact: true })
        for (const name of ['Code', '我的 Agent', '设置']) {
          await reachable(navigation.getByRole('button', { name, exact: true }))
        }
        await navigation.getByRole('button', { name: label, exact: true }).click()
        if (entry === 'settings') {
          await page.locator('.settings-overlay:modal').waitFor()
          expect(await page.locator('.app-shell').getAttribute('data-entry')).toBe('sessions')
          expect(await home.isVisible()).toBe(true)
          await closeSettings(settings)
          await reachable(navigation.getByRole('button', { name: '设置', exact: true }))
        } else {
          await expect.poll(() => page.locator('.app-shell').getAttribute('data-entry')).toBe(entry)
          await expect.poll(() => home.isVisible()).toBe(entry === 'sessions')
        }
        if (entry === 'sessions') {
          await reachable(page.getByRole('button', { name: '全部会话', exact: true }))
          expect(await page.locator('main.workspace').getAttribute('inert')).toBe('')
        }
        await page.setViewportSize({ width: 1440, height: 1000 })
        await settleShell(page)
      }
      await choose(page, recent.summary.title)
      expect(await input.inputValue()).toBe(draft)
      await generalSettings(page)
      const layouts = page.getByRole('radiogroup', { name: '工作台布局', exact: true })
      // Each tile is named by its layout and what it sorts by: 「侧栏 按项目」 and 「顶栏 按状态」.
      expect(await layouts.locator('.ui-tile-choice-label').allTextContents()).toEqual(['侧栏', '顶栏'])
      expect(await layouts.locator('.ui-tile-choice-note').allTextContents()).toEqual(['按项目', '按状态'])
      await layouts.getByRole('radio', { name: /^侧栏/u }).focus()
      await page.keyboard.press('ArrowRight')
      await expect.poll(() => layouts.getByRole('radio', { name: /^顶栏/u }).getAttribute('aria-checked')).toBe('true')
      expect(await layouts.getByRole('radio', { name: /^顶栏/u }).evaluate(element => element === document.activeElement)).toBe(true)
      await page.reload()
      await connected(page)
      expect(await page.locator('.app-shell').getAttribute('data-workbench-layout')).toBe('triage')
      await choose(page, recent.summary.title)
      await expect.poll(() => input.inputValue()).toBe(draft)
      // A reload while the home covers a session finds the home again, the session still open under it.
      await openHome(page)
      await page.reload()
      await connected(page)
      await home.waitFor({ state: 'visible' })
      expect(await page.locator('main.workspace').getAttribute('inert')).toBe('')
      await expect.poll(() => input.inputValue()).toBe(draft)
      expect(await homeInput.inputValue()).toBe('首页自己的新任务草稿')
      // And a reload on the session itself stays on the session.
      await choose(page, recent.summary.title)
      await page.reload()
      await connected(page)
      await page.locator('main.workspace').waitFor({ state: 'visible' })
      expect(await home.count()).toBe(0)
      await choose(page, waiting.summary.title)
      const approval = page.locator(`[data-approval-id="${waiting.approvals[0].id}"]`)
      await expect.poll(() => approval.getByRole('button', { name: '拒绝', exact: true }).isEnabled()).toBe(true)
      await reachable(approval.getByRole('button', { name: '拒绝', exact: true }))
      const risk = await approval.getAttribute('data-risk')
      expect(risk).not.toBeNull()
      await watchLayout()
      for (const layout of ['overview', 'triage'] as const) {
        await layoutMenu(page, layout)
        await reachable(approval.getByRole('button', { name: '拒绝', exact: true }))
        expect(await approval.getAttribute('data-risk')).toBe(risk)
      }
      expect(await marked()).toBe(0)
      await openHome(page)
      await page.keyboard.press('Escape')
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())))
      expect((await owner.json<TaskDetail>(`tasks/${waiting.summary.id}`)).approvals.map(item => item.id)).toEqual(
        waiting.approvals.map(item => item.id),
      )
      expect(toolExecutions).toBe(0)
      await choose(page, waiting.summary.title)
      await expect.poll(() => approval.getByRole('button', { name: '允许', exact: true }).isEnabled()).toBe(true)
      await reachable(approval.getByRole('button', { name: '允许', exact: true }))
      expect(writes).toEqual([])
    } finally {
      await context.close()
    }

    for (const width of [320, 390, 768, 1024, 1440]) {
      const screenshotContext = await visualContext(browser, {
        name: width < 768 ? 'phone' : width < 1024 ? 'tablet' : 'desktop',
        width,
        height: width < 768 ? 900 : 1000,
        touch: width <= 768,
      })
      try {
        const page = await screenshotContext.newPage()
        await enrollBrowser(page, host, { name: `布局截图 ${width}`, scopes: ['view', 'run'] })
        expect(await page.locator('.app-shell').getAttribute('data-workbench-layout')).toBe('overview')
        for (const theme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: theme })
          await openHome(page)
          const canvasByLayout = []
          for (const layout of ['overview', 'triage'] as const) {
            await layoutMenu(page, layout)
            const home = page.locator('.workbench-home')
            await reachable(home.locator(`[data-work-session="${waiting.summary.id}"]`))
            // A failure is titled by what the person does, the verb then the session; the bare word 失败 is not its title.
            expect(await home.locator(`[data-request-session="${failed.summary.id}"] .work-decision-verb`).first().textContent()).toMatch(
              /^(重试|查看)$/u,
            )
            expect(await home.locator(`[data-request-session="${failed.summary.id}"] strong`).allTextContents()).not.toContain('失败')
            if (width === 390 && theme === 'light' && layout === 'overview') {
              const edge = home.locator(`[data-work-session="${running.summary.id}"] .ui-running-edge`)
              const state = () => edge.locator('i').evaluate(element => getComputedStyle(element).animationPlayState)
              await page.setViewportSize({ width, height: 440 })
              await expect.poll(state).toBe('paused')
              await edge.scrollIntoViewIfNeeded()
              await expect.poll(state).toBe('running')
              await page.setViewportSize({ width, height: 900 })
              await home.locator('.code-home-queue').evaluate(element => (element.scrollTop = 0))
            }
            if (width === 1440) {
              const runningEdge = home.locator(`[data-work-session="${running.summary.id}"] .ui-running-edge > i`)
              await runningEdge.waitFor()
              expect(await runningEdge.evaluate(element => getComputedStyle(element).animationName)).toBe('ui-run-edge')
              expect(await home.locator(`[data-work-session="${waiting.summary.id}"] .ui-running-edge`).count()).toBe(0)
              await page.emulateMedia({ reducedMotion: 'reduce' })
              expect(await runningEdge.evaluate(element => getComputedStyle(element).display)).toBe('none')
              await page.emulateMedia({ reducedMotion: 'no-preference' })
              // The risk line stays one row: the red reason, the short fact and its ⓘ.
              const clause = home.locator('.approval-clause').first()
              expect(await clause.textContent()).toContain('每次都要确认')
              expect((await clause.boundingBox())!.height).toBeLessThan(32)
            }
            await capture(page, layout, width, theme)
            await noHorizontalOverflow(page, home)
            const canvas = await paintedBackground(home)
            canvasByLayout.push(canvas)
            expect(await paintedBackground(home.locator('.composer').first())).not.toBe(canvas)
            const approval = home.locator('.approval-panel').first()
            const reviewSurface =
              (await approval.getAttribute('data-document-review')) === null ? approval : approval.locator('.approval-preview')
            expect(await paintedBackground(reviewSurface)).not.toBe(canvas)
            if (layout === 'overview' && width >= 768) {
              const navigation = page
                .locator(width >= 1024 ? '.sidebar' : '.workbench-tablet-rail')
                .locator('visible=true')
                .first()
              expect(await paintedBackground(navigation)).not.toBe(canvas)
            }
            if (width < 768) {
              // Touch targets: each segment of the layout switch and the input's two buttons answer 44px around their middle.
              const hits = await page.evaluate(() =>
                [
                  ...document.querySelectorAll<HTMLElement>(
                    '.workbench-home .layout-switch [role="radio"], .workbench-home .composer-line button',
                  ),
                ]
                  .filter(element => element.checkVisibility({ visibilityProperty: true }))
                  .map(element => {
                    const box = element.getBoundingClientRect()
                    const [x, y] = [box.left + box.width / 2, box.top + box.height / 2]
                    const hit = (dx: number, dy: number) => {
                      const found = document.elementFromPoint(x + dx, y + dy)
                      return found !== null && (found === element || element.contains(found))
                    }
                    return {
                      name: element.getAttribute('aria-label') ?? element.textContent,
                      ok: hit(0, -21) && hit(0, 21) && hit(-21, 0) && hit(21, 0),
                    }
                  }),
              )
              expect(hits.length).toBeGreaterThanOrEqual(4)
              expect(hits.filter(item => !item.ok)).toEqual([])
              // The session page at this width does not scroll sideways either.
              await choose(page, running.summary.title)
              await page.locator('main.workspace .composer-line').waitFor({ state: 'visible' })
              await noHorizontalOverflow(page)
              await capture(page, `${layout}-session`, width, theme)
              await backToPhoneSessions(page)
              await settleShell(page)
              await openHome(page)
            }
            const resume = home.getByRole('region', { name: '接着做', exact: true })
            await reachable(resume.getByRole('button', { name: new RegExp(recent.summary.title, 'u') }))
            if (width < 768 && layout === 'triage') {
              await home.getByRole('button', { name: '可交付', exact: true }).click()
              expect(await home.locator('[data-group="delivery"]').textContent()).not.toContain('没有可交付的')
              await capture(page, 'triage-delivery-empty', width, theme)
              await home.getByRole('button', { name: '等你处理 2', exact: true }).click()
            }
            if (width === 768 && theme === 'light' && layout === 'overview') {
              // Settings has its own centered two-column surface. The rail stays where it was and cannot take focus through it.
              const rail = page.locator('.workbench-tablet-rail')
              const before = await rail.boundingBox()
              await generalSettings(page)
              await settleShell(page)
              const panel = page.locator('.settings-overlay:modal')
              const categories = panel.locator('.settings-nav-pane')
              expect((await panel.boundingBox())!.x).toBeGreaterThan(0)
              expect(Math.round((await categories.boundingBox())!.width)).toBe(200)
              expect(await rail.boundingBox()).toEqual(before)
              expect(
                await rail
                  .locator('button')
                  .first()
                  .evaluate(button => {
                    button.focus()
                    return button === document.activeElement
                  }),
              ).toBe(false)
              await closeSettings(page.locator('.settings-page'))
              await openHome(page)
            }
            if (width === 768 && theme === 'light' && layout === 'triage') {
              // 顶栏 has no session list over its home: with nothing open under it the key opens nothing unseen.
              await page.keyboard.press('Alt+b')
              await page.waitForTimeout(300)
              expect(await page.locator('.sidebar.is-open').count()).toBe(0)
              expect(await page.locator('.titlebar').getAttribute('inert')).toBeNull()
              // With a session open the key leaves the home for it and slides the list over it.
              await choose(page, waiting.summary.title)
              await page.keyboard.press('Alt+b')
              await page.locator('.sidebar.is-open').waitFor({ state: 'visible' })
              await reachable(
                page.getByRole('dialog', { name: '会话导航', exact: true }).getByRole('button', { name: '关闭会话列表', exact: true }),
              )
              await capture(page, 'triage-drawer', width, theme)
              await page.keyboard.press('Escape')
              await openHome(page)
            }
            if (width === 1440) {
              await choose(page, waiting.summary.title)
              const shell = page.locator('.app-shell')
              if ((layout === 'overview') !== ((await shell.getAttribute('data-inspector')) === 'open'))
                await page.keyboard.press('Alt+Shift+b')
              await expect.poll(() => shell.getAttribute('data-inspector')).toBe(layout === 'overview' ? 'open' : null)
              const close = page.locator('.inspector-column .session-panel-strip').getByRole('button', { name: '关闭', exact: true })
              if (layout === 'overview') {
                const tabs = page.locator('.inspector-column .ui-panel-tab-list')
                await reachable(close)
                await reachable(layoutSwitch(page).getByRole('radio', { checked: true }))
                const [tabsRight, closeRight, switchLeft] = await Promise.all([
                  tabs.evaluate(element => element.getBoundingClientRect().right),
                  close.evaluate(element => element.getBoundingClientRect().right),
                  layoutSwitch(page).evaluate(element => element.getBoundingClientRect().left),
                ])
                expect(tabsRight).toBeLessThan(switchLeft)
                expect(closeRight).toBeLessThan(switchLeft)
                const changes = page.locator('.session-overview-section').first()
                expect(await changes.textContent()).toContain('这台设备不能读取项目改动')
                expect(await changes.locator('.ui-count').count()).toBe(0)
              }
              await capture(page, `${layout}-session`, width, theme)
              if (layout === 'overview') {
                await close.click()
                await expect.poll(() => shell.getAttribute('data-inspector')).toBeNull()
              }
              await openHome(page)
            }
          }
          await generalSettings(page)
          const layouts = page.getByRole('radiogroup', { name: '工作台布局', exact: true })
          for (const name of Object.values(LAYOUT_NAMES)) await reachable(layouts.getByRole('radio', { name: new RegExp(`^${name}`, 'u') }))
          expect(await layouts.getByRole('radio', { name: /^顶栏/u }).getAttribute('aria-checked')).toBe('true')
          expect(await page.evaluate(() => document.body.innerText)).not.toContain('分拣台')
          await noHorizontalOverflow(page, layouts)
          for (const layout of ['triage', 'overview'] as const) {
            if (layout === 'overview') {
              await layouts.getByRole('radio', { name: /^侧栏/u }).click()
              await expect.poll(() => page.locator('.app-shell').getAttribute('data-workbench-layout')).toBe(layout)
            }
            await capture(page, `${layout}-settings`, width, theme)
            const settings = page.locator('.settings-page')
            const canvas = canvasByLayout[0]
            expect(canvasByLayout).toEqual([canvas, canvas])
            const settingsNav = await paintedBackground(settings.locator('.settings-nav-pane'))
            if (width < 768) expect(settingsNav).toBe(canvas)
            else expect(settingsNav).not.toBe(canvas)
            if (width >= 768) {
              const lead = page.locator('.titlebar-lead:visible, .workbench-nav:visible, .workbench-tablet-rail:visible').first()
              expect(await paintedBackground(lead)).toBe(canvas)
            }
            const previews = layouts.locator('.layout-preview')
            const [side, top] = [previews.first(), previews.last()]
            expect(await paintedBackground(side)).toBe(canvas)
            expect(await paintedBackground(top)).toBe(canvas)
            expect(await paintedBackground(side.locator('.layout-preview-rail'))).toBe(canvas)
            expect(await paintedBackground(top.locator('.layout-preview-rail'))).toBe(canvas)
            const previewInput = await paintedBackground(side.locator('.layout-preview-input'))
            expect(previewInput).not.toBe(canvas)
            expect(await paintedBackground(top.locator('.layout-preview-input'))).toBe(previewInput)
          }
          await closeSettings(page.locator('.settings-page'))
        }
      } finally {
        await screenshotContext.close()
      }
    }
    expect(calls).toBe(callsBefore)
    // A choice saved under the old key still opens its layout, under the new name.
    const storedContext = await visualContext(browser, { name: 'desktop', width: 1440, height: 1000, touch: false })
    try {
      await storedContext.addInitScript(() => {
        if (localStorage.getItem('latch.preferences') === null) localStorage.setItem('latch.preferences', '{"workbenchLayout":"triage"}')
      })
      const page = await storedContext.newPage()
      await enrollBrowser(page, host, { name: '已存布局验收', scopes: ['view', 'run'] })
      expect(await page.locator('.app-shell').getAttribute('data-workbench-layout')).toBe('triage')
      expect(await layoutSwitch(page).getByRole('radio', { name: '顶栏', exact: true }).getAttribute('aria-checked')).toBe('true')
      expect(await page.locator('.workbench-nav, .workbench-primary-nav').first().isVisible()).toBe(true)
      expect(await page.evaluate(() => document.body.innerText)).not.toContain('分拣台')
    } finally {
      await storedContext.close()
    }
    const approvalContext = await visualContext(browser, { name: 'desktop', width: 1440, height: 1000, touch: false })
    try {
      const page = await approvalContext.newPage()
      await enrollBrowser(page, host, { name: '恢复审批验收', scopes: ['view', 'run', 'approve:elevated'] })
      await choose(page, waiting.summary.title)
      const approval = page.locator(`[data-approval-id="${waiting.approvals[0].id}"]`)
      await expect.poll(() => approval.getByRole('button', { name: '允许', exact: true }).isEnabled()).toBe(true)
      await reachable(approval.getByRole('button', { name: '允许', exact: true }))
      await approval.getByRole('button', { name: '允许', exact: true }).click()
      await expect.poll(() => toolExecutions).toBe(1)
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${waiting.summary.id}`)).summary.status).toBe('idle')
    } finally {
      await approvalContext.close()
    }
  } finally {
    for (const id of active) {
      await owner.request(`tasks/${id}/cancel`, { method: 'POST', body: { requestId: randomUUID() } }).catch(() => {})
    }
    for (const release of releases) release()
    await browser.close()
    await host.close()
  }
})
