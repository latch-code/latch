import { _electron, type ElectronApplication } from '@playwright/test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FAKE_ACP_AGENT, startFakeModels } from '@latch/testkit'
import type { AgentSettings, AppSnapshot, TaskDetail } from '@latch/protocol'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost } from './helpers/host.ts'
import { backToPhoneSessions, openSection, openSession, openSettings, reachable } from './helpers/layout.ts'
import { homeInput } from './helpers/workbench.ts'

describe.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')(
  'actual Agent model and reasoning controls',
  () => {
    it('opens a fresh Host straight into the workbench, and the input works once a model service is saved', async () => {
      const root = await mkdtemp(join(tmpdir(), 'latch-electron-setup-'))
      const host = await startTestHost({ demo: false, hostName: '验收电脑' })
      const models = await startFakeModels()
      let application: ElectronApplication | undefined
      try {
        const owner = await host.enroll({ listener: 'unix' })
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
        await page.getByRole('button', { name: '继续', exact: true }).click()
        await page.locator('.app-shell[data-connection="connected"]').waitFor()
        // Nothing to prepare first: what is missing is said where a session starts.
        const install = page.getByRole('region', { name: '安装 Harness', exact: true })
        await install.waitFor()
        expect(await page.getByRole('dialog').count()).toBe(0)
        await mkdir('test-results/first-open', { recursive: true })
        for (const width of [1440, 768, 390]) {
          await application.evaluate(({ BrowserWindow }, size) => {
            const window = BrowserWindow.getAllWindows()[0]!
            window.setMinimumSize(320, 400)
            window.setSize(size, 900)
          }, width)
          await page.waitForFunction(value => innerWidth === value, width)
          for (const colorScheme of ['light', 'dark'] as const) {
            await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
            await page.screenshot({ path: `test-results/first-open/none-ready-${width}-${colorScheme}.png`, animations: 'disabled' })
          }
        }

        const saved = await owner.confirmed('providers', {
          method: 'POST',
          body: {
            name: '验收模型服务',
            kind: 'openai-compatible',
            baseURL: `${models.origin}/v1`,
            models: ['fake-model'],
            defaultModel: 'fake-model',
            confirmOrigin: true,
          },
        })
        expect(saved.status).toBe(201)
        await install.waitFor({ state: 'detached' })
        const input = page.getByRole('textbox', { name: '新会话消息', exact: true })
        await input.fill('你好')
        await input.press('Meta+Enter')
        await expect.poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.length).toBe(1)
        await page.screenshot({ path: 'test-results/first-open/model-ready-390-dark.png', animations: 'disabled' })
      } finally {
        await application?.close()
        await host.close()
        await models.close()
        await rm(root, { recursive: true, force: true })
      }
    })
    it('reads actual ACP options at three sizes and reconciles a lost response without sending again', async () => {
      const root = await mkdtemp(join(tmpdir(), 'latch-electron-models-')),
        host = await startTestHost({ hostName: '验收电脑' })
      let application: ElectronApplication | undefined
      try {
        const owner = await host.enroll({ listener: 'unix' })
        const saved = await owner.confirmed('agents', {
          method: 'POST',
          body: { name: '配置测试 Harness', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_CONFIG: 'options' } },
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
        await page.getByRole('button', { name: '继续', exact: true }).click()
        await page.locator('.app-shell[data-connection="connected"]').waitFor()
        await page
          .locator('[data-task-id="' + sessionId + '"]')
          .first()
          .click()
        const input = page.getByRole('textbox', { name: '继续对话', exact: true })
        const modelPicker = page.locator('button.model-picker')
        const thinkingPicker = page.locator('button.thinking-picker')
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
        await page.getByRole('button', { name: /模型：.*结果未知/u }).waitFor()
        expect((await owner.json<TaskDetail>('tasks/' + sessionId)).config?.find(item => item.id === 'model')?.currentValue).toBe('large')
        // A session's switch keeps the panel open on the new model (d0ccdd6e): its unknown result is checked right there.
        const modelMenu = page.getByRole('menu', { name: '模型', exact: true })
        expect(await modelMenu.isVisible()).toBe(true)
        await modelMenu.getByRole('button', { name: '核对', exact: true }).click()
        await page.getByRole('button', { name: '模型：Large', exact: true }).waitFor()
        await page.getByRole('button', { name: '思考：Low', exact: true }).waitFor()
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
          // 思考 opens the model panel on its levels (a sheet on a phone), which closes on the choice. Each chip draws
          // its own panel, so the level is the one shown.
          await thinkingPicker.click()
          const effort = width === 900 ? 'Low' : 'High'
          // In the panel now open: the model chip's, shut by Escape above, may still be fading out in place.
          await page
            .locator(':popover-open, dialog[open]')
            .getByRole('menuitemradio', { name: new RegExp(`^${effort}`, 'u') })
            .filter({ visible: true })
            .first()
            .click()
          await expect
            .poll(async () => (await owner.json<TaskDetail>('tasks/' + sessionId)).config?.find(item => item.id === 'effort')?.currentValue)
            .toBe(effort.toLowerCase())
          await expect.poll(() => thinkingPicker.getAttribute('aria-busy')).not.toBe('true')
          await expect.poll(() => thinkingPicker.getAttribute('aria-label')).toBe(`思考：${effort}`)
          expect(await input.inputValue()).toBe('切换设置时保留这份草稿。')
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          await mkdir('test-results/model-controls', { recursive: true })
          await page.screenshot({ path: 'test-results/model-controls/agent-' + width + '.png', animations: 'disabled' })
        }
        expect(host.presence.requests.length).toBe(beforePresence)
        const path = (await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(item => item.id === agent.id)?.bound?.path
        expect(path).toBeTruthy()
        for (const width of [1440, 390]) {
          await application.evaluate(({ BrowserWindow }, value) => {
            BrowserWindow.getAllWindows()[0]!.setSize(value, 900)
          }, width)
          await page.waitForFunction(value => innerWidth === value, width)
          await openSession(page, sessionId)
          // Where the program is stays off the menu's rows: it is the hover of the session's Harness chip and of each
          // Harness in a new session's menu. A sheet (the narrow window) has no hover and shows no path.
          const shots = async (state: string) => {
            for (const colorScheme of ['light', 'dark'] as const) {
              await page.emulateMedia({ colorScheme })
              await page.screenshot({
                path: `test-results/model-controls/harness-${state}--${colorScheme}--${width}.png`,
                animations: 'disabled',
                scale: 'css',
              })
            }
            await page.emulateMedia({ colorScheme: 'light' })
          }
          const chip = page.getByRole('button', { name: 'Harness：配置测试 Harness', exact: true }).filter({ visible: true })
          if (width === 1440) {
            await chip.hover()
            await page.getByText(path!, { exact: true }).filter({ visible: true }).waitFor()
            await shots('session')
          }
          await chip.click()
          expect(await page.locator('.harness-bound-path').count()).toBe(0)
          await page.keyboard.press('Escape')
          if (width === 390) await backToPhoneSessions(page)
          await page.getByRole('button', { name: '新建会话', exact: true }).filter({ visible: true }).first().click()
          await homeInput(page).waitFor()
          await page.getByRole('button', { name: 'Harness：配置测试 Harness', exact: true }).filter({ visible: true }).click()
          expect(await page.locator(':is(.ui-menu-item-description, .ui-choice-description) .middle-ellipsis').count()).toBe(0)
          if (width === 1440) {
            const row = page.getByRole('menuitemradio', { name: /配置测试 Harness/u }).filter({ visible: true })
            expect(await row.getAttribute('title')).toBe(path)
          }
          await shots('new')
          await page.keyboard.press('Escape')
        }
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
        await page.getByRole('button', { name: '继续', exact: true }).click()
        await page.locator('.app-shell[data-connection="connected"]').waitFor()
        const asked = host.presence.requests.length

        await page.getByRole('button', { name: /^Harness：/u }).click()
        await page.getByRole('menuitem', { name: '设为新会话默认' }).click()
        await page.getByRole('menuitem', { name: '取消新会话默认' }).waitFor()
        expect((await owner.json<AppSnapshot>('snapshot')).catalog!.defaults.pinned).toBe(true)
        await page.keyboard.press('Escape')

        const settings = await openSettings(page)
        await openSection(settings, '模型')
        const row = settings.locator('.address-row', { hasText: '127.0.0.1' })
        await row.getByRole('button', { name: '移除', exact: true }).click()
        await page
          .getByRole('dialog', { name: /^移除 /u })
          .getByRole('button', { name: '移除', exact: true })
          .click()
        await row.waitFor({ state: 'detached' })
        const { policy } = await owner.json<{ policy: { confirmedAddresses: string[]; hostEgressAllow: string[] } }>('policy')
        expect(policy.confirmedAddresses).toEqual([])
        expect(policy.hostEgressAllow).toEqual([])
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
