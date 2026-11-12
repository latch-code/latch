import { chromium, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AppSnapshot, AutomationDetail, AutomationList, CustomAgentList, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

const OUT = 'test-results/agent-schedules'

/** A browser with the full data scope, which Agents need; `scopes` narrows what it may do. */
async function agentBrowser(page: Page, host: TestHost, owner: TestDevice, name: string, scopes?: string[]) {
  await enrollBrowser(page, host, { name })
  const id = host.host.security.devices.list().find(device => device.name === name)!.id
  const body = { dataScope: 'all', ...(scopes ? { scopes } : {}) }
  expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body })).status).toBe(200)
  await page.reload()
  await connected(page)
}

const settled = (page: Page) =>
  page
    .locator('.agents-page')
    .evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined))))

const choice = (page: Page, name: RegExp) => page.getByRole('menuitemradio', { name }).or(page.getByRole('radio', { name })).first()
const pad = (value: number) => String(value).padStart(2, '0')

async function openAgent(page: Page, tab: '委托' | '定时') {
  const place = page.getByRole('radio', { name: '我的 Agent', exact: true }).first()
  await place.click()
  await expect.poll(() => place.getAttribute('aria-checked')).toBe('true')
  // The list stands where the sidebar stands: on 我的 Agent's page, or beside one of its sessions.
  const where = (await page.locator('.agents-page').count()) > 0 ? page.locator('.agents-page') : page.locator('#session-navigation')
  await where
    .getByRole('navigation', { name: '我的 Agent', exact: true })
    .getByRole('region', { name: 'Agent', exact: true })
    .getByRole('button', { name: /资料助手/u })
    .click()
  await page.getByRole('tab', { name: tab, exact: true }).click()
}

