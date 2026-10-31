import { chromium, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentSettings } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { backToSection, openSection, openSettings } from './helpers/layout.ts'
import { motions, tokens } from './helpers/motion.ts'

/**
 * Settings moves between its levels with the duration and easing tokens: on a phone the first section slides in over
 * the section list, a page inside a section slides in over the section and back out again (240ms), and under reduced
 * motion both only cross-fade; from 768px going back from a page fades the section in (120ms), and leaving settings
 * fades the page out before the conversation shows.
 */
describe('settings navigation motion', () => {
  let testHost: TestHost
  let browser: Browser

  beforeAll(async () => {
    testHost = await startTestHost({ uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web') })
    browser = await chromium.launch(browserLaunchOptions())
  })
  afterAll(async () => {
    await browser?.close()
    await testHost?.close()
  })

  async function device(options: {
    phone: boolean
    reducedMotion: 'reduce' | 'no-preference'
  }): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({
      viewport: options.phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      hasTouch: options.phone,
      isMobile: options.phone,
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      reducedMotion: options.reducedMotion,
    })
    context.setDefaultTimeout(15_000)
    const page = await context.newPage()
    await enrollBrowser(page, testHost, {
      name: options.phone ? '动效手机' : '动效电脑',
      scopes: ['view', 'run', 'approve:standard', 'admin'],
    })
    return { context, page }
  }

  it('slides the first section in on a phone, then a page over the section and back', async () => {
    const { context, page } = await device({ phone: true, reducedMotion: 'no-preference' })
    try {
      const token = await tokens(page)
      const settings = await openSettings(page, '设置')
      // The first push: the section was laid out off-screen from the start, so it slides in like every later one.
      const push = await motions(page, () => settings.getByRole('tab', { name: '电脑', exact: true }).click())
      expect(push).toContainEqual({
        kind: 'transition',
        target: 'settings-panel',
        name: 'transform',
        duration: token.push,
        easing: token.ePush,
      })
      expect(push).toContainEqual({
        kind: 'transition',
        target: 'settings-nav-pane',
        name: 'transform',
        duration: token.push,
        easing: token.ePush,
      })
      // A page inside the section: its own bar and back, sliding in over the section, which moves aside.
      const deeper = await motions(page, () => settings.getByRole('button', { name: /^其他设备可用的 Agent/ }).click())
      expect(deeper).toContainEqual({
        kind: 'transition',
        target: 'settings-level',
        name: 'transform',
        duration: token.push,
        easing: token.ePush,
      })
      expect(deeper).toContainEqual({
        kind: 'transition',
        target: 'settings-panel',
        name: 'transform',
        duration: token.push,
        easing: token.ePush,
      })
      const level = settings.locator('.settings-level[data-state="top"]')
      await level.getByRole('heading', { name: '其他设备可用的 Agent', exact: true }).waitFor()
      // This browser is on loopback, so the list holds it back too, and the page never calls it 本机.
      await level.getByText(/^手机、这台电脑上的浏览器和其他电脑只能用这里允许的 Agent/u).waitFor()
      // One way back per level: the bar's, named after where it goes; the section's own bar is covered.
      expect(await settings.locator('.settings-back').count()).toBe(0)
      const back = await motions(page, () => level.getByRole('button', { name: '返回电脑', exact: true }).click())
      expect(back).toContainEqual({
        kind: 'transition',
        target: 'settings-level',
        name: 'transform',
        duration: token.push,
        easing: token.ePush,
      })
      expect(back).toContainEqual({
        kind: 'transition',
        target: 'settings-panel',
        name: 'transform',
        duration: token.push,
        easing: token.ePush,
      })
      await expect.poll(() => settings.locator('.settings-level').count()).toBe(0)
      expect(await settings.locator('.settings-layout').getAttribute('data-level')).toBe('section')
    } finally {
      await context.close()
    }
  })

  it('cross-fades the phone levels under reduced motion, with nothing moving', async () => {
    const { context, page } = await device({ phone: true, reducedMotion: 'reduce' })
    try {
      const token = await tokens(page)
      const settings = await openSettings(page, '设置')
      const push = await motions(page, () => settings.getByRole('tab', { name: '电脑', exact: true }).click())
      expect(push).toContainEqual({
        kind: 'transition',
        target: 'settings-panel',
        name: 'opacity',
        duration: token.micro,
        easing: token.eMicro,
      })
      const deeper = await motions(page, () => settings.getByRole('button', { name: /^其他设备可用的 Agent/ }).click())
      expect(deeper).toContainEqual({
        kind: 'transition',
        target: 'settings-level',
        name: 'opacity',
        duration: token.micro,
        easing: token.eMicro,
      })
      // Nothing in settings moves (the session drawer behind it shuts at once, which is not settings' own motion).
      const moving = [...push, ...deeper].filter(
        motion => motion.target.startsWith('settings') && /^(transform|translate|settings-enter)$/u.test(motion.name),
      )
      expect(moving).toEqual([])
    } finally {
      await context.close()
    }
  })

  it('fades a section in again on the way back from a page, and fades settings out when leaving', async () => {
    const { context, page } = await device({ phone: false, reducedMotion: 'no-preference' })
    try {
      const token = await tokens(page)
      const settings = await openSettings(page, '设置')
      await openSection(settings, '电脑')
      const forward = await motions(page, () => settings.getByRole('button', { name: /^其他设备可用的 Agent/ }).click())
      expect(forward).toContainEqual({
        kind: 'animation',
        target: 'settings-subpage settings-enter',
        name: 'settings-enter',
        duration: token.micro,
        easing: token.eMicro,
      })
      const back = await motions(page, () => backToSection(settings))
      expect(back).toContainEqual({
        kind: 'animation',
        target: 'settings-subpage settings-enter',
        name: 'settings-enter',
        duration: token.micro,
        easing: token.eMicro,
      })
      await settings.getByRole('button', { name: /^在这台电脑上发起：/ }).waitFor()

      // Leaving: the page fades out (70% of --m-micro, the exit curve), and only then is the conversation back.
      const leave = await motions(page, async () => {
        await settings.getByRole('button', { name: /^返回会话/ }).click()
        await settings.waitFor({ state: 'detached' })
      })
      expect(leave).toContainEqual({
        kind: 'animation',
        target: 'ui-modal ui-modal-page settings-page is-leaving',
        name: 'settings-leave',
        duration: token.microExit,
        easing: token.exit,
      })
    } finally {
      await context.close()
    }
  })
})

/** A local OpenAI-compatible service whose model list fails, so a model has to be added by its ID. */
async function brokenListing(): Promise<{ baseURL: string; allow: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'listing is broken' } }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    allow: `127.0.0.1:${port}`,
    close: () =>
      new Promise<void>(done => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
}

