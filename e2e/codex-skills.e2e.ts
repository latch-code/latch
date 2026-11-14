import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { expect, it, vi } from 'vitest'
import type { AppSnapshot, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { startFakeModels } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession, settleShell } from './helpers/layout.ts'

const binary = process.env.LATCH_CODEX_GATEWAY_BINARY
it.skipIf(process.env.LATCH_SLASH_LIVE !== '1' || !binary)(
  'uses an explicitly typed skill through the normal UI and a private real Codex',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-codex-skills-ui-')))
    let service: Awaited<ReturnType<typeof startFakeModels>> | undefined
    let host: Awaited<ReturnType<typeof startTestHost>> | undefined
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    const output = 'test-results/codex-skills-live'
    try {
      for (const name of ['HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
        const path = join(root, name.toLowerCase())
        await mkdir(path)
        vi.stubEnv(name, path)
      }
      const projectPath = join(root, 'project')
      const directory = join(projectPath, '.agents', 'skills', 'latch-ui-proof')
      await mkdir(directory, { recursive: true })
      const skillPath = join(directory, 'SKILL.md')
      const marker = 'LATCH_SKILL_UI_BODY_20261114'
      await writeFile(
        skillPath,
        '---\nname: latch-ui-proof\ndescription: An explicit public UI verification skill.\n---\nThe public fixture phrase is '
          + marker
          + '.\n',
      )
      service = await startFakeModels({
        replyFor: request => ({ text: JSON.stringify(request.body).includes(marker) ? '已读取本轮指定技能的正文。' : '未收到技能正文。' }),
      })
      host = await startTestHost({
        demo: false,
        dataDir: join(root, 'data'),
        workspaceRoot: join(root, 'default'),
        uiDir: resolve(process.env.LATCH_E2E_UI_DIR ?? 'dist/web'),
        commandDirectories: () => [dirname(binary!)],
        loginPrograms: name => (name === 'codex' ? binary : undefined),
        detectPreset: preset => (preset.id === 'codex' ? { found: true, path: binary! } : { found: false }),
      })
      const owner = await host.enroll({ listener: 'unix' })
      const { workspace } = (await (await owner.addFolders({ paths: [projectPath], name: '技能项目' })).json()) as {
        workspace: WorkspaceInfo
      }
      await owner.confirmedJson('providers', {
        method: 'POST',
        body: {
          name: 'Local skill fixture',
          kind: 'openai-responses',
          baseURL: `${service.origin}/v1`,
          apiKey: 'sk-test-skills-local-only',
          models: ['gpt-5.5'],
          defaultModel: 'gpt-5.5',
          confirmOrigin: true,
        },
      })
      await owner.confirmedJson('agents', {
        method: 'POST',
        body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex', args: [], env: {} },
      })
      await owner.json('preferences', {
        method: 'PUT',
        body: { defaults: { harnessId: 'codex', workspaceId: workspace.id, mode: 'agent', pinned: true } },
      })
      browser = await chromium.launch(browserLaunchOptions())
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
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
        const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
        await input.fill('$latch-ui-proof 请直接回答公开验证语句，不要运行工具。')
        await input.press('Meta+Enter')
        await page.locator('.transcript').getByText('已读取本轮指定技能的正文。', { exact: true }).waitFor()
        const tasks = (await owner.json<AppSnapshot>('snapshot')).tasks
        expect(tasks).toHaveLength(1)
        const id = tasks[0]!.id
        await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${id}`)).summary.status).toBe('idle')
        const detail = await owner.json<TaskDetail>(`tasks/${id}`)
        expect(detail.skills).toContainEqual(
          expect.objectContaining({ name: 'latch-ui-proof', invocation: '$latch-ui-proof', scope: 'project' }),
        )
        expect(detail.commands?.some(command => command.name === 'latch-ui-proof')).toBe(false)
        expect(JSON.stringify(detail)).not.toContain(skillPath)
        expect(service.requests).toHaveLength(1)
        expect(JSON.stringify(service.requests[0]?.body)).toContain(marker)
        const continued = page.getByRole('textbox', { name: '继续对话', exact: true })
        const menu = page.getByRole('listbox', { name: '命令与提示模板', exact: true })
        for (const [width, theme] of [
          [1440, 'light'],
          [768, 'dark'],
          [390, 'dark'],
        ] as const) {
          await page.setViewportSize({ width, height: 1000 })
          await page.emulateMedia({ colorScheme: theme })
          await settleShell(page)
          if (!(await continued.isVisible())) await openSession(page, id)
          await continued.fill('/latch-ui-proof')
          await menu.getByRole('option').first().waitFor()
          await noHorizontalOverflow(page)
          await page.screenshot({ path: `${output}/picker-${width}-${theme}.png`, animations: 'disabled' })
          await continued.press('Enter')
          expect(await continued.inputValue()).toBe('$latch-ui-proof ')
          expect(service.requests).toHaveLength(1)
        }
        await page.setViewportSize({ width: 1440, height: 1000 })
        await settleShell(page)
        if (!(await continued.isVisible())) await openSession(page, id)
        expect(await continued.inputValue()).toBe('$latch-ui-proof ')
        await continued.press('End')
        await continued.pressSequentially('请再次直接回答公开验证语句，不要运行工具。')
        await continued.press('Meta+Enter')
        await expect.poll(() => service!.requests.length).toBe(2)
        await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${id}`)).summary.status).toBe('idle')
        expect(JSON.stringify(service.requests[1]?.body)).toContain(marker)
        await page.screenshot({ path: `${output}/picker-completed.png`, animations: 'disabled' })
        await writeFile(
          `${output}/evidence.json`,
          JSON.stringify(
            {
              normalUi: true,
              pickerInsertsWithoutSending: true,
              bodyMarkerReceived: true,
              currentSkillsHaveNoPath: true,
              modelRequests: service.requests.length,
              model: service.requests[0]?.model,
              wire: service.requests[0]?.wire,
            },
            null,
            2,
          ),
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
