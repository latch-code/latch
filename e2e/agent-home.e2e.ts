import { chromium, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AppSnapshot, TaskDetail, TerminalSummary } from '@latch/protocol'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'

const OUT = process.env.LATCH_AGENT_HOME_SHOTS ?? 'test-results/agent-home'

/** A stand-in for latch-pty: it starts, records where, and ends when closed. */
const launched: string[] = []
const launch = (spec: { cwd: string }, onEvent: (event: { type: string; [key: string]: unknown }) => void) => {
  launched.push(spec.cwd)
  onEvent({ type: 'started', pid: 1 })
  setTimeout(() => onEvent({ type: 'output', data: Buffer.from(`~/${spec.cwd.split('/').at(-1)} $ `) }), 10)
  let closed = false
  return {
    input() {},
    resize() {},
    signal() {},
    pauseOutput() {},
    resumeOutput() {},
    close() {
      if (!closed) {
        closed = true
        onEvent({ type: 'exit', signal: 1 })
        onEvent({ type: 'gone' })
      }
      return Promise.resolve()
    },
  }
}

it('talks to 通用 on a fresh data directory, sets its deleted home up again, and never asks for a folder', async () => {
  await mkdir(OUT, { recursive: true })
  const base = await realpath(await mkdtemp(join(tmpdir(), 'latch-agent-home-e2e-')))
  // No start directory yet: the Host makes it, then 通用's home inside it.
  const workspaceRoot = join(base, 'not-yet', 'workspace')
  const host = await startTestHost({
    hostName: '工作 Mac',
    workspaceRoot,
    terminal: { launch: launch as never, shell: { file: '/bin/sh', argv: ['sh'] } },
  })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  try {
    await stillMotion(context)
    const owner = await host.enroll({ listener: 'unix' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { name: '通用的家' })
    const device = host.host.security.devices.list().find(item => item.name === '通用的家')!
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    await page.reload()
    await connected(page)
    await page.getByRole('radio', { name: '我的 Agent', exact: true }).filter({ visible: true }).click()
    await page.getByRole('navigation', { name: '我的 Agent', exact: true }).locator('[data-agent-id="general"]').first().click()
    const send = async (text: string) => {
      // The first message goes from 通用's new-chat input, later ones from the chat's own.
      const input = page.locator('.composer-input [role="textbox"]').filter({ visible: true }).first()
      await input.fill(text)
      await input.press('Meta+Enter')
    }
    const chat = async () => (await owner.json<AppSnapshot>('snapshot')).agentChats?.general
    const userTexts = async (id: string) =>
      (await owner.json<TaskDetail>(`tasks/${id}`)).messages.filter(message => message.role === 'user').map(message => message.text)

    await send('第一句')
    await expect.poll(async () => (await chat())?.state).toBe('ready')
    const sessionId = ((await chat()) as { sessionId: string }).sessionId
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    const home = join(workspaceRoot, 'helpers', 'general')
    expect((await stat(home)).mode & 0o777).toBe(0o700)
    await shot(page, 'healthy-1440-light')

    // The home goes away; the next message sets it up again and the same chat continues, with no folder to pick.
    await rm(home, { recursive: true })
    // Opened onto the chat afterwards, as after a restart: nothing to pick, no failure, the input ready.
    await page.reload()
    await connected(page)
    await page.locator('.composer-input [role="textbox"]').filter({ visible: true }).first().waitFor()
    await page.waitForTimeout(1500)
    expect(
      await page
        .getByText(/找不到了|请求未完成|不会接手|不可用/u)
        .filter({ visible: true })
        .count(),
    ).toBe(0)
    await shot(page, 'reopened-1440-light')
    await send('第二句')
    await expect.poll(() => userTexts(sessionId)).toEqual(['第一句', '第二句'])
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    expect(await chat()).toEqual({ state: 'ready', sessionId })
    expect((await stat(home)).mode & 0o777).toBe(0o700)
    expect(await page.getByText('在新会话中继续').count()).toBe(0)
    expect(await page.getByText(/找不到了|请求未完成/u).count()).toBe(0)
    await shot(page, 'continued-1440-light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await shot(page, 'continued-1440-dark')
    await page.emulateMedia({ colorScheme: 'light' })

    // The terminal (this Mac only) opens in the home.
    const opened = await owner.request(`tasks/${sessionId}/terminals`, { method: 'POST', body: { cols: 80, rows: 24 } })
    expect(opened.status).toBe(201)
    expect(((await opened.json()) as { terminal: TerminalSummary }).terminal).toMatchObject({ status: 'running' })
    expect(launched.at(-1)).toBe(await realpath(home))

    // A home changed behind the Host's back is refused as it is: a short state with 重试, never a folder picker.
    await chmod(home, 0o755)
    await send('第三句')
    const state = page
      .locator('.composer-stop')
      .filter({ has: page.getByText('工作文件夹不可用', { exact: true }) })
      .filter({ visible: true })
    await state.waitFor()
    expect(await state.getByRole('button', { name: '重试', exact: true }).count()).toBe(1)
    // The reason is behind the hover, not inline.
    expect(
      await state
        .getByText(/不会接手/u)
        .filter({ visible: true })
        .count(),
    ).toBe(0)
    expect(await page.getByText('在新会话中继续').count()).toBe(0)
    expect(
      await page
        .getByRole('combobox')
        .filter({ hasText: /项目/u })
        .count(),
    ).toBe(0)
    expect((await stat(home)).mode & 0o777).toBe(0o755)
    expect(await userTexts(sessionId)).toEqual(['第一句', '第二句'])
    await shot(page, 'refused-1440-light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await shot(page, 'refused-1440-dark')
    await page.emulateMedia({ colorScheme: 'light' })
    await page.setViewportSize({ width: 390, height: 844 })
    await state.waitFor()
    await shot(page, 'refused-390-light')
    // Put right on the Mac, 重试 sends what was refused.
    await chmod(home, 0o700)
    await state.getByRole('button', { name: '重试', exact: true }).click()
    await expect.poll(() => userTexts(sessionId)).toEqual(['第一句', '第二句', '第三句'])
    await expect.poll(() => state.count()).toBe(0)
    await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
    await shot(page, 'healthy-390-light')
  } finally {
    await context.close()
    await browser.close()
    await host.close()
    await rm(base, { recursive: true, force: true })
  }
})

it('moves 通用’s chat to the home under a new start directory, and the page follows the chat that took the message', async () => {
  await mkdir(OUT, { recursive: true })
  const base = await realpath(await mkdtemp(join(tmpdir(), 'latch-agent-move-e2e-')))
  // The same port across the restart, so this browser's page and credential stay on one origin.
  const port = await new Promise<number>((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as AddressInfo
      probe.close(() => done(address.port))
    })
  })
  const dataDir = join(base, 'data')
  let host = await startTestHost({ hostName: '工作 Mac', port, dataDir, workspaceRoot: join(base, 'first') })
  const browser = await chromium.launch(browserLaunchOptions())
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  try {
    await stillMotion(context)
    const owner = await host.enroll({ listener: 'unix' })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await enrollBrowser(page, host, { name: '换家' })
    const device = host.host.security.devices.list().find(item => item.name === '换家')!
    await owner.confirmedJson(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
    const openGeneral = async () => {
      await page.reload()
      await connected(page)
      await page.getByRole('radio', { name: '我的 Agent', exact: true }).filter({ visible: true }).click()
      await page.getByRole('navigation', { name: '我的 Agent', exact: true }).locator('[data-agent-id="general"]').first().click()
    }
    const send = async (text: string) => {
      const input = page.locator('.composer-input [role="textbox"]').filter({ visible: true }).first()
      await input.fill(text)
      await input.press('Meta+Enter')
    }
    await openGeneral()
    await send('旧家里的话')
    // As this device, on whichever Host runs now.
    const api = async (path: string, init: { method?: 'GET' | 'POST'; body?: object } = {}) =>
      host.raw('unix', `api/${path}`, { ...init, headers: { authorization: `Latch-Device ${owner.credential}` } })
    const json = async <T>(path: string) => (await (await api(path)).json()) as T
    const chat = async () => (await json<AppSnapshot>('snapshot')).agentChats?.general
    await expect.poll(async () => (await chat())?.state).toBe('ready')
    const old = (await chat()) as { sessionId: string }
    await expect.poll(async () => (await json<TaskDetail>(`tasks/${old.sessionId}`)).summary.status).toBe('idle')
    await host.close()
    host = await startTestHost({ hostName: '工作 Mac', port, dataDir, workspaceRoot: join(base, 'second') })
    await openGeneral()
    await page.getByText('旧家里的话').filter({ visible: true }).first().waitFor()
    await send('新家里的话')
    await expect
      .poll(async () => {
        const now = (await chat()) as { state: string; sessionId?: string } | undefined
        return now?.state === 'ready' && now.sessionId !== old.sessionId
      })
      .toBe(true)
    const moved = (await chat()) as { sessionId: string }
    await expect.poll(async () => (await json<TaskDetail>(`tasks/${moved.sessionId}`)).summary.status).toBe('idle')
    // The page shows the chat that took the message: the new one, with only that message.
    await page.getByText('新家里的话').filter({ visible: true }).first().waitFor()
    await expect.poll(() => page.getByText('旧家里的话').filter({ visible: true }).count()).toBe(0)
    expect(
      await page
        .getByText(/找不到了|请求未完成|不可用|在新会话中继续/u)
        .filter({ visible: true })
        .count(),
    ).toBe(0)
    expect((await json<TaskDetail>(`tasks/${moved.sessionId}`)).summary.cwd).toBe(join(base, 'second', 'helpers', 'general'))
    // The old chat stays to read and takes no new message.
    const refused = await api(`tasks/${old.sessionId}/prompt`, { method: 'POST', body: { prompt: 'x', requestId: randomUUID() } })
    expect(refused.status).toBe(409)
    await shot(page, 'moved-1440-light')
  } finally {
    await context.close()
    await browser.close()
    await host.close()
    await rm(base, { recursive: true, force: true })
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
