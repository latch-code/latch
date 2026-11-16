import { _electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { AppSnapshot, CustomAgent, TaskDetail } from '@latch/protocol'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost } from './helpers/host.ts'

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
      await panelToggle.click()
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
