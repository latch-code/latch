import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { expect, test } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { composerEntry, noHorizontalOverflow, openSession, permissionControl, permissionWords, showTooltip } from './helpers/layout.ts'
import { homeInput } from './helpers/workbench.ts'

test('shows immediate text, delays delivery wording and retries an uncertain input with the same identity on three widths', async () => {
  const host = await startTestHost({ uiDir: resolve('dist/web') }),
    browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    for (const width of [1440, 768, 390]) {
      const title = `发送状态 ${width}`
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: title, requestId: randomUUID() },
      })
      const path = `tasks/${sessionId}`
      await expect.poll(async () => (await owner.json<TaskDetail>(path)).summary.status).toBe('idle')
      const context = await browser.newContext({
          viewport: { width, height: 960 },
          colorScheme: width === 390 ? 'dark' : 'light',
          reducedMotion: 'reduce',
        }),
        page = await context.newPage()
      await enrollBrowser(page, host, { name: `发送 ${width}` })
      await page.keyboard.press('Meta+k')
      const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
      await palette.getByRole('searchbox').fill(title)
      await palette.getByRole('option', { name: title, exact: true }).click()
      let release!: () => void
      const delayed = new Promise<void>(resolve => {
          release = resolve
        }),
        requests: Array<{ prompt: string; requestId: string }> = []
      let count = 0
      await page.route(`**/link/api/${path}/prompt`, async route => {
        count++
        requests.push(route.request().postDataJSON() as { prompt: string; requestId: string })
        if (count === 1) {
          await delayed
          await route.continue()
        } else if (count === 2) await route.abort('failed')
        else await route.continue()
      })
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      const text = `慢请求 ${width}`
      await input.fill(text)
      await input.press('Enter')
      const pending = page.locator('.sending-message').filter({ visible: true })
      await expect.poll(() => pending.isVisible()).toBe(true)
      expect(await pending.getByText(text, { exact: true }).isVisible()).toBe(true)
      await expect.poll(() => pending.getByText('发送中…', { exact: true }).isVisible()).toBe(true)
      expect((await owner.json<TaskDetail>(path)).messages.filter(message => message.text === text)).toEqual([])
      await page.screenshot({ path: `test-results/sending-${width}.png`, fullPage: true })
      release()
      await expect.poll(async () => (await owner.json<TaskDetail>(path)).messages.some(message => message.text === text)).toBe(true)
      await expect.poll(async () => (await owner.json<TaskDetail>(path)).summary.status).toBe('idle')
      await expect.poll(() => pending.count()).toBe(0)
      expect(await page.locator('.user-bubble').getByText(text, { exact: true }).count()).toBe(1)
      await expect.poll(() => page.getByRole('button', { name: '发送', exact: true }).isVisible()).toBe(true)
      const unknown = `断线后的提交 ${width}`
      await input.fill(unknown)
      await input.press('Enter')
      await expect.poll(() => pending.getByText('未确认送达', { exact: false }).isVisible()).toBe(true)
      expect((await owner.json<TaskDetail>(path)).messages.some(message => message.text === unknown)).toBe(false)
      await page.screenshot({ path: `test-results/sending-unknown-${width}.png`, fullPage: true })
      expect(await page.getByRole('button', { name: '重试这次提交', exact: true }).count()).toBe(1)
      await page.getByRole('button', { name: '重试这次提交', exact: true }).click()
      await expect.poll(() => requests.length).toBe(3)
      expect(requests[2]).toEqual(requests[1])
      await expect
        .poll(async () => (await owner.json<TaskDetail>(path)).messages.filter(message => message.text === unknown).length)
        .toBe(1)
      await expect.poll(() => pending.count()).toBe(0)
      expect(await page.locator('.user-bubble').getByText(unknown, { exact: true }).count()).toBe(1)
      await context.close()
    }
  } finally {
    await browser.close()
    await host.close()
  }
}, 60_000)

