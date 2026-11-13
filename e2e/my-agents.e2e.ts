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

it('creates an Agent, talks with it in topics, keeps its profile, talks with 通用, and says when a start is refused or unknown', async () => {
  await mkdir(OUT, { recursive: true })
  const host = await startTestHost({ plugins: [fixture] })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
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

    // Create one on the fake ACP Harness, working in the project, from the sidebar's own 新建 Agent: first who, then
    // its name and duty, with the project under 更多.
    await agentsNav(page).getByRole('button', { name: '新建 Agent', exact: true }).click()
    await page.getByRole('heading', { name: '你想让谁成为你的帮手？' }).waitFor()
    await page.getByRole('list', { name: '候选' }).getByRole('button', { name: 'Fake Agent', exact: true }).click()
    const form = page.getByRole('form', { name: '新建 Agent' })
    await form.getByLabel('名字').fill('资料助手')
    await form.getByLabel('职责').fill('查资料，写成一页摘要')
    await form.getByRole('button', { name: '多说几句' }).click()
    await form.getByLabel('指令').fill('只用中文回答。')
    await form.getByRole('button', { name: '更多' }).click()
    await form.getByRole('button', { name: /^项目：/u }).click()
    await choice(page, /notes/u).click()
    await form.getByRole('button', { name: '创建', exact: true }).click()
    // Created, it opens as a conversation with no topic yet: its frame on top, the input ready at the bottom.
    const input = page.getByRole('textbox', { name: '给资料助手发消息', exact: true })
    await input.waitFor()
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('给资料助手发消息')
    const who = page.getByRole('button', { name: '资料助手 的资料', exact: true })
    await who.waitFor()
    await page.screenshot({ path: `${OUT}/chat-empty-1440.png` })
    const { agents } = await owner.json<CustomAgentList>('custom-agents')
    expect(agents).toHaveLength(1)
    const agent = agents[0]!
    expect(agent).toMatchObject({
      name: '资料助手',
      harnessId: 'fake-agent',
      defaultProjectId: project.id,
      avatar: { kind: 'face', bracket: 'round', eyes: 'dot', hue: 'ink' },
    })

    // The face opens the profile; its big face opens the picker, and a choice is the Host's at once.
    await who.click()
    const profile = page.getByRole('region', { name: '资料助手 的资料', exact: true })
    await profile.getByText('查资料，写成一页摘要').waitFor()
    await profile.getByRole('button', { name: '资料助手 的头像', exact: true }).click()
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
    await expect.poll(() => profile.locator('.agent-head-avatar .agent-avatar').getAttribute('data-hue')).toBe('wisteria')
    await page.screenshot({ path: `${OUT}/chat-profile-1440.png` })
    // Escape closes the profile and gives focus back to the face that opened it.
    await page.keyboard.press('Escape')
    await profile.waitFor({ state: 'detached' })
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('资料助手 的资料')
    await who.click()
    await profile.waitFor()

    // The first message starts its first topic: a real session of the Agent, on its Harness and in its project.
    const delegated = async () => (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.agent?.customAgentId === agent.id)
    await input.fill('比较三家汇率接口')
    await input.press('Meta+Enter')
    await expect.poll(async () => (await delegated()).length, { timeout: 15_000 }).toBe(1)
    const [first] = await delegated()
    expect(first).toMatchObject({ harnessId: 'fake-agent', cwd: project.path })
    // The topic opens in place: the same frame, the session's own composer saying whom it talks to.
    await page.locator('.topbar .agent-frame').waitFor()
    await expect.poll(() => page.locator(`[data-task-id="${first!.id}"][aria-current="page"]`).count()).toBe(1)
    expect(await place(page, '我的 Agent').getAttribute('aria-checked')).toBe('true')
    await page.screenshot({ path: `${OUT}/topic-1440.png` })

    // After a reload, the Agent's row opens the same topic.
    await page.reload()
    await connected(page)
    await agentsNav(page)
      .getByRole('button', { name: /资料助手/u })
      .first()
      .click()
    await expect.poll(() => page.locator(`[data-task-id="${first!.id}"][aria-current="page"]`).count()).toBe(1)
    await page.locator('.topbar .agent-frame').waitFor()

    // 话题 ▾ → 新话题: the next message starts a second topic; the menu then lists both, the open one checked.
    await page.locator('.topbar').getByRole('button', { name: '话题', exact: true }).click()
    await page.getByRole('menuitemradio', { name: /新话题/u }).click()
    await input.waitFor()
    await input.fill('再查一下手续费')
    await input.press('Meta+Enter')
    await expect.poll(async () => (await delegated()).length, { timeout: 15_000 }).toBe(2)
    const second = (await delegated()).find(task => task.id !== first!.id)!
    await expect.poll(() => page.locator(`[data-task-id="${second.id}"][aria-current="page"]`).count()).toBe(1)
    await page.locator('.topbar').getByRole('button', { name: '话题', exact: true }).click()
    const topics = page.getByRole('menu', { name: '话题' })
    await topics.getByRole('menuitemradio', { name: new RegExp(second.title.slice(0, 4), 'u'), checked: true }).waitFor()
    await page.screenshot({ path: `${OUT}/topics-menu-1440.png` })
    await topics.getByRole('menuitemradio', { name: new RegExp(first!.title.slice(0, 4), 'u') }).click()
    await expect.poll(() => page.locator(`[data-task-id="${first!.id}"][aria-current="page"]`).count()).toBe(1)

    // The conversations live in 我的 Agent: 最近对话 lists them, Code does not.
    await agentsNav(page).getByRole('region', { name: '最近对话' }).waitFor()
    await place(page, 'Code').click()
    await page.getByRole('navigation', { name: '会话列表' }).waitFor()
    expect(await page.getByRole('navigation', { name: '会话列表' }).locator(`[data-task-id="${first!.id}"]`).count()).toBe(0)
    await place(page, '我的 Agent').click()
    await page.locator('.topbar .agent-frame').waitFor()

    // Native tasks can be saved closed; the profile must not offer a background grant above the Host's ceiling.
    const automation = await owner.json<{ id: string }>('automations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '每周汇率',
        customAgentId: agent.id,
        prompt: '汇总本周汇率',
        schedule: { kind: 'weekly', day: 1, time: '09:00' },
        notify: false,
        enabled: false,
      },
    })
    await page.locator('.topbar').getByRole('button', { name: '资料助手 的资料', exact: true }).click()
    const panel = page.getByRole('region', { name: '资料助手 的资料', exact: true })
    const toggle = panel.getByRole('switch', { name: '每周汇率 开启' })
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
    expect(await toggle.isDisabled()).toBe(true)
    expect((await owner.json<AppSnapshot>('snapshot')).automations?.find(item => item.id === automation.id)?.enabled).toBe(false)
    await panel.getByRole('radio', { name: '记忆', exact: true }).click()
    await panel.getByText('还没有记忆').waitFor()
    await panel.getByRole('button', { name: '添加', exact: true }).click()
    await panel.getByLabel('新记忆').fill('摘要不超过一页。')
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    const memories = panel.getByRole('list', { name: '记忆' })
    await memories.getByText('摘要不超过一页。').waitFor()
    await memories.getByRole('button', { name: '修改', exact: true }).click()
    await panel.getByLabel('修改记忆').fill('摘要不超过一页，结论放最前。')
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await memories.getByText('摘要不超过一页，结论放最前。').waitFor()
    await memories.getByText('已保存').waitFor()
    const saved = await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)
    expect(saved.memories.map(memory => memory.content)).toEqual(['摘要不超过一页，结论放最前。'])
    await page.screenshot({ path: `${OUT}/profile-memory-1440.png` })
    // 设置 opens the edit form in the profile.
    await panel.getByRole('button', { name: '设置', exact: true }).click()
    const instructions = panel.getByLabel('指令')
    await instructions.fill('只用中文回答，结论放最前。')
    // A new face chosen elsewhere keeps the unsaved edit: the avatar is not part of the form.
    const current = (await owner.json<CustomAgentList>('custom-agents')).agents.find(item => item.id === agent.id)!
    await owner.json(`custom-agents/${agent.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: current.revision, avatar: { ...current.avatar, hue: 'plum' } },
    })
    await expect
      .poll(async () => (await owner.json<CustomAgentList>('custom-agents')).agents.find(item => item.id === agent.id)!.avatar.hue)
      .toBe('plum')
    await expect.poll(() => page.locator('.topbar .agent-frame-who .agent-avatar').getAttribute('data-hue')).toBe('plum')
    expect(await instructions.inputValue()).toBe('只用中文回答，结论放最前。')
    expect(await page.getByText('已在别处修改').count()).toBe(0)
    expect((await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)).agent.instructions).toBe('只用中文回答。')
    await panel.getByRole('button', { name: '关闭资料', exact: true }).click()
    await panel.waitFor({ state: 'detached' })

    // Archived, a topic stays in 我的 Agent: under its own 已归档, not in 最近对话 and not in Code.
    await owner.json('tasks/' + second.id, { method: 'PATCH', body: { archived: true } })
    const shelf = agentsNav(page).getByRole('button', { name: /^已归档的对话/u })
    await shelf.click()
    await agentsNav(page)
      .getByRole('region', { name: '已归档' })
      .getByRole('button', { name: new RegExp(second.title.slice(0, 4), 'u') })
      .waitFor()
    await page.screenshot({ path: `${OUT}/archived-1440.png` })
    await agentsNav(page)
      .getByRole('region', { name: '已归档' })
      .getByRole('button', { name: /^已归档/u })
      .first()
      .click()
    await shelf.waitFor()
    await owner.json('tasks/' + second.id, { method: 'PATCH', body: { archived: false } })

    // Something waits in 我的 Agent while Code is shown: an amber dot on its segment, and on its button when shut.
    await page.route('**/link/api/snapshot*', async route => {
      const response = await route.fetch()
      const snapshot = (await response.json()) as AppSnapshot
      if (!Array.isArray(snapshot.tasks)) return route.fulfill({ response })
      const tasks = snapshot.tasks.map(task => (task.id === first!.id ? { ...task, status: 'waiting-approval' as const } : task))
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
    await page.keyboard.press('Escape')

    // 通用: its row opens a conversation without a project, which belongs to 我的 Agent and not to Code.
    await agentsNav(page)
      .getByRole('button', { name: /^通用/u })
      .click()
    const generalInput = page.getByRole('textbox', { name: '给通用发消息', exact: true })
    await generalInput.fill('今天先做什么？')
    await generalInput.press('Meta+Enter')
    const generalChats = async () => (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.generalChat)
    await expect.poll(async () => (await generalChats()).length, { timeout: 15_000 }).toBe(1)
    const [talk] = await generalChats()
    expect(talk).not.toHaveProperty('agent')
    await expect.poll(() => page.locator(`[data-task-id="${talk!.id}"][aria-current="page"]`).count()).toBe(1)
    await page.locator('.topbar').getByRole('button', { name: '通用 的资料', exact: true }).waitFor()
    await page.screenshot({ path: `${OUT}/general-1440.png` })

    // 新对话… (the key of 新会话, a browser's Alt N) chooses an Agent and opens a new topic with the input ready.
    await page.keyboard.press('Alt+KeyN')
    await page.getByRole('menuitem', { name: /资料助手/u }).click()
    await input.waitFor()
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('给资料助手发消息')

    // A refusal says so and keeps what was written.
    await page.route(
      '**/link/api/tasks',
      route => route.fulfill({ status: 409, json: { error: 'agent-unavailable', message: '这个 Harness 暂时不可用' } }),
      {
        times: 1,
      },
    )
    await input.fill('第三件事')
    await input.press('Meta+Enter')
    await page.getByText(/没有开始/u).waitFor()
    expect(await input.inputValue()).toBe('第三件事')
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
    expect(await delegated()).toHaveLength(2)
    await page.getByRole('button', { name: '重试这次提交', exact: true }).click()
    await expect.poll(async () => (await delegated()).length, { timeout: 15_000 }).toBe(3)
    expect(sent).toHaveLength(2)
    expect(new Set(sent).size).toBe(1)
    // The page ends the unconfirmed start only on the Host's answer: wait until that answer has opened its topic here.
    const third = (await delegated()).find(task => task.id !== first!.id && task.id !== second.id)!
    await expect.poll(() => page.locator(`[data-task-id="${third.id}"][aria-current="page"]`).count()).toBe(1)
    await page.locator('.topbar .agent-frame').waitFor()
    // A start still unconfirmed says why and can be given up: its text comes back, and nothing new was started here.
    await page.locator('.topbar').getByRole('button', { name: '话题', exact: true }).click()
    await page.getByRole('menuitemradio', { name: /新话题/u }).click()
    await page.route('**/link/api/tasks', route => route.abort('timedout'), { times: 1 })
    await input.fill('第四件事')
    await input.press('Meta+Enter')
    const card = page.locator('.pending-submission')
    await card.getByText('未确认送达').waitFor()
    expect((await card.locator('.pending-submission-reason').textContent())?.trim()).not.toBe('')
    await card.getByRole('button', { name: '放弃这次提交', exact: true }).click()
    await card.waitFor({ state: 'detached' })
    await expect.poll(() => input.inputValue()).toBe('第四件事')
    expect(await delegated()).toHaveLength(3)

    await context.close()

    // A phone: 我的 Agent is a tab; an Agent opens its current topic, and its face opens the profile as a sheet.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', reducedMotion: 'reduce' })
    await stillMotion(phone)
    const narrow = await phone.newPage()
    narrow.setDefaultTimeout(15_000)
    await fullScopeBrowser(narrow, host, owner, '我的 Agent 390')
    const tabs = narrow.getByRole('navigation', { name: '主导航' })
    await tabs.getByRole('button', { name: 'Code', exact: true }).waitFor()
    await tabs.getByRole('button', { name: '我的 Agent', exact: true }).click()
    await narrow.getByRole('region', { name: '最近对话' }).first().getByRole('button').first().waitFor()
    await settled(narrow)
    await noHorizontalOverflow(narrow)
    await narrow.screenshot({ path: `${OUT}/list-390-dark.png` })
    await narrow
      .getByRole('list', { name: '我的 Agent', exact: true })
      .getByRole('button', { name: /资料助手/u })
      .click()
    const phoneWho = narrow.locator('.topbar').getByRole('button', { name: '资料助手 的资料', exact: true })
    await phoneWho.waitFor()
    await noHorizontalOverflow(narrow)
    await narrow.screenshot({ path: `${OUT}/topic-390-dark.png` })
    await phoneWho.click()
    const sheet = narrow.getByRole('dialog', { name: '资料助手' })
    await sheet.getByRole('region', { name: '资料助手 的资料' }).waitFor()
    await noHorizontalOverflow(narrow)
    await narrow.screenshot({ path: `${OUT}/profile-390-dark.png` })
    // On a phone the picker is a sheet too; the choice is the Host's and survives a reload.
    await sheet.getByRole('button', { name: '资料助手 的头像', exact: true }).click()
    expect((await pickAvatar(narrow, owner, agent.id, '眼睛', '弯眼')).eyes).toBe('arc')
    await noHorizontalOverflow(narrow)
    await narrow.screenshot({ path: `${OUT}/avatar-picker-390-dark.png` })
    const pickerDone = sheet.getByRole('region', { name: '资料助手 的资料' }).getByRole('button', { name: '完成', exact: true })
    await pickerDone.click()
    await pickerDone.waitFor({ state: 'hidden' })
    await sheet.getByRole('banner').getByRole('button', { name: '完成', exact: true }).click()
    await sheet.waitFor({ state: 'hidden' })
    await narrow.reload()
    await connected(narrow)
    await phoneWho.click()
    await expect.poll(() => sheet.locator('.agent-head-avatar .agent-avatar path').nth(2).getAttribute('d')).toContain('Q16.9 19.4')
    await sheet.getByRole('banner').getByRole('button', { name: '完成', exact: true }).click()
    await sheet.waitFor({ state: 'hidden' })
    await narrow.getByRole('button', { name: '返回', exact: true }).first().click()
    await narrow.getByRole('button', { name: /^给资料助手发消息/u }).waitFor()
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

it('delegates from an Agent with no default project into its fixed home', async () => {
  const host = await startTestHost({ plugins: [fixture] })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
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
    const input = page.getByRole('textbox', { name: '给随手助手发消息', exact: true })
    await input.fill('列一下待办')
    await input.press('Meta+Enter')
    const delegated = async () => (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.agent?.customAgentId === agent.id)
    await expect.poll(async () => (await delegated()).length, { timeout: 15_000 }).toBe(1)
    expect(sent).toEqual([expect.objectContaining({ customAgentId: agent.id, workspaceId: 'default' })])
    // The Host fills in where it works after the row first appears: wait for the whole of it.
    await expect
      .poll(async () => (await delegated())[0], { timeout: 15_000 })
      .toMatchObject({ harnessId: 'fake-agent', workspaceId: 'default', cwd: join(host.workspaceRoot, 'helpers', agent.id) })
    await page.locator('.topbar .agent-frame').waitFor()
    expect(await page.getByText(/没有开始/u).count()).toBe(0)
    await context.close()
  } finally {
    await browser.close()
    await host.close()
  }
})
