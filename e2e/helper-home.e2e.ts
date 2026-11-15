import { chromium, type Page } from '@playwright/test'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { AppSnapshot, AutomationDetail, CustomAgent, CustomAgentList, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, reachable } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'

const OUT = 'test-results/helper-home'
const pick = (page: Page, name: string) =>
  page
    .getByRole('menuitemradio', { name, exact: true })
    .or(page.getByRole('radio', { name, exact: true }))
    .filter({ visible: true })
    .first()

const writer: HarnessPlugin = {
  id: 'home-writer',
  name: 'Home writer',
  version: '1',
  description: '',
  activate(context) {
    context.registerProvider({
      id: 'home-writer',
      name: 'Home writer',
      model: 'fixture',
      async *stream({ messages }) {
        if (messages.some(message => message.role === 'tool')) {
          yield { type: 'text', text: '已写 notes.md' }
          yield { type: 'finish', reason: 'stop' }
        } else {
          yield {
            type: 'tool-call',
            call: { id: 'write-home', name: 'write_file', arguments: { path: 'notes.md', content: 'Private home note' } },
          }
          yield { type: 'finish', reason: 'tool-calls' }
        }
      },
    })
  },
}

it('keeps the original approval on a real home write through responsive views before the file exists', async () => {
  await mkdir(OUT, { recursive: true })
  const host = await startTestHost({ hostName: '工作 Mac', plugins: [writer] })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  try {
    await stillMotion(context)
    const owner = await host.enroll({ listener: 'unix' })
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '守家',
        description: '',
        harnessId: 'standard',
        mode: 'agent',
        model: { providerId: 'home-writer', model: 'fixture' },
        instructions: '',
        skills: [],
      },
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { name: '家的审批' })
    const device = host.host.security.devices.list().find(item => item.name === '家的审批')!
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    await page.reload()
    await connected(page)
    await page.getByRole('radio', { name: '我的 Agent', exact: true }).filter({ visible: true }).click()
    await page
      .getByRole('navigation', { name: '我的 Agent', exact: true })
      .getByRole('button', { name: /守家/u })
      .first()
      .click()
    const input = page.getByRole('textbox', { name: '给守家发消息', exact: true })
    await input.fill('请写入 notes.md')
    await input.press('Meta+Enter')
    const topics = async () => (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.agent?.customAgentId === agent.id)
    await expect.poll(async () => (await topics())[0]?.status).toBe('waiting-approval')
    const task = (await topics())[0]!
    const detail = await owner.json<TaskDetail>(`tasks/${task.id}`)
    const approval = detail.approvals[0]!
    const file = join(host.workspaceRoot, 'helpers', agent.id, 'notes.md')
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const width of [320, 390, 768, 1440])
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 1024 })
        await page.emulateMedia({ colorScheme })
        const card = page.locator(`[data-approval-id="${approval.id}"]`).filter({ visible: true })
        await expect.poll(() => card.getByRole('button', { name: '允许', exact: true }).isEnabled()).toBe(true)
        await shot(page, `home-approval-${width}-${colorScheme}`)
        expect((await owner.json<TaskDetail>(`tasks/${task.id}`)).approvals.map(item => item.id)).toEqual([approval.id])
      }
    await page
      .locator(`[data-approval-id="${approval.id}"]`)
      .filter({ visible: true })
      .getByRole('button', { name: '允许', exact: true })
      .click()
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${task.id}`)).summary.runOutcome).toBe('completed')
    expect(await readFile(file, 'utf8')).toBe('Private home note')
    await expect(stat(join(host.workspaceRoot, 'notes.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await context.close()
    await browser.close()
    await host.close()
  }
})

async function shot(page: Page, name: string) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => undefined)),
    ),
  )
  await page.evaluate(() => document.fonts.ready)
  await noHorizontalOverflow(page)
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled' })
}

it.each(['native', 'chat'] as const)(
  'keeps a legacy %s General start unknown across retries and refresh until the person abandons it',
  async kind => {
    const host = await startTestHost()
    const browser = await chromium.launch(browserLaunchOptions())
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      await enrollBrowser(page, host, { name: '旧通用待确认' })
      const device = host.host.security.devices.list().find(item => item.name === '旧通用待确认')!
      await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
      const legacy = {
        requestId: randomUUID(),
        prompt: '之前发送的通用消息',
        customAgentId: 'general',
        harnessId: kind === 'native' ? 'legacy-native' : 'standard',
        mode: kind === 'native' ? ('agent' as const) : ('chat' as const),
        workspaceId: 'default',
        ...(kind === 'chat' ? { model: { providerId: 'demo', model: 'demo' } } : {}),
      }
      const existing: string[] = []
      if (kind === 'chat') {
        const old = await host.host.bridge.createTask({
          ...legacy,
          cwd: host.workspaceRoot,
          generalChat: true,
          agentContext: { instructions: '', revision: '1'.repeat(64), proposals: true },
        })
        await expect.poll(async () => (await host.host.bridge.detail(old.sessionId)).summary.status, { timeout: 8000 }).toBe('idle')
        existing.push(old.sessionId)
      }
      // This is the previous client's persisted pending shape, not an authorization or a fabricated Host receipt.
      const key = await page.evaluate(
        ({ id, legacy }) => {
          const key = `latch.delegation.${location.origin}.${id}`
          localStorage.setItem(key, JSON.stringify(legacy))
          return key
        },
        { id: device.id, legacy },
      )
      const requests: Array<{ requestId: string; harnessId?: string }> = []
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/link/api/tasks')
          requests.push(request.postDataJSON() as (typeof requests)[number])
      })
      const openGeneral = async () => {
        await page.reload()
        await connected(page)
        await page.getByRole('radio', { name: '我的 Agent', exact: true }).filter({ visible: true }).click()
        await page
          .getByRole('navigation', { name: '我的 Agent', exact: true })
          .getByRole('button', { name: /^通用/u })
          .first()
          .click()
        if (existing.length) {
          await page.getByRole('button', { name: '话题', exact: true }).filter({ visible: true }).click()
          await page.getByRole('menuitemradio', { name: /新话题/u }).click()
        }
      }
      for (let index = 0; index < 2; index++) {
        await openGeneral()
        await page.getByRole('button', { name: '重试这次提交', exact: true }).waitFor()
        const response = page.waitForResponse(
          response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/link/api/tasks',
        )
        await page.getByRole('button', { name: '重试这次提交', exact: true }).click()
        const reply = await response
        await reply.finished()
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown, key)).toEqual(legacy)
        expect(reply.status()).toBe(503)
        expect(await reply.json()).toMatchObject({ error: 'general-start-unconfirmed' })
        await page.getByRole('button', { name: '重试这次提交', exact: true }).waitFor()
        expect((await owner.json<AppSnapshot>('snapshot')).tasks.map(task => task.id)).toEqual(existing)
      }
      expect(requests.map(item => [item.requestId, item.harnessId])).toEqual([
        [legacy.requestId, legacy.harnessId],
        [legacy.requestId, legacy.harnessId],
      ])
      await page.getByRole('button', { name: '放弃这次提交', exact: true }).click()
      await expect.poll(() => page.evaluate(key => localStorage.getItem(key), key)).toBeNull()
      expect(requests).toHaveLength(2)
      expect((await owner.json<AppSnapshot>('snapshot')).tasks.map(task => task.id)).toEqual(existing)
    } finally {
      await context.close()
      await browser.close()
      await host.close()
    }
  },
)

it('keeps one profile, unsaved defaults, focus and an unknown write across desktop and phone presentations', async () => {
  const host = await startTestHost({ hostName: '工作 Mac' })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: {
        id: 'profile-agent',
        name: '配置夹具',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'build,plan' },
      },
    })
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '保留设置',
        description: '',
        harnessId: 'profile-agent',
        mode: 'agent',
        instructions: '',
        skills: [],
      },
    })
    const task = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: {
        customAgentId: agent.id,
        requestId: randomUUID(),
        prompt: 'echo seed',
      },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${task.sessionId}`)).summary.status).toBe('idle')
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { name: '资料跨断点' })
    const device = host.host.security.devices.list().find(item => item.name === '资料跨断点')!
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    await page.reload()
    await connected(page)
    await page.getByRole('radio', { name: '我的 Agent', exact: true }).filter({ visible: true }).click()
    await page
      .getByRole('navigation', { name: '我的 Agent', exact: true })
      .getByRole('button', { name: /保留设置/u })
      .first()
      .click()
    await page.getByRole('button', { name: '保留设置 的资料', exact: true }).filter({ visible: true }).click()
    const panel = page.locator('.agent-profile').filter({ visible: true })
    await panel.getByRole('button', { name: '设置', exact: true }).click()
    await panel.getByLabel('名称', { exact: true }).fill('尚未保存')
    await panel.getByLabel('指令', { exact: true }).fill('跨断点仍然保留这份草稿')
    await panel.locator('button.thinking-picker').click()
    await pick(page, 'High').click()
    await panel.locator('button.model-picker').click()
    await pick(page, 'Large').click()
    await panel.locator('button.chip-permission').click()
    await pick(page, 'plan').click()
    const textarea = await panel.getByLabel('指令', { exact: true }).elementHandle()
    await panel.getByLabel('指令', { exact: true }).focus()
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1024 })
      await page.locator(`.app-shell[data-viewport="${width < 768 ? 'phone' : width < 1024 ? 'tablet' : 'desktop'}"]`).waitFor()
      await expect.poll(() => page.evaluate(element => element?.isConnected === true, textarea)).toBe(true)
      expect(await panel.getByLabel('名称', { exact: true }).inputValue()).toBe('尚未保存')
      expect(await panel.getByLabel('指令', { exact: true }).inputValue()).toBe('跨断点仍然保留这份草稿')
      expect(await panel.locator('button.model-picker').innerText()).toContain('Large')
      expect(await panel.locator('button.chip-permission').innerText()).toContain('plan')
      await expect
        .poll(() =>
          page.evaluate(element => {
            if (!element || document.activeElement !== element || element.closest('[inert]') || !element.checkVisibility()) return false
            const modal = document.querySelector('dialog:modal')
            return !modal || modal.contains(element)
          }, textarea),
        )
        .toBe(true)
      expect(await page.locator('.agent-profile').count()).toBe(1)
    }
    const writes: string[] = []
    await page.route(`**/link/api/custom-agents/${agent.id}`, async route => {
      if (route.request().method() !== 'PATCH') return route.continue()
      writes.push((route.request().postDataJSON() as { requestId: string }).requestId)
      if (writes.length > 1) return route.continue()
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      await route.abort('failed')
    })
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await panel.getByRole('button', { name: '重试同一请求', exact: true }).waitFor()
    for (const width of [390, 1440, 768]) {
      await page.setViewportSize({ width, height: 1024 })
      await panel.getByRole('button', { name: '重试同一请求', exact: true }).waitFor()
      expect(writes).toHaveLength(1)
      expect(await page.locator('.agent-profile').count()).toBe(1)
    }
    await panel.getByRole('button', { name: '重试同一请求', exact: true }).click()
    await expect.poll(() => writes.length).toBe(2)
    expect(writes[1]).toBe(writes[0])
    await panel.getByRole('button', { name: '重试同一请求', exact: true }).waitFor({ state: 'hidden' })
    const saved = (await owner.json<CustomAgentList>('custom-agents')).agents.find(item => item.id === agent.id)!
    expect(saved).toMatchObject({
      name: '尚未保存',
      revision: agent.revision + 1,
      engineOptions: { model: 'large', effort: 'high', mode: 'plan' },
    })
    await panel.getByRole('button', { name: '尚未保存', exact: true }).click()
    await panel.getByRole('radio', { name: '记忆', exact: true }).click()
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1024 })
      await expect.poll(() => panel.getByRole('radio', { name: '记忆', exact: true }).getAttribute('aria-checked')).toBe('true')
    }
    await panel.getByRole('button', { name: '关闭资料', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('agent-frame-who'))).toBe(true)
    expect(await page.locator('.agent-profile').count()).toBe(0)
    await page.getByRole('button', { name: '尚未保存 的资料', exact: true }).filter({ visible: true }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.agent-profile-sheet').waitFor({ state: 'visible' })
    await page.locator('.agent-profile-sheet').getByRole('button', { name: '完成', exact: true }).click()
    await page.locator('.agent-profile-sheet').waitFor({ state: 'hidden' })
    await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('agent-frame-who'))).toBe(true)
    expect(await page.locator('.agent-profile').count()).toBe(0)
  } finally {
    await context.close()
    await browser.close()
    await host.close()
  }
})

