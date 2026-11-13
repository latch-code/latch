import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { TaskDetail, TaskStatus, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { backToPhoneSessions, closeSettings, noHorizontalOverflow, openSection, reachable, settleShell } from './helpers/layout.ts'
import { VISUAL_TIME, visualContext } from './helpers/visual.ts'

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

async function layoutMenu(page: Page, layout: 'overview' | 'triage'): Promise<void> {
  await page.getByRole('button', { name: '布局', exact: true }).locator('visible=true').first().click()
  await page
    .getByRole('menu', { name: '布局', exact: true })
    .getByRole('menuitemradio', { name: layout === 'overview' ? '总览' : '分拣台', exact: true })
    .click()
  await expect.poll(() => page.locator('.app-shell').getAttribute('data-workbench-layout')).toBe(layout)
  await settleShell(page)
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-layout-trigger'))).toBe(true)
}

async function generalSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '布局', exact: true }).locator('visible=true').first().focus()
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
        if (request.method() === 'POST' && /\/api\/(?:tasks(?:\/[^/]+\/prompt)?|approvals\/[^/]+)$/u.test(new URL(request.url()).pathname))
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
      await layoutMenu(page, 'triage')
      await sameComposer()
      await openHome(page)
      await sameComposer()
      const home = page.locator('.workbench-home')
      const homeInput = home.getByRole('textbox', { name: '新会话消息', exact: true })
      await homeInput.fill('首页自己的新任务草稿')
      await sameComposer()
      await layoutMenu(page, 'overview')
      expect(await homeInput.inputValue()).toBe('首页自己的新任务草稿')
      await layoutMenu(page, 'triage')
      expect(await home.locator('[data-group="attention"]').textContent()).toContain(waiting.summary.title)
      expect(await home.locator('[data-group="attention"]').textContent()).toContain(failed.summary.title)
      expect(await home.locator('[data-group="running"]').textContent()).toContain(running.summary.title)
      expect(await home.locator('[data-group="delivery"]').textContent()).not.toContain(recent.summary.title)
      await choose(page, recent.summary.title)
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
        await expect.poll(() => page.locator('.app-shell').getAttribute('data-entry')).toBe(entry)
        await expect.poll(() => page.locator('.workbench-home').isVisible()).toBe(entry === 'sessions')
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
      await layouts.getByRole('radio', { name: '总览', exact: true }).focus()
      await page.keyboard.press('ArrowRight')
      await expect.poll(() => layouts.getByRole('radio', { name: '分拣台', exact: true }).getAttribute('aria-checked')).toBe('true')
      expect(
        await layouts.getByRole('radio', { name: '分拣台', exact: true }).evaluate(element => element === document.activeElement),
      ).toBe(true)
      await page.reload()
      await connected(page)
      expect(await page.locator('.app-shell').getAttribute('data-workbench-layout')).toBe('triage')
      await choose(page, recent.summary.title)
      await expect.poll(() => input.inputValue()).toBe(draft)
      await choose(page, waiting.summary.title)
      const approval = page.locator(`[data-approval-id="${waiting.approvals[0].id}"]`)
      await expect.poll(() => approval.getByRole('button', { name: '拒绝', exact: true }).isEnabled()).toBe(true)
      await reachable(approval.getByRole('button', { name: '拒绝', exact: true }))
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
          for (const layout of ['overview', 'triage'] as const) {
            await layoutMenu(page, layout)
            const home = page.locator('.workbench-home')
            await reachable(home.locator(`[data-work-session="${waiting.summary.id}"]`))
            expect(await home.locator(`[data-work-session="${failed.summary.id}"]`).textContent()).toContain('失败')
            await capture(page, layout, width, theme)
            await noHorizontalOverflow(page, home)
            expect(await home.locator(`[data-work-session="${recent.summary.id}"]`).count()).toBe(0)
            if (width < 768 && layout === 'triage') {
              await home.getByRole('button', { name: '可交付', exact: true }).click()
              expect(await home.locator('[data-group="delivery"]').textContent()).not.toContain('没有待交付的改动')
              await capture(page, 'triage-delivery-empty', width, theme)
              await home.getByRole('button', { name: '等你处理 2', exact: true }).click()
            }
            if (width === 768 && theme === 'light' && layout === 'triage') {
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
              if (layout === 'overview') {
                const changes = page.locator('.session-overview-section').first()
                expect(await changes.textContent()).toContain('这台设备不能读取项目改动')
                expect(await changes.locator('.ui-count').count()).toBe(0)
              }
              await capture(page, `${layout}-session`, width, theme)
              await openHome(page)
            }
          }
          await generalSettings(page)
          const layouts = page.getByRole('radiogroup', { name: '工作台布局', exact: true })
          for (const name of ['总览', '分拣台']) await reachable(layouts.getByRole('radio', { name, exact: true }))
          expect(await layouts.getByRole('radio', { name: '分拣台', exact: true }).getAttribute('aria-checked')).toBe('true')
          await noHorizontalOverflow(page, layouts)
          await capture(page, 'settings', width, theme)
        }
      } finally {
        await screenshotContext.close()
      }
    }
    expect(calls).toBe(callsBefore)
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
