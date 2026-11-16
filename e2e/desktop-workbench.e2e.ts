import { _electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import type { HarnessPlugin } from '@latch/sdk'
import type { AppSnapshot, CustomAgent, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost } from './helpers/host.ts'
import { measureWorkbenchSwitch } from './helpers/workbenchSwitch.ts'
import { noHorizontalOverflow, reachable, settleShell } from './helpers/layout.ts'
import { LAYOUT_NAMES, layoutSwitch, switchLayout, returnFromHomeFocus } from './helpers/workbench.ts'

const OUT = 'test-results/desktop-workbench'

it.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')(
  'continues one Personal Agent chat across an Electron reload and exposes the row actions',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-personal-agent-'))
    const host = await startTestHost({ hostName: '验收电脑' })
    let app: ElectronApplication | undefined
    try {
      await mkdir(OUT, { recursive: true })
      const owner = await host.enroll({ listener: 'unix' })
      const agent = await owner.json<CustomAgent>('custom-agents', {
        method: 'POST',
        body: { requestId: randomUUID(), name: '桌面资料助手', description: '', harnessId: 'standard', mode: 'chat' },
      })
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
      app = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${join(host.dataDir, 'host.json')}`,
          `--latch-user-data=${join(root, 'electron')}`,
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: Object.fromEntries(
          Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        timeout: 30_000,
      })
      const page = await app.firstWindow()
      expect(page.url()).toBe('latch://app/link/')
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900))
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
      const online = page.locator('.app-shell[data-connection="connected"]')
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await online.waitFor()
      await page.getByRole('radio', { name: '我的 Agent', exact: true }).first().click()
      const row = page.locator(`[data-agent-id="${agent.id}"]`).filter({ visible: true })
      await row.click()
      const initial = page.getByRole('textbox', { name: '给桌面资料助手发消息', exact: true })
      await initial.fill('记下本周的验收范围')
      await initial.press('Meta+Enter')
      const snapshot = () => owner.json<AppSnapshot>('snapshot')
      await expect.poll(async () => (await snapshot()).agentChats?.[agent.id]?.state).toBe('ready')
      const slot = (await snapshot()).agentChats?.[agent.id]
      if (slot?.state !== 'ready') throw new Error('The Host did not identify the chat.')
      const continued = page.getByRole('textbox', { name: '继续对话', exact: true }).filter({ visible: true })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${slot.sessionId}`)).summary.status).toBe('idle')
      await continued.fill('在这里补上第二条')
      await continued.press('Meta+Enter')
      await expect
        .poll(async () => {
          const chat = await owner.json<TaskDetail>(`tasks/${slot.sessionId}`)
          return {
            status: chat.summary.status,
            prompts: chat.messages.filter(message => message.role === 'user').map(message => message.text),
          }
        })
        .toEqual({ status: 'idle', prompts: ['记下本周的验收范围', '在这里补上第二条'] })
      await page.reload()
      await online.waitFor()
      await row.click()
      const transcript = page.locator('.transcript-shell')
      await transcript.getByText('记下本周的验收范围', { exact: true }).waitFor()
      await transcript.getByText('在这里补上第二条', { exact: true }).waitFor()
      expect((await snapshot()).tasks.filter(task => task.agent?.customAgentId === agent.id).map(task => task.id)).toEqual([slot.sessionId])
      const inspector = page.getByRole('complementary', { name: '侧边面板', exact: true })
      const panelToggle = page.getByRole('button', { name: '侧边面板', exact: true })
      await inspector.waitFor({ state: 'hidden' })
      await expect.poll(() => panelToggle.getAttribute('aria-pressed')).toBe('false')
      await page.screenshot({ path: `${OUT}/personal-agent-inspector-closed-1440-dark.png`, animations: 'disabled' })
      await panelToggle.click()
      await expect.poll(() => panelToggle.getAttribute('aria-pressed')).toBe('true')
      await inspector.getByRole('button', { name: '关闭', exact: true }).click()
      await inspector.waitFor({ state: 'hidden' })
      const more = page.getByRole('button', { name: '更多操作：桌面资料助手', exact: true }).filter({ visible: true })
      const actions = page.getByRole('menu', { name: '桌面资料助手 的操作' })
      await more.click()
      await actions.getByRole('menuitem', { name: '设置', exact: true }).waitFor()
      await actions.getByRole('menuitem', { name: '删除 Agent', exact: true }).waitFor()
      await page.screenshot({ path: `${OUT}/personal-agent-one-chat-1440-dark.png`, animations: 'disabled' })
      await actions.getByRole('menuitem', { name: '设置', exact: true }).click()
      const profile = page.getByRole('region', { name: '桌面资料助手 的资料', exact: true })
      await profile.getByRole('form', { name: '桌面资料助手 的设置', exact: true }).waitFor()
      await profile.getByRole('button', { name: '关闭资料', exact: true }).click()
      await profile.waitFor({ state: 'hidden' })
      await more.click()
      await actions.getByRole('menuitem', { name: '删除 Agent', exact: true }).click()
      const confirm = page.getByRole('dialog', { name: '删除「桌面资料助手」？' })
      await confirm.getByText('它的记忆会删除，聊天记录和文件夹会保留。').waitFor()
      await confirm.getByRole('button', { name: '取消', exact: true }).click()
      await confirm.waitFor({ state: 'hidden' })
      expect((await snapshot()).customAgents?.some(item => item.id === agent.id)).toBe(true)
      await continued.waitFor()
    } finally {
      await app?.close()
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)

