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

    // The menu holds both: its own models under its name, and the service's under 经 Latch.
    const chip = page
      .getByRole('button', { name: /^模型：/u })
      .filter({ visible: true })
      .first()
    const row = (name: string | RegExp) =>
      page.getByRole('menuitemradio', { name }).or(page.getByRole('option', { name })).or(page.getByRole('radio', { name })).first()
    await chip.click()
    await row(/fake-model/u).waitFor()
    const menu = page.locator('[role=menu], [role=listbox]').filter({ visible: true }).first()
    await menu.getByText('Codex', { exact: true }).first().waitFor()
    await menu
      .getByText(/Temporary Responses · .*经 Latch/u)
      .first()
      .waitFor()
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
