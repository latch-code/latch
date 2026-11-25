import { _electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { AgentMention, AppSnapshot, CustomAgent, TaskDetail } from '@latch/protocol'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { promptValue } from './helpers/prompt.ts'

const OUT = 'test-results/desktop-workbench'
const electronOnly = latchEnv(process.env, 'ELECTRON_E2E') === '1' && process.platform === 'darwin'

async function launchWorkbench(host: TestHost, root: string) {
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
  return _electron.launch({
    args: [
      resolve('apps/desktop/src/main.cjs'),
      `--latch-host-state=${join(host.dataDir, 'host.json')}`,
      `--latch-user-data=${join(root, 'electron')}`,
      '--use-mock-keychain',
      '-AppleLanguages',
      '(zh-CN)',
    ],
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    timeout: 30_000,
  })
}

async function captureWorkbench(app: ElectronApplication, name: string) {
  const image = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error('The Electron workbench window is closed.')
    const frame = await window.capturePage()
    return frame.toPNG().toString('base64')
  })
  await writeFile(join(OUT, name), Buffer.from(image, 'base64'))
}

it.skipIf(!electronOnly)(
  'continues one Personal Agent chat across an Electron reload and exposes settings and deletion from its selected row',
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
      app = await launchWorkbench(host, root)
      const page = await app.firstWindow()
      expect(page.url()).toBe('latch://app/link/')
      const window = await app.browserWindow(page)
      await window.evaluate(workbench => workbench.setSize(1440, 900))
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
      await confirm.getByText('它的记忆和空文件夹会删除，聊天记录保留。').waitFor()
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

it.skipIf(!electronOnly)(
  'addresses another personal Agent by keyboard and returns from its reply to the source record in Electron',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-agent-mention-'))
    const question = '两台设备离线编辑同一段文字，恢复连接后该怎么处理？'
    const reply = '保留两份修改，标出冲突段落，让编辑选择合并结果。'
    const sourceMessage = '我们正在整理离线编辑流程。'
    const sourceReply = '可以先请架构师看一下同步时的冲突。'
    const provider = 'desktop-collaboration'
    const host = await startTestHost({
      hostName: '工作室',
      demo: false,
      providerId: provider,
      plugins: [
        {
          id: provider,
          name: '协作验收模型',
          version: '1',
          description: '',
          activate(context) {
            context.registerProvider({
              id: provider,
              name: '本地测试模型',
              model: 'fixture',
              async *stream({ messages }) {
                const prompt = messages.findLast(message => message.role === 'user')?.content ?? ''
                yield { type: 'text', text: prompt.includes(question) ? reply : sourceReply }
                yield { type: 'finish', reason: 'stop' }
              },
            })
          },
        },
      ],
    })
    let app: ElectronApplication | undefined
    try {
      await mkdir(OUT, { recursive: true })
      const owner = await host.enroll({ listener: 'unix' })
      const create = (name: string, description: string) =>
        owner.json<CustomAgent>('custom-agents', {
          method: 'POST',
          body: {
            requestId: randomUUID(),
            name,
            description,
            harnessId: 'standard',
            mode: 'agent',
            model: { providerId: provider, model: 'fixture' },
          },
        })
      const source = await create('编辑', '梳理产品需求与设计文稿')
      const target = await create('架构师', '审阅技术方案与系统边界')
      app = await launchWorkbench(host, root)
      const page = await app.firstWindow()
      expect(page.url()).toBe('latch://app/link/')
      page.setDefaultTimeout(15_000)
      const window = await app.browserWindow(page)
      await window.evaluate(workbench => workbench.setSize(1440, 900))
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      await page.getByRole('radio', { name: '我的 Agent', exact: true }).first().click()
      await page.locator(`button[data-agent-id="${source.id}"]`).filter({ visible: true }).first().click()
      const first = page.getByRole('textbox', { name: '给编辑发消息', exact: true })
      await first.fill(sourceMessage)
      await first.press('Meta+Enter')
      const transcript = page.locator('.transcript-shell')
      await transcript.getByText(sourceReply, { exact: true }).waitFor()
      const contact = page.getByRole('button', { name: '联系其他 Agent', exact: true })
      await contact.focus()
      await page.keyboard.press('Enter')
      const field = page.getByRole('textbox', { name: '继续对话', exact: true }).filter({ visible: true })
      const option = page.getByRole('option', { name: /架构师/u })
      await option.waitFor()
      expect(await page.getByRole('option', { name: /编辑/u }).count()).toBe(0)
      await expect.poll(() => field.evaluate(element => element === document.activeElement)).toBe(true)
      await expect.poll(() => promptValue(field)).toBe('@')
      expect(await field.getAttribute('aria-activedescendant')).toBeNull()
      await page.keyboard.press('ArrowDown')
      await expect.poll(() => field.getAttribute('aria-activedescendant')).not.toBeNull()
      await captureWorkbench(app, 'agent-mention-picker-1440-dark.png')
      await page.keyboard.insertText('架')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      expect(await promptValue(field)).toBe('')
      const send = page.getByRole('button', { name: '发给架构师', exact: true })
      await send.waitFor()
      await field.fill(question)
      await send.click()
      const visibleRecord = page.locator('article[data-agent-mention-id]').filter({ hasText: question })
      await visibleRecord.getByText(reply, { exact: true }).waitFor()
      const records = await owner.json<{ mentions: AgentMention[] }>(`custom-agents/${source.id}/mentions`)
      const recordId = await visibleRecord.getAttribute('data-agent-mention-id')
      expect(records.mentions).toEqual([
        expect.objectContaining({ id: recordId, initiator: 'person', sourceAgentId: source.id, targetAgentId: target.id, text: question }),
      ])
      const card = page.locator(`article[data-agent-mention-id="${recordId}"]`)
      await captureWorkbench(app, 'agent-mention-reply-1440-dark.png')
      const snapshot = await owner.json<AppSnapshot>('snapshot')
      const targetChat = snapshot.agentChats?.[target.id]
      if (targetChat?.state !== 'ready') throw new Error('The recipient has no confirmed chat.')
      const detail = await owner.json<TaskDetail>(`tasks/${targetChat.sessionId}`)
      expect(detail.messages.filter(item => item.role === 'user').map(item => item.text)).toEqual([question])
      await card.locator('[data-open-agent-mention]').click()
      await transcript.getByText(reply, { exact: true }).waitFor()
      const back = page.getByRole('button', { name: '返回编辑', exact: true })
      await back.waitFor()
      await captureWorkbench(app, 'agent-mention-recipient-1440-dark.png')
      await back.click()
      await card.getByText(question, { exact: true }).waitFor()
      await card.getByText(reply, { exact: true }).waitFor()
      await transcript.getByText(sourceMessage, { exact: true }).waitFor()
      await expect.poll(() => card.locator('[data-open-agent-mention]').evaluate(element => document.activeElement === element)).toBe(true)
    } finally {
      await app?.close()
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
