import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { Device, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSection, settleShell } from './helpers/layout.ts'

const OUT = 'test-results/workbench-states'
async function layout(page: Page, value: 'overview' | 'triage') {
  await page.getByRole('button', { name: '布局', exact: true }).locator('visible=true').first().click()
  await page.getByRole('menuitemradio', { name: value === 'overview' ? '总览' : '分拣台', exact: true }).click()
  await settleShell(page)
}
async function shot(page: Page, name: string, width: number, theme: 'light' | 'dark') {
  await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 })
  await page.emulateMedia({ colorScheme: theme })
  await page.evaluate(() => document.fonts.ready)
  await settleShell(page)
  await noHorizontalOverflow(page)
  await page.screenshot({ path: `${OUT}/${name}--${theme}--${width}.png`, animations: 'disabled', caret: 'hide' })
}

it('renders the v8 empty, loading, many, limited, read-only and offline states from the real Host permissions', async () => {
  let releaseRead: (() => void) | undefined
  const plugin: HarnessPlugin = {
    id: 'workbench-states',
    name: '界面状态验收',
    version: '1',
    description: 'Local scripted provider only.',
    activate(context) {
      context.registerProvider({
        id: 'state-model',
        name: '本地验收模型',
        model: 'fixture',
        async *stream({ messages }) {
          const prompt = messages.findLast(message => message.role === 'user')?.content ?? ''
          const ordinal = /配置 (\d+)$/u.exec(prompt)?.[1] ?? '1'
          if (messages.at(-1)?.role !== 'tool') {
            yield { type: 'text', text: '准备保存配置，需要你确认写入。' }
            yield {
              type: 'tool-call',
              call: {
                id: randomUUID(),
                name: 'write_file',
                arguments: { path: `settings-${ordinal}.ts`, content: 'export const keep = true\n' },
              },
            }
            yield { type: 'finish', reason: 'tool-calls' }
            return
          }
          yield { type: 'text', text: '配置已经保存。' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({ demo: false, plugins: [plugin], providerId: 'state-model', hostName: '验收电脑' })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  const page = await context.newPage()
  const ids: string[] = []
  page.setDefaultTimeout(15_000)
  try {
    await mkdir(OUT, { recursive: true })
    const owner = await host.enroll({ listener: 'unix' })
    const folder = join(host.root, 'state-project')
    await mkdir(folder)
    for (let i = 1; i <= 7; i++) await writeFile(join(folder, `settings-${i}.ts`), 'export const keep = false\n')
    const added = await owner.addFolders({ name: '设置项目', paths: [folder] })
    const { workspace } = (await added.json()) as { workspace: WorkspaceInfo }
    await enrollBrowser(page, host, { name: '状态验收设备', scopes: ['admin'] })
    const { devices } = await owner.json<{ devices: Device[] }>('devices')
    const device = devices.find(item => item.name === '状态验收设备')!
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    await page.reload()
    await connected(page)
    expect(await page.locator('.workbench-home .work-overview-group').count()).toBe(0)
    await page.locator('.workbench-empty').getByRole('heading', { name: '还没有会话' }).waitFor()
    await shot(page, 'overview-empty', 1440, 'dark')
    await layout(page, 'triage')
    await shot(page, 'triage-empty', 1440, 'dark')
    await layout(page, 'overview')
    const readGate = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    await page.route(/\/link\/api\/tasks\/[^/?]+$/u, async route => {
      if (route.request().method() !== 'GET') return route.continue()
      await readGate
      return route.continue().catch(cause => {
        if (route.request().failure()?.errorText === 'net::ERR_ABORTED') return
        throw cause
      })
    })
    for (let i = 1; i <= 7; i++) {
      const task = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          prompt: `保存配置 ${i}`,
          workspaceId: workspace.id,
          model: { providerId: 'state-model', model: 'fixture' },
        },
      })
      ids.push(task.sessionId)
    }
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${ids[6]}`)).approvals.length).toBe(1)
    await page.locator('.work-decision-placeholder[aria-label="正在读取请求"]').waitFor()
    await shot(page, 'overview-loading', 1440, 'dark')
    releaseRead?.()
    await page.unrouteAll({ behavior: 'wait' })
    const home = page.locator('.workbench-home')
    await home.locator('.approval-panel').waitFor()
    await expect.poll(() => home.locator('.approval-panel').getByRole('button', { name: '允许', exact: true }).isDisabled()).toBe(false)
    expect(await home.locator('[data-group="attention"] [data-work-session]').count()).toBe(5)
    await home.getByRole('button', { name: '还有 2 件', exact: true }).click()
    expect(await home.locator('[data-group="attention"] [data-work-session]').count()).toBe(7)
    await home
      .locator('.work-overview-more')
      .filter({ hasText: /^收起$/u })
      .click()
    for (const theme of ['light', 'dark'] as const) {
      await shot(page, 'overview-many', 1440, theme)
      for (const value of ['overview', 'triage'] as const) {
        await layout(page, value)
        await shot(page, `${value}-home`, 768, theme)
        await shot(page, `${value}-phone`, 390, theme)
        const words = page.locator('.workbench-phone-heading .ui-segmented-label').filter({ hasText: '我的 Agent' })
        if (await words.count()) expect(await words.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
        await page.setViewportSize({ width: 1440, height: 1000 })
      }
      await layout(page, 'overview')
    }
    // Work scope may read shared Code transcript evidence; project browsing and delivery remain unavailable.
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'work' } })
    await page.reload()
    await connected(page)
    await home.locator('.approval-panel').waitFor()
    expect(await home.locator('.diff-line').count()).toBeGreaterThan(0)
    expect(await home.locator('[data-group="delivery"]').textContent()).toContain('这台设备不能读取项目改动')
    await shot(page, 'overview-limited', 1440, 'dark')
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all', scopes: ['view'] } })
    await page.reload()
    await connected(page)
    await home.locator('.approval-panel').waitFor()
    expect(await home.locator('.approval-panel').getByRole('button', { name: '允许', exact: true }).count()).toBe(0)
    expect(await home.locator('.approval-panel').getByRole('button', { name: '拒绝', exact: true }).count()).toBe(1)
    await expect.poll(() => home.locator('.approval-panel').getByRole('button', { name: '拒绝', exact: true }).isDisabled()).toBe(false)
    await shot(page, 'overview-readonly', 1440, 'dark')
    await owner.confirmedJson(`devices/${device.id}`, {
      method: 'PATCH',
      body: { dataScope: 'all', scopes: ['view', 'run', 'approve:standard', 'approve:elevated', 'admin'] },
    })
    await page.reload()
    await connected(page)
    await home.locator('.approval-panel').waitFor()
    await context.setOffline(true)
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-connection')).toMatch(/offline|reconnecting/u)
    for (const theme of ['light', 'dark'] as const) await shot(page, 'overview-offline', 1440, theme)
    await layout(page, 'triage')
    await shot(page, 'triage-offline', 1440, 'dark')
    await context.setOffline(false)
    await connected(page)
    await layout(page, 'overview')
    await page.keyboard.press('Alt+,')
    const settings = page.locator('.settings-page')
    await settings.waitFor()
    await openSection(settings, '通用')
    for (const theme of ['light', 'dark'] as const) await shot(page, 'overview-settings', 1440, theme)
  } finally {
    releaseRead?.()
    await context.setOffline(false)
    for (const id of ids) await host.host.bridge.cancel(id).catch(() => {})
    await context.close()
    await browser.close()
    await host.close()
  }
})
