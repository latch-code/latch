import { chromium, type Browser, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FAKE_ACP_AGENT, FAKE_PI_AGENT } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSection, openSettings } from './helpers/layout.ts'

const OUTPUT = process.env.LATCH_ACCEPTANCE_DIR ?? 'test-results/harness-connect'
const NEED = '需要 0.2.2-rc.1 或更高版本（当前 0.1.1-rc.2）'
const UPGRADE = 'npm i -g @deepseek-ai/dsh@latest'

/**
 * A Mac where DeepSeek Harness is installed but too old and Codex has only its own CLI: what settings and a new session say,
 * on a Host that may run the person's programs only inside a temporary folder of fakes.
 */
describe('a Harness that cannot connect yet', () => {
  let directory: string
  let host: TestHost
  let browser: Browser

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'latch-e2e-connect-'))
    const bin = join(directory, 'bin')
    await mkdir(bin)
    const dshVersion = join(directory, 'dsh-version')
    await writeFile(dshVersion, '0.2.2-rc.1')
    const scripts: Record<string, string> = {
      dsh: `if [ "$1" = --version ]; then cat '${dshVersion}'; echo; exit 0; fi\nexec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
      // Never added: only choosing it reads its version.
      pi: `if [ "$1" = --version ]; then echo 0.84.3; exit 0; fi\nexec '${process.execPath}' '${FAKE_PI_AGENT}' "$@"`,
      codex: `echo 'codex-cli 0.167.0'`,
    }
    for (const [name, body] of Object.entries(scripts)) {
      await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`)
      await chmod(join(bin, name), 0o755)
    }
    const at = (name: string) => (existsSync(join(bin, name)) ? join(bin, name) : undefined)
    host = await startTestHost({
      demo: false,
      detectPreset: preset => {
        const path = at(preset.command)
        return {
          ...(path ? { found: true, path } : { found: false }),
          ...(preset.agentCommand ? { agent: { command: preset.agentCommand, found: at(preset.agentCommand) !== undefined } } : {}),
        }
      },
      loginPrograms: at,
      commandDirectories: () => [bin],
    })
    // A definition saved while its version was new enough, found too old on a later 重新检测 (as after a downgrade).
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'dsh', name: 'DeepSeek Harness', presetId: 'dsh', command: 'dsh', args: ['--profile', 'acp'], env: {} },
    })
    await writeFile(dshVersion, '0.1.1-rc.2')
    await owner.json('agents')
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

  for (const [width, theme] of [
    [1440, 'light'],
    [1440, 'dark'],
    [390, 'light'],
    [390, 'dark'],
  ] as const) {
    it(`says what each one needs at ${width} ${theme}`, async () => {
      const page = await open(width, theme)
      if (width === 390) {
        // A phone opens on its session list; a new session is one step in.
        await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
        await page.getByRole('textbox', { name: '新会话消息', exact: true }).waitFor()
        // DeepSeek Harness is not offered as if it could run.
        expect(await page.getByRole('button', { name: /DeepSeek Harness/u }).count()).toBe(0)
        await shot(page, `new-session-${width}-${theme}`)
        await page.getByRole('button', { name: '取消', exact: true }).click()
      } else {
        // The new session's Harness menu offers no preset to a browser, since saving one is confirmed on the Mac; the
        // too-old DeepSeek Harness is listed greyed with 需要升级, never as a choice.
        await page.getByRole('button', { name: /^Harness[：\s]/u }).click()
        await page.getByRole('menuitem', { name: '添加 Harness…', exact: true }).waitFor()
        expect(await page.getByRole('menuitemradio', { name: /^Codex/u }).count()).toBe(0)
        const old = page.getByRole('menuitemradio', { name: /DeepSeek Harness/u })
        expect(await old.getAttribute('aria-disabled')).toBe('true')
        await old.getByText('需要升级', { exact: true }).waitFor()
        await noHorizontalOverflow(page)
        await shot(page, `new-session-harnesses-${width}-${theme}`)
        await page.keyboard.press('Escape')
      }

      // Settings › Harness: the same reasons, and 重新检测.
      const settings = await openSettings(page)
      await openSection(settings, 'Harness')
      const found = settings.locator('.agent-row, .settings-row').filter({ hasText: 'DeepSeek Harness' }).first()
      // The row says what to do; its page says why and how (below).
      await found.getByText('需要升级', { exact: true }).waitFor()
      // Codex alone is found: no word of an adapter.
      await settings.locator('.agent-row').filter({ hasText: 'Codex' }).getByText('已找到', { exact: true }).waitFor()
      expect(await settings.getByText(/codex-acp|适配器/u).count()).toBe(0)
      await noHorizontalOverflow(page)
      await shot(page, `settings-${width}-${theme}`)
      await page.context().close()
    })
  }

  it('keeps a saved definition from starting and says why', async () => {
    const owner = await host.enroll({ listener: 'unix' })
    for (const theme of ['light', 'dark'] as const) {
      const page = await open(1440, theme)
      const settings = await openSettings(page)
      await openSection(settings, 'Harness')
      const row = settings.locator('.agent-row, .settings-row').filter({ hasText: 'DeepSeek Harness' }).first()
      await row.getByText('需要升级', { exact: true }).waitFor()
      await shot(page, `settings-saved-1440-${theme}`)
      await settings
        .getByRole('button', { name: /DeepSeek Harness/u })
        .first()
        .click()
      await settings.getByText('需要升级', { exact: true }).first().waitFor()
      await settings.getByText(NEED, { exact: true }).first().waitFor()
      await settings.getByText(UPGRADE, { exact: true }).first().waitFor()
      await settings.getByRole('button', { name: '复制升级命令', exact: true }).waitFor()
      await shot(page, `settings-saved-detail-1440-${theme}`)
      await page.context().close()
    }
    const refused = await owner.request('tasks', {
      method: 'POST',
      body: { harnessId: 'dsh', prompt: 'hello', requestId: crypto.randomUUID() },
    })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: 'harness-version-unsupported' })
  })

  it('reads the version of a preset only once it is confirmed, refuses a too-old one then, and says it needs an upgrade', async () => {
    const owner = await host.enroll({ listener: 'unix' })
    const asked = host.presence.requests.length
    // The desktop app saves a preset when it is first used: the program is confirmed before it is run for its version.
    const refused = await owner.confirmed('agents', {
      method: 'POST',
      body: { id: 'pi', name: 'pi', presetId: 'pi', command: 'pi', args: [], env: {}, enabled: true },
    })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({
      error: 'harness-version-unsupported',
      message: 'pi 需要 0.84.4 或更高版本（当前 0.84.3）。升级：npm i -g @earendil-works/pi-coding-agent@latest',
    })
    expect(host.presence.requests).toHaveLength(asked + 1)
    expect(host.presence.requests.at(-1)?.preview.action).toBe('harness.command.apply')
    const after = await owner.json<{ agents: Array<{ id: string }> }>('agents')
    expect(after.agents.map(agent => agent.id)).toEqual(['dsh'])
    expect((await owner.json<{ tasks: unknown[] }>('snapshot')).tasks).toEqual([])
    // The picker now says it needs an upgrade instead of offering it.
    const page = await open(1440, 'light')
    await page.getByRole('button', { name: /^Harness[：\s]/u }).click()
    await page.getByRole('menuitem', { name: '添加 Harness…', exact: true }).click()
    const presets = page.getByRole('group', { name: '添加 Harness', exact: true })
    await presets.getByRole('button', { name: /^pi/u }).getByText('需要升级', { exact: true }).waitFor()
    await shot(page, 'unsaved-after-1440-light')
    await page.context().close()
  })
})
