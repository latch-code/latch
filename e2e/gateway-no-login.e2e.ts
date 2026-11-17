import { chromium } from '@playwright/test'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import type { AppSnapshot, ProviderSettings, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, startFakeModels } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

const OUTPUT = 'test-results/gateway-no-login'

it('runs a Harness that is not logged in on a model of a Latch service, and asks for its login only for its own models', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-e2e-no-login-'))
  const bin = join(root, 'bin')
  await mkdir(bin)
  // The fake as Codex behind its adapter: never logged in (the login file is never written), and pointed at a service
  // the way the adapter is, by ACP `providers/set`.
  for (const name of ['codex', 'codex-acp']) {
    await writeFile(
      join(bin, name),
      [
        '#!/bin/sh',
        `export FAKE_ACP_LOGIN_FILE='${join(root, 'login')}' FAKE_ACP_CAPS=resume FAKE_ACP_STATE='${join(root, 'state.json')}'`,
        'export FAKE_ACP_MODES=read-only,workspace-write,agent-full-access FAKE_ACP_INITIAL_MODE=read-only FAKE_ACP_CONFIG=options',
        'export FAKE_ACP_PROVIDERS=1 FAKE_ACP_MODELS=own-model,fake-model',
        `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
      ].join('\n'),
    )
    await chmod(join(bin, name), 0o755)
  }
  const service = await startFakeModels({ replies: [{ text: 'answer without a login' }] })
  const host = await startTestHost({
    uiDir: process.env.LATCH_E2E_UI_DIR ?? resolve('dist/web'),
    demo: false,
    sessionFolders: true,
    detectPreset: preset => (preset.id === 'codex' ? { found: true, path: join(bin, 'codex-acp') } : { found: false }),
    loginPrograms: name => (existsSync(join(bin, name)) ? join(bin, name) : undefined),
    commandDirectories: () => [bin],
  })
  const browser = await chromium.launch(browserLaunchOptions())
  await mkdir(OUTPUT, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  page.setDefaultTimeout(20_000)
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const added = await owner.confirmed('providers', {
      body: {
        name: 'Temporary Responses',
        kind: 'openai-responses',
        baseURL: `${service.origin}/v1`,
        apiKey: 'sk-test-no-login-0123456789abcdef',
        models: ['fake-model'],
        defaultModel: 'fake-model',
        confirmOrigin: true,
      },
    })
    expect(added.status).toBe(201)
    const provider = ((await added.json()) as { provider: ProviderSettings }).provider
    const saved = await owner.confirmed('agents', {
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex-acp', args: [], env: {} },
    })
    expect(saved.status).toBe(201)
    await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
    await connected(page)

    // On its own models the draft says it is not logged in.
    const notice = page.getByRole('status', { name: '登录' })
    await notice.getByText('Codex 还没登录', { exact: true }).waitFor()
    await page.screenshot({ path: `${OUTPUT}/own-model-1440.png`, animations: 'disabled' })

    // The menu holds both: its own models under its name, and the service's under Latch 网关.
    const chip = page
      .getByRole('button', { name: /^模型：/u })
      .filter({ visible: true })
      .first()
    const row = (name: string | RegExp) =>
      page.getByRole('menuitemradio', { name }).or(page.getByRole('option', { name })).or(page.getByRole('radio', { name })).first()
    // The panel lists one source at a time (66e1b331): its rail names Codex and Latch 网关, the gateway to the service.
    const source = (name: RegExp) => page.getByRole('tablist', { name: '来源', exact: true }).getByRole('tab', { name }).first()
    await chip.click()
    await source(/^Codex$/u).waitFor()
    await source(/^Latch 网关$/u).click()
    await page.getByRole('group', { name: 'Temporary Responses', exact: true }).waitFor()
    await row(/fake-model/u).waitFor()
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUTPUT}/menu-1440.png`, animations: 'disabled' })

    // A model of the service: no login is needed, so the row goes, and the turn just runs.
    await row(/fake-model/u).click()
    await expect.poll(() => notice.count()).toBe(0)
    await page.screenshot({ path: `${OUTPUT}/service-model-1440.png`, animations: 'disabled' })
    const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
    await input.fill('model Reply once through the chosen service.')
    await input.press('Meta+Enter')
    await page
      .locator('.transcript')
      .getByText(/answer without a login/u)
      .first()
      .waitFor({ timeout: 30_000 })
    expect(await page.locator('.run-end').count()).toBe(0)
    expect(await page.getByText(/还没登录/u).count()).toBe(0)
    const tasks = (await owner.json<AppSnapshot>('snapshot')).tasks
    expect(tasks).toHaveLength(1)
    const detail = await owner.json<TaskDetail>(`tasks/${tasks[0]!.id}`)
    expect(detail.summary).toMatchObject({ status: 'idle', modelRoute: { providerId: provider.id, model: 'fake-model' } })
    expect(detail.summary.runEnd?.reason).toBeUndefined()
    expect(service.requests).toMatchObject([{ wire: 'responses', model: 'fake-model' }])
    // The session's model chip keeps the service's mark the draft's had, so it reads apart from one on Codex's own model.
    const sessionChip = page.locator('main.workspace:not([inert]) form.composer').getByRole('button', { name: /^模型：/u })
    await sessionChip.locator('.ui-value-picker-lead .ui-tile').waitFor()
    await page.screenshot({ path: `${OUTPUT}/ran-1440.png`, animations: 'disabled' })

    // Phone width: the same draft, the same absence of a login row.
    await page.setViewportSize({ width: 390, height: 844 })
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUTPUT}/ran-390.png`, animations: 'disabled' })
  } catch (error) {
    await page.screenshot({ path: `${OUTPUT}/failure.png`, animations: 'disabled' }).catch(() => {})
    throw error
  } finally {
    await browser.close()
    await host.close()
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)

it('shows a Harness that cannot be asked about its login the same login row once reading its lists is refused for it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-e2e-no-login-unasked-'))
  const bin = join(root, 'bin')
  await mkdir(bin)
  const loginFile = join(root, 'login')
  // The fake as Qwen Code: no status command, so only a refused session says it is not logged in.
  await writeFile(
    join(bin, 'qwen'),
    [
      '#!/bin/sh',
      `export FAKE_ACP_LOGIN_FILE='${loginFile}' FAKE_ACP_STATE='${join(root, 'state.json')}'`,
      'export FAKE_ACP_MODES=plan,default,auto-edit,auto,yolo FAKE_ACP_INITIAL_MODE=default FAKE_ACP_CONFIG=options',
      `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
    ].join('\n'),
  )
  await chmod(join(bin, 'qwen'), 0o755)
  const service = await startFakeModels({ replies: [] })
  const host = await startTestHost({
    uiDir: process.env.LATCH_E2E_UI_DIR ?? resolve('dist/web'),
    demo: false,
    detectPreset: preset => (preset.id === 'qwen' ? { found: true, path: join(bin, 'qwen') } : { found: false }),
    loginPrograms: name => (existsSync(join(bin, name)) ? join(bin, name) : undefined),
    commandDirectories: () => [bin],
  })
  const browser = await chromium.launch(browserLaunchOptions())
  await mkdir(OUTPUT, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  page.setDefaultTimeout(20_000)
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const added = await owner.confirmed('providers', {
      body: {
        name: 'Temporary Chat',
        kind: 'openai-compatible',
        baseURL: `${service.origin}/v1`,
        apiKey: 'sk-test-no-login-fedcba9876543210',
        models: ['fake-model'],
        defaultModel: 'fake-model',
        confirmOrigin: true,
      },
    })
    expect(added.status).toBe(201)
    const saved = await owner.confirmed('agents', {
      body: { id: 'qwen', name: 'Qwen Code', presetId: 'qwen', command: 'qwen', args: ['--acp'], env: {} },
    })
    expect(saved.status).toBe(201)
    const qwen = async () => (await owner.json<AppSnapshot>('snapshot')).catalog!.harnesses.find(harness => harness.id === 'qwen')!
    expect((await qwen()).login?.checkable).toBeUndefined()
    await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
    await connected(page)

    // Nothing is known yet, and nothing is asked: no row before the first read.
    const notice = page.getByRole('status', { name: '登录' })
    expect(await notice.count()).toBe(0)
    const chip = page
      .getByRole('button', { name: /^模型：/u })
      .filter({ visible: true })
      .first()
    const menu = page.locator('[role=menu], [role=listbox]').filter({ visible: true }).first()
    // Opening the model menu reads its lists; the session it opens for that is refused for want of a login.
    await chip.click()
    await expect.poll(async () => (await qwen()).catalogueRead?.last).toMatchObject({ ok: false, loginRequired: true })
    await menu.getByText('重新读取', { exact: true }).waitFor()
    await page.screenshot({ path: `${OUTPUT}/unasked-menu-1440.png`, animations: 'disabled' })
    // The menu says the state in a word; the sentence and the way to log in are not repeated in it.
    await menu.locator('.model-note[data-tone="warn"]').getByText('还没登录', { exact: true }).waitFor()
    expect(await menu.getByText(/没有读到|按它自己的方式/u).count()).toBe(0)
    // The same row as a Harness that can be asked: the command with its copy button, and where to run it from a browser.
    await notice.getByText('Qwen Code 还没登录', { exact: true }).waitFor()
    await notice.getByText('qwen', { exact: true }).waitFor()
    await notice.getByRole('button', { name: '复制登录命令', exact: true }).waitFor()
    await notice.getByText('在这台 Mac 的终端里运行这条命令。').waitFor()
    await notice.getByRole('button', { name: '重新检查', exact: true }).waitFor()
    await noHorizontalOverflow(page)

    // A model of a service: the Harness's login is not what the draft depends on, so the row and the word both go.
    const row = (name: string | RegExp) =>
      page.getByRole('menuitemradio', { name }).or(page.getByRole('option', { name })).or(page.getByRole('radio', { name })).first()
    // The panel lists one source at a time (66e1b331): the service's models are under Latch 网关 on the rail.
    const source = (name: RegExp) => page.getByRole('tablist', { name: '来源', exact: true }).getByRole('tab', { name }).first()
    await source(/^Latch 网关$/u).click()
    await row(/fake-model/u).click()
    await expect.poll(() => notice.count()).toBe(0)
    await chip.click()
    await menu.getByText('重新读取', { exact: true }).waitFor()
    expect(await menu.getByText('还没登录', { exact: true }).count()).toBe(0)
    await page.screenshot({ path: `${OUTPUT}/unasked-service-model-1440.png`, animations: 'disabled' })
    // Back on its own model the row is back.
    await source(/^Qwen Code$/u).click()
    await row(/默认模型/u).click()
    await notice.getByText('Qwen Code 还没登录', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.screenshot({ path: `${OUTPUT}/unasked-own-model-1440.png`, animations: 'disabled' })

    // Still logged out, 重新检查 reads again and the row stays; logged in, the read goes through and the row leaves.
    await notice.getByRole('button', { name: '重新检查', exact: true }).click()
    await expect.poll(async () => Date.parse((await qwen()).catalogueRead!.last!.at)).toBeGreaterThan(0)
    await notice.getByText('Qwen Code 还没登录', { exact: true }).waitFor()
    await writeFile(loginFile, 'logged in\n')
    await notice.getByRole('button', { name: '重新检查', exact: true }).click()
    await expect.poll(() => notice.count()).toBe(0)
    expect((await qwen()).catalogueRead?.last).toMatchObject({ ok: true })
    await chip.click()
    await row(/Small/u).waitFor()
    expect(await menu.getByText('还没登录', { exact: true }).count()).toBe(0)
    // Nothing was sent anywhere by any of it.
    expect((await owner.json<AppSnapshot>('snapshot')).tasks).toEqual([])
    expect(service.requests).toEqual([])
  } catch (error) {
    await page.screenshot({ path: `${OUTPUT}/unasked-failure.png`, animations: 'disabled' }).catch(() => {})
    throw error
  } finally {
    await browser.close()
    await host.close()
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
