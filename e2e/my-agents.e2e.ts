import { chromium, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AppSnapshot, CustomAgentDetail, CustomAgentList, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

const OUT = 'test-results/my-agents'

/** A local model service, so the built-in Harness answers without the demo model. */
const fixture: HarnessPlugin = {
  id: 'agents-fixture',
  name: 'Agents fixture',
  version: '1',
  description: '',
  activate(context) {
    context.registerProvider({
      id: 'agents-fixture',
      name: 'Agents fixture',
      model: 'fixture',
      async *stream() {
        yield { type: 'text', text: '已收到。' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
}

/** A browser with the full data scope, which Agents need. */
async function fullScopeBrowser(page: Page, host: TestHost, owner: TestDevice, name: string) {
  await enrollBrowser(page, host, { name })
  const id = host.host.security.devices.list().find(device => device.name === name)!.id
  expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
  await page.reload()
  await connected(page)
}

/** The page has stopped moving: a pushed level has slid (or faded) in. */
const settled = (page: Page) =>
  page
    .locator('.agents-page')
    .evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined))))

const choice = (page: Page, name: RegExp) => page.getByRole('menuitemradio', { name }).or(page.getByRole('radio', { name })).first()

it('creates an Agent, delegates real sessions to it, edits its memory, and says when a start is refused or unknown', async () => {
  await mkdir(OUT, { recursive: true })
  const host = await startTestHost({ plugins: [fixture] })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    await owner.json('agents', {
      method: 'POST',
      body: {
        id: 'fake-agent',
        name: 'Fake Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_LOG: join(host.root, 'acp.log') },
      },
    })
    const folder = join(host.root, 'notes')
    await mkdir(folder)
    expect((await owner.addFolders({ paths: [folder], name: 'notes' })).status).toBeLessThan(300)
    const project = (await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces.find(item => item.name === 'notes')!

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await fullScopeBrowser(page, host, owner, '我的 Agent 1440')

    // 我的 Agent sits under Code; its list starts with 通用, built in, and nothing of the person's own yet.
    await page.getByRole('button', { name: '我的 Agent', exact: true }).first().click()
    await page
      .getByRole('list', { name: '我的 Agent', exact: true })
      .getByRole('button', { name: /^通用 内置/u })
      .waitFor()
    await page.getByText('还没有自己的 Agent').waitFor()
    await page.screenshot({ path: `${OUT}/list-empty-1440.png` })

    // Create one on the fake ACP Harness, working in the project.
    await page.getByRole('button', { name: '新建 Agent', exact: true }).click()
    const form = page.getByRole('form', { name: '新建 Agent' })
    await form.getByLabel('名称').fill('资料助手')
    await form.getByLabel('职责').fill('查资料，写成一页摘要')
    await form.getByLabel('指令').fill('只用中文回答。')
    await form.getByRole('button', { name: /^Harness：/u }).click()
    await choice(page, /Fake Agent/u).click()
    await form.getByRole('button', { name: /^项目：/u }).click()
    await choice(page, /notes/u).click()
    await form.getByRole('button', { name: '创建', exact: true }).click()
    await page.getByRole('tab', { name: '委托', exact: true, selected: true }).waitFor()
    const { agents } = await owner.json<CustomAgentList>('custom-agents')
    expect(agents).toHaveLength(1)
    const agent = agents[0]!
    expect(agent).toMatchObject({
      name: '资料助手',
      harnessId: 'fake-agent',
      defaultProjectId: project.id,
      description: '查资料，写成一页摘要',
    })

    // Delegating starts a real session of the Agent, on its Harness and in its project.
    const input = page.getByRole('textbox', { name: '委托内容', exact: true })
    await input.fill('比较三家汇率接口')
    await input.press('Meta+Enter')
    const delegated = async () => (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.agent?.customAgentId === agent.id)
    await expect.poll(async () => (await delegated()).length, { timeout: 15_000 }).toBe(1)
    const [session] = await delegated()
    expect(session).toMatchObject({ harnessId: 'fake-agent', cwd: project.path })
    await expect.poll(() => input.inputValue()).toBe('')
    const recent = page.getByRole('region', { name: '近期委托' })
    await recent.getByRole('button', { name: new RegExp(session!.title.slice(0, 6), 'u') }).waitFor()
    await page.screenshot({ path: `${OUT}/delegated-1440.png` })

    // Next time: from Code back to 我的 Agent, the Agent's page lists it, and it opens the normal conversation.
    await page.getByRole('button', { name: 'Code', exact: true }).click()
    await page.getByRole('button', { name: '我的 Agent', exact: true }).first().click()
    await page
      .getByRole('navigation', { name: 'Agent 列表' })
      .getByRole('button', { name: /资料助手/u })
      .click()
    await recent.getByRole('button', { name: new RegExp(session!.title.slice(0, 6), 'u') }).click()
    const way = page.getByRole('button', { name: '为 资料助手 委托', exact: true })
    await way.waitFor()
    await page.screenshot({ path: `${OUT}/conversation-1440.png` })
    await way.click()
    await page.getByRole('tab', { name: '委托', exact: true, selected: true }).waitFor()

    // 记忆: add one, then change it; the Host keeps what the page says.
    await page.getByRole('tab', { name: '记忆', exact: true }).click()
    await page.getByText('还没有记忆').waitFor()
    await page.getByRole('button', { name: '添加', exact: true }).click()
    await page.getByLabel('新记忆').fill('摘要不超过一页。')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    const memories = page.getByRole('list', { name: '记忆' })
    await memories.getByText('摘要不超过一页。').waitFor()
    await memories.getByRole('button', { name: '修改', exact: true }).click()
    await page.getByLabel('修改记忆').fill('摘要不超过一页，结论放最前。')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await memories.getByText('摘要不超过一页，结论放最前。').waitFor()
    await memories.getByText('已保存').waitFor()
    const saved = await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)
    expect(saved.memories.map(memory => memory.content)).toEqual(['摘要不超过一页，结论放最前。'])
    await page.screenshot({ path: `${OUT}/memory-edited-1440.png` })

    // A refusal says so and keeps what was written.
    await page.getByRole('tab', { name: '委托', exact: true }).click()
    await page.route(
      '**/link/api/tasks',
      route => route.fulfill({ status: 409, json: { error: 'agent-unavailable', message: '这个 Harness 暂时不可用' } }),
      {
        times: 1,
      },
    )
    await input.fill('第二件事')
    await input.press('Meta+Enter')
    await page.getByText(/委托没开始/u).waitFor()
    expect(await input.inputValue()).toBe('第二件事')
    await page.screenshot({ path: `${OUT}/refused-1440.png` })

    // An unknown result keeps the request; retrying sends the same requestId and starts exactly one session.
    const sent: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/tasks')) sent.push(request.postDataJSON().requestId)
    })
    await page.route('**/link/api/tasks', route => route.abort('timedout'), { times: 1 })
    await input.press('Meta+Enter')
    await page.getByText('未确认送达').waitFor()
    await page.screenshot({ path: `${OUT}/unknown-1440.png` })
    expect(await delegated()).toHaveLength(1)
    await page.getByRole('button', { name: '重试这次提交', exact: true }).click()
    await expect.poll(async () => (await delegated()).length, { timeout: 15_000 }).toBe(2)
    expect(sent).toHaveLength(2)
    expect(new Set(sent).size).toBe(1)
    await page.getByText('未确认送达').waitFor({ state: 'detached' })
    await context.close()

    // A phone: 我的 Agent is a tab; an Agent's page is pushed over the list and fits.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', reducedMotion: 'reduce' })
    const narrow = await phone.newPage()
    narrow.setDefaultTimeout(15_000)
    await fullScopeBrowser(narrow, host, owner, '我的 Agent 390')
    const tabs = narrow.getByRole('navigation', { name: '主导航' })
    await tabs.getByRole('button', { name: 'Code', exact: true }).waitFor()
    await tabs.getByRole('button', { name: '我的 Agent', exact: true }).click()
    await narrow
      .getByRole('button', { name: /资料助手/u })
      .first()
      .click()
    await narrow.getByRole('textbox', { name: '委托内容', exact: true }).waitFor()
    await narrow.getByRole('region', { name: '近期委托' }).getByRole('listitem').nth(1).waitFor()
    await settled(narrow)
    await noHorizontalOverflow(narrow)
    await narrow.screenshot({ path: `${OUT}/agent-390-dark.png` })
    await narrow.getByRole('button', { name: '返回', exact: true }).click()
    await narrow.getByRole('button', { name: /^委托资料助手/u }).waitFor()
    await settled(narrow)
    await noHorizontalOverflow(narrow)
    await narrow.screenshot({ path: `${OUT}/list-390-dark.png` })
    await phone.close()

    // A device without the full data scope is told it cannot see Agents, not shown an empty list.
    const scoped = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const limited = await scoped.newPage()
    await enrollBrowser(limited, host, { name: `工作范围 ${randomUUID().slice(0, 4)}` })
    await limited.getByRole('button', { name: '我的 Agent', exact: true }).first().click()
    await limited.getByText('这台设备看不到 Agent').waitFor()
    expect(await limited.getByText('还没有自己的 Agent').count()).toBe(0)
    await scoped.close()
  } finally {
    await browser.close()
    await host.close()
  }
})
