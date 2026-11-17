import { chromium, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AppSnapshot, CustomAgent, CustomAgentDetail, CustomAgentList, TaskDetail, WorkspaceInfo } from '@latch/protocol'
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
  return id
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
const agentRow = (page: Page, id: string) => agentsNav(page).locator(`[data-agent-id="${id}"]`)

const choice = (page: Page, name: RegExp) => page.getByRole('menuitemradio', { name }).or(page.getByRole('radio', { name })).first()

it('creates an Agent, continues its one chat, keeps its profile, talks with 通用, and says when a start is refused or unknown', async () => {
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
    await page.getByRole('list', { name: '我的 Agent', exact: true }).locator('[data-agent-id="general"]').waitFor()
    await page.locator('.agents-page').getByText('还没有自己的 Agent').first().waitFor()
    await page.screenshot({ path: `${OUT}/list-empty-1440.png` })

    // Create one on the fake ACP Harness, working in the project, from the sidebar's own 新建 Agent: first who, then
    // its name and duty, with the project under 更多.
    await page.locator('button:not([inert] *):visible', { hasText: '新建 Agent' }).first().click()
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
    const header = await page.locator('.agent-chat-main > .topbar-frame').boundingBox()
    const field = await input.boundingBox()
    expect(header!.height).toBeLessThan(160)
    expect(header!.y).toBeLessThan(90)
    expect(page.viewportSize()!.height - (field!.y + field!.height)).toBeLessThan(144)
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
    await page.locator('.transcript-shell').getByText('比较三家汇率接口', { exact: true }).waitFor()
    await expect.poll(() => page.locator(`[data-agent-id="${agent.id}"][aria-current="page"]`).filter({ visible: true }).count()).toBe(1)
    expect(await place(page, '我的 Agent').getAttribute('aria-checked')).toBe('true')
    await page.screenshot({ path: `${OUT}/topic-1440.png` })

    // After a reload, the Agent's row opens the same topic.
    await page.reload()
    await connected(page)
    await agentsNav(page).locator(`[data-agent-id="${agent.id}"]`).first().click()
    await expect.poll(() => page.locator(`[data-agent-id="${agent.id}"][aria-current="page"]`).filter({ visible: true }).count()).toBe(1)
    await page.locator('.topbar .agent-frame').waitFor()

    const detail = async () => owner.json<TaskDetail>(`tasks/${first!.id}`)
    await expect.poll(async () => (await detail()).summary.status).toBe('idle')
    const replyInput = page.getByRole('textbox', { name: '继续对话', exact: true }).filter({ visible: true })
    await replyInput.fill('再查一下手续费')
    await replyInput.press('Meta+Enter')
    await expect
      .poll(async () => (await detail()).messages.filter(message => message.role === 'user').map(message => message.text))
      .toEqual(['比较三家汇率接口', '再查一下手续费'])
    expect(await delegated()).toHaveLength(1)
    expect(await page.locator('.topbar').getByRole('button', { name: '话题', exact: true }).count()).toBe(0)
    expect(await agentsNav(page).locator('.agent-tree').count()).toBe(0)

    // The row ends with a state icon, never a word, and names no Harness or model.
    expect(await agentsNav(page).innerText()).not.toMatch(/Fake Agent|Harness|模型|内置/u)
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
    // The profile's head is the right column's top row, under the window's controls: its close button stays clear of
    // them at every desktop width, with the sidebar open and shut.
    const closeProfile = panel.getByRole('button', { name: '关闭资料', exact: true })
    const closeOnTop = () =>
      closeProfile.evaluate(button => {
        const box = button.getBoundingClientRect()
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button') === button
      })
    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(closeOnTop, { message: `${width}` }).toBe(true)
      await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
      await expect.poll(closeOnTop, { message: `${width}, sidebar shut` }).toBe(true)
      await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
    }
    await closeProfile.click()
    await panel.waitFor({ state: 'detached' })

    const cannotArchive = await owner.request('tasks/' + first!.id, { method: 'PATCH', body: { archived: true } })
    expect(cannotArchive.status).toBe(409)
    expect(await cannotArchive.json()).toMatchObject({ error: 'agent-chat-retained' })

    // Something waits in 我的 Agent while Code is shown: an amber dot on its segment, and on its button when shut.
    await page.route('**/link/api/snapshot*', async route => {
      const response = await route.fetch()
      const snapshot = (await response.json()) as AppSnapshot
      if (!Array.isArray(snapshot.tasks)) return route.fulfill({ response })
      const tasks = snapshot.tasks.map(task =>
        task.id === first!.id
          ? {
              ...task,
              status: 'waiting-approval' as const,
              board: { ...task.board, group: 'attention' as const, reason: 'approval' as const },
            }
          : task,
      )
      await route.fulfill({ response, json: { ...snapshot, tasks } })
    })
    // Code's home covers the topic without closing it, so after the reload its detail is read again: it says the same.
    const firstDetail = `**/link/api/tasks/${first!.id}`
    await page.route(firstDetail, async route => {
      const response = await route.fetch()
      const detail = (await response.json()) as { summary?: { status: string } }
      if (!detail.summary) return route.fulfill({ response })
      const summary = { ...detail.summary, status: 'waiting-approval', board: { group: 'attention', reason: 'approval' } }
      await route.fulfill({ response, json: { ...detail, summary } })
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
    await page.unroute(firstDetail)
    await page.keyboard.press('Meta+Shift+Digit1')
    await expect.poll(() => place(page, 'Code').getAttribute('aria-checked')).toBe('true')
    await page.keyboard.press('Meta+Shift+Digit2')
    await expect.poll(() => place(page, '我的 Agent').getAttribute('aria-checked')).toBe('true')
    // Focus lands on the place's primary, never on the page.
    await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-space-primary'))).toBe(true)
    await page.keyboard.press('Escape')

    // 通用: its row opens a conversation without a project, which belongs to 我的 Agent and not to Code.
    await agentsNav(page).locator('[data-agent-id="general"]').click()
    const generalInput = page.getByRole('textbox', { name: '给通用发消息', exact: true })
    await generalInput.fill('今天先做什么？')
    await generalInput.press('Meta+Enter')
    const generalChats = async () => (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.generalChat)
    await expect.poll(async () => (await generalChats()).length, { timeout: 15_000 }).toBe(1)
    const [talk] = await generalChats()
    expect(talk).not.toHaveProperty('agent')
    await expect.poll(() => page.locator('[data-agent-id="general"][aria-current="page"]').filter({ visible: true }).count()).toBe(1)
    await page.locator('.topbar').getByRole('button', { name: '通用 的资料', exact: true }).waitFor()
    await page.screenshot({ path: `${OUT}/general-1440.png` })
    // The Code schedule shortcut opens General's existing chat and its own profile without collapsing the page.
    await place(page, 'Code').click()
    await page.getByRole('button', { name: '定时任务', exact: true }).filter({ visible: true }).first().click()
    const generalProfile = page.getByRole('region', { name: '通用 的资料', exact: true })
    await generalProfile.getByText('没有定时任务', { exact: true }).waitFor()
    await expect.poll(async () => (await generalProfile.boundingBox())?.width ?? 0).toBeGreaterThan(0)
    await page.getByText('今天先做什么？', { exact: true }).last().waitFor()
    expect((await owner.json<AppSnapshot>('snapshot')).agentChats?.general).toEqual({ state: 'ready', sessionId: talk!.id })
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUT}/general-from-code-schedule-1440.png` })
    await generalProfile.getByRole('button', { name: '关闭资料', exact: true }).click()

    const fresh = async (name: string) =>
      owner.json<CustomAgent>('custom-agents', {
        method: 'POST',
        body: { requestId: randomUUID(), name, description: '', harnessId: 'fake-agent', mode: 'agent' },
      })
    const retryAgent = await fresh('核对助手')
    await expect.poll(() => agentRow(page, retryAgent.id).count()).toBe(1)
    // 新会话 in 我的 Agent opens the chat of the Agent last spoken with; the 总览 lists everyone with one action each.
    await page.keyboard.press('Alt+KeyN')
    await page.locator('.agent-frame').filter({ visible: true }).first().waitFor()
    await page.getByRole('button', { name: '总览', exact: true }).filter({ visible: true }).first().click()
    await expect.poll(() => page.locator('.agents-page').getAttribute('data-view')).toBe('home')
    await page.getByRole('navigation', { name: '全部 Agent', exact: true }).locator(`[data-helper-id="${retryAgent.id}"]`).click()
    const retryInput = page.getByRole('textbox', { name: '给核对助手发消息', exact: true })
    await retryInput.fill('写了一半')
    await page.screenshot({ path: `${OUT}/home-1440.png` })

    // A refusal says so and keeps what was written.
    await page.route(
      '**/link/api/tasks',
      route => route.fulfill({ status: 409, json: { error: 'agent-unavailable', message: '这个 Harness 暂时不可用' } }),
      {
        times: 1,
      },
    )
    await retryInput.fill('第一条核对消息')
    await retryInput.press('Meta+Enter')
    await page.getByText(/没有开始/u).waitFor()
    expect(await retryInput.inputValue()).toBe('第一条核对消息')
    await page.screenshot({ path: `${OUT}/refused-1440.png` })

    // An unknown result keeps the request; retrying sends the same requestId and starts exactly one session.
    const sent: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/tasks')) sent.push(request.postDataJSON().requestId)
    })
    await page.route('**/link/api/tasks', route => route.abort('timedout'), { times: 1 })
    await retryInput.press('Meta+Enter')
    await page.getByText('未确认送达').waitFor()
    await page.screenshot({ path: `${OUT}/unknown-1440.png` })
    const chat = async () => (await owner.json<AppSnapshot>('snapshot')).agentChats?.[retryAgent.id]
    expect(await chat()).toEqual({ state: 'empty' })
    await page.getByRole('button', { name: '重试这次提交', exact: true }).click()
    await expect.poll(async () => (await chat())?.state).toBe('ready')
    expect(sent).toHaveLength(2)
    expect(new Set(sent).size).toBe(1)
    await page.locator('.topbar').getByRole('button', { name: '核对助手 的资料', exact: true }).waitFor()

    const another = await fresh('暂存助手')
    await agentRow(page, another.id).click()
    const laterInput = page.getByRole('textbox', { name: '给暂存助手发消息', exact: true })
    await page.route('**/link/api/tasks', route => route.abort('timedout'), { times: 1 })
    await laterInput.fill('保留这份草稿')
    await laterInput.press('Meta+Enter')
    const card = page.locator('.pending-submission')
    await card.getByText('未确认送达').waitFor()
    expect((await card.locator('.pending-submission-reason').textContent())?.trim()).not.toBe('')
    await card.getByRole('button', { name: '放弃这次提交', exact: true }).click()
    await card.waitFor({ state: 'detached' })
    await expect.poll(() => laterInput.inputValue()).toBe('保留这份草稿')
    expect((await owner.json<AppSnapshot>('snapshot')).agentChats?.[another.id]).toEqual({ state: 'empty' })

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
    await narrow.getByRole('list', { name: '我的 Agent', exact: true }).locator(`[data-agent-id="${agent.id}"]`).waitFor()
    await settled(narrow)
    await noHorizontalOverflow(narrow)
    await narrow.screenshot({ path: `${OUT}/list-390-dark.png` })
    await narrow.getByRole('list', { name: '我的 Agent', exact: true }).locator(`[data-agent-id="${agent.id}"]`).click()
    const phoneWho = narrow.locator('.topbar').getByRole('button', { name: '资料助手 的资料', exact: true })
    await phoneWho.waitFor()
    await noHorizontalOverflow(narrow)
    await narrow.screenshot({ path: `${OUT}/topic-390-dark.png`, animations: 'disabled' })
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
    const pickerDone = narrow.getByRole('dialog', { name: '头像', exact: true }).getByRole('button', { name: '关闭', exact: true })
    await pickerDone.click()
    await pickerDone.waitFor({ state: 'hidden' })
    await sheet.getByRole('banner').getByRole('button', { name: '关闭', exact: true }).click()
    await sheet.waitFor({ state: 'hidden' })
    await narrow.reload()
    await connected(narrow)
    await phoneWho.click()
    await expect.poll(() => sheet.locator('.agent-head-avatar .agent-avatar path').nth(2).getAttribute('d')).toContain('Q16.9 19.4')
    await sheet.getByRole('banner').getByRole('button', { name: '关闭', exact: true }).click()
    await sheet.waitFor({ state: 'hidden' })
    await narrow.getByRole('button', { name: '返回', exact: true }).first().click()
    // Back from the pushed topic to the root page, the roster, where its row opens it again.
    await narrow.getByRole('list', { name: '我的 Agent', exact: true }).locator(`[data-agent-id="${agent.id}"]`).waitFor()
    await expect.poll(() => narrow.locator('.app-shell').getAttribute('data-entry')).toBe('agents')
    await phone.close()

    // A device without the full data scope is told it cannot see Agents, not shown an empty list.
    const scoped = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const limited = await scoped.newPage()
    await enrollBrowser(limited, host, { name: `工作范围 ${randomUUID().slice(0, 4)}` })
    await place(limited, '我的 Agent').click()
    await limited.locator('.agents-home').getByText('这台设备看不到 Agent').waitFor()
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
    await agentsNav(page).getByRole('button', { name: '随手助手', exact: true }).click()
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

it('keeps the Agent, the topic and what was typed through a layout change, and pushes a topic over the roster on a phone', async () => {
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
      body: { requestId: randomUUID(), name: '晨报', harnessId: 'fake-agent', mode: 'agent', instructions: '', skills: [] },
    })
    await mkdir(OUT, { recursive: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await fullScopeBrowser(page, host, owner, '名册与队列')
    await place(page, '我的 Agent').click()
    // The space's own 总览 is where the place opens; the roster stands beside it.
    await expect.poll(() => page.locator('.agents-page').getAttribute('data-view')).toBe('home')
    await agentsNav(page)
      .getByRole('button', { name: /^晨报/u })
      .click()
    const input = page.getByRole('textbox', { name: '给晨报发消息', exact: true })
    await input.fill('整理一下今天的事')
    await input.press('Meta+Enter')
    const topics = async () => (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.agent?.customAgentId === agent.id)
    await expect.poll(async () => (await topics()).length, { timeout: 15_000 }).toBe(1)
    const [topic] = await topics()
    const current = page.locator(`[data-agent-id="${agent.id}"][aria-current="page"]`).filter({ visible: true })
    await expect.poll(() => current.count()).toBe(1)
    await page.locator('.topbar .agent-frame').waitFor()
    // 侧栏: the roster, the topic on its Agent's tree, and the switcher named by the topic.
    expect(await agentsNav(page).getAttribute('data-people')).toBe('roster')
    expect(await agentsNav(page).locator('.agent-tree').count()).toBe(0)
    // The open topic's own input (the new topic's is gone with its page).
    const draft = page.locator('main.workspace textarea:visible').first()
    await draft.fill('写到一半的话')
    await page.screenshot({ path: `${OUT}/layout-roster-1440.png` })

    // 我的 Agent's own 总览 from the sidebar; the helper's row there, with what it last worked on, leads back to the same
    // topic and the same words.
    await page.getByRole('button', { name: '总览', exact: true }).filter({ visible: true }).first().click()
    await expect.poll(() => page.locator('.agents-page').getAttribute('data-view')).toBe('home')
    const helper = page.getByRole('navigation', { name: '全部 Agent', exact: true }).getByRole('button', { name: /^晨报/u })
    expect(await helper.locator('.space-agent-line').textContent()).toBe(topic!.title)
    await helper.click()
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-entry')).toBe('sessions')
    await expect.poll(() => current.count()).toBe(1)
    expect(await draft.inputValue()).toBe('写到一半的话')
    await context.close()

    // A phone: the roster is the root page; a topic is pushed over it and the way back returns to the roster.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
    const narrow = await phone.newPage()
    narrow.setDefaultTimeout(15_000)
    await fullScopeBrowser(narrow, host, owner, '名册 390')
    await narrow.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的 Agent', exact: true }).click()
    const row = narrow.getByRole('list', { name: '我的 Agent', exact: true }).getByRole('button', { name: /^晨报/u })
    await row.waitFor()
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await noHorizontalOverflow(narrow)
    await narrow.screenshot({ path: `${OUT}/roster-390.png` })
    await row.click()
    await narrow.locator('.topbar').getByRole('button', { name: '晨报 的资料', exact: true }).waitFor()
    await expect.poll(() => narrow.locator('.app-shell').getAttribute('data-entry')).toBe('sessions')
    await narrow.getByRole('button', { name: '返回', exact: true }).first().click()
    await expect.poll(() => narrow.locator('.app-shell').getAttribute('data-entry')).toBe('agents')
    await row.waitFor()
    // 全部话题 is pushed the same way, and comes back to the roster.
    await narrow.getByRole('button', { name: '全部话题', exact: true }).click()
    await narrow.getByRole('region', { name: '全部话题', exact: true }).locator(`[data-task-id="${topic!.id}"]`).waitFor()
    await narrow.getByRole('region', { name: '全部话题', exact: true }).getByRole('button', { name: '返回', exact: true }).click()
    await row.waitFor()
    await phone.close()
  } finally {
    await browser.close()
    await host.close()
  }
})

it('decides a topic’s approval from the space’s 总览, raises the toast only where no card shows, and hides a covered card', async () => {
  // A local model that asks to write a file whenever it is told to note something, and otherwise answers.
  const approving: HarnessPlugin = {
    id: 'agents-approving',
    name: 'Agents approving fixture',
    version: '1',
    description: '',
    activate(context) {
      context.registerProvider({
        id: 'agents-approving',
        name: 'Agents approving fixture',
        model: 'fixture',
        async *stream({ messages }) {
          const prompt = String(messages.findLast(message => message.role === 'user')?.content ?? '')
          if (prompt.includes('记下来') && messages.at(-1)?.role !== 'tool') {
            yield {
              type: 'tool-call',
              call: {
                id: randomUUID(),
                name: 'write_file',
                arguments: { path: `notes/${randomUUID().slice(0, 6)}.md`, content: '# 记下\n' },
              },
            }
            yield { type: 'finish', reason: 'tool-calls' }
            return
          }
          yield { type: 'text', text: '已收到。' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({ demo: false, plugins: [approving], providerId: 'agents-approving' })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const model = { providerId: 'agents-approving', model: 'fixture' }
    const agent = await owner.json<{ id: string }>('custom-agents', {
      method: 'POST',
      body: { requestId: randomUUID(), name: '小满', harnessId: 'standard', mode: 'agent', instructions: '', skills: [] },
    })
    const start = async (prompt: string, status: string, customAgentId?: string): Promise<string> => {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { requestId: randomUUID(), prompt, mode: 'agent', model, ...(customAgentId ? { customAgentId } : {}) },
      })
      await expect
        .poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.id === sessionId)?.status, {
          timeout: 15_000,
        })
        .toBe(status)
      return sessionId
    }
    const approvalOf = async (sessionId: string) =>
      (await owner.json<AppSnapshot>('snapshot')).approvals.find(approval => approval.sessionId === sessionId)!.id
    // A Code session that waits for an approval, opened so that its card is the conversation's.
    const code = await start('把这件事记下来', 'waiting-approval')
    const codeApproval = await approvalOf(code)
    await mkdir(OUT, { recursive: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await fullScopeBrowser(page, host, owner, '总览里的审批')
    await page.locator(`#session-navigation [data-task-id="${code}"]`).click()
    const covered = page.locator(`main.workspace [data-approval-id="${codeApproval}"]`)
    await covered.waitFor()

    // (c) From 我的 Agent the Code conversation is covered: its protected card is inert and cannot be seen through the page.
    await place(page, '我的 Agent').click()
    await expect.poll(() => page.locator('.agents-page').getAttribute('data-view')).toBe('home')
    const hidden = () =>
      covered.evaluate(card => {
        let lowest = 1
        for (let node: Element | null = card; node; node = node.parentElement)
          lowest = Math.min(lowest, Number(getComputedStyle(node).opacity))
        return { inert: card.closest('[inert]') !== null, opacity: lowest }
      })
    await expect.poll(hidden).toEqual({ inert: true, opacity: 0 })
    // The covered Code card is nowhere on the 总览 of 我的 Agent.
    expect(await page.locator('.agents-page').locator(`[data-approval-id="${codeApproval}"]`).count()).toBe(0)

    // (a), (b) A topic asks: its card is on the 总览 with the same approval, so no toast says it a second time there.
    const waiting = await start('把今天的事记下来', 'waiting-approval', agent.id)
    const approval = await approvalOf(waiting)
    const home = page.locator('.agents-home')
    const card = home.locator(`[data-approval-id="${approval}"]`)
    await card.waitFor()
    expect(await home.getByRole('region', { name: '等你处理', exact: true }).innerText()).toContain('小满')
    await page.waitForTimeout(1_000)
    const toast = page.locator('.toast').filter({ hasText: '另一个话题等你处理' })
    expect(await toast.count()).toBe(0)
    expect(await hidden()).toEqual({ inert: true, opacity: 0 })
    await page.screenshot({ path: `${OUT}/home-approval-1440.png` })
    // In Code no card shows it, so the toast does.
    await place(page, 'Code').click()
    await toast.waitFor()
    await place(page, '我的 Agent').click()
    const overview = () => page.getByRole('button', { name: '总览', exact: true }).filter({ visible: true }).first().click()
    await overview()
    await card.waitFor()

    // The Agent row keeps its canonical chat while the approval is pending.
    await agentRow(page, agent.id).click()
    await expect.poll(() => page.locator('.app-shell').getAttribute('data-entry')).toBe('sessions')
    await page.locator(`main.workspace [data-approval-id="${approval}"]`).waitFor()
    expect(await page.locator(`main.workspace [data-approval-id="${codeApproval}"]`).count()).toBe(0)

    // (a) Deciding on the 总览 is the same request: the Host settles that approval and the card leaves.
    await overview()
    await card.waitFor()
    const allow = card.getByRole('button', { name: '允许', exact: true })
    await expect.poll(() => allow.isDisabled()).toBe(false)
    const decided = page.waitForRequest(
      request => request.method() === 'POST' && new URL(request.url()).pathname.includes(`/approvals/${approval}`),
    )
    await allow.click()
    await decided
    await expect
      .poll(async () => (await owner.json<AppSnapshot>('snapshot')).approvals.some(item => item.id === approval), { timeout: 15_000 })
      .toBe(false)
    await card.waitFor({ state: 'detached' })
    // The Code session's own approval was never touched from here.
    expect((await owner.json<AppSnapshot>('snapshot')).approvals.some(item => item.id === codeApproval)).toBe(true)
    await context.close()
  } finally {
    await browser.close()
    await host.close()
  }
})

