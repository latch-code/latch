import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
          await new Promise<void>(done => {
            if (signal.aborted) done()
            signal.addEventListener('abort', () => done(), { once: true })
          })
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

/** The work panel's box, read from the shell's ::before (the panel is drawn there, under the columns). */
async function panelRect(page: Page): Promise<Rect & { radius: string; shadow: string }> {
  return page.locator('.app-shell').evaluate(shell => {
    const panel = getComputedStyle(shell, '::before')
    const box = shell.getBoundingClientRect()
    const columns = getComputedStyle(shell).gridTemplateColumns.split(' ').map(Number.parseFloat)
    const page = shell.getAttribute('data-entry') !== 'sessions'
    const start = page ? 0 : columns[0]!
    const end = page ? box.width : columns[0]! + columns[1]!
    const px = (value: string) => Number.parseFloat(value)
    return {
      left: Math.round(box.left + start + px(panel.marginLeft)),
      top: Math.round(box.top + px(panel.marginTop)),
      right: Math.round(box.left + end - px(panel.marginRight)),
      bottom: Math.round(box.bottom - px(panel.marginBottom)),
      radius: panel.borderTopLeftRadius,
      shadow: panel.boxShadow,
    }
  })
}

/** The panel floats: inset 8 from the window's top, right and bottom, rounded 12, with a shadow, inside the window. */
async function floats(page: Page): Promise<Rect> {
  const panel = await panelRect(page)
  const window = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(panel.radius).toBe('12px')
  expect(panel.shadow).not.toBe('none')
  expect(panel.top).toBe(8)
  expect(panel.bottom).toBe(window.height - 8)
  expect(panel.left).toBeGreaterThanOrEqual(8)
  expect(panel.right).toBeLessThanOrEqual(window.width - 8)
  expect(panel.right).toBeGreaterThan(panel.left)
  await noHorizontalOverflow(page)
  return panel
}

