import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, webkit, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { Device, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'

async function choose(page: Page, title: string) {
  await page.keyboard.press('Meta+k')
  const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
  await palette.getByRole('searchbox').fill(title)
  await palette.getByRole('option', { name: title, exact: true }).click()
  await palette.waitFor({ state: 'hidden' })
}

it.each([
  { name: 'chromium', engine: chromium },
  { name: 'webkit', engine: webkit },
])(
  '$name keeps the conversation, files, attachments and independent home draft through a new submission with an unknown result',
  async ({ engine, name }) => {
    let calls = 0
    const plugin: HarnessPlugin = {
      id: 'home-input',
      name: '首页输入验收',
      version: '1',
      description: 'Local fixture only.',
      activate(context) {
        context.registerProvider({
          id: 'home-model',
          name: '本地验收模型',
          model: 'fixture',
          async *stream() {
            calls++
            yield { type: 'text', text: '工作记录已保留。\n\n'.repeat(80) }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const host = await startTestHost({ demo: false, plugins: [plugin], providerId: 'home-model' })
    const browser = await engine.launch(engine === chromium ? browserLaunchOptions() : undefined)
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const folder = join(host.root, 'home-project')
      await mkdir(folder)
      await writeFile(join(folder, 'home-reading.txt'), '文件预览在总览背后保留。')
      const added = await owner.addFolders({ name: '首页项目', paths: [folder] })
      const { workspace } = (await added.json()) as { workspace: { id: string } }
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          prompt: '原会话',
          workspaceId: workspace.id,
          model: { providerId: 'home-model', model: 'fixture' },
        },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
      await owner.json(`tasks/${sessionId}`, { method: 'PATCH', body: { title: '原会话' } })
      await enrollBrowser(page, host, { name: '输入目标验收', scopes: ['admin'] })
      const { devices } = await owner.json<{ devices: Device[] }>('devices')
      const device = devices.find(item => item.name === '输入目标验收')!
      await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
      await page.reload()
      await connected(page)
      await expect.poll(() => page.locator('.workbench-home textarea').evaluate(element => element === document.activeElement)).toBe(true)
      let releaseDetail!: () => void
      const detailGate = new Promise<void>(resolve => {
        releaseDetail = resolve
      })
      await page.route(`**/link/api/tasks/${sessionId}`, async route => {
        await detailGate
        await route.continue()
      })
      await choose(page, '原会话')
      const input = page.locator('.workspace textarea').first()
      await input.fill('只属于原会话的草稿')
      releaseDetail()
      await page.locator('.transcript').getByText('工作记录已保留。', { exact: true }).first().waitFor()
      expect(await input.inputValue()).toBe('只属于原会话的草稿')
      await page.unroute(`**/link/api/tasks/${sessionId}`)
      await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
      await page.locator('.titlebar').getByRole('button', { name: '新建会话', exact: true }).click({ trial: true })
      await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
      expect(await input.inputValue()).toBe('只属于原会话的草稿')
      await page
        .locator('.workspace')
        .getByLabel('选择附件', { exact: true })
        .setInputFiles({ name: 'session.txt', mimeType: 'text/plain', buffer: Buffer.from('session attachment') })
      await expect.poll(() => page.locator('.workspace').getByRole('button', { name: 'session.txt', exact: true }).isEnabled()).toBe(true)
      await page.keyboard.press('Alt+p')
      const files = page.getByRole('dialog', { name: '搜索文件', exact: true })
      await files.getByRole('searchbox').fill('home-reading.txt')
      await files.getByRole('option', { name: 'home-reading.txt', exact: true }).click()
      const preview = page.getByRole('region', { name: '文件预览', exact: true })
      await preview.getByText('文件预览在总览背后保留。', { exact: true }).waitFor()
      await preview.getByRole('button', { name: '编辑', exact: true }).click()
      const edit = page.getByLabel('home-reading.txt 的内容', { exact: true })
      await edit.fill('尚未保存的原会话编辑。')
      const transcript = page.locator('.transcript').first()
      await transcript.hover()
      const bottom = await transcript.evaluate(element => element.scrollTop)
      await page.mouse.wheel(0, -1500)
      await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeLessThan(bottom)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const position = await transcript.evaluate(element => element.scrollTop)
      const mounted = await transcript.elementHandle()
      await page.locator('.sidebar [data-space-primary]').click()
      const home = page.locator('.workbench-home')
      const draft = home.getByRole('textbox', { name: '新会话消息', exact: true })
      expect(await draft.inputValue()).toBe('')
      await draft.fill('只属于首页的新任务')
      await home
        .getByLabel('选择附件', { exact: true })
        .setInputFiles({ name: 'home.txt', mimeType: 'text/plain', buffer: Buffer.from('home attachment') })
      await expect.poll(() => home.getByRole('button', { name: 'home.txt', exact: true }).isEnabled()).toBe(true)
      expect(await home.getByRole('button', { name: 'session.txt', exact: true }).count()).toBe(0)
      // 新建会话 is the home with its input focused: the reading session stays open under it, so its unsaved edit is
      // not asked about, and the home keeps its route, draft and attachment target.
      await home.getByRole('button', { name: 'home.txt', exact: true }).focus()
      await page.locator('.sidebar').getByRole('button', { name: '新建会话', exact: true }).click()
      await expect.poll(() => draft.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await page.getByRole('dialog', { name: '放弃你的修改？', exact: true }).count()).toBe(0)
      expect(await home.isVisible()).toBe(true)
      expect(await page.locator('main.workspace').getAttribute('inert')).toBe('')
      expect(await mounted!.evaluate(element => element.isConnected)).toBe(true)
      expect(await draft.inputValue()).toBe('只属于首页的新任务')
      expect(await home.getByRole('button', { name: 'home.txt', exact: true }).isEnabled()).toBe(true)
      await page.setViewportSize({ width: 390, height: 844 })
      await home.locator('.workbench-phone-heading').waitFor()
      // A phone has no sheet for a new session: the key leads to the same home input, with what it already holds.
      await home.getByRole('button', { name: 'home.txt', exact: true }).focus()
      await page.keyboard.press('Alt+n')
      await expect.poll(() => draft.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await page.getByRole('dialog', { name: '新会话', exact: true }).count()).toBe(0)
      expect(await page.getByRole('button', { name: '新会话选项', exact: true }).count()).toBe(0)
      expect(await draft.inputValue()).toBe('只属于首页的新任务')
      expect(await home.getByRole('button', { name: 'home.txt', exact: true }).isEnabled()).toBe(true)
      expect(await home.getByRole('button', { name: 'session.txt', exact: true }).count()).toBe(0)
      expect(await page.getByRole('dialog', { name: '放弃你的修改？', exact: true }).count()).toBe(0)
      // The phone's input is one row of chips over ＋, the text and send.
      const chips = home.getByRole('group', { name: '会话选项', exact: true })
      expect(await chips.evaluate(element => element.classList.contains('composer-chips'))).toBe(true)
      for (const name of [/^(?:项目：|不选项目)/u, /^Harness：/u]) expect(await chips.getByRole('button', { name }).count()).toBe(1)
      expect(await home.locator('.composer-line textarea').count()).toBe(1)
      expect(await home.locator('.composer-line .send-button').getAttribute('aria-label')).toBe('发送')
      expect(await home.isVisible()).toBe(true)
      await page.setViewportSize({ width: 1440, height: 1000 })
      // The session under the home is still the current row; it leads back.
      await page.locator(`.sidebar [data-task-id="${sessionId}"]`).filter({ visible: true }).click()
      expect(await input.inputValue()).toBe('只属于原会话的草稿')
      expect(await mounted!.evaluate(element => element.isConnected)).toBe(true)
      expect(await transcript.evaluate(element => element.scrollTop)).toBe(position)
      expect(await edit.isVisible()).toBe(true)
      expect(await edit.inputValue()).toBe('尚未保存的原会话编辑。')
      await edit.fill('文件预览在总览背后保留。')
      expect(await page.locator('.workspace').getByRole('button', { name: 'session.txt', exact: true }).isEnabled()).toBe(true)
      expect(await page.locator('.workspace').getByRole('button', { name: 'home.txt', exact: true }).count()).toBe(0)
      await page.locator('.sidebar [data-space-primary]').click()
      expect(await draft.inputValue()).toBe('只属于首页的新任务')
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 })
        // A phone's start screen is pushed over its list: its heading holds the way back and 搜索.
        const navigation = home.locator('.workbench-phone-heading')
        for (const label of ['返回会话列表', '搜索'])
          expect((await navigation.getByRole('button', { name: label, exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
        await navigation.getByRole('button', { name: '搜索', exact: true }).click()
        const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
        await palette.getByRole('searchbox').fill('原会话')
        await page.keyboard.press('Escape')
        expect(await palette.getByRole('searchbox').inputValue()).toBe('')
        await page.keyboard.press('Escape')
        await palette.waitFor({ state: 'hidden' })
        expect(await draft.inputValue()).toBe('只属于首页的新任务')
        await navigation.getByRole('button', { name: '返回会话列表', exact: true }).click()
        const history = page.locator('.phone-list:not([inert])')
        await history.locator(`[data-task-id="${sessionId}"]`).click()
        await page.locator('.workspace .topbar').getByRole('button', { name: '返回会话列表', exact: true }).click()
        await history.getByRole('button', { name: '新建会话', exact: true }).click()
        expect(await draft.inputValue()).toBe('只属于首页的新任务')
        expect(await home.getByRole('button', { name: 'home.txt', exact: true }).isEnabled()).toBe(true)
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
      await home.getByRole('button', { name: /^项目：/u }).click()
      await page.getByRole('menuitemradio', { name: '首页项目', exact: true }).click()
      const requests: Array<{ requestId: string; sessionId?: string; prompt: string; attachmentIds?: string[] }> = []
      await page.route('**/link/api/tasks', async route => {
        if (route.request().method() !== 'POST') return route.continue()
        requests.push(route.request().postDataJSON() as (typeof requests)[number])
        if (requests.length === 1) return route.abort('failed')
        return route.continue()
      })
      await home.getByRole('button', { name: '发送', exact: true }).click()
      const sending = page.locator('main.workspace[data-pending-start]:not([inert])')
      const firstMessage = sending.locator('.transcript .user-bubble').getByText('只属于首页的新任务', { exact: true })
      const pending = sending.locator('.pending-submission')
      const retry = pending.getByRole('button', { name: '重试这次提交', exact: true })
      await firstMessage.waitFor()
      await retry.waitFor()
      expect(await home.isVisible()).toBe(false)
      expect(await sending.locator('form[hidden] textarea').inputValue()).toBe('只属于首页的新任务')
      const [request] = requests
      expect(request).toMatchObject({ requestId: expect.any(String), prompt: '只属于首页的新任务' })
      expect(request!.sessionId).toBeUndefined()
      expect(request!.attachmentIds).toHaveLength(1)
      expect(await sending.getAttribute('data-pending-start')).toBe(request!.requestId)
      expect(await host.host.bridge.listTasks()).toHaveLength(1)
      const pendingBox = await pending.boundingBox()
      const messageBox = await firstMessage.boundingBox()
      expect(pendingBox!.y - (messageBox!.y + messageBox!.height)).toBeGreaterThanOrEqual(8)
      expect(pendingBox!.y + pendingBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
      await retry.click()
      await expect.poll(() => calls).toBe(2)
      expect(requests).toEqual([request, request])
      await sending.waitFor({ state: 'detached' })
      await page.locator('main.workspace:not([inert]) .transcript .user-bubble').getByText('只属于首页的新任务', { exact: true }).waitFor()
      const tasks = await host.host.bridge.listTasks()
      expect(tasks).toHaveLength(2)
      const created = await owner.json<TaskDetail>(`tasks/${tasks.find(task => task.id !== sessionId)!.id}`)
      expect(created.messages.find(message => message.role === 'user')?.attachments?.map(item => item.name)).toEqual(['home.txt'])
      await choose(page, '原会话')
      expect(await input.inputValue()).toBe('只属于原会话的草稿')
      await mkdir('test-results/workbench-input', { recursive: true })
      await page.screenshot({ path: `test-results/workbench-input/restored-session-${name}.png`, animations: 'disabled' })
    } finally {
      await context.close()
      await browser.close()
      await host.close()
    }
  },
)
