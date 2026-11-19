import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AGENT_PRESETS, type AppSnapshot, type ProviderSettings, type TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, startFakeModels, type FakeModels, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession, phoneStartScreen } from './helpers/layout.ts'

const OUTPUT = 'test-results/model-gateway'
const shownText = (page: Page, text: string | RegExp, options?: { exact?: boolean }) =>
  page.getByText(text, options).filter({ visible: true })
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
/** Words of the model menu, not the same words in a draft's status line or its tooltips. */
const menuText = (page: Page, text: string): Locator =>
  shownText(page, text, { exact: true }).and(page.locator(':not(.composer-status, .composer-status *)'))
const layer = (page: Page) => page.locator(':popover-open, dialog[open]')
const row = (page: Page, name: RegExp | string) =>
  layer(page)
    .getByRole('menuitemradio', { name })
    .or(layer(page).getByRole('option', { name }))
    .or(layer(page).getByRole('radio', { name }))
    .filter({ visible: true })
    .first()
/** A source of the model panel, by its full name: its rail entry (a tab on a phone). */
const sourceTab = (page: Page, label: string) => layer(page).getByRole('tab', { name: label, exact: true }).first()
/** The panel shows one source at a time: choosing its entry brings up its models, a group named after it. */
async function source(page: Page, label: string): Promise<Locator> {
  await sourceTab(page, label).click()
  return layer(page).getByRole('group', { name: label, exact: true })
}
/** The services a Harness reaches through Latch are one source, 「Latch 网关」; each service's models are a group under its name. */
const GATEWAY = 'Latch 网关'
async function service(page: Page, name: string): Promise<Locator> {
  await sourceTab(page, GATEWAY).click()
  return layer(page).getByRole('group', { name, exact: true })
}
/** A model by name from whichever source has it: the panel's search runs across all of them. */
async function pickModel(page: Page, name: string) {
  await layer(page).getByRole('searchbox', { name: '搜索模型' }).fill(name)
  await row(page, name).click()
}
/** A disabled row's reason: its tooltip, which is also its accessible description. */
const reason = (locator: Locator) =>
  locator.evaluate(element =>
    (element.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map(id => document.getElementById(id)?.textContent ?? '')
      .join(''),
  )

/** Sends the draft, starting in a new empty folder when the page asks where, however late it asks. */
/** A preset as a new session's first send saves it: its own command, which the Host finds in the test's directory. */
function savedPreset(id: string) {
  const preset = AGENT_PRESETS.find(item => item.id === id)!
  return { id: preset.id, name: preset.name, presetId: preset.id, command: preset.command, args: preset.args, env: {} }
}

async function sendDraft(page: Page): Promise<void> {
  await input(page).press('Meta+Enter')
  const elsewhere = page.getByRole('menuitemradio', { name: /^不选项目/u }).or(page.getByRole('radio', { name: /^不选项目/u }))
  const sent = page.getByRole('textbox', { name: '继续对话', exact: true })
  await elsewhere.or(sent).first().waitFor({ timeout: 20_000 })
  if (await elsewhere.isVisible()) {
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
    // Saved on this Mac with its confirmation: a page elsewhere is offered no preset, only saved definitions.
    expect((await owner.confirmed('agents', { body: savedPreset('codex') })).status).toBe(201)
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
    await row(page, /GPT Own/u).waitFor()
    await pickModel(page, 'fake-model-large')
    await expect.poll(() => chip(page, '模型').innerText()).toBe('fake-model-large')
    // The panel opens on the service picked; Codex's own models are its first rail entry.
    await chip(page, '模型').click()
    await source(page, 'Codex')
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
      // On a phone the 模型 chip sits in the row over the start screen's input (pushed over the list since cae787a4).
      await phoneStartScreen(page)
      await chip(page, '模型').click()
      await service(page, 'OpenAI')
      await noHorizontalOverflow(page)
      await shot(page, `draft-menu-${width}-${theme}`)
      if (width === 390) {
        // A tapped heading's note is one short line, with what the translation leaves out folded under it.
        const heading = layer(page).getByRole('button', { name: /^DeepSeek/u })
        await heading.click()
        const note = layer(page).locator('.ui-board-hint').filter({ visible: true })
        expect(await note.locator('p').first().innerText()).toMatch(/^请求由 Latch 在 \S+ 上转发，用设置里的密钥。协议转换，实验性。$/u)
        const fold = note.getByRole('button', { name: /略去或受限/u })
        expect(await fold.getAttribute('aria-expanded')).toBe('false')
        await shot(page, `draft-note-${width}-${theme}`)
        await fold.click()
        await note.getByText('文件与服务端会话状态（不能转换）', { exact: true }).waitFor()
        await noHorizontalOverflow(page)
        await shot(page, `draft-note-open-${width}-${theme}`)
        await heading.click()
      }
      await row(page, 'fake-model').click()
      if (width === 390) {
        await expect.poll(() => chip(page, '模型').innerText()).toContain('fake-model')
        await shot(page, `chip-picked-${width}-${theme}`)
      } else await expect.poll(() => chip(page, '模型').innerText()).toBe('fake-model')
      await page.context().close()
    }
  })
  it('lists the service Codex speaks under Latch 网关, starts on its model, and sends the turn through Latch', async () => {
    const page = await open(1440, 'light')
    await chip(page, '模型').click()
    // The rail names the gateway alone, whatever services it has: its tooltip is its name and that it is experimental.
    await sourceTab(page, GATEWAY).waitFor()
    expect(await reason(sourceTab(page, GATEWAY))).toBe('Latch 网关 · 实验性')
    expect(
      await layer(page)
        .getByRole('tab', { name: /经 Latch|OpenAI|DeepSeek|Relay/u })
        .count(),
    ).toBe(0)
    // Chat is available through the implemented conversion, so no saved service is left that Codex cannot use.
    const chatGroup = await service(page, 'DeepSeek')
    expect(await chatGroup.getByRole('menuitemradio', { name: 'fake-model-large', exact: true }).getAttribute('aria-disabled')).toBeNull()
    expect(await shownText(page, /个服务用不了/u).count()).toBe(0)
    expect(await shownText(page, /尚未实现/u).count()).toBe(0)
    await service(page, 'Relay')
    await expect.poll(() => row(page, 'deepseek-v3').getAttribute('aria-disabled')).toBe('true')
    expect(await reason(row(page, 'deepseek-v3'))).toBe('Codex 不认识这个模型')
    // Options only: where a service's requests go and with whose key is on its heading, on hover; a browser names
    // the computer where the Latch app on it says 这台 Mac. Each heading is the service's name and its 实验性 mark.
    expect(await shownText(page, /经 Latch( 网关)?转发|协议转换 · 实验性|请求由 Latch/u).count()).toBe(0)
    const headings = await layer(page).locator('.ui-board-section .ui-board-heading').filter({ visible: true }).allInnerTexts()
    expect(headings.map(text => text.replace(/\s+/gu, '')).sort()).toEqual(['DeepSeek实验性', 'OpenAI实验性', 'Relay实验性'])
    await service(page, 'DeepSeek')
    expect(await chatGroup.getAttribute('aria-description')).toMatch(/^请求由 Latch 在 \S+ 上转发，用设置里的密钥。协议转换，实验性：/u)
    await shot(page, 'draft-menu-1440-light')
    await service(page, 'OpenAI')
    await row(page, 'fake-model-large').click()
    await expect.poll(() => chip(page, '模型').innerText()).toBe('fake-model-large')
    await page.reload()
    await connected(page)
    // The pick is Codex's own and stays across a reload.
    await expect.poll(() => chip(page, '模型').innerText()).toBe('fake-model-large')

    await input(page).fill('model 你好')
    await sendDraft(page)
    await page.locator('.transcript').getByText('model: 经过 Latch 的回复', { exact: true }).first().waitFor({ timeout: 20_000 })
    const detail = await latest()
    expect(detail.summary.modelRoute).toEqual({ providerId: openai.id, model: 'fake-model-large', name: 'OpenAI' })
    expect(detail.config?.find(option => option.category === 'model')?.currentValue).toBe('fake-model-large')
    // The turn carries what the gateway counted of the Responses reply: its model and its tokens.
    expect(detail.messages.find(message => message.role === 'user')?.turn?.routed).toEqual({
      requests: 1,
      chosen: 'fake-model-large',
      models: [
        {
          model: 'fake-model-large',
          used: 'fake-model-large',
          requests: 1,
          measured: 1,
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, reasoningTokens: 0 },
        },
      ],
    })
    // The service received its own key; the agent's environment and messages never held it.
    expect(models.requests.map(request => [request.wire, request.model, request.key])).toEqual([['responses', 'fake-model-large', KEY]])
    expect(await readFile(log, 'utf8')).not.toContain(KEY)
    expect(JSON.stringify(detail)).not.toMatch(/lmg1\./u)

    // In the session the menu lists what a new one does: Codex's own models and every service's, its own checked.
    await chip(page, '模型').click()
    // The panel opens on the session's own source, marked on the rail.
    const session = layer(page).getByRole('group', { name: 'OpenAI', exact: true })
    expect(await session.getByRole('menuitemradio', { name: 'Fake-model-large', exact: true }).getAttribute('aria-checked')).toBe('true')
    expect(await session.getAttribute('aria-description')).toMatch(/^请求由 Latch 在 \S+ 上转发，用设置里的密钥。$/u)
    expect(await sourceTab(page, GATEWAY).getAttribute('data-current')).toBe('')
    await shot(page, 'session-menu-1440-light')
    for (const name of ['DeepSeek', 'Relay'])
      expect(
        await (await service(page, name)).getByRole('menuitemradio', { name: 'fake-model', exact: true }).getAttribute('aria-disabled'),
      ).toBeNull()
    await source(page, 'Codex')
    await row(page, /GPT Own/u).waitFor()
    expect(await shownText(page, /经 Latch 用「|开始后不能换服务/u).count()).toBe(0)
    // A route that works is said in the menu alone: a session's input has no line under it.
    expect(await page.locator('form.composer .composer-status, form.composer .composer-notice[data-tint="warn"]').count()).toBe(0)
    await page.keyboard.press('Escape')

    // The service turned off: its token stops, and the next turn says why instead of using Codex's own login.
    expect((await owner.request(`providers/${openai.id}`, { method: 'PUT', body: { enabled: false } })).status).toBe(200)
    // The menu says so by the service's name before anything is sent, and offers no model of it.
    await chip(page, '模型').click()
    await sourceTab(page, GATEWAY).waitFor()
    await layer(page).getByRole('group', { name: 'OpenAI · 已停用', exact: true }).waitFor()
    // A route the next turn fails on is the one thing said under the input, in amber.
    await expect
      .poll(() => page.locator('form.composer .composer-notice[data-tint="warn"]').filter({ visible: true }).first().innerText())
      .toContain('下一轮会失败：模型服务')
    await menuText(page, '这个会话开始时用的「OpenAI」已停用，下一轮会失败。在设置 › 模型里重新打开它，或新开一个会话。').waitFor()
    await expect
      .poll(() =>
        layer(page)
          .getByRole('group', { name: 'OpenAI · 已停用', exact: true })
          .getByRole('menuitemradio', { name: /^Fake-model-large/u })
          .getAttribute('aria-disabled'),
      )
      .toBe('true')
    expect(await shownText(page, /经 Latch 用|openai · /u).count()).toBe(0)
    await shot(page, 'service-off-menu-1440-light')
    await page.keyboard.press('Escape')
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

    // Another service, picked in the same menu: the idle agent restarts on its route and resumes the same session.
    await chip(page, '模型').click()
    await (await service(page, 'Relay')).getByRole('menuitemradio', { name: 'fake-model', exact: true }).click()
    await page.locator('.transcript').getByText('模型改为 fake-model · 经 Latch · Relay', { exact: true }).waitFor({ timeout: 20_000 })
    await expect.poll(() => chip(page, '模型').innerText()).toBe('Fake-model')
    await shot(page, 'moved-service-1440-light')
    await composer.fill('model 第四轮')
    await composer.press('Meta+Enter')
    await expect.poll(() => models.requests.length, { timeout: 20_000 }).toBe(3)
    expect(models.requests.at(-1)).toMatchObject({ wire: 'responses', model: 'fake-model', key: KEY })
    expect((await latest()).summary.modelRoute).toMatchObject({ model: 'fake-model', name: 'Relay' })
    await page.context().close()
  })
})

