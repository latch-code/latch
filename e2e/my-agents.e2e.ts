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
import { stillMotion } from './helpers/visual.ts'

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

/** Picks one part of the face from the header's picker; the Host's answer is what the picker then shows. */
async function pickAvatar(page: Page, owner: TestDevice, agentId: string, row: '括号' | '眼睛' | '颜色', name: string) {
  const option = page.getByRole('radiogroup', { name: row }).getByRole('radio', { name, exact: true })
  await option.click()
  await expect.poll(() => option.getAttribute('aria-checked')).toBe('true')
  const { agents } = await owner.json<CustomAgentList>('custom-agents')
  return agents.find(agent => agent.id === agentId)!.avatar
}

/** The switch at the top of the sidebar: Code or 我的 Agent. */
const place = (page: Page, name: 'Code' | '我的 Agent') => page.getByRole('radio', { name, exact: true }).first()
/** 我的 Agent's list in the sidebar. */
const agentsNav = (page: Page) => page.getByRole('navigation', { name: '我的 Agent', exact: true })

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
    await stillMotion(context)
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await fullScopeBrowser(page, host, owner, '我的 Agent 1440')

    // 我的 Agent is the other place beside Code; its list starts with 通用, built in, and nothing of the person's own yet.
    await place(page, '我的 Agent').click()
    await page
      .getByRole('list', { name: '我的 Agent', exact: true })
      .getByRole('button', { name: /^通用 内置/u })
      .waitFor()
    await page.getByText('还没有自己的 Agent').waitFor()
    await page.screenshot({ path: `${OUT}/list-empty-1440.png` })

    // Create one on the fake ACP Harness, working in the project, from the sidebar's own 新建 Agent.
    await agentsNav(page).getByRole('button', { name: '新建 Agent', exact: true }).click()
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
      avatar: { kind: 'face', bracket: 'round', eyes: 'dot', hue: 'ink' },
    })

    // Its face opens the picker; a choice is the Host's at once, and stays after a reload.
    await page.getByRole('button', { name: '资料助手 的头像', exact: true }).click()
    expect(await pickAvatar(page, owner, agent.id, '括号', '花括号')).toEqual({ kind: 'face', bracket: 'curly', eyes: 'dot', hue: 'ink' })
    expect(await pickAvatar(page, owner, agent.id, '颜色', '藤')).toEqual({ kind: 'face', bracket: 'curly', eyes: 'dot', hue: 'wisteria' })
    // The keyboard: arrows move focus from the focused face (twice in a row), Space picks it, Tab goes to the next row.
    const focusedLabel = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
    await page.getByRole('radiogroup', { name: '眼睛' }).getByRole('radio', { name: '圆点', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(focusedLabel).toBe('弯眼')
    await page.keyboard.press('ArrowRight')
    await expect.poll(focusedLabel).toBe('椭圆')
    await page.screenshot({ path: `${OUT}/avatar-picker-1440.png` })
    await page.keyboard.press('Space')
    const eyes = page.getByRole('radiogroup', { name: '眼睛' }).getByRole('radio', { name: '椭圆', exact: true })
    await expect.poll(() => eyes.getAttribute('aria-checked')).toBe('true')
    expect((await owner.json<CustomAgentList>('custom-agents')).agents[0]!.avatar.eyes).toBe('oval')
    await page.keyboard.press('Tab')
    await expect.poll(focusedLabel).toBe('藤')
    await page.keyboard.press('Escape')
    await page.reload()
    await connected(page)
    // A reload comes back to the place this device was in.
    await expect.poll(() => place(page, '我的 Agent').getAttribute('aria-checked')).toBe('true')
    await agentsNav(page)
      .getByRole('button', { name: /资料助手/u })
      .click()
    await page.getByRole('tab', { name: '委托', exact: true, selected: true }).waitFor()
    const head = page.locator('.agent-head-avatar .agent-avatar')
    await expect.poll(() => head.getAttribute('data-hue')).toBe('wisteria')
    expect(await page.locator('.agents-page .space-agent .agent-avatar').first().getAttribute('data-hue')).toBe('neutral')

    // A new face while 设置 has unsaved edits keeps them: the avatar is not part of the form.
    await page.getByRole('tab', { name: '设置', exact: true }).click()
    const instructions = page.getByLabel('指令')
    await instructions.fill('只用中文回答，结论放最前。')
    await page.getByRole('button', { name: '资料助手 的头像', exact: true }).click()
    expect((await pickAvatar(page, owner, agent.id, '颜色', '李')).hue).toBe('plum')
    await page.keyboard.press('Escape')
    await expect.poll(() => instructions.inputValue()).toBe('只用中文回答，结论放最前。')
    expect(await page.getByText('已在别处修改').count()).toBe(0)
    expect((await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)).agent.instructions).toBe('只用中文回答。')
    await page.getByRole('tab', { name: '委托', exact: true }).click()

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

    // The delegation lives in 我的 Agent: 最近委托 lists it, Code does not.
    const delegation = agentsNav(page)
      .getByRole('region', { name: '最近委托' })
      .getByRole('button', { name: new RegExp(session!.title.slice(0, 6), 'u') })
    await delegation.waitFor()
    await place(page, 'Code').click()
    await page.getByRole('navigation', { name: '会话列表' }).waitFor()
    expect(await page.getByRole('navigation', { name: '会话列表' }).locator(`[data-task-id="${session!.id}"]`).count()).toBe(0)
    expect(await page.getByRole('button', { name: '新建会话', exact: true }).first().isVisible()).toBe(true)

    // Back in 我的 Agent it opens the normal conversation, under 我的 Agent / the Agent, and the place follows it.
    await place(page, '我的 Agent').click()
    await delegation.click()
    const way = page.locator('.topbar').getByRole('button', { name: '资料助手', exact: true })
    await way.waitFor()
    expect(await place(page, '我的 Agent').getAttribute('aria-checked')).toBe('true')
    await expect.poll(() => delegation.getAttribute('aria-current')).toBe('page')
    await page.screenshot({ path: `${OUT}/conversation-1440.png` })

    // Something waits in 我的 Agent while Code is shown: an amber dot on its segment, and on its button when shut.
    await page.route('**/link/api/snapshot*', async route => {
      const response = await route.fetch()
      const snapshot = (await response.json()) as AppSnapshot
      if (!Array.isArray(snapshot.tasks)) return route.fulfill({ response })
      const tasks = snapshot.tasks.map(task => (task.id === session!.id ? { ...task, status: 'waiting-approval' as const } : task))
      await route.fulfill({ response, json: { ...snapshot, tasks } })
    })
    // The keys: ⇧⌘1 to Code, ⇧⌘2 back.
    await page.keyboard.press('Meta+Shift+Digit1')
    await expect.poll(() => place(page, 'Code').getAttribute('aria-checked')).toBe('true')
    await page.reload()
    await connected(page)
    await expect.poll(() => place(page, '我的 Agent').locator('.space-dot').count()).toBe(1)
    expect(await place(page, 'Code').locator('.space-dot').count()).toBe(0)
    await page.screenshot({ path: `${OUT}/waiting-dot-1440.png` })
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
    const shut = page.locator('.titlebar').getByRole('group', { name: 'Code 与我的 Agent' })
    await expect.poll(() => shut.getByRole('button', { name: '我的 Agent', exact: true }).locator('.space-dot').count()).toBe(1)
    await shut.getByRole('button', { name: '我的 Agent', exact: true }).click()
    await expect.poll(() => shut.getByRole('button', { name: '我的 Agent', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await page.screenshot({ path: `${OUT}/shut-1440.png` })
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
    await page.unroute('**/link/api/snapshot*')
    await page.keyboard.press('Meta+Shift+Digit1')
    await expect.poll(() => place(page, 'Code').getAttribute('aria-checked')).toBe('true')
    await page.keyboard.press('Meta+Shift+Digit2')
    await expect.poll(() => place(page, '我的 Agent').getAttribute('aria-checked')).toBe('true')
    // Focus lands on the place's primary, never on the page.
    await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-space-primary'))).toBe(true)

    // 委托… (the key of 新会话, a browser's Alt N) chooses an Agent and opens its page on 委托 with the input ready.
    await page.keyboard.press('Alt+KeyN')
    await page.getByRole('menuitem', { name: /资料助手/u }).click()
    await page.getByRole('tab', { name: '委托', exact: true, selected: true }).waitFor()
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('委托内容')
    await way.waitFor({ state: 'detached' })
    await page.locator('.agents-crumb').getByRole('button', { name: '我的 Agent', exact: true }).waitFor()

    // Archived, the delegation stays in 我的 Agent: under its own 已归档, not in 最近委托 and not in Code.
    await owner.json('tasks/' + session!.id, { method: 'PATCH', body: { archived: true } })
    const shelf = agentsNav(page).getByRole('button', { name: /^已归档的委托/u })
    await shelf.click()
    await agentsNav(page)
      .getByRole('region', { name: '已归档' })
      .getByRole('button', { name: new RegExp(session!.title.slice(0, 6), 'u') })
      .waitFor()
    await page.screenshot({ path: `${OUT}/archived-1440.png` })
    await agentsNav(page)
      .getByRole('region', { name: '已归档' })
      .getByRole('button', { name: /^已归档/u })
      .first()
      .click()
    await shelf.waitFor()
    await owner.json('tasks/' + session!.id, { method: 'PATCH', body: { archived: false } })
    await delegation.waitFor()

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
    await stillMotion(phone)
    const narrow = await phone.newPage()
    narrow.setDefaultTimeout(15_000)
    await fullScopeBrowser(narrow, host, owner, '我的 Agent 390')
    const tabs = narrow.getByRole('navigation', { name: '主导航' })
    await tabs.getByRole('button', { name: 'Code', exact: true }).waitFor()
    await tabs.getByRole('button', { name: '我的 Agent', exact: true }).click()
    // The tab lists the delegations too, under the Agents.
    await narrow.getByRole('region', { name: '最近委托' }).first().getByRole('button').first().waitFor()
    await narrow
      .getByRole('list', { name: '我的 Agent', exact: true })
      .getByRole('button', { name: /资料助手/u })
      .click()
    await narrow.getByRole('textbox', { name: '委托内容', exact: true }).waitFor()
    await narrow.getByRole('region', { name: '近期委托' }).getByRole('listitem').nth(1).waitFor()
    await settled(narrow)
    await noHorizontalOverflow(narrow)
    await narrow.screenshot({ path: `${OUT}/agent-390-dark.png` })
    // On a phone the picker is a sheet; the choice is the Host's and survives a reload.
    await narrow.getByRole('button', { name: '资料助手 的头像', exact: true }).click()
    expect(await pickAvatar(narrow, owner, agent.id, '眼睛', '弯眼')).toEqual({
      kind: 'face',
      bracket: 'curly',
      eyes: 'arc',
      hue: 'plum',
    })
    await noHorizontalOverflow(narrow)
    await narrow.screenshot({ path: `${OUT}/avatar-picker-390-dark.png` })
    await narrow.getByRole('button', { name: '完成', exact: true }).click()
    await narrow.reload()
    await connected(narrow)
    await narrow.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的 Agent', exact: true }).click()
    await narrow
      .getByRole('list', { name: '我的 Agent', exact: true })
      .getByRole('button', { name: /资料助手/u })
      .click()
    await expect.poll(() => narrow.locator('.agent-head-avatar .agent-avatar path').nth(2).getAttribute('d')).toContain('Q16.9 19.4')
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
    await place(limited, '我的 Agent').click()
    await limited.locator('.agents-content').getByText('这台设备看不到 Agent').waitFor()
    await agentsNav(limited).getByText('这台设备看不到 Agent').waitFor()
    expect(await limited.getByText('还没有自己的 Agent').count()).toBe(0)
    await scoped.close()
  } finally {
    await browser.close()
    await host.close()
  }
})

it('delegates from an Agent with no default project into the start folder', async () => {
  const host = await startTestHost({ plugins: [fixture] })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    await owner.json('agents', {
      method: 'POST',
      body: { id: 'fake-agent', name: 'Fake Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
    })
    const agent = await owner.json<{ id: string }>('custom-agents', {
      method: 'POST',
      body: { requestId: randomUUID(), name: '随手助手', harnessId: 'fake-agent', mode: 'agent', instructions: '', skills: [] },
    })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await fullScopeBrowser(page, host, owner, '无项目 Agent')
    await place(page, '我的 Agent').click()
    await agentsNav(page)
      .getByRole('button', { name: /随手助手/u })
      .click()
    const sent: unknown[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/tasks')) sent.push(request.postDataJSON())
    })
    const input = page.getByRole('textbox', { name: '委托内容', exact: true })
    await input.fill('列一下待办')
    await input.press('Meta+Enter')
    const delegated = async () => (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.agent?.customAgentId === agent.id)
    await expect.poll(async () => (await delegated()).length, { timeout: 15_000 }).toBe(1)
    expect(sent).toEqual([expect.objectContaining({ customAgentId: agent.id, workspaceId: 'default' })])
    // The Host fills in where it works after the row first appears: wait for the whole of it.
    await expect
      .poll(async () => (await delegated())[0], { timeout: 15_000 })
      .toMatchObject({ harnessId: 'fake-agent', workspaceId: 'default', cwd: host.workspaceRoot })
    await expect.poll(() => input.inputValue()).toBe('')
    expect(await page.getByText(/委托没开始/u).count()).toBe(0)
    await context.close()
  } finally {
    await browser.close()
    await host.close()
  }
})
