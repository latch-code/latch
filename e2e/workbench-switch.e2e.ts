import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import type { Device, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { join } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { measureWorkbenchSwitch } from './helpers/workbenchSwitch.ts'

const OUT = 'test-results/workbench-switch-populated'
const measure = (page: Page, name: string, action: () => Promise<void>) => measureWorkbenchSwitch(page, OUT, name, action)

it('switches the two named layouts and spaces without replacing the sender, losing input or duplicating a trigger', async () => {
  const plugin: HarnessPlugin = {
    id: 'switch-check',
    name: '切换验收',
    version: '1',
    description: 'Local fixture only.',
    activate(context) {
      context.registerProvider({
        id: 'switch-model',
        name: '本地验收模型',
        model: 'fixture',
        async *stream({ messages, signal }) {
          const prompt = messages.findLast(message => message.role === 'user')?.content
          if (prompt === '保存待处理的配置' && messages.at(-1)?.role !== 'tool') {
            yield {
              type: 'tool-call',
              call: { id: randomUUID(), name: 'write_file', arguments: { path: 'settings.ts', content: 'export const keep = true\n' } },
            }
            yield { type: 'finish', reason: 'tool-calls' }
            return
          }
          if (prompt === '继续准备发布记录') {
            yield { type: 'reasoning', text: '正在整理发布记录。' }
            await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
            return
          }
          yield { type: 'text', text: '这份记录用于核对切换后仍能接着阅读。\n\n'.repeat(60) }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  await mkdir(OUT, { recursive: true })
  const host = await startTestHost({ demo: false, plugins: [plugin], providerId: 'switch-model', hostName: '验收电脑' })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'dark',
    locale: 'zh-CN',
    reducedMotion: 'no-preference',
    recordVideo: { dir: `${OUT}/recording`, size: { width: 1440, height: 1000 } },
  })
  const page = await context.newPage()
  const video = page.video()
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const folder = join(host.root, 'switch-project')
    await mkdir(folder)
    await writeFile(join(folder, 'settings.ts'), 'export const keep = false\n')
    const added = await owner.addFolders({ name: '切换项目', paths: [folder] })
    const { workspace } = (await added.json()) as { workspace: WorkspaceInfo }
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'switch-agent', name: '本地Agent夹具', command: process.execPath, args: [FAKE_ACP_AGENT] },
    })
    for (const [name, description] of [
      ['审阅搭档', '复核代码与测试'],
      ['发布搭档', '整理发布记录'],
    ])
      await owner.json('custom-agents', {
        method: 'POST',
        body: { requestId: randomUUID(), name, description, harnessId: 'switch-agent', mode: 'agent', defaultProjectId: workspace.id },
      })
    await enrollBrowser(page, host, { name: '切换验收设备', scopes: ['admin'] })
    await connected(page)
    const devices = await owner.json<{ devices: Device[] }>('devices')
    const device = devices.devices.find(item => item.name === '切换验收设备')!
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    await page.reload()
    await connected(page)
    const home = page.locator('.workbench-home')
    await home.getByRole('button', { name: /^Harness：/u }).click()
    await page.getByRole('menuitemradio', { name: /Latch.*内置/u }).click()
    await home.getByRole('button', { name: /^项目：/u }).click()
    await page.getByRole('menuitemradio', { name: '切换项目', exact: true }).click()
    await home.getByRole('textbox', { name: '新会话消息', exact: true }).fill('请准备阅读记录')
    await home.getByRole('button', { name: '发送', exact: true }).click()
    const input = page.locator('.workspace textarea').first()
    await input.waitFor()
    await expect.poll(async () => (await host.host.bridge.listTasks())[0]?.status).toBe('idle')
    expect((await host.host.bridge.listTasks())[0]?.harnessId).toBe('standard')
    for (const prompt of ['保存待处理的配置', '继续准备发布记录']) {
      const created = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), prompt, workspaceId: workspace.id, model: { providerId: 'switch-model', model: 'fixture' } },
      })
      await expect
        .poll(async () => (await owner.json<TaskDetail>(`tasks/${created.sessionId}`)).summary.status)
        .toBe(prompt === '保存待处理的配置' ? 'waiting-approval' : 'running')
    }
    await input.fill('会话草稿保留')
    const sender = await input.elementHandle()
    const transcript = page.locator('.transcript').first()
    const bottom = await transcript.evaluate(element => element.scrollTop)
    await transcript.hover()
    await page.mouse.wheel(0, -1000)
    await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeLessThan(bottom)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const reading = await transcript.evaluate(element => element.scrollTop)
    await page.getByRole('button', { name: '总览', exact: true }).locator('visible=true').first().click()
    await home.locator('.approval-panel').waitFor()
    expect(await home.locator('[data-group="running"] [data-work-session]').count()).toBe(1)
    const newInput = home.getByRole('textbox', { name: '新会话消息', exact: true })
    await newInput.fill('首页草稿保留')
    await home
      .getByLabel('选择附件', { exact: true })
      .setInputFiles({ name: 'switch.txt', mimeType: 'text/plain', buffer: Buffer.from('retained attachment') })
    await expect.poll(() => home.getByRole('button', { name: 'switch.txt', exact: true }).isEnabled()).toBe(true)
    const homeSender = await newInput.elementHandle()
    const results = []
    for (const target of ['分拣台', '总览'] as const) {
      await page.getByRole('button', { name: '布局', exact: true }).locator('visible=true').first().click()
      results.push(
        await measure(page, target === '分拣台' ? 'a-to-b' : 'b-to-a', () =>
          page.getByRole('menuitemradio', { name: target, exact: true }).click(),
        ),
      )
      expect(await homeSender!.evaluate(element => element.isConnected)).toBe(true)
      expect(await newInput.inputValue()).toBe('首页草稿保留')
      expect(await sender!.evaluate(element => element.isConnected)).toBe(true)
      expect(await input.inputValue()).toBe('会话草稿保留')
      expect(await transcript.evaluate(element => element.scrollTop)).toBe(reading)
      expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-layout-trigger'))).toBe(true)
    }
    results.push(
      await measure(page, 'code-to-agent', () =>
        page.getByRole('radio', { name: '我的 Agent', exact: true }).locator('visible=true').first().click(),
      ),
    )
    expect(await page.locator('.agents-page').textContent()).toContain('审阅搭档')
    expect(await page.locator('.agents-page').textContent()).toContain('发布搭档')
    expect(
      await page
        .getByRole('radio', { name: '我的 Agent', exact: true })
        .locator('visible=true')
        .first()
        .evaluate(element => element === document.activeElement),
    ).toBe(true)
    results.push(
      await measure(page, 'agent-to-code', () =>
        page.getByRole('radio', { name: 'Code', exact: true }).locator('visible=true').first().click(),
      ),
    )
    await home.waitFor()
    expect(
      await page.evaluate(
        () =>
          document.activeElement instanceof HTMLElement
          && document.activeElement !== document.body
          && document.activeElement.checkVisibility({ visibilityProperty: true })
          && !document.activeElement.closest('[inert]'),
      ),
    ).toBe(true)
    expect(await newInput.inputValue()).toBe('首页草稿保留')
    expect(await home.getByRole('button', { name: 'switch.txt', exact: true }).isEnabled()).toBe(true)
    expect(await sender!.evaluate(element => element.isConnected)).toBe(true)
    expect(await input.inputValue()).toBe('会话草稿保留')
    expect(await transcript.evaluate(element => element.scrollTop)).toBe(reading)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: '布局', exact: true }).locator('visible=true').first().click()
    const reduced = await measure(page, 'reduced-a-to-b', () => page.getByRole('menuitemradio', { name: '分拣台', exact: true }).click())
    expect(reduced.fades).toEqual([])
    expect(results.flatMap(result => result.fades).every(duration => duration === 120)).toBe(true)
    expect(results.slice(0, 2).every(result => result.fades.includes(120))).toBe(true)
    expect(await host.host.bridge.listTasks()).toHaveLength(3)
    await writeFile(`${OUT}/frames.json`, JSON.stringify({ browser: await browser.version(), results: [...results, reduced] }, null, 2))
  } finally {
    for (const task of await host.host.bridge.listTasks())
      if (task.status === 'running' || task.status === 'waiting-approval') await host.host.bridge.cancel(task.id).catch(() => {})
    await context.close()
    await video?.saveAs(`${OUT}/switches.webm`)
    await browser.close()
    await host.close()
  }
})
