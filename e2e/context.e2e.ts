import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

const OUTPUT = 'test-results/context'

describe('a new context in a session', () => {
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let models: string

  beforeAll(async () => {
    host = await startTestHost()
    owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: {
        id: 'fake-agent',
        name: 'Fake Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'resume,close' },
      },
    })
    models = join(host.root, 'models.txt')
    await writeFile(models, 'small,large')
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: {
        id: 'shrinking-agent',
        name: 'Shrinking Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_CONFIG: 'options', FAKE_ACP_CAPS: 'resume,close', FAKE_ACP_MODELS_FILE: models },
      },
    })
    // Nothing on this computer is looked up: only the built-in harness and the fake agents can run.
    const harnesses = (await owner.json<AppSnapshot>('snapshot')).catalog!.harnesses
    expect(harnesses.filter(item => item.status === 'ready').map(item => item.id)).toEqual(['standard', 'fake-agent', 'shrinking-agent'])
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  const detail = (id: string) => owner.json<TaskDetail>(`tasks/${id}`)
  const idle = (id: string) => expect.poll(async () => (await detail(id)).summary.status, { timeout: 15_000 }).toBe('idle')
  const input = (page: Page) => page.getByRole('textbox', { name: '继续对话', exact: true })
  const send = async (page: Page, text: string) => {
    await input(page).fill(text)
    await input(page).press('Meta+Enter')
  }
  const armed = (page: Page) => page.getByText('下一条消息开始新的上下文', { exact: true })
  const open = async (width: number, theme: 'light' | 'dark', title: string) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { name: `上下文 ${width} ${randomUUID().slice(0, 4)}` })
    await connected(page)
    await page.keyboard.press('Meta+k')
    const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
    await palette.getByRole('searchbox').fill(title)
    await palette.getByRole('option').first().click()
    return { context, page }
  }

  for (const [width, theme] of [
    [1440, 'light'],
    [390, 'dark'],
  ] as const) {
    it(`chooses, takes back and sends a new context, and keeps its line at ${width} ${theme}`, async () => {
      const title = `echo context ${width}`
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { harnessId: 'fake-agent', prompt: title, requestId: randomUUID() },
      })
      await idle(sessionId)
      const { context, page } = await open(width, theme, title)
      const transcript = page.locator('.transcript')
      await send(page, 'recall')
      await transcript.getByText('recall: 1 earlier').waitFor()

      // /clear chooses it and empties the input; 保留上下文 takes it back without a request.
      await input(page).fill('/clear')
      await page
        .getByRole('group', { name: '这个会话' })
        .getByRole('option', { name: /\/clear/ })
        .waitFor()
      await input(page).press('Enter')
      await armed(page).waitFor()
      expect(await input(page).inputValue()).toBe('')
      await page.screenshot({ path: `${OUTPUT}/armed-${width}.png` })
      await page.getByRole('button', { name: '保留上下文', exact: true }).click()
      await armed(page).waitFor({ state: 'detached' })

      const menu = () =>
        width === 390 ? page.locator('.topbar-title-button') : page.getByRole('button', { name: '会话操作', exact: true })
      await menu().click()
      await page.getByRole('menuitem', { name: '清空上下文' }).click()
      await armed(page).waitFor()
      await send(page, 'recall')
      await transcript.getByText('recall: 0 earlier').waitFor()
      await armed(page).waitFor({ state: 'detached' })
      await page.getByRole('note').filter({ hasText: '清空了上下文' }).waitFor()
      // The next turn continues the new context and draws no second line.
      await send(page, 'recall')
      await expect.poll(() => transcript.getByText('recall: 1 earlier').count()).toBe(2)
      expect(await page.locator('.timeline-divider').count()).toBe(1)

      await owner.json(`tasks/${sessionId}/config`, { method: 'POST', body: { configId: 'model', value: 'large' } })
      await send(page, 'echo bigger')
      await transcript.getByText('echo: echo bigger').waitFor()
      await page.getByRole('note').filter({ hasText: '模型 Small → Large' }).waitFor()
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${OUTPUT}/lines-${width}.png`, fullPage: true })

      const users = (await detail(sessionId)).messages.filter(message => message.role === 'user')
      expect(users.map(message => [message.text, message.freshContext ?? false])).toEqual([
        [title, false],
        ['recall', false],
        ['recall', true],
        ['recall', false],
        ['echo bigger', false],
      ])
      await page.reload()
      await connected(page)
      await page.getByRole('note').filter({ hasText: '清空了上下文' }).waitFor()
      expect(await page.locator('.timeline-divider').count()).toBe(2)

      // Chosen, then a turn starts from another device: the choice goes, and the menu says why it cannot be chosen now.
      await menu().click()
      await page.getByRole('menuitem', { name: '清空上下文' }).click()
      await armed(page).waitFor()
      await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'count 60', requestId: randomUUID() } })
      await armed(page).waitFor({ state: 'detached' })
      await menu().click()
      const item = page.getByRole('menuitem', { name: '清空上下文' })
      await expect.poll(() => item.getAttribute('aria-disabled')).toBe('true')
      await expect.poll(() => item.textContent()).toContain('这一轮结束后才能清空上下文')
      await page.keyboard.press('Escape')
      await idle(sessionId)
      await context.close()
    })
  }

  it('resends the latest turn on the new context that was chosen', async () => {
    const title = 'echo resent context'
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'fake-agent', prompt: title, requestId: randomUUID() },
    })
    await idle(sessionId)
    const { context, page } = await open(1440, 'light', title)
    const transcript = page.locator('.transcript')
    await send(page, 'recall')
    await transcript.getByText('recall: 1 earlier').waitFor()
    await idle(sessionId)
    await input(page).fill('/clear')
    await page
      .getByRole('group', { name: '这个会话' })
      .getByRole('option', { name: /\/clear/ })
      .waitFor()
    await input(page).press('Enter')
    await armed(page).waitFor()

    await transcript.getByText('recall: 1 earlier').hover()
    await transcript.getByRole('button', { name: '重试', exact: true }).last().click()
    await transcript.getByText('recall: 0 earlier').waitFor()
    await armed(page).waitFor({ state: 'detached' })
    await page.getByRole('note').filter({ hasText: '清空了上下文' }).waitFor()
    const users = (await detail(sessionId)).messages.filter(message => message.role === 'user')
    expect(users.map(message => [message.text, message.freshContext ?? false])).toEqual([
      [title, false],
      ['recall', false],
      ['recall', true],
    ])
    await context.close()
  })

  it('says the context is already cleared after a refused new-context send, and offers no way back', async () => {
    const title = 'echo refused context'
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId: 'shrinking-agent', prompt: title, requestId: randomUUID() },
    })
    await idle(sessionId)
    await owner.json(`tasks/${sessionId}/config`, { method: 'POST', body: { configId: 'model', value: 'large' } })
    await writeFile(models, 'small')
    const { context, page } = await open(390, 'dark', title)
    const transcript = page.locator('.transcript')
    await transcript.getByText(`echo: ${title}`).waitFor()
    await input(page).fill('/clear')
    await page
      .getByRole('group', { name: '这个会话' })
      .getByRole('option', { name: /\/clear/ })
      .waitFor()
    await input(page).press('Enter')
    await armed(page).waitFor()
    await send(page, 'recall')
    await expect.poll(async () => (await detail(sessionId)).contextCleared).toBe(true)
    await expect.poll(async () => (await detail(sessionId)).messages.filter(message => message.role === 'user').length).toBe(1)
    const drawer = page.getByRole('region', { name: '清空上下文' })
    await drawer.getByText('上下文已经清空').waitFor()
    await armed(page).waitFor()
    expect(await page.getByRole('button', { name: '保留上下文', exact: true }).count()).toBe(0)
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUTPUT}/refused-390.png` })

    // After a reload the page reads the same from the Host, and the menu offers no clear either.
    await page.reload()
    await connected(page)
    await drawer.getByText('上下文已经清空').waitFor()
    expect(await page.getByRole('button', { name: '保留上下文', exact: true }).count()).toBe(0)
    await page.locator('.topbar-title-button').click()
    expect(await page.getByRole('menuitem', { name: /清空上下文|保留上下文/ }).count()).toBe(0)
    await page.keyboard.press('Escape')

    await writeFile(models, 'small,large')
    await send(page, 'recall')
    await transcript.getByText('recall: 0 earlier').waitFor()
    await drawer.waitFor({ state: 'detached' })
    await page.getByRole('note').filter({ hasText: '清空了上下文' }).waitFor()
    const users = (await detail(sessionId)).messages.filter(message => message.role === 'user')
    expect(users.map(message => [message.text, message.freshContext ?? false])).toEqual([
      [title, false],
      ['recall', true],
    ])
    await context.close()
  })
})
