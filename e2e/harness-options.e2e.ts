import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

const OUTPUT = 'test-results/harness-options'

/** Each level's own sentence, the same in Codex's list and in the sessions the fake agent opens. */
const LEVELS: Record<string, string> = {
  low: 'Prefer for routine or latency-sensitive tasks.',
  high: 'The default balance for most tasks.',
  max: 'Reserve for the hardest quality-first tasks.',
}
const effort = (reasoningEffort: string) => ({ reasoningEffort, description: LEVELS[reasoningEffort]! })
/** What Codex's own model list says, in the shape the session's options take after it. */
const CODEX_MODELS = JSON.stringify([
  {
    id: 'small',
    displayName: 'Small',
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [effort('low'), effort('high')],
  },
  {
    id: 'large',
    displayName: 'Large',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [effort('low'), effort('high'), effort('max')],
  },
])

/** A Harness's own models, thinking and modes, chosen in a draft from what it listed or its last session offered. */
describe("choosing a Harness's own options before the first message", () => {
  let directory: string
  let models: string
  let log: string
  let host: TestHost
  let owner: TestDevice
  let browser: Browser

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'latch-e2e-options-'))
    models = join(directory, 'models')
    log = join(directory, 'agent.log')
    const bin = join(directory, 'bin')
    await mkdir(bin)
    for (const name of ['codex', 'codex-acp']) {
      await writeFile(
        join(bin, name),
        [
          '#!/bin/sh',
          `export FAKE_ACP_STATE='${join(directory, 'state.json')}' FAKE_ACP_LOG='${log}' FAKE_ACP_MODELS_FILE='${models}'`,
          'export FAKE_ACP_MODES=read-only,workspace-write,agent,agent-full-access FAKE_ACP_INITIAL_MODE=read-only FAKE_ACP_CONFIG=options',
          `export FAKE_ACP_EFFORT_BY_MODEL=1 FAKE_ACP_EFFORT_ID=reasoning_effort FAKE_ACP_EFFORT_DESCRIPTIONS=1 FAKE_CODEX_MODELS='${CODEX_MODELS}'`,
          `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
        ].join('\n'),
      )
      await chmod(join(bin, name), 0o755)
    }
    host = await startTestHost({
      demo: false,
      sessionFolders: true,
      detectPreset: preset => (preset.id === 'codex' ? { found: true, path: join(bin, 'codex-acp') } : { found: false }),
      // Only this directory: no agent installed on the computer running the test is ever found.
      commandDirectories: () => [bin],
    })
    owner = await host.enroll({ listener: 'unix' })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
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
  const shot = (page: Page, name: string) => page.screenshot({ path: `${OUTPUT}/${name}.png`, animations: 'disabled' })
  const input = (page: Page) => page.getByRole('textbox', { name: '新会话消息', exact: true })
  const chip = (page: Page, name: string): Locator => page.getByRole('button', { name: new RegExp(`^${name}：`, 'u') }).first()
  const send = async (page: Page, text: string) => {
    await input(page).fill(text)
    await input(page).press('Meta+Enter')
    // With no project yet, sending asks where; a new empty folder is fine here.
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
    await page
      .locator('.transcript')
      .getByText(`echo: ${text}`, { exact: true })
      .first()
      .waitFor({ timeout: 20_000 })
      .catch(async (error: unknown) => {
        await shot(page, `failed-send-${text}`)
        throw error
      })
  }
  const startNew = async (page: Page) => {
    for (const button of await page.getByRole('button', { name: '新建会话', exact: true }).all()) {
      if (await button.isVisible()) {
        await button.click()
        break
      }
    }
    await input(page).waitFor()
  }
  const latest = async () => {
    const tasks = (await owner.json<AppSnapshot>('snapshot')).tasks.toSorted((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
    return owner.json<TaskDetail>(`tasks/${tasks.at(-1)!.id}`)
  }
  const current = (detail: TaskDetail, id: string) => detail.config?.find(option => option.id === id)?.currentValue
  /** A row of an open picker; a searchable one lists its rows as options. */
  const row = (page: Page, name: RegExp | string) =>
    page.getByRole('menuitemradio', { name }).or(page.getByRole('option', { name })).or(page.getByRole('radio', { name })).first()

  it("reads Codex's own list when its menu first opens, then lists what a session offered, and starts on the picks", async () => {
    const page = await open(1440, 'light')
    await expect.poll(() => chip(page, '模型').innerText()).toContain('默认模型')
    await expect.poll(() => chip(page, '思考').getAttribute('aria-label')).toBe('思考：默认')
    // The four controls carry their names for the keys that open them, in a draft as in a session.
    await expect
      .poll(() =>
        page
          .locator('.composer-stack [data-composer-control]')
          .evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.composerControl)),
      )
      .toEqual(['harness', 'model', 'thinking', 'permission'])
    const agent = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
    expect(await agent()).toEqual([])
    // Codex's own model list says nothing of its modes, so 权限 reads nothing and says they come with the session.
    await chip(page, '权限').click()
    await page
      .locator('.permission-list-note')
      .getByText('发第一条消息后可以换：Codex 开始会话时才给出其他几项。', { exact: true })
      .waitFor()
    await shot(page, 'permission-before-read-1440-light')
    await page.keyboard.press('Escape')
    expect(await agent()).toEqual([])
    // Opening the menu of a Harness nothing is known of reads its list: Codex's own model list, with no session.
    await chip(page, '模型').click()
    await page.getByText(/^读取于 /u).waitFor()
    await row(page, /Large/u).waitFor()
    await shot(page, 'read-1440-light')
    expect((await agent()).filter(line => line.includes('"session/new"'))).toEqual([])
    expect((await agent()).filter(line => line.includes('"model/list"')).length).toBe(1)
    await page.keyboard.press('Escape')
    // Opening it again reads nothing more.
    await chip(page, '模型').click()
    await page.keyboard.press('Escape')
    expect((await agent()).filter(line => line.includes('"model/list"')).length).toBe(1)

    await send(page, '第一轮')
    await startNew(page)
    // What the first session offered, before anything is sent.
    await expect.poll(() => chip(page, '模型').innerText()).toContain('Small')
    await expect.poll(() => chip(page, '思考').innerText()).toContain('Low')
    await expect.poll(() => chip(page, '权限').innerText()).toContain('先问你')
    await chip(page, '模型').click()
    await row(page, /Large/u).waitFor()
    await page.getByText(/^来自上次会话 · /u).waitFor()
    expect(await page.getByText('开始后才报告', { exact: false }).count()).toBe(0)
    await shot(page, 'listed-1440-light')
    await row(page, /Large/u).click()
    // Codex's list said what thinking Large offers, so 思考 says it before any session ran on Large.
    await expect.poll(() => chip(page, '模型').innerText()).toContain('Large')
    await expect.poll(() => chip(page, '思考').innerText()).toContain('Low')
    await chip(page, '思考').click()
    await row(page, /^Max/u).waitFor()
    await shot(page, 'large-thinking-1440-light')
    await page.keyboard.press('Escape')

    // Four modes: the menu lists three, and the one between them waits under 更多, which folds again.
    await chip(page, '权限').click()
    await row(page, /由模型判断/u).waitFor()
    expect(await row(page, /按规则放行/u).count()).toBe(0)
    const more = page.locator('.permission-list-more')
    await more.click()
    await expect.poll(() => more.getAttribute('aria-expanded')).toBe('true')
    await shot(page, 'permission-more-1440-light')
    await more.click()
    await expect.poll(() => row(page, /按规则放行/u).count()).toBe(0)
    // Left open, 更多 is folded again the next time 权限 opens.
    await more.click()
    await row(page, /按规则放行/u).waitFor()
    await page.keyboard.press('Escape')
    await chip(page, '权限').click()
    await row(page, /由模型判断/u).waitFor()
    expect(await row(page, /按规则放行/u).count()).toBe(0)
    expect(await more.getAttribute('aria-expanded')).toBe('false')
    await more.click()
    await row(page, /按规则放行/u).click()
    await expect.poll(() => chip(page, '权限').innerText()).toContain('按规则放行')
    await page.keyboard.press('Escape')
    await shot(page, 'picked-1440-light')

    await send(page, '第二轮')
    const second = await latest()
    expect(current(second, 'model')).toBe('large')
    expect(current(second, 'mode')).toBe('workspace-write')
    expect((await agent()).filter(line => line.includes('"session/set_config_option"')).length).toBeGreaterThanOrEqual(2)

    // The model, its thinking and the mode the person picked stay picked for the next draft.
    await startNew(page)
    await expect.poll(() => chip(page, '模型').innerText()).toContain('Large')
    await expect.poll(() => chip(page, '思考').innerText()).toContain('Low')
    await expect.poll(() => chip(page, '权限').innerText()).toContain('按规则放行')
    await chip(page, '思考').click()
    // A session ran on Large, so its own levels are known now, each with its own words under it.
    for (const level of ['low', 'high', 'max']) await page.getByText(LEVELS[level]!, { exact: true }).waitFor()
    await shot(page, 'thinking-described-1440-light')
    await row(page, /^High/u).click()
    await expect.poll(() => chip(page, '思考').innerText()).toContain('High')
    expect(await chip(page, '模型').innerText()).toContain('Large')
    await page.reload()
    await connected(page)
    await expect.poll(() => chip(page, '模型').innerText()).toContain('Large')
    await expect.poll(() => chip(page, '思考').innerText()).toContain('High')
    await expect.poll(() => chip(page, '权限').innerText()).toContain('按规则放行')
    await noHorizontalOverflow(page)
    await page.context().close()
  })

  it('fails the turn with the model it no longer offers, and goes on once another is picked', async () => {
    await writeFile(models, 'small')
    // Another browser: its own picks. The list still has Large, from the last session.
    const page = await open(1440, 'dark')
    await chip(page, '模型').click()
    await shot(page, 'listed-1440-dark')
    await row(page, /Large/u).click()
    await expect.poll(() => chip(page, '模型').innerText()).toContain('Large')
    await expect.poll(() => chip(page, '思考').innerText()).toContain('Low')
    await chip(page, '思考').click()
    await row(page, /^High/u).click()
    await expect.poll(() => chip(page, '思考').innerText()).toContain('High')
    await chip(page, '权限').click()
    await page.locator('.permission-list-more').click()
    await row(page, /按规则放行/u).click()
    await page.keyboard.press('Escape')
    await input(page).fill('第三轮')
    await input(page).press('Meta+Enter')
    // With no project yet, sending asks where; a new empty folder is fine here.
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
    await page
      .getByText('Codex 现在没有模型「Large」，这条消息没有发出。再发送会用「Small」，也可以先在模型里换一个。')
      .first()
      .waitFor({ timeout: 20_000 })
    await shot(page, 'model-gone-1440-dark')
    // The session shows what it runs on now, the rest of the draft with it, and a retry runs on that.
    await expect.poll(() => chip(page, '模型').innerText()).toContain('Small')
    await expect.poll(() => chip(page, '思考').innerText()).toContain('High')
    await expect.poll(() => chip(page, '权限').innerText()).toContain('按规则放行')
    await page.getByRole('button', { name: '重试', exact: true }).first().click()
    await page.locator('.transcript').getByText('echo: 第三轮', { exact: true }).first().waitFor({ timeout: 20_000 })
    const retried = await latest()
    expect([current(retried, 'model'), current(retried, 'reasoning_effort'), current(retried, 'mode')]).toEqual([
      'small',
      'high',
      'workspace-write',
    ])
    await expect.poll(async () => (await latest()).summary.status).toBe('idle')
    await page.waitForTimeout(1500)
    await shot(page, 'model-gone-recovered-1440-dark')
    // The next draft has caught up with what the agent offers.
    await startNew(page)
    await expect.poll(() => chip(page, '模型').innerText()).toContain('Small')
    await chip(page, '模型').click()
    expect(await row(page, /Large/u).count()).toBe(0)
    await page.keyboard.press('Escape')
    await page.context().close()
    await rm(models)
  })

  it('starts on a model ID typed for the Harness, and forgets it once removed', async () => {
    const page = await open(1280, 'dark')
    await chip(page, '模型').click()
    await page.getByText('填写模型 ID…', { exact: true }).click()
    await page.getByRole('textbox', { name: '模型 ID' }).fill('vendor/typed')
    await shot(page, 'typed-panel-1280-dark')
    await page.getByRole('button', { name: '添加并选用' }).click()
    await expect.poll(() => chip(page, '模型').innerText()).toContain('vendor/typed')
    await send(page, '第四轮')
    expect(current(await latest(), 'model')).toBe('vendor/typed')
    await startNew(page)
    await chip(page, '模型').click()
    await row(page, /vendor\/typed/u).waitFor()
    await page.getByText('填写模型 ID…', { exact: true }).click()
    await page.getByRole('button', { name: '移除 vendor/typed' }).click()
    await expect
      .poll(async () => (await owner.json<AppSnapshot>('snapshot')).catalog!.harnesses.find(item => item.id === 'codex')?.customModels)
      .toBeUndefined()
    await page.context().close()
  })

  it('sends a message after the thinking picked a moment before, so its turn runs on it', async () => {
    const page = await open(1440, 'light')
    await send(page, '第五轮')
    const session = await latest()
    expect(current(session, 'reasoning_effort')).toBe('low')
    const order: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && /\/tasks\/[^/]+\/prompt$/u.test(request.url())) order.push('prompt sent')
    })
    page.on('response', response => {
      if (response.request().method() === 'POST' && /\/tasks\/[^/]+\/config$/u.test(response.url())) order.push('config answered')
    })
    // The change takes a while to reach the Host; the message must not overtake it.
    await page.route(/\/tasks\/[^/]+\/config$/u, async route => {
      await new Promise(resolve => setTimeout(resolve, 1500))
      await route.continue()
    })
    // In a session too, each control carries its name.
    expect(
      await page
        .locator('.composer-stack [data-composer-control]')
        .evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.composerControl)),
    ).toEqual(['harness', 'model', 'thinking', 'permission'])
    await chip(page, '思考').click()
    await row(page, /^High/u).click()
    const next = page.getByRole('textbox', { name: '继续对话', exact: true })
    await next.fill('第六轮')
    await next.press('Meta+Enter')
    await page.locator('.transcript').getByText('echo: 第六轮', { exact: true }).first().waitFor({ timeout: 20_000 })
    await shot(page, 'thinking-then-send-1440-light')
    expect(order).toEqual(['config answered', 'prompt sent'])
    const after = await owner.json<TaskDetail>(`tasks/${session.summary.id}`)
    expect(current(after, 'reasoning_effort')).toBe('high')
    expect(await page.getByText('结果未知', { exact: false }).count()).toBe(0)
    await expect.poll(() => chip(page, '思考').innerText()).toContain('High')
    await page.context().close()
  })

  it('resends a turn after the thinking picked a moment before, so the retry runs on it', async () => {
    const page = await open(1440, 'dark')
    await send(page, '第七轮')
    const session = await latest()
    expect(current(session, 'reasoning_effort')).toBe('low')
    const order: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && /\/tasks\/[^/]+\/prompt$/u.test(request.url())) order.push('prompt sent')
    })
    page.on('response', response => {
      if (response.request().method() === 'POST' && /\/tasks\/[^/]+\/config$/u.test(response.url())) order.push('config answered')
    })
    await page.route(/\/tasks\/[^/]+\/config$/u, async route => {
      await new Promise(resolve => setTimeout(resolve, 1500))
      await route.continue()
    })
    await chip(page, '思考').click()
    await row(page, /^High/u).click()
    const transcript = page.locator('.transcript')
    await transcript.getByText('echo: 第七轮', { exact: true }).hover()
    await transcript.getByRole('button', { name: '重试', exact: true }).last().click()
    await expect.poll(() => transcript.getByText('echo: 第七轮', { exact: true }).count(), { timeout: 20_000 }).toBe(2)
    await shot(page, 'thinking-then-retry-1440-dark')
    expect(order).toEqual(['config answered', 'prompt sent'])
    const after = await owner.json<TaskDetail>(`tasks/${session.summary.id}`)
    expect(current(after, 'reasoning_effort')).toBe('high')
    expect(after.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['第七轮', '第七轮'])
    expect(await page.getByText('结果未知', { exact: false }).count()).toBe(0)
    expect(await page.getByText('设置未能切换', { exact: false }).count()).toBe(0)
    await page.context().close()
  })

  for (const theme of ['light', 'dark'] as const)
    it(`lists the same on a phone, ${theme}`, async () => {
      const page = await open(390, theme)
      const sheetOpen = page.getByRole('button', { name: '新建会话', exact: true })
      for (const button of await sheetOpen.all()) {
        if (await button.isVisible()) {
          await button.click()
          break
        }
      }
      const sheet = page.locator('.new-session-sheet')
      await sheet.waitFor()
      await sheet
        .getByText(/列表来自上次会话|Small/u)
        .first()
        .waitFor()
      expect(await sheet.getByText('开始后可以换', { exact: false }).count()).toBe(0)
      await shot(page, `sheet-390-${theme}`)
      await sheet.getByRole('button', { name: /^权限/u }).click()
      await page.getByText('由模型判断', { exact: true }).waitFor()
      expect(await page.getByText('按规则放行', { exact: true }).count()).toBe(0)
      await page.getByRole('button', { name: '更多', exact: true }).click()
      await page.getByText('按规则放行', { exact: true }).waitFor()
      await shot(page, `sheet-permission-390-${theme}`)
      // Closed with the rest shown, the next opening shows the main rows again.
      const picker = page.getByRole('dialog', { name: '权限' })
      await picker.getByRole('button', { name: '取消', exact: true }).click()
      await picker.waitFor({ state: 'hidden' })
      await sheet.getByRole('button', { name: /^权限/u }).click()
      await page.getByText('由模型判断', { exact: true }).waitFor()
      await expect.poll(() => page.getByText('按规则放行', { exact: true }).count()).toBe(0)
      await page.getByRole('button', { name: '更多', exact: true }).click()
      await page.getByText('按规则放行', { exact: true }).click()
      await expect.poll(() => sheet.getByRole('button', { name: /^权限/u }).innerText()).toContain('按规则放行')
      await noHorizontalOverflow(page)
      await page.context().close()
    })
})

/** A Harness Latch has no permission profile for: only a read or a session says what modes it has. */
describe('opening 权限 first on a Harness that declares no modes', () => {
  let directory: string
  let host: TestHost
  let owner: TestDevice
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
  })
  // A Host each, so the agent each case saves is the only one and the draft starts on it without anything choosing it.
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'latch-e2e-permission-read-'))
    host = await startTestHost({
      demo: false,
      detectPreset: () => ({ found: false }),
      // Only this empty directory: no agent installed on the computer running the test is ever found.
      commandDirectories: () => [directory],
    })
    owner = await host.enroll({ listener: 'unix' })
    const saved = await owner.request('agents', {
      method: 'POST',
      body: {
        id: 'generic',
        name: 'Generic',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'ask,auto', FAKE_ACP_INITIAL_MODE: 'ask' },
      },
    })
    expect(saved.status).toBe(201)
    const harness = await generic()
    expect(harness).toMatchObject({ level: 'L3', catalogueRead: { when: 'select' } })
    expect(harness?.permission).toBeUndefined()
    expect(harness?.catalogue).toBeUndefined()
  })
  afterEach(async () => {
    await host?.close()
    await rm(directory, { recursive: true, force: true })
  })

  const generic = async () => (await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(item => item.id === 'generic')
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
  const shot = (page: Page, name: string) => page.screenshot({ path: `${OUTPUT}/${name}.png`, animations: 'disabled' })
  /** A row of the open 权限 menu or sheet. */
  const mode = (page: Page, name: string) =>
    page
      .getByRole('menuitemradio', { name, exact: true })
      .or(page.getByRole('option', { name, exact: true }))
      .or(page.getByRole('radio', { name, exact: true }))
      .first()

  it('reads its modes on a phone and offers them before the first message', async () => {
    const page = await open(390, 'dark')
    try {
      for (const button of await page.getByRole('button', { name: '新建会话', exact: true }).all()) {
        if (await button.isVisible()) {
          await button.click()
          break
        }
      }
      const sheet = page.locator('.new-session-sheet')
      await sheet.waitFor()
      expect(await sheet.getByRole('button', { name: /^Harness：/u }).getAttribute('aria-label')).toBe('Harness：Generic')
      const permission = sheet.getByRole('button', { name: /^权限：/u })
      await expect.poll(() => permission.getAttribute('aria-label')).toBe('权限：读取后可以选')
      expect(await page.getByText('开始后才告诉 Latch', { exact: false }).count()).toBe(0)
      await shot(page, 'permission-before-read-390-dark')
      // Only 权限 is opened: the model row never is.
      await permission.click()
      await expect.poll(async () => (await generic())?.catalogue, { timeout: 20_000 }).toMatchObject({ source: 'check' })
      await mode(page, 'auto')
        .waitFor()
        .catch(async (error: unknown) => {
          await shot(page, 'failed-permission-read-390-dark')
          throw error
        })
      await shot(page, 'permission-read-390-dark')
      await mode(page, 'auto').click()
      await expect.poll(() => permission.getAttribute('aria-label')).toBe('权限：auto')
      await noHorizontalOverflow(page)
    } finally {
      await page.context().close()
    }
  })

  it('reads its modes on a desktop when 权限 opens first', async () => {
    const page = await open(1280, 'light')
    try {
      expect(
        await page
          .getByRole('button', { name: /^Harness：/u })
          .first()
          .getAttribute('aria-label'),
      ).toBe('Harness：Generic')
      const chip = page.getByRole('button', { name: /^权限：/u }).first()
      await expect.poll(() => chip.getAttribute('aria-label')).toBe('权限：读取后可以选')
      await chip.click()
      await expect.poll(async () => (await generic())?.catalogue, { timeout: 20_000 }).toMatchObject({ source: 'check' })
      await mode(page, 'auto').waitFor()
      await expect.poll(() => chip.getAttribute('aria-label')).toBe('权限：ask')
      await shot(page, 'permission-read-1280-light')
    } finally {
      await page.context().close()
    }
  })
})

/** A Harness Latch has a profile for, whose read opens a session and so reports its modes too. */
describe('opening 权限 first on a Harness whose read reports its modes', () => {
  let directory: string
  let log: string
  let host: TestHost
  let browser: Browser

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'latch-e2e-permission-modes-'))
    log = join(directory, 'agent.log')
    const bin = join(directory, 'bin')
    await mkdir(bin)
    await writeFile(
      join(bin, 'gemini'),
      [
        '#!/bin/sh',
        `export FAKE_ACP_STATE='${join(directory, 'state.json')}' FAKE_ACP_LOG='${log}'`,
        'export FAKE_ACP_MODES=plan,default,autoEdit,yolo FAKE_ACP_INITIAL_MODE=default FAKE_ACP_CONFIG=options',
        `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
      ].join('\n'),
    )
    await chmod(join(bin, 'gemini'), 0o755)
    host = await startTestHost({
      demo: false,
      detectPreset: preset => (preset.id === 'gemini' ? { found: true, path: join(bin, 'gemini') } : { found: false }),
      // Only this directory: no agent installed on the computer running the test is ever found.
      commandDirectories: () => [bin],
    })
    const owner = await host.enroll({ listener: 'unix' })
    const offered = (await owner.json<AppSnapshot>('snapshot')).catalog!.harnesses.filter(harness => harness.offer)
    expect(offered.map(harness => [harness.id, harness.catalogueRead])).toEqual([['gemini', { when: 'select', modes: true }]])
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('says it is reading, then offers the modes before the first message', async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      colorScheme: 'dark',
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    try {
      await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
      await connected(page)
      const shot = (name: string) => page.screenshot({ path: `${OUTPUT}/${name}.png`, animations: 'disabled' })
      const sent = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(line => line.includes('"session/new"'))
      expect(
        await page
          .getByRole('button', { name: /^Harness：/u })
          .first()
          .getAttribute('aria-label'),
      ).toBe('Harness：Gemini CLI')
      const chip = page.getByRole('button', { name: /^权限：/u }).first()
      await expect.poll(() => chip.getAttribute('aria-label')).toBe('权限：先问你')
      expect(await sent()).toEqual([])
      // The read takes a moment; until it answers the menu says so.
      await page.route(/\/agents\/[^/]+\/catalogue$/u, async route => {
        await new Promise(resolve => setTimeout(resolve, 1500))
        await route.continue()
      })
      await chip.click()
      await page.locator('.permission-list-note').getByText('正在读取 Gemini CLI 的权限…', { exact: true }).waitFor()
      await shot('permission-reading-1280-dark')
      const rule = page
        .getByRole('menuitemradio', { name: /按规则放行/u })
        .or(page.getByRole('radio', { name: /按规则放行/u }))
        .first()
      await rule.waitFor({ timeout: 20_000 })
      expect(await page.getByText('发第一条消息后可以换', { exact: false }).count()).toBe(0)
      await shot('permission-read-1280-dark')
      expect(await sent()).toHaveLength(1)
      await rule.click()
      await expect.poll(() => chip.getAttribute('aria-label')).toBe('权限：按规则放行')
      await noHorizontalOverflow(page)
    } finally {
      await context.close()
    }
  })
})
