import { chromium, type BrowserContext, type Page } from '@playwright/test'
import { mkdir, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { AgentMention, AppSnapshot, CustomAgent, CustomAgentList, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, tooltipText } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'
import { promptValue } from './helpers/prompt.ts'

const OUT = 'test-results/helper-chat'

function createPeer(owner: TestDevice, name: string, description: string) {
  return owner.json<CustomAgent>('custom-agents', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name,
      description,
      harnessId: 'standard',
      mode: 'agent',
      model: { providerId: 'helper-fixture', model: 'fixture-one' },
    },
  })
}

it('addresses one other personal Agent from an empty or existing chat and reads its own reply', async () => {
  const host = await startTestHost({ plugins: [fixture] })
  const browser = await chromium.launch(browserLaunchOptions())
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  try {
    page.setDefaultTimeout(15_000)
    const owner = await host.enroll({ listener: 'unix' })
    const source = await createPeer(owner, '编辑', '整理想法与写作素材')
    const target = await createPeer(owner, '架构师', '评审架构与技术方案')
    await fullScopeBrowser(page, host, owner, '协作验收')
    await place(page, '我的 Agent').click()
    await page.locator(`button[data-agent-id="${source.id}"]`).filter({ visible: true }).first().click()
    const field = page.getByRole('textbox', { name: '给编辑发消息', exact: true })
    const contact = page.getByRole('button', { name: '联系其他 Agent', exact: true })
    const option = page.getByRole('option', { name: /架构师/u })
    // The toolbar can address an Agent while the caret is in a quoted source, without editing or completing its text.
    const excerpt = '下面是原文：\n> 评审人是 @架'
    await field.fill(excerpt)
    await field.press('End')
    expect(await option.count()).toBe(0)
    await contact.click()
    await option.waitFor()
    await field.press('Escape')
    expect(await promptValue(field)).toBe(excerpt)
    await field.fill('')
    await contact.focus()
    await contact.press('Enter')
    await option.waitFor()
    expect(await page.getByRole('option', { name: /编辑/u }).count()).toBe(0)
    expect(await field.getAttribute('aria-activedescendant')).toBeNull()
    await mkdir(OUT, { recursive: true })
    for (const [width, height, scheme] of [
      [1440, 900, 'light'],
      [834, 1112, 'light'],
      [390, 844, 'dark'],
    ] as const) {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: scheme })
      await field.fill('@')
      await option.waitFor()
      await shoot(page, `mention-picker-${width}-${scheme}`)
    }
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await field.fill('@架')
    await field.press('ArrowDown')
    await field.press('Enter')
    await page.getByRole('button', { name: '发给架构师', exact: true }).waitFor()
    await shoot(page, 'pc-mention-addressed-dark')
    await page.getByRole('button', { name: '移除收件人' }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await field.fill('请＠架')
    await field.press('Enter')
    const addressed = page.getByRole('button', { name: '发给架构师', exact: true })
    await addressed.waitFor()
    expect(await promptValue(field)).toBe('请')
    await page.getByRole('button', { name: '移除收件人' }).click()
    await field.fill('')
    await page.getByRole('button', { name: '更多', exact: true }).filter({ visible: true }).click()
    await page.getByRole('menuitem', { name: '联系其他 Agent' }).click()
    await option.click()
    const question = '请评审这份离线同步方案'
    await field.fill(question)
    const attempts: string[] = []
    await page.route(`**/custom-agents/${source.id}/mentions`, async route => {
      if (route.request().method() !== 'POST') {
        // Neither the acceptance nor the read-back is visible until this tab retries after reload.
        if (attempts.length === 1) {
          const response = await route.fetch()
          if (response.ok()) return route.abort('failed')
          return route.fulfill({ response })
        }
        return route.continue()
      }
      const sent = route.request().postDataJSON() as { requestId: string; target: { customAgentId: string }; text: string }
      expect(sent.target.customAgentId).toBe(target.id)
      expect(sent.text).toBe(question)
      attempts.push(sent.requestId)
      if (attempts.length !== 1) return route.continue()
      const accepted = await route.fetch()
      expect(accepted.ok()).toBe(true)
      await route.abort('failed')
    })
    await addressed.click()
    const retry = page.getByRole('button', { name: '重试同一请求', exact: true })
    await retry.waitFor()
    await page.reload()
    await connected(page)
    if (!(await field.isVisible())) {
      await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的 Agent', exact: true }).click()
      await page.locator(`button[data-agent-id="${source.id}"]`).filter({ visible: true }).first().click()
    }
    await retry.click()
    const record = page.locator('.agent-mention-record').filter({ hasText: question })
    await record.getByText('好的，我来整理。', { exact: true }).waitFor()
    expect(attempts).toHaveLength(2)
    expect(new Set(attempts).size).toBe(1)
    expect(await record.count()).toBe(1)
    expect((await owner.json<AppSnapshot>('snapshot')).agentChats?.[source.id]?.state).toBe('empty')
    await shoot(page, 'mention-reply-390-dark')
    await record.getByRole('button', { name: '打开对方聊天' }).click()
    const backToSource = page.getByRole('button', { name: '返回编辑', exact: true })
    await backToSource.click()
    await expect.poll(() => record.locator('[data-open-agent-mention]').evaluate(el => el === document.activeElement)).toBe(true)
    await record.locator('[data-open-agent-mention]').press('Enter')
    const followup = page.getByRole('textbox', { name: '继续对话', exact: true })
    await followup.fill('@')
    await page.getByRole('option', { name: /编辑/u }).click()
    await followup.fill('把意见整理成提纲')
    await page.getByRole('button', { name: '发给编辑', exact: true }).click()
    await page
      .locator('.agent-mention-record')
      .filter({ hasText: '把意见整理成提纲' })
      .getByText('好的，我来整理。', { exact: true })
      .waitFor()
  } finally {
    await browser.close()
    await host.close()
  }
})

const consultRequest = '帮我梳理离线同步方案的验收重点。'
const reviewQuestion = '离线编辑后重新联网，哪些场景要优先验收？'
const reviewAnswer = [
  '建议先测三种场景。',
  '',
  '1. 离线编辑后重连，修改仍在。',
  '2. 同一条修改重复提交，只写入一次。',
  '3. 两台设备同时编辑，保留双方的内容并提示冲突。',
].join('\n')

