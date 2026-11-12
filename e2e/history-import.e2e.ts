import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, HistoryImportResult, HistoryList } from '@latch/protocol'
import { FAKE_ACP_AGENT, FAKE_HISTORY_SECRETS, fakeConversation, writeFakeHistory, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'

const OUTPUT = 'test-results/history-import'
const CODEX_ENV = {
  FAKE_ACP_CONFIG: 'options',
  FAKE_ACP_MODES: 'read-only,workspace-write,agent,agent-full-access',
  FAKE_ACP_INITIAL_MODE: 'agent-full-access',
  FAKE_ACP_CAPS: 'list,load,resume,close,delete,dirs',
}

interface LogEntry {
  event: string
  method?: string | null
  params?: Record<string, unknown>
}

const readLog = async (path: string): Promise<LogEntry[]> =>
  (await readFile(path, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as LogEntry)

describe('接入已有会话 from the new-session page', () => {
  let root: string
  let host: TestHost
  let owner: TestDevice
  let browser: Browser
  let projectId: string
  let codexLog: string
  let plainLog: string
  let historyFile: string
  let codexState: string

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'latch-e2e-history-')))
    const workspaceRoot = join(root, 'workspace')
    const main = join(workspaceRoot, 'app')
    const other = join(workspaceRoot, 'docs')
    const outside = join(root, 'elsewhere')
    for (const folder of [main, join(main, 'web'), other, outside]) await mkdir(folder, { recursive: true })
    const history = await writeFakeHistory(root, [
      {
        sessionId: 'ext-web',
        cwd: join(main, 'web'),
        title: 'Web build',
        updatedAt: '2026-11-11T08:00:00.000Z',
        updates: fakeConversation(),
      },
      {
        sessionId: 'ext-login',
        cwd: main,
        title: `Login bug ${FAKE_HISTORY_SECRETS.openai}`,
        updatedAt: '2026-11-10T08:00:00.000Z',
        updates: fakeConversation(),
      },
      {
        sessionId: 'ext-rebuild',
        cwd: main,
        title: 'Rebuild me',
        updatedAt: '2026-11-09T08:00:00.000Z',
        updates: fakeConversation(),
      },
      { sessionId: 'ext-lost', cwd: main, title: 'Lost later', updatedAt: '2026-11-08T10:00:00.000Z', updates: fakeConversation() },
      { sessionId: 'ext-phone', cwd: main, title: 'Phone notes', updatedAt: '2026-11-08T09:00:00.000Z', updates: fakeConversation() },
      { sessionId: 'ext-busy', cwd: main, title: 'Open in a terminal', updatedAt: '2026-11-08T08:00:00.000Z', busy: true, updates: [] },
      { sessionId: 'ext-other', cwd: other, title: 'Docs session', updates: [] },
      { sessionId: 'ext-outside', cwd: outside, title: 'Outside secret title', updates: [] },
    ])
    historyFile = history
    codexState = join(root, 'codex-state.json')
    codexLog = join(root, 'codex.log')
    plainLog = join(root, 'plain.log')
    host = await startTestHost({ workspaceRoot })
    owner = await host.enroll({ listener: 'unix' })
    const codex = await owner.confirmed('agents', {
      method: 'POST',
      body: {
        id: 'codex',
        name: 'Codex',
        presetId: 'codex',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { ...CODEX_ENV, FAKE_ACP_STATE: join(root, 'codex-state.json'), FAKE_ACP_LOG: codexLog, FAKE_ACP_HISTORY_FILE: history },
      },
    })
    expect(codex.status).toBe(201)
    const plain = await owner.confirmed('agents', {
      method: 'POST',
      body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_LOG: plainLog } },
    })
    expect(plain.status).toBe(201)
    const added = await owner.addFolders({ name: 'Shop', paths: [main, other] })
    expect(added.status).toBe(201)
    projectId = ((await added.json()) as { workspace: { id: string } }).workspace.id
    await owner.json('preferences', { method: 'PUT', body: { defaults: { workspaceId: projectId, harnessId: 'codex' } } })
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterAll(async () => {
    await browser?.close()
    await host?.close()
    await rm(root, { recursive: true, force: true })
  })

  /** A browser device; `all` widens its data scope, as the Mac's 「可以看项目文件」 does. */
  const open = async (width: number, theme: 'light' | 'dark', scope: 'all' | 'work' = 'all'): Promise<Page> => {
    const context = await browser.newContext({
      viewport: { width, height: width < 768 ? 844 : 900 },
      colorScheme: theme,
      locale: 'zh-CN',
      reducedMotion: 'reduce',
      ...(width < 768 ? { isMobile: true, hasTouch: true } : {}),
    })
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    const name = `History ${randomUUID()}`
    await enrollBrowser(page, host, { name, scopes: ['admin'] })
    if (scope === 'all') {
      const devices = await owner.json<{ devices: Array<{ id: string; name: string }> }>('devices')
      const id = devices.devices.find(item => item.name === name)!.id
      expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
      await page.reload()
      await connected(page)
    }
    return page
  }
  const shot = (page: Page, name: string) => page.screenshot({ path: `${OUTPUT}/${name}.png`, animations: 'disabled' })
  const dialogOf = (page: Page) => page.getByRole('dialog', { name: '接入已有会话', exact: true })
  const rows = (dialog: Locator) => dialog.locator('.history-row-title')
  const tasks = async () => (await owner.json<AppSnapshot>('snapshot')).tasks
  const openEntry = async (page: Page) => {
    await page.getByRole('button', { name: '接入已有会话', exact: true }).click()
    const dialog = dialogOf(page)
    await dialog.locator('.history-row').first().waitFor()
    return dialog
  }

  it('lists the project’s sessions, previews one redacted, says busy, imports it as it was and continues it', async () => {
    const page = await open(1440, 'light')
    await page.getByRole('button', { name: '接入已有会话', exact: true }).waitFor()
    await shot(page, 'entry-1440-light')
    const dialog = await openEntry(page)
    // Newest first, only the primary folder and below; the other folder is a count, outside is nothing at all.
    expect(await rows(dialog).allTextContents()).toEqual([
      'Web build',
      'Login bug [redacted]',
      'Rebuild me',
      'Lost later',
      'Phone notes',
      'Open in a terminal',
    ])
    await dialog.getByText('另有 1 个在项目的其他文件夹里 · 尚未支持').waitFor()
    await dialog.locator('.history-row-folder', { hasText: 'web/' }).waitFor()
    expect(await dialog.textContent()).not.toContain('Outside secret title')
    expect(await dialog.textContent()).not.toContain(FAKE_HISTORY_SECRETS.openai)
    await dialog.locator('.history-scope').getByText('Shop', { exact: true }).waitFor()
    await shot(page, 'list-1440-light')

    // Busy: said plainly, nothing to take it over with.
    await dialog.getByRole('button', { name: /Open in a terminal/u }).click()
    await dialog.getByText('这个会话正在别处使用', { exact: true }).waitFor()
    expect(await dialog.getByRole('button', { name: /接管|接入/u }).count()).toBe(0)
    await shot(page, 'busy-1440-light')
    await dialog.getByRole('button', { name: '返回列表', exact: true }).click()

    await dialog.getByRole('button', { name: /Login bug/u }).click()
    await dialog.locator('.history-message[data-role="user"]').first().waitFor()
    const text = (await dialog.locator('.history-messages').textContent()) ?? ''
    expect(text).toContain('My key is [redacted]')
    expect(text).not.toContain(FAKE_HISTORY_SECRETS.openai)
    expect(text).not.toContain('hidden reasoning')
    expect(text).not.toContain('OPENAI_API_KEY')
    await dialog.locator('.history-message[data-role="tool"]', { hasText: '输出已隐藏' }).waitFor()
    await dialog.getByText('工具输出和思考不显示', { exact: true }).waitFor()
    await dialog.getByText('原样接入', { exact: true }).waitFor()
    await shot(page, 'preview-1440-light')

    const before = (await tasks()).length
    await dialog.getByRole('button', { name: '接入', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await page.locator('.topbar-imported', { hasText: '已接入' }).waitFor()
    await page.locator('.transcript').getByText('The bug is in the session check.', { exact: true }).waitFor()
    expect((await tasks()).length).toBe(before + 1)
    await shot(page, 'imported-1440-light')

    const composer = page.getByRole('textbox', { name: '继续对话', exact: true })
    await composer.fill('echo 接着做')
    await composer.press('Enter')
    await page.locator('.transcript').getByText('echo: echo 接着做', { exact: true }).waitFor()
    const resumed = (await readLog(codexLog)).filter(entry => entry.event === 'recv' && entry.method === 'session/resume')
    expect(resumed.some(entry => entry.params?.sessionId === 'ext-login')).toBe(true)
    // Never prompted while previewing: the one prompt is the person's.
    const prompts = (await readLog(codexLog)).filter(entry => entry.event === 'recv' && entry.method === 'session/prompt')
    expect(prompts).toHaveLength(1)

    // Again: the row says 已接入 and opens the same session, without another.
    const importedId = (await tasks()).find(task => task.imported?.mode === 'native')!.id
    await page.getByRole('button', { name: '新建会话', exact: true }).first().click()
    const again = await openEntry(page)
    const row = again.locator('.history-row[data-imported]')
    await row.getByText('已接入', { exact: true }).waitFor()
    await shot(page, 'list-imported-1440-light')
    await row.click()
    await again.waitFor({ state: 'detached' })
    await page.locator('.topbar-imported').waitFor()
    expect((await tasks()).filter(task => task.imported).map(task => task.id)).toEqual([importedId])
    await page.context().close()
  })

  it('opens the session another request brought in first, from a 409', async () => {
    const page = await open(768, 'dark')
    const dialog = await openEntry(page)
    await dialog.getByRole('button', { name: /Web build/u }).click()
    await dialog.getByRole('button', { name: '接入', exact: true }).waitFor()
    // Meanwhile another device brings the same session in.
    const listed = await owner.json<HistoryList>('history/list', { method: 'POST', body: { projectId, harnessId: 'codex' } })
    const handle = listed.rows.find(item => item.title === 'Web build')!.handle
    const first = await owner.json<HistoryImportResult>('history/imports', { method: 'POST', body: { requestId: randomUUID(), handle } })
    const refused = page.waitForResponse(response => response.url().endsWith('/history/imports') && response.request().method() === 'POST')
    await dialog.getByRole('button', { name: '接入', exact: true }).click()
    expect((await refused).status()).toBe(409)
    await dialog.waitFor({ state: 'detached' })
    await page.locator('.topbar-imported').waitFor()
    await page.locator('.topbar h1', { hasText: 'Web build' }).waitFor()
    expect((await tasks()).filter(task => task.title === 'Web build').map(task => task.id)).toEqual([first.taskId])
    await shot(page, 'already-imported-768-dark')
    await page.context().close()
  })

  it('rebuilds as text into another ACP Harness that sends nothing until the first message', async () => {
    const page = await open(1440, 'dark')
    const dialog = await openEntry(page)
    await dialog.getByRole('button', { name: /Rebuild me/u }).click()
    await dialog.getByRole('button', { name: '接入', exact: true }).waitFor()
    await dialog.getByRole('button', { name: /继续用/u }).click()
    await page
      .getByRole('menuitemradio', { name: /Fake/u })
      .or(page.getByRole('radio', { name: /Fake/u }))
      .first()
      .click()
    await dialog.getByText('按文字重建，不是原样恢复', { exact: true }).waitFor()
    await shot(page, 'rebuild-1440-dark')
    await dialog.getByRole('button', { name: '接入', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await page.locator('.topbar-imported', { hasText: '已接入 · 按文字重建' }).waitFor()
    await page
      .locator('.composer-seed')
      .getByText(/第一条消息会把重建的对话文字一起发给/u)
      .waitFor()
    await shot(page, 'rebuilt-waiting-1440-dark')
    const sent = async () => (await readLog(plainLog)).filter(entry => entry.event === 'recv' && entry.method === 'session/prompt')
    expect(await sent()).toHaveLength(0)

    const composer = page.getByRole('textbox', { name: '继续对话', exact: true })
    await composer.fill('echo 按重建继续')
    await composer.press('Enter')
    await page.locator('.message-user .fork-context summary', { hasText: '按 Codex 会话的文字重建' }).waitFor()
    await shot(page, 'rebuilt-sent-1440-dark')
    // The rebuilt conversation is folded away; the bubble's own words are the person's alone.
    const own = () =>
      page
        .locator('.message-user .user-bubble-text')
        .first()
        .evaluate(element =>
          [...element.childNodes]
            .filter(node => !(node instanceof HTMLDetailsElement))
            .map(node => node.textContent)
            .join('')
            .trim(),
        )
    await expect.poll(own).toBe('echo 按重建继续')
    await expect.poll(async () => (await sent()).length).toBe(1)
    const prompt = JSON.stringify((await sent())[0]!.params)
    expect(prompt).toContain('Fix the login bug')
    expect(prompt).not.toContain(FAKE_HISTORY_SECRETS.openai)
    expect(prompt).not.toContain('hidden reasoning')
    expect(await page.locator('.composer-seed').count()).toBe(0)
    await page.context().close()
  })

  it('rebuilds as text a session its Harness lost, and keeps the original to read with a link', async () => {
    // Brought in as it was, then gone from the agent's own store.
    const listed = await owner.json<HistoryList>('history/list', { method: 'POST', body: { projectId, harnessId: 'codex' } })
    const handle = listed.rows.find(item => item.title === 'Lost later')!.handle
    const lost = await owner.json<HistoryImportResult>('history/imports', { method: 'POST', body: { requestId: randomUUID(), handle } })
    const history = JSON.parse(await readFile(historyFile, 'utf8')) as { sessions: Array<{ sessionId: string }> }
    await writeFile(historyFile, JSON.stringify({ sessions: history.sessions.filter(item => item.sessionId !== 'ext-lost') }))
    const state = JSON.parse(await readFile(codexState, 'utf8').catch(() => '{}')) as Record<string, unknown>
    delete state['ext-lost']
    await writeFile(codexState, JSON.stringify(state))

    const page = await open(1440, 'light')
    await page
      .getByRole('button', { name: /Lost later/u })
      .first()
      .click()
    await page.locator('.topbar-imported', { hasText: '已接入' }).waitFor()
    const composer = page.getByRole('textbox', { name: '继续对话', exact: true })
    await composer.fill('echo 还在吗')
    const refused = page.waitForResponse(response => /\/tasks\/[^/]+\/prompt$/u.test(response.url()))
    await composer.press('Enter')
    expect((await refused).status()).toBe(409)
    const stop = page.locator('.composer-stop')
    await stop.getByText('Harness 找不到原来的会话了', { exact: true }).waitFor()
    await shot(page, 'lost-1440-light')

    const prompts = async () =>
      (await readLog(plainLog)).filter(entry => entry.event === 'recv' && entry.method === 'session/prompt').length
    const before = await prompts()
    await stop.getByRole('button', { name: '按文字重建', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '按文字重建', exact: true })
    await dialog.getByRole('button', { name: /继续用/u }).click()
    await page
      .getByRole('menuitemradio', { name: /Fake/u })
      .or(page.getByRole('radio', { name: /Fake/u }))
      .first()
      .click()
    await dialog.getByText('按文字重建，不是原样恢复', { exact: true }).waitFor()
    await shot(page, 'lost-rebuild-1440-light')
    await dialog.getByRole('button', { name: '按文字重建', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await page.locator('.topbar-imported', { hasText: '已接入 · 按文字重建' }).waitFor()
    await page.locator('.composer-seed').waitFor()
    const rebuilt = (await tasks()).find(task => task.imported?.fromTaskId === lost.taskId)!
    expect(rebuilt.harnessId).toBe('fake')
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(await prompts()).toBe(before)
    await shot(page, 'lost-rebuilt-1440-light')

    // The original stays to read, with the way to the new one.
    await page.locator(`.sidebar [data-task-id="${lost.taskId}"]`).click()
    await shot(page, 'lost-original-1440-light')
    const link = page.locator('.history-rebuilt')
    await link.getByText('已按文字重建为新会话', { exact: true }).waitFor()
    await page.getByText('已按文字重建为新会话 · 这个会话只能查看').first().waitFor()
    await shot(page, 'lost-original-1440-light')
    await link.getByRole('button', { name: /打开/u }).click()
    await page.locator('.topbar-imported', { hasText: '按文字重建' }).waitFor()
    await page.context().close()
  })

  it('shows a work-scope device the entry locked', async () => {
    const page = await open(1440, 'light', 'work')
    const locked = page.locator('.history-entry[data-locked]')
    await locked.getByText('接入已有会话', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: '接入已有会话', exact: true }).count()).toBe(0)
    await locked.getByRole('button', { name: '为什么不能接入', exact: true }).click()
    await locked.getByText(/开启「可以看项目文件」后可用/u).waitFor()
    // Nor does it see the sessions brought in, which are private.
    const listed = (await page.evaluate(() => [...document.querySelectorAll('[data-task-id]')].map(item => item.textContent))).join('\n')
    expect(listed).not.toContain('Login bug')
    await shot(page, 'locked-1440-light')
    await page.context().close()
  })

  it('goes through the same pages at 390', async () => {
    const page = await open(390, 'dark')
    await page.locator('.phone-list-head').getByRole('button', { name: '新建会话', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: '新会话', exact: true })
    await sheet.getByRole('button', { name: '接入已有会话', exact: true }).click()
    const dialog = dialogOf(page)
    await dialog.locator('.history-row').first().waitFor()
    await noHorizontalOverflow(page)
    await shot(page, 'list-390-dark')
    await dialog.getByRole('button', { name: /Open in a terminal/u }).click()
    await dialog.getByText('这个会话正在别处使用', { exact: true }).waitFor()
    await shot(page, 'busy-390-dark')
    // The browser's back goes from a preview to the list.
    await page.goBack()
    await dialog.getByRole('button', { name: /Phone notes/u }).click()
    await dialog.getByRole('button', { name: '接入', exact: true }).waitFor()
    await noHorizontalOverflow(page)
    await shot(page, 'preview-390-dark')
    await dialog.getByRole('button', { name: '接入', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await page.locator('.topbar-imported').waitFor()
    await page.locator('.topbar h1', { hasText: 'Phone notes' }).waitFor()
    await noHorizontalOverflow(page)
    await shot(page, 'imported-390-dark')
    await page.context().close()
  })
})
