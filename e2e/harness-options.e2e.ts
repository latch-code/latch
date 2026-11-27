import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_PRESETS, type AppSnapshot, type TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, FAKE_CODEX_APP_SERVER, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession, permissionControl, permissionWords } from './helpers/layout.ts'
import { promptValue } from './helpers/prompt.ts'

const OUTPUT = 'test-results/harness-options'
/** The phone's entry on the start page: the same one entry as on a desktop, at the end of the input's line. */
const phonePermission = (page: Page) => permissionControl(page.locator('.workbench-home form.composer'))

const refreshModels = (page: Page) =>
  page.getByRole('menuitem', { name: '刷新模型列表', exact: true }).or(page.getByRole('button', { name: '刷新模型列表', exact: true }))

/** The new draft is the home's input: already in sight, or where 新建会话 leads. */
async function openNew(page: Page) {
  const home = page.locator('.workbench-home')
  if (!(await home.isVisible())) await page.getByRole('button', { name: '新建会话', exact: true }).filter({ visible: true }).first().click()
  await home.getByRole('textbox', { name: '新会话消息', exact: true }).waitFor()
}

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
    // Only the adapter: with no Codex of its own here, choosing the preset saves it on codex-acp, which runs the Codex it
    // ships (here, the fake app-server the fake agent answers as).
    for (const name of ['codex-acp']) {
      await writeFile(
        join(bin, name),
        [
          '#!/bin/sh',
          `export FAKE_ACP_STATE='${join(directory, 'state.json')}' FAKE_ACP_LOG='${log}' FAKE_ACP_MODELS_FILE='${models}' FAKE_ACP_CONFIG_ANSWER_FILE='${join(directory, 'config-answer')}'`,
          'export FAKE_ACP_MODES=read-only,workspace-write,agent,agent-full-access FAKE_ACP_INITIAL_MODE=read-only FAKE_ACP_CONFIG=options FAKE_ACP_CAPS=resume',
          `export FAKE_ACP_EFFORT_BY_MODEL=1 FAKE_ACP_EFFORT_ID=reasoning_effort FAKE_ACP_EFFORT_DESCRIPTIONS=1 FAKE_CODEX_MODELS='${CODEX_MODELS}'`,
          `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
        ].join('\n'),
      )
      await chmod(join(bin, name), 0o755)
    }
    host = await startTestHost({
      demo: false,
      sessionFolders: true,
      hostName: '测试执行电脑',
      detectPreset: preset => (preset.id === 'codex' ? { found: true, path: join(bin, 'codex-acp') } : { found: false }),
      // Only this directory: no agent installed on the computer running the test is ever found.
      commandDirectories: () => [bin],
    })
    owner = await host.enroll({ listener: 'unix' })
    // Saved on this Mac first: a page elsewhere is offered no preset, and nothing reads a definition not confirmed here.
    const preset = AGENT_PRESETS.find(item => item.id === 'codex')!
    const saved = await owner.confirmed('agents', {
      method: 'POST',
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: preset.command, args: preset.args, env: {} },
    })
    expect(saved.status).toBe(201)
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
    await rm(directory, { recursive: true, force: true })
  })
  afterEach(async context => {
    try {
      const snapshot = await owner.json<AppSnapshot>('snapshot')
      const tasks = snapshot.tasks
      if (context.task.result?.state === 'fail') {
        const pages = browser.contexts().flatMap(context => context.pages())
        await Promise.allSettled(
          pages.map(async (page, index) => {
            if (await page.locator('.app-shell').count())
              await page.screenshot({ path: `${OUTPUT}/failure-${index}.png`, animations: 'disabled' })
          }),
        )
      }
      for (const task of tasks.filter(task => task.status === 'running' || task.status === 'waiting-approval'))
        await owner.json(`tasks/${task.id}/cancel`, { method: 'POST', body: { requestId: randomUUID(), runId: task.runId } })
    } finally {
      await Promise.all(browser.contexts().map(context => context.close()))
    }
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
  // 思考 is set in the model's entry: its level stands after the model's name on the one chip, and the chip opens both.
  const chip = (page: Page, name: string): Locator =>
    page.getByRole('button', { name: new RegExp(`^${name === '思考' ? '模型' : name}：`, 'u') }).first()
  /** Opens the entry's panel for a level, unless a model picked a moment ago left it open. */
  const openThinking = async (page: Page) => {
    const entry = chip(page, '思考')
    if ((await entry.getAttribute('aria-expanded')) !== 'true') await entry.click()
  }
  /** Opens the permission's popover beside the Harness, unless it is open already. */
  const openEntry = async (page: Page) => {
    const control = permissionControl(page)
    if ((await control.getAttribute('aria-expanded')) !== 'true') await control.click()
  }
  const send = async (page: Page, text: string) => {
    await input(page).fill(text)
    await input(page).press('Meta+Enter')
    // With no project yet, sending asks where; a new empty folder is fine here.
    const elsewhere = page.getByRole('menuitemradio', { name: /^不选项目/u }).or(page.getByRole('radio', { name: /^不选项目/u }))
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
    await openNew(page)
    await input(page).waitFor()
  }
  const latest = async () => {
    const tasks = (await owner.json<AppSnapshot>('snapshot')).tasks.toSorted((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
    return owner.json<TaskDetail>(`tasks/${tasks.at(-1)!.id}`)
  }
  const current = (detail: TaskDetail, id: string) => detail.config?.find(option => option.id === id)?.currentValue
  /** A row of an open picker; a searchable one lists its rows as options. */
  // The 模型 and 思考 chips open the same panel: the row is the one in the layer that is open, not one fading out.
  const row = (page: Page, name: RegExp | string) =>
    page
      .locator(':popover-open, dialog[open]')
      .getByRole('menuitemradio', { name })
      .or(page.locator(':popover-open, dialog[open]').getByRole('option', { name }))
      .or(page.locator(':popover-open, dialog[open]').getByRole('radio', { name }))
      .filter({ visible: true })
      .first()

  it("reads Codex's own list when its menu first opens, then lists what a session offered, and starts on the picks", async () => {
    const page = await open(1440, 'light')
    await expect.poll(() => chip(page, '模型').innerText()).toContain('默认模型')
    await expect.poll(() => chip(page, '思考').locator('.model-level').innerText()).toBe('默认')
    // The three controls carry their names for the keys that open them, in a draft as in a session.
    await expect
      .poll(() =>
        page
          .locator('.composer-stack [data-composer-control]')
          .filter({ visible: true })
          .evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.composerControl)),
      )
      .toEqual(['harness', 'permission', 'model'])
    const agent = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
    expect(await agent()).toEqual([])
    // The known ladder is available before a read, even though Codex's model/list reports no modes.
    await openEntry(page)
    await row(page, /先问你/u).waitFor()
    await row(page, /由模型判断/u).waitFor()
    await row(page, /不再询问/u).waitFor()
    await row(page, /按规则放行/u).click()
    // The popover stays open on the choice: the control follows it.
    await expect.poll(() => permissionWords(page)).toContain('按规则放行')
    await shot(page, 'permission-before-read-1440-light')
    await page.keyboard.press('Escape')
    expect(await agent()).toEqual([])
    // Opening the menu of a Harness nothing is known of reads its list: Codex's own model list, with no session.
    await chip(page, '模型').click()
    await refreshModels(page).waitFor()
    await row(page, /Large/u).waitFor()
    await shot(page, 'read-1440-light')
    expect((await agent()).filter(line => line.includes('"session/new"'))).toEqual([])
    expect((await agent()).filter(line => line.includes('"model/list"')).length).toBe(1)
    await page.keyboard.press('Escape')
    // A late catalogue must keep the earlier draft choice.
    await expect.poll(() => permissionWords(page)).toContain('按规则放行')
    await openEntry(page)
    await row(page, /先问你/u).click()
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
    await expect.poll(() => permissionWords(page)).toContain('先问你')
    await chip(page, '模型').click()
    await row(page, /Large/u).waitFor()
    await refreshModels(page).waitFor()
    expect(await page.getByText('发第一条消息后可以换', { exact: true }).count()).toBe(0)
    await shot(page, 'listed-1440-light')
    await row(page, /Large/u).click()
    await page.keyboard.press('Escape')
    // Codex's list said what thinking Large offers, so 思考 says it before any session ran on Large.
    await expect.poll(() => chip(page, '模型').innerText()).toContain('Large')
    await expect.poll(() => chip(page, '思考').innerText()).toContain('Low')
    await openThinking(page)
    await row(page, /^Max/u).waitFor()
    await shot(page, 'large-thinking-1440-light')
    await page.keyboard.press('Escape')

    // Four modes, one segment each, tightest first: moving previews a mode's name and line, choosing takes Enter.
    await openEntry(page)
    await expect
      .poll(() =>
        page
          .locator('.ui-mode-strip-option')
          .filter({ visible: true })
          .evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))),
      )
      .toEqual(['先问你', '按规则放行', '由模型判断', '不再询问'])
    await expect.poll(() => page.locator('.ui-mode-strip-name').filter({ visible: true }).innerText()).toBe('先问你')
    // The strip is the popover's one tab stop: from there the arrows preview.
    await page.locator('.permission-panel [role="radio"][aria-checked="true"]').filter({ visible: true }).first().focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => page.locator('.ui-mode-strip-name').filter({ visible: true }).innerText()).toBe('按规则放行')
    expect(await permissionWords(page)).toContain('先问你')
    await shot(page, 'permission-strip-1440-light')
    await page.keyboard.press('Enter')
    await expect.poll(() => permissionWords(page)).toContain('按规则放行')
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
    await expect.poll(() => permissionWords(page)).toContain('按规则放行')
    await openThinking(page)
    // Routine descriptions stay out of the list; every level remains reachable by its own name.
    for (const level of ['Low', 'High', 'Max']) await row(page, new RegExp(`^${level}`, 'u')).waitFor()
    for (const text of Object.values(LEVELS)) expect(await page.getByText(text, { exact: true }).count()).toBe(0)
    await shot(page, 'thinking-compact-1440-light')
    await row(page, /^High/u).click()
    await page.keyboard.press('Escape')
    await expect.poll(() => chip(page, '思考').innerText()).toContain('High')
    expect(await chip(page, '模型').innerText()).toContain('Large')
    await page.reload()
    await connected(page)
    // A reload opens the session that was open; the draft's picks wait on the home, where 新建会话 leads.
    await startNew(page)
    await expect.poll(() => chip(page, '模型').innerText()).toContain('Large')
    await expect.poll(() => chip(page, '思考').innerText()).toContain('High')
    await expect.poll(() => permissionWords(page)).toContain('按规则放行')
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
    await page.keyboard.press('Escape')
    await expect.poll(() => chip(page, '模型').innerText()).toContain('Large')
    await expect.poll(() => chip(page, '思考').innerText()).toContain('Low')
    await openThinking(page)
    await row(page, /^High/u).click()
    await page.keyboard.press('Escape')
    await expect.poll(() => chip(page, '思考').innerText()).toContain('High')
    await openEntry(page)
    await row(page, /按规则放行/u).click()
    await page.keyboard.press('Escape')
    await input(page).fill('第三轮')
    await input(page).press('Meta+Enter')
    // With no project yet, sending asks where; a new empty folder is fine here.
    const elsewhere = page.getByRole('menuitemradio', { name: /^不选项目/u }).or(page.getByRole('radio', { name: /^不选项目/u }))
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
    await expect.poll(() => permissionWords(page)).toContain('按规则放行')
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
    await page
      .getByRole('menuitem', { name: '填写模型 ID…', exact: true })
      .or(page.getByRole('button', { name: '填写模型 ID…', exact: true }))
      .click()
    await page.getByRole('textbox', { name: '模型 ID' }).fill('vendor/typed')
    await shot(page, 'typed-panel-1280-dark')
    await page.getByRole('button', { name: '添加并选用' }).click()
    await page.getByRole('textbox', { name: '模型 ID' }).waitFor({ state: 'hidden' })
    await expect.poll(() => chip(page, '模型').innerText()).toContain('vendor/typed')
    await send(page, '第四轮')
    expect(current(await latest(), 'model')).toBe('vendor/typed')
    await startNew(page)
    await chip(page, '模型').click()
    await row(page, /vendor\/typed/u).waitFor()
    await page
      .getByRole('menuitem', { name: '填写模型 ID…', exact: true })
      .or(page.getByRole('button', { name: '填写模型 ID…', exact: true }))
      .click()
    const removeTyped = page.getByRole('button', { name: '移除 vendor/typed' })
    await removeTyped.click()
    await removeTyped.waitFor({ state: 'hidden' })
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
        .filter({ visible: true })
        .evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.composerControl)),
    ).toEqual(['harness', 'permission', 'model'])
    await openThinking(page)
    await row(page, /^High/u).click()
    await page.keyboard.press('Escape')
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

  it.each(['unsupported', 'error-after-take'])(
    'keeps the next message as a draft if tightening permissions after a stop fails (%s)',
    async outcome => {
      const page = await open(1440, 'light')
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          harnessId: 'codex',
          requestId: randomUUID(),
          prompt: 'steerable hold',
          config: [{ configId: '~mode', value: 'agent-full-access' }],
        },
      })
      await openSession(page, sessionId)
      await page.locator('.transcript').getByText('working', { exact: true }).waitFor()
      await expect.poll(() => permissionWords(page)).toContain('不再询问')
      await owner.json(`tasks/${sessionId}/prompt`, {
        method: 'POST',
        body: { requestId: randomUUID(), prompt: '排队的消息', queue: true },
      })
      await page.getByRole('button', { name: '停止', exact: true }).filter({ visible: true }).click()
      await expect.poll(async () => (await latest()).summary.status).toBe('cancelled')
      const queue = page.getByRole('region', { name: '排队发送', exact: true })
      const resume = queue.getByRole('button', { name: '发送', exact: true })
      await expect.poll(() => resume.isEnabled()).toBe(true)

      const answer = join(directory, 'config-answer')
      let release!: () => void
      const waiting = new Promise<void>(resolve => {
        release = resolve
      })
      const sent: string[] = []
      page.on('request', request => {
        if (request.method() === 'POST' && request.url().endsWith(`/tasks/${sessionId}/prompt`)) sent.push('prompt')
      })
      try {
        await writeFile(answer, outcome)
        await page.route(
          `**/tasks/${sessionId}/config`,
          async route => {
            await waiting
            await route.continue()
          },
          { times: 1 },
        )
        await openEntry(page)
        const response = page.waitForResponse(`**/tasks/${sessionId}/config`)
        await row(page, /先问你/u).click()
        await page.keyboard.press('Escape')
        expect(await resume.isEnabled()).toBe(false)
        expect(await queue.getByRole('button', { name: '编辑', exact: true }).isEnabled()).toBe(true)
        expect(await queue.getByRole('button', { name: '移除', exact: true }).isEnabled()).toBe(true)
        const next = page.getByRole('textbox', { name: '继续对话', exact: true })
        await next.fill('切换权限后继续')
        await next.press('Meta+Enter')
        release()
        expect((await response).ok()).toBe(false)
        await rm(answer)
        if (outcome === 'unsupported') {
          await openEntry(page)
          await expect.poll(() => permissionControl(page).getAttribute('aria-busy')).toBeNull()
          await row(page, /先问你/u).click()
          await page.keyboard.press('Escape')
        } else {
          const check = page.locator('[data-config-unknown]').getByRole('button', { name: '核对', exact: true })
          await check.waitFor()
          expect(await resume.isEnabled()).toBe(false)
          await shot(page, 'permission-unconfirmed-after-stop-1440-light')
          await next.press('Meta+Enter')
          await check.click()
          await check.waitFor({ state: 'hidden' })
        }
        await expect.poll(() => permissionWords(page)).toContain('先问你')
        await expect.poll(() => resume.isEnabled()).toBe(true)
        expect(sent).toEqual([])
        expect(await promptValue(next)).toBe('切换权限后继续')
        await next.press('Meta+Enter')
        await page.locator('.transcript').getByText('echo: 切换权限后继续', { exact: true }).waitFor()
        expect(sent).toEqual(['prompt'])
        const turns = (await readFile(log, 'utf8'))
          .trim()
          .split('\n')
          .map(line => JSON.parse(line) as { event: string; mode?: string })
        expect(turns.findLast(turn => turn.event === 'prompt-mode')?.mode).toBe('read-only')
      } finally {
        release()
        await rm(answer, { force: true })
      }
    },
  )

  it.each(['unsupported', 'error-after-take'])(
    'keeps the attachment and draft when a permission change fails while sending waits for the upload (%s)',
    async outcome => {
      const page = await open(1440, 'light')
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          harnessId: 'codex',
          requestId: randomUUID(),
          prompt: '第一轮',
          config: [{ configId: '~mode', value: 'agent-full-access' }],
        },
      })
      await openSession(page, sessionId)
      await page.locator('.transcript').getByText('echo: 第一轮', { exact: true }).waitFor()
      await expect.poll(() => permissionWords(page)).toContain('不再询问')

      const answer = join(directory, 'config-answer')
      let release!: () => void
      const uploading = new Promise<void>(resolve => {
        release = resolve
      })
      const prompts: string[][] = []
      page.on('request', request => {
        if (request.method() === 'POST' && request.url().endsWith(`/tasks/${sessionId}/prompt`))
          prompts.push(request.postDataJSON().attachmentIds ?? [])
      })
      try {
        await page.route(
          '**/link/api/attachments',
          async route => {
            await uploading
            await route.continue()
          },
          { times: 1 },
        )
        const composer = page.locator('form.composer:visible')
        const next = composer.getByRole('textbox', { name: '继续对话', exact: true })
        await composer.getByLabel('选择附件', { exact: true }).setInputFiles({
          name: 'notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('permission test'),
        })
        await next.fill('带附件继续')
        await composer.getByRole('button', { name: '发送', exact: true }).click()
        const cancel = composer.getByRole('button', { name: '取消发送', exact: true })
        await cancel.waitFor()

        await writeFile(answer, outcome)
        await openEntry(page)
        const changed = page.waitForResponse(`**/tasks/${sessionId}/config`)
        await row(page, /先问你/u).click()
        await page.keyboard.press('Escape')
        const check = composer.locator('[data-config-unknown]').getByRole('button', { name: '核对', exact: true })
        expect((await changed).ok()).toBe(false)
        if (outcome === 'error-after-take') await check.waitFor()
        else await expect.poll(() => permissionControl(page).getAttribute('aria-busy')).toBeNull()
        const response = page.waitForResponse('**/link/api/attachments')
        release()
        const uploaded = await response
        expect(uploaded.ok()).toBe(true)
        const { attachment } = (await uploaded.json()) as { attachment: { id: string } }
        await cancel.waitFor({ state: 'hidden' })
        await rm(answer)
        if (outcome === 'error-after-take') {
          await check.click()
          await check.waitFor({ state: 'hidden' })
        } else {
          await openEntry(page)
          await row(page, /先问你/u).click()
          await page.keyboard.press('Escape')
        }
        await expect.poll(() => permissionWords(page)).toContain('先问你')
        expect(prompts).toEqual([])
        expect(await promptValue(next)).toBe('带附件继续')
        expect(
          await composer.locator('.attachment-draft[data-state="ready"]').getByRole('button', { name: 'notes.txt', exact: true }).count(),
        ).toBe(1)
        await next.press('Meta+Enter')
        await expect.poll(() => prompts).toEqual([[attachment.id]])
        await expect
          .poll(
            async () => (await latest()).messages.find(message => message.role === 'user' && message.text === '带附件继续')?.attachments,
          )
          .toMatchObject([{ id: attachment.id }])
      } finally {
        release()
        await rm(answer, { force: true })
      }
    },
  )

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
    await openThinking(page)
    await row(page, /^High/u).click()
    await page.keyboard.press('Escape')
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

  it('reselects the current strict mode after an interrupted draft and never reapplies its wide mode', async () => {
    const page = await open(1440, 'light')
    const answer = join(directory, 'config-answer')
    try {
      await chip(page, '模型').click()
      await row(page, /Small/u).waitFor()
      await page.keyboard.press('Escape')
      await openThinking(page)
      await row(page, /^High/u).click()
      await openEntry(page)
      await row(page, /不再询问/u).click()
      await page.keyboard.press('Escape')
      const logStart = (await readFile(log, 'utf8')).length
      await writeFile(answer, 'exit-before-take')
      await input(page).fill('中断的草稿')
      await input(page).press('Meta+Enter')
      const elsewhere = page.getByRole('menuitemradio', { name: /^不选项目/u }).or(page.getByRole('radio', { name: /^不选项目/u }))
      if (
        await elsewhere.waitFor({ timeout: 2_000 }).then(
          () => true,
          () => false,
        )
      ) {
        await elsewhere.click()
        await input(page).press('Meta+Enter')
      }
      await expect.poll(async () => (await latest()).summary.status).toBe('failed')
      const session = await latest()
      expect(current(session, 'mode')).toBe('read-only')
      await writeFile(answer, '')
      await expect.poll(() => permissionWords(page)).toContain('先问你')
      await openEntry(page)
      const accepted = page.waitForResponse(
        response => response.request().method() === 'POST' && /\/tasks\/[^/]+\/config$/u.test(response.url()),
      )
      await row(page, /先问你/u).click()
      await page.keyboard.press('Escape')
      expect((await accepted).ok()).toBe(true)
      const next = page.getByRole('textbox', { name: '继续对话', exact: true })
      await next.fill('重选严格档后继续')
      await next.press('Meta+Enter')
      await page.locator('.transcript').getByText('echo: 重选严格档后继续', { exact: true }).waitFor()
      const after = await owner.json<TaskDetail>(`tasks/${session.summary.id}`)
      expect(current(after, 'mode')).toBe('read-only')
      expect(after.permission?.expectedMode).toBe('read-only')
      const modeWrites = (await readFile(log, 'utf8'))
        .slice(logStart)
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { event: string; params?: { configId?: string; value?: string; sessionId?: string } })
      // The attempted draft failed before any Agent mode write; this explicit strict choice must not revive it.
      expect(
        modeWrites.filter(item => item.event === 'recv' && item.params?.configId === 'mode' && item.params.value === 'agent-full-access'),
      ).toHaveLength(0)
    } finally {
      await rm(answer, { force: true })
      await page.context().close()
    }
  })

  for (const theme of ['light', 'dark'] as const)
    it(`lists the same on a phone, ${theme}`, async () => {
      const page = await open(390, theme)
      await openNew(page)
      // The permission beside the Harness: its own sheet sets it.
      const chips = page.locator('.workbench-home form.composer')
      const permission = phonePermission(page)
      await chips.getByRole('button', { name: /^模型/u }).waitFor()
      expect(await chips.getByText('开始后可以换', { exact: false }).count()).toBe(0)
      await shot(page, `chips-390-${theme}`)
      await permission.click()
      // The same segments in the sheet, larger.
      await row(page, '由模型判断').waitFor()
      expect((await row(page, '按规则放行').boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await shot(page, `sheet-permission-390-${theme}`)
      await row(page, '按规则放行').click()
      await page.keyboard.press('Escape')
      await expect.poll(() => permissionWords(page)).toContain('按规则放行')
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
    const saved = await owner.confirmed('agents', {
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
      await openNew(page)
      const sheet = page.locator('.workbench-home form.composer')
      await sheet.waitFor()
      expect(await sheet.getByRole('button', { name: /^Harness：/u }).getAttribute('aria-label')).toBe('Harness：Generic')
      const permission = phonePermission(page)
      await expect.poll(() => permissionWords(page)).toBe('权限：默认')
      expect(await page.getByText('开始后才知道', { exact: false }).count()).toBe(0)
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
      await expect.poll(() => permissionWords(page)).toBe('权限：auto')
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
      const chip = permissionControl(page)
      await expect.poll(() => permissionWords(page)).toBe('权限：默认')
      await chip.click()
      await expect.poll(async () => (await generic())?.catalogue, { timeout: 20_000 }).toMatchObject({ source: 'check' })
      await mode(page, 'auto').waitFor()
      await expect.poll(() => permissionWords(page)).toBe('权限：ask')
      await shot(page, 'permission-read-1280-light')
    } finally {
      await page.context().close()
    }
  })
})

/** A Harness Latch has a profile for, whose read opens a session and so reports its modes too. */
describe('opening 权限 first on a Harness whose lists are read only on request', () => {
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
      join(bin, 'qwen'),
      [
        '#!/bin/sh',
        `export FAKE_ACP_STATE='${join(directory, 'state.json')}' FAKE_ACP_LOG='${log}'`,
        'export FAKE_ACP_MODES=plan,default,auto-edit,auto,yolo FAKE_ACP_INITIAL_MODE=default FAKE_ACP_CONFIG=options FAKE_ACP_EFFORT_BY_MODEL=1',
        `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
      ].join('\n'),
    )
    await chmod(join(bin, 'qwen'), 0o755)
    host = await startTestHost({
      demo: false,
      detectPreset: preset => (preset.id === 'qwen' ? { found: true, path: join(bin, 'qwen') } : { found: false }),
      // Only this directory: no agent installed on the computer running the test is ever found.
      commandDirectories: () => [bin],
    })
    const owner = await host.enroll({ listener: 'unix' })
    const saved = await owner.confirmed('agents', {
      method: 'POST',
      body: {
        id: 'qwen',
        name: 'Qwen Code',
        presetId: 'qwen',
        command: 'qwen',
        args: ['--acp'],
        env: {},
      },
    })
    expect(saved.status).toBe(201)
    const qwen = (await owner.json<AppSnapshot>('snapshot')).catalog!.harnesses.find(harness => harness.id === 'qwen')
    // Its sessions start the person's MCP servers and hooks, so nothing reads its lists unasked.
    expect(qwen?.catalogueRead).toEqual({ when: 'request', modes: true })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('offers the known modes without reading, and keeps a choice made before the person reads the list', async () => {
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
      ).toBe('Harness：Qwen Code')
      const chip = permissionControl(page)
      await expect.poll(() => permissionWords(page)).toBe('权限：先问你')
      await chip.click()
      const rule = page
        .getByRole('menuitemradio', { name: /由模型判断/u })
        .or(page.getByRole('radio', { name: /由模型判断/u }))
        .first()
      await rule.waitFor({ timeout: 20_000 })
      await rule.click()
      await expect.poll(() => permissionWords(page)).toBe('权限：由模型判断')
      // Opening 权限 started nothing.
      expect(await sent()).toEqual([])
      await shot('permission-request-1280-dark')
      // The person reads the list from the model menu; the choice made before it stays.
      await page
        .getByRole('button', { name: /^模型：/u })
        .filter({ visible: true })
        .first()
        .click()
      const menu = page.locator('[role=menu], [role=listbox]').filter({ visible: true }).first()
      await menu.getByText('刷新模型列表', { exact: true }).waitFor()
      await expect.poll(sent).toHaveLength(1)
      // A model with unknown levels is read while the panel stays open. Its late answer still belongs to that model.
      let release!: () => void,
        modelReads = 0
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      await page.route('**/link/api/agents/qwen/catalogue', async route => {
        if (route.request().postDataJSON().model === 'large') {
          modelReads++
          await gate
        }
        return route.continue()
      })
      const large = menu.getByRole('menuitemradio', { name: /^Large/u })
      const small = menu.getByRole('menuitemradio', { name: /^Small/u })
      const max = page.locator('.ui-board').filter({ visible: true }).getByRole('menuitemradio', { name: /^Max/u })
      try {
        await large.click()
        await expect.poll(() => modelReads).toBe(1)
        await small.click()
      } finally {
        release()
      }
      await expect.poll(async () => (await sent()).length).toBe(2)
      await menu.getByText('刷新模型列表', { exact: true }).waitFor()
      expect(await small.getAttribute('aria-checked')).toBe('true')
      expect(await max.count()).toBe(0)
      await large.click()
      await max.waitFor()
      expect(modelReads).toBe(1)
      await shot('qwen-picked-model-levels-1280-dark')
      await page.keyboard.press('Escape')
      await expect.poll(() => permissionWords(page)).toBe('权限：由模型判断')
      expect(await page.getByText('发第一条消息后可以换', { exact: false }).count()).toBe(0)
      await shot('permission-read-1280-dark')
      await noHorizontalOverflow(page)
    } finally {
      await context.close()
    }
  })
})