it('shows a desktop Agent-initiated consultation in place and returns to the same exchange', async () => {
  const host = await startTestHost({ plugins: [fixture] })
  const browser = await chromium.launch(browserLaunchOptions())
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  try {
    page.setDefaultTimeout(15_000)
    const owner = await host.enroll({ listener: 'unix' })
    const source = await createPeer(owner, '编辑', '整理想法与写作素材')
    const target = await createPeer(owner, '架构师', '评审架构与技术方案')
    await owner.json(`custom-agents/${source.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: source.revision, canConsultAgents: true },
    })
    await fullScopeBrowser(page, host, owner, '桌面协作验收')
    await mkdir(OUT, { recursive: true })
    await place(page, '我的 Agent').click()
    await page.locator(`button[data-agent-id="${source.id}"]`).filter({ visible: true }).first().click()
    const profile = page.getByRole('region', { name: '编辑 的资料', exact: true })
    await page.getByRole('button', { name: '编辑 的资料', exact: true }).click()
    await profile.getByRole('button', { name: '设置', exact: true }).click()
    expect(await profile.getByRole('switch', { name: '允许主动联系其他 Agent', exact: true }).getAttribute('aria-checked')).toBe('true')
    await profile.getByText(/当前沿用之前授权的联系范围/u).waitFor()
    const expandConsent = profile.getByRole('button', { name: '允许联系其他本机 Agent', exact: true })
    const receive = profile.getByRole('switch', { name: '允许按自身权限接单', exact: true })
    expect(await receive.getAttribute('aria-checked')).toBe('false')
    for (const [width, height, scheme] of [
      [390, 844, 'dark'],
      [834, 1112, 'light'],
      [1440, 900, 'light'],
    ] as const) {
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: scheme })
      await receive.scrollIntoViewIfNeeded()
      expect(await receive.isVisible()).toBe(true)
      await shoot(page, `consultation-settings-${width}-${scheme}`)
    }
    await expandConsent.click()
    await receive.click()
    await profile.getByRole('button', { name: '保存', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await owner.json<CustomAgentList>('custom-agents')).agents.find(agent => agent.id === source.id)?.canConsultLocalAgents,
      )
      .toBe(true)
    expect(
      (await owner.json<CustomAgentList>('custom-agents')).agents.find(agent => agent.id === source.id)?.useOwnPermissionsForConsultations,
    ).toBe(true)
    expect(
      (await owner.json<CustomAgentList>('custom-agents')).agents.find(agent => agent.id === target.id)?.useOwnPermissionsForConsultations,
    ).toBeUndefined()
    await profile.getByRole('button', { name: '关闭资料', exact: true }).click()
    const field = page.getByRole('textbox', { name: '给编辑发消息', exact: true })
    await field.fill(consultRequest)
    await field.press('Meta+Enter')
    const records = () => owner.json<{ mentions: AgentMention[] }>(`custom-agents/${source.id}/mentions`)
    await expect.poll(async () => (await records()).mentions[0]?.status, { timeout: 15_000 }).toBe('completed')
    const [mention] = (await records()).mentions
    expect(mention).toMatchObject({ sourceAgentId: source.id, targetAgentId: target.id, initiator: 'agent', reply: { text: reviewAnswer } })
    const card = page.locator(`[data-agent-mention-id="${mention!.id}"]`)
    await card.getByText(reviewQuestion, { exact: true }).waitFor()
    await card.getByRole('button', { name: '展开回复' }).click()
    await card.getByText('两台设备同时编辑，保留双方的内容并提示冲突。', { exact: false }).waitFor()
    await shoot(page, 'pc-mention-result-light')
    await page.setViewportSize({ width: 1152, height: 720 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await shoot(page, 'pc-mention-result-dark')
    const open = card.getByRole('button', { name: '打开对方聊天' })
    await open.focus()
    await open.press('Enter')
    const back = page.getByRole('button', { name: '返回编辑', exact: true })
    await back.waitFor()
    await page.locator(`[data-message-id="${mention!.reply!.messageId}"]`).waitFor()
    await shoot(page, 'pc-mention-target-dark')
    await back.focus()
    await back.press('Enter')
    await expect.poll(() => open.evaluate(el => el === document.activeElement)).toBe(true)
    expect(await card.getByRole('button', { name: '收起回复' }).isVisible()).toBe(true)
    expect((await records()).mentions).toHaveLength(1)
    await open.press('Enter')
    await back.waitFor()
    const choosePeer = async (id: string) => page.locator(`button[data-agent-id="${id}"]`).filter({ visible: true }).first().click()
    await choosePeer(source.id)
    await card.waitFor()
    await choosePeer(target.id)
    await page.locator(`[data-message-id="${mention!.reply!.messageId}"]`).waitFor()
    expect(await back.count()).toBe(0)
  } finally {
    await browser.close()
    await host.close()
  }
})

it('binds abandonment to the creation shown when the confirmation opened', async () => {
  const host = await startTestHost({ plugins: [fixture] })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  try {
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const owner = await host.enroll({ listener: 'unix' })
    await fullScopeBrowser(page, host, owner, '放弃的归属')
    const seen = new Set<string>()
    const ids: string[] = []
    await context.route('**/link/api/custom-agents', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      const id = (route.request().postDataJSON() as { requestId: string }).requestId
      ids.push(id)
      if (seen.has(id)) return route.continue()
      seen.add(id)
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      await route.abort('failed')
    })
    const create = async (view: Page, name: string) => {
      await place(view, '我的 Agent').click()
      await view.locator('button:not([inert] *):visible', { hasText: '新建 Agent' }).first().click()
      await view.getByRole('list', { name: '候选' }).getByRole('button', { name: 'Latch 内置', exact: true }).click()
      const form = view.getByRole('form', { name: '新建 Agent' })
      await form.getByLabel('名字', { exact: true }).fill(name)
      await form.getByRole('button', { name: '创建', exact: true }).click()
      await view.getByRole('button', { name: '重试同一请求', exact: true }).waitFor()
    }
    await create(page, '第一项未知')
    await page.getByRole('button', { name: '放弃这次创建的等待', exact: true }).click()
    const confirmation = page.getByRole('button', { name: '放弃等待', exact: true })
    await confirmation.waitFor()
    const other = await context.newPage()
    other.setDefaultTimeout(15_000)
    await other.goto(`${host.host.loopbackOrigin}/link/`)
    await connected(other)
    await place(other, '我的 Agent').click()
    await other.getByRole('button', { name: '继续确认创建', exact: true }).click()
    await other.getByRole('button', { name: '重试同一请求', exact: true }).click()
    await other.getByRole('textbox', { name: '给第一项未知发消息', exact: true }).waitFor()
    await create(other, '第二项未知')
    const secondId = ids.at(-1)!
    expect(secondId).not.toBe(ids[0])
    if (await confirmation.isVisible()) {
      await confirmation.click()
      await confirmation.waitFor({ state: 'hidden' })
    }
    expect(await other.evaluate(id => Object.values(localStorage).some(value => value.includes(id)), secondId)).toBe(true)
    expect(await other.getByRole('button', { name: '重试同一请求', exact: true }).isVisible()).toBe(true)
  } finally {
    await context.close()
    await browser.close()
    await host.close()
  }
})

it('does not restore a revoked creation or clear a newer request when its old response arrives late', async () => {
  const host = await startTestHost({ plugins: [fixture] })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', reducedMotion: 'reduce' })
  let release: (() => void) | undefined
  try {
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const owner = await host.enroll({ listener: 'unix' })
    const name = '创建撤权'
    await fullScopeBrowser(page, host, owner, name)
    const device = host.host.security.devices.list().find(item => item.name === name)!
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的 Agent', exact: true }).click()
    await page.getByRole('button', { name: '新建 Agent', exact: true }).filter({ visible: true }).click()
    const choose = () => page.getByRole('list', { name: '候选' }).getByRole('button', { name: 'Latch 内置', exact: true }).click()
    await choose()
    const form = page.getByRole('form', { name: '新建 Agent' })
    await form.getByLabel('名字', { exact: true }).fill('旧的私有创建')
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let accepted = false
    const ids: string[] = []
    await page.route('**/link/api/custom-agents', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      ids.push((route.request().postDataJSON() as { requestId: string }).requestId)
      if (ids.length > 1) return route.continue()
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      accepted = true
      await held
      await route.fulfill({ response }).catch(() => {})
    })
    await form.getByRole('button', { name: '创建', exact: true }).click()
    await expect.poll(() => accepted).toBe(true)
    expect((await owner.confirmed(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
    await page.getByText('这台设备看不到 Agent', { exact: true }).filter({ visible: true }).waitFor()
    await expect.poll(() => page.evaluate(id => Object.values(localStorage).some(value => value.includes(id)), ids[0]!)).toBe(false)
    expect((await owner.confirmed(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
    await page.getByRole('heading', { name: '你想让谁成为你的帮手？' }).waitFor()
    await choose()
    await form.getByLabel('名字', { exact: true }).fill('新的已授权创建')
    await form.getByRole('button', { name: '创建', exact: true }).click()
    release!()
    await page.getByRole('textbox', { name: '给新的已授权创建发消息', exact: true }).waitFor()
    expect(new Set(ids).size).toBe(2)
    expect(ids).toHaveLength(2)
    expect(await page.getByRole('textbox', { name: '给旧的私有创建发消息', exact: true }).count()).toBe(0)
    const names = (await owner.json<CustomAgentList>('custom-agents')).agents.map(agent => agent.name)
    expect(names.toSorted()).toEqual(['新的已授权创建', '旧的私有创建'].toSorted())
    await mkdir(OUT, { recursive: true })
    await shoot(page, 'creation-scope-restored-390-dark')
  } finally {
    release?.()
    await context.close()
    await browser.close()
    await host.close()
  }
})

it('keeps a sensitive creation out of storage and requires an explicit decision after reload', async () => {
  const host = await startTestHost({ plugins: [fixture] })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  try {
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const owner = await host.enroll({ listener: 'unix' })
    await fullScopeBrowser(page, host, owner, '私有创建')
    await place(page, '我的 Agent').click()
    await page.locator('button:not([inert] *):visible', { hasText: '新建 Agent' }).first().click()
    await page.getByRole('list', { name: '候选' }).getByRole('button', { name: 'Latch 内置', exact: true }).click()
    const form = page.getByRole('form', { name: '新建 Agent' })
    await form.getByLabel('名字', { exact: true }).fill('私有创建')
    await form.getByRole('button', { name: '多说几句', exact: true }).click()
    const secret = `sk-${'a'.repeat(40)}`
    await form.getByLabel('指令', { exact: true }).fill(`测试用伪造值 ${secret}`)
    let sent = 0
    await page.route('**/link/api/custom-agents', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      sent++
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      await route.abort('failed')
    })
    await form.getByRole('button', { name: '创建', exact: true }).click()
    await page.getByRole('button', { name: '重试同一请求', exact: true }).waitFor()
    expect(await page.evaluate(value => Object.values(localStorage).some(entry => entry.includes(value)), secret)).toBe(false)
    await page.reload()
    await connected(page)
    await place(page, '我的 Agent').click()
    await page.getByRole('button', { name: '继续确认创建', exact: true }).click()
    await page.getByText(/敏感内容只保留在原页面内存中/u).waitFor()
    expect(await page.getByRole('button', { name: '重试同一请求', exact: true }).count()).toBe(0)
    expect(await page.evaluate(value => Object.values(localStorage).some(entry => entry.includes(value)), secret)).toBe(false)
    await mkdir(OUT, { recursive: true })
    await shoot(page, 'creation-private-unknown-1440-light')
    await page.getByRole('button', { name: '放弃这次创建的等待', exact: true }).click()
    await page.getByRole('button', { name: '放弃等待', exact: true }).click()
    await page.getByRole('heading', { name: '你想让谁成为你的帮手？' }).waitFor()
    expect(sent).toBe(1)
    expect((await owner.json<CustomAgentList>('custom-agents')).agents.filter(agent => agent.name === '私有创建')).toHaveLength(1)
  } finally {
    await context.close()
    await browser.close()
    await host.close()
  }
})

it('coordinates two windows retrying one creation without replacing its request', async () => {
  const host = await startTestHost({ plugins: [fixture] })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  let release: (() => void) | undefined
  try {
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const owner = await host.enroll({ listener: 'unix' })
    await fullScopeBrowser(page, host, owner, '双窗口创建')
    await place(page, '我的 Agent').click()
    await page.locator('button:not([inert] *):visible', { hasText: '新建 Agent' }).first().click()
    await page.getByRole('list', { name: '候选' }).getByRole('button', { name: 'Latch 内置', exact: true }).click()
    const form = page.getByRole('form', { name: '新建 Agent' })
    await form.getByLabel('名字', { exact: true }).fill('双窗口只建一次')
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const sent: Array<Record<string, unknown>> = []
    let accepted = false
    await context.route('**/link/api/custom-agents', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      sent.push(route.request().postDataJSON() as Record<string, unknown>)
      if (sent.length > 1) return route.continue()
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      accepted = true
      await held
      await route.abort('failed')
    })
    await form.getByRole('button', { name: '创建', exact: true }).click()
    await expect.poll(() => accepted).toBe(true)
    const other = await context.newPage()
    other.setDefaultTimeout(15_000)
    await other.goto(`${host.host.loopbackOrigin}/link/`)
    await connected(other)
    await place(other, '我的 Agent').click()
    await other.getByRole('button', { name: '继续确认创建', exact: true }).click()
    await other.getByRole('button', { name: '重试同一请求', exact: true }).click()
    await expect.poll(() => other.evaluate(async () => (await navigator.locks.query()).pending?.length ?? 0)).toBe(1)
    expect(sent).toHaveLength(1)
    release!()
    await other.getByRole('textbox', { name: '给双窗口只建一次发消息', exact: true }).waitFor()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(sent[0])
    await page.getByRole('heading', { name: '你想让谁成为你的帮手？' }).waitFor()
    expect((await owner.json<CustomAgentList>('custom-agents')).agents.filter(agent => agent.name === '双窗口只建一次')).toHaveLength(1)
  } finally {
    release?.()
    await context.close()
    await browser.close()
    await host.close()
  }
})

it('keeps an unknown creation available for retry instead of cancelling away its request', async () => {
  const host = await startTestHost({ plugins: [fixture] })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  try {
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const owner = await host.enroll({ listener: 'unix' })
    await fullScopeBrowser(page, host, owner, '创建回执')
    await place(page, '我的 Agent').click()
    await page.locator('button:not([inert] *):visible', { hasText: '新建 Agent' }).first().click()
    await page.getByRole('list', { name: '候选' }).getByRole('button', { name: 'Latch 内置', exact: true }).click()
    const form = page.getByRole('form', { name: '新建 Agent' })
    await form.getByLabel('名字', { exact: true }).fill('只创建一次')
    const sent: Array<Record<string, unknown>> = []
    await page.route('**/link/api/custom-agents', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      sent.push(route.request().postDataJSON() as Record<string, unknown>)
      if (sent.length > 1) return route.continue()
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      await route.abort('failed')
    })
    await form.getByRole('button', { name: '创建', exact: true }).click()
    const retry = page.getByRole('button', { name: '重试同一请求', exact: true })
    await retry.waitFor()
    expect((await owner.json<CustomAgentList>('custom-agents')).agents.filter(agent => agent.name === '只创建一次')).toHaveLength(1)
    const cancel = form.getByRole('button', { name: '取消', exact: true })
    if (await cancel.isEnabled()) await cancel.click()
    expect(await retry.isVisible()).toBe(true)
    await place(page, 'Code').click()
    await place(page, '我的 Agent').click()
    const resume = page.getByRole('button', { name: '继续确认创建', exact: true })
    await expect.poll(async () => (await retry.isVisible()) || (await resume.isVisible())).toBe(true)
    if (await resume.isVisible()) await resume.click()
    await retry.waitFor()
    await page.reload()
    await connected(page)
    await place(page, '我的 Agent').click()
    await expect.poll(async () => (await retry.isVisible()) || (await resume.isVisible())).toBe(true)
    if (await resume.isVisible()) await resume.click()
    await retry.waitFor()
    await retry.click()
    await page.getByRole('textbox', { name: '给只创建一次发消息', exact: true }).waitFor()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(sent[0])
    expect((await owner.json<CustomAgentList>('custom-agents')).agents.filter(agent => agent.name === '只创建一次')).toHaveLength(1)
  } finally {
    await context.close()
    await browser.close()
    await host.close()
  }
})

it('keeps the creation draft when choosing a helper again and cancels without writing', async () => {
  const host = await startTestHost({ plugins: [fixture] })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  try {
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'fake-agent', name: 'Fake Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
    })
    await fullScopeBrowser(page, host, owner, '创建草稿')
    await place(page, '我的 Agent').click()
    const before = (await owner.json<CustomAgentList>('custom-agents')).agents
    await page.locator('button:not([inert] *):visible', { hasText: '新建 Agent' }).first().click()
    const choose = (name: string) => page.getByRole('list', { name: '候选' }).getByRole('button', { name, exact: true }).click()
    await choose('Latch 内置')
    const form = page.getByRole('form', { name: '新建 Agent' })
    await form.getByLabel('名字', { exact: true }).fill('保留我的名字')
    await form.getByLabel('职责', { exact: true }).fill('核对资料后整理成摘要')
    await form.getByRole('button', { name: '多说几句', exact: true }).click()
    await form.getByLabel('指令', { exact: true }).fill('保留来源，缺少证据时直接说明。')
    await form.getByRole('button', { name: '保留我的名字的头像', exact: true }).click()
    for (const name of ['尖括号', '眯眼', '雾']) await page.getByRole('radio', { name, exact: true }).click()
    await page.keyboard.press('Escape')
    await form.getByRole('button', { name: '更多', exact: true }).click()
    await form.getByRole('button', { name: /^模型：/u }).click()
    await modelChoice(page, 'fixture-two').click()
    const checkDraft = async () => {
      expect(await form.getByLabel('名字', { exact: true }).inputValue()).toBe('保留我的名字')
      expect(await form.getByLabel('职责', { exact: true }).inputValue()).toBe('核对资料后整理成摘要')
      expect(await form.getByLabel('指令', { exact: true }).inputValue()).toBe('保留来源，缺少证据时直接说明。')
      await form.getByRole('button', { name: '保留我的名字的头像', exact: true }).click()
      for (const name of ['尖括号', '眯眼', '雾'])
        expect(await page.getByRole('radio', { name, exact: true }).getAttribute('aria-checked')).toBe('true')
      await page.keyboard.press('Escape')
    }
    await form.getByRole('button', { name: '换', exact: true }).click()
    await choose('Latch 内置')
    await checkDraft()
    expect(await form.getByRole('button', { name: /^模型：/u }).innerText()).toContain('fixture-two')
    await form.getByRole('button', { name: '换', exact: true }).click()
    await choose('Fake Agent')
    await checkDraft()
    expect(await form.getByText('它自己的默认', { exact: true }).isVisible()).toBe(true)
    expect((await owner.json<CustomAgentList>('custom-agents')).agents).toEqual(before)
    await mkdir(OUT, { recursive: true })
    await shoot(page, 'creation-draft-kept-1440-light')
    await form.getByRole('button', { name: '取消', exact: true }).click()
    expect((await owner.json<CustomAgentList>('custom-agents')).agents).toEqual(before)
  } finally {
    await context.close()
    await browser.close()
    await host.close()
  }
})

it('keeps one topic and the same attachments when the first send reaches the Host but its answer is lost', async () => {
  let calls = 0
  const received: string[][] = []
  const plugin: HarnessPlugin = {
    id: 'helper-attachments',
    name: 'Helper attachments',
    version: '1',
    description: '',
    activate(context) {
      context.registerProvider({
        id: 'helper-attachments',
        name: 'Fixture vision',
        model: 'fixture',
        modelCapabilities: { fixture: { vision: true } },
        async *stream(input) {
          calls++
          received.push(input.messages.flatMap(message => message.attachments?.map(item => item.type) ?? []))
          yield { type: 'text', text: '收到了图片和资料。' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({ demo: false, plugins: [plugin] })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  let resumeUpload: (() => void) | undefined
  try {
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const owner = await host.enroll({ listener: 'unix' })
    const folder = join(host.root, 'helper-notes')
    await mkdir(folder)
    expect((await owner.addFolders({ paths: [folder], name: '资料项目' })).status).toBeLessThan(300)
    const project = (await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces.find(item => item.name === '资料项目')!
    const gone = join(host.root, 'helper-gone')
    await mkdir(gone)
    expect((await owner.addFolders({ paths: [gone], name: '离线资料' })).status).toBeLessThan(300)
    await rmdir(gone)
    await expect
      .poll(
        async () =>
          (await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces.find(item => item.name === '离线资料')?.unavailable,
        { timeout: 10_000 },
      )
      .toBeTruthy()
    await fullScopeBrowser(page, host, owner, '助手附件')
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的 Agent', exact: true }).click()
    await page.getByRole('button', { name: '新建 Agent', exact: true }).filter({ visible: true }).click()
    await page.getByRole('list', { name: '候选' }).getByRole('button', { name: 'Latch 内置', exact: true }).click()
    const form = page.getByRole('form', { name: '新建 Agent' })
    await form.getByLabel('名字').fill('资料员')
    await form.getByRole('button', { name: '更多', exact: true }).click()
    await form.getByRole('button', { name: /^模型：/u }).click()
    await modelChoice(page, 'fixture').click()
    await form.getByRole('button', { name: '创建', exact: true }).click()
    const composer = page.locator('.agent-delegate .composer')
    const input = page.getByRole('textbox', { name: '给资料员发消息', exact: true })
    await input.waitFor()
    expect(await composer.getByRole('button', { name: '更多', exact: true }).count()).toBe(1)
    const heldUpload = new Promise<void>(resolve => {
      resumeUpload = resolve
    })
    let finishUpload: (() => void) | undefined
    const uploadFinished = new Promise<void>(resolve => {
      finishUpload = resolve
    })
    await page.route('**/link/api/attachments', async route => {
      await heldUpload
      await route.abort().catch(() => {})
      finishUpload!()
    })
    await composer.getByRole('button', { name: '更多', exact: true }).click()
    const waitingChooser = page.waitForEvent('filechooser')
    await page.getByRole('menuitem', { name: /添加文件/u }).click()
    await (await waitingChooser).setFiles({ name: 'waiting.txt', mimeType: 'text/plain', buffer: Buffer.from('waiting upload') })
    await input.fill('取消上传等待后保留这条草稿')
    await input.press('Meta+Enter')
    await composer.getByRole('button', { name: '取消发送', exact: true }).click()
    resumeUpload!()
    await uploadFinished
    await page.unroute('**/link/api/attachments')
    await page.getByRole('button', { name: '重试上传', exact: true }).waitFor()
    expect(await promptValue(input)).toBe('取消上传等待后保留这条草稿')
    expect(calls).toBe(0)
    expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(0)
    await mkdir(OUT, { recursive: true })
    await shoot(page, 'attachments-upload-cancelled-390-light')
    await page.getByRole('button', { name: '移除附件 waiting.txt', exact: true }).click()
    await composer.getByRole('button', { name: '更多', exact: true }).click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('menuitem', { name: /添加文件/u }).click()
    await (
      await chooser
    ).setFiles([
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('资料附件，供本轮阅读。') },
      {
        name: 'sample.png',
        mimeType: 'image/png',
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64'),
      },
    ])
    const drafts = page.getByLabel('消息附件', { exact: true })
    for (const name of ['notes.txt', 'sample.png'])
      await expect
        .poll(() => drafts.getByRole('button', { name, exact: true }).isEnabled(), { timeout: 10000 })
        .toBe(true)
        .catch(async () => {
          throw new Error(await drafts.innerText())
        })
    await composer.getByRole('button', { name: '更多', exact: true }).click()
    const unavailable = page.getByRole('menuitem', { name: /离线资料/u })
    expect(await unavailable.getAttribute('aria-disabled')).toBe('true')
    expect(await unavailable.innerText()).toContain('文件夹')
    await page.getByRole('menuitem', { name: '资料项目', exact: true }).click()
    await page.locator('.agent-delegate-where').getByText('在 资料项目 做', { exact: true }).waitFor()
    await input.fill('看一下这两份资料')
    const requests: Array<{ requestId: string; attachmentIds?: string[]; workspaceId?: string }> = []
    await page.route('**/link/api/tasks', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      requests.push(route.request().postDataJSON() as (typeof requests)[number])
      if (requests.length > 1) return route.continue()
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      await route.abort('failed')
    })
    await input.press('Meta+Enter')
    await page.getByRole('button', { name: '重试这次提交', exact: true }).waitFor()
    await mkdir(OUT, { recursive: true })
    await shoot(page, 'attachments-unknown-390-light')
    await page.getByRole('button', { name: '重试这次提交', exact: true }).click()
    await page.getByText('收到了图片和资料。', { exact: true }).waitFor()
    expect(requests).toHaveLength(2)
    expect(requests[0]!.attachmentIds).toHaveLength(2)
    expect(requests[0]!.workspaceId).toBe(project.id)
    expect(requests[1]).toEqual(requests[0])
    expect(calls).toBe(1)
    expect(received).toEqual([['text', 'image']])
    const tasks = (await owner.json<AppSnapshot>('snapshot')).tasks
    expect(tasks).toHaveLength(1)
    const detail = await owner.json<TaskDetail>(`tasks/${tasks[0]!.id}`)
    expect(detail.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(detail.messages.find(message => message.role === 'user')?.attachments?.map(item => item.name)).toEqual([
      'notes.txt',
      'sample.png',
    ])
    await shoot(page, 'attachments-recovered-390-light')
    await page.unroute('**/link/api/tasks')
    const another = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '附件复核',
        description: '',
        harnessId: 'standard',
        mode: 'agent',
        model: { providerId: 'helper-attachments', model: 'fixture' },
      },
    })
    await page.getByRole('button', { name: '返回', exact: true }).filter({ visible: true }).first().click()
    await page.locator(`[data-agent-id="${another.id}"]`).filter({ visible: true }).click()
    const laterInput = page.getByRole('textbox', { name: '给附件复核发消息', exact: true })
    await laterInput.waitFor()
    await composer.getByRole('button', { name: '更多', exact: true }).click()
    const laterChooser = page.waitForEvent('filechooser')
    await page.getByRole('menuitem', { name: /添加文件/u }).click()
    await (await laterChooser).setFiles({ name: 'later.txt', mimeType: 'text/plain', buffer: Buffer.from('another attachment') })
    await expect.poll(() => page.getByRole('button', { name: 'later.txt', exact: true }).isEnabled()).toBe(true)
    await page.route('**/link/api/tasks', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      await route.abort('failed')
    })
    await laterInput.fill('放下等待后不要自动重发')
    await laterInput.press('Meta+Enter')
    await page.getByRole('button', { name: '放弃这次提交', exact: true }).click()
    expect(await promptValue(laterInput)).toBe('放下等待后不要自动重发')
    expect(await page.locator('.attachment-draft').count()).toBe(0)
    await page.getByText('附件需要重新添加。', { exact: true }).waitFor()
    expect(calls).toBe(2)
    expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(2)
    await shoot(page, 'attachments-abandoned-390-light')
  } finally {
    resumeUpload?.()
    await context.close()
    await browser.close()
    await host.close()
  }
})

/** A local model service with two models, so the built-in Harness answers and a helper's model can change. */
const fixture: HarnessPlugin = {
  id: 'helper-fixture',
  name: 'Helper fixture',
  version: '1',
  description: '',
  activate(context) {
    context.registerSkill({ id: 'digest', name: '摘要清单', description: '把资料整理成一页摘要', content: 'Draft a one-page summary.' })
    context.registerProvider({
      id: 'helper-fixture',
      name: 'Helper fixture',
      model: 'fixture-one',
      models: ['fixture-one', 'fixture-two'],
      async *stream({ messages, tools }) {
        const last = messages.at(-1)
        if (last?.role === 'user' && last.content === consultRequest && tools?.some(tool => tool.name === 'list_personal_agents')) {
          yield { type: 'tool-call', call: { id: 'peer-list', name: 'list_personal_agents', arguments: {} } }
          yield { type: 'finish', reason: 'tool-calls' }
          return
        }
        if (last?.role === 'tool' && last.toolCallId === 'peer-list') {
          const peers = JSON.parse(last.content) as { id: string; name: string }[]
          const peer = peers.find(entry => entry.name === '架构师')
          if (!peer) throw new Error('Fixture expected its peer')
          yield {
            type: 'tool-call',
            call: { id: 'peer-review', name: 'consult_personal_agent', arguments: { agentId: peer.id, question: reviewQuestion } },
          }
          yield { type: 'finish', reason: 'tool-calls' }
          return
        }
        if (last?.role === 'tool' && last.toolCallId === 'peer-review') {
          yield { type: 'text', text: '评审意见已收到。我会把重连、幂等和冲突处理加入验收清单。' }
          yield { type: 'finish', reason: 'stop' }
          return
        }
        if (last?.role === 'user' && last.content.endsWith(reviewQuestion)) {
          yield { type: 'text', text: reviewAnswer }
          yield { type: 'finish', reason: 'stop' }
          return
        }
        if (messages.findLast(message => message.role === 'user')?.content === '失败一轮') throw new Error('本地验收模型暂时不可用')
        yield { type: 'reasoning', text: '想一下' }
        yield { type: 'text', text: '好的，我来整理。' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
}

async function fullScopeBrowser(page: Page, host: TestHost, owner: TestDevice, name: string) {
  await enrollBrowser(page, host, { name })
  const id = host.host.security.devices.list().find(device => device.name === name)!.id
  expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
  await page.reload()
  await connected(page)
}

const place = (page: Page, name: 'Code' | '我的 Agent') => page.getByRole('radio', { name, exact: true }).first()

/**
 * What a helper's conversation shows around its words: the frame, the author lines, the status and footer lines, and
 * the input. The prose and the person's own bubbles are left out: the fake agent echoes what it was sent.
 */
const chromeText = (page: Page) =>
  page.evaluate(() => {
    // Only what is shown: Code's own columns stay mounted, hidden, under 我的 Agent's page.
    const roots = [...document.querySelectorAll<HTMLElement>('.topbar, .agent-chat-title, .transcript, .composer, .agent-delegate')].filter(
      root => root.checkVisibility() && !root.closest('[inert], [aria-hidden="true"]'),
    )
    return roots
      .map(root => {
        const copy = root.cloneNode(true) as HTMLElement
        for (const prose of copy.querySelectorAll('.message-content, .user-bubble-text, .reasoning-text, [popover], .sr-only'))
          prose.remove()
        return copy.textContent ?? ''
      })
      .join('\n')
  })

const modelChoice = (page: Page, name: string) =>
  page
    .getByRole('menuitemradio', { name: new RegExp(name, 'u') })
    .or(page.getByRole('option', { name: new RegExp(name, 'u') }))
    .or(page.getByRole('radio', { name: new RegExp(name, 'u') }))
    .first()

const ENGINE_WORDS = ['Latch 内置', 'Fake Agent', 'Harness', '模型', '思考', 'fixture', 'tokens', '输入 ', '输出 ']

async function expectPersonOnly(page: Page) {
  const text = await chromeText(page)
  for (const word of ENGINE_WORDS) expect(text, `「${word}」 on a helper's conversation`).not.toContain(word)
  // The input is the input, ＋ and send: none of Code's four controls.
  expect(
    await page.evaluate(
      () =>
        [...document.querySelectorAll<HTMLElement>('[data-composer-control]')].filter(
          control => control.checkVisibility() && !control.closest('[inert], [aria-hidden="true"]'),
        ).length,
    ),
  ).toBe(0)
  expect(await page.getByRole('button', { name: '插入命令', exact: true }).filter({ visible: true }).count()).toBe(0)
}

async function shoot(page: Page, name: string) {
  // Menus and the page's own entrance have finished moving.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => undefined)),
    ),
  )
  await noHorizontalOverflow(page)
  await page.screenshot({ path: `${OUT}/${name}.png` })
}

it('assembles an assistant from a skill and an explicit plugin scope before its first job', async () => {
  const host = await startTestHost({ plugins: [fixture] })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' })
    const owner = await host.enroll({ listener: 'unix' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await fullScopeBrowser(page, host, owner, '能力验收')
    await place(page, '我的 Agent').click()
    await page.getByRole('button', { name: '新建 Agent', exact: true }).filter({ visible: true }).first().click()
    const form = page.getByRole('form', { name: '新建 Agent' })
    await form.getByLabel('名字', { exact: true }).fill('读书助手')
    await form.getByLabel('职责', { exact: true }).fill('把阅读笔记整理成一页摘要')
    await page.getByRole('list', { name: '候选' }).getByRole('button', { name: 'Latch 内置', exact: true }).click()
    expect(await form.getByLabel('名字', { exact: true }).inputValue()).toBe('读书助手')
    await form.getByRole('button', { name: '技能与工具', exact: true }).click()
    await form.getByRole('checkbox', { name: /摘要清单/u }).check()
    await form.getByRole('checkbox', { name: '全部已启用的插件', exact: true }).uncheck()
    const plugins = (await owner.json<CustomAgentList>('custom-agents')).plugins.filter(plugin =>
      plugin.capabilities.some(cap => cap.startsWith('tool:')),
    )
    expect(plugins.length).toBeGreaterThan(0)
    for (const plugin of plugins) await form.getByRole('checkbox', { name: plugin.name, exact: true }).uncheck()
    await mkdir(OUT, { recursive: true })
    await page.setViewportSize({ width: 768, height: 1024 })
    await shoot(page, 'assemble-768-dark')
    await form.getByRole('button', { name: '创建', exact: true }).click()
    await page.getByRole('textbox', { name: '给读书助手发消息', exact: true }).waitFor()
    const agent = (await owner.json<CustomAgentList>('custom-agents')).agents.find(item => item.name === '读书助手')!
    expect((await owner.json<{ agent: CustomAgent }>(`custom-agents/${agent.id}`)).agent).toMatchObject({
      description: '把阅读笔记整理成一页摘要',
      skills: ['helper-fixture:digest'],
      tools: [],
    })
    await context.close()
  } finally {
    await browser.close()
    await host.close()
  }
})

it('creates a helper in two steps, talks to it as a person, and changes its model only in 资料 › 设置', async () => {
  await mkdir(OUT, { recursive: true })
  const host = await startTestHost({ plugins: [fixture] })
  const browser = await chromium.launch(browserLaunchOptions())
  const contexts: BrowserContext[] = []
  const replyQueue = join(host.root, 'helper-replies.json')
  try {
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: {
        id: 'fake-agent',
        name: 'Fake Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_LOG: join(host.root, 'acp.log'), FAKE_ACP_REPLY_QUEUE: replyQueue },
      },
    })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    contexts.push(context)
    await stillMotion(context)
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await fullScopeBrowser(page, host, owner, '帮手 1440')
    await place(page, '我的 Agent').click()

    // Step one: who. Latch 内置 is the first card; the fake one has no card of its own, so it is its name alone.
    await page.locator('button:not([inert] *):visible', { hasText: '新建 Agent' }).first().click()
    await page.getByRole('heading', { name: '你想让谁成为你的帮手？' }).waitFor()
    const cards = page.getByRole('list', { name: '候选' }).getByRole('button')
    expect(await cards.allInnerTexts()).toEqual([expect.stringContaining('Latch 内置'), expect.stringContaining('Fake Agent')])
    expect(await cards.first().innerText()).toContain('稳当，动手前每次问你。')
    await shoot(page, 'create-who-1440-light')

    // Step two: who it is. The Harness is said once, here, with 换; the model, 做事前 and the project are under 更多.
    await cards.first().click()
    const form = page.getByRole('form', { name: '新建 Agent' })
    await form.locator('.helper-chosen').getByText('选了').waitFor()
    await form.getByLabel('名字').fill('晨报')
    expect(await form.getByRole('button', { name: '资料整理', exact: true }).count()).toBe(0)
    expect(await form.getByLabel('名字').inputValue()).toBe('晨报')
    await form.getByRole('button', { name: '更多' }).click()
    await form.getByText('做事前', { exact: true }).waitFor()
    // The test Host's default is the demo model: this helper uses the local service from the start.
    await form.getByRole('button', { name: /^模型：/u }).click()
    await modelChoice(page, 'fixture-one').click()
    await shoot(page, 'create-about-1440-light')
    await form.getByRole('button', { name: '创建', exact: true }).click()

    // Created: its new topic greets with fixed words, which are no message.
    const input = page.getByRole('textbox', { name: '给晨报发消息', exact: true })
    await input.waitFor()
    expect(await page.getByText('你好，我是晨报。').count()).toBe(0)
    const { agents } = await owner.json<CustomAgentList>('custom-agents')
    const morning = agents.find(agent => agent.name === '晨报')!
    expect(morning).toMatchObject({ harnessId: 'standard', mode: 'agent', model: { providerId: 'helper-fixture', model: 'fixture-one' } })
    await expectPersonOnly(page)
    await shoot(page, 'new-topic-1440-light')

    // Talking: the reply is under its face and name; nothing of the Harness, the model or the tokens.
    await input.fill('整理一下今天的事')
    await input.press('Meta+Enter')
    const topics = async () => (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.agent?.customAgentId === morning.id)
    await expect.poll(async () => (await topics()).length, { timeout: 15_000 }).toBe(1)
    const [first] = await topics()
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${first!.id}`)).summary.status, { timeout: 15_000 }).toBe('idle')
    const reply = page.locator('.turn-reply .assistant-meta-person')
    await reply.getByText('晨报').waitFor()
    await page.getByText('好的，我来整理。').waitFor()
    await page.getByText(/想了 \d+ 秒/u).waitFor()
    await expectPersonOnly(page)
    await shoot(page, 'topic-1440-light')

    // The model is a setting of the helper's: 资料 › 设置 › 模型. Nothing in the conversation changes it.
    await page.locator('.topbar').getByRole('button', { name: '晨报 的资料', exact: true }).click()
    const panel = page.getByRole('region', { name: '晨报 的资料', exact: true })
    await panel.getByRole('button', { name: '设置', exact: true }).click()
    await panel.getByText('由 Latch 内置 运行').waitFor()
    const consult = panel.getByRole('switch', { name: '允许主动联系其他 Agent', exact: true })
    expect(await consult.getAttribute('aria-checked')).toBe('false')
    await consult.click()
    await shoot(page, 'settings-1440-light')
    await panel.getByRole('button', { name: /^模型：/u }).click()
    // The model panel lists one source at a time (66e1b331); its search reaches every source.
    await page.getByRole('searchbox', { name: '搜索模型', exact: true }).filter({ visible: true }).first().fill('fixture-two')
    await modelChoice(page, 'fixture-two').click()
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect
      .poll(async () => (await owner.json<CustomAgentList>('custom-agents')).agents.find(agent => agent.id === morning.id)?.model)
      .toEqual({ providerId: 'helper-fixture', model: 'fixture-two' })
    expect((await owner.json<CustomAgentList>('custom-agents')).agents.find(agent => agent.id === morning.id)).toMatchObject({
      canConsultAgents: true,
      canConsultLocalAgents: true,
    })
    await panel.getByRole('button', { name: '关闭资料', exact: true }).click()
    // The existing chat uses the selected default for its next turn.
    const continued = page.getByRole('textbox', { name: '继续对话', exact: true }).filter({ visible: true })
    await continued.fill('明天呢')
    await continued.press('Meta+Enter')
    await expect
      .poll(async () => (await owner.json<TaskDetail>(`tasks/${first!.id}`)).summary.model, { timeout: 15_000 })
      .toBe('fixture-two')
    expect(await topics()).toHaveLength(1)
    await expect
      .poll(async () => (await owner.json<TaskDetail>(`tasks/${first!.id}`)).messages.filter(message => message.role === 'user').length)
      .toBe(2)
    await expectPersonOnly(page)

    // A helper on the fake ACP Harness: the same two steps; its permission cannot be read back, and the frame says so.
    await page.locator('button:not([inert] *):visible', { hasText: '新建 Agent' }).first().click()
    await page.getByRole('list', { name: '候选' }).getByRole('button', { name: 'Fake Agent', exact: true }).click()
    // That Latch does not isolate it is the chosen Harness's tooltip, where the person decides.
    const boundary = page.getByRole('form', { name: '新建 Agent' }).locator('.helper-chosen-name')
    const said = await tooltipText(page, boundary)
    expect(said).toContain('Latch 不隔离')
    expect(said).toContain('运行命令')
    await page.getByRole('form', { name: '新建 Agent' }).getByLabel('名字').fill('小抄')
    await page.getByRole('form', { name: '新建 Agent' }).getByRole('button', { name: '创建', exact: true }).click()
    const fakeInput = page.getByRole('textbox', { name: '给小抄发消息', exact: true })
    await fakeInput.fill('列一下待办')
    await fakeInput.press('Meta+Enter')
    const scribe = (await owner.json<CustomAgentList>('custom-agents')).agents.find(agent => agent.name === '小抄')!
    expect(scribe.harnessId).toBe('fake-agent')
    await expect
      .poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.agent?.customAgentId === scribe.id).length, {
        timeout: 15_000,
      })
      .toBe(1)
    await page.locator('.turn-reply .assistant-meta-person').getByText('小抄').waitFor()
    await page.getByText(/echo:/u).first().waitFor()
    await expectPersonOnly(page)
    await shoot(page, 'topic-fake-1440-light')

    // A simpler input keeps the Harness's real commands: choosing only edits the draft, then the same sender sends it.
    const scribeSession = (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.agent?.customAgentId === scribe.id)!
    const commandInput = page.getByRole('textbox', { name: '继续对话', exact: true }).filter({ visible: true })
    await commandInput.fill('plan')
    await commandInput.press('Meta+Enter')
    await expect
      .poll(async () => (await owner.json<TaskDetail>(`tasks/${scribeSession.id}`)).commands?.some(command => command.name === 'init'))
      .toBe(true)
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${scribeSession.id}`)).summary.status).toBe('idle')
    const beforeCommand = (await owner.json<TaskDetail>(`tasks/${scribeSession.id}`)).messages.filter(
      message => message.role === 'user',
    ).length
    await commandInput.fill('/ini')
    await page.getByRole('option', { name: /\/init/u }).click()
    expect((await owner.json<TaskDetail>(`tasks/${scribeSession.id}`)).messages.filter(message => message.role === 'user')).toHaveLength(
      beforeCommand,
    )
    await commandInput.press('Meta+Enter')
    await expect
      .poll(async () =>
        (await owner.json<TaskDetail>(`tasks/${scribeSession.id}`)).messages
          .filter(message => message.role === 'user')
          .map(message => message.text)
          .at(-1),
      )
      .toBe('/init')
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${scribeSession.id}`)).summary.status).toBe('idle')
    expect((await owner.json<TaskDetail>(`tasks/${scribeSession.id}`)).messages.filter(message => message.role === 'user')).toHaveLength(
      beforeCommand + 1,
    )

    // The Host keeps the Harness: a change of it is refused, in words, with nothing changed.
    const moved = await owner.request(`custom-agents/${scribe.id}`, {
      method: 'PATCH',
      body: { requestId: crypto.randomUUID(), baseRevision: scribe.revision, harnessId: 'standard' },
    })
    expect(moved.status).toBe(409)
    expect(await moved.json()).toMatchObject({ error: 'agent-harness-fixed' })

    // Every width, light and dark: the creation page and a helper's topic, with no page wider than the window.
    for (const [width, height] of [
      [1440, 900],
      [768, 1024],
      [390, 844],
      [320, 640],
    ] as const) {
      for (const scheme of ['light', 'dark'] as const) {
        if (width === 1440 && scheme === 'light') continue
        const wide = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: 'reduce' })
        contexts.push(wide)
        await stillMotion(wide)
        const view = await wide.newPage()
        view.setDefaultTimeout(15_000)
        await fullScopeBrowser(view, host, owner, `帮手 ${width} ${scheme}`)
        const phone = width < 768
        if (phone) await view.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的 Agent', exact: true }).click()
        else await view.keyboard.press('Meta+Shift+Digit2')
        // Wherever the list stands at this width (the sidebar, a tablet's inline list, a phone's root page); the page in
        // front is last in the document, over the rail or sidebar it covers.
        const visible = (name: string | RegExp) =>
          view
            .getByRole('button', { name, ...(typeof name === 'string' ? { exact: true } : {}) })
            .filter({ visible: true })
            .last()
        await visible('新建 Agent').click()
        await view.getByRole('heading', { name: '你想让谁成为你的帮手？' }).waitFor()
        await shoot(view, `create-who-${width}-${scheme}`)
        await view.getByRole('list', { name: '候选' }).getByRole('button').first().click()
        await view.getByRole('form', { name: '新建 Agent' }).getByRole('button', { name: '更多' }).click()
        await view.getByRole('form', { name: '新建 Agent' }).getByText('做事前', { exact: true }).waitFor()
        await shoot(view, `create-about-${width}-${scheme}`)
        await view.getByRole('form', { name: '新建 Agent' }).getByRole('button', { name: '取消', exact: true }).click()
        await visible(/^晨报/u).click()
        await view.locator('.turn-reply .assistant-meta-person').first().waitFor()
        await expectPersonOnly(view)
        await shoot(view, `topic-${width}-${scheme}`)
        if (phone) {
          await view.getByRole('button', { name: '返回', exact: true }).filter({ visible: true }).first().click()
          await visible(/^小抄/u).click()
          const warning = view.getByRole('button', { name: '权限没确认：说明', exact: true }).filter({ visible: true }).first()
          await warning.getByText('权限没确认', { exact: true }).waitFor()
          expect(await warning.locator('span').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
          const header = await view.locator('.topbar-frame').filter({ visible: true }).boundingBox()
          const body = await view.locator('.transcript').filter({ visible: true }).boundingBox()
          expect(header && body && header.y + header.height <= body.y + 1).toBe(true)
          await warning.click()
          expect(await view.locator('.agent-boundary-detail').filter({ visible: true }).innerText()).toContain('Latch 也不隔离它')
          await shoot(view, `permission-${width}-${scheme}`)
        }
        await wide.close()
      }
    }

    // These are actual Harness states: the person sees the same pending approval and failed turn as the Host.
    const stateShots = async (state: string) => {
      for (const [width, height, colorScheme] of [
        [390, 844, 'dark'],
        [768, 1024, 'light'],
        [1440, 900, 'light'],
      ] as const) {
        await page.setViewportSize({ width, height })
        await page.emulateMedia({ colorScheme })
        await shoot(page, `${state}-${width}-${colorScheme}`)
      }
    }
    await commandInput.fill('permission')
    await commandInput.press('Meta+Enter')
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${scribeSession.id}`)).approvals.length).toBe(1)
    const approvalId = (await owner.json<TaskDetail>(`tasks/${scribeSession.id}`)).approvals[0]!.id
    const approval = page.locator(`[data-approval-id="${approvalId}"]`).filter({ visible: true })
    await expect.poll(() => approval.getByRole('button', { name: '拒绝', exact: true }).isEnabled()).toBe(true)
    expect(await approval.innerText()).toContain('小抄')
    await stateShots('topic-approval')
    expect((await owner.json<TaskDetail>(`tasks/${scribeSession.id}`)).approvals[0]!.id).toBe(approvalId)
    await approval.getByRole('button', { name: '拒绝', exact: true }).click()
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${scribeSession.id}`)).summary.status).toBe('idle')
    await commandInput.fill('endturn')
    await commandInput.press('Meta+Enter')
    await page.getByText('在跑命令', { exact: true }).filter({ visible: true }).first().waitFor()
    // The frame says what it does once; under the turn nothing is drawn while it runs.
    await expect.poll(() => page.locator('.status-line').filter({ visible: true }).allTextContents()).toEqual([])
    await stateShots('topic-running')
    await page.getByRole('button', { name: '停止', exact: true }).filter({ visible: true }).click()
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${scribeSession.id}`)).summary.status).toBe('cancelled')
    await writeFile(replyQueue, JSON.stringify([{ error: 'fixture unavailable' }]))
    await commandInput.fill('再试一轮')
    await commandInput.press('Meta+Enter')
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${scribeSession.id}`)).summary.status).toBe('failed')
    await page.getByText('Fake Agent 还没登录 · 登录后重试', { exact: true }).waitFor()
    await stateShots('topic-login')
    await page
      .getByRole('button', { name: /^晨报/u })
      .filter({ visible: true })
      .first()
      .click()
    await commandInput.fill('失败一轮')
    await commandInput.press('Meta+Enter')
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${first!.id}`)).summary.status).toBe('failed')
    await page.getByText(/晨报 没能回复：.*本地验收模型暂时不可用/u).waitFor()
    await stateShots('topic-failed')
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined)
    await browser.close()
    await host.close()
  }
})
