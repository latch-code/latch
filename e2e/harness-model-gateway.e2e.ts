import { chromium } from '@playwright/test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppSnapshot, ProviderSettings, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, FAKE_PI_AGENT, startFakeModels } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

afterEach(() => vi.unstubAllEnvs())

it.each(['opencode', 'dsh', 'pi'] as const)(
  'chooses %s service models and thinking in the normal menus and restores them',
  async harness => {
    // Only an explicitly authorized run substitutes an installed CLI. The upstream is always local and fake.
    const live = process.env[`LATCH_${harness.toUpperCase()}_GATEWAY_BINARY`]
    const root = await mkdtemp(join(tmpdir(), `latch-ui-${harness}-gateway-`))
    const bin = join(root, 'bin')
    await mkdir(bin)
    for (const name of [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
      'DSH_HOME',
      'PI_CODING_AGENT_DIR',
    ]) {
      const directory = join(root, name.toLowerCase())
      await mkdir(directory)
      vi.stubEnv(name, directory)
    }
    const command = live ?? join(bin, harness)
    if (!live) {
      const env =
        harness === 'pi'
          ? { FAKE_PI_GATEWAY: '1', FAKE_PI_SESSIONS: root }
          : {
              FAKE_ACP_CONFIG: 'options',
              FAKE_ACP_CAPS: 'resume',
              FAKE_ACP_GATEWAY: harness,
              FAKE_ACP_VERSION: harness === 'opencode' ? '2.2.6' : '0.2.2-rc.1',
              FAKE_ACP_MODES: harness === 'opencode' ? 'plan,build,auto-edit,yolo' : 'read-only,workspace-write,danger-full-access',
              FAKE_ACP_INITIAL_MODE: harness === 'opencode' ? 'build' : 'read-only',
              ...(harness === 'dsh' ? { FAKE_ACP_PROCESS_MODE: '1' } : {}),
              FAKE_ACP_STATE: join(root, 'agent-state.json'),
            }
      const version = harness === 'opencode' ? '2.2.6' : harness === 'pi' ? '1.5.0' : '0.2.2-rc.1'
      await writeFile(
        command,
        [
          '#!/bin/sh',
          `if [ "$1" = '--version' ]; then echo '${version}'; exit 0; fi`,
          ...Object.entries(env).map(([key, value]) => `export ${key}='${value}'`),
          `exec '${process.execPath}' '${harness === 'pi' ? FAKE_PI_AGENT : FAKE_ACP_AGENT}' "$@"`,
        ].join('\n'),
      )
      await chmod(command, 0o755)
    }
    const service = await startFakeModels({ replies: [{ text: 'gateway menu answer' }] })
    const names = ['service-only-model', 'service-only-next']
    const nativeValue = (id: string) =>
      harness === 'dsh' ? JSON.stringify(['latch-gateway', id]) : `${harness === 'opencode' ? 'latch' : 'latch-gateway'}/${id}`
    const options = {
      uiDir: process.env.LATCH_E2E_UI_DIR ?? resolve('dist/web'),
      demo: false,
      dataDir: join(root, 'host'),
      workspaceRoot: join(root, 'project'),
      commandDirectories: () => [dirname(command)],
      loginPrograms: (name: string) => (name === harness ? command : undefined),
      detectPreset: (preset: { id: string }) => (preset.id === harness ? { found: true, path: command } : { found: false }),
    }
    let host = await startTestHost(options)
    const port = Number(new URL(host.host.loopbackOrigin).port)
    let owner = await host.enroll({ listener: 'unix' })
    const browser = await chromium.launch(browserLaunchOptions())
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    page.setDefaultTimeout(20_000)
    const output = `test-results/harness-model-gateway/${harness}-${live ? 'live' : 'fake'}`
    await mkdir(output, { recursive: true })
    const chip = (name: string) =>
      page
        // 思考 is set in the model's entry: one chip opens both.
        .getByRole('button', { name: new RegExp(`^${name === '思考' ? '模型' : name}：`, 'u') })
        .filter({ visible: true })
        .first()
    const row = (name: string | RegExp) =>
      page.getByRole('menuitemradio', { name }).or(page.getByRole('option', { name })).or(page.getByRole('radio', { name })).first()
    // The model panel lists one source at a time (66e1b331): the service's models are under Latch 网关 on the rail.
    const serviceSource = async () =>
      page
        .getByRole('tablist', { name: '来源', exact: true })
        .getByRole('tab', { name: 'Latch 网关', exact: true })
        .filter({ visible: true })
        .first()
        .click()
    // A session's switch keeps the panel open on the new model's levels; it is closed before the next chip.
    const closePanel = async () => {
      const panel = page.locator('.model-board').filter({ visible: true })
      if (await panel.count()) {
        await page.keyboard.press('Escape')
        await expect.poll(() => panel.count()).toBe(0)
      }
    }
    try {
      const added = await owner.confirmed('providers', {
        body: {
          name: 'Temporary Chat',
          kind: 'openai-compatible',
          baseURL: `${service.origin}/v1`,
          apiKey: 'sk-test-ui-gateway-0123456789',
          models: names,
          defaultModel: names[0],
          modelCapabilities: Object.fromEntries(names.map(id => [id, { thinking: ['low', 'high'] }])),
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
              command: harness,
              args: harness === 'opencode' ? ['acp'] : harness === 'dsh' ? ['--profile', 'acp'] : [],
              env: harness === 'pi' ? { PI_GATEWAY_CONTEXT_TOKENS: '32768', PI_GATEWAY_OUTPUT_TOKENS: '4096' } : {},
            },
          })
        ).status,
      ).toBe(201)
      await enrollBrowser(page, host)
      await connected(page)
      await chip('模型').click()
      await serviceSource()
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
      expect(service.requests.some(request => request.model === names[0] && request.wire === 'chat-completions')).toBe(true)
      expect((await detail()).summary.modelRoute?.providerId).toBe(provider.id)
      await page
        .locator('.transcript')
        .getByText(/gateway menu answer/u)
        .first()
        .waitFor()
      let selectedThought = 'low'
      for (const [width, colorScheme] of [
        [1440, 'light'],
        [820, 'dark'],
        [390, 'light'],
      ] as const) {
        const chosen = names[width === 820 ? 0 : 1]!
        await page.setViewportSize({ width, height: 1000 })
        await page.emulateMedia({ colorScheme })
        await closePanel()
        await chip('模型').click()
        await serviceSource()
        await row(new RegExp(chosen, 'u')).waitFor()
        await noHorizontalOverflow(page)
        await page.screenshot({ path: `${output}/models-${width}.png`, animations: 'disabled' })
        await row(new RegExp(chosen, 'u')).click()
        await expect
          .poll(async () => (await detail()).config?.find(option => option.category === 'model')?.currentValue)
          .toBe(nativeValue(chosen))
        const thought =
          (await detail()).config?.find(option => option.category === 'thought_level')?.currentValue === 'low' ? 'high' : 'low'
        const thoughtLabel = thought === 'high' ? /^(high|High|高)$/u : /^(low|Low|低)$/u
        selectedThought = thought
        await closePanel()
        await chip('思考').click()
        await row(thoughtLabel).waitFor()
        await noHorizontalOverflow(page)
        await page.screenshot({ path: `${output}/thinking-${width}.png`, animations: 'disabled' })
        await row(thoughtLabel).click()
        await expect
          .poll(async () => (await detail()).config?.find(option => option.category === 'thought_level')?.currentValue)
          .toBe(thought)
      }
      await closePanel()
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
      expect((await detail()).config?.find(option => option.category === 'thought_level')?.currentValue).toBe(selectedThought)
      if (live)
        expect(service.requests.findLast(request => request.model === names[1])?.body).toMatchObject({ reasoning_effort: selectedThought })
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${output}/restored.png`, animations: 'disabled' })
      await writeFile(
        `${output}/evidence.json`,
        JSON.stringify({
          actualCli: Boolean(live),
          upstream: 'local fake Chat Completions',
          testPresence: true,
          privateHome: true,
          model: names[1],
          thought: selectedThought,
          requests: service.requests.length,
        }),
      )
    } catch (error) {
      if (await page.locator('.app-shell').count()) {
        await page.screenshot({ path: `${output}/failure.png`, animations: 'disabled' })
        await writeFile(`${output}/failure-menu.txt`, (await page.locator('[role=menu], [role=listbox]').allTextContents()).join('\n'))
      }
      throw error
    } finally {
      await browser.close()
      await host.close()
      await service.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