it('opens the Agent row actions by keyboard and retries a lost deletion response after navigation and scope changes', async () => {
  await mkdir(OUT, { recursive: true })
  const host = await startTestHost({ plugins: [fixture] })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '行操作夹具',
        description: '',
        harnessId: 'standard',
        mode: 'agent',
        model: { providerId: 'agents-fixture', model: 'fixture' },
      },
    })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { customAgentId: agent.id, prompt: '原聊天永久保留', requestId: randomUUID() },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    const page = await context.newPage()
    const deviceId = await fullScopeBrowser(page, host, owner, 'Agent 行操作')
    await place(page, '我的 Agent').click()
    const more = (name: string) =>
      agentsNav(page)
        .getByRole('button', { name: `更多操作：${name}`, exact: true })
        .filter({ visible: true })
    await more('通用').focus()
    await page.keyboard.press('Enter')
    const general = page.getByRole('menu', { name: '通用 的操作' })
    await general.getByRole('menuitem', { name: '设置' }).waitFor()
    expect(await general.getByRole('menuitem', { name: '删除 Agent' }).count()).toBe(0)
    await page.keyboard.press('Escape')

    const writes: string[] = []
    const previous = (await owner.json<AppSnapshot>('snapshot')).customAgents!.find(row => row.id === agent.id)!
    let holdOldList = true
    await page.route('**/link/api/snapshot', async route => {
      const response = await route.fetch()
      if (holdOldList && response.ok()) {
        const snapshot = (await response.json()) as AppSnapshot
        if (snapshot.customAgents?.every(row => row.id !== agent.id)) {
          await route.fulfill({ response, json: { ...snapshot, customAgents: [...snapshot.customAgents, previous] } })
          return
        }
      }
      await route.fulfill({ response })
    })
    await page.route(`**/link/api/custom-agents/${agent.id}`, async route => {
      if (route.request().method() !== 'DELETE') return route.continue()
      writes.push(String(route.request().postDataJSON().requestId))
      if (writes.length === 2) holdOldList = false
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      await route.abort('failed')
    })
    await more(agent.name).focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: `${agent.name} 的操作` })
    await menu.getByRole('menuitem', { name: '删除 Agent' }).waitFor()
    await page.screenshot({ path: `${OUT}/agent-menu-1440.png`, animations: 'disabled' })
    await menu.getByRole('menuitem', { name: '删除 Agent' }).click()
    const confirm = page.getByRole('dialog', { name: `删除「${agent.name}」？` })
    await confirm.getByText('它的记忆会删除，聊天记录和文件夹会保留。').waitFor()
    await page.screenshot({ path: `${OUT}/agent-delete-1440.png` })
    await confirm.getByRole('button', { name: '取消', exact: true }).click()
    await confirm.waitFor({ state: 'hidden' })
    expect(writes).toEqual([])
    await more(agent.name).click()
    await menu.getByRole('menuitem', { name: '删除 Agent' }).click()
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    await confirm.getByRole('button', { name: '重试同一请求', exact: true }).waitFor()
    await confirm.getByRole('button', { name: '取消', exact: true }).click()
    await confirm.waitFor({ state: 'hidden' })
    await place(page, 'Code').click()
    await agentsNav(page).waitFor({ state: 'hidden' })
    await place(page, '我的 Agent').click()
    const retry = agentsNav(page).getByRole('button', { name: '重试同一请求', exact: true }).filter({ visible: true })
    await retry.waitFor({ timeout: 6000 })
    const abandon = agentsNav(page).getByRole('button', { name: '放弃等待', exact: true }).filter({ visible: true })
    await abandon.waitFor()
    expect((await owner.confirmed(`devices/${deviceId}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
    await agentsNav(page).getByText('这台设备看不到 Agent', { exact: true }).first().waitFor()
    await retry.waitFor({ state: 'hidden' })
    await abandon.waitFor({ state: 'hidden' })
    expect((await owner.confirmed(`devices/${deviceId}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    await retry.click()
    await more(agent.name).waitFor({ state: 'hidden' })
    await retry.waitFor({ state: 'hidden' })
    expect(writes).toHaveLength(2)
    expect(writes[1]).toBe(writes[0])
    expect((await owner.json<CustomAgentList>('custom-agents')).agents.find(item => item.id === agent.id)).toBeUndefined()
    expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.find(message => message.role === 'user')?.text).toBe(
      '原聊天永久保留',
    )
  } finally {
    await context.close()
    await browser.close()
    await host.close()
  }
})