it.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')(
  'uses the normal Electron socket entry for populated layout and space changes while keeping the long conversation and its inputs',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-workbench-'))
    const plugin: HarnessPlugin = {
      id: 'desktop-workbench',
      name: '桌面工作台验收',
      version: '1',
      description: 'Local fixture only.',
      activate(context) {
        context.registerProvider({
          id: 'desktop-workbench-model',
          name: '本地验收模型',
          model: 'fixture',
          async *stream({ messages, signal }) {
            const prompt = messages.findLast(message => message.role === 'user')?.content
            if (prompt?.startsWith('重试桌面验收任务 ')) throw new Error('暂时无法生成验收记录。')
            if (prompt === '等待批准配置' && messages.at(-1)?.role !== 'tool') {
              yield {
                type: 'tool-call',
                call: { id: randomUUID(), name: 'write_file', arguments: { path: 'settings.ts', content: 'export const keep = true\n' } },
              }
              yield { type: 'finish', reason: 'tool-calls' }
              return
            }
            if (prompt === '准备发布记录') {
              yield { type: 'reasoning', text: '正在整理发布记录。' }
              await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
              return
            }
            yield { type: 'text', text: '这份长记录在布局和空间之间保持阅读位置。\n\n'.repeat(60) }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const host = await startTestHost({ demo: false, providerId: 'desktop-workbench-model', plugins: [plugin], hostName: '验收电脑' })
    let app: ElectronApplication | undefined
    try {
      await mkdir(OUT, { recursive: true })
      const owner = await host.enroll({ listener: 'unix' })
      const folder = join(host.root, 'desktop-project')
      await mkdir(folder)
      await writeFile(join(folder, 'settings.ts'), 'export const keep = false\n')
      const git = (...args: string[]) =>
        execFileSync(
          'git',
          [
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'commit.gpgsign=false',
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.invalid',
            ...args,
          ],
          {
            cwd: folder,
            env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
            stdio: 'pipe',
          },
        )
      git('init', '--template=', '--initial-branch=main')
      git('add', 'settings.ts')
      git('commit', '-m', 'Initial fixture')
      const added = await owner.addFolders({ name: '桌面项目', paths: [folder] })
      const { workspace } = (await added.json()) as { workspace: WorkspaceInfo }
      await owner.confirmedJson('agents', {
        method: 'POST',
        body: { id: 'desktop-switch-agent', name: '本地Agent夹具', command: process.execPath, args: [FAKE_ACP_AGENT] },
      })
      for (const name of ['审阅搭档', '发布搭档'])
        await owner.json('custom-agents', {
          method: 'POST',
          body: {
            requestId: randomUUID(),
            name,
            description: '协作完成项目任务',
            harnessId: 'desktop-switch-agent',
            mode: 'agent',
            defaultProjectId: workspace.id,
          },
        })
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
      app = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${join(host.dataDir, 'host.json')}`,
          `--latch-user-data=${join(root, 'electron')}`,
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: Object.fromEntries(
          Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        recordVideo: { dir: `${OUT}/recording`, size: { width: 1440, height: 1000 } },
        timeout: 30_000,
      })
      const page = await app.firstWindow()
      expect(page.url()).toBe('latch://app/link/')
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!
        window.setMinimumSize(320, 400)
        window.setSize(1440, 1000)
      })
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' })
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      const home = page.locator('.workbench-home')
      await home.getByRole('button', { name: /^Harness：/u }).click()
      await page.getByRole('menuitemradio', { name: /Latch.*内置/u }).click()
      await home.getByRole('button', { name: /^项目：/u }).click()
      await page.getByRole('menuitemradio', { name: '桌面项目', exact: true }).click()
      await home.getByRole('textbox', { name: '新会话消息', exact: true }).fill('准备桌面阅读记录')
      await home.getByRole('button', { name: '发送', exact: true }).click()
      await expect.poll(async () => (await host.host.bridge.listTasks())[0]?.status).toBe('idle')
      const completed = (await host.host.bridge.listTasks())[0]
      await expect
        .poll(async () => (await host.host.bridge.detail(completed.id)).messages.some(message => message.outputsPending), {
          timeout: 10_000,
        })
        .toBe(false)
      await writeFile(join(folder, 'release.md'), '# 发布说明\n\n保留设置。\n')
      const input = page.locator('.workspace textarea').first()
      await input.fill('原会话草稿')
      const sender = await input.elementHandle(),
        transcript = page.locator('.transcript').first()
      const bottom = await transcript.evaluate(element => element.scrollTop)
      await transcript.hover()
      await page.mouse.wheel(0, -1000)
      await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeLessThan(bottom)
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const reading = await transcript.evaluate(element => element.scrollTop)
      let waiting = ''
      for (const prompt of ['等待批准配置', '准备发布记录']) {
        const started = await owner.json<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: {
            requestId: randomUUID(),
            prompt,
            workspaceId: workspace.id,
            model: { providerId: 'desktop-workbench-model', model: 'fixture' },
          },
        })
        await expect
          .poll(async () => (await owner.json<TaskDetail>(`tasks/${started.sessionId}`)).summary.status)
          .toBe(prompt === '等待批准配置' ? 'waiting-approval' : 'running')
        if (prompt === '等待批准配置') waiting = started.sessionId
      }
      await page.getByRole('button', { name: '总览', exact: true }).locator('visible=true').first().click()
      const approvalId = (await owner.json<TaskDetail>(`tasks/${waiting}`)).approvals[0]!.id
      const featuredApproval = home.locator(`.work-feature[data-work-session="${waiting}"]`)
      const viewOriginal = featuredApproval.getByRole('button', { name: '查看原请求', exact: true })
      await viewOriginal.waitFor()
      await featuredApproval.locator('.work-feature-material[data-secure]').waitFor()
      const delivery = home.locator('[data-group="delivery"]')
      const featuredDelivery = home.getByRole('button', { name: '查看交付', exact: true })
      await featuredDelivery.waitFor()
      expect(await home.getByRole('button', { name: '重试', exact: true }).count()).toBe(0)
      const draft = home.getByRole('textbox', { name: '新会话消息', exact: true })
      await draft.fill('首页独立草稿')
      await home
        .getByLabel('选择附件', { exact: true })
        .setInputFiles({ name: 'desktop.txt', mimeType: 'text/plain', buffer: Buffer.from('desktop draft attachment') })
      await expect.poll(() => home.getByRole('button', { name: 'desktop.txt', exact: true }).isEnabled()).toBe(true)
      await returnFromHomeFocus(page)
      const metrics = []
      for (const [name, target] of [
        ['a-to-b', 'triage'],
        ['b-to-a', 'overview'],
      ] as const) {
        const radio = layoutSwitch(page).getByRole('radio', { name: LAYOUT_NAMES[target], exact: true })
        const metric = await measureWorkbenchSwitch(page, OUT, name, () => radio.click())
        metrics.push(metric)
        // The visible approval stays out of the window snapshot, and the chosen segment keeps the focus.
        expect(metric.fades).toEqual([])
        expect(metric.transitions).toEqual([])
        expect(metric.marked).toBe(false)
        if (target === 'triage') await home.locator(`[data-approval-id="${approvalId}"]`).waitFor()
        else await viewOriginal.waitFor()
        expect(await radio.evaluate(element => element === document.activeElement)).toBe(true)
        expect(await sender!.evaluate(element => element.isConnected)).toBe(true)
        expect(await input.inputValue()).toBe('原会话草稿')
        expect(await transcript.evaluate(element => element.scrollTop)).toBe(reading)
      }
      metrics.push(
        await measureWorkbenchSwitch(page, OUT, 'code-to-agent', () =>
          page.getByRole('radio', { name: '我的 Agent', exact: true }).locator('visible=true').first().click(),
        ),
      )
      expect(await page.locator('.agents-page').textContent()).toContain('审阅搭档')
      metrics.push(
        await measureWorkbenchSwitch(page, OUT, 'agent-to-code', () =>
          page.getByRole('radio', { name: 'Code', exact: true }).locator('visible=true').first().click(),
        ),
      )
      expect(await draft.inputValue()).toBe('首页独立草稿')
      expect(await home.getByRole('button', { name: 'desktop.txt', exact: true }).isEnabled()).toBe(true)
      expect(await sender!.evaluate(element => element.isConnected)).toBe(true)
      expect(await transcript.evaluate(element => element.scrollTop)).toBe(reading)
      expect(await host.host.bridge.listTasks()).toHaveLength(3)
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        for (const layout of ['overview', 'triage'] as const) {
          await switchLayout(page, layout)
          await noHorizontalOverflow(page)
          const frame = await home.boundingBox()
          const panels = await page.getByRole('group', { name: '工作台面板', exact: true }).locator('visible=true').boundingBox()
          const viewSwitch = await layoutSwitch(page).boundingBox()
          const window = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
          expect(frame!.x + frame!.width).toBeLessThan(window.width)
          expect(frame!.y + frame!.height).toBeLessThan(window.height)
          expect(Math.abs(panels!.y + panels!.height / 2 - viewSwitch!.y - viewSwitch!.height / 2)).toBeLessThanOrEqual(3)
          expect(viewSwitch!.x - panels!.x - panels!.width).toBeGreaterThanOrEqual(12)
          if (layout === 'triage') {
            expect(await delivery.textContent()).toContain('未提交 1 个文件')
            expect(await delivery.locator('.work-delivery').count()).toBe(1)
            await expect.poll(() => home.locator('.approval-panel[data-arming]').count()).toBe(0)
          } else {
            await featuredDelivery.waitFor()
            await viewOriginal.waitFor()
          }
          await page.screenshot({ path: `${OUT}/${layout}-home-1440-${theme}.png`, animations: 'disabled' })
        }
      }
      for (let index = 1; index <= 7; index++) {
        const failure = await owner.json<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: {
            requestId: randomUUID(),
            prompt: `重试桌面验收任务 ${index}`,
            model: { providerId: 'desktop-workbench-model', model: 'fixture' },
          },
        })
        await expect.poll(async () => (await host.host.bridge.detail(failure.sessionId)).summary.status).toBe('failed')
      }
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 560))
      await expect.poll(() => page.evaluate(() => innerHeight)).toBe(560)
      for (const layout of ['overview', 'triage'] as const) {
        await switchLayout(page, layout)
        const featured = layout === 'overview'
        const attention = home.getByRole('region', { name: featured ? '当前请求' : '等你处理', exact: true })
        const more = attention.getByRole('button', { name: featured ? '8 项待处理' : /^还有 3 件$|^收起$/u, exact: true })
        await more.waitFor()
        const composer = home.locator('.workbench-home-composer')
        const composerBox = await composer.boundingBox()
        const frame = await home.boundingBox()
        expect(composerBox!.y + composerBox!.height).toBeLessThan(frame!.y + frame!.height)
        const switchBox = await layoutSwitch(page).boundingBox()
        const list = attention.getByRole('list', { name: '待处理会话', exact: true })
        if (featured) await more.click()
        const scroll = featured ? list : attention
        const wheelTarget = featured ? list : attention.getByRole('heading')
        await wheelTarget.scrollIntoViewIfNeeded()
        const wheelBox = await wheelTarget.boundingBox()
        const start = await scroll.evaluate(element => element.scrollTop)
        await page.mouse.move(wheelBox!.x + wheelBox!.width / 2, wheelBox!.y + wheelBox!.height / 2)
        await page.mouse.wheel(0, 600)
        await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(start)
        if (!featured && (await more.textContent()) === '还有 3 件') await more.click()
        const last = list.getByRole('listitem').last().getByRole('button')
        await reachable(last)
        await reachable(home.getByRole('button', { name: 'desktop.txt', exact: true }))
        await settleShell(page)
        expect(await home.evaluate(element => [element.scrollTop, document.scrollingElement?.scrollTop])).toEqual([0, 0])
        expect(await composer.boundingBox()).toEqual(composerBox)
        expect(await layoutSwitch(page).boundingBox()).toEqual(switchBox)
        await page.screenshot({ path: `${OUT}/${layout}-short-queue-1440-dark.png`, animations: 'disabled' })
      }
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 1000))
      // The featured request opens the actual card and changes this file without consuming either draft.
      await switchLayout(page, 'overview')
      await viewOriginal.click()
      const allow = page.locator(`main.workspace [data-approval-id="${approvalId}"]`).getByRole('button', { name: '允许', exact: true })
      await allow.scrollIntoViewIfNeeded()
      await expect.poll(() => allow.isEnabled()).toBe(true)
      await allow.click()
      await expect.poll(async () => (await host.host.bridge.detail(waiting)).summary.status).toBe('idle')
      expect(await readFile(join(folder, 'settings.ts'), 'utf8')).toBe('export const keep = true\n')
      await page.getByRole('button', { name: '总览', exact: true }).locator('visible=true').first().click()
      expect(await draft.inputValue()).toBe('首页独立草稿')
      expect(await home.getByRole('button', { name: 'desktop.txt', exact: true }).isEnabled()).toBe(true)
      await switchLayout(page, 'triage')
      await expect.poll(() => delivery.textContent(), { timeout: 10_000 }).toContain('未提交 2 个文件')
      await delivery.getByRole('button', { name: '查看改动', exact: true }).click()
      await page.locator('.delivery-panel').getByText('release.md', { exact: true }).waitFor()
      await page.locator('.delivery-panel').getByText('settings.ts', { exact: true }).waitFor()
      await page.screenshot({ path: `${OUT}/delivery-after-home-approval.png`, animations: 'disabled' })
      await writeFile(`${OUT}/frames.json`, JSON.stringify({ entry: 'latch://app/link/', metrics }, null, 2))
      const video = page.video()
      await app.close()
      app = undefined
      await video?.saveAs(`${OUT}/switches.webm`)
    } finally {
      for (const task of await host.host.bridge.listTasks())
        if (task.status === 'running' || task.status === 'waiting-approval') await host.host.bridge.cancel(task.id).catch(() => {})
      await app?.close()
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
