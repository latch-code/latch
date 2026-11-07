import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { FAKE_PI_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

const OUTPUT = 'test-results/pi'

/** pi run as itself over its RPC mode, with no adapter: found, started, stopped, added to and reopened in the page. */
describe('pi over its own RPC mode', () => {
  let directory: string
  let log: string
  let host: TestHost
  let owner: TestDevice
  let browser: Browser

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'latch-e2e-pi-'))
    log = join(directory, 'pi.log')
    const bin = join(directory, 'bin')
    await mkdir(bin)
    await mkdir(join(directory, 'sessions'))
    await writeFile(
      join(bin, 'pi'),
      [
        '#!/bin/sh',
        `export FAKE_PI_LOG='${log}' FAKE_PI_SESSIONS='${join(directory, 'sessions')}'`,
        `exec '${process.execPath}' '${FAKE_PI_AGENT}' "$@"`,
      ].join('\n'),
    )
    await chmod(join(bin, 'pi'), 0o755)
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
    const elsewhere = page.getByText('在一个新的空文件夹里开始', { exact: true })
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
    await expect.poll(() => chip(page, '模型').innerText()).toContain('Claude Sonnet 4.5 · 中')
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
    expect(types.indexOf('clear_queue')).toBeGreaterThan(-1)
    expect(types.indexOf('abort')).toBeGreaterThan(types.indexOf('clear_queue'))
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
    await chip(page, '模型').click()
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
})
