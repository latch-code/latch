import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { openPersonal, openSection } from './helpers/layout.ts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PersonalAssistant, PersonalGroup, PersonalGroupDetail, PersonalOverview, PersonalRoutine } from '@latch/protocol'
import type { HarnessPlugin, ModelMessage } from '@latch/sdk'
import type { TestDevice } from '@latch/testkit'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

describe('real personal group and daily-task workflows', () => {
  let host: TestHost, browser: Browser, owner: TestDevice, members: PersonalAssistant[]
  let stopRequested = false,
    releaseStop!: () => void
  const seen: ModelMessage[][] = []
  beforeAll(async () => {
    const settlement = new Promise<void>(resolve => {
      releaseStop = resolve
    })
    const plugin: HarnessPlugin = {
      id: 'personal-workflow-model',
      name: 'Fixture model',
      version: '1',
      description: '',
      activate(context) {
        context.registerProvider({
          id: 'personal-workflow-model',
          name: 'Fixture model',
          model: 'fixture',
          async *stream({ messages, signal }) {
            seen.push(structuredClone(messages))
            if (messages.at(-1)?.content === 'wait for stop') {
              yield { type: 'text', text: 'Waiting for the actual cancellation' }
              if (!signal.aborted) await new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }))
              stopRequested = true
              await settlement
              throw new DOMException('Fixture stopped', 'AbortError')
            }
            yield { type: 'text', text: 'Visible shared reply' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    host = await startTestHost({ plugins: [plugin], uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web') })
    owner = await host.enroll({ listener: 'unix' })
    members = []
    for (const name of ['成员 A', '成员 B']) {
      const assistant = await owner.json<PersonalAssistant>('personal/assistants', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name,
          role: 'PRIVATE ROLE ' + name,
          harnessId: 'standard',
          mode: 'chat',
          pluginIds: [],
          model: { providerId: 'personal-workflow-model', model: 'fixture' },
        },
      })
      members.push(assistant)
      await owner.json(`personal/assistants/${assistant.id}/memories`, {
        method: 'POST',
        body: { requestId: randomUUID(), content: 'PRIVATE MEMORY NOT SHARED' },
      })
    }
    browser = await chromium.launch(browserLaunchOptions())
  })
  afterAll(async () => {
    releaseStop?.()
    await browser?.close()
    await host?.close()
  })
  async function open(page: Page, name: string) {
    await enrollBrowser(page, host, { name, scopes: ['view', 'run'] })
    const id = host.host.security.devices.list().find(item => item.name === name)!.id
    expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    await page.reload()
    await connected(page)
    return { personal: await openPersonal(page), id }
  }
  it('creates a real group, recovers the exact send and stop requests and waits for execution settlement', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    let interceptionFailed = false
    try {
      const { personal } = await open(page, '群聊浏览器')
      await personal.getByRole('tab', { name: '群聊', exact: true }).click()
      await personal.getByRole('button', { name: '创建群聊', exact: true }).click()
      const editor = page.getByRole('dialog', { name: '群聊设置', exact: true })
      await editor.getByLabel('群聊名称', { exact: true }).fill('真实接力群聊')
      await editor.getByRole('checkbox', { name: '成员 A', exact: true }).check()
      await editor.getByRole('checkbox', { name: '成员 B', exact: true }).check()
      await editor.getByRole('button', { name: /^每轮回复上限/u }).click()
      await page.getByText('最多 2 位回复', { exact: true }).click()
      await editor.getByLabel('共同指令', { exact: true }).fill('Explicit group instructions')
      await editor.getByRole('button', { name: '保存群聊', exact: true }).click()
      await editor.waitFor({ state: 'hidden' })
      await personal.getByRole('heading', { name: '真实接力群聊', exact: true }).waitFor()
      const overview = await owner.json<PersonalOverview>('personal')
      const group: PersonalGroup = overview.groups.find(item => item.name === '真实接力群聊')!
      const sends: unknown[] = [],
        stops: unknown[] = []
      page.on('request', request => {
        if (request.method() !== 'POST') return
        if (request.url().endsWith(`/personal/groups/${group.id}/messages`)) sends.push(request.postDataJSON())
        if (request.url().endsWith(`/personal/groups/${group.id}/cancel`)) stops.push(request.postDataJSON())
      })
      await page.route(
        `**/personal/groups/${group.id}/messages`,
        async route => {
          try {
            await route.fetch()
            await route.abort('failed')
          } catch {
            interceptionFailed = true
            await route.abort('failed').catch(() => {})
          }
        },
        { times: 1 },
      )
      await personal.getByLabel('群聊消息', { exact: true }).fill('Shared turn')
      await personal.getByRole('checkbox', { name: '成员 B', exact: true }).check()
      await personal.getByRole('checkbox', { name: '成员 A', exact: true }).check()
      await personal.getByRole('button', { name: '发送到群聊', exact: true }).click()
      await personal.getByRole('button', { name: '重试同一请求', exact: true }).waitFor()
      await owner.json('personal/groups', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name: '另一个群聊',
          instructions: '',
          memberIds: [members[0]!.id],
          defaultAssistantId: members[0]!.id,
          maxRelays: 0,
        },
      })
      await personal.getByRole('button', { name: '所有群聊', exact: true }).click()
      await personal.getByRole('button').filter({ hasText: '另一个群聊' }).click()
      await personal.getByRole('heading', { name: '另一个群聊', exact: true }).waitFor()
      await personal.getByRole('button', { name: '重试同一请求', exact: true }).click()
      await vi.waitFor(async () =>
        expect((await owner.json<PersonalGroupDetail>(`personal/groups/${group.id}`)).turn?.state).toBe('completed'),
      )
      await vi.waitFor(() => expect(sends).toHaveLength(2))
      expect(sends[1]).toEqual(sends[0])
      expect(await personal.getByRole('heading', { name: '另一个群聊', exact: true }).count()).toBe(1)
      expect(await personal.locator('.personal-shared-history').getByText('Shared turn', { exact: true }).count()).toBe(0)
      const detail = await owner.json<PersonalGroupDetail>(`personal/groups/${group.id}`)
      expect(detail.turn?.assistantIds).toEqual([members[1]!.id, members[0]!.id])
      expect(detail.messages.filter(message => message.role === 'user' && message.text === 'Shared turn')).toHaveLength(1)
      expect(await personal.getByText('PRIVATE MEMORY NOT SHARED', { exact: true }).count()).toBe(0)
      expect(seen.some(messages => JSON.stringify(messages).includes('PRIVATE MEMORY NOT SHARED'))).toBe(false)
      await personal.getByRole('button', { name: '所有群聊', exact: true }).click()
      await personal.getByRole('button').filter({ hasText: '真实接力群聊' }).click()
      await personal.getByText('本轮已完成', { exact: true }).waitFor()
      await personal.getByRole('button', { name: '恢复默认回复者', exact: true }).click()
      await personal.getByLabel('群聊消息', { exact: true }).fill('wait for stop')
      await personal.getByRole('button', { name: '发送到群聊', exact: true }).click()
      await personal.getByRole('button', { name: '停止本轮', exact: true }).waitFor()
      let replied = false
      await page.route(
        `**/personal/groups/${group.id}/cancel`,
        async route => {
          try {
            await route.fetch()
            replied = true
            await route.abort('failed')
          } catch {
            interceptionFailed = true
            await route.abort('failed').catch(() => {})
          }
        },
        { times: 1 },
      )
      await personal.getByRole('button', { name: '停止本轮', exact: true }).click()
      await vi.waitFor(() => expect(stopRequested).toBe(true))
      expect(replied).toBe(false)
      await personal.getByRole('status').filter({ hasText: '正在等待本轮真实停止…' }).waitFor()
      releaseStop()
      await personal.getByRole('button', { name: '重试原停止请求', exact: true }).click()
      await personal.getByText('本轮已停止', { exact: true }).waitFor()
      await vi.waitFor(() => expect(stops).toHaveLength(2))
      expect(stops[1]).toEqual(stops[0])
      expect((await owner.json<PersonalGroupDetail>(`personal/groups/${group.id}`)).turn?.state).toBe('cancelled')
      expect(interceptionFailed).toBe(false)
    } finally {
      releaseStop()
      await page.unrouteAll({ behavior: 'wait' })
      await context.close()
    }
  })
  it('creates a disabled routine, lets only the local API enable it, permits remote pause and removes private drafts on scope loss', async () => {
    const context = await browser.newContext({ viewport: { width: 900, height: 960 }, locale: 'zh-CN' })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    try {
      const { personal, id } = await open(page, '例行浏览器')
      await openSection(page.locator('.settings-page'), '定时任务')
      await personal.getByRole('button', { name: '创建定时任务', exact: true }).click()
      const editor = page.getByRole('dialog', { name: '定时任务设置', exact: true })
      await editor.getByLabel('任务名称', { exact: true }).fill('每日整理')
      await editor.getByRole('button', { name: /^执行助手/u }).click()
      await page.getByText('成员 A', { exact: true }).last().click()
      await editor.getByLabel('任务内容', { exact: true }).fill('Prepare a daily summary')
      await editor.getByLabel('每日时间', { exact: true }).fill('23:59')
      await editor.getByLabel('时区', { exact: true }).fill('UTC')
      await editor.getByRole('button', { name: '保存任务', exact: true }).click()
      await editor.waitFor({ state: 'hidden' })
      await personal.getByRole('heading', { name: '每日整理', exact: true }).waitFor()
      let routine = (await owner.json<PersonalOverview>('personal')).routines.find(item => item.name === '每日整理')!
      expect(routine.enabled).toBe(false)
      expect(await personal.getByRole('button', { name: '开启每日执行', exact: true }).count()).toBe(0)
      routine = await owner.json<PersonalRoutine>(`personal/routines/${routine.id}/enabled`, {
        method: 'POST',
        body: { requestId: randomUUID(), baseRevision: routine.revision, enabled: true },
      })
      expect(routine.enabled).toBe(true)
      await personal.getByRole('button', { name: '暂停以后执行', exact: true }).click()
      await vi.waitFor(async () => expect((await owner.json<PersonalRoutine>(`personal/routines/${routine.id}`)).enabled).toBe(false))
      await personal.getByRole('button', { name: '编辑任务', exact: true }).click()
      await editor.getByLabel('任务内容', { exact: true }).fill('Private unsaved routine draft')
      expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
      await vi.waitFor(async () => expect(await page.getByLabel('任务内容', { exact: true }).count()).toBe(0))
      expect(
        await page.evaluate(() => Object.values(localStorage).some(value => String(value).includes('Private unsaved routine draft'))),
      ).toBe(false)
    } finally {
      await context.close()
    }
  })
})
