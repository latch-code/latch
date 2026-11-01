import { _electron, type ElectronApplication } from '@playwright/test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import type { AgentSettings, AppSnapshot, TaskDetail } from '@latch/protocol'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost } from './helpers/host.ts'
import { openSection, openSettings } from './helpers/layout.ts'

describe.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')(
  'actual Agent model and reasoning controls',
  () => {
    it('reads actual ACP options at three sizes and reconciles a lost response without sending again', async () => {
      const root = await mkdtemp(join(tmpdir(), 'latch-electron-models-')),
        host = await startTestHost()
      let application: ElectronApplication | undefined
      try {
        const owner = await host.enroll({ listener: 'unix' })
        const saved = await owner.confirmed('agents', {
          method: 'POST',
          body: { name: '配置测试 Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_CONFIG: 'options' } },
        })
        expect(saved.status).toBe(201)
        const agent = ((await saved.json()) as { agent: AgentSettings }).agent
        const started = await owner.confirmed('tasks', {
          method: 'POST',
          body: { prompt: 'echo 模型配置测试', harnessId: agent.id, requestId: randomUUID() },
        })
        expect(started.status).toBe(201)
        const sessionId = ((await started.json()) as { sessionId: string }).sessionId
        await expect.poll(async () => (await host.host.bridge.detail(sessionId)).summary.status).toBe('idle')
        await writeHostState(host.dataDir, {
          version: 2,
          pid: process.pid,
          hostId: host.host.hostId,
          instanceId: host.host.instanceId,
          socketPath: host.host.socketPath,
          loopbackOrigin: host.host.loopbackOrigin,
          tlsOrigin: null,
          startedAt: new Date().toISOString(),
          dataDir: host.dataDir,
        })
        application = await _electron.launch({
          args: [
            resolve('apps/desktop/src/main.cjs'),
            '--latch-host-state=' + join(host.dataDir, 'host.json'),
            '--latch-user-data=' + join(root, 'electron'),
            '--use-mock-keychain',
          ],
          cwd: process.cwd(),
          env: Object.fromEntries(
            Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
          timeout: 30_000,
        })
        const page = await application.firstWindow()
        page.setDefaultTimeout(15_000)
        await page.getByRole('textbox', { name: '设备名称', exact: true }).fill('模型控件验收')
        await page.getByRole('button', { name: '请求连接', exact: true }).click()
        await page.locator('.app-shell[data-connection="connected"]').waitFor()
        await page
          .locator('[data-task-id="' + sessionId + '"]')
          .first()
          .click()
        const input = page.getByRole('textbox', { name: '继续对话', exact: true })
        const modelPicker = page.locator('button.model-picker')
        await input.fill('切换设置时保留这份草稿。')
        const beforePresence = host.presence.requests.length
        await page.evaluate(() => {
          const base = window.fetch.bind(window)
          let lose = true
          Reflect.set(window, 'configurationChanges', [])
          window.fetch = async (input, init) => {
            const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href
            const config = /\/tasks\/[^/]+\/config$/u.test(url) && init?.method === 'POST'
            if (config) Reflect.get(window, 'configurationChanges').push(JSON.parse(String(init.body)))
            const response = await base(input, init)
            if (config && lose && response.ok) {
              lose = false
              throw new TypeError('Simulated lost configuration response')
            }
            return response
          }
        })
        await modelPicker.click()
        await page.getByRole('menuitemradio', { name: 'Large', exact: true }).click()
        await page.getByRole('button', { name: /Model：.*结果未知/u }).waitFor()
        expect((await owner.json<TaskDetail>('tasks/' + sessionId)).config?.find(item => item.id === 'model')?.currentValue).toBe('large')
        await modelPicker.click()
        await page.getByRole('button', { name: '刷新当前设置', exact: true }).click()
        await page.getByRole('button', { name: /Model：Large · Low$/u }).waitFor()
        expect(await page.evaluate(() => Reflect.get(window, 'configurationChanges').length)).toBe(1)
        await page.keyboard.press('Escape')
        for (const width of [1440, 900, 390]) {
          await application.evaluate(({ BrowserWindow }, value) => {
            const window = BrowserWindow.getAllWindows()[0]!
            window.setMinimumSize(320, 400)
            window.setSize(value, 960)
          }, width)
          await page.waitForFunction(value => innerWidth === value, width)
          await page.emulateMedia({ colorScheme: width === 900 ? 'dark' : 'light' })
          await modelPicker.click()
          const effort = width === 900 ? 'Low' : 'High'
          await page.getByRole('radio', { name: effort, exact: true }).click()
          await expect
            .poll(async () => (await owner.json<TaskDetail>('tasks/' + sessionId)).config?.find(item => item.id === 'effort')?.currentValue)
            .toBe(effort.toLowerCase())
          await expect.poll(() => modelPicker.getAttribute('aria-busy')).not.toBe('true')
          if (width === 390)
            await page.getByRole('dialog', { name: 'Model', exact: true }).getByRole('button', { name: '取消', exact: true }).click()
          else if ((await modelPicker.getAttribute('aria-expanded')) === 'true') await modelPicker.click()
          expect(await input.inputValue()).toBe('切换设置时保留这份草稿。')
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await mkdir('test-results/model-controls', { recursive: true })
          await page.screenshot({ path: 'test-results/model-controls/agent-' + width + '.png', animations: 'disabled' })
        }
        expect(host.presence.requests.length).toBe(beforePresence)
      } finally {
        await application?.close()
        await host.close()
        await rm(root, { recursive: true, force: true })
      }
    })

    it('pins where new sessions start and removes a confirmed address over the real socket, asking the system for neither', async () => {
      const root = await mkdtemp(join(tmpdir(), 'latch-electron-take-back-')),
        host = await startTestHost()
      const service = createServer((_, response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'local-model' }] }))
      })
      let application: ElectronApplication | undefined
      try {
        await new Promise<void>(done => service.listen(0, '127.0.0.1', done))
        const address = `http://127.0.0.1:${(service.address() as AddressInfo).port}/v1`
        const owner = await host.enroll({ listener: 'unix' })
        expect(
          (
            await owner.confirmed('providers', {
              method: 'POST',
              body: {
                name: '本地服务',
                kind: 'openai-compatible',
                baseURL: address,
                models: ['local-model'],
                defaultModel: 'local-model',
                confirmOrigin: true,
              },
            })
          ).status,
        ).toBeLessThan(300)
        await owner.json('policy', { method: 'PATCH', body: { remote: { workspaces: ['default'] } } })
        await writeHostState(host.dataDir, {
          version: 2,
          pid: process.pid,
          hostId: host.host.hostId,
          instanceId: host.host.instanceId,
          socketPath: host.host.socketPath,
          loopbackOrigin: host.host.loopbackOrigin,
          tlsOrigin: null,
          startedAt: new Date().toISOString(),
          dataDir: host.dataDir,
        })
        application = await _electron.launch({
          args: [
            resolve('apps/desktop/src/main.cjs'),
            '--latch-host-state=' + join(host.dataDir, 'host.json'),
            '--latch-user-data=' + join(root, 'electron'),
            '--use-mock-keychain',
          ],
          cwd: process.cwd(),
          env: Object.fromEntries(
            Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
          timeout: 30_000,
        })
        const page = await application.firstWindow()
        page.setDefaultTimeout(15_000)
        await page.getByRole('textbox', { name: '设备名称', exact: true }).fill('取回验收')
        await page.getByRole('button', { name: '请求连接', exact: true }).click()
        await page.locator('.app-shell[data-connection="connected"]').waitFor()
        const asked = host.presence.requests.length

        await page.locator('.composer-stack .model-picker').click()
        await page.getByRole('menuitem', { name: '设为新会话默认' }).click()
        await page.getByRole('menuitem', { name: '取消新会话默认' }).waitFor()
        expect((await owner.json<AppSnapshot>('snapshot')).catalog!.defaults.pinned).toBe(true)
        await page.keyboard.press('Escape')

        const settings = await openSettings(page)
        await openSection(settings, '模型')
        const row = settings.locator('.address-row', { hasText: '127.0.0.1' })
        await row.getByRole('button', { name: '移除', exact: true }).click()
        await page.getByRole('dialog').getByRole('button', { name: '移除', exact: true }).click()
        await row.waitFor({ state: 'detached' })
        const { policy } = await owner.json<{ policy: { confirmedAddresses: string[]; hostEgressAllow: string[] } }>('policy')
        expect(policy.confirmedAddresses).toEqual([])
        expect(policy.hostEgressAllow).toEqual([])

        await openSection(settings, '手机与设备')
        await settings.getByText('手机和浏览器只能在这些项目里工作', { exact: true }).waitFor()
        expect(host.presence.requests.length).toBe(asked)
      } finally {
        await application?.close()
        await host.close()
        await new Promise(done => service.close(done))
        await rm(root, { recursive: true, force: true })
      }
    })
  },
)
