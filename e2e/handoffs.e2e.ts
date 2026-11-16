import { chromium, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { HandoffList, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { backToPhoneSessions, noHorizontalOverflow } from './helpers/layout.ts'

const OUT = process.env.LATCH_HANDOFF_SHOTS ?? 'test-results/handoffs'

/** A local model service, so the built-in Harness answers in the source session without the demo model. */
const fixture: HarnessPlugin = {
  id: 'handoff-fixture',
  name: 'Handoff fixture',
  version: '1',
  description: '',
  activate(context) {
    context.registerProvider({
      id: 'handoff-fixture',
      name: 'Handoff fixture',
      model: 'fixture',
      async *stream() {
        yield { type: 'text', text: '建议：用 ECB 汇率接口，每天缓存一次。' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
}

/** The same state at other widths and schemes, then back to 1440 light. */
async function shoot(page: Page, name: string, sizes: ReadonlyArray<readonly [number, 'light' | 'dark']>) {
  const desktopDepth = await page.evaluate(() => (history.state as { latchLayer?: number } | null)?.latchLayer ?? 0)
  for (const [width, scheme] of sizes) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
    // The page settles into the new layout: a session pushed over the phone list slides in first.
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined)))
    })
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUT}/${name}-${scheme}-${width}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1440, height: 900 })
  // The phone layer gives back its history entry after React switches layouts.
  await page.waitForFunction(
    depth =>
      document.querySelector('.app-shell[data-viewport="desktop"]') !== null
      && ((history.state as { latchLayer?: number } | null)?.latchLayer ?? 0) === depth,
    desktopDepth,
  )
}

async function browserWithScope(page: Page, host: TestHost, owner: TestDevice, name: string, dataScope: 'work' | 'all') {
  await enrollBrowser(page, host, { name })
  const id = host.host.security.devices.list().find(device => device.name === name)!.id
  expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope } })).status).toBe(200)
  await page.reload()
  await connected(page)
}

const choice = (page: Page, name: RegExp) => page.getByRole('menuitemradio', { name }).or(page.getByRole('radio', { name })).first()

/** Opens a session from the list, on any width. */
async function open(page: Page, sessionId: string, title?: string) {
  if (
    title
    && (
      await page
        .locator('.topbar h1')
        .first()
        .textContent()
        .catch(() => null)
    )?.startsWith(title.slice(0, 6))
  )
    return
  const row = page.locator(`[data-task-id="${sessionId}"]:visible`).first()
  if ((page.viewportSize()?.width ?? 1440) < 768 && (await page.locator('main[data-pushed]').count())) await backToPhoneSessions(page)
  await row.click()
  await page.locator(`.transcript [data-message-id]`).first().waitFor()
}

