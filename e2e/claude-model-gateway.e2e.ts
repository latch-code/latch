import { chromium } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppSnapshot, ProviderSettings, TaskDetail } from '@latch/protocol'
import { startFakeModels } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

afterEach(() => vi.unstubAllEnvs())

const live = process.env.LATCH_CLAUDE_GATEWAY_BINARY
it.skipIf(!live)('chooses real Claude gateway models in the normal menus and restores the exact model', async () => {
  const harness = 'claude-agent'
  const root = await mkdtemp(join(tmpdir(), `latch-ui-${harness}-gateway-`))
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CLAUDE_CONFIG_DIR']) {
    const directory = join(root, name.toLowerCase())
    await mkdir(directory)
    vi.stubEnv(name, directory)
  }
  vi.stubEnv('NO_PROXY', '127.0.0.1,localhost,::1')
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) vi.stubEnv(name, 'http://127.0.0.1:9')
  const command = live!
  const service = await startFakeModels({ replies: [{ text: 'gateway menu answer' }] })
  const names = ['service-only-model', 'service-only-next']
  const nativeValue = (id: string) => id
  const options = {
    uiDir: process.env.LATCH_E2E_UI_DIR ?? resolve('dist/web'),
    demo: false,
    dataDir: join(root, 'host'),
    workspaceRoot: join(root, 'project'),
    commandDirectories: () => [dirname(command)],
    loginPrograms: (name: string) => (name === 'claude-agent-acp' ? command : undefined),
    detectPreset: (preset: { id: string }) => (preset.id === harness ? { found: true, path: command } : { found: false }),
  }
  let host = await startTestHost(options)
  const port = Number(new URL(host.host.loopbackOrigin).port)
  let owner = await host.enroll({ listener: 'unix' })
  const browser = await chromium.launch(browserLaunchOptions())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  page.setDefaultTimeout(20_000)
  const output = 'test-results/claude-model-gateway'
  await mkdir(output, { recursive: true })
  const chip = (name: string) =>
    page
      .getByRole('button', { name: new RegExp(`^${name}：`, 'u') })
      .filter({ visible: true })
      .first()
  const row = (name: string | RegExp) =>
    page.getByRole('menuitemradio', { name }).or(page.getByRole('option', { name })).or(page.getByRole('radio', { name })).first()
  try {
    const added = await owner.confirmed('providers', {
      body: {
        name: 'Temporary Anthropic',
        kind: 'anthropic',
        baseURL: `${service.origin}/v1`,
        apiKey: 'sk-test-ui-gateway-0123456789',
        models: names,
        defaultModel: names[0],
        confirmOrigin: true,
      },
    })
    expect(added.status).toBe(201)
    const provider = ((await added.json()) as { provider: ProviderSettings }).provider
    expect(
      (
        await owner.confirmed('agents', {
          body: {
            id: harness,
            name: harness,
            presetId: harness,
            command,
            args: ['--hide-claude-auth'],
            env: {},
          },
        })
      ).status,
    ).toBe(201)
    await enrollBrowser(page, host)
    await connected(page)
    await chip('模型').click()
    await row(names[0]!).waitFor()
    await page.screenshot({ path: `${output}/draft.png`, animations: 'disabled' })
    await row(names[0]!).click()
    const draft = page.getByRole('textbox', { name: '新会话消息', exact: true })
    await draft.fill('model Reply once through the chosen service.')
    await draft.press('Meta+Enter')
    await expect.poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.length).toBe(1)
    const sessionId = (await owner.json<AppSnapshot>('snapshot')).tasks[0]!.id
    const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
    await expect.poll(async () => (await detail()).summary.status, { timeout: 60_000 }).toBe('idle')
    expect(service.requests.some(request => request.model === names[0] && request.wire === 'anthropic-messages')).toBe(true)
    expect((await detail()).summary.modelRoute?.providerId).toBe(provider.id)
    await page
      .locator('.transcript')
      .getByText(/gateway menu answer/u)
      .first()
      .waitFor()
    for (const [width, colorScheme] of [
      [1440, 'light'],
      [820, 'dark'],
      [390, 'light'],
    ] as const) {
      const chosen = names[width === 820 ? 0 : 1]!
      await page.setViewportSize({ width, height: 1000 })
      await page.emulateMedia({ colorScheme })
      await chip('模型').click()
      await row(new RegExp(chosen, 'u')).waitFor()
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${output}/models-${width}.png`, animations: 'disabled' })
      await row(new RegExp(chosen, 'u')).click()
      await expect
        .poll(async () => (await detail()).config?.find(option => option.category === 'model')?.currentValue)
        .toBe(nativeValue(chosen))
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await host.close()
    host = await startTestHost({ ...options, port })
    owner = await host.enroll({ listener: 'unix' })
    await page.reload()
    await connected(page)
    const next = page.getByRole('textbox', { name: '继续对话', exact: true })
    await next.fill('model Reply once after recovery.')
    await next.press('Meta+Enter')
    await expect.poll(async () => service.requests.some(request => request.model === names[1]), { timeout: 60_000 }).toBe(true)
    await expect.poll(async () => (await detail()).summary.status).toBe('idle')
    expect((await detail()).config?.find(option => option.category === 'model')?.currentValue).toBe(nativeValue(names[1]!))
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${output}/restored.png`, animations: 'disabled' })
    await writeFile(
      `${output}/evidence.json`,
      JSON.stringify({
        actualCli: Boolean(live),
        upstream: 'local fake Anthropic Messages',
        testPresence: true,
        privateHome: true,
        model: names[1],
        requests: service.requests.length,
      }),
    )
  } catch (error) {
    if (await page.locator('.app-shell').count()) {
      await page.screenshot({ path: `${output}/failure.png`, animations: 'disabled' })
      await writeFile(
        `${output}/failure-models.json`,
        JSON.stringify((await owner.json<AppSnapshot>('snapshot')).tasks.map(task => ({ id: task.id, route: task.modelRoute }))),
      )
      await writeFile(`${output}/failure-menu.txt`, (await page.locator('[role=menu], [role=listbox]').allTextContents()).join('\n'))
    }
    throw error
  } finally {
    await browser.close()
    await host.close()
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})