it('creates, runs, pauses and resumes a schedule, shows a missed time, and carries an earlier result into a new delegation', async () => {
  await mkdir(OUT, { recursive: true })
  // The Host's clock, moved forward to pass a scheduled time while the Host is "asleep".
  let shift = 0
  const host = await startTestHost({ now: () => Date.now() + shift })
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
    await owner.json('custom-agents', {
      method: 'POST',
      body: { requestId: randomUUID(), name: '资料助手', description: '查资料', harnessId: 'fake-agent', defaultProjectId: project.id },
    })
    const agent = (await owner.json<CustomAgentList>('custom-agents')).agents[0]!
    const automations = async () => (await owner.json<AutomationList>('automations')).automations
    const detailOf = (id: string) => owner.json<AutomationDetail>(`automations/${id}`)

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await agentBrowser(page, host, owner, '定时 1440')
    await openAgent(page, '定时')
    await page.getByText('没有定时任务').waitFor()
    await page.screenshot({ path: `${OUT}/empty-1440.png` })

    // 新建: the work location is chosen by hand before it can be saved.
    await page.getByRole('button', { name: '新建定时', exact: true }).click()
    const form = page.getByRole('form', { name: '新建定时任务' })
    const at = new Date(Date.now() + 5 * 60_000)
    const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
    await form.getByLabel('名称').fill('汇率周报')
    await form.getByLabel('几点').fill(time)
    await form.getByLabel('每次的输入').fill('整理本周汇率')
    // The Agent's default project is filled in, shown and changeable; saving is the choice.
    await form.getByRole('button', { name: /^项目.*notes/u }).waitFor()
    await form.getByRole('button', { name: /^项目/u }).click()
    await choice(page, /notes/u).click()
    await page.screenshot({ path: `${OUT}/form-1440.png` })
    await form.getByRole('button', { name: '创建', exact: true }).click()
    await expect.poll(async () => (await automations()).length).toBe(1)
    const [saved] = await automations()
    expect(saved).toMatchObject({
      name: '汇率周报',
      customAgentId: agent.id,
      projectId: project.id,
      schedule: { kind: 'daily', time },
      enabled: true,
      state: 'ready',
    })
    const card = page.getByRole('listitem', { name: '汇率周报' })
    await card.getByText('已开启').waitFor()
    await card.getByText('整理本周汇率').waitFor()
    await card.getByText(/下次 /u).waitFor()

    // 立即运行 starts a session, listed in the run record, which opens the conversation.
    const sent: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/run')) sent.push(request.postDataJSON().requestId)
    })
    await card.getByRole('button', { name: '立即运行', exact: true }).click()
    await expect.poll(async () => (await detailOf(saved!.id)).runs[0]?.state, { timeout: 20_000 }).toBe('completed')
    expect(sent).toHaveLength(1)
    const ran = (await detailOf(saved!.id)).runs[0]!
    expect(ran).toMatchObject({ trigger: 'manual', state: 'completed' })
    const runRow = card.getByRole('button', { name: /立即运行|完成，打开会话/u }).last()
    await card.getByRole('button', { name: /完成，打开会话/u }).waitFor()
    await page.screenshot({ path: `${OUT}/ran-1440.png` })
    await runRow.click()
    await page.getByText('整理本周汇率').first().waitFor()
    const run = await owner.json<TaskDetail>(`tasks/${ran.sessionId}`)
    expect(run.summary.automationId).toBe(saved!.id)

    // 暂停 and 继续: the Host says it is off, then on again.
    await openAgent(page, '定时')
    // A pause whose answer is lost keeps the request; retrying sends the same requestId.
    const toggles: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/enabled'))
        toggles.push(request.postDataJSON().requestId)
    })
    await page.route('**/link/api/automations/*/enabled', route => route.abort('timedout'), { times: 1 })
    await card.getByRole('button', { name: '暂停', exact: true }).click()
    await card.getByText('结果未知').waitFor()
    await page.screenshot({ path: `${OUT}/unknown-1440.png` })
    await card.getByRole('button', { name: '重试同一请求', exact: true }).click()
    await card.getByText('已关闭').waitFor()
    expect(toggles).toHaveLength(2)
    expect(new Set(toggles).size).toBe(1)
    expect((await automations())[0]).toMatchObject({ enabled: false, state: 'off' })
    await card.getByRole('button', { name: '继续', exact: true }).click()
    await card.getByText('已开启').waitFor()
    const resumed = (await automations())[0]!
    expect(resumed).toMatchObject({ enabled: true, state: 'ready' })

    // The Mac "sleeps" past the time: the Host records a missed time, keeps it on and does not catch it up.
    shift = Date.parse(resumed.nextRunAt!) - Date.now() + 90_000
    await expect.poll(async () => (await detailOf(saved!.id)).runs[0]?.state, { timeout: 10_000 }).toBe('missed')
    await card.getByText('错过 1 次').waitFor()
    await card.getByText('没有运行', { exact: true }).waitFor()
    await card.getByRole('button', { name: '错过的时间' }).click()
    await card
      .getByText(/关机、睡眠或 Latch 没有运行/u)
      .first()
      .waitFor()
    expect((await automations())[0]).toMatchObject({ enabled: true, state: 'ready' })
    expect((await detailOf(saved!.id)).runs.filter(item => item.sessionId)).toHaveLength(1)
    await page.screenshot({ path: `${OUT}/missed-1440.png` })

    // 编辑 changes the time and nothing else.
    await card.getByRole('button', { name: '编辑', exact: true }).click()
    const edit = page.getByRole('form', { name: '编辑定时任务' })
    await edit.getByRole('radio', { name: '工作日' }).click()
    await edit.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(async () => (await automations())[0]?.schedule.kind).toBe('weekdays')
    await card.getByText(new RegExp(`工作日 ${time}`, 'u')).waitFor()

    // 带入上次成果: a delegation's last reply goes into a new delegation's draft as quoted text, in a new session.
    await page.getByRole('tab', { name: '委托', exact: true }).click()
    const input = page.getByRole('textbox', { name: '委托内容', exact: true })
    await input.fill('比较三家汇率接口')
    await input.press('Meta+Enter')
    const delegated = async () =>
      (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.agent?.customAgentId === agent.id && !task.automationId)
    await expect.poll(async () => (await delegated()).length, { timeout: 15_000 }).toBe(1)
    const [first] = await delegated()
    await expect
      .poll(async () => (await owner.json<TaskDetail>(`tasks/${first!.id}`)).messages.some(item => item.role === 'assistant'), {
        timeout: 15_000,
      })
      .toBe(true)
    // The automation's run is among the Agent's sessions, tagged 定时.
    await page
      .getByRole('region', { name: '近期委托' })
      .getByRole('button', { name: /定时\s*汇率周报/u })
      .waitFor()
    await page.locator('.agent-delegate-new').getByText('新会话', { exact: true }).waitFor()
    await page.getByRole('button', { name: '带入上次成果', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '带入上次成果' })
    await dialog.getByRole('checkbox', { name: first!.title }).check()
    await dialog.getByRole('checkbox', { name: '最后的回复' }).waitFor()
    expect(await dialog.getByRole('checkbox', { name: '最后的回复' }).isChecked()).toBe(true)
    await page.screenshot({ path: `${OUT}/carry-1440.png` })
    await dialog.getByRole('button', { name: '带入', exact: true }).click()
    await expect.poll(() => input.inputValue()).toContain(`> 上次成果「${first!.title}」：\n> echo:`)
    await input.press('End')
    await input.pressSequentially('按这个结论写一页摘要')
    await input.press('Meta+Enter')
    await expect.poll(async () => (await delegated()).length, { timeout: 15_000 }).toBe(2)
    const second = (await delegated()).find(task => task.id !== first!.id)!
    const opened = await owner.json<TaskDetail>(`tasks/${second.id}`)
    const prompt = opened.messages.find(item => item.role === 'user')!.text
    expect(prompt).toContain(`上次成果「${first!.title}」：`)
    expect(prompt).toContain('按这个结论写一页摘要')
    // The title skips the quoted block in front of what the person wrote.
    expect(second.title).toBe('按这个结论写一页摘要')
    await context.close()
    // Back to the real time, which a new browser's enrollment is checked against.
    shift = 0

    // A phone: the same tab in the pushed Agent page, the form and the picker fit.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', reducedMotion: 'reduce' })
    const narrow = await phone.newPage()
    narrow.setDefaultTimeout(15_000)
    await agentBrowser(narrow, host, owner, '定时 390')
    await narrow.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的 Agent', exact: true }).click()
    await narrow
      .getByRole('list', { name: '我的 Agent', exact: true })
      .getByRole('button', { name: /资料助手/u })
      .click()
    await narrow.getByRole('tab', { name: '定时', exact: true }).click()
    await narrow.getByRole('listitem', { name: '汇率周报' }).getByText('错过 1 次').waitFor()
    await settled(narrow)
    await noHorizontalOverflow(narrow)
    await narrow.screenshot({ path: `${OUT}/schedules-390-dark.png`, fullPage: true })
    await narrow.getByRole('button', { name: '新建定时', exact: true }).click()
    await narrow.getByRole('form', { name: '新建定时任务' }).waitFor()
    await noHorizontalOverflow(narrow)
    await narrow.screenshot({ path: `${OUT}/form-390-dark.png`, fullPage: true })
    await narrow.getByRole('button', { name: '取消', exact: true }).click()
    await narrow.getByRole('tab', { name: '委托', exact: true }).click()
    await narrow.getByRole('button', { name: '带入上次成果', exact: true }).click()
    const sheet = narrow.getByRole('dialog', { name: '带入上次成果' })
    await sheet.getByRole('checkbox').first().check()
    await sheet.getByRole('checkbox', { name: '最后的回复' }).waitFor()
    await narrow.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))))
    await noHorizontalOverflow(narrow)
    await narrow.screenshot({ path: `${OUT}/carry-390-dark.png` })
    await phone.close()

    // The tab at the other widths and themes: a tablet, the narrowest phone, and a dark desktop.
    for (const [width, height, scheme] of [
      [768, 1024, 'light'],
      [320, 640, 'light'],
      [1440, 900, 'dark'],
    ] as const) {
      const sized = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: 'reduce' })
      const view = await sized.newPage()
      view.setDefaultTimeout(15_000)
      await agentBrowser(view, host, owner, `定时 ${width} ${scheme}`)
      if (width < 768) {
        await view.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的 Agent', exact: true }).click()
        await view
          .getByRole('list', { name: '我的 Agent', exact: true })
          .getByRole('button', { name: /资料助手/u })
          .click()
        await view.getByRole('tab', { name: '定时', exact: true }).click()
      } else {
        // A tablet keeps the sidebar in a drawer.
        if (width < 1024) await view.getByRole('button', { name: '打开会话列表', exact: true }).click()
        await openAgent(view, '定时')
      }
      await view.getByRole('listitem', { name: '汇率周报' }).getByText('错过 1 次').waitFor()
      await view.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))))
      await noHorizontalOverflow(view)
      await view.screenshot({ path: `${OUT}/schedules-${width}-${scheme}.png`, fullPage: true })
      await view.getByRole('tab', { name: '委托', exact: true }).click()
      await view.getByRole('button', { name: '带入上次成果', exact: true }).waitFor()
      await noHorizontalOverflow(view)
      await view.screenshot({ path: `${OUT}/delegate-${width}-${scheme}.png` })
      await sized.close()
    }

    // A device that may only view sees the schedules and why it cannot change them, and no actions.
    const viewing = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const viewer = await viewing.newPage()
    viewer.setDefaultTimeout(15_000)
    await agentBrowser(viewer, host, owner, '只看 1440', ['view'])
    await openAgent(viewer, '定时')
    await viewer.getByRole('listitem', { name: '汇率周报' }).waitFor()
    await viewer.getByText('只能查看', { exact: true }).waitFor()
    expect(await viewer.getByRole('button', { name: '新建定时' }).count()).toBe(0)
    expect(await viewer.getByRole('button', { name: '立即运行' }).count()).toBe(0)
    await viewing.close()
  } finally {
    await browser.close()
    await host.close()
  }
})