/** Button names in a region, as the accessibility tree reads them. */
async function buttonNames(region: Locator): Promise<string[]> {
  const tree = await region.ariaSnapshot()
  return [...tree.matchAll(/- button "([^"]+)"/gu)].map(match => match[1]!)
}

/**
 * Adding a model service from a browser: when the service's model list fails, the reason is one sentence and a model is
 * added by its ID; the service saves, and every button in the form has its own name. A browser cannot type keys, and
 * says where to do it instead.
 */
describe('adding a model service', () => {
  it('adds a model by its ID when listing fails, saves the service and names every button once', async () => {
    const service = await brokenListing()
    // The address is allowed for this run, as `LATCH_BASE_URL` would be; confirming it is the desktop's part.
    const testHost = await startTestHost({
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
      egressAllow: [service.allow],
    })
    const browser = await chromium.launch(browserLaunchOptions())
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', deviceScaleFactor: 1 })
      context.setDefaultTimeout(15_000)
      const page = await context.newPage()
      await enrollBrowser(page, testHost, { name: '模型服务电脑', scopes: ['view', 'run', 'approve:standard', 'admin'] })
      const settings = await openSettings(page, '设置')
      await openSection(settings, '模型服务')
      await settings.getByRole('button', { name: '添加服务…', exact: true }).click()
      await settings.getByRole('button', { name: /^自定义 OpenAI 兼容/ }).click()
      await settings.getByLabel('名称', { exact: true }).fill('实验室模型')
      await settings.getByLabel('API 地址', { exact: true }).fill(service.baseURL)
      await settings.getByText('密钥只能在运行 Latch 的电脑上用桌面端填写：设置 › 模型服务。', { exact: true }).waitFor()

      await settings.getByRole('button', { name: '获取模型', exact: true }).click()
      await settings.getByText('模型服务返回了错误（HTTP 500）。可以手动输入模型 ID。', { exact: true }).waitFor()
      const manual = settings.getByLabel('手动添加模型 ID', { exact: true })
      // An ID the Host would refuse is explained in place and not added.
      await manual.fill('m'.repeat(201))
      await manual.press('Enter')
      await settings.getByText('模型 ID 不能超过 200 个字符。', { exact: true }).waitFor()
      await manual.fill('lab-model')
      await manual.press('Enter')
      await settings.getByRole('radio', { name: '默认使用 lab-model', exact: true }).waitFor()
      await page.screenshot({ path: 'test-results/settings-provider-manual-model.png', animations: 'disabled' })

      const names = await buttonNames(settings.locator('.provider-add'))
      expect(names).toContain('保存服务')
      expect(names).toContain('添加输入的模型 ID')
      expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([])

      await settings.getByRole('button', { name: '保存服务', exact: true }).click()
      await settings.getByRole('heading', { name: '实验室模型', exact: true }).waitFor()
      const saved = testHost.host.config.providers().find(provider => provider.name === '实验室模型')
      expect(saved).toMatchObject({ baseURL: service.baseURL, models: ['lab-model'], defaultModel: 'lab-model', apiKey: '' })
      // The form already showed there is no model list, so nothing is checked at once; checking says it cannot tell,
      // which is not a failed connection, and never suggests removing the service.
      await settings.getByText('用这个地址和密钥请求服务的模型列表', { exact: true }).waitFor()
      await settings.getByRole('button', { name: '检测连接', exact: true }).click()
      await settings.getByText('无法自动检测：这个服务不提供模型列表', { exact: true }).waitFor()
      expect(await settings.getByRole('button', { name: '移除此服务', exact: true }).count()).toBe(0)
      expect(await settings.locator('.check-result.is-error').count()).toBe(0)
      await page.screenshot({ path: 'test-results/settings-provider-saved-no-listing.png', animations: 'disabled' })

      // A preset that needs a key, saved from a device that cannot type one: said before saving, and after it the page
      // and the list say the key is missing instead of checking with none.
      await settings.getByRole('button', { name: '模型服务', exact: true }).click()
      await settings.getByRole('button', { name: '添加服务…', exact: true }).click()
      await settings.getByRole('button', { name: /^DeepSeek/ }).click()
      await settings
        .getByText('这个服务需要密钥：保存后，在运行 Latch 的电脑上 设置 › 模型服务 填写密钥，它才能使用。', { exact: true })
        .waitFor()
      await settings.getByLabel('手动添加模型 ID', { exact: true }).fill('deepseek-chat')
      await settings.getByLabel('手动添加模型 ID', { exact: true }).press('Enter')
      await settings.getByRole('button', { name: '保存服务', exact: true }).click()
      await settings.getByRole('heading', { name: 'DeepSeek', exact: true }).waitFor()
      await settings.getByText('还没有填写密钥，Latch 不会使用它。', { exact: true }).waitFor()
      await settings.getByText('在运行 Latch 的电脑上 设置 › 模型服务 › DeepSeek 填写密钥。').waitFor()
      await settings.getByText('填写密钥后 Latch 内置才能使用它的模型', { exact: true }).waitFor()
      expect(await settings.getByRole('button', { name: '检测连接', exact: true }).getAttribute('aria-disabled')).toBe('true')
      expect(await settings.getByRole('button', { name: '获取模型', exact: true }).getAttribute('aria-disabled')).toBe('true')
      expect(await settings.getByText('密钥不对或已过期', { exact: false }).count()).toBe(0)
      await page.screenshot({ path: 'test-results/settings-provider-missing-key.png', animations: 'disabled' })
      await settings.getByRole('button', { name: '模型服务', exact: true }).click()
      await settings.getByText('缺密钥', { exact: true }).waitFor()
      await settings.getByText(/还没有填写密钥$/u).waitFor()

      // An address nobody has confirmed: saved from here, never used, and the page says where to confirm it.
      await settings.getByRole('button', { name: '添加服务…', exact: true }).click()
      await settings.getByRole('button', { name: /^Ollama/ }).click()
      await settings
        .getByText('这个地址要在运行 Latch 的电脑上确认后才能使用。保存后它会显示在列表里，等你在运行 Latch 的电脑上确认地址。', {
          exact: true,
        })
        .waitFor()
      await settings.getByLabel('手动添加模型 ID', { exact: true }).fill('llama3')
      await settings.getByLabel('手动添加模型 ID', { exact: true }).press('Enter')
      await settings.getByRole('button', { name: '保存服务', exact: true }).click()
      await settings.getByText('这个服务的地址还没有确认，Latch 不会使用它。', { exact: true }).waitFor()
      // The notice's sentence follows its title in the same element.
      await settings.getByText('需要在运行 Latch 的电脑上确认这个地址：设置 › 模型服务 › Ollama。').waitFor()
      expect(await settings.getByRole('button', { name: '获取模型', exact: true }).getAttribute('aria-disabled')).toBe('true')
      // The switch says what the address still needs, the check says why it cannot run, and no command for the
      // computer running Latch is offered on this device.
      await settings.getByText('确认地址后 Latch 内置才能使用它的模型', { exact: true }).waitFor()
      expect(await settings.getByRole('button', { name: '检测连接', exact: true }).getAttribute('aria-disabled')).toBe('true')
      expect(await settings.innerText()).not.toContain('pnpm latch')
      expect(testHost.host.security.policy.get().confirmedAddresses).toEqual([])
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.screenshot({ path: `test-results/settings-provider-unconfirmed-${scheme}.png`, animations: 'disabled' })
      }
      await settings.getByRole('button', { name: '模型服务', exact: true }).click()
      await settings.getByText('未确认', { exact: true }).waitFor()
      await settings.getByText(/需要在运行 Latch 的电脑上确认这个地址$/u).waitFor()
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.screenshot({ path: `test-results/settings-providers-unconfirmed-row-${scheme}.png`, animations: 'disabled' })
      }
      await page.setViewportSize({ width: 390, height: 844 })
      await page.emulateMedia({ colorScheme: 'light' })
      await settings.getByText('未确认', { exact: true }).waitFor()
      await page.screenshot({ path: 'test-results/settings-providers-unconfirmed-row-phone.png', animations: 'disabled' })
      await context.close()
    } finally {
      await browser.close()
      await testHost.close()
      await service.close()
    }
  })
})

