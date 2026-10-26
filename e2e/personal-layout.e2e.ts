import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PersonalAssistant, PersonalGroup, PersonalGroupDetail, PersonalOverview, PersonalRoutine, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ModelMessage } from '@latch/sdk'
import type { TestDevice } from '@latch/testkit'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { backToPhoneSessions, noHorizontalOverflow, reachable } from './helpers/layout.ts'

const OUTPUT = 'test-results/personal-workflows'
const SHARED_REPLY =
  '已经整理好三项下一步。\n第一项：确认目标与负责人。\n第二项：检查执行记录和待解决的问题。\n第三项：在群聊中继续讨论，再决定是否执行。'
const PRIVATE_MEMORY = 'Only this assistant may read the private layout-test memory.'

async function capture(page: Page, name: string): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
  })
  await page.mouse.move(0, 0)
  await page.screenshot({ path: `${OUTPUT}/${name}.png`, animations: 'disabled', caret: 'hide' })
}

describe('personal group and routine layout with real child-session navigation', () => {
  let host: TestHost, browser: Browser, owner: TestDevice, members: PersonalAssistant[]
  const modelCalls: ModelMessage[][] = []
  beforeAll(async () => {
    const plugin: HarnessPlugin = {
      id: 'personal-layout-model',
      name: 'Layout fixture model',
      version: '1',
      description: '',
      activate(context) {
        context.registerProvider({
          id: 'personal-layout-model',
          name: 'Layout fixture model',
          model: 'fixture',
          async *stream({ messages }) {
            modelCalls.push(structuredClone(messages))
            yield { type: 'text', text: SHARED_REPLY }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    host = await startTestHost({
      plugins: [plugin],
      hostName: '个人助手布局测试',
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
    })
    owner = await host.enroll({ listener: 'unix', name: '布局测试电脑' })
    members = []
    for (const name of ['规划助手', '复核助手']) {
      const assistant = await owner.json<PersonalAssistant>('personal/assistants', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name,
          role: 'PRIVATE MEMBER ROLE: ' + name,
          harnessId: 'standard',
          mode: 'chat',
          pluginIds: [],
          model: { providerId: 'personal-layout-model', model: 'fixture' },
        },
      })
      members.push(assistant)
      await owner.json(`personal/assistants/${assistant.id}/memories`, {
        method: 'POST',
        body: { requestId: randomUUID(), content: PRIVATE_MEMORY },
      })
    }
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
  })

  it.each([
    [390, 'light'],
    [900, 'dark'],
    [1440, 'light'],
    [1440, 'dark'],
  ] as const)(
    '%s %s preserves the original group draft across its read-only execution record and permits remote routine pause',
    async (width, theme) => {
      const suffix = `${width}-${theme}`
      const group = await owner.json<PersonalGroup>('personal/groups', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name: '跨设备协作与执行复核 ' + suffix,
          instructions: 'Share only this group conversation and explicit group instructions.',
          memberIds: members.map(member => member.id),
          defaultAssistantId: members[0]!.id,
          maxRelays: 1,
        },
      })
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 960 },
        colorScheme: theme,
        hasTouch: width <= 900,
        isMobile: width <= 900,
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezoneId: 'UTC',
      })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      const requests: Array<{ path: string; body: unknown }> = []
      page.on('request', request => {
        const path = new URL(request.url()).pathname
        if (
          request.method() === 'POST'
          && (/^\/link\/api\/tasks(?:\/[^/]+\/prompt)?$/u.test(path) || /^\/link\/api\/personal\/groups\/[^/]+\/messages$/u.test(path))
        )
          requests.push({ path, body: request.postDataJSON() })
      })
      const prompt = '请一起梳理目标、执行顺序和需要复核的地方。'
      const draft = '这是一条尚未发送的群聊草稿。\n保留原群聊与成员顺序，不要自动开始新的执行。 ' + suffix
      const privateDraft = '尚未保存的私人例行任务草稿 ' + suffix
      const readGroup = () => owner.json<PersonalGroupDetail>(`personal/groups/${group.id}`)
      try {
        const deviceName = '群聊布局 ' + suffix
        await enrollBrowser(page, host, { name: deviceName, scopes: ['view', 'run'] })
        const deviceId = host.host.security.devices.list().find(device => device.name === deviceName)!.id
        expect((await owner.confirmed(`devices/${deviceId}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
        await page.reload()
        await connected(page)
        await backToPhoneSessions(page)
        const personalButton = page.getByRole('button', { name: '个人助手', exact: true }).filter({ visible: true }).first()
        await reachable(personalButton)
        await personalButton.click()
        const personal = page.getByRole('dialog', { name: '个人助手', exact: true })
        const groupTab = personal.getByRole('tab', { name: '群聊', exact: true })
        await reachable(groupTab)
        await groupTab.click()
        await reachable(personal.getByRole('button').filter({ hasText: group.name }))
        await personal.getByRole('button').filter({ hasText: group.name }).click()
        await personal.getByRole('heading', { name: group.name, exact: true }).waitFor()
        const input = personal.getByRole('textbox', { name: '群聊消息', exact: true })
        await reachable(input)
        await input.fill(prompt)
        const send = personal.getByRole('button', { name: '发送到群聊', exact: true })
        await reachable(send)
        const callsBefore = modelCalls.length
        await send.click()
        await vi.waitFor(async () => expect((await readGroup()).turn?.state).toBe('completed'))
        await personal.getByText('本轮已完成', { exact: true }).waitFor()
        const shared = personal.getByRole('region', { name: '群聊共享记录', exact: true })
        await shared.getByText(SHARED_REPLY, { exact: true }).waitFor()
        expect(modelCalls.length).toBe(callsBefore + 1)
        expect(modelCalls.slice(callsBefore).some(messages => JSON.stringify(messages).includes(PRIVATE_MEMORY))).toBe(false)
        await noHorizontalOverflow(page, personal.locator('.personal-content'))
        await shared.scrollIntoViewIfNeeded()
        await capture(page, 'group-history-' + suffix)

        await input.fill(draft)
        await personal.getByRole('checkbox', { name: '复核助手', exact: true }).check()
        await noHorizontalOverflow(page, personal.locator('.personal-content'))
        await reachable(send)
        await capture(page, 'group-draft-' + suffix)
        const settled = await readGroup()
        const child = settled.sessions.find(session => session.personal?.groupId === group.id)!
        expect(child).toBeDefined()
        expect(settled.messages.filter(message => message.role === 'user')).toHaveLength(1)
        expect(requests).toHaveLength(1)
        const requestCount = requests.length
        const messageIds = settled.messages.map(message => message.id)
        const record = shared.getByRole('button', { name: '完整会话', exact: true }).first()
        await reachable(record)
        await record.click()
        await personal.waitFor({ state: 'hidden' })
        const workspace = page.locator('main.workspace')
        const readOnlyComposer = workspace.locator('.composer[data-variant="read-only"]')
        await readOnlyComposer.waitFor()
        await readOnlyComposer.getByRole('note').getByText('这是群聊中的执行记录，请回到个人助手群聊继续。', { exact: true }).waitFor()
        expect(await readOnlyComposer.getByRole('textbox').count()).toBe(0)
        expect(await readOnlyComposer.getByRole('button', { name: '发送', exact: true }).count()).toBe(0)
        await workspace.locator('.transcript').getByText(SHARED_REPLY, { exact: true }).waitFor()
        const childDetail = await owner.json<TaskDetail>(`tasks/${child.id}`)
        expect(childDetail.summary.personal?.groupId).toBe(group.id)
        const back = workspace.getByRole('button', { name: '回到群聊', exact: true })
        await reachable(back)
        await noHorizontalOverflow(page, readOnlyComposer)
        await capture(page, 'group-child-read-only-' + suffix)
        const originalRead = page.waitForResponse(
          response =>
            new URL(response.url()).pathname === `/link/api/personal/groups/${group.id}`
            && response.request().method() === 'GET'
            && response.ok(),
        )
        await back.click()
        expect(((await (await originalRead).json()) as PersonalGroupDetail).group.id).toBe(group.id)
        await personal.getByRole('heading', { name: group.name, exact: true }).waitFor()
        await vi.waitFor(async () => expect(await input.inputValue()).toBe(draft))
        expect(await personal.getByRole('checkbox', { name: '复核助手 · 第 1 位', exact: true }).isChecked()).toBe(true)
        await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
        expect(requests).toHaveLength(requestCount)
        expect(modelCalls.length).toBe(callsBefore + 1)
        expect((await readGroup()).messages.map(message => message.id)).toEqual(messageIds)
        await reachable(input)
        await noHorizontalOverflow(page, personal.locator('.personal-content'))
        await capture(page, 'group-returned-draft-' + suffix)

        const routineTab = personal.getByRole('tab', { name: '例行任务', exact: true })
        await reachable(routineTab)
        await routineTab.click()
        const create = personal.getByRole('button', { name: '创建例行任务', exact: true })
        await reachable(create)
        const confirmations = host.presence.requests.length
        await create.click()
        const editor = page.getByRole('dialog', { name: '例行任务设置', exact: true })
        const routineName = '每日整理与下一步检查 ' + suffix
        await editor.getByRole('textbox', { name: '任务名称', exact: true }).fill(routineName)
        const assistant = editor.getByRole('button', { name: /^执行助手/u })
        await reachable(assistant)
        await assistant.click()
        await page.getByText(members[0]!.name, { exact: true }).last().click()
        await editor.getByRole('textbox', { name: '任务内容', exact: true }).fill('整理当天的明确事项，不自动发送到其他服务。')
        const future = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(11, 16)
        await editor.getByLabel('每日时间', { exact: true }).fill(future)
        await editor.getByRole('textbox', { name: '时区', exact: true }).fill('UTC')
        for (const field of ['任务名称', '任务内容', '时区']) await reachable(editor.getByRole('textbox', { name: field, exact: true }))
        await noHorizontalOverflow(page, editor)
        const save = editor.getByRole('button', { name: '保存任务', exact: true })
        await reachable(save)
        await capture(page, 'routine-editor-' + suffix)
        await save.click()
        await editor.waitFor({ state: 'hidden' })
        await personal.getByRole('heading', { name: routineName, exact: true }).waitFor()
        let routine = (await owner.json<PersonalOverview>('personal')).routines.find(item => item.name === routineName)!
        expect(routine.enabled).toBe(false)
        expect(routine.state).toBe('disabled')
        expect(await personal.getByRole('button', { name: /^(开启每日执行|重新开启)$/u }).count()).toBe(0)
        await personal.getByText('开启例行任务：此操作只能在运行 Latch 的电脑上用 Latch 桌面端进行。', { exact: true }).waitFor()
        await noHorizontalOverflow(page, personal.locator('.personal-content'))
        await capture(page, 'routine-disabled-' + suffix)
        const refused = await page.evaluate(
          async ({ id, revision, requestId }) => {
            const response = await fetch(`/link/api/personal/routines/${id}/enabled`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ requestId, baseRevision: revision, enabled: true }),
            })
            return { status: response.status, error: ((await response.json()) as { error?: string }).error }
          },
          { id: routine.id, revision: routine.revision, requestId: randomUUID() },
        )
        expect(refused).toEqual({ status: 403, error: 'local-only' })
        routine = await owner.json<PersonalRoutine>(`personal/routines/${routine.id}/enabled`, {
          method: 'POST',
          body: { requestId: randomUUID(), baseRevision: routine.revision, enabled: true },
        })
        expect(routine.enabled).toBe(true)
        expect(Date.parse(routine.nextRunAt!)).toBeGreaterThan(Date.now() + 6 * 60 * 60 * 1000)
        const pause = personal.getByRole('button', { name: '暂停以后执行', exact: true })
        await reachable(pause)
        await capture(page, 'routine-enabled-' + suffix)
        await pause.click()
        await vi.waitFor(async () => expect((await owner.json<PersonalRoutine>(`personal/routines/${routine.id}`)).enabled).toBe(false))
        await personal.getByText('未开启', { exact: true }).waitFor()
        expect(host.presence.requests.length).toBe(confirmations)
        expect(modelCalls.length).toBe(callsBefore + 1)
        expect(requests).toHaveLength(requestCount)
        await noHorizontalOverflow(page, personal.locator('.personal-content'))
        await capture(page, 'routine-paused-' + suffix)

        const edit = personal.getByRole('button', { name: '编辑任务', exact: true })
        await reachable(edit)
        await edit.click()
        await editor.getByRole('textbox', { name: '任务内容', exact: true }).fill(privateDraft)
        expect((await owner.confirmed(`devices/${deviceId}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
        await vi.waitFor(async () => expect(await page.getByRole('textbox', { name: '任务内容', exact: true }).count()).toBe(0))
        expect(await page.getByText(privateDraft, { exact: true }).count()).toBe(0)
        expect(await page.getByText(PRIVATE_MEMORY, { exact: true }).count()).toBe(0)
        expect(await page.evaluate(async () => (await fetch('/link/api/personal')).status)).toBe(403)
        expect(
          await page.evaluate(
            needles =>
              [localStorage, sessionStorage].some(storage =>
                Object.values(storage).some(value => needles.some(needle => String(value).includes(needle))),
              ),
            [draft, privateDraft, PRIVATE_MEMORY],
          ),
        ).toBe(false)
        await noHorizontalOverflow(page)
        await capture(page, 'private-access-withdrawn-' + suffix)
      } finally {
        await context.close()
      }
    },
  )
})