/** 交给代码任务… from the newest reply's ⋯. */
async function handOffReply(page: Page) {
  const turn = page.locator('.turn').last()
  await turn.hover()
  await turn.getByRole('button', { name: '这一轮的更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '交给代码任务…', exact: true }).click()
  return page.getByRole('group', { name: '交给代码任务', exact: true })
}

const chip = (card: Locator, name: string) => card.locator('.handoff-chip', { hasText: name })

it('hands a reply and a file to a new code session, takes its result back, and cuts what a smaller scope reads', async () => {
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
    const folder = join(host.root, 'ledger')
    await mkdir(folder)
    await writeFile(join(folder, 'rates.md'), '# 三家汇率接口\n\nECB：免费，工作日更新。\n')
    expect((await owner.addFolders({ paths: [folder], name: 'ledger' })).status).toBeLessThan(300)
    const project = (await owner.json<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces.find(item => item.name === 'ledger')!
    // The built-in Harness names the folder by its own ID; the fake ACP Agent calls it `default`.
    const root = project.folders![0]!.id

    // The source: a built-in session in the project whose prompt names a file; the target runs on the fake ACP Agent.
    const { sessionId: sourceId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: {
        prompt: '比较三家汇率接口',
        mode: 'agent',
        harnessId: 'standard',
        model: { providerId: 'handoff-fixture', model: 'fixture' },
        workspaceId: project.id,
        fileRefs: [{ root, path: 'rates.md' }],
        requestId: randomUUID(),
      },
    })
    await expect.poll(async () => (await host.host.bridge.detail(sourceId)).summary.status, { timeout: 15_000 }).toBe('idle')
    const sourceTitle = (await host.host.bridge.detail(sourceId)).summary.title

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await browserWithScope(page, host, owner, '交接 1440', 'all')
    await open(page, sourceId)

    // Keys alone: the person's message's action opens the card with the keys in 要求, Tab walks the card to its button,
    // and Escape closes it and puts the keys back on the action. Reduced motion: nothing in the card animates.
    const action = page.locator('.message-user').first().getByRole('button', { name: '交给代码任务…', exact: true })
    await action.focus()
    await page.keyboard.press('Enter')
    const keyed = page.getByRole('group', { name: '交给代码任务', exact: true })
    await chip(keyed, '你的消息').waitFor()
    await expect.poll(() => keyed.getByLabel('要求', { exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
    expect(
      await keyed.evaluate(element => element.getAnimations({ subtree: true }).filter(item => item.playState === 'running').length),
    ).toBe(0)
    const walked: string[] = []
    for (let step = 0; step < 12 && !walked.includes('button:交给 ledger'); step++) {
      await page.keyboard.press('Tab')
      walked.push(
        await page.evaluate(() => {
          const focused = document.activeElement as HTMLElement | null
          if (!focused?.closest('.handoff-card')) return 'outside'
          return `${focused.tagName.toLowerCase()}:${focused.getAttribute('aria-label') ?? focused.textContent?.trim() ?? ''}`
        }),
      )
    }
    expect(walked).not.toContain('outside')
    expect(walked.at(-1)).toBe('button:交给 ledger')
    await page.keyboard.press('Escape')
    await keyed.waitFor({ state: 'detached' })
    expect(await action.evaluate(element => element === document.activeElement)).toBe(true)

    // The card opens inline above the composer with the reply and the file its turn named, each pinned.
    const card = await handOffReply(page)
    await chip(card, 'Agent 的回复').waitFor()
    await chip(card, 'rates.md').waitFor()
    await card.getByRole('button', { name: /^Harness：/u }).click()
    await choice(page, /Fake Agent/u).click()
    await card.getByLabel('要求', { exact: true }).fill('接入每日汇率，失败时显示上次的汇率')
    await card.getByRole('button', { name: '已定的决定', exact: true }).click()
    await card.getByLabel('决定 1', { exact: true }).fill('用 ECB')
    const send = card.getByRole('button', { name: '交给 ledger', exact: true })
    await expect.poll(() => send.isEnabled()).toBe(true)
    await page.screenshot({ path: `${OUT}/card-1440.png` })
    await shoot(page, 'card', [
      [768, 'light'],
      [320, 'light'],
      [390, 'dark'],
    ])

    // The file changes after it was chosen: the Host refuses and the card names the chip.
    await writeFile(join(folder, 'rates.md'), '# 三家汇率接口\n\nECB：免费，工作日更新。\n补充：每天 16:00 发布。\n')
    await send.click()
    await card.getByText('「rates.md」在选定之后变化了').waitFor()
    expect((await owner.json<HandoffList>(`handoffs?sessionId=${sourceId}`)).handoffs).toHaveLength(0)
    await page.screenshot({ path: `${OUT}/material-changed-1440.png` })
    await shoot(page, 'material-changed', [[390, 'dark']])
    await card.getByRole('button', { name: '用现在的版本', exact: true }).click()
    await expect.poll(() => send.isEnabled()).toBe(true)

    // A double click makes one target.
    await send.dblclick()
    await page
      .getByRole('group', { name: '交接', exact: true })
      .getByText('代码会话在做')
      .waitFor()
      .catch(async (error: unknown) => {
        await page.screenshot({ path: `${OUT}/failed-start.png` })
        console.log(JSON.stringify(await owner.json(`handoffs?sessionId=${sourceId}`)))
        throw error
      })
    const { handoffs } = await owner.json<HandoffList>(`handoffs?sessionId=${sourceId}`)
    expect(handoffs).toHaveLength(1)
    const handoff = handoffs[0]!
    expect(handoff).toMatchObject({ status: 'started', returnScope: 'summary-and-evidence', decisions: ['用 ECB'] })
    const targetId = handoff.targetSessionId!
    expect(await host.host.bridge.listTasks()).toHaveLength(2)

    // The target's first message carries the requirements, the decision and the material, with the file as a reference.
    const first = (await host.host.bridge.detail(targetId)).messages.find(message => message.role === 'user')!
    expect(first.text).toContain('接入每日汇率，失败时显示上次的汇率')
    expect(first.text).toContain('用 ECB')
    expect(first.text).toContain('建议：用 ECB 汇率接口，每天缓存一次。')
    // Under the ACP Agent's own name for the folder, and titled after the requirements.
    expect(first.fileRefs).toEqual([{ root: 'default', path: 'rates.md' }])
    const targetTitle = (await host.host.bridge.listTasks()).find(task => task.id === targetId)?.title
    expect(targetTitle).toBe('接入每日汇率，失败时显示上次的汇率')
    await page.locator(`[data-task-id="${targetId}"]`).first().getByText(targetTitle!, { exact: true }).waitFor()
    await expect.poll(async () => (await host.host.bridge.detail(targetId)).summary.status, { timeout: 15_000 }).toBe('idle')

    // The list marks the target while its result waits to be handed back.
    await page.locator(`[data-task-id="${targetId}"]`).first().locator('.session-handoff', { hasText: '待交回' }).waitFor()

    // In the target: 来自 <source> in the header, then 交回结果 with the last reply and ticked evidence.
    await page
      .getByRole('group', { name: '交接', exact: true })
      .getByRole('button', { name: /^打开/u })
      .click()
    await page
      .locator('.topbar')
      .getByRole('button', { name: new RegExp(`来自 ${sourceTitle.slice(0, 4)}`, 'u') })
      .waitFor()
    await page.getByRole('button', { name: '交回结果', exact: true }).click()
    const back = page.getByRole('group', { name: '交回结果', exact: true })
    expect(await back.getByLabel('结论', { exact: true }).inputValue()).not.toBe('')
    await back.getByLabel('结论', { exact: true }).fill('已接入 ECB 每日汇率，缓存 24 小时。')
    await back.getByRole('checkbox', { name: 'rates.md', exact: true }).check()
    await back
      .getByRole('checkbox', { name: /^回复 · /u })
      .first()
      .check()
    await page.screenshot({ path: `${OUT}/return-1440.png` })
    await shoot(page, 'return', [
      [320, 'light'],
      [390, 'dark'],
    ])
    await back.getByRole('button', { name: '交回', exact: true }).click()
    await page.getByText('已交回', { exact: true }).waitFor()
    const returned = (await owner.json<HandoffList>(`handoffs?sessionId=${sourceId}`)).handoffs[0]!
    expect(returned.status).toBe('returned')
    expect(returned.result?.evidence.map(item => item.kind)).toEqual(['file', 'message'])
    await expect.poll(() => page.locator(`[data-task-id="${targetId}"] .session-handoff`).count()).toBe(0)

    // Back in the source: 交回的结果 where it arrived, with links that open the file and the message.
    await page
      .locator('.topbar')
      .getByRole('button', { name: /^来自/u })
      .click()
    const result = page.getByRole('group', { name: '交回的结果', exact: true })
    await result.getByText('已接入 ECB 每日汇率，缓存 24 小时。').waitFor()
    await page.screenshot({ path: `${OUT}/returned-1440.png` })
    await result.getByRole('button', { name: '带入输入框', exact: true }).click()
    await expect.poll(() => page.getByRole('textbox', { name: '继续对话', exact: true }).inputValue()).toContain('> 已接入 ECB 每日汇率')
    await result.getByRole('button', { name: 'rates.md', exact: true }).click()
    await page.locator('.file-preview').getByText('补充：每天 16:00 发布。').waitFor()
    await page.locator(`[data-task-id="${sourceId}"]`).first().click()
    await result.getByRole('button', { name: '代码会话里的一条消息', exact: true }).click()
    await expect.poll(() => page.locator('.topbar h1').first().textContent()).not.toBe(sourceTitle)

    for (const width of [390, 768, 1440])
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await connected(page)
        await open(page, sourceId, sourceTitle)
        await page.getByRole('group', { name: '交回的结果', exact: true }).scrollIntoViewIfNeeded()
        await noHorizontalOverflow(page)
        await page.screenshot({ path: `${OUT}/returned-${scheme}-${width}.png` })
      }
    await page.emulateMedia({ colorScheme: 'light' })

    // A phone opens the card from the person's own message; it fits without sideways scrolling.
    await page.setViewportSize({ width: 390, height: 844 })
    const prompt = page.locator('.message-user').first()
    await prompt.click()
    await prompt.getByRole('button', { name: '交给代码任务…', exact: true }).click()
    const phoneCard = page.getByRole('group', { name: '交给代码任务', exact: true })
    await chip(phoneCard, '你的消息').waitFor()
    await noHorizontalOverflow(page)
    await page.screenshot({ path: `${OUT}/card-390.png` })

    // To the existing code session instead; the answer is lost on the way, so the card keeps the request: 查询 finds it.
    await page.setViewportSize({ width: 1440, height: 900 })
    await phoneCard.getByRole('radio', { name: '已有会话', exact: true }).click()
    await phoneCard.getByRole('button', { name: /^已有会话/u }).click()
    await choice(page, /接入每日汇率/u).click()
    await phoneCard.getByLabel('要求', { exact: true }).fill('失败时再加一行提示')
    await page.route('**/link/api/handoffs', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      await route.fetch()
      return route.abort('connectionreset')
    })
    await phoneCard.getByRole('button', { name: /^交给「/u }).focus()
    await page.keyboard.press('Enter')
    await phoneCard.getByText('交接结果未知', { exact: true }).waitFor()
    await phoneCard.getByRole('button', { name: '重试同一请求', exact: true }).waitFor()
    await page.screenshot({ path: `${OUT}/unknown-1440.png` })
    await shoot(page, 'unknown', [[390, 'dark']])
    await page.unroute('**/link/api/handoffs')
    await phoneCard.getByRole('button', { name: '查询', exact: true }).click()
    await phoneCard.waitFor({ state: 'detached' })
    const both = (await owner.json<HandoffList>(`handoffs?sessionId=${sourceId}`)).handoffs
    expect(both).toHaveLength(2)
    expect(both.find(item => item.target.kind === 'session')).toMatchObject({ targetSessionId: targetId, status: 'started' })
    await context.close()

    // A device with the work data scope reads the summary and the message, not the file.
    const narrow = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const reader = await narrow.newPage()
    reader.setDefaultTimeout(15_000)
    await browserWithScope(reader, host, owner, '交接 只读文件', 'work')
    await open(reader, sourceId)
    const seen = reader.getByRole('group', { name: '交回的结果', exact: true })
    await seen.getByText('已接入 ECB 每日汇率，缓存 24 小时。').waitFor()
    await seen.getByText('无权查看', { exact: true }).waitFor()
    await seen.getByRole('button', { name: '代码会话里的一条消息', exact: true }).waitFor()
    expect(await seen.getByRole('button', { name: 'rates.md' }).count()).toBe(0)
    await reader.screenshot({ path: `${OUT}/withheld-1440.png` })
    await shoot(reader, 'withheld', [[390, 'dark']])

    // A device that may only look opens the card to a refusal, and an offline page holds it back.
    const readerId = host.host.security.devices.list().find(device => device.name === '交接 只读文件')!.id
    await owner.json(`devices/${readerId}`, { method: 'PATCH', body: { scopes: ['view'] } })
    await reader.reload()
    await connected(reader)
    await open(reader, sourceId)
    const denied = await handOffReply(reader)
    await denied.getByText('这台设备只能查看，不能开始会话').waitFor()
    await reader.screenshot({ path: `${OUT}/denied-1440.png` })
    await shoot(reader, 'denied', [[390, 'dark']])
    await narrow.setOffline(true)
    await denied.getByText('这台设备没有联网 · 恢复后再交').waitFor({ timeout: 30_000 })
    await reader.screenshot({ path: `${OUT}/offline-1440.png` })
    await shoot(reader, 'offline', [[390, 'dark']])
    await narrow.close()
  } finally {
    await browser.close()
    await host.close()
  }
})
