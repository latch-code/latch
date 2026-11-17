import { chromium } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AppSnapshot } from '@latch/protocol'
import { FAKE_CODEX_APP_SERVER } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSection, openSettings } from './helpers/layout.ts'

const time = new Date('2026-11-13T06:00:00.000Z')

it('shows only names before a Codex session reports MCP states, and preserves those states after another read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'latch-e2e-own-mcp-'))
  const bin = join(root, 'bin')
  const command = join(bin, 'codex')
  await mkdir(bin)
  await writeFile(command, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`)
  await chmod(command, 0o755)
  const host = await startTestHost({
    demo: false,
    now: () => time.getTime(),
    commandDirectories: () => [bin],
    loginPrograms: name => (name === 'codex' ? command : undefined),
    detectPreset: preset => (preset.id === 'codex' ? { found: true, path: command } : { found: false }),
  })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      body: {
        id: 'codex',
        name: 'Codex',
        presetId: 'codex',
        command: 'codex',
        args: [],
        env: {
          FAKE_CODEX_MCP: JSON.stringify([
            { name: 'files', runtimeStatus: 'connected', tools: { read: {} }, authStatus: 'unsupported' },
            { name: 'linear', runtimeStatus: 'authenticationRequired', tools: {}, authStatus: 'notLoggedIn' },
          ]),
        },
      },
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
    await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
    const settings = await openSettings(page)
    await openSection(settings, '扩展')
    await settings.getByRole('button', { name: /^Codex/u }).click()
    const group = settings.locator('[data-extensions-harness="codex"]').getByRole('region', { name: 'MCP', exact: true })
    await group.getByRole('button', { name: '读取', exact: true }).click()
    await group.getByText('只有名字', { exact: true }).waitFor()
    expect(await group.locator('[data-harness-mcp="files"]').textContent()).not.toContain('可用')
    expect(await group.locator('[data-harness-mcp="linear"]').textContent()).not.toContain('需要登录')
    const output = 'test-results/harness-mcp-status'
    await mkdir(output, { recursive: true })
    const capture = async (state: 'names' | 'session') => {
      for (const width of [390, 768, 1440])
        for (const theme of ['light', 'dark'] as const) {
          const context = await browser.newContext({
            viewport: { width, height: 1000 },
            locale: 'zh-CN',
            colorScheme: theme,
            reducedMotion: 'reduce',
          })
          await context.clock.setFixedTime(time)
          try {
            const view = await context.newPage()
            await enrollBrowser(view, host, { scopes: ['view', 'run', 'admin'] })
            const section = await openSettings(view)
            await openSection(section, '扩展')
            await section.getByRole('button', { name: /^Codex/u }).click()
            const own = section.locator('[data-extensions-harness="codex"]').getByRole('region', { name: 'MCP', exact: true })
            if (state === 'names') await own.getByText('只有名字', { exact: true }).waitFor()
            else await own.locator('[data-harness-mcp="linear"]').getByText('需要登录', { exact: true }).waitFor()
            await noHorizontalOverflow(view)
            await own.scrollIntoViewIfNeeded()
            await view.screenshot({ path: `${output}/${state}--${width}-${theme}.png`, animations: 'disabled' })
          } finally {
            await context.close()
          }
        }
    }
    await capture('names')
    await owner.confirmedJson('tasks', { body: { prompt: 'echo MCP', requestId: randomUUID(), harnessId: 'codex' } })
    await group.locator('[data-harness-mcp="files"]').getByText('可用 · 1 个工具', { exact: true }).waitFor()
    await group.locator('[data-harness-mcp="linear"]').getByText('需要登录', { exact: true }).waitFor()
    const report = async () => (await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(h => h.id === 'codex')?.ownMcp?.last
    const before = await report()
    expect(before?.via).toBe('session')
    const read = page.waitForResponse(response => response.url().endsWith('/agents/codex/mcp') && response.request().method() === 'POST')
    await group.getByRole('button', { name: '读取', exact: true }).click()
    expect((await read).status()).toBe(200)
    await expect
      .poll(async () => (await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(h => h.id === 'codex')?.ownMcp?.running)
      .not.toBe(true)
    expect(await report()).toEqual(before)
    expect(await group.getByText('只有名字', { exact: true }).count()).toBe(0)
    await capture('session')
  } finally {
    await browser.close()
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})