test('an unconfirmed message says so in another session, opens from there and is retried at home', async () => {
  const host = await startTestHost({ uiDir: resolve('dist/web') }),
    browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const start = async (title: string) => {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: title, requestId: randomUUID() },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
      return sessionId
    }
    const home = await start('发出去的会话')
    const elsewhere = await start('另一个会话')
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' }),
      page = await context.newPage()
    await enrollBrowser(page, host, { name: '未确认' })
    let aborted = false
    await page.route(`**/link/api/tasks/${home}/prompt`, async route => {
      if (aborted) return route.continue()
      aborted = true
      return route.abort('failed')
    })
    await page.locator(`[data-task-id="${home}"]`).first().click()
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    await input.fill('断线的消息')
    await input.press('Enter')
    const row = page.locator('.pending-submission').filter({ visible: true })
    await row.getByRole('button', { name: '重试这次提交', exact: true }).waitFor()

    // Another window of this device reads the same record, and lets go of it when this one settles it.
    const other = await context.newPage()
    await other.goto(page.url())
    const otherRow = other.locator('.pending-submission').filter({ visible: true })
    await otherRow.waitFor()

    await page.locator(`[data-task-id="${elsewhere}"]`).first().click()
    await row.getByText('另一个会话有消息未确认送达', { exact: true }).waitFor()
    expect(await row.getByRole('button', { name: '重试这次提交', exact: true }).count()).toBe(0)

    await row.getByRole('button', { name: '打开', exact: true }).click()
    await page.locator('.user-bubble').getByText('发出去的会话', { exact: true }).waitFor()
    await row.getByRole('button', { name: '重试这次提交', exact: true }).click()
    await expect
      .poll(async () => (await owner.json<TaskDetail>(`tasks/${home}`)).messages.filter(message => message.text === '断线的消息').length)
      .toBe(1)
    await expect.poll(() => row.count()).toBe(0)
    await page.locator(`[data-task-id="${elsewhere}"]`).first().click()
    expect(await row.count()).toBe(0)
    await expect.poll(() => otherRow.count()).toBe(0)
    await context.close()
  } finally {
    await browser.close()
    await host.close()
  }
}, 60_000)

// Acceptance screenshots go where the person running it says, else beside the other test results.
const SHOTS = resolve(process.env.LATCH_PENDING_SHOTS ?? 'test-results/pending-escape')