it.each([false, true])('saves native defaults and retains the same home; permission refusal %s', async sticky => {
  await mkdir(OUT, { recursive: true })
  const host = await startTestHost({ hostName: '工作 Mac' })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  try {
    await stillMotion(context)
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const owner = await host.enroll({ listener: 'unix' })
    const log = join(host.root, 'home-agent.jsonl')
    await owner.confirmedJson('agents', {
      method: 'POST',
      body: {
        id: 'home-agent',
        name: '配置夹具',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: {
          FAKE_ACP_LOG: log,
          FAKE_ACP_CONFIG: 'options',
          FAKE_ACP_MODES: 'build,plan',
          ...(sticky ? { FAKE_ACP_STICKY_MODE: '1' } : {}),
        },
      },
    })
    await enrollBrowser(page, host, { name: '家的设置' })
    const device = host.host.security.devices.list().find(item => item.name === '家的设置')!
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    await page.reload()
    await connected(page)
    await page.getByRole('radio', { name: '我的 Agent', exact: true }).filter({ visible: true }).click()
    await page.locator('button:not([inert] *):visible', { hasText: '新建 Agent' }).first().click()
    await page.getByRole('list', { name: '候选' }).getByRole('button', { name: '配置夹具', exact: true }).click()
    const form = page.getByRole('form', { name: '新建 Agent' })
    await form.getByLabel('名字', { exact: true }).fill('守家')
    await form.getByRole('button', { name: '创建', exact: true }).click()
    await page.getByRole('textbox', { name: '给守家发消息', exact: true }).waitFor()
    const agent = (await owner.json<CustomAgentList>('custom-agents')).agents.find(item => item.name === '守家')!
    const topics = async () => (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.agent?.customAgentId === agent.id)
    const send = async (count: number, status = 'idle') => {
      const input = page.getByRole('textbox', { name: '给守家发消息', exact: true })
      await input.fill(`echo topic ${count}`)
      await input.press('Meta+Enter')
      await expect.poll(async () => (await topics()).length).toBe(count)
      const task = (await topics()).toSorted((a, b) => (b.createdAt ?? b.updatedAt).localeCompare(a.createdAt ?? a.updatedAt))[0]!
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${task.id}`)).summary.status).toBe(status)
      return task.id
    }
    const openSettings = async () => {
      await page.getByRole('button', { name: '守家 的资料', exact: true }).filter({ visible: true }).click()
      const panel = page.getByRole('region', { name: '守家 的资料', exact: true })
      await panel.getByRole('button', { name: '设置', exact: true }).click()
      await panel.getByRole('form', { name: '守家 的设置', exact: true }).waitFor()
      return panel
    }
    const newTopic = async () => {
      await page.getByRole('button', { name: '关闭资料', exact: true }).filter({ visible: true }).click()
      await page.getByRole('button', { name: '话题', exact: true }).filter({ visible: true }).click()
      await page.getByRole('menuitemradio', { name: /新话题/u }).click()
    }
    const first = await send(1)
    const initial = await owner.json<TaskDetail>(`tasks/${first}`)
    expect(initial.summary.cwd).toBe(join(host.workspaceRoot, 'helpers', agent.id))
    let panel = await openSettings()
    await panel.locator('button.model-picker').click()
    await pick(page, 'Large').click()
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect
      .poll(
        async () => (await owner.json<CustomAgentList>('custom-agents')).agents.find(item => item.id === agent.id)?.engineOptions?.model,
      )
      .toBe('large')
    await newTopic()
    const second = await send(2)
    expect((await owner.json<TaskDetail>(`tasks/${second}`)).config?.find(item => item.category === 'model')?.currentValue).toBe('large')
    panel = await openSettings()
    await panel.locator('button.thinking-picker').click()
    await pick(page, 'High').click()
    await panel.locator('button.chip-permission').click()
    await pick(page, 'plan').click()
    await panel.getByRole('button', { name: '保存', exact: true }).click()
    await expect
      .poll(async () => (await owner.json<CustomAgentList>('custom-agents')).agents.find(item => item.id === agent.id)?.engineOptions)
      .toEqual({ model: 'large', effort: 'high', mode: 'plan' })
    if (!sticky)
      for (const width of [320, 390, 768, 1440])
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.setViewportSize({ width, height: width === 1440 ? 900 : 1024 })
          await page.emulateMedia({ colorScheme })
          await page.locator('.agent-profile-sheet').waitFor({ state: width < 768 ? 'visible' : 'hidden' })
          // Enter Settings through this viewport's profile presentation; breakpoint-state retention is checked separately.
          if (!(await panel.getByRole('form', { name: '守家 的设置', exact: true }).isVisible()))
            await panel.getByRole('button', { name: '设置', exact: true }).click()
          await panel.locator('.agent-profile-body').evaluate(element => {
            element.scrollTop = 0
          })
          await shot(page, `settings-${width}-${colorScheme}`)
          await panel.locator('button.chip-permission').click()
          await pick(page, 'plan').waitFor()
          await shot(page, `permission-${width}-${colorScheme}`)
          await page.keyboard.press('Escape')
        }
    await newTopic()
    const third = await send(3, sticky ? 'failed' : 'idle')
    const detail = await owner.json<TaskDetail>(`tasks/${third}`)
    expect(detail.summary.cwd).toBe(initial.summary.cwd)
    expect(detail.config?.map(item => [item.id, item.currentValue])).toEqual(
      expect.arrayContaining([
        ['model', 'large'],
        ['effort', 'high'],
        ['mode', sticky ? 'build' : 'plan'],
      ]),
    )
    expect((await owner.json<TaskDetail>(`tasks/${first}`)).config?.find(item => item.id === 'model')?.currentValue).toBe('small')
    const events = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { event: string; mode?: string })
    expect(events.filter(event => event.event === 'prompt-mode')).toHaveLength(sticky ? 2 : 3)
    if (sticky) {
      await page.getByRole('button', { name: '权限没确认：说明', exact: true }).filter({ visible: true }).waitFor()
      await page.getByText('权限没确认，修改默认选项后开新话题', { exact: true }).waitFor()
      expect(await page.getByRole('textbox', { name: '继续对话', exact: true }).filter({ visible: true }).count()).toBe(0)
      for (const width of [320, 390, 768, 1440])
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.setViewportSize({ width, height: width === 1440 ? 900 : 1024 })
          await page.emulateMedia({ colorScheme })
          await shot(page, `permission-unconfirmed-${width}-${colorScheme}`)
        }
    } else {
      expect(events.filter(event => event.event === 'prompt-mode').at(-1)?.mode).toBe('plan')
      panel = await openSettings()
      await panel.getByRole('button', { name: '守家', exact: true }).click()
      await panel.getByRole('button', { name: '新建定时', exact: true }).click()
      await panel.getByRole('button', { name: '新建定时', exact: true }).click()
      const schedule = panel.getByRole('form', { name: '新建定时任务', exact: true })
      await schedule.getByLabel('名称', { exact: true }).fill('人工整理')
      await schedule.getByLabel('每次的输入', { exact: true }).fill('echo manual task')
      await schedule.getByRole('button', { name: '保存为关闭', exact: true }).click()
      const card = panel.getByRole('listitem', { name: '人工整理', exact: true })
      await card.waitFor()
      expect(await card.getByRole('button', { name: '继续', exact: true }).isDisabled()).toBe(true)
      expect(await card.getByRole('button', { name: '立即运行', exact: true }).isEnabled()).toBe(true)
      expect(await topics()).toHaveLength(3)
      const automatic = (await owner.json<AppSnapshot>('snapshot')).automations!.find(item => item.name === '人工整理')!
      expect(automatic.enabled).toBe(false)
      await page.locator('.agent-frame').getByRole('button', { name: '1 个定时任务', exact: true }).waitFor()
      await card.getByRole('button', { name: '立即运行', exact: true }).click()
      await expect
        .poll(async () => (await owner.json<AutomationDetail>(`automations/${automatic.id}`)).automation.lastRun?.state, { timeout: 8000 })
        .toBe('completed')
      const completed = (await owner.json<AutomationDetail>(`automations/${automatic.id}`)).automation
      expect(completed).toMatchObject({ enabled: false, state: 'off', lastRun: { trigger: 'manual' } })
      expect(completed.nextRunAt).toBeUndefined()
      const actual = await owner.json<TaskDetail>(`tasks/${completed.lastRun!.sessionId}`)
      expect(actual.summary.cwd).toBe(initial.summary.cwd)
      expect(actual.config?.map(item => [item.id, item.currentValue])).toEqual(
        expect.arrayContaining([
          ['model', 'large'],
          ['effort', 'high'],
          ['mode', 'plan'],
        ]),
      )
      for (const width of [320, 390, 768, 1440])
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.setViewportSize({ width, height: width === 1440 ? 900 : 1024 })
          await page.emulateMedia({ colorScheme })
          await card.waitFor()
          await shot(page, `manual-task-${width}-${colorScheme}`)
        }
      await panel.getByRole('button', { name: '关闭资料', exact: true }).click()
      await page.setViewportSize({ width: 768, height: 1024 })
      const frame = page.locator('.agent-frame').filter({ visible: true })
      const scheduleChip = frame.getByRole('button', { name: '1 个定时任务', exact: true })
      await reachable(scheduleChip)
      const room = await scheduleChip.locator('.agent-schedule-words').evaluate(element => {
        const label = element.textContent
        try {
          // The Host can hold at most 128 schedules, the widest count the chip needs to show.
          element.textContent = '128 个定时任务'
          return element.clientWidth >= element.scrollWidth
        } finally {
          element.textContent = label
        }
      })
      expect(room).toBe(true)
      await noHorizontalOverflow(page, frame)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await shot(page, `schedule-chip-768-${colorScheme}`)
      }
      await scheduleChip.click()
      await card.waitFor()
    }
  } finally {
    await context.close()
    await browser.close()
    await host.close()
  }
})
