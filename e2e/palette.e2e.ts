import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium, type Locator, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { TaskDetail, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'
import { startTestHost } from './helpers/host.ts'

const OUTPUT = 'test-results/palette'
const LONG = Array.from({ length: 40 }, (_, line) => `第 ${line} 段说明，这里有一句普通的话用来撑开页面的高度。`).join('\n\n')

it.each([
  [390, 844, 'light', true],
  [390, 844, 'dark', true],
  [768, 1024, 'light', true],
  [768, 1024, 'dark', true],
  [1440, 900, 'light', false],
  [1440, 900, 'dark', false],
] as const)('searches, steps back and finds at %i × %i %s', async (width, height, theme, touch) => {
  let released = false,
    ticking = false
  const plugin: HarnessPlugin = {
    id: 'palette-model',
    name: 'Palette fixture',
    version: '1',
    description: 'Only local test responses.',
    activate(context) {
      context.registerProvider({
        id: 'palette-model',
        name: 'Palette fixture',
        model: 'fixture',
        async *stream({ messages }) {
          const prompt = messages.findLast(message => message.role === 'user')?.content ?? ''
          if (prompt.startsWith('等待批准')) {
            yield { type: 'tool-call', call: { id: randomUUID(), name: 'write_report', arguments: {} } }
            yield { type: 'finish', reason: 'tool-calls' }
          } else if (prompt.startsWith('一直运行')) {
            yield { type: 'text', text: `流式匹配词 开头。\n\n流式匹配词 第二处。\n\n${LONG}` }
            // Each tick makes the open find bar search again.
            while (!released) {
              if (ticking) yield { type: 'text', text: '。' }
              await sleep(16)
            }
            yield { type: 'text', text: '\n\n流式匹配词 结尾。' }
            yield { type: 'finish', reason: 'stop' }
          } else {
            yield { type: 'text', text: `修好了。独特消息词藏在这句话里。\n\n${LONG}\n\n末尾独有词在很长的回答之后。` }
            yield { type: 'finish', reason: 'stop' }
          }
        },
      })
    },
  }
  const host = await startTestHost({ plugins: [plugin] })
  const browser = await chromium.launch(browserLaunchOptions())
  const owner = await host.enroll({ listener: 'unix' })
  const shot = (page: Page, state: string) => page.screenshot({ path: `${OUTPUT}/${state}-${width}-${theme}.png`, animations: 'disabled' })
  try {
    await mkdir(OUTPUT, { recursive: true })
    const source = join(host.root, 'palette-project')
    await mkdir(source)
    await writeFile(join(source, 'providers-独特文件.ts'), 'export {}\n')
    await writeFile(join(source, '通用-说明.md'), '说明\n')
    const added = await owner.addFolders({ name: '面板项目', paths: [source] })
    const project = ((await added.json()) as { workspace: WorkspaceInfo }).workspace
    const start = async (prompt: string, title: string, wait: 'idle' | 'waiting-approval' | 'running') => {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          prompt,
          mode: 'agent',
          workspaceId: project.id,
          model: { providerId: 'palette-model', model: 'fixture' },
          requestId: randomUUID(),
        },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, { timeout: 15_000 }).toBe(wait)
      await owner.json(`tasks/${sessionId}`, { method: 'PATCH', body: { title } })
      return sessionId
    }
    await start('修复密钥', '修复设置页密钥丢失', 'idle')
    const waiting = await start('等待批准 报告', '补充审批的端到端测试', 'waiting-approval')
    const running = await start('一直运行', '升级依赖', 'running')

    const context = await browser.newContext({
      viewport: { width, height },
      colorScheme: theme,
      locale: 'zh-CN',
      reducedMotion: 'reduce',
      ...(touch ? { hasTouch: true, isMobile: true } : {}),
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      await enrollBrowser(page, host, { name: `面板 ${width} ${theme}`, scopes: ['view', 'run', 'approve:standard'] })
      const deviceId = host.host.security.devices.list().find(device => device.name === `面板 ${width} ${theme}`)!.id
      expect((await owner.confirmed(`devices/${deviceId}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
      await page.reload()
      await connected(page)

      const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
      const input = palette.getByRole('searchbox')
      const groupNames = () => palette.locator('.palette-results h3').allTextContents()
      const selectedRow = () => palette.locator('[role="option"][aria-selected="true"]').getAttribute('aria-label')
      // What a key would do while an input method composes, which Playwright's own key presses cannot be.
      const composingKey = (field: Locator, key: string) =>
        field.evaluate((element, key) => {
          element.dispatchEvent(new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true }))
        }, key)
      const statusOf = async (id: string) => (await owner.json<TaskDetail>(`tasks/${id}`)).summary.status
      // The match the count names, out from under the bar and inside the pane.
      const currentMatchShown = () =>
        page.evaluate(() => {
          const range = [...(CSS.highlights.get('latch-find-current') ?? [])][0] as Range | undefined
          const box = range?.getBoundingClientRect()
          const bar = document.querySelector('.find-bar')!.getBoundingClientRect()
          const pane = document.querySelector('.transcript')!.getBoundingClientRect()
          return (
            box !== undefined
            && box.height > 0
            && box.top >= pane.top
            && box.bottom <= pane.bottom
            && (box.top >= bar.bottom || box.right <= bar.left)
          )
        })
      const open = async () => {
        await page.keyboard.press('Meta+k')
        await palette.waitFor()
      }
      await open()
      expect(await groupNames()).toEqual(['最近会话', '命令'])
      expect(await palette.locator('section[aria-label="最近会话"] [role="option"]').count()).toBe(3)
      // A request waits, so the way to it is a command at hand.
      await palette.getByRole('option', { name: '下一个等你处理的请求', exact: true }).waitFor()
      const frame = await palette.locator('.ui-modal-surface').boundingBox()
      expect(frame!.width).toBe(Math.min(576, width - 32))
      expect(frame!.height).toBeLessThanOrEqual(420)
      expect(frame!.y).toBeCloseTo(height * 0.12, 0)
      await noHorizontalOverflow(page, palette)
      await shot(page, 'root')

      // Results and their groups, in the agreed order, with the first row marked for Enter.
      await input.fill('独特')
      await palette.locator('[role="option"]').filter({ hasText: '独特消息词' }).waitFor()
      expect(await groupNames()).toEqual(['在消息中'])
      expect(await palette.locator('[role="option"][aria-selected="true"]').count()).toBe(1)
      await input.fill('快捷')
      if (width >= 768) await palette.getByRole('option', { name: '快捷键', exact: true }).waitFor()

      // A search under way and a search refused are not "nothing matched".
      let answer: () => void = () => {}
      const answered = new Promise<void>(resolve => {
        answer = resolve
      })
      await page.route('**/link/api/search', async route => {
        await answered
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'failed', message: '读取失败' }),
        })
      })
      await input.fill('写入计划')
      await palette.getByText('正在搜索消息…', { exact: true }).waitFor()
      expect(await palette.getByText('没有匹配结果').count()).toBe(0)
      await shot(page, 'searching')
      answer()
      await palette.getByText(/^消息搜索失败/u).waitFor()
      expect(await palette.getByText('消息里没有').count()).toBe(0)
      await shot(page, 'failed')
      await page.unroute('**/link/api/search')
      await input.fill('绝不会出现的词')
      await palette.getByText('消息里没有「绝不会出现的词」', { exact: true }).waitFor()

      // While an input method composes, its keys are its own.
      await composingKey(input, 'Enter')
      await composingKey(input, 'Escape')
      expect(await input.inputValue()).toBe('绝不会出现的词')
      expect(await palette.isVisible()).toBe(true)

      // Esc takes back what was typed, then a level, and only then closes.
      await input.press('Escape')
      expect(await input.inputValue()).toBe('')
      expect(await palette.isVisible()).toBe(true)
      await input.press('Escape')
      await palette.waitFor({ state: 'detached' })

      // Open a session; the palette gives the keys back to its composer.
      await open()
      await input.fill('修复设置页')
      await input.press('Enter')
      await palette.waitFor({ state: 'detached' })
      const draft = page.getByRole('textbox', { name: '继续对话', exact: true })
      await draft.waitFor()
      if (!touch) await expect.poll(() => draft.evaluate(element => element === document.activeElement)).toBe(true)
      await draft.fill('保留的草稿')

      await open()
      await input.fill('独特')
      await palette.getByRole('option', { name: 'providers-独特文件.ts', exact: true }).waitFor()
      await palette.locator('[role="option"]').filter({ hasText: '独特消息词' }).waitFor()
      expect(await groupNames()).toEqual(['文件', '在消息中'])
      await noHorizontalOverflow(page, palette)
      await shot(page, 'typed')

      // A file that answers late goes above the row Enter would open, and Enter still opens that row.
      await input.fill('通用')
      await expect.poll(selectedRow).toBe('通用')
      await palette.getByRole('option', { name: '通用-说明.md', exact: true }).waitFor()
      expect((await groupNames()).slice(0, 2)).toEqual(['文件', '设置'])
      expect(await selectedRow()).toBe('通用')

      await input.fill('修复')
      await palette.getByRole('option', { name: '修复设置页密钥丢失', exact: true }).waitFor()
      await input.fill('设置')
      await palette.getByRole('option', { name: '设置', exact: true }).waitFor()
      await expect.poll(groupNames).toContain('命令')
      await shot(page, 'typed-groups')
      await input.fill('搜索项目')
      await palette.getByRole('option', { name: '搜索项目文件', exact: true }).click()
      const files = page.getByRole('dialog', { name: '搜索文件', exact: true })
      await files.getByRole('option', { name: 'providers-独特文件.ts', exact: true }).waitFor()
      await shot(page, 'files')
      await files.getByRole('searchbox').press('Escape')
      await palette.waitFor()
      expect(await groupNames()).toEqual(['最近会话', '命令'])
      // The keys that opened it put it away.
      await page.keyboard.press('Meta+k')
      await palette.waitFor({ state: 'detached' })
      expect(await draft.inputValue()).toBe('保留的草稿')

      // 打开改动 opens: run again, with the panel showing, it leaves the panel there.
      const openChanges = async () => {
        await open()
        await input.fill('打开改动')
        await input.press('Enter')
        await palette.waitFor({ state: 'detached' })
      }
      await openChanges()
      const changes = page.locator('.changes-panel')
      await changes.waitFor()
      await openChanges()
      await changes.waitFor()
      await page.keyboard.press('Alt+d')
      await changes.waitFor({ state: 'hidden' })

      // The find bar floats: opening it leaves the conversation's lane where it was.
      const content = page.locator('.transcript-content')
      const before = await content.boundingBox()
      await page.keyboard.press('Meta+f')
      const find = page.getByRole('search', { name: '会话内查找' })
      await find.waitFor()
      const query = find.getByRole('searchbox', { name: '查找消息内容' })
      expect(await find.getByRole('status').textContent()).toBe('')
      expect(await content.boundingBox()).toEqual(before)
      const bar = (await find.boundingBox())!
      const pane = (await page.locator('.transcript-shell').boundingBox())!
      expect(bar.width).toBe(Math.min(300, pane.width - 32))
      expect(bar.y - pane.y).toBe(10)
      expect(pane.x + pane.width - (bar.x + bar.width)).toBe(width < 768 ? 16 : 20)
      await query.fill('绝不会出现的词')
      await expect.poll(() => find.getByRole('status').textContent()).toBe('0/0')
      await shot(page, 'find-none')
      await query.fill('独特消息词')
      await expect.poll(() => find.getByRole('status').textContent()).toBe('1/1')
      await expect.poll(currentMatchShown).toBe(true)
      await shot(page, 'find')

      // While an input method composes, Enter does not step and Esc does not close.
      await composingKey(query, 'Enter')
      await composingKey(query, 'Escape')
      expect(await find.isVisible()).toBe(true)
      expect(await query.inputValue()).toBe('独特消息词')

      // The first message sits at the very top, where scrolling cannot bring a match out from under the bar.
      await query.fill('修复密钥')
      await expect.poll(() => find.getByRole('status').textContent()).toBe('1/1')
      await expect.poll(currentMatchShown).toBe(true)
      await shot(page, 'find-top')

      // A match deep inside a tall answer is brought into view, not just the answer's first line.
      const scroller = page.locator('.transcript')
      await query.fill('末尾独有词')
      await expect.poll(() => find.getByRole('status').textContent()).toBe('1/1')
      await expect.poll(currentMatchShown).toBe(true)
      expect(await scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
      // ⌘F with the bar open goes back to its field and selects what is there.
      await draft.focus()
      await page.keyboard.press('Meta+f')
      await expect.poll(() => query.evaluate(element => element === document.activeElement)).toBe(true)
      await expect.poll(() => query.evaluate((element: HTMLInputElement) => element.selectionEnd! - element.selectionStart!)).toBe(5)
      await query.press('Escape')
      await find.waitFor({ state: 'hidden' })

      // A running turn adds text and matches; the reader stays on the match they are on.
      await open()
      await input.fill('升级依赖')
      await input.press('Enter')
      await palette.waitFor({ state: 'detached' })
      await page.locator('.transcript').getByText('流式匹配词 第二处。').waitFor()
      await page.keyboard.press('Meta+f')
      await find.waitFor()
      await query.fill('流式匹配词')
      await expect.poll(() => find.getByRole('status').textContent()).toBe('1/2')
      await query.press('Enter')
      await expect.poll(() => find.getByRole('status').textContent()).toBe('2/2')
      await expect.poll(currentMatchShown).toBe(true)
      await shot(page, 'find-running')

      // A step taken while text keeps arriving still brings its match into view, each time.
      ticking = true
      for (const count of ['1/2', '2/2']) {
        await scroller.evaluate(element => {
          element.scrollTop = element.scrollHeight
        })
        await query.press('Enter')
        await expect.poll(() => find.getByRole('status').textContent()).toBe(count)
        await expect.poll(currentMatchShown).toBe(true)
      }
      // A match appearing in an earlier row takes the ordinal: the count follows, and the reader stays on their match.
      await page
        .locator('.transcript [data-message-id]')
        .first()
        .evaluate(row => {
          row.append('流式匹配词')
        })
      await expect.poll(() => find.getByRole('status').textContent()).toBe('3/3')
      const place = () =>
        page.evaluate(() => (([...(CSS.highlights.get('latch-find-current') ?? [])][0] as Range).startContainer.textContent ?? '').trim())
      expect(await place()).toContain('第二处')
      await page
        .locator('.transcript [data-message-id]')
        .first()
        .evaluate(row => {
          row.lastChild!.remove()
        })
      await expect.poll(() => find.getByRole('status').textContent()).toBe('2/2')
      ticking = false

      // Esc held down, or still falling after the find bar closed, does not stop the run.
      await query.press('Escape')
      await find.waitFor({ state: 'hidden' })
      await draft.focus()
      for (let press = 0; press < 3; press++) await page.keyboard.press('Escape')
      await page.waitForTimeout(600)
      for (let press = 0; press < 3; press++) await page.keyboard.down('Escape')
      await page.keyboard.up('Escape')
      await page.waitForTimeout(300)
      expect(await statusOf(running)).toBe('running')
      // Nor, from the palette, does it refuse the request that is waiting.
      await open()
      await input.fill('补充审批')
      await input.press('Enter')
      await palette.waitFor({ state: 'detached' })
      await page.locator('.approval-panel').first().waitFor()
      await open()
      await input.fill('x')
      for (let press = 0; press < 4; press++) await page.keyboard.press('Escape')
      await palette.waitFor({ state: 'detached' })
      await page.waitForTimeout(300)
      expect(await statusOf(waiting)).toBe('waiting-approval')
      await open()
      await input.fill('升级依赖')
      await input.press('Enter')
      await palette.waitFor({ state: 'detached' })
      await page.locator('.transcript').getByText('流式匹配词 第二处。').waitFor()
      await page.keyboard.press('Meta+f')
      await find.waitFor()
      await query.fill('流式匹配词')
      await expect.poll(() => find.getByRole('status').textContent()).toBe('1/2')
      await query.press('Enter')
      await expect.poll(() => find.getByRole('status').textContent()).toBe('2/2')

      released = true
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${running}`)).summary.status, { timeout: 15_000 }).toBe('idle')
      await expect.poll(() => find.getByRole('status').textContent()).toBe('2/3')
      await query.press('Escape')
      await find.waitFor({ state: 'hidden' })

      // 快捷键 shows this client's keys only. A phone has no such page.
      if (width >= 768) {
        await page.keyboard.press('Alt+/')
        const search = page.getByRole('searchbox', { name: '搜索快捷键', exact: true })
        await search.waitFor()
        const page_ = page.locator('.settings-page')
        expect(await page_.locator('[data-keys="Alt N"] kbd').allTextContents()).toEqual(['Alt', 'N'])
        expect(await page_.locator('[data-keys="⌘N"]').count()).toBe(0)
        await noHorizontalOverflow(page, page_)
        await shot(page, 'shortcuts')
        await search.fill('查找')
        await page_.getByText('在会话中查找', { exact: true }).waitFor()
        expect(await page_.getByText('新会话', { exact: true }).count()).toBe(0)
      }
    } finally {
      await context.close()
    }
  } finally {
    released = true
    await browser.close()
    await host.close()
  }
})