test('a retry that stays unconfirmed says why, and 放弃这次提交 lets go of it here or from another session', async () => {
  const host = await startTestHost({ uiDir: resolve('dist/web') }),
    browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const start = async (title: string) => {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: title, requestId: randomUUID() },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
      return sessionId
    }
    for (const width of [1440, 390]) {
      const home = await start(`卡住的会话 ${width}`)
      await start(`旁边的会话 ${width}`)
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' }),
        page = await context.newPage()
      await enrollBrowser(page, host, { name: `放弃 ${width}` })
      const requests: Array<{ requestId: string; prompt: string }> = []
      // The Host keeps answering with its own 5xx, as a Harness that times out every time does.
      let failing = true
      await page.route(`**/link/api/tasks/${home}/prompt`, async route => {
        requests.push(route.request().postDataJSON() as { requestId: string; prompt: string })
        if (!failing) return route.continue()
        return route.fulfill({
          status: 504,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'agent-timeout', message: '夹具：Agent 停止响应' }),
        })
      })
      const open = async (title: string) => {
        await page.keyboard.press('Meta+k')
        const palette = page.getByRole('dialog', { name: '命令面板', exact: true })
        await palette.getByRole('searchbox').fill(title)
        await palette.getByRole('option', { name: title, exact: true }).click()
        await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
        await page.locator('.user-bubble').getByText(title, { exact: true }).waitFor()
      }
      await open(`卡住的会话 ${width}`)
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      const text = `卡住的消息 ${width}`
      await input.fill(text)
      await input.press('Enter')
      const card = page.locator('.pending-submission').filter({ visible: true })
      await card.getByText('Harness 没有在时限内答复。', { exact: true }).waitFor()
      expect(await card.getByText('夹具：Agent 停止响应', { exact: true }).count()).toBe(0)
      await card.getByRole('button', { name: '重试这次提交', exact: true }).click()
      await expect.poll(() => requests.length).toBe(2)
      expect(requests[1]).toEqual(requests[0])
      await card.getByText('Harness 没有在时限内答复。', { exact: true }).waitFor()
      if (width >= 768) {
        // A reload keeps the reason the last try heard, not a general 没有收到电脑的答复.
        await page.reload()
        await card.getByText('Harness 没有在时限内答复。', { exact: true }).waitFor()
        expect(await card.getByText('没有收到电脑的答复').count()).toBe(0)
      }
      expect(await card.getByRole('button', { name: '放弃这次提交', exact: true }).isEnabled()).toBe(true)
      // The ⓘ is a mark whose tooltip is the detail (00d98cb1), held on touch.
      const hint = await showTooltip(page, card.getByRole('img', { name: '说明', exact: true }))
      await hint.tip.getByText('再发送就是第二条消息', { exact: false }).waitFor()
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.screenshot({ path: `${SHOTS}/unconfirmed-reason--${scheme}--${width}.png` })
      }
      await page.emulateMedia({ colorScheme: 'light' })
      await hint.close()

      if (width >= 768) {
        // In the session: the text goes back into the input and is sent as a new message with a new requestId.
        await card.getByRole('button', { name: '放弃这次提交', exact: true }).click()
        await expect.poll(() => card.count()).toBe(0)
        expect(await input.inputValue()).toBe(text)
      } else {
        // From another session: the card offers it there too, and the text waits as the home session's draft.
        await open(`旁边的会话 ${width}`)
        await card.getByText('另一个会话有消息未确认送达', { exact: true }).waitFor()
        for (const scheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: scheme })
          await page.screenshot({ path: `${SHOTS}/elsewhere--${scheme}--${width}.png` })
        }
        await page.emulateMedia({ colorScheme: 'light' })
        await card.getByRole('button', { name: '放弃这次提交', exact: true }).click()
        await expect.poll(() => card.count()).toBe(0)
        expect(await input.inputValue()).toBe('')
        await open(`卡住的会话 ${width}`)
        await expect.poll(() => input.inputValue()).toBe(text)
      }
      failing = false
      await input.press('Enter')
      await expect
        .poll(async () => (await owner.json<TaskDetail>(`tasks/${home}`)).messages.filter(message => message.text === text).length)
        .toBe(1)
      expect(requests).toHaveLength(3)
      expect(requests[2]!.requestId).not.toBe(requests[0]!.requestId)
      await expect.poll(() => card.count()).toBe(0)
      await context.close()
    }
  } finally {
    await browser.close()
    await host.close()
  }
}, 90_000)

test('a Harness that cannot start is a refusal, not an unconfirmed message: the text stays, with its reason and next steps', async () => {
  const host = await startTestHost({ uiDir: resolve('dist/web') }),
    browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { prompt: '起不来的会话', requestId: randomUUID() },
    })
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    for (const [width, scheme] of [
      [1440, 'light'],
      [1440, 'dark'],
      [390, 'light'],
      [390, 'dark'],
    ] as const) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, reducedMotion: 'reduce' }),
        page = await context.newPage()
      await enrollBrowser(page, host, { name: `起不来 ${width} ${scheme}`, scopes: ['admin'] })
      let tries = 0
      // The Host's answer when the agent's process exits before the turn is recorded.
      await page.route(`**/link/api/tasks/${sessionId}/prompt`, route => {
        tries++
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'agent-start-failed', message: 'Flaky Agent 启动失败：进程退出（退出码 1）' }),
        })
      })
      await openSession(page, sessionId)
      const input = page.getByRole('textbox', { name: '继续对话', exact: true })
      const text = `发给起不来的 Agent ${width}`
      await input.fill(text)
      await input.press('Enter')
      const notice = page.locator('.composer-stack .ui-notice').filter({ hasText: 'Harness 未能启动，消息没有发出。' })
      await notice.waitFor()
      expect(await notice.getByText('Flaky Agent 启动失败', { exact: false }).count()).toBe(0)
      await notice.getByRole('button', { name: '打开设置 › Harness', exact: true }).waitFor()
      await notice.getByRole('button', { name: '重试', exact: true }).waitFor()
      expect(await page.locator('.pending-submission').filter({ visible: true }).count()).toBe(0)
      expect(await input.inputValue()).toBe(text)
      await page.screenshot({ path: `${SHOTS}/start-failed--${scheme}--${width}.png` })
      const answered = page.waitForResponse(response => response.url().endsWith(`/tasks/${sessionId}/prompt`))
      await notice.getByRole('button', { name: '重试', exact: true }).click()
      await answered
      expect(tries).toBe(2)
      await notice.waitFor()
      await expect.poll(() => page.locator('.pending-submission').filter({ visible: true }).count()).toBe(0)
      // Nothing is held for later: a reload has no unconfirmed message, here or for the next session.
      await page.reload()
      await page.locator('.app-shell').waitFor()
      expect(await page.locator('.pending-submission').filter({ visible: true }).count()).toBe(0)
      await context.close()
    }
  } finally {
    await browser.close()
    await host.close()
  }
}, 120_000)