/**
 * Adding an agent asks for no confirmation; its definition says it has not started yet, and the first full-access start
 * (confirmed with what it runs) clears that.
 */
describe('an agent that has not started yet', () => {
  it('saves without a confirmation and says 还没有开启过会话 until a session starts with it', async () => {
    const testHost = await startTestHost({ uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web') })
    const browser = await chromium.launch(browserLaunchOptions())
    try {
      const desktop = await testHost.enroll({ listener: 'unix', name: '本机桌面端' })
      const before = testHost.presence.requests.length
      const saved = await desktop.request('agents', {
        method: 'POST',
        body: { name: '本地 ACP Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
      })
      expect(saved.status).toBe(201)
      expect(testHost.presence.requests).toHaveLength(before)
      const { agent }: { agent: AgentSettings } = await saved.json()
      expect(agent.started).toBe(false)

      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', deviceScaleFactor: 1 })
      context.setDefaultTimeout(15_000)
      const page = await context.newPage()
      await enrollBrowser(page, testHost, { name: 'Agent 电脑', scopes: ['view', 'run', 'approve:standard', 'admin'] })
      const settings = await openSettings(page, '设置')
      await openSection(settings, 'Agent 成员')
      const row = settings.locator(`[data-agent-id="${agent.id}"]`)
      await row.getByText('还没有开启过会话', { exact: true }).waitFor()
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.screenshot({ path: `test-results/settings-agent-not-started-${scheme}.png`, animations: 'disabled' })
      }
      await page.emulateMedia({ colorScheme: 'light' })
      await settings.getByRole('button', { name: '编辑 本地 ACP Agent', exact: true }).click()
      await settings.getByText('开始会话时，会在这台电脑上确认它要运行的命令、参数和环境变量名。', { exact: true }).waitFor()
      await page.screenshot({ path: 'test-results/settings-agent-page-not-started.png', animations: 'disabled' })
      await backToSection(settings)

      // The first full-access start is the confirmation.
      const beforeStart = testHost.presence.requests.length
      const started = await desktop.confirmed('tasks', {
        method: 'POST',
        body: { prompt: 'echo hi', requestId: randomUUID(), mode: 'agent', harnessId: agent.id },
      })
      expect(started.status).toBe(201)
      expect(testHost.presence.requests.slice(beforeStart).map(request => request.preview.action)).toEqual(['task.start-l3'])
      // 重新检测 on its page reads the agents again.
      await settings.getByRole('button', { name: '编辑 本地 ACP Agent', exact: true }).click()
      await settings.getByRole('button', { name: '重新检测', exact: true }).click()
      await expect
        .poll(() => settings.getByText('开始会话时，会在这台电脑上确认它要运行的命令、参数和环境变量名。', { exact: true }).count())
        .toBe(0)
      await backToSection(settings)
      await row.waitFor()
      expect(await row.getByText('还没有开启过会话', { exact: true }).count()).toBe(0)
      await context.close()
    } finally {
      await browser.close()
      await testHost.close()
    }
  })
})
