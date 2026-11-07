import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, ProviderSettings, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, startFakeModels, type FakeModels, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

const OUTPUT = 'test-results/model-gateway'
const KEY = 'sk-e2e-service-key-0123456789abcdef'
/** Codex's own list, as its model/list answers before any session: the models it knows. */
const CODEX_MODELS = JSON.stringify(
  [
    ['gpt-own', 'GPT Own'],
    ['fake-model', 'Fake Model'],
    ['fake-model-large', 'Fake Model Large'],
  ].map(([id, displayName], index) => ({
    id,
    displayName,
    hidden: false,
    isDefault: index === 0,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [],
  })),
)

const shot = (page: Page, name: string) => page.screenshot({ path: `${OUTPUT}/${name}.png`, animations: 'disabled' })
const input = (page: Page) => page.getByRole('textbox', { name: '新会话消息', exact: true })
const chip = (page: Page, name: string): Locator => page.getByRole('button', { name: new RegExp(`^${name}：`, 'u') }).first()
const row = (page: Page, name: RegExp | string) =>
  page.getByRole('menuitemradio', { name }).or(page.getByRole('option', { name })).or(page.getByRole('radio', { name })).first()

/** Sends the draft, starting in a new empty folder when the page asks where. */
async function sendDraft(page: Page): Promise<void> {
  await input(page).press('Meta+Enter')
  const elsewhere = page.getByText('在一个新的空文件夹里开始', { exact: true })
  if (
    await elsewhere.waitFor({ timeout: 3_000 }).then(
      () => true,
      () => false,
    )
  ) {
    await elsewhere.click()
    await input(page).press('Meta+Enter')
  }
}

