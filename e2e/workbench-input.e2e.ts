import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from '@playwright/test'
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

it('keeps the conversation, files, attachments and independent home draft through a new submission with an unknown result', async () => {
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
  const browser = await chromium.launch(browserLaunchOptions())
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
    await choose(page, '原会话')
    const input = page.locator('.workspace textarea').first()
    await input.fill('只属于原会话的草稿')
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
    const transcript = page.locator('.transcript').first()
    await transcript.hover()
    const bottom = await transcript.evaluate(element => element.scrollTop)
    await page.mouse.wheel(0, -1500)
    await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeLessThan(bottom)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const position = await transcript.evaluate(element => element.scrollTop)
    const mounted = await transcript.elementHandle()
    await page.getByRole('button', { name: '总览', exact: true }).locator('visible=true').first().click()
    const home = page.locator('.workbench-home')
    const draft = home.getByRole('textbox', { name: '新会话消息', exact: true })
    expect(await draft.inputValue()).toBe('')
    await draft.fill('只属于首页的新任务')
    await home
      .getByLabel('选择附件', { exact: true })
      .setInputFiles({ name: 'home.txt', mimeType: 'text/plain', buffer: Buffer.from('home attachment') })
    await expect.poll(() => home.getByRole('button', { name: 'home.txt', exact: true }).isEnabled()).toBe(true)
    expect(await home.getByRole('button', { name: 'session.txt', exact: true }).count()).toBe(0)
    await page.locator('.titlebar').getByRole('button', { name: '返回会话', exact: true }).click()
    expect(await input.inputValue()).toBe('只属于原会话的草稿')
    expect(await mounted!.evaluate(element => element.isConnected)).toBe(true)
    expect(await transcript.evaluate(element => element.scrollTop)).toBe(position)
    expect(await preview.isVisible()).toBe(true)
    expect(await page.locator('.workspace').getByRole('button', { name: 'session.txt', exact: true }).isEnabled()).toBe(true)
    expect(await page.locator('.workspace').getByRole('button', { name: 'home.txt', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: '总览', exact: true }).locator('visible=true').first().click()
    expect(await draft.inputValue()).toBe('只属于首页的新任务')
    await home.getByRole('button', { name: /^项目：/u }).click()
    await page.getByRole('menuitemradio', { name: '首页项目', exact: true }).click()
    const requests: string[] = []
    let rejected = false
    await page.route('**/link/api/tasks', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      const body = route.request().postDataJSON() as { requestId: string; sessionId?: string; prompt: string }
      requests.push(body.requestId)
      expect(body.sessionId).toBeUndefined()
      expect(body.prompt).toBe('只属于首页的新任务')
      if (!rejected) {
        rejected = true
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'submission-unknown', message: '测试发送结果未知' }),
        })
      }
      return route.continue()
    })
    await home.getByRole('button', { name: '发送', exact: true }).click()
    await home.getByRole('button', { name: '重试这次提交', exact: true }).waitFor()
    await home.getByRole('button', { name: '重试这次提交', exact: true }).click()
    await expect.poll(() => calls).toBe(2)
    expect(requests).toHaveLength(2)
    expect(new Set(requests).size).toBe(1)
    await expect.poll(() => home.count()).toBe(0)
    const tasks = await host.host.bridge.listTasks()
    expect(tasks).toHaveLength(2)
    const created = await owner.json<TaskDetail>(`tasks/${tasks.find(task => task.id !== sessionId)!.id}`)
    expect(created.messages.find(message => message.role === 'user')?.attachments?.map(item => item.name)).toEqual(['home.txt'])
    await choose(page, '原会话')
    expect(await input.inputValue()).toBe('只属于原会话的草稿')
    await mkdir('test-results/workbench-input', { recursive: true })
    await page.screenshot({ path: 'test-results/workbench-input/restored-session.png', animations: 'disabled' })
  } finally {
    await context.close()
    await browser.close()
    await host.close()
  }
})

