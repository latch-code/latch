import { chromium } from '@playwright/test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppSnapshot, ProviderSettings, TaskDetail } from '@latch/protocol'
import { FAKE_CODEX_APP_SERVER, startFakeModels } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

// An explicit owner-authorized run may substitute the installed CLI; all ordinary runs use the fake app-server.
const live = process.env.LATCH_CODEX_GATEWAY_BINARY
afterEach(() => vi.unstubAllEnvs())

it.each(['openai-responses', 'openai-compatible'] as const)(
  'chooses a native Codex %s service model and preserves it through Host recovery',
  async kind => {
    const wire = kind === 'openai-compatible' ? 'chat-completions' : 'responses'
    const root = await mkdtemp(join(tmpdir(), 'latch-ui-codex-gateway-'))
    const bin = join(root, 'bin')
    const home = join(root, 'home')
    await mkdir(bin)
    await mkdir(join(home, '.codex'), { recursive: true })
    if (live) {
      vi.stubEnv('HOME', home)
      vi.stubEnv('CODEX_HOME', join(home, '.codex'))
    }
    const log = join(root, 'fake.jsonl')
    const command = live ?? join(bin, 'codex')
    if (!live) {
      await writeFile(
        command,
        `#!/bin/sh\nexport FAKE_ACP_LOG='${log}' FAKE_CODEX_STATE='${join(root, 'threads.json')}'\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`,
      )
      await chmod(command, 0o755)
    }
    const replies = live
      ? [
          { tool: { name: 'exec_command', input: { cmd: "printf 'gateway-tool-ok'", yield_time_ms: 1000, max_output_tokens: 100 } } },
          { text: 'native gateway answer' },
        ]
      : [{ text: 'native gateway answer' }]
    const service = await startFakeModels({ replies })
    const key = 'sk-test-ui-native-gateway-0123456789'
    const names = ['latch-service-only-a', 'latch-service-only-b']
    const options = {
      demo: false,
      dataDir: join(root, 'data'),
      workspaceRoot: join(root, 'project'),
      commandDirectories: () => [dirname(command)],
      loginPrograms: (name: string) => (name === 'codex' ? command : undefined),
      detectPreset: (preset: { id: string }) => (preset.id === 'codex' ? { found: true, path: command } : { found: false }),
    }
    let host = await startTestHost(options)
    const port = Number(new URL(host.host.loopbackOrigin).port)
    let owner = await host.enroll({ listener: 'unix' })
    const browser = await chromium.launch(browserLaunchOptions())
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    page.setDefaultTimeout(20_000)
    const output = `test-results/codex-model-gateway-${wire}-${live ? 'live' : 'fake'}`
    await mkdir(output, { recursive: true })
    const chip = () =>
      page
        .getByRole('button', { name: /^模型：/u })
        .filter({ visible: true })
        .first()
    const modelSurface = page.getByRole('menu', { name: '模型', exact: true }).or(page.getByRole('dialog', { name: '模型', exact: true }))
    const modelRow = (name: string) =>
      modelSurface
        .getByRole('menuitemradio', { name, exact: true })
        .or(modelSurface.getByRole('option', { name, exact: true }))
        .or(modelSurface.getByRole('radio', { name, exact: true }))
    try {
      const added = await owner.confirmed('providers', {
        method: 'POST',
        body: {
          name: `Temporary ${wire}`,
          kind,
          baseURL: `${service.origin}/v1`,
          apiKey: key,
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
            method: 'POST',
            body: {
              id: 'codex',
              name: 'Codex',
              presetId: 'codex',
              command: 'codex',
              args: [],
              env: {},
            },
          })
        ).status,
      ).toBe(201)
      await enrollBrowser(page, host)
      await connected(page)
      await chip().click()
      await modelRow(names[0]!).waitFor()
      if (wire === 'chat-completions') {
        await modelSurface.getByText('协议转换 · 实验性', { exact: true }).waitFor()
        await page.keyboard.press('Escape')
        for (const width of [320, 390, 768, 1440]) {
          for (const colorScheme of ['light', 'dark'] as const) {
            await page.setViewportSize({ width, height: 1000 })
            await page.emulateMedia({ colorScheme })
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
            if (!(await chip().isVisible())) await page.getByRole('button', { name: '新会话选项', exact: true }).click()
            await chip().click()
            await modelRow(names[0]!).waitFor()
            await modelRow(names[0]!).scrollIntoViewIfNeeded()
            const conversionNote = modelSurface.locator('.ui-hint').filter({ has: page.getByText('协议转换 · 实验性', { exact: true }) })
            await conversionNote.scrollIntoViewIfNeeded()
            await noHorizontalOverflow(page)
            await page.screenshot({ path: `${output}/menu-${width}-${colorScheme}.png`, animations: 'disabled' })
            if (width === 320 && colorScheme === 'dark') {
              await conversionNote.getByRole('button', { name: '说明', exact: true }).click()
              await conversionNote.locator('.ui-hint-detail').waitFor()
              await noHorizontalOverflow(page)
              await page.screenshot({ path: `${output}/conversion-detail-320-dark.png`, animations: 'disabled' })
              await conversionNote.getByRole('button', { name: '说明', exact: true }).click()
            }
            await page.keyboard.press('Escape')
          }
        }
        await page.setViewportSize({ width: 1440, height: 1000 })
        await page.emulateMedia({ colorScheme: 'light' })
        await chip().click()
      }
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${output}/menu.png`, animations: 'disabled' })
      await modelRow(names[0]!).click()
      const draft = page.getByRole('textbox', { name: '新会话消息', exact: true })
      await draft.fill('Run the one supplied diagnostic command if requested, then reply.')
      await draft.press('Meta+Enter')
      await expect.poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.length).toBe(1)
      const id = (await owner.json<AppSnapshot>('snapshot')).tasks[0]!.id
      const detail = () => owner.json<TaskDetail>(`tasks/${id}`)
      await expect
        .poll(
          async () => {
            const current = await detail()
            if (current.approvals.length)
              await page.locator('[data-approval-id]').getByRole('button', { name: '允许', exact: true }).click()
            return current.summary.status
          },
          { timeout: 60_000 },
        )
        .toBe('idle')
      await page.locator('.transcript').getByText('native gateway answer', { exact: true }).waitFor()
      expect((await detail()).summary.modelRoute).toMatchObject({ providerId: provider.id, model: names[0] })
      expect(service.requests[0]).toMatchObject({ wire, model: names[0], key })
      if (live) {
        const body = service.requests.at(-1)?.body as {
          input?: Array<{ type?: string; output?: string }>
          messages?: Array<{ role: string; content?: string }>
        }
        const outputs = [
          ...(body.input ?? []).filter(item => item.type === 'function_call_output').map(item => item.output ?? ''),
          ...(body.messages ?? []).filter(item => item.role === 'tool').map(item => item.content ?? ''),
        ]
        expect(outputs.some(output => output.includes('gateway-tool-ok'))).toBe(true)
        expect((await detail()).messages.some(message => message.role === 'tool' && message.state === 'completed')).toBe(true)
      }
      await page.screenshot({ path: `${output}/first.png`, animations: 'disabled' })

      await chip().click()
      await modelRow(names[1]!).click()
      await expect.poll(async () => (await detail()).config?.find(option => option.category === 'model')?.currentValue).toBe(names[1])
      await host.close()
      host = await startTestHost({ ...options, port })
      owner = await host.enroll({ listener: 'unix' })
      await page.reload()
      await connected(page)
      const next = page.getByRole('textbox', { name: '继续对话', exact: true })
      await next.fill('Reply once after recovery.')
      const submitted = page.waitForResponse(
        response => response.request().method() === 'POST' && /\/tasks\/[^/]+\/prompt$/u.test(response.url()),
      )
      await next.press('Meta+Enter')
      expect((await submitted).ok()).toBe(true)
      await expect.poll(async () => (await detail()).summary.status, { timeout: 60_000 }).toBe('idle')
      expect(service.requests.at(-1)).toMatchObject({ wire, model: names[1], key })
      expect((await detail()).config?.find(option => option.category === 'model')?.currentValue).toBe(names[1])
      await expect.poll(() => page.locator(`[data-task-id="${id}"] .session-status`).innerText()).not.toMatch(/运行中|正在/u)
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${output}/restored.png`, animations: 'disabled' })
      if (!live) {
        const text = await readFile(log, 'utf8')
        expect(text).not.toContain(key)
        expect(text).not.toContain('lmg1.')
      }
      await writeFile(
        `${output}/evidence.json`,
        `${JSON.stringify({ actualCli: Boolean(live), upstream: `local fake ${wire}`, temporaryHome: Boolean(live), testPresence: true, createdModel: names[0], restoredModel: names[1], requests: service.requests.length, cliCredentialsReadByTest: false }, null, 2)}\n`,
      )
    } catch (error) {
      await page.screenshot({ path: `${output}/failure.png`, animations: 'disabled' })
      throw error
    } finally {
      await browser.close()
      await host.close()
      await service.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
