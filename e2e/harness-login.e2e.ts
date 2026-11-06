import { chromium, type Browser, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

const OUTPUT = 'test-results/harness-login'

describe('logging in to a Harness from a browser', () => {
  let directory: string
  let loginFile: string
  let host: TestHost
  let browser: Browser

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'latch-e2e-login-'))
    loginFile = join(directory, 'login')
    const bin = join(directory, 'bin')
    await mkdir(bin)
    for (const name of ['codex', 'codex-acp']) {
      await writeFile(
        join(bin, name),
        [
          '#!/bin/sh',
          `export FAKE_ACP_LOGIN_FILE='${loginFile}' FAKE_ACP_CAPS=resume FAKE_ACP_STATE='${join(directory, 'state.json')}'`,
          'export FAKE_ACP_MODES=read-only,workspace-write,agent-full-access FAKE_ACP_INITIAL_MODE=read-only FAKE_ACP_CONFIG=options',
          `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
        ].join('\n'),
      )
      await chmod(join(bin, name), 0o755)
    }
    host = await startTestHost({
      demo: false,
      sessionFolders: true,
      detectPreset: preset => (preset.id === 'codex' ? { found: true, path: join(bin, 'codex-acp') } : { found: false }),
      loginPrograms: name => (existsSync(join(bin, name)) ? join(bin, name) : undefined),
      commandDirectories: () => [bin],
    })
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
  const refusal = (page: Page) => page.locator('.run-end').getByText('Codex 还没登录 · 登录后重试')

  it('says so before the first turn, fails that turn plainly, and goes on once logged in', async () => {
    const page = await open(1440, 'light')
    const notice = page.getByRole('status', { name: '登录' })
    await notice.getByText('Codex 还没登录', { exact: true }).waitFor()
    await notice.getByText('codex login', { exact: true }).waitFor()
    // This browser is not this computer, so it gets the command and where to run it.
    await notice.getByText('在这台 Mac 的终端里运行这条命令。').waitFor()
    expect(await notice.getByRole('button', { name: '在终端里登录' }).count()).toBe(0)
    await shot(page, 'draft-1440-light')

    // Sending stays possible: the program may know better, and the refusal is what it says at that point.
    const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
    await input.fill('echo 第一轮')
    await input.press('Meta+Enter')
    await page.getByText('在一个新的空文件夹里开始', { exact: true }).click()
    await input.press('Meta+Enter')
    await refusal(page).waitFor()
    const end = page.locator('.run-end')
    await end.getByText('codex login', { exact: true }).waitFor()
    await shot(page, 'refused-1440-light')

    // Pressed too early, the same words come back; nothing was lost.
    const posted = page.waitForResponse(response => response.request().method() === 'POST' && /\/tasks\//u.test(response.url()))
    await end.getByRole('button', { name: '重试', exact: true }).click()
    expect((await posted).status()).toBe(409)
    await page.getByText('Codex 还没登录。按它自己的方式登录后重试。').first().waitFor()
    await shot(page, 'retry-too-early-1440-light')
    await page.locator('.run-end').getByRole('button', { name: '重试', exact: true }).waitFor()

    // A reload keeps what to do.
    await page.reload()
    await refusal(page).waitFor()
    await page.locator('.run-end').getByText('codex login', { exact: true }).waitFor()

    await writeFile(loginFile, 'yes')
    await page.locator('.run-end').getByRole('button', { name: '重试', exact: true }).click()
    await page.locator('.transcript').getByText('echo: echo 第一轮', { exact: true }).first().waitFor({ timeout: 20_000 })
    expect(await page.locator('.run-end').count()).toBe(0)
    await shot(page, 'after-login-1440-light')
    await page.context().close()
  })

  it('picks up the same session after a login expires', async () => {
    const owner = await host.enroll({ listener: 'unix' })
    await writeFile(loginFile, 'yes')
    const page = await open(390, 'dark')
    const tasks = async () => (await owner.json<AppSnapshot>('snapshot')).tasks
    const before = await tasks()
    await page
      .getByRole('button', { name: /echo 第一轮/ })
      .first()
      .click()
    await page.locator('.transcript').waitFor()

    await rm(loginFile)
    const composer = page.getByRole('textbox').last()
    await composer.fill('echo 第二轮')
    await composer.press('Meta+Enter')
    await refusal(page).waitFor()
    await page.locator('.run-end').getByText('codex login', { exact: true }).waitFor()
    await noHorizontalOverflow(page)
    await shot(page, 'expired-390-dark')

    await writeFile(loginFile, 'yes')
    await page.locator('.run-end').getByRole('button', { name: '重试', exact: true }).click()
    await page.locator('.transcript').getByText('echo: echo 第二轮', { exact: true }).first().waitFor({ timeout: 20_000 })
    expect((await tasks()).length).toBe(before.length)
    await page.context().close()
  })

  it('stops saying so once the program says it is logged in', async () => {
    await rm(loginFile, { force: true })
    const page = await open(768, 'dark')
    const notice = page.getByRole('status', { name: '登录' })
    await notice.getByText('Codex 还没登录', { exact: true }).waitFor()
    await noHorizontalOverflow(page)
    await shot(page, 'draft-768-dark')
    await writeFile(loginFile, 'yes')
    await notice.getByRole('button', { name: '重新检查' }).click()
    await notice.waitFor({ state: 'detached' })
    await page.context().close()
  })
})