test('only a message the Host lists by this requestId counts as delivered, from here, from another session and with attachments', async () => {
  const host = await startTestHost({ uiDir: resolve('dist/web') }),
    browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const start = async (title: string) => {
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { prompt: title, requestId: randomUUID() },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
      return sessionId
    }
    const home = await start('送达核对')
    const other = await start('别处')
    const path = `tasks/${home}`
    const texts = async (text: string) => (await owner.json<TaskDetail>(path)).messages.filter(message => message.text === text).length
    // The same words are already in the session, under another requestId.
    await owner.json(`${path}/prompt`, { method: 'POST', body: { prompt: '同样的文字', requestId: randomUUID() } })
    await expect.poll(async () => (await owner.json<TaskDetail>(path)).summary.status).toBe('idle')
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' }),
      page = await context.newPage()
    await enrollBrowser(page, host, { name: '已送达' })
    let mode: 'refuse' | 'lose' | 'publish-unknown' = 'refuse'
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const requests: Array<{ requestId: string; prompt: string; attachmentIds?: string[] }> = []
    await page.route(`**/link/api/${path}/prompt`, async route => {
      const body = route.request().postDataJSON() as { requestId: string; prompt: string; attachmentIds?: string[] }
      requests.push(body)
      const fail = (status: number, error: string) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error, message: '没有答复' }) })
      if (mode === 'refuse') return fail(502, 'bad-gateway')
      if (mode === 'lose') {
        await route.fetch()
        await gate
        return fail(504, 'gateway')
      }
      // The Host takes it, then asks for the same request again (attachment-publish-unknown); the second goes through.
      if (requests.filter(item => item.requestId === body.requestId).length > 1) return route.continue()
      await route.fetch()
      return fail(503, 'attachment-publish-unknown')
    })
    await page.locator(`[data-task-id="${home}"]`).first().click()
    const input = page.getByRole('textbox', { name: '继续对话', exact: true })
    const card = page.locator('.pending-submission').filter({ visible: true })

    // Same text, another requestId: never taken for this one.
    await input.fill('同样的文字')
    await input.press('Enter')
    await card.getByRole('button', { name: '放弃这次提交', exact: true }).waitFor()
    await card.getByRole('button', { name: '放弃这次提交', exact: true }).click()
    await expect.poll(() => card.count()).toBe(0)
    expect(await input.inputValue()).toBe('同样的文字')
    expect(await page.getByText('已送达', { exact: true }).count()).toBe(0)
    expect(await texts('同样的文字')).toBe(1)

    // The Host has it, the answer is lost, and 放弃 is pressed from another session: its fresh read finds it.
    mode = 'lose'
    await input.fill('丢了答复的消息')
    await input.press('Enter')
    await expect.poll(() => texts('丢了答复的消息')).toBe(1)
    await page.locator(`[data-task-id="${other}"]`).first().click()
    await page.locator('.user-bubble').getByText('别处', { exact: true }).waitFor()
    release()
    await card.getByText('另一个会话有消息未确认送达', { exact: true }).waitFor()
    await card.getByRole('button', { name: '放弃这次提交', exact: true }).click()
    await page.getByText('已送达', { exact: true }).waitFor()
    await expect.poll(() => card.count()).toBe(0)
    await page.locator(`[data-task-id="${home}"]`).first().click()
    await page.locator('.user-bubble').getByText('丢了答复的消息', { exact: true }).waitFor()
    // The draft that still held the delivered text went with it.
    expect(await input.inputValue()).toBe('')
    expect(await texts('丢了答复的消息')).toBe(1)

    // With an attachment, a listed message is sent once more with the same requestId instead of being settled.
    mode = 'publish-unknown'
    await page.getByLabel('选择附件').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('附件内容') })
    await expect.poll(() => page.getByRole('button', { name: 'notes.txt', exact: true }).isEnabled()).toBe(true)
    await input.fill('带附件的消息')
    await input.press('Enter')
    await expect.poll(() => requests.filter(item => item.prompt === '带附件的消息').length).toBe(2)
    const [first, second] = requests.filter(item => item.prompt === '带附件的消息')
    expect(second).toEqual(first)
    expect(first!.attachmentIds).toHaveLength(1)
    await expect.poll(() => card.count()).toBe(0)
    expect(await texts('带附件的消息')).toBe(1)
    await context.close()
  } finally {
    await browser.close()
    await host.close()
  }
}, 90_000)

