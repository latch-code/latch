import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { expect, it, vi } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { startFakeModels } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'
import { promptValue } from './helpers/prompt.ts'

const binary = process.env.LATCH_CODEX_GATEWAY_BINARY
it.skipIf(process.env.LATCH_SLASH_LIVE !== '1' || !binary)(
  'runs a real Codex compact from the menu and waits for actual cancellation',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-codex-compact-ui-'))
    let service: Awaited<ReturnType<typeof startFakeModels>> | undefined
    let host: Awaited<ReturnType<typeof startTestHost>> | undefined
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    const output = 'test-results/codex-compact-live'
    try {
      for (const name of ['HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
        const path = join(root, name.toLowerCase())
        await mkdir(path)
        vi.stubEnv(name, path)
      }
      let hold = false
      service = await startFakeModels({ replyFor: () => ({ text: 'The public plan is retained.', ...(hold ? { delayMs: 30_000 } : {}) }) })
      host = await startTestHost({
        demo: false,
        dataDir: join(root, 'data'),
        workspaceRoot: join(root, 'project'),
        uiDir: resolve(process.env.LATCH_E2E_UI_DIR ?? 'dist/web'),
        commandDirectories: () => [dirname(binary!)],
        loginPrograms: name => (name === 'codex' ? binary : undefined),
        detectPreset: preset => (preset.id === 'codex' ? { found: true, path: binary! } : { found: false }),
      })
      const owner = await host.enroll({ listener: 'unix' })
      expect(
        (
          await owner.confirmed('providers', {
            method: 'POST',
            body: {
              name: 'Local command fixture',
              kind: 'openai-responses',
              baseURL: `${service.origin}/v1`,
              apiKey: 'sk-test-compact-local-only',
              models: ['gpt-5.5'],
              defaultModel: 'gpt-5.5',
              confirmOrigin: true,
            },
          })
        ).status,
      ).toBe(201)
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
      browser = await chromium.launch(browserLaunchOptions())
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
      await mkdir(output, { recursive: true })
      try {
        await enrollBrowser(page, host)
        await connected(page)
        await page
          .getByRole('button', { name: /^模型：/u })
          .filter({ visible: true })
          .first()
          .click()
        await page.getByRole('menu', { name: '模型', exact: true }).getByRole('menuitemradio', { name: 'gpt-5.5', exact: true }).click()
        const first = page.getByRole('textbox', { name: '新会话消息', exact: true })
        await first.fill('Remember the public plan: check the heading, then report.')
        await first.press('Meta+Enter')
        await expect.poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.length).toBe(1)
        const id = (await owner.json<AppSnapshot>('snapshot')).tasks[0]!.id
        const detail = () => owner.json<TaskDetail>(`tasks/${id}`)
        await expect.poll(async () => (await detail()).summary.status).toBe('idle')
        expect((await detail()).commands).toContainEqual(expect.objectContaining({ name: 'compact', idleOnly: true }))
        const input = page.getByRole('textbox', { name: '继续对话', exact: true })
        const list = page.getByRole('listbox', { name: '命令与提示模板', exact: true })
        for (const [width, theme] of [
          [1440, 'light'],
          [768, 'dark'],
          [390, 'dark'],
        ] as const) {
          await page.setViewportSize({ width, height: 1000 })
          await page.emulateMedia({ colorScheme: theme })
          await input.fill('/compact')
          await list.getByRole('option').filter({ hasText: '/compact' }).waitFor()
          await noHorizontalOverflow(page)
          await page.screenshot({ path: `${output}/menu-${width}-${theme}.png`, animations: 'disabled' })
        }
        await list.getByRole('option').filter({ hasText: '/compact' }).click()
        expect((await promptValue(input)).trim()).toBe('/compact')
        await input.press('Meta+Enter')
        await expect.poll(async () => (await detail()).messages.some(message => message.text === 'Codex 已压缩上下文')).toBe(true)
        await expect.poll(async () => (await detail()).summary.status).toBe('idle')
        await page.screenshot({ path: `${output}/completed-390-dark.png`, animations: 'disabled' })
        hold = true
        const before = service.requests.length
        await input.fill('/compact')
        await input.press('Meta+Enter')
        await expect.poll(() => service!.requests.length).toBe(before + 1)
        expect((await detail()).summary.status).toBe('running')
        await input.fill('/compact')
        expect(await list.getByRole('option').filter({ hasText: '/compact' }).getAttribute('aria-disabled')).toBe('true')
        expect(await list.innerText()).toContain('这一轮结束后可用')
        const queued = await owner.request(`tasks/${id}/prompt`, {
          method: 'POST',
          body: { prompt: '/compact', requestId: randomUUID(), queue: true },
        })
        expect(queued.status).toBe(409)
        expect(await queued.json()).toMatchObject({ error: 'command-queued' })
        await input.fill('')
        await page.screenshot({ path: `${output}/running-390-dark.png`, animations: 'disabled' })
        await page.getByRole('button', { name: '停止', exact: true }).filter({ visible: true }).click()
        await expect.poll(async () => (await detail()).summary.status).toBe('cancelled')
        await expect.poll(async () => (await detail()).messages.some(message => message.text === 'Codex 已取消压缩上下文')).toBe(true)
        await page.screenshot({ path: `${output}/cancelled-390-dark.png`, animations: 'disabled' })
        const beforeReview = service.requests.length
        await input.fill('/review check the public plan')
        await input.press('Meta+Enter')
        await expect.poll(async () => (await detail()).summary.status).toBe('failed')
        expect(service.requests).toHaveLength(beforeReview)
        expect((await detail()).commands?.some(command => command.name === 'review')).toBe(false)
        expect((await detail()).messages.some(message => message.text.includes('原生审阅不会先询问'))).toBe(true)
        await page.screenshot({ path: `${output}/review-refused-390-dark.png`, animations: 'disabled' })
        await writeFile(
          `${output}/evidence.json`,
          JSON.stringify(
            {
              actualCli: true,
              modelUpstream: 'local controlled Responses fixture',
              testPresence: true,
              temporaryHome: true,
              cliStorageReadByTest: false,
              modelRequests: service.requests.length,
              commands: (await detail()).commands,
              status: (await detail()).summary.status,
              reviewRefusedWithoutModelRequest: true,
            },
            null,
            2,
          ) + '\n',
        )
      } catch (error) {
        await page.screenshot({ path: `${output}/failure.png`, animations: 'disabled' })
        throw error
      }
    } finally {
      try {
        await browser?.close()
      } finally {
        try {
          await host?.close()
        } finally {
          try {
            await service?.close()
          } finally {
            vi.unstubAllEnvs()
            await rm(root, { recursive: true, force: true })
          }
        }
      }
    }
  },
)