/** Codex on a saved Responses service: chosen in the model menu, its turns sent through Latch with the service's key. */
describe('a Harness with its own models on a saved service', () => {
  let directory: string
  let log: string
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let models: FakeModels
  let openai: ProviderSettings

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'latch-e2e-gateway-'))
    log = join(directory, 'agent.log')
    models = await startFakeModels({ replies: [{ text: '经过 Latch 的回复' }] })
    const bin = join(directory, 'bin')
    await mkdir(bin)
    // codex-acp as the fake agent: it takes providers/set and offers the service's models it knows.
    await writeFile(
      join(bin, 'codex-acp'),
      [
        '#!/bin/sh',
        `export FAKE_ACP_STATE='${join(directory, 'state.json')}' FAKE_ACP_LOG='${log}' FAKE_ACP_PROVIDERS=1`,
        'export FAKE_ACP_MODES=read-only,workspace-write,agent,agent-full-access FAKE_ACP_INITIAL_MODE=read-only FAKE_ACP_CONFIG=options',
        'export FAKE_ACP_MODELS=gpt-own,fake-model,fake-model-large FAKE_ACP_DUMP_ENV=1 FAKE_ACP_CAPS=resume',
        `export FAKE_CODEX_MODELS='${CODEX_MODELS}'`,
        `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
      ].join('\n'),
    )
    await chmod(join(bin, 'codex-acp'), 0o755)
    host = await startTestHost({
      demo: false,
      sessionFolders: true,
      detectPreset: preset => (preset.id === 'codex' ? { found: true, path: join(bin, 'codex-acp') } : { found: false }),
      // Only this directory: no agent installed on the computer running the test is ever found.
      commandDirectories: () => [bin],
    })
    owner = await host.enroll({ listener: 'unix' })
    const add = async (name: string, kind: string, baseURL: string, served = ['fake-model', 'fake-model-large']) => {
      const created = await owner.confirmed('providers', {
        method: 'POST',
        body: {
          name,
          kind,
          baseURL,
          apiKey: KEY,
          models: served,
          defaultModel: 'fake-model',
          confirmOrigin: true,
        },
      })
      expect(created.status).toBe(201)
      return ((await created.json()) as { provider: ProviderSettings }).provider
    }
    openai = await add('OpenAI', 'openai-responses', `${models.origin}/v1`)
    await add('DeepSeek', 'openai-compatible', `${models.origin}/v1`)
    // A relay with a model Codex does not know: Codex would not use it.
    await add('Relay', 'openai-responses', `${models.origin}/v1`, ['fake-model', 'deepseek-v3'])
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
    await models?.close()
    await rm(directory, { recursive: true, force: true })
  })

  const open = async (width: number, theme: 'light' | 'dark'): Promise<Page> => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: theme,
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
    await connected(page)
    return page
  }
  const latest = async () => {
    const tasks = (await owner.json<AppSnapshot>('snapshot')).tasks.toSorted((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
    return owner.json<TaskDetail>(`tasks/${tasks.at(-1)!.id}`)
  }

  it("goes back to Codex's own model when it is picked again, and leaves nothing of the service pick", async () => {
    const page = await open(1440, 'dark')
    await chip(page, '模型').click()
    // Opening the menu first reads Codex's own list.
    await page.getByText(/^读取于 /u).waitFor()
    await row(page, 'fake-model-large').click()
    await expect.poll(() => chip(page, '模型').innerText()).toContain('fake-model-large · OpenAI')
    await chip(page, '模型').click()
    await row(page, /GPT Own/u).click()
    await expect.poll(() => chip(page, '模型').innerText()).toContain('GPT Own')
    await page.reload()
    await connected(page)
    await expect.poll(() => chip(page, '模型').innerText()).toContain('GPT Own')
    await shot(page, 'own-again-1440-dark')
    await page.context().close()
  })

  it('lists the same on a phone and a tablet, light and dark', async () => {
    for (const [width, theme] of [
      [390, 'dark'],
      [390, 'light'],
      [768, 'dark'],
    ] as const) {
      const page = await open(width, theme)
      if (width === 390) {
        for (const button of await page.getByRole('button', { name: '新建会话', exact: true }).all()) {
          if (await button.isVisible()) {
            await button.click()
            break
          }
        }
        const sheet = page.locator('.new-session-sheet')
        await sheet.waitFor()
        await sheet.getByRole('button', { name: /^模型/u }).click()
      } else await chip(page, '模型').click()
      await page.getByText('OpenAI · 实验性 · 经 Latch', { exact: true }).waitFor()
      await noHorizontalOverflow(page)
      await shot(page, `draft-menu-${width}-${theme}`)
      await row(page, 'fake-model').click()
      if (width === 390) {
        await expect
          .poll(() =>
            page
              .locator('.new-session-sheet')
              .getByRole('button', { name: /^模型/u })
              .innerText(),
          )
          .toContain('fake-model · OpenAI')
        await shot(page, `sheet-picked-${width}-${theme}`)
      } else await expect.poll(() => chip(page, '模型').innerText()).toContain('fake-model · OpenAI')
      await page.context().close()
    }
  })
  it('lists the service Codex speaks under 经 Latch, starts on its model, and sends the turn through Latch', async () => {
    const page = await open(1440, 'light')
    await chip(page, '模型').click()
    await page.getByText('OpenAI · 实验性 · 经 Latch', { exact: true }).waitFor()
    // A service Codex does not speak is listed with why, not offered; nor is a model it does not know.
    await page.getByText(/^Codex 只说 Responses 协议，转换 Chat Completions 尚未实现$/u).waitFor()
    await page.getByText('Relay · 实验性 · 经 Latch', { exact: true }).waitFor()
    await expect.poll(() => row(page, 'deepseek-v3').getAttribute('aria-disabled')).toBe('true')
    await page.getByText('Codex 不认识这个模型', { exact: true }).waitFor()
    // What it promises is what the Host checks: a whole turn that did not reach Latch.
    await page
      .getByText('「经 Latch」表示请求由 Latch 在这台 Mac 上转发，用设置里的密钥。Codex 有一整轮没有经过 Latch 时，会话里会告诉你。', {
        exact: true,
      })
      .waitFor()
    await shot(page, 'draft-menu-1440-light')
    await row(page, 'fake-model-large').click()
    await expect.poll(() => chip(page, '模型').innerText()).toContain('fake-model-large · OpenAI')
    await page.reload()
    await connected(page)
    // The pick is Codex's own and stays across a reload.
    await expect.poll(() => chip(page, '模型').innerText()).toContain('fake-model-large · OpenAI')

    await input(page).fill('model 你好')
    await sendDraft(page)
    await page.locator('.transcript').getByText('model: 经过 Latch 的回复', { exact: true }).first().waitFor({ timeout: 20_000 })
    const detail = await latest()
    expect(detail.summary.modelRoute).toEqual({ providerId: openai.id, model: 'fake-model-large' })
    expect(detail.config?.find(option => option.category === 'model')?.currentValue).toBe('fake-model-large')
    // The service received its own key; the agent's environment and messages never held it.
    expect(models.requests.map(request => [request.wire, request.model, request.key])).toEqual([['responses', 'fake-model-large', KEY]])
    expect(await readFile(log, 'utf8')).not.toContain(KEY)
    expect(JSON.stringify(detail)).not.toMatch(/lmg1\./u)

    // In the session the service is fixed; the menu says where its requests go.
    await chip(page, '模型').click()
    await page.getByText('这个会话经 Latch 用「OpenAI」：请求由 Latch 在这台 Mac 上转发，用设置里的密钥。', { exact: true }).waitFor()
    // What Codex lists now is that service's; another service it speaks needs a new session.
    await page.getByText('OpenAI · 经 Latch', { exact: true }).waitFor()
    await page.getByText('换服务要新开会话：开始时确认的是这个服务。', { exact: true }).waitFor()
    expect(await page.getByText('Codex 自己的模型', { exact: true }).count()).toBe(0)
    await shot(page, 'session-menu-1440-light')
    await page.keyboard.press('Escape')

    // The service turned off: its token stops, and the next turn says why instead of using Codex's own login.
    expect((await owner.request(`providers/${openai.id}`, { method: 'PUT', body: { enabled: false } })).status).toBe(200)
    const composer = page.getByRole('textbox', { name: '继续对话', exact: true })
    await composer.fill('model 第二轮')
    await composer.press('Meta+Enter')
    await page
      .locator('.transcript')
      .getByText(/这个会话开始时用的模型服务现在不能用/u)
      .first()
      .waitFor({ timeout: 20_000 })
    await shot(page, 'service-off-1440-light')
    expect(models.requests).toHaveLength(1)
    // Turned on again, the next turn goes through with a new token.
    expect((await owner.request(`providers/${openai.id}`, { method: 'PUT', body: { enabled: true } })).status).toBe(200)
    await composer.fill('model 第三轮')
    await composer.press('Meta+Enter')
    await expect.poll(() => models.requests.length, { timeout: 20_000 }).toBe(2)
    await page.locator('.transcript').getByText('model: 经过 Latch 的回复', { exact: true }).nth(1).waitFor()
    const tokens = (await readFile(log, 'utf8')).match(/lmg1\.[A-Za-z0-9_-]{43}/gu) ?? []
    expect(new Set(tokens).size).toBe(2)
    await page.context().close()
  })
})

/**
 * Gemini CLI on a saved Gemini service. Gemini CLI lists a fixed set of its own models whatever service it points at;
 * the gateway forwards only the service's, so those are what the session offers.
 */
describe('Gemini CLI on a saved Gemini service', () => {
  let directory: string
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let models: FakeModels
  let gemini: ProviderSettings

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'latch-e2e-gateway-gemini-'))
    models = await startFakeModels({ replies: [{ text: '经过 Latch 的回复' }] })
    const bin = join(directory, 'bin')
    await mkdir(bin)
    // As Gemini CLI answers: its own models in the old `models` form, the current one from its settings.
    await writeFile(
      join(bin, 'gemini'),
      [
        '#!/bin/sh',
        `export FAKE_ACP_STATE='${join(directory, 'state.json')}' FAKE_ACP_LOG='${join(directory, 'agent.log')}'`,
        'export FAKE_ACP_MODES=plan,default,autoEdit,yolo FAKE_ACP_INITIAL_MODE=default FAKE_ACP_CONFIG=legacy',
        `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
      ].join('\n'),
    )
    await chmod(join(bin, 'gemini'), 0o755)
    host = await startTestHost({
      demo: false,
      sessionFolders: true,
      detectPreset: preset => (preset.id === 'gemini' ? { found: true, path: join(bin, 'gemini') } : { found: false }),
      commandDirectories: () => [bin],
    })
    owner = await host.enroll({ listener: 'unix' })
    const created = await owner.confirmed('providers', {
      method: 'POST',
      body: {
        name: 'MyGemini',
        kind: 'gemini',
        baseURL: models.origin,
        apiKey: KEY,
        models: ['fake-model', 'fake-model-large'],
        defaultModel: 'fake-model',
        confirmOrigin: true,
      },
    })
    expect(created.status).toBe(201)
    gemini = ((await created.json()) as { provider: ProviderSettings }).provider
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
    await models?.close()
    await rm(directory, { recursive: true, force: true })
  })

  it("offers in the session the service's models, not Gemini CLI's own, and a switch goes to the service", async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
    await connected(page)
    await chip(page, '模型').click()
    await page.getByText('MyGemini · 经 Latch', { exact: true }).waitFor()
    await row(page, 'fake-model').click()
    await expect.poll(() => chip(page, '模型').innerText()).toContain('fake-model · MyGemini')
    await input(page).fill('model 你好')
    await sendDraft(page)
    await page.locator('.transcript').getByText('model: 经过 Latch 的回复', { exact: true }).first().waitFor({ timeout: 20_000 })
    // An ID typed for Gemini CLI's own login is no model of this service either.
    const [started] = (await owner.json<AppSnapshot>('snapshot')).tasks
    const typed = await owner.request(`agents/${started!.harnessId}/models`, { method: 'PUT', body: { models: ['vendor/typed'] } })
    expect(typed.status).toBe(200)
    await page.reload()
    await connected(page)

    await chip(page, '模型').click()
    await page.getByText('MyGemini · 经 Latch', { exact: true }).waitFor()
    await row(page, 'fake-model-large').waitFor()
    expect(await page.getByText('Fake Small', { exact: true }).count()).toBe(0)
    expect(await page.getByText('vendor/typed', { exact: true }).count()).toBe(0)
    await shot(page, 'gemini-session-menu-1440-light')
    await row(page, 'fake-model-large').click()
    await expect.poll(() => chip(page, '模型').innerText()).toContain('fake-model-large')
    const composer = page.getByRole('textbox', { name: '继续对话', exact: true })
    await composer.fill('model 第二轮')
    await composer.press('Meta+Enter')
    await page.locator('.transcript').getByText('model: 经过 Latch 的回复', { exact: true }).nth(1).waitFor({ timeout: 20_000 })
    expect(models.requests.map(request => [request.wire, request.model, request.key])).toEqual([
      ['gemini', 'fake-model', KEY],
      ['gemini', 'fake-model-large', KEY],
    ])
    const tasks = (await owner.json<AppSnapshot>('snapshot')).tasks
    const detail = await owner.json<TaskDetail>(`tasks/${tasks[0]!.id}`)
    expect(detail.summary.modelRoute).toEqual({ providerId: gemini.id, model: 'fake-model' })
    await context.close()
  })
})