test('opens the new-session transcript on send, keeps the lost receipt, and opens three warm transcripts without reading again', async () => {
  // Only this empty directory is searched, and nothing is detected: no agent installed here can be found or started.
  const bin = await mkdtemp(join(tmpdir(), 'latch-e2e-sending-'))
  const host = await startTestHost({
      uiDir: resolve('dist/web'),
      hostName: '验收电脑',
      commandDirectories: () => [bin],
      detectPreset: () => ({ found: false }),
    }),
    browser = await chromium.launch(browserLaunchOptions())
  try {
    const owner = await host.enroll({ listener: 'unix' })
    const permission = '核对每一次文件编辑和终端命令执行'
    const saved = await owner.confirmed('agents', {
      method: 'POST',
      body: {
        id: 'fake',
        name: 'Fake',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: `${permission},plan` },
      },
    })
    expect(saved.status).toBe(201)
    expect((await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(item => item.id === 'fake')?.level).toBe('L3')
    const prior = await Promise.all(
      ['已打开的记录甲', '已打开的记录乙'].map(async title => {
        const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: { prompt: title, requestId: randomUUID(), harnessId: 'standard' },
        })
        await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
        return { sessionId, title }
      }),
    )
    const output = 'test-results/composer-rest'
    await mkdir(output, { recursive: true })
    for (const width of [1440, 1100, 768, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 900 },
        hasTouch: width <= 768,
        isMobile: width === 390,
        reducedMotion: 'reduce',
        deviceScaleFactor: 1,
      })
      let release = () => {}
      try {
        const page = await context.newPage()
        await enrollBrowser(page, host, { name: `开始会话 ${width}` })
        await connected(page)
        if (width === 390) await page.locator('.phone-list').getByRole('button', { name: '新建会话', exact: true }).first().click()
        await homeInput(page).waitFor()
        const delayed = new Promise<void>(resolve => {
          release = resolve
        })
        const starts: Array<{ prompt: string; requestId: string; harnessId?: string }> = []
        await page.route('**/link/api/tasks', async route => {
          if (route.request().method() !== 'POST') return route.continue()
          starts.push(route.request().postDataJSON() as (typeof starts)[number])
          if (starts.length !== 1) return route.continue()
          const accepted = await route.fetch()
          await delayed
          await route.abort(accepted.ok() ? 'connectionreset' : 'failed')
          await accepted.dispose()
        })
        const title = `echo 一条新消息 ${width}`
        await homeInput(page).fill(title)
        const sending = page.locator('main.workspace[data-pending-start]:not([inert])')
        const send = page.locator('.workbench-home').getByRole('button', { name: '发送', exact: true })
        await send.click()
        await sending.getByRole('heading', { name: 'Fake · 不选项目', exact: true }).waitFor()
        const bubble = sending.locator('.transcript .user-bubble')
        expect(await bubble.getByText(title, { exact: true }).isVisible()).toBe(true)
        await page.waitForTimeout(2_000)
        await sending.getByText('发送中…', { exact: true }).waitFor()

        const shot = async (state: string) => {
          for (const colorScheme of ['light', 'dark'] as const) {
            await page.emulateMedia({ colorScheme })
            await noHorizontalOverflow(page)
            await page.screenshot({ path: `${output}/${state}--${colorScheme}--${width}.png`, animations: 'disabled' })
          }
        }
        await shot('first-message-sending')
        release()
        const retry = sending.getByRole('button', { name: '重试这次提交', exact: true })
        await retry.waitFor()
        const input = sending.locator('form[hidden] textarea')
        expect(await input.inputValue()).toBe(title)
        expect(await input.isVisible()).toBe(false)
        expect(await sending.locator('.pending-submission').getByText(title, { exact: true }).count()).toBe(0)
        const [request] = starts
        expect(request).toMatchObject({ prompt: title, harnessId: 'fake', requestId: expect.any(String) })
        expect(await sending.getAttribute('data-pending-start')).toBe(request!.requestId)
        await shot('first-message-unknown')
        await retry.click()
        await sending.waitFor({ state: 'detached' })
        const real = page.locator('main.workspace:not([inert]) .transcript')
        await real.locator('.user-bubble').getByText(title, { exact: true }).waitFor()
        expect(starts).toEqual([request, request])
        const matches = (await owner.json<AppSnapshot>('snapshot')).tasks.filter(task => task.title === title)
        expect(matches).toHaveLength(1)
        const task = matches[0]!
        expect((await owner.json<TaskDetail>(`tasks/${task.id}`)).messages.filter(message => message.role === 'user')).toHaveLength(1)
        if (width === 390) {
          // The permission is said beside the Harness; its glyph is never cut, whatever the model's name is, and the
          // entry still ends the line beside send.
          const form = page.locator('main.workspace:not([inert]) form.composer')
          const mark = permissionControl(form)
          await mark.waitFor()
          expect(await permissionWords(form)).toBe(`权限：${permission}`)
          expect(
            await mark.evaluate(button => {
              const glyph = button.querySelector('svg')!.getBoundingClientRect()
              const box = button.getBoundingClientRect()
              return {
                inside: glyph.left >= box.left - 1 && glyph.right <= box.right + 1 && box.right <= window.innerWidth,
                vertical: glyph.height <= box.height,
              }
            }),
          ).toEqual({ inside: true, vertical: true })
          const sendBox = (await form.locator('.composer-slot').boundingBox())!
          const entryBox = (await composerEntry(form).boundingBox())!
          expect(sendBox.x - (entryBox.x + entryBox.width)).toBeLessThan(12)
        }
        await shot('first-message-confirmed')
        if (width === 1440 || width === 390) {
          await context.setOffline(true)
          await page.locator('.app-shell[data-connection="offline"]').waitFor()
          await openSession(page, prior[0]!.sessionId)
          await real.locator('.transcript-skeleton').waitFor()
          await shot('cold-transcript')
          await context.setOffline(false)
          await connected(page)
          for (const entry of prior) {
            await openSession(page, entry.sessionId)
            await real.getByText(entry.title, { exact: true }).waitFor()
          }
          await context.setOffline(true)
          await page.locator('.app-shell[data-connection="offline"]').waitFor()
          for (const entry of [...prior, { sessionId: task.id, title }]) {
            await openSession(page, entry.sessionId)
            expect(await real.getByText(entry.title, { exact: true }).isVisible()).toBe(true)
            expect(await real.locator('.transcript-skeleton').count()).toBe(0)
          }
          await shot('cached-transcript-offline')
        }
      } finally {
        release()
        await context.close()
      }
    }
  } finally {
    await browser.close()
    await host.close()
    await rm(bin, { recursive: true, force: true })
  }
}, 100_000)