it('keeps the second device’s first-message draft and explicitly opens the shared chat', async () => {
  await mkdir(OUT, { recursive: true })
  const host = await startTestHost({ plugins: [fixture] })
  const browser = await chromium.launch(browserLaunchOptions())
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true })
  let proceed = () => {}
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '接续夹具',
        description: '在同一聊天里接续',
        harnessId: 'standard',
        mode: 'agent',
        model: { providerId: 'agents-fixture', model: 'fixture' },
      },
    })
    const first = await desktop.newPage()
    const second = await phone.newPage()
    await fullScopeBrowser(first, host, owner, '首发设备')
    await fullScopeBrowser(second, host, owner, '草稿保留设备')
    await place(first, '我的 Agent').click()
    await second.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的 Agent', exact: true }).click()
    const row = (page: Page) => page.locator(`[data-agent-id="${agent.id}"]`).filter({ visible: true })
    await row(first).click()
    await row(second).click()
    const input = (page: Page) => page.getByRole('textbox', { name: '给接续夹具发消息', exact: true }).filter({ visible: true })
    await input(second).fill('手机的未送出草稿')
    const blocked = new Promise<void>(resolve => {
      proceed = resolve
    })
    let seen = () => {}
    const ready = new Promise<void>(resolve => {
      seen = resolve
    })
    await second.route('**/link/api/tasks', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      seen()
      await blocked
      await route.continue()
    })
    await second.getByRole('button', { name: '发送', exact: true }).filter({ visible: true }).click()
    await ready
    await input(first).fill('桌面的唯一首条消息')
    await input(first).press('Meta+Enter')
    const state = async () => (await owner.json<AppSnapshot>('snapshot')).agentChats?.[agent.id]
    await expect.poll(async () => (await state())?.state).toBe('ready')
    const confirmed = await state()
    if (confirmed?.state !== 'ready') throw new Error('No confirmed chat')
    proceed()
    const continueChat = second.getByRole('button', { name: '带上草稿打开聊天', exact: true })
    await continueChat.waitFor()
    expect(await input(second).inputValue()).toBe('手机的未送出草稿')
    await noHorizontalOverflow(second)
    await second.screenshot({ path: `${OUT}/second-first-draft-390-dark.png`, animations: 'disabled' })
    await continueChat.click()
    await second.locator('.transcript-shell').getByText('桌面的唯一首条消息', { exact: true }).waitFor()
    const continued = second.getByRole('textbox', { name: '继续对话', exact: true }).filter({ visible: true })
    await expect.poll(() => continued.inputValue()).toBe('手机的未送出草稿')
    const detail = await owner.json<TaskDetail>(`tasks/${confirmed.sessionId}`)
    expect(detail.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['桌面的唯一首条消息'])
    const tasks = (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.agent?.customAgentId === agent.id)
    expect(tasks.map(task => task.id)).toEqual([confirmed.sessionId])
    await second.screenshot({ path: `${OUT}/shared-chat-draft-390-dark.png`, animations: 'disabled' })
  } finally {
    proceed()
    await desktop.close()
    await phone.close()
    await browser.close()
    await host.close()
  }
})
