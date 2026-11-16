import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HarnessPlugin, ModelDelta } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openEntry, openSessions, settleShell } from './helpers/layout.ts'

const OUT = 'test-results/work-panel'

const PROMPTS = {
  done: '修复设置页保存后密钥被清空的问题',
  running: '运行设置页的回归测试',
  waiting: '在提交前检查里加上类型检查',
  failed: '检查发布脚本的签名步骤',
} as const

const write = (path: string, content: string): ModelDelta => ({
  type: 'tool-call',
  call: { id: `write-${randomUUID()}`, name: 'write_file', arguments: { path, content } },
})

/** A model per prompt: done edits a file and answers, running holds until stopped, waiting asks to write, failed errors. */
const fixture: HarnessPlugin = {
  id: 'work-panel-fixture',
  name: 'Fixture',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerProvider({
      id: 'panel',
      name: 'Fixture',
      model: 'fixture',
      async *stream({ messages, signal }) {
        const last = messages.findLastIndex(message => message.role === 'user')
        const prompt = messages[last]?.content
        const answered = messages.slice(last + 1).some(message => message.role === 'tool')
        if (prompt === PROMPTS.failed) throw new Error('模型服务返回错误（HTTP 503）：服务暂时不可用')
        if (prompt === PROMPTS.running) {
          yield { type: 'text', text: '先读一下现有的测试，再运行一次。' }
          // A live fixture reports activity throughout this multi-width suite; an idle stream would correctly become silent.
          while (!signal.aborted) {
            await delay(10_000, undefined, { signal }).catch(() => {})
            signal.throwIfAborted()
            yield { type: 'usage', inputTokens: 12, outputTokens: 8 }
          }
          signal.throwIfAborted()
          return
        }
        if (answered) {
          yield { type: 'text', text: '已修复：省略密钥时保留已保存的值。' }
          yield { type: 'finish', reason: 'stop' }
          return
        }
        yield { type: 'text', text: '先改保存逻辑。' }
        yield prompt === PROMPTS.waiting
          ? write('.husky/pre-commit', 'pnpm lint\npnpm typecheck\n')
          : write('settings.ts', 'export const keep = true\nexport const clear = null\nexport const saved = 1\n')
        yield { type: 'finish', reason: 'tool-calls' }
      },
    })
  },
}

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** The actual v8 work canvas; the previous decorative pseudo-panel is no longer drawn. */
async function canvas(page: Page): Promise<Rect> {
  const shell = page.locator('.app-shell')
  expect(await shell.evaluate(element => getComputedStyle(element, '::before').display)).toBe('none')
  const panel = await page
    .locator('.workbench-home, main.workspace')
    .filter({ visible: true })
    .evaluate(element => {
      const rect = element.getBoundingClientRect()
      return { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom) }
    })
  const window = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(panel.bottom).toBe(window.height)
  expect(panel.left).toBeGreaterThanOrEqual(0)
  expect(panel.right).toBeLessThanOrEqual(window.width)
  expect(panel.right - panel.left).toBeGreaterThanOrEqual(480)
  expect(panel.top).toBe((await shell.getAttribute('data-sidebar')) === 'collapsed' ? 52 : 0)
  await noHorizontalOverflow(page)
  return panel
}

/** Every control of the title row's panel half lies inside the panel and can be hit. */
async function titleRowInside(page: Page, panel: Rect): Promise<void> {
  const controls = page.locator('main.workspace .topbar :is(button, [role="button"])').filter({ visible: true })
  const count = await controls.count()
  for (let index = 0; index < count; index++) {
    const control = controls.nth(index)
    const rect = await control.evaluate(element => element.getBoundingClientRect().toJSON() as Rect)
    expect(rect.left).toBeGreaterThanOrEqual(panel.left)
    expect(rect.right).toBeLessThanOrEqual(panel.right)
    expect(rect.top).toBeGreaterThanOrEqual(panel.top)
    await control.click({ trial: true })
  }
}