/** Codex over its own app-server, saved on this Mac: its model/list says the models a draft offers. */
describe("choosing one of Codex's own models in a draft", () => {
  let directory: string
  let log: string
  let host: TestHost
  let browser: Browser

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'latch-e2e-codex-models-'))
    log = join(directory, 'codex.log')
    const bin = join(directory, 'bin')
    await mkdir(bin)
    await writeFile(
      join(bin, 'codex'),
      [
        '#!/bin/sh',
        `export FAKE_ACP_LOG='${log}' FAKE_CODEX_STATE='${join(directory, 'threads.json')}'`,
        `exec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"`,
      ].join('\n'),
    )
    await chmod(join(bin, 'codex'), 0o755)
    host = await startTestHost({ demo: false, sessionFolders: true, commandDirectories: () => [bin] })
    const owner = await host.enroll({ listener: 'unix' })
    const saved = await owner.confirmed('agents', {
      method: 'POST',
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: join(bin, 'codex'), args: [], env: {} },
    })
    expect(saved.status).toBe(201)
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
    await rm(directory, { recursive: true, force: true })
  })

  const lines = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event: string; method?: string | null; params?: Record<string, unknown> })
  const received = async (method: string) => (await lines()).filter(line => line.event === 'recv' && line.method === method)
  // 思考 is set in the model's entry: its level stands after the model's name on the one chip, and the chip opens both.
  const chip = (page: Page, name: string): Locator =>
    page.getByRole('button', { name: new RegExp(`^${name === '思考' ? '模型' : name}：`, 'u') }).first()
  /** Opens the entry's panel for a level, unless a model picked a moment ago left it open. */
  const openThinking = async (page: Page) => {
    const entry = chip(page, '思考')
    if ((await entry.getAttribute('aria-expanded')) !== 'true') await entry.click()
  }
  /** Opens the permission's popover beside the Harness, unless it is open already. */
  const openEntry = async (page: Page) => {
    const control = permissionControl(page)
    if ((await control.getAttribute('aria-expanded')) !== 'true') await control.click()
  }
  const row = (page: Page, name: RegExp) =>
    page
      .getByRole('menuitemradio', { name })
      .or(page.locator(':popover-open, dialog[open]').getByRole('option', { name }))
      .or(page.locator(':popover-open, dialog[open]').getByRole('radio', { name }))
      .filter({ visible: true })
      .first()

  it('reads its list when its menu opens, lists the real names with the default marked, and starts on the one picked', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    try {
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
      await connected(page)
      // The draft starts on Codex, the one Harness saved; opening its model menu reads model/list once, with no thread.
      expect(await chip(page, 'Harness').getAttribute('aria-label')).toBe('Harness：Codex')
      expect(await received('model/list')).toEqual([])
      await chip(page, '模型').click()
      await expect.poll(() => chip(page, '模型').innerText(), { timeout: 15_000 }).toContain('GPT Fake')
      expect(await received('model/list')).toHaveLength(1)
      expect(await received('thread/start')).toEqual([])
      const menu = page.locator('.ui-menu, [role="menu"], [role="listbox"]').filter({ hasText: 'GPT Fake Mini', visible: true }).first()
      await menu.waitFor()
      await row(page, /^GPT Fake Mini/u).waitFor()
      await row(page, /^GPT Fake 默认/u).waitFor()
      expect(await menu.getByText('Codex', { exact: true }).count()).toBe(1)
      for (const gone of ['Codex 自己的模型', '默认模型', '服务用不了']) expect(await menu.getByText(gone).count()).toBe(0)
      await menu.getByText('刷新模型列表', { exact: true }).waitFor()
      await page.screenshot({ path: `${OUTPUT}/codex-models-1440-light.png`, animations: 'disabled' })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.screenshot({ path: `${OUTPUT}/codex-models-1440-dark.png`, animations: 'disabled' })
      await page.emulateMedia({ colorScheme: 'light' })

      // 刷新模型列表 reads again; the list stays.
      await menu.getByText('刷新模型列表', { exact: true }).click()
      await expect.poll(async () => (await received('model/list')).length, { timeout: 15_000 }).toBe(2)
      await row(page, /^GPT Fake Mini/u).click()
      await page.keyboard.press('Escape')
      await expect.poll(() => chip(page, '模型').innerText()).toContain('GPT Fake Mini')
      // 思考 offers exactly the levels Codex listed for that model.
      await openThinking(page)
      await row(page, /^Medium/u).waitFor()
      expect(await row(page, /^High/u).count()).toBe(0)
      await page.keyboard.press('Escape')

      const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
      await input.fill('第一轮')
      await input.press('Meta+Enter')
      const elsewhere = page.getByRole('menuitemradio', { name: /^不选项目/u }).or(page.getByRole('radio', { name: /^不选项目/u }))
      if (
        await elsewhere.waitFor({ timeout: 3_000 }).then(
          () => true,
          () => false,
        )
      ) {
        await elsewhere.click()
        await input.press('Meta+Enter')
      }
      await page.locator('.transcript').getByText('echo: 第一轮', { exact: true }).first().waitFor({ timeout: 20_000 })
      const started = await received('thread/start')
      const turns = await received('turn/start')
      expect(started.at(-1)?.params?.model ?? turns.at(-1)?.params?.model).toBe('gpt-fake-mini')
    } finally {
      await context.close()
    }
  })

  it('lists the same on a phone', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'zh-CN',
      reducedMotion: 'reduce',
      isMobile: true,
      hasTouch: true,
    })
    try {
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
      await connected(page)
      await openNew(page)
      const sheet = page.locator('.workbench-home form.composer')
      await sheet.waitFor()
      await sheet.getByRole('button', { name: /^Harness/u }).click()
      await row(page, /^Codex/u).click()
      await sheet.getByRole('button', { name: /^模型/u }).click()
      await row(page, /^GPT Fake Mini/u).waitFor()
      await row(page, /^GPT Fake 默认/u).waitFor()
      await page.screenshot({ path: `${OUTPUT}/codex-models-390-light.png`, animations: 'disabled' })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.screenshot({ path: `${OUTPUT}/codex-models-390-dark.png`, animations: 'disabled' })
      await noHorizontalOverflow(page)
    } finally {
      await context.close()
    }
  })
  it('keeps identical model IDs on their own accounts across selection, search and session start', async () => {
    const accountDirectory = join(directory, 'work-account')
    await mkdir(accountDirectory)
    const owner = await host.enroll({ listener: 'unix' })
    const { agent } = await owner.confirmedJson<{ agent: { id: string } }>('agents', {
      method: 'POST',
      body: { name: 'Codex · 工作', presetId: 'codex', command: 'codex', args: [], accountDirectory },
    })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    try {
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
      await connected(page)
      await chip(page, '模型').click()
      await row(page, /^GPT Fake Mini/u).waitFor()
      const work = page.getByRole('tab', { name: 'Codex · 工作', exact: true }).filter({ visible: true })
      await work.click()
      await row(page, /^GPT Fake Mini/u).waitFor()
      await expect.poll(() => chip(page, 'Harness').innerText()).toContain('Codex · 工作')
      const shot = (name: string) => page.screenshot({ path: `${OUTPUT}/accounts-${name}.png`, animations: 'disabled' })
      await shot('1440-light')
      await page.keyboard.press('Escape')
      for (const width of [390, 820, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: 'dark' })
        await chip(page, '模型').click()
        await work.waitFor()
        await noHorizontalOverflow(page)
        await shot(`${width}-dark`)
        await page.keyboard.press('Escape')
      }
      await chip(page, '模型').click()
      await page.getByRole('tab', { name: 'Codex', exact: true }).filter({ visible: true }).click()
      await page.locator('.ui-board-search input:visible').fill('Mini')
      const workResults = page.locator('.ui-board-section:visible').filter({ has: page.getByText('Codex · 工作', { exact: true }) })
      await workResults.getByText('GPT Fake Mini', { exact: true }).click()
      await page.keyboard.press('Escape')
      await expect.poll(() => chip(page, 'Harness').innerText()).toContain('Codex · 工作')
      await expect.poll(() => chip(page, '模型').innerText()).toContain('GPT Fake Mini')
      const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
      await input.fill('账号选择')
      await input.press('Meta+Enter')
      const elsewhere = page.getByRole('menuitemradio', { name: /^不选项目/u }).or(page.getByRole('radio', { name: /^不选项目/u }))
      if (
        await elsewhere.waitFor({ timeout: 3000 }).then(
          () => true,
          () => false,
        )
      ) {
        await elsewhere.click()
        await input.press('Meta+Enter')
      }
      await page.locator('.transcript').getByText('echo: 账号选择', { exact: true }).first().waitFor()
      expect((await owner.json<AppSnapshot>('snapshot')).tasks.some(task => task.harnessId === agent.id)).toBe(true)
      expect((await received('thread/start')).at(-1)?.params?.model ?? (await received('turn/start')).at(-1)?.params?.model).toBe(
        'gpt-fake-mini',
      )
      await chip(page, '模型').click()
      expect(await page.getByRole('tab', { name: 'Codex', exact: true }).count()).toBe(0)
      await page.keyboard.press('Escape')
      await openNew(page)
      await expect.poll(() => chip(page, 'Harness').innerText()).toContain('Codex · 工作')
      await input.fill('保留原来的草稿')
      expect((await owner.request(`agents/${agent.id}`, { method: 'DELETE' })).ok).toBe(true)
      const unavailable = page.locator('.setup-card').getByText('原来选择的账号已停用或移除。请重新选择 Harness。', { exact: true })
      await unavailable.waitFor()
      expect(await promptValue(input)).toBe('保留原来的草稿')
      await page.reload()
      await connected(page)
      await openNew(page)
      await unavailable.waitFor()
      expect(await promptValue(input)).toBe('保留原来的草稿')
    } finally {
      await context.close()
    }
  })
})
