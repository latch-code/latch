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
import { noHorizontalOverflow, openSection, openSettings } from './helpers/layout.ts'

const OUTPUT = 'test-results/harness-login'

describe('logging in to a Harness from a browser', () => {
  let directory: string
  let loginFile: string
  let refuseStart: string
  let host: TestHost
  let browser: Browser

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'latch-e2e-login-'))
    loginFile = join(directory, 'login')
    refuseStart = join(directory, 'refuse-start')
    const bin = join(directory, 'bin')
    await mkdir(bin)
    for (const name of ['codex', 'codex-acp']) {
      await writeFile(
        join(bin, name),
        [
          '#!/bin/sh',
          `export FAKE_ACP_LOGIN_FILE='${loginFile}' FAKE_ACP_CAPS=resume FAKE_ACP_STATE='${join(directory, 'state.json')}' FAKE_ACP_LOGOUT=1`,
          'export FAKE_ACP_MODES=read-only,workspace-write,agent-full-access FAKE_ACP_INITIAL_MODE=read-only FAKE_ACP_CONFIG=options',
          // A stored login the service no longer takes: the handshake is refused while `login status` still says yes.
          `[ -e '${refuseStart}' ] && export FAKE_ACP_INIT_AUTH=1`,
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

  it('logs out from the Harness page and says how to log in again', async () => {
    await writeFile(loginFile, 'yes')
    const page = await open(1440, 'dark')
    const settings = await openSettings(page)
    await openSection(settings, 'Harness')
    await settings.getByRole('button', { name: '编辑 Codex', exact: true }).click()
    const group = settings.locator('.settings-group', { has: page.getByRole('heading', { name: '登录', exact: true }) })
    // The last answer was from before the file came back; asking again runs the program.
    await group.getByRole('button', { name: '重新检查' }).click()
    await group.getByText('已登录', { exact: true }).waitFor()
    // Cancelled, nothing changes.
    await group.getByRole('button', { name: '退出登录' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click()
    expect(existsSync(loginFile)).toBe(true)
    await group.getByRole('button', { name: '退出登录' }).click()
    await page.getByRole('dialog').getByText('有会话正在运行时不能退出', { exact: false }).waitFor()
    await page.getByRole('dialog').getByRole('button', { name: '退出登录' }).click()
    await group.getByText('已退出登录', { exact: true }).waitFor()
    await group.getByText('codex login', { exact: true }).waitFor()
    expect(existsSync(loginFile)).toBe(false)
    await shot(page, 'logged-out-1440-dark')
    // After a reload the program itself says so.
    await page.reload()
    await connected(page)
    const again = await openSettings(page)
    await openSection(again, 'Harness')
    await again.getByRole('button', { name: '编辑 Codex', exact: true }).click()
    await again
      .locator('.settings-group', { has: page.getByRole('heading', { name: '登录', exact: true }) })
      .getByText('还没登录', { exact: true })
      .waitFor()
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

  it('takes a test start that says otherwise as the newer answer', async () => {
    const owner = await host.enroll({ listener: 'unix' })
    const saved = await owner.request('agents', {
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex-acp', args: [], env: {} },
    })
    expect([201, 409]).toContain(saved.status)
    await writeFile(loginFile, 'yes')
    const page = await open(1440, 'light')
    const settings = await openSettings(page)
    await openSection(settings, 'Harness')
    await settings.getByRole('button', { name: '编辑 Codex', exact: true }).click()
    const group = settings.locator('.settings-group', { has: page.getByRole('heading', { name: '登录', exact: true }) })
    const probe = settings.locator('.settings-group', { has: page.getByRole('heading', { name: '测试启动', exact: true }) })
    await group.getByRole('button', { name: '重新检查' }).click()
    await group.getByText('已登录', { exact: true }).waitFor()

    // Logged out elsewhere, with this window never losing focus: the test start reads it, and the group follows.
    await rm(loginFile)
    await probe.getByRole('button', { name: '测试启动' }).click()
    await probe.getByText('还没登录', { exact: true }).waitFor({ timeout: 25_000 })
    await group.getByText('还没登录', { exact: true }).waitFor()
    expect(await group.getByRole('button', { name: '退出登录' }).count()).toBe(0)
    await shot(page, 'probe-logged-out-1440-light')

    // And back.
    await writeFile(loginFile, 'yes')
    await probe.getByRole('button', { name: '测试启动' }).click()
    await probe.getByText('可以启动，已登录', { exact: true }).waitFor({ timeout: 25_000 })
    await group.getByText('已登录', { exact: true }).waitFor()
    await page.context().close()
  })

  it('says how to log in when a test start is refused while the program says it is logged in', async () => {
    const owner = await host.enroll({ listener: 'unix' })
    const saved = await owner.request('agents', {
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex-acp', args: [], env: {} },
    })
    expect([201, 409]).toContain(saved.status)
    await writeFile(loginFile, 'yes')
    await writeFile(refuseStart, 'yes')
    const page = await open(1440, 'light')
    const settings = await openSettings(page)
    await openSection(settings, 'Harness')
    await settings.getByRole('button', { name: '编辑 Codex', exact: true }).click()
    const group = settings.locator('.settings-group', { has: page.getByRole('heading', { name: '登录', exact: true }) })
    const probe = settings.locator('.settings-group', { has: page.getByRole('heading', { name: '测试启动', exact: true }) })
    await group.getByRole('button', { name: '重新检查' }).click()
    await group.getByText('已登录', { exact: true }).waitFor()

    await probe.getByRole('button', { name: '测试启动' }).click()
    await probe.getByText('还没登录', { exact: true }).waitFor({ timeout: 25_000 })
    // `login status` still says yes after the group asks again, so the group says the two disagree and how to log in.
    await group.getByText('登录可能已失效', { exact: true }).waitFor()
    await group.getByText('codex login', { exact: true }).waitFor()
    expect(await group.getByText('已登录', { exact: true }).count()).toBe(0)
    await group.getByRole('button', { name: '退出登录' }).waitFor()
    await shot(page, 'probe-refused-1440-light')
    await page.context().close()

    // The last test start is kept, and so is what it said, on a phone too.
    const phone = await open(390, 'dark')
    const again = await openSettings(phone)
    await openSection(again, 'Harness')
    await again.getByRole('button', { name: '编辑 Codex', exact: true }).click()
    const phoneGroup = again.locator('.settings-group', { has: phone.getByRole('heading', { name: '登录', exact: true }) })
    await phoneGroup.getByText('登录可能已失效', { exact: true }).waitFor()
    await phoneGroup.getByText('codex login', { exact: true }).waitFor()
    await noHorizontalOverflow(phone)
    await phoneGroup.scrollIntoViewIfNeeded()
    await shot(phone, 'probe-refused-390-dark')

    // Logged in again: the next test start goes through and the group says so alone.
    await rm(refuseStart)
    const phoneProbe = again.locator('.settings-group', { has: phone.getByRole('heading', { name: '测试启动', exact: true }) })
    await phoneProbe.getByRole('button', { name: '测试启动' }).click()
    await phoneProbe.getByText('可以启动，已登录', { exact: true }).waitFor({ timeout: 25_000 })
    await phoneGroup.getByText('已登录', { exact: true }).waitFor()
    expect(await phoneGroup.getByText('codex login', { exact: true }).count()).toBe(0)
    await phone.context().close()
  })
})
