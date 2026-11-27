import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { openSession, settleShell } from './helpers/layout.ts'

const OUT = 'test-results/generated-outputs'

it('separates gitignored outputs from code changes, opens the Generated panel from the turn card, and cleans up ignored files', async () => {
  let workspace = ''
  let pngBytes: Buffer = Buffer.alloc(0)
  const plugin: HarnessPlugin = {
    id: 'generated-outputs-fixture',
    name: 'Fixture',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerProvider({
        id: 'writer',
        name: 'Fixture',
        model: 'fixture',
        async *stream() {
          await new Promise(resolve => setTimeout(resolve, 40))
          await mkdir(join(workspace, 'src'), { recursive: true })
          await mkdir(join(workspace, 'docs'), { recursive: true })
          await mkdir(join(workspace, 'test-results', 'reply-media'), { recursive: true })
          await writeFile(join(workspace, 'src', 'app.ts'), 'export const ready = true\n')
          await writeFile(join(workspace, 'docs', 'summary.html'), '<!doctype html><title>Summary</title><h1>Report</h1>\n')
          await writeFile(join(workspace, 'test-results', 'reply-media', 'desktop-1440.png'), pngBytes)
          await writeFile(join(workspace, 'test-results', 'reply-media', 'phone-390.png'), pngBytes)
          yield { type: 'text', text: '已完成代码修改并完成端到端截图验证。' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }

  const host = await startTestHost({ demo: false, plugins: [plugin] })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    workspace = host.workspaceRoot
    await mkdir(OUT, { recursive: true })

    // Draw a valid crisp PNG via headless browser canvas so thumbnails render cleanly.
    const drawPage = await browser.newPage()
    const b64 = await drawPage.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 480
      canvas.height = 300
      const ctx = canvas.getContext('2d')!
      const g = ctx.createLinearGradient(0, 0, 480, 300)
      g.addColorStop(0, '#2c5ad6')
      g.addColorStop(1, '#182b66')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, 480, 300)
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      ctx.beginPath()
      ctx.arc(160, 150, 64, 0, Math.PI * 2)
      ctx.fill()
      return canvas.toDataURL('image/png').split(',')[1]!
    })
    pngBytes = Buffer.from(b64, 'base64')
    await drawPage.close()

    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
        cwd: host.workspaceRoot,
        env: { PATH: process.env.PATH, HOME: host.root, GIT_CONFIG_NOSYSTEM: '1' },
        stdio: 'pipe',
      })
    git('init', '-q', '-b', 'main')
    await writeFile(join(host.workspaceRoot, '.gitignore'), '/test-results/\n')
    await mkdir(join(host.workspaceRoot, 'src'), { recursive: true })
    await writeFile(join(host.workspaceRoot, 'src', 'app.ts'), 'export const ready = false\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')

    const { sessionId } = await host.host.bridge.createTask({
      prompt: '验证修改并生成测试截图',
      requestId: randomUUID(),
      mode: 'agent',
      model: { providerId: 'writer', model: 'fixture' },
    })

    await expect
      .poll(
        async () => {
          const detail = await host.host.bridge.detail(sessionId)
          return detail.summary.status === 'idle' && detail.messages.some(m => (m.outputs?.length ?? 0) >= 3 && !m.outputsPending)
        },
        { timeout: 15_000 },
      )
      .toBe(true)

    // Check responsive rendering on phone (390 light) and tablet (768 dark) first before deleting files.
    for (const [width, theme] of [
      [390, 'light'],
      [768, 'dark'],
    ] as const) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, locale: 'zh-CN' })
      const p = await ctx.newPage()
      try {
        await enrollBrowser(p, host, { name: `Outputs ${width} ${theme}`, scopes: ['admin'], dataScope: 'all' })
        await openSession(p, sessionId)
        await p.getByRole('region', { name: '这一轮改动的文件', exact: true }).getByText('改动了 2 个文件').waitFor()
        await p
          .getByRole('region', { name: '这一轮生成的文件', exact: true })
          .getByRole('button', { name: '查看与清理', exact: true })
          .click()
        const panel = p.getByRole('region', { name: '生成文件', exact: true })
        await panel.getByText('临时产物', { exact: true }).waitFor()
        await settleShell(p)
        expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await p.screenshot({ path: `${OUT}/panel-${width}-${theme}.png`, animations: 'disabled' })
      } finally {
        await ctx.close()
      }
    }

    // Desktop dark (1440 dark) and desktop light (1440 light) + grid toggle + full one-click cleanup flow.
    const darkCtx = await browser.newContext({ viewport: { width: 1440, height: 920 }, colorScheme: 'dark', locale: 'zh-CN' })
    const darkPage = await darkCtx.newPage()
    try {
      await enrollBrowser(darkPage, host, { name: 'Outputs 1440 dark', scopes: ['admin'], dataScope: 'all' })
      await openSession(darkPage, sessionId)
      await darkPage
        .getByRole('region', { name: '这一轮生成的文件', exact: true })
        .getByRole('button', { name: '查看与清理', exact: true })
        .click()
      const panel = darkPage.getByRole('region', { name: '生成文件', exact: true })
      await panel.getByText('desktop-1440.png', { exact: true }).waitFor()
      await panel.locator('.outputs-thumb-tile img').first().waitFor()
      await settleShell(darkPage)
      await darkPage.screenshot({ path: `${OUT}/panel-1440-dark.png`, animations: 'disabled' })
    } finally {
      await darkCtx.close()
    }

    const lightCtx = await browser.newContext({ viewport: { width: 1440, height: 920 }, colorScheme: 'light', locale: 'zh-CN' })
    const page = await lightCtx.newPage()
    try {
      await enrollBrowser(page, host, { name: 'Outputs 1440 light', scopes: ['admin'], dataScope: 'all' })
      await openSession(page, sessionId)

      // Turn changed-files card only counts the 2 unignored files (`src/app.ts` and `docs/summary.html`), NOT the 2 gitignored screenshots!
      const changedCard = page.getByRole('region', { name: '这一轮改动的文件', exact: true })
      await changedCard.getByText('改动了 2 个文件', { exact: true }).waitFor()
      const producedCard = page.getByRole('region', { name: '这一轮生成的文件', exact: true })
      await producedCard.getByText('生成了 3 个文件', { exact: true }).waitFor()
      await producedCard.getByText('含 2 个忽略文件', { exact: true }).waitFor()

      await producedCard.getByRole('button', { name: '查看与清理', exact: true }).click()
      const panel = page.getByRole('region', { name: '生成文件', exact: true })
      await panel.getByText('临时产物', { exact: true }).waitFor()
      await panel.getByText('新建文件', { exact: true }).waitFor()
      await panel.locator('.outputs-thumb-tile img').first().waitFor()
      await settleShell(page)
      await page.screenshot({ path: `${OUT}/panel-1440-light.png`, animations: 'disabled' })

      // Verify contact-sheet grid view toggle renders cleanly, then return to list view.
      await panel.getByRole('button', { name: '缩略图网格', exact: true }).click()
      await panel.locator('.outputs-card-media img').first().waitFor()
      await settleShell(page)
      await page.screenshot({ path: `${OUT}/panel-grid-1440-light.png`, animations: 'disabled' })
      await panel.getByRole('button', { name: '列表视图', exact: true }).click()

      // Click one-click cleanup for temporary/ignored files.
      await panel.getByRole('button', { name: '清理临时文件 (2)', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '删除 2 个生成文件？', exact: true })
      await dialog.getByText('test-results/reply-media/desktop-1440.png', { exact: true }).waitFor()
      await page.screenshot({ path: `${OUT}/confirm-1440-light.png`, animations: 'disabled' })
      await dialog.getByRole('button', { name: '永久删除', exact: true }).click()

      // Wait for cleanup to finish: temporary section disappears while `docs/summary.html` remains intact!
      await expect.poll(() => existsSync(join(host.workspaceRoot, 'test-results')), { timeout: 10_000 }).toBe(false)
      expect(existsSync(join(host.workspaceRoot, 'docs', 'summary.html'))).toBe(true)
      expect(existsSync(join(host.workspaceRoot, 'src', 'app.ts'))).toBe(true)
      await expect.poll(() => panel.getByText('临时产物', { exact: true }).count()).toBe(0)
      await panel.getByText('summary.html', { exact: true }).waitFor()
    } finally {
      await lightCtx.close()
    }
  } finally {
    await host.close()
    await browser.close()
  }
})
