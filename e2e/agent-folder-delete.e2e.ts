import { chromium, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AgentHome, CustomAgent, CustomAgentList, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import type { TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSection, openSettings } from './helpers/layout.ts'

const OUT = 'test-results/agent-folder-delete'

const fixture: HarnessPlugin = {
  id: 'folder-fixture',
  name: 'Folder fixture',
  version: '1',
  description: '',
  activate(context) {
    context.registerProvider({
      id: 'folder-fixture',
      name: 'Folder fixture',
      model: 'fixture',
      async *stream() {
        yield { type: 'text', text: '好的。' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
}

/** Each width and scheme from a fresh `show` (a phone draws the roster and the dialog elsewhere), then `hide`. */
async function shoot(page: Page, name: string, show: () => Promise<void>, hide: () => Promise<void>) {
  for (const [width, colorScheme] of [
    [1440, 'light'],
    [1440, 'dark'],
    [390, 'light'],
  ] as const) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
    await page.emulateMedia({ colorScheme })
    await show()
    await noHorizontalOverflow(page)
    await page.screenshot({ path: join(OUT, `${name}--${width}-${colorScheme}.png`), animations: 'disabled' })
    await hide()
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
}

/** One of my Agents after a first message, with files in its home. */
async function agentWithFiles(owner: TestDevice, name: string) {
  const agent = await owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name,
      description: '',
      harnessId: 'standard',
      mode: 'agent',
      model: { providerId: 'folder-fixture', model: 'fixture' },
    },
  })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    method: 'POST',
    body: { customAgentId: agent.id, prompt: '整理一下', requestId: randomUUID() },
  })
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
  const home = (await owner.json<AgentHome>(`custom-agents/${agent.id}/home`)).path!
  await mkdir(join(home, '笔记'))
  await writeFile(join(home, '笔记', '周报.md'), '# 周报\n')
  return { agent, home }
}

const gone = (path: string) =>
  lstat(path).then(
    () => false,
    () => true,
  )

it('asks once before an Agent’s folder goes: export first on the Mac’s desktop app, or delete for good', async () => {
  await mkdir(OUT, { recursive: true })
  const host: TestHost = await startTestHost({ plugins: [fixture] })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const first = await agentWithFiles(owner, '资料整理')
    const second = await agentWithFiles(owner, '周报助手')
    const third = await agentWithFiles(owner, '旧页面删除的')
    const page = await context.newPage()
    await enrollBrowser(page, host, { name: '删除 Agent', scopes: ['view', 'run', 'admin'], dataScope: 'all' })
    await connected(page)
    const nav = page.locator('nav[data-people="roster"]').filter({ visible: true }).first()
    const toAgents = async () => {
      if (await nav.isVisible()) return
      const place = page.getByRole('radio', { name: '我的 Agent', exact: true }).filter({ visible: true })
      const tab = page.getByRole('button', { name: '我的 Agent', exact: true }).filter({ visible: true })
      if (await place.count()) await place.first().click()
      else if (await tab.count()) await tab.first().click()
    }
    const dialogOf = (agent: CustomAgent) => page.getByRole('dialog', { name: `删除「${agent.name}」？` })
    const open = async (agent: CustomAgent, words = '文件夹无法恢复') => {
      await toAgents()
      const more = nav.getByRole('button', { name: `更多操作：${agent.name}`, exact: true }).filter({ visible: true })
      // A phone keeps the ⋯ out of sight: the row's own context gesture opens the same menu.
      if (await more.count()) await more.first().click()
      else await nav.locator('.agent-row').filter({ hasText: agent.name }).first().click({ button: 'right' })
      await page.getByRole('menuitem', { name: '删除 Agent' }).filter({ visible: true }).first().click()
      const dialog = dialogOf(agent)
      await dialog.getByText(words, { exact: false }).waitFor()
      return dialog
    }
    const close = async (agent: CustomAgent) => {
      await dialogOf(agent).getByRole('button', { name: '取消', exact: true }).click()
      await dialogOf(agent).waitFor({ state: 'hidden' })
    }

    // A browser: no export here, only the reason on hover, and 永久删除.
    let dialog = await open(first.agent)
    await dialog.getByText('需要导出？', { exact: true }).waitFor()
    expect(await dialog.getByRole('button', { name: '导出后删除', exact: true }).count()).toBe(0)
    await close(first.agent)
    await shoot(
      page,
      'browser',
      async () => void (await open(first.agent)),
      () => close(first.agent),
    )

    // The desktop app (its folder bridge stood in for): both choices; an export that fails deletes nothing.
    await page.evaluate(() => {
      const shell = {
        kind: 'electron',
        folders: {
          protocolVersion: 1,
          pick: async () => ({ status: 'canceled' }),
          drop: async () => ({ status: 'canceled' }),
          reveal: async () => ({ status: 'failed', code: 'invalid' }),
          exportAgentFolder: async () => ({ status: 'failed', code: 'export-failed' }),
        },
      }
      Object.assign(window, { latchShell: shell })
    })
    await shoot(
      page,
      'desktop',
      async () => void (await (await open(first.agent)).getByRole('button', { name: '导出后删除', exact: true }).waitFor()),
      () => close(first.agent),
    )
    await shoot(
      page,
      'export-failed',
      async () => {
        const shown = await open(first.agent)
        await shown.getByRole('button', { name: '导出后删除', exact: true }).click()
        await shown.getByText('导出没有完成，什么都没有删除。', { exact: true }).waitFor()
      },
      () => close(first.agent),
    )
    expect(await gone(first.home)).toBe(false)
    expect((await owner.json<CustomAgentList>('custom-agents')).agents.some(agent => agent.id === first.agent.id)).toBe(true)
    dialog = await open(first.agent)

    // 永久删除: the Agent and its folder go; its conversation stays.
    await dialog.getByRole('button', { name: '永久删除', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await expect.poll(() => gone(first.home)).toBe(true)
    expect((await owner.json<CustomAgentList>('custom-agents')).agents.some(agent => agent.id === first.agent.id)).toBe(false)

    // A folder that is no longer the one Latch made stays where it is, and the page says so.
    await chmod(second.home, 0o755)
    // Not the folder it made: nothing to ask about it, and it is not touched.
    dialog = await open(second.agent, '它的记忆会删除，聊天记录保留。')
    await dialog.getByRole('button', { name: '删除', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const kept = page.getByText('已删除 Agent，文件夹保留在原处', { exact: false })
    await kept.waitFor()
    await page.screenshot({ path: join(OUT, 'folder-kept--1440-light.png'), animations: 'disabled' })
    expect(await gone(second.home)).toBe(false)

    // A page from before the choice deletes without asking: its folder is kept, and 设置 › 数据 offers it, once pressed.
    await owner.json(`custom-agents/${third.agent.id}`, { method: 'DELETE', body: { requestId: randomUUID() } })
    await page.reload()
    await connected(page)
    const settings = await openSettings(page)
    await openSection(settings, '数据')
    const group = settings.getByText('已删除 Agent 的文件夹（1）', { exact: true })
    await group.waitFor()
    await group.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(OUT, 'settings-leftover--1440-light.png'), animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: join(OUT, 'settings-leftover--1440-dark.png'), animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'light' })
    expect(await gone(third.home)).toBe(false)
    await settings.getByRole('button', { name: '永久删除', exact: true }).click()
    await page.getByRole('dialog', { name: '永久删除这个文件夹？' }).getByRole('button', { name: '永久删除', exact: true }).click()
    await expect.poll(() => gone(third.home)).toBe(true)
    await group.waitFor({ state: 'hidden' })
  } finally {
    await context.close()
    await browser.close()
    await host.close()
  }
})
