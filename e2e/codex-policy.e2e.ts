import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { FAKE_CODEX_APP_SERVER } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import type { TestDevice } from '@latch/testkit'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSection, openSession, openSettings, permissionControl } from './helpers/layout.ts'

/**
 * What this computer's Codex policy and hooks look like in Latch: the hooks every Codex session runs, listed under its
 * MCP servers in 设置 › 扩展, and a permission mode its policy refuses, greyed with why in the composer's menu.
 */
const time = new Date('2026-11-20T06:00:00.000Z')
const OUTPUT = 'test-results/codex-policy'
const HOOKS = [
  {
    key: 'managed:prompt',
    eventName: 'userPromptSubmit',
    handlerType: 'command',
    command: '/opt/corp/audit',
    source: 'mdm',
    sourcePath: '/Library/Managed Preferences/corp.plist',
    isManaged: true,
    enabled: true,
    trustStatus: 'managed',
    currentHash: 'h1',
    displayOrder: 0,
    timeoutSec: 30,
  },
  {
    key: 'user:post',
    eventName: 'postToolUse',
    handlerType: 'command',
    command: 'echo done',
    source: 'user',
    sourcePath: '/Users/someone/.codex/hooks.json',
    isManaged: false,
    enabled: true,
    trustStatus: 'untrusted',
    currentHash: 'h2',
    displayOrder: 1,
    timeoutSec: 30,
  },
]

let root: string
let host: TestHost
let owner: TestDevice
let browser: Browser

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'latch-e2e-codex-policy-'))
  const bin = join(root, 'bin')
  const command = join(bin, 'codex')
  await mkdir(bin)
  await writeFile(command, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`)
  await chmod(command, 0o755)
  host = await startTestHost({
    demo: false,
    now: () => time.getTime(),
    commandDirectories: () => [bin],
    loginPrograms: name => (name === 'codex' ? command : undefined),
    detectPreset: preset => (preset.id === 'codex' ? { found: true, path: command } : { found: false }),
  })
  owner = await host.enroll({ listener: 'unix' })
  await owner.confirmedJson('agents', {
    body: {
      id: 'codex',
      name: 'Codex',
      presetId: 'codex',
      command: 'codex',
      args: [],
      env: {
        FAKE_CODEX_HOOKS: JSON.stringify(HOOKS),
        FAKE_CODEX_REQUIREMENTS: JSON.stringify({ allowedSandboxModes: ['read-only', 'workspace-write'] }),
      },
    },
  })
  browser = await chromium.launch(browserLaunchOptions())
  await mkdir(OUTPUT, { recursive: true })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await host?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

async function view(width: number, theme: 'light' | 'dark'): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width, height: 1000 },
    locale: 'zh-CN',
    colorScheme: theme,
    reducedMotion: 'reduce',
  })
  await context.clock.setFixedTime(time)
  const page = await context.newPage()
  await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
  return page
}

it('lists the hooks Codex runs under its MCP servers, with where each comes from and no command', async () => {
  const page = await view(1440, 'light')
  const settings = await openSettings(page)
  await openSection(settings, '扩展')
  await settings.getByRole('button', { name: /^Codex/u }).click()
  const codex = settings.locator('[data-extensions-harness="codex"]')
  await codex.getByRole('region', { name: 'MCP', exact: true }).getByRole('button', { name: '读取', exact: true }).click()
  const hooks = codex.getByRole('region', { name: '钩子', exact: true })
  await hooks.locator('[data-harness-hook="userPromptSubmit"]').waitFor()
  expect(await hooks.locator('[data-harness-hook="userPromptSubmit"]').innerText()).toMatch(/你发送消息时[\s\S]*设备管理[\s\S]*管理策略/u)
  expect(await hooks.locator('[data-harness-hook="postToolUse"]').innerText()).toMatch(/调用工具后[\s\S]*你的配置[\s\S]*未信任/u)
  expect(await codex.innerText()).not.toMatch(/\/opt\/corp|hooks\.json|Managed Preferences/u)
  await page.context().close()
  for (const width of [390, 768, 1440])
    for (const theme of ['light', 'dark'] as const) {
      const shot = await view(width, theme)
      const section = await openSettings(shot)
      await openSection(section, '扩展')
      await section.getByRole('button', { name: /^Codex/u }).click()
      const group = section.locator('[data-extensions-harness="codex"]').getByRole('region', { name: '钩子', exact: true })
      await group.locator('[data-harness-hook="postToolUse"]').waitFor()
      await noHorizontalOverflow(shot)
      await group.scrollIntoViewIfNeeded()
      await shot.screenshot({ path: `${OUTPUT}/hooks--${width}-${theme}.png`, animations: 'disabled' })
      await shot.context().close()
    }
})

it('greys the mode Codex’s policy refuses in the permission menu, with why, and keeps the session where it is', async () => {
  const created = await owner.confirmedJson<{ sessionId: string }>('tasks', {
    body: { prompt: 'echo policy', requestId: randomUUID(), harnessId: 'codex' },
  })
  const detail = () => owner.json<TaskDetail>(`tasks/${created.sessionId}`)
  await expect.poll(async () => (await detail()).summary.status, { timeout: 15_000 }).toBe('idle')
  const reason = '这台电脑的 Codex 管理策略不允许不用沙箱'
  for (const width of [390, 768, 1440])
    for (const theme of ['light', 'dark'] as const) {
      const page = await view(width, theme)
      await openSession(page, created.sessionId)
      await permissionControl(page).click()
      // A phone opens the modes in a sheet of their own, wider screens in a popover.
      const panel = (
        width < 768 ? page.getByRole('dialog', { name: '权限', exact: true }) : page.locator('.ui-popover:popover-open')
      ).locator('.permission-panel')
      await panel.waitFor()
      const refused = panel.locator('[role="radio"][aria-disabled="true"]')
      await expect.poll(() => refused.count()).toBe(1)
      // Touch shows the row's line under the strip, which is why it cannot be chosen; a pointer shows the same as its tooltip.
      if (width < 768) await refused.dispatchEvent('pointerenter')
      else await refused.hover()
      await expect.poll(() => panel.innerText()).toContain(reason)
      await refused.click({ force: true })
      expect((await detail()).permission?.expectedMode).toBe('read-only')
      await noHorizontalOverflow(page)
      await page.screenshot({ path: `${OUTPUT}/mode-menu--${width}-${theme}.png`, animations: 'disabled' })
      await page.context().close()
    }
})
