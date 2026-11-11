import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { FAKE_PI_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSection, openSettings } from './helpers/layout.ts'

const OUTPUT = 'test-results/pi'

/** pi run as itself over its RPC mode, with no adapter: found, started, stopped, added to and reopened in the page. */
describe('pi over its own RPC mode', () => {
  let directory: string
  let log: string
  let host: TestHost
  let owner: TestDevice
  let browser: Browser

  /** The pi the Host finds: the fake, as itself or as a pi older than 0.84.4. */
  const fakePi = async (bin: string, old = false) => {
    await writeFile(
      join(bin, 'pi'),
      [
        '#!/bin/sh',
        `export FAKE_PI_LOG='${log}' FAKE_PI_SESSIONS='${join(directory, 'sessions')}'${old ? ' FAKE_PI_TOO_OLD=1' : ''}`,
        `exec '${process.execPath}' '${FAKE_PI_AGENT}' "$@"`,
      ].join('\n'),
    )
    await chmod(join(bin, 'pi'), 0o755)
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'latch-e2e-pi-'))
    log = join(directory, 'pi.log')
    const bin = join(directory, 'bin')
    await mkdir(bin)
    await mkdir(join(directory, 'sessions'))
    await fakePi(bin)
    host = await startTestHost({
      demo: false,
      sessionFolders: true,
      detectPreset: preset => (preset.id === 'pi' ? { found: true, path: join(bin, 'pi') } : { found: false }),
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
  const draft = (page: Page) => page.getByRole('textbox', { name: '新会话消息', exact: true })
  const composer = (page: Page) => page.getByRole('textbox', { name: '继续对话', exact: true })
  const chip = (page: Page, name: string): Locator => page.getByRole('button', { name: new RegExp(`^${name}：`, 'u') }).first()
  const received = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event: string; type?: string; argv?: string[]; message?: string; cwd?: string })
  const reply = (page: Page, text: string) => page.locator('.transcript').getByText(text, { exact: true }).first()
  const latest = async () => {
    const tasks = (await owner.json<AppSnapshot>('snapshot')).tasks.toSorted((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
    return owner.json<TaskDetail>(`tasks/${tasks.at(-1)!.id}`)
  }
  const start = async (page: Page, text: string) => {
    await draft(page).fill(text)
    await draft(page).press('Meta+Enter')
    // With no project yet, sending asks where; a new empty folder is fine here.
    const elsewhere = page.getByText(/ 在一个新的空文件夹里开始$/u)
    if (
      await elsewhere.waitFor({ timeout: 3_000 }).then(
        () => true,
        () => false,
      )
    ) {
      await elsewhere.click()
      await draft(page).press('Meta+Enter')
    }
  }

  it('starts pi only when sent to or asked for its list, then runs, stops and keeps the session after a reload', async () => {
    const page = await open(1440, 'light')
    await expect.poll(() => chip(page, 'Harness').innerText()).toContain('pi')
    await expect.poll(() => chip(page, '模型').innerText()).toContain('默认模型')
    await expect.poll(() => chip(page, '权限').innerText()).toContain('由 pi 决定')
    // Selecting pi loads nothing: its list is read only when a person asks.
    await chip(page, '模型').click()
    await page.getByText('读取 pi 的模型列表', { exact: true }).waitFor()
    await shot(page, 'draft-menu-1440-light')
    expect(await received()).toEqual([])
    await page.getByText('读取 pi 的模型列表', { exact: true }).click()
    await page.getByText('Claude Sonnet 4.5', { exact: true }).first().waitFor()
    const read = await received()
    expect(read.filter(entry => entry.event === 'start')).toHaveLength(1)
    expect(read.find(entry => entry.event === 'start')!.argv).toEqual(['--mode', 'rpc'])
    expect(read.some(entry => entry.type === 'prompt')).toBe(false)
    await shot(page, 'listed-1440-light')
    await page.keyboard.press('Escape')

    await start(page, 'say hello')
    await reply(page, 'echo: say hello').waitFor({ timeout: 20_000 })
    await expect.poll(() => chip(page, '模型').innerText()).toContain('Claude Sonnet 4.5')
    await expect.poll(() => chip(page, '思考').innerText()).toContain('中')
    const first = await latest()
    expect(first.summary.status).toBe('idle')
    expect(first.messages.filter(message => message.role === 'assistant').map(message => message.reasoning)).toEqual(['Thinking about it.'])
    expect(first.usageReport?.contextSize).toBe(200000)
    await shot(page, 'reply-1440-light')

    await composer(page).fill('run the tests')
    await composer(page).press('Meta+Enter')
    await reply(page, 'echo: run the tests').waitFor({ timeout: 20_000 })
    await expect.poll(async () => (await latest()).messages.find(message => message.role === 'tool')?.state).toBe('completed')

    await composer(page).fill('sleep a while')
    await composer(page).press('Meta+Enter')
    await expect.poll(async () => (await latest()).messages.filter(message => message.role === 'tool').length).toBe(2)
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await expect.poll(async () => (await latest()).summary.status, { timeout: 20_000 }).toBe('cancelled')
    const stopped = await latest()
    expect(stopped.messages.filter(message => message.role === 'tool').every(message => message.state !== 'running')).toBe(true)
    // Stopping clears what was queued before aborting, so pi does not carry on with it.
    const types = (await received()).flatMap(entry => (entry.type ? [entry.type] : []))
    const abort = types.indexOf('abort')
    expect(abort).toBeGreaterThan(-1)
    expect(types.slice(types.lastIndexOf('prompt', abort), abort)).toContain('clear_queue')
    await page.locator('.sidebar-body').getByText('已停止', { exact: true }).waitFor()
    await shot(page, 'stopped-1440-light')

    await page.reload()
    await connected(page)
    await reply(page, 'echo: say hello').waitFor()
    await reply(page, 'echo: run the tests').waitFor()
    await noHorizontalOverflow(page)
    await shot(page, 'reloaded-1440-light')
    await page.context().close()
  })

  it('adds text to a running turn, and fails a turn with what the model service said', async () => {
    const page = await open(390, 'dark')
    for (const button of await page.getByRole('button', { name: '新建会话', exact: true }).all()) {
      if (await button.isVisible()) {
        await button.click()
        break
      }
    }
    await draft(page).waitFor()
    await start(page, 'build it slowly')
    await expect.poll(async () => (await latest()).messages.some(message => message.role === 'tool')).toBe(true)
    await composer(page).fill('also update the README')
    await page.getByRole('button', { name: '追加到本轮', exact: true }).click()
    await reply(page, 'echo: also update the README').waitFor({ timeout: 20_000 })
    await expect.poll(async () => (await latest()).summary.status).toBe('idle')
    const steered = await latest()
    expect(steered.messages.find(message => message.role === 'user' && message.steered)?.text).toBe('also update the README')
    expect((await received()).filter(entry => entry.type === 'steer').map(entry => entry.message)).toEqual(['also update the README'])
    await noHorizontalOverflow(page)
    await shot(page, 'steered-390-dark')
    await chip(page, '思考').click()
    await page.getByRole('radio', { name: '高', exact: true }).waitFor()
    await shot(page, 'model-menu-390-dark')
    await page.keyboard.press('Escape')

    await composer(page).fill('fail now')
    await composer(page).press('Meta+Enter')
    await expect.poll(async () => (await latest()).summary.status, { timeout: 20_000 }).toBe('failed')
    await page.locator('.transcript').getByText('pi 返回错误：529 overloaded_error: Overloaded', { exact: false }).first().waitFor()
    await shot(page, 'failed-390-dark')
    await page.context().close()
  })
  it("compacts with pi's own /compact between turns, and refuses it while a turn runs", async () => {
    const page = await open(1440, 'light')
    for (const button of await page.getByRole('button', { name: '新建会话', exact: true }).all()) {
      if (await button.isVisible()) {
        await button.click()
        break
      }
    }
    await draft(page).waitFor()
    await start(page, 'say hello first')
    await reply(page, 'echo: say hello first').waitFor({ timeout: 20_000 })
    const menu = page.locator('.slash-commands')
    await composer(page).fill('/comp')
    await menu.getByRole('option', { name: /^\/compact/u }).waitFor()
    await shot(page, 'compact-menu-1440-light')
    await composer(page).press('Enter')
    expect(await composer(page).inputValue()).toBe('/compact ')
    await composer(page).pressSequentially('keep the test names')
    await composer(page).press('Meta+Enter')
    await page.locator('.transcript').getByText('keeping: keep the test names', { exact: false }).waitFor({ timeout: 20_000 })
    const compacted = await latest()
    expect(compacted.summary.status).toBe('idle')
    expect(compacted.messages.map(message => `${message.role}:${message.text}`).slice(-2)).toEqual([
      'user:/compact keep the test names',
      'system:pi 已压缩上下文\nSummary of the conversation so far, keeping: keep the test names.',
    ])
    // pi got its own command, not the text as a prompt.
    const sent = await received()
    expect(sent.filter(entry => entry.type === 'compact')).toEqual([expect.objectContaining({ customInstructions: 'keep the test names' })])
    expect(sent.filter(entry => entry.type === 'prompt').map(entry => entry.message)).not.toContain('/compact keep the test names')
    await shot(page, 'compacted-1440-light')

    await composer(page).fill('sleep a while')
    await composer(page).press('Meta+Enter')
    await expect
      .poll(async () => (await latest()).messages.some(message => message.role === 'tool' && message.state === 'running'))
      .toBe(true)
    // pi stops what it is doing to compact, so the command is not offered meanwhile, and refused when typed.
    await composer(page).fill('/')
    await expect.poll(() => menu.isVisible()).toBe(false)
    await composer(page).fill('/compact')
    await composer(page).press('Meta+Enter')
    const refusal = page.getByText('/compact 不能排队或追加，请等本轮结束后发送。', { exact: true })
    await refusal.waitFor()
    const [notice, box] = await Promise.all([refusal.boundingBox(), page.locator('form.composer').boundingBox()])
    expect(notice!.y + notice!.height).toBeLessThanOrEqual(box!.y)
    expect(await composer(page).inputValue()).toBe('/compact')
    expect((await received()).filter(entry => entry.type === 'compact')).toHaveLength(1)
    expect((await latest()).summary.status).toBe('running')
    await noHorizontalOverflow(page)
    await shot(page, 'compact-refused-1440-light')
    await composer(page).fill('')
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await expect.poll(async () => (await latest()).summary.status, { timeout: 20_000 }).toBe('cancelled')
    await page.context().close()
  })

  it("forks a pi session from a turn in pi's own record, and sends the person's words alone", async () => {
    const page = await open(1440, 'light')
    for (const button of await page.getByRole('button', { name: '新建会话', exact: true }).all()) {
      if (await button.isVisible()) {
        await button.click()
        break
      }
    }
    await draft(page).waitFor()
    await start(page, 'first idea')
    await reply(page, 'echo: first idea').waitFor({ timeout: 20_000 })
    await composer(page).fill('second idea')
    await composer(page).press('Meta+Enter')
    await reply(page, 'echo: second idea').waitFor({ timeout: 20_000 })
    await expect.poll(async () => (await latest()).summary.status).toBe('idle')
    const turn = page.locator('.turn-reply').first()
    await turn.hover()
    await turn.getByRole('button', { name: '从这里分叉', exact: true }).click({ force: true })
    // How pi forks is said once the fork runs, in the session; the notice only names the source.
    await page.locator('.fork-notice').getByText('从「', { exact: false }).waitFor()
    await draft(page).fill('recall what came before')
    await draft(page).press('Meta+Enter')
    // The fork holds pi's record up to the first turn and no further.
    await reply(page, 'remembers: first idea').waitFor({ timeout: 20_000 })
    await page.getByText('pi 带着「', { exact: false }).waitFor()
    expect(await page.locator('details.fork-context').count()).toBe(0)
    const forked = await latest()
    expect(forked.messages.find(message => message.role === 'user')?.nativeFork).toBe(true)
    const sent = await received()
    expect(sent.filter(entry => entry.type === 'fork')).toHaveLength(1)
    expect(sent.filter(entry => entry.type === 'prompt').at(-1)?.message).toBe('recall what came before')
    await noHorizontalOverflow(page)
    await shot(page, 'forked-1440-light')

    // Retrying that first turn sends the words again, not the text record pi never got.
    const transcript = page.locator('.transcript')
    await reply(page, 'remembers: first idea').hover()
    await transcript.getByRole('button', { name: '重试', exact: true }).last().click()
    await expect
      .poll(async () =>
        (await latest()).messages
          .filter(message => message.role === 'user')
          .map(message => message.text.endsWith('recall what came before')),
      )
      .toEqual([true, true])
    await expect.poll(async () => (await latest()).summary.status, { timeout: 20_000 }).toBe('idle')
    const retried = (await latest()).messages.filter(message => message.role === 'user')
    expect(retried[1]).toMatchObject({ text: 'recall what came before' })
    expect(retried[1]?.forkContext).toBeUndefined()
    expect((await received()).filter(entry => entry.type === 'prompt').at(-1)?.message).toBe('recall what came before')
    // pi's own record now holds the first turn and the words sent before, and nothing else.
    await reply(page, 'remembers: first idea | recall what came before').waitFor({ timeout: 20_000 })
    expect(await transcript.getByText('的前 1 轮', { exact: false }).count()).toBe(1)
    await shot(page, 'fork-retried-1440-light')
    await page.context().close()
  })

  it('refuses a pi older than 0.84.4 when a session starts and in a test start, and says what to do', async () => {
    const bin = join(directory, 'bin')
    await fakePi(bin, true)
    const refusal = 'pi 的版本低于 0.84.4（它不认识 clear_queue），已拒绝启动。升级到 0.84.4 或更高版本后再试。'
    try {
      const page = await open(1440, 'dark')
      for (const button of await page.getByRole('button', { name: '新建会话', exact: true }).all()) {
        if (await button.isVisible()) {
          await button.click()
          break
        }
      }
      await draft(page).waitFor()
      await start(page, 'hello from an old pi')
      await expect.poll(async () => (await latest()).summary.status, { timeout: 20_000 }).toBe('failed')
      await page.locator('.transcript').getByText(refusal).first().waitFor()
      const refused = await latest()
      expect(refused.messages.filter(message => message.role === 'assistant')).toEqual([])
      expect((await received()).filter(entry => entry.type === 'prompt').map(entry => entry.message)).not.toContain('hello from an old pi')
      await noHorizontalOverflow(page)
      await shot(page, 'too-old-1440-dark')

      const saved = await owner.request('agents', { body: { id: 'pi', name: 'pi', presetId: 'pi', command: 'pi', args: [], env: {} } })
      expect([201, 409]).toContain(saved.status)
      const settings = await openSettings(page)
      await openSection(settings, 'Harness')
      await settings.getByRole('button', { name: '编辑 pi', exact: true }).click()
      const probe = settings.locator('.settings-group', { has: page.getByRole('heading', { name: '测试启动', exact: true }) })
      await probe.getByRole('button', { name: '测试启动', exact: true }).click()
      await probe.getByText('测试启动失败', { exact: true }).waitFor({ timeout: 25_000 })
      expect(await probe.locator('pre').innerText()).toContain(refusal)
      await probe.scrollIntoViewIfNeeded()
      await shot(page, 'too-old-probe-1440-dark')
      await page.context().close()
    } finally {
      await fakePi(bin)
    }
  })

  it("lists a saved service on a phone's new session as on the desktop, with why pi cannot use it", async () => {
    const created = await owner.confirmed('providers', {
      method: 'POST',
      body: {
        name: 'Relay',
        kind: 'openai-compatible',
        baseURL: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-e2e-service-key-0123456789abcdef',
        models: ['fake-model'],
        defaultModel: 'fake-model',
        confirmOrigin: true,
      },
    })
    expect(created.status).toBe(201)
    const reason = '转发 pi 的请求尚未实现'
    for (const width of [1440, 390] as const) {
      const page = await open(width, 'dark')
      for (const button of await page.getByRole('button', { name: '新建会话', exact: true }).all()) {
        if (await button.isVisible()) {
          await button.click()
          break
        }
      }
      if (width === 390) {
        const sheet = page.locator('.new-session-sheet')
        await sheet.waitFor()
        await sheet.getByRole('button', { name: /^模型/u }).click()
      } else await chip(page, '模型').click()
      // The menu's group, not the status line under the input, which names the same thing.
      const inMenu = (text: string) => page.getByText(text, { exact: true }).and(page.locator(':not(.composer-status, .composer-status *)'))
      await inMenu('pi 自己的模型').waitFor()
      // The services pi cannot use fold into one row; opening it says why.
      await inMenu('1 个服务用不了').click()
      await inMenu(reason).waitFor()
      // Nothing here goes through Latch, so the menu does not explain 「经 Latch」.
      expect(await page.getByText(/「经 Latch」/u).count()).toBe(0)
      await noHorizontalOverflow(page)
      await shot(page, `services-${width}-dark`)
      await page.context().close()
    }
  })
})