it('retries a failed session through the one sender while preserving the home draft and attachment', async () => {
  let calls = 0
  let failNext = false
  let holdNext = false
  let releaseRun: (() => void) | undefined
  const plugin: HarnessPlugin = {
    id: 'home-retry',
    name: '首页重试验收',
    version: '1',
    description: 'Local fixture only.',
    activate(context) {
      context.registerProvider({
        id: 'retry-model',
        name: '本地验收模型',
        model: 'fixture',
        async *stream() {
          calls++
          if (calls === 1 || failNext) {
            failNext = false
            throw new Error('测试临时失败')
          }
          if (holdNext) {
            holdNext = false
            await new Promise<void>(resolve => {
              releaseRun = resolve
            })
          }
          yield { type: 'text', text: '原会话已完成重试。' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({ demo: false, plugins: [plugin], providerId: 'retry-model' })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  const page = await context.newPage()
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: '请重试原来的工作', model: { providerId: 'retry-model', model: 'fixture' } },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('failed')
    await enrollBrowser(page, host, { name: '首页重试设备', scopes: ['admin'] })
    await connected(page)
    const home = page.locator('.workbench-home')
    const draft = home.getByRole('textbox', { name: '新会话消息', exact: true })
    await draft.fill('首页草稿继续保留')
    await home
      .getByLabel('选择附件', { exact: true })
      .setInputFiles({ name: 'keep-home.txt', mimeType: 'text/plain', buffer: Buffer.from('home only') })
    await expect.poll(() => home.getByRole('button', { name: 'keep-home.txt', exact: true }).isEnabled()).toBe(true)
    const retry = home.locator(`[data-work-session="${sessionId}"]`).getByRole('button', { name: '重试', exact: true })
    await retry.waitFor()
    await retry.click()
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    expect(await host.host.bridge.listTasks()).toHaveLength(1)
    const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
    const prompts = detail.messages.filter(message => message.role === 'user')
    expect(prompts.map(message => message.text)).toEqual(['请重试原来的工作', '请重试原来的工作'])
    expect(prompts[1]?.attachments).toBeUndefined()
    expect(prompts[0]?.requestId).not.toBe(prompts[1]?.requestId)
    await page.getByRole('button', { name: '总览', exact: true }).locator('visible=true').first().click()
    expect(await draft.inputValue()).toBe('首页草稿继续保留')
    expect(await home.getByRole('button', { name: 'keep-home.txt', exact: true }).isEnabled()).toBe(true)
    expect(calls).toBe(2)
    // A different reader opens the same failed session meanwhile. The delayed target detail must not start another turn.
    const peer = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: '另一条会话', model: { providerId: 'retry-model', model: 'fixture' } },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${peer.sessionId}`)).summary.status).toBe('idle')
    await owner.json(`tasks/${peer.sessionId}`, { method: 'PATCH', body: { title: '另一条会话' } })
    await choose(page, '另一条会话')
    await page.getByRole('button', { name: '总览', exact: true }).locator('visible=true').first().click()
    failNext = true
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { requestId: randomUUID(), prompt: '再次出现失败' } })
    await retry.waitFor()
    let reading = false
    let releaseRead!: () => void
    const readGate = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    await page.route(`**/link/api/tasks/${sessionId}`, async route => {
      if (route.request().method() !== 'GET' || reading) return route.continue()
      reading = true
      await readGate
      return route.continue()
    })
    await retry.click()
    await expect.poll(() => reading).toBe(true)
    holdNext = true
    await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { requestId: randomUUID(), prompt: '另一个设备已经继续' } })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('running')
    releaseRead()
    await page.getByText('会话状态已变化，请查看最新状态后重试。', { exact: true }).waitFor()
    await expect.poll(() => calls).toBe(5)
    expect(
      (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.filter(message => message.role === 'user').map(message => message.text),
    ).toEqual(['请重试原来的工作', '请重试原来的工作', '再次出现失败', '另一个设备已经继续'])
    await page.getByRole('button', { name: '总览', exact: true }).locator('visible=true').first().click()
    expect(await draft.inputValue()).toBe('首页草稿继续保留')
    expect(await home.getByRole('button', { name: 'keep-home.txt', exact: true }).isEnabled()).toBe(true)
    releaseRun?.()
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
  } finally {
    releaseRun?.()
    await context.close()
    await browser.close()
    await host.close()
  }
})