/**
 * What a turn sent through Latch, as the gateway counted it: the service's own tokens on the turn, the requests by model,
 * and the chosen model beside the one the service said answered when they differ. Across a reload, on a phone, in the dark.
 */
describe('a turn through Latch shows what the service said it used', () => {
  let directory: string
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let models: FakeModels

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'latch-e2e-gateway-usage-'))
    models = await startFakeModels({
      replies: [
        { text: '第一轮的回复' },
        { text: '换了模型的回复', answeredBy: 'fake-model-preview' },
        // A 5xx is tried twice more at the same service before the turn fails: the service stays down for all three.
        { error: { status: 500, message: 'upstream down' } },
        { error: { status: 500, message: 'upstream down' } },
        { error: { status: 500, message: 'upstream down' } },
        // The service keeps the stream open after the last event; the agent ends its turn without waiting for it.
        { text: '流还开着的回复', lingerMs: 60_000 },
      ],
    })
    const bin = join(directory, 'bin')
    await mkdir(bin)
    // OpenCode's preset on the fake agent: pointed at the gateway by what its launch is given.
    await writeFile(
      join(bin, 'opencode'),
      [
        '#!/bin/sh',
        `if [ "$1" = '--version' ]; then echo '2.2.6'; exit 0; fi`,
        `export FAKE_ACP_STATE='${join(directory, 'state.json')}' FAKE_ACP_LOG='${join(directory, 'agent.log')}'`,
        'export FAKE_ACP_MODES=plan,build,auto-edit,yolo FAKE_ACP_INITIAL_MODE=build FAKE_ACP_CONFIG=options',
        'export FAKE_ACP_GATEWAY=opencode FAKE_ACP_VERSION=2.2.6 FAKE_ACP_CAPS=resume',
        `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
      ].join('\n'),
    )
    await chmod(join(bin, 'opencode'), 0o755)
    host = await startTestHost({
      demo: false,
      sessionFolders: true,
      detectPreset: preset => (preset.id === 'opencode' ? { found: true, path: join(bin, 'opencode') } : { found: false }),
      commandDirectories: () => [bin],
    })
    owner = await host.enroll({ listener: 'unix' })
    // Saved on this Mac with its confirmation: a page elsewhere is offered no preset, only saved definitions. The fake
    // speaks ACP, so the definition is `opencode acp`: the preset's own args start `opencode serve` since 8427ab3f.
    expect((await owner.confirmed('agents', { body: { ...savedPreset('opencode'), args: ['acp'] } })).status).toBe(201)
    const created = await owner.confirmed('providers', {
      method: 'POST',
      body: {
        name: 'MyService',
        kind: 'openai-responses',
        baseURL: `${models.origin}/v1`,
        apiKey: KEY,
        models: ['fake-model', 'fake-model-large'],
        defaultModel: 'fake-model',
        confirmOrigin: true,
      },
    })
    expect(created.status).toBe(201)
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
  const turn = (page: Page, index: number) => page.locator('.transcript .turn').nth(index)

  it('puts the tokens and requests on each turn, and says when the service answered with another model', async () => {
    const page = await open(1440, 'light')
    await chip(page, '模型').click()
    await pickModel(page, 'fake-model')
    await input(page).fill('model 第一轮')
    await sendDraft(page)
    await page.locator('.transcript').getByText('model: 第一轮的回复', { exact: true }).waitFor({ timeout: 20_000 })
    const composer = page.getByRole('textbox', { name: '继续对话', exact: true })
    await composer.fill('model 第二轮')
    await composer.press('Meta+Enter')
    await page.locator('.transcript').getByText('model: 换了模型的回复', { exact: true }).waitFor({ timeout: 20_000 })
    await composer.fill('model 第三轮')
    await composer.press('Meta+Enter')
    await page
      .locator('.transcript')
      .getByText(/^model error 500/u)
      .waitFor({ timeout: 30_000 })

    // The first turn: the service's tokens and one request, no second model named.
    await turn(page, 0).hover()
    const first = turn(page, 0).locator('.turn-footer')
    await expect.poll(() => first.innerText()).toContain('输入 10 tokens')
    expect(await first.innerText()).toContain('输出 5 tokens')
    expect(await turn(page, 0).locator('.assistant-meta-chosen').count()).toBe(0)
    // The second: the service said another model answered, so the author line says both.
    const second = turn(page, 1)
    await second.locator('.assistant-meta-chosen').getByText('选的是 fake-model', { exact: true }).waitFor()
    expect(await second.locator('.assistant-meta-model').innerText()).toBe('fake-model-preview')
    // 请求记录 is an ⓘ whose tooltip lists the requests, never something to press (00d98cb1).
    await second.hover()
    const requests = page.locator('.ui-tooltip:popover-open')
    await second.getByRole('img', { name: '请求记录', exact: true }).hover()
    await requests
      .getByText('fake-model：1 次，服务说用的是 fake-model-preview · 输入 10 tokens · 输出 5 tokens', { exact: true })
      .waitFor()
    await shot(page, 'usage-1440-light')
    await page.mouse.move(0, 0)
    await requests.waitFor({ state: 'hidden' })
    // The third: the service failed, so there are no tokens to show and the request did not complete.
    const third = turn(page, 2)
    await third.hover()
    await third.locator('.turn-fact', { hasText: '经 Latch 网关 1 次请求' }).hover()
    const tip = page.locator('.ui-tooltip:popover-open')
    await tip.getByText('fake-model：1 次，1 次没有完成', { exact: true }).waitFor()
    await shot(page, 'usage-failed-1440-light')
    expect(await third.locator('.turn-footer').innerText()).not.toContain('输入')
    // The fourth: the turn ended on the reply's last event while the service still held the stream open.
    await composer.fill('model 第四轮')
    await composer.press('Meta+Enter')
    await page.locator('.transcript').getByText('model: 流还开着的回复', { exact: true }).waitFor({ timeout: 20_000 })
    const fourth = turn(page, 3)
    await fourth.hover()
    await expect.poll(() => fourth.locator('.turn-footer').innerText(), { timeout: 10_000 }).toContain('输入 10 tokens')
    await fourth.getByRole('img', { name: '请求记录', exact: true }).hover()
    await requests.getByText('fake-model：1 次 · 输入 10 tokens · 输出 5 tokens', { exact: true }).waitFor()
    expect(await requests.innerText()).not.toContain('没有')
    // The session does not wait for the stream the service still holds.
    await expect.poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks[0]?.status, { timeout: 10_000 }).toBe('idle')
    // The list shows a status for at least a second, so after a turn this short it says so a moment later.
    await expect.poll(() => shownText(page, '运行中', { exact: true }).count(), { timeout: 10_000 }).toBe(0)
    await shot(page, 'usage-lingering-1440-light')

    // The record is the Host's: the same after a reload, and it holds no text of the turns.
    await page.reload()
    await connected(page)
    await turn(page, 1).locator('.assistant-meta-chosen').getByText('选的是 fake-model', { exact: true }).waitFor()
    const [task] = (await owner.json<AppSnapshot>('snapshot')).tasks
    const detail = await owner.json<TaskDetail>(`tasks/${task!.id}`)
    const routed = detail.messages.filter(message => message.role === 'user').map(message => message.turn?.routed)
    expect(routed).toEqual([
      {
        requests: 1,
        chosen: 'fake-model',
        models: [
          {
            model: 'fake-model',
            used: 'fake-model',
            requests: 1,
            measured: 1,
            usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, reasoningTokens: 0 },
          },
        ],
      },
      {
        requests: 1,
        chosen: 'fake-model',
        models: [
          {
            model: 'fake-model',
            used: 'fake-model-preview',
            requests: 1,
            measured: 1,
            usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, reasoningTokens: 0 },
          },
        ],
      },
      { requests: 1, chosen: 'fake-model', models: [{ model: 'fake-model', requests: 1, failed: 1 }] },
      {
        requests: 1,
        chosen: 'fake-model',
        models: [
          {
            model: 'fake-model',
            used: 'fake-model',
            requests: 1,
            measured: 1,
            usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, reasoningTokens: 0 },
          },
        ],
      },
    ])
    expect(JSON.stringify(routed)).not.toMatch(/第.轮|回复|lmg1\./u)
    await page.context().close()

    for (const [width, theme] of [
      [1440, 'dark'],
      [390, 'light'],
      [390, 'dark'],
    ] as const) {
      const view = await open(width, theme)
      await openSession(view, task!.id)
      await turn(view, 1).locator('.assistant-meta-chosen').waitFor()
      await turn(view, 1).click({ position: { x: 4, y: 4 } })
      await noHorizontalOverflow(view)
      await shot(view, `usage-${width}-${theme}`)
      await view.context().close()
    }
  })
})