/** Every control of the title row's panel half lies inside the panel and can be hit. */
async function titleRowInside(page: Page, panel: Rect): Promise<void> {
  const controls = page.locator('.titlebar .topbar :is(button, [role="button"])').filter({ visible: true })
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

describe('the work panel on the ground', () => {
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
    return page
  }

  async function choose(page: Page, id: string): Promise<void> {
    const row = page.locator(`[data-task-id="${id}"]`).first()
    // Under 1024 the list is a sheet over the ground: open it each time, and click once it has slid in.
    if ((page.viewportSize()?.width ?? 0) < 1024) {
      await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
      await page.getByRole('dialog', { name: '会话导航', exact: true }).waitFor()
      await settleShell(page)
    }
    await row.click()
    await page.locator('.drawer-backdrop').waitFor({ state: 'detached' })
    await page.locator('.transcript-content').waitFor()
    await page.locator('.transcript .ui-loading').waitFor({ state: 'detached' })
    await settleShell(page)
  }

  const shot = (page: Page, name: string, width: number, theme: string) =>
    page.screenshot({ path: `${OUT}/${name}--${width}--${theme}.png`, animations: 'disabled', caret: 'hide' })

  for (const theme of ['light', 'dark'] as const)
    for (const [width, height] of [
      [768, 1024],
      [1024, 768],
      [1440, 900],
    ] as const)
      it(`floats on the ground at ${width} in ${theme}: sidebar open, shut and dragged, the right panel open`, async () => {
        const page = await open(width, height, theme)
        const desktop = width >= 1024

        // The new session: the panel holds the page under the title row.
        let panel = await floats(page)
        if (desktop) {
          const sidebar = await page.locator('#session-navigation').evaluate(element => element.getBoundingClientRect().right)
          expect(panel.left).toBe(Math.round(sidebar))
        }
        await shot(page, 'new', width, theme)

        // Each state of a session, its title row in the panel.
        for (const state of ['running', 'waiting', 'failed', 'done'] as const) {
          await choose(page, sessions[state])
          panel = await floats(page)
          await titleRowInside(page, panel)
          await shot(page, `session-${state}`, width, theme)
        }
        const title = page.locator('.titlebar .topbar')
        await choose(page, sessions.running)
        await title.locator('.ui-status-word[data-tone="running"]', { hasText: /[0-9]+:[0-9]{2}$/u }).waitFor()
        await choose(page, sessions.waiting)
        await title.locator('.ui-status-word[data-tone="waiting"]', { hasText: '等你处理' }).waitFor()
        await choose(page, sessions.failed)
        await title.locator('.ui-status-word[data-tone="failed"]', { hasText: '失败' }).waitFor()

        // 改动 writes no totals until the page has read them; once the panel has, it does.
        await choose(page, sessions.done)
        const changes = page.getByRole('button', { name: '改动', exact: true })
        expect(await title.locator('.topbar-changes-stat').count()).toBe(0)
        await changes.click()
        await page.locator('.app-shell[data-inspector]').waitFor()
        await settleShell(page)
        await title.locator('.topbar-changes-stat', { hasText: '+3' }).waitFor()
        panel = await floats(page)
        await titleRowInside(page, panel)
        const inspector = await page
          .locator('.inspector-column-inner')
          .evaluate(element => element.getBoundingClientRect().toJSON() as Rect)
        const window = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
        const placement = await page.locator('.app-shell').getAttribute('data-inspector')
        expect(Math.round(inspector.right)).toBe(window.width - 8)
        expect(Math.round(inspector.bottom)).toBe(window.height - 8)
        expect(Math.round(inspector.top)).toBe(placement === 'sheet' ? 60 : 8)
        if (placement === 'open') expect(Math.round(inspector.left)).toBe(panel.right + 8)
        await shot(page, 'session-changes', width, theme)
        await changes.click()
        await page.locator('.app-shell[data-inspector]').waitFor({ state: 'detached' })
        await settleShell(page)
        await title.locator('.topbar-changes-stat').waitFor()
        await shot(page, 'session-done-totals', width, theme)

        if (desktop) {
          // Shut: the panel keeps its inset on the left, and the lead's controls stay in its title row.
          await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
          await page.locator('.app-shell[data-sidebar="collapsed"]').waitFor()
          await settleShell(page)
          panel = await floats(page)
          expect(panel.left).toBe(8)
          for (const control of await page.locator('.titlebar-lead button').filter({ visible: true }).all()) {
            const rect = await control.evaluate(element => element.getBoundingClientRect().toJSON() as Rect)
            expect(rect.left).toBeGreaterThanOrEqual(panel.left)
            expect(rect.top).toBeGreaterThanOrEqual(panel.top)
          }
          await shot(page, 'sidebar-shut', width, theme)
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
          panel = await floats(page)
          const sidebar = await page.locator('#session-navigation').evaluate(element => element.getBoundingClientRect().right)
          expect(panel.left).toBe(Math.round(sidebar))
          await page.getByRole('separator', { name: '调整侧栏宽度', exact: true }).dblclick()
          await settleShell(page)
        } else {
          // The tablet's list slides over the ground; the panel stays where it is.
          await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
          await page.getByRole('dialog', { name: '会话导航', exact: true }).waitFor()
          await settleShell(page)
          await floats(page)
          await shot(page, 'sidebar-open', width, theme)
          await page
            .getByRole('dialog', { name: '会话导航', exact: true })
            .getByRole('button', { name: '关闭会话列表', exact: true })
            .click()
          await page.locator('.drawer-backdrop').waitFor({ state: 'detached' })
        }

        // A page (设置) sits in the same panel, its list on the ground.
        await openEntry(page, '设置')
        await page.locator('.settings-page .settings-content').waitFor()
        await page.locator('.settings-page .ui-loading').waitFor({ state: 'detached' })
        await settleShell(page)
        panel = await floats(page)
        const nav = await page.locator('.settings-nav-pane').evaluate(element => element.getBoundingClientRect().right)
        expect(panel.left).toBe(Math.max(8, Math.round(nav)))
        const content = await page.locator('.settings-panel').evaluate(element => element.getBoundingClientRect().toJSON() as Rect)
        expect(Math.round(content.right)).toBe(panel.right)
        expect(Math.round(content.bottom)).toBe(panel.bottom)
        await shot(page, 'settings', width, theme)
        await openSessions(page)
      })

  it('slides no track with reduced motion, and glides it otherwise', async () => {
    for (const reducedMotion of ['reduce', 'no-preference'] as const) {
      const page = await open(1440, 900, 'light', reducedMotion)
      const transitions = await page.locator('.app-shell').evaluate(shell => ({
        shell: getComputedStyle(shell).transitionDuration,
        panel: getComputedStyle(shell, '::before').transitionDuration,
        workspace: getComputedStyle(shell.querySelector('.workspace')!).transitionDuration,
      }))
      const still = reducedMotion === 'reduce'
      for (const duration of Object.values(transitions)) expect(duration === '0s').toBe(still)
    }
  })

  it('leaves a phone without the panel', async () => {
    const page = await open(390, 844, 'light')
    expect(await page.locator('.titlebar').count()).toBe(0)
    expect(await page.locator('.app-shell').evaluate(shell => getComputedStyle(shell, '::before').content)).toBe('none')
    await shot(page, 'phone-list', 390, 'light')
  })
})