describe('the v8 work canvas', () => {
  let host: TestHost
  let browser: Browser
  const sessions = {} as Record<keyof typeof PROMPTS, string>
  const contexts: BrowserContext[] = []

  async function start(prompt: string): Promise<string> {
    const { sessionId } = await host.host.bridge.createTask({
      prompt,
      requestId: randomUUID(),
      mode: 'agent',
      model: { providerId: 'panel', model: 'fixture' },
    })
    return sessionId
  }
  const status = async (id: string) => (await host.host.bridge.detail(id)).summary.status
  /** expect.poll belongs to a test; the sessions are set up before them. */
  async function until(check: () => Promise<boolean> | boolean): Promise<void> {
    const deadline = Date.now() + 20_000
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('the fixture session never reached its state')
      await new Promise(done => setTimeout(done, 50))
    }
  }

  beforeAll(async () => {
    host = await startTestHost({ demo: false, plugins: [fixture] })
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: host.workspaceRoot, stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    await writeFile(join(host.workspaceRoot, 'settings.ts'), 'export const keep = false\nexport const clear = ""\n')
    git('add', '.')
    git('commit', '-q', '-m', 'first')

    sessions.failed = await start(PROMPTS.failed)
    await until(async () => (await status(sessions.failed)) === 'failed')
    sessions.done = await start(PROMPTS.done)
    await until(() => host.host.bridge.approvals().length === 1)
    expect(await host.host.bridge.decide(host.host.bridge.approvals()[0]!.id, 'allow')).toBe(true)
    await until(async () => (await status(sessions.done)) === 'idle')
    sessions.waiting = await start(PROMPTS.waiting)
    await until(async () => (await status(sessions.waiting)) === 'waiting-approval')
    sessions.running = await start(PROMPTS.running)
    await until(async () => (await status(sessions.running)) === 'running')
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUT, { recursive: true })
  })
  afterAll(async () => {
    if (sessions.running) await host?.host.bridge.cancel(sessions.running).catch(() => {})
    for (const context of contexts) await context.close().catch(() => {})
    await browser?.close()
    await host?.close()
  })

  /** A browser with the data scope of the session's folders, which 改动 reads. */
  async function open(width: number, height: number, colorScheme: 'light' | 'dark', reducedMotion: 'reduce' | 'no-preference' = 'reduce') {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', colorScheme, reducedMotion })
    contexts.push(context)
    context.setDefaultTimeout(15_000)
    const page = await context.newPage()
    const name = `面板 ${width} ${colorScheme} ${randomUUID().slice(0, 4)}`
    await enrollBrowser(page, host, { name, scopes: ['admin'] })
    const owner = await host.enroll({ listener: 'unix' })
    const devices = await owner.json<{ devices: Array<{ id: string; name: string }> }>('devices')
    const id = devices.devices.find(item => item.name === name)!.id
    expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    await page.reload()
    await page.locator('.app-shell[data-connection="connected"]').waitFor()
    await settleShell(page)
    expect(await page.getByRole('button', { name: '终端', exact: true }).count()).toBe(0)
    return page
  }

  async function choose(page: Page, id: string): Promise<void> {
    // Under 1024 the list is a sheet over the ground: open it each time, and click once it has slid in.
    if ((page.viewportSize()?.width ?? 0) < 1024) {
      await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
      await page.getByRole('dialog', { name: '会话导航', exact: true }).waitFor()
      await settleShell(page)
    }
    await page.locator(`[data-task-id="${id}"]`).first().click()
    await page.locator('.drawer-backdrop').waitFor({ state: 'detached' })
    await page.locator('.transcript-content').waitFor()
    await page.locator('.transcript .ui-loading').waitFor({ state: 'detached' })
    await settleShell(page)
    expect(await page.getByRole('button', { name: '终端', exact: true }).count()).toBe(0)
  }

  const shot = (page: Page, name: string, width: number, theme: string) =>
    page.screenshot({ path: `${OUT}/${name}--${width}--${theme}.png`, animations: 'disabled', caret: 'hide' })

  for (const layout of ['chat'] as const)
    for (const theme of ['light', 'dark'] as const)
      for (const [width, height] of [
        [768, 1024],
        [1024, 768],
        [1440, 900],
      ] as const)
        it(`${layout} at ${width} in ${theme}: the start screen, live states, sidebar resizing and the right panel`, async () => {
          const page = await open(width, height, theme)
          const desktop = width >= 1024
          const capture = (name: string) => shot(page, `${layout}-${name}`, width, theme)

          // The new session: the panel holds the page under the title row.
          let panel = await canvas(page)
          if (desktop) {
            const sidebar = await page.locator('#session-navigation').evaluate(element => element.getBoundingClientRect().right)
            expect(panel.left).toBe(Math.round(sidebar))
          }
          expect(panel.left).toBe(desktop ? 264 : 60)
          await capture('home')

          // Each state of a session, its title row in the panel.
          for (const state of ['running', 'waiting', 'failed', 'done'] as const) {
            await choose(page, sessions[state])
            panel = await canvas(page)
            await titleRowInside(page, panel)
            await capture(`session-${state}`)
          }
          const title = page.locator('main.workspace .topbar')
          await choose(page, sessions.running)
          await title.locator('.ui-status-word[data-tone="running"]', { hasText: /[0-9]+:[0-9]{2}$/u }).waitFor()
          await choose(page, sessions.waiting)
          await title.locator('.ui-status-word[data-tone="waiting"]', { hasText: '等你处理' }).waitFor()
          await choose(page, sessions.failed)
          await title.locator('.ui-status-word[data-tone="failed"]', { hasText: '失败' }).waitFor()

          // 改动 writes no totals until the page has read them; once the panel has, it does.
          await choose(page, sessions.done)
          const changes = title.getByRole('button', { name: '改动', exact: true })
          expect(await title.locator('.topbar-changes-stat').count()).toBe(0)
          await changes.click()
          await page.locator('.app-shell[data-inspector]').waitFor()
          await settleShell(page)
          await title.locator('.topbar-changes-stat', { hasText: '+3' }).waitFor()
          panel = await canvas(page)
          const placement = await page.locator('.app-shell').getAttribute('data-inspector')
          if (placement === 'open') await titleRowInside(page, panel)
          const inspector = await page
            .locator('.inspector-column-inner')
            .evaluate(element => element.getBoundingClientRect().toJSON() as Rect)
          const window = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
          expect(Math.round(inspector.right)).toBe(window.width)
          expect(Math.round(inspector.bottom)).toBe(window.height)
          expect(Math.round(inspector.top)).toBe(placement === 'sheet' ? 52 : 0)
          if (placement === 'open') expect(Math.round(inspector.left)).toBe(panel.right)
          const close = page.locator('.inspector-column').getByRole('button', { name: '关闭', exact: true })
          await close.click({ trial: true })
          await capture('session-changes')
          if (placement === 'sheet') await close.click()
          else await changes.click()
          await page.locator('.app-shell[data-inspector]').waitFor({ state: 'detached' })
          await settleShell(page)
          await title.locator('.topbar-changes-stat').waitFor()
          await titleRowInside(page, await canvas(page))
          await capture('session-done-totals')

          if (desktop) {
            // Shut: the canvas reaches the window edge and the header keeps the navigation controls reachable.
            await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
            await page.locator('.app-shell[data-sidebar="collapsed"]').waitFor()
            await settleShell(page)
            panel = await canvas(page)
            expect(panel.left).toBe(0)
            for (const control of await page.locator('.titlebar-lead button').filter({ visible: true }).all()) {
              const rect = await control.evaluate(element => element.getBoundingClientRect().toJSON() as Rect)
              expect(rect.left).toBeGreaterThanOrEqual(panel.left)
              expect(rect.top).toBeGreaterThanOrEqual(0)
              expect(rect.bottom).toBeLessThanOrEqual(panel.top)
              await control.click({ trial: true })
            }
            await capture('sidebar-shut')
            await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
            await page.locator('.app-shell[data-sidebar="open"]').waitFor()
            await settleShell(page)

            // Dragged wider: the panel follows the sidebar's edge.
            const handle = (await page.getByRole('separator', { name: '调整侧栏宽度', exact: true }).boundingBox())!
            await page.mouse.move(handle.x + handle.width / 2, handle.y + 200)
            await page.mouse.down()
            await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + 200, { steps: 4 })
            await page.mouse.up()
            await settleShell(page)
            panel = await canvas(page)
            const sidebar = await page.locator('#session-navigation').evaluate(element => element.getBoundingClientRect().right)
            expect(panel.left).toBe(Math.round(sidebar))
            await page.getByRole('separator', { name: '调整侧栏宽度', exact: true }).dblclick()
            await settleShell(page)
          } else {
            // The tablet's list slides over the ground; the panel stays where it is.
            await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
            await page.getByRole('dialog', { name: '会话导航', exact: true }).waitFor()
            await settleShell(page)
            await canvas(page)
            await capture('sidebar-open')
            await page
              .getByRole('dialog', { name: '会话导航', exact: true })
              .getByRole('button', { name: '关闭会话列表', exact: true })
              .click()
            await page.locator('.drawer-backdrop').waitFor({ state: 'detached' })
          }

          // Settings owns both columns and keeps the original canvas under the dialog.
          const beforeSettings = await canvas(page)
          await openEntry(page, '设置')
          const settings = page.locator('.settings-overlay:modal')
          await settings.locator('.settings-content').waitFor()
          await settings.locator('.ui-loading').waitFor({ state: 'detached' })
          await settleShell(page)
          const overlay = await settings.evaluate(element => element.getBoundingClientRect().toJSON() as Rect)
          const nav = await settings.locator('.settings-nav-pane').evaluate(element => element.getBoundingClientRect().right)
          const content = await settings.locator('.settings-panel').evaluate(element => element.getBoundingClientRect().toJSON() as Rect)
          expect(overlay.left).toBeGreaterThan(0)
          expect(overlay.right).toBeLessThan(width)
          expect(overlay.bottom).toBeLessThan(height)
          expect(Math.round(content.left)).toBe(Math.round(nav))
          expect(Math.round(content.right)).toBe(Math.round(overlay.right - 1))
          expect(Math.round(content.bottom)).toBe(Math.round(overlay.bottom - 1))
          await noHorizontalOverflow(page)
          await capture('settings')
          await openSessions(page)
          expect(await canvas(page)).toEqual(beforeSettings)
        })

  it('slides no track with reduced motion, and glides it otherwise', async () => {
    for (const reducedMotion of ['reduce', 'no-preference'] as const) {
      const page = await open(1440, 900, 'light', reducedMotion)
      const transitions = await page.locator('.app-shell').evaluate(shell => ({
        shell: getComputedStyle(shell).transitionDuration,
        workspace: getComputedStyle(shell.querySelector('.workspace')!).transitionDuration,
      }))
      const still = reducedMotion === 'reduce'
      for (const duration of Object.values(transitions)) expect(duration === '0s').toBe(still)
    }
  })

  it('keeps the phone list reachable without a desktop title row or decorative panel', async () => {
    const page = await open(390, 844, 'light')
    expect(await page.locator('.titlebar').count()).toBe(0)
    expect(await page.locator('.app-shell').evaluate(shell => getComputedStyle(shell, '::before').content)).toBe('none')
    await page.locator('.phone-list:not([inert])').waitFor()
    await noHorizontalOverflow(page)
    await shot(page, 'phone-history', 390, 'light')
  })
})
