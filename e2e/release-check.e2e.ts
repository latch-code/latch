import {
  _electron,
  chromium,
  type Browser,
  type BrowserContext,
  type ElectronApplication,
  type Frame,
  type Locator,
  type Page,
} from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, PluginBuild, PluginPackageDetail, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { writeHostState } from '@latch/host/host-state'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, settleShell } from './helpers/layout.ts'

const OUTPUT = 'test-results/release-check'
const EXAMPLE = resolve('examples/release-check')
const PLUGIN = 'release-check'
const TITLE = '发布检查'
const SLOW = { timeout: 30_000 }

/** The example's files as the Agent writes them into the session's `latch-app/` in one turn. */
async function exampleEdits(): Promise<Array<{ path: string; content: string }>> {
  const files: string[] = []
  const walk = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true }))
      if (entry.isDirectory()) await walk(join(folder, entry.name))
      else files.push(join(folder, entry.name))
  }
  await walk(EXAMPLE)
  return Promise.all(
    files.sort().map(async file => ({ path: `latch-app/${relative(EXAMPLE, file)}`, content: await readFile(file, 'utf8') })),
  )
}

/** A reply that ends with the block the page asks for: two passes and one failure. */
const VALID = [
  '三项都看过了。',
  '',
  '```latch-release-check',
  JSON.stringify({
    items: [
      { id: 1, status: 'pass', evidence: 'package.json 是 0.10.0' },
      { id: 2, status: 'fail', evidence: 'CHANGELOG 缺 0.10.0 一节' },
      { id: 3, status: 'pass', evidence: 'pnpm test:e2e 全部通过' },
    ],
  }),
  '```',
].join('\n')
/** A reply whose block is not JSON. */
const MALFORMED = '版本号对了，变更记录还差一节。\n\n```latch-release-check\n{ items: 版本号 通过\n```'

async function fakeAgent(host: TestHost, owner: TestDevice, edits: string, replies: string): Promise<void> {
  const saved = await owner.confirmed('agents', {
    method: 'POST',
    body: {
      id: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_LOG: join(host.root, 'agent.log'), FAKE_ACP_EDIT_QUEUE: edits, FAKE_ACP_REPLY_QUEUE: replies },
    },
  })
  expect(saved.status).toBe(201)
}

async function idle(owner: TestDevice, sessionId: string) {
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('idle')
}

/** The drawn page's frame inside `scope`. */
async function pageFrame(scope: Locator): Promise<Frame> {
  let found: Frame | null = null
  await expect
    .poll(async () => {
      found = (await (await scope.elementHandle({ timeout: 1_000 }).catch(() => null))?.contentFrame()) ?? null
      return found
        ? await found
            .locator('.rc')
            .count()
            .catch(() => 0)
        : 0
    }, SLOW)
    .toBe(1)
  return found!
}

/** Opens 发布检查 from the sidebar unless it is already open. */
async function openPage(page: Page): Promise<Frame> {
  if (!(await page.locator('iframe.app-frame').count())) {
    // 应用 sits at the sidebar's foot; its pages stand where the sidebar stands.
    if (!(await page.locator('.sidebar-apps').count()))
      await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '应用', exact: true }).click()
    await page.locator('.sidebar-apps').getByRole('button', { name: TITLE }).click()
  }
  return pageFrame(page.locator('iframe.app-frame:not([hidden])'))
}

/** The page in light and dark, each once the frame has taken the theme. */
async function shots(page: Page, frame: Frame, name: string): Promise<void> {
  const width = page.viewportSize()?.width ?? 0
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await expect.poll(() => frame.evaluate(() => document.documentElement.dataset.theme)).toBe(scheme)
    await settleShell(page)
    await page.screenshot({ path: `${OUTPUT}/${name}-${scheme}-${width}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

/** Draft from a session, built and applied: the Agent writes the example, the Host imports, builds and applies it. */
async function draftAndApply(owner: TestDevice, edits: string): Promise<{ sessionId: string; applied: PluginPackageDetail }> {
  await writeFile(edits, JSON.stringify([await exampleEdits()]))
  const started = await owner.confirmed('tasks', {
    body: { prompt: '做一个发布检查页', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', appDraft: true },
  })
  expect(started.status).toBe(201)
  const { sessionId } = (await started.json()) as { sessionId: string }
  await idle(owner, sessionId)
  expect((await owner.json<{ present: boolean }>(`plugin-packages/session-draft?sessionId=${sessionId}`)).present).toBe(true)
  const draft = (
    await owner.json<{ package: PluginPackageDetail }>('plugin-packages/import', { body: { requestId: randomUUID(), sessionId } })
  ).package
  const build = (
    await owner.json<{ build: PluginBuild }>(`plugin-packages/${draft.id}/build`, {
      body: { requestId: randomUUID(), revision: draft.revision },
    })
  ).build
  expect(build).toMatchObject({ status: 'ok', typeChecked: true, diagnostics: [] })
  const response = await owner.confirmed(`plugin-packages/${draft.id}/apply`, {
    body: { requestId: randomUUID(), revision: draft.revision },
  })
  expect(response.status).toBe(200)
  return { sessionId, applied: ((await response.json()) as { package: PluginPackageDetail }).package }
}

describe('发布检查, the example page, from an Agent session to the phone', () => {
  let host: TestHost
  let browser: Browser
  let owner: TestDevice
  let replies: string
  let hold: string
  let revision: string
  let edits: string
  const contexts: BrowserContext[] = []
  const sessions = async () => (await owner.json<AppSnapshot>('snapshot')).tasks.length
  const stored = async (scope: string, key: string) => {
    const response = await owner.request(
      `apps/${PLUGIN}/data/${encodeURIComponent(scope)}/${encodeURIComponent(key)}?app=${PLUGIN}/main&revision=${revision}`,
    )
    return response.status === 200 ? ((await response.json()) as { document: { version: number; value: unknown } }).document : undefined
  }
  const queue = (...entries: unknown[]) => writeFile(replies, JSON.stringify(entries))
  let page: Page
  let context: BrowserContext

  beforeAll(async () => {
    await mkdir(OUTPUT, { recursive: true })
    host = await startTestHost({ hostName: '工作电脑', sessionFolders: true })
    owner = await host.enroll({ listener: 'unix' })
    replies = join(host.root, 'replies.json')
    hold = join(host.root, 'hold')
    await fakeAgent(host, owner, join(host.root, 'edits.json'), replies)
    edits = join(host.root, 'edits.json')
    browser = await chromium.launch(browserLaunchOptions())
  })
  afterAll(async () => {
    for (const item of contexts) await item.close()
    await browser?.close()
    await host?.close()
  })

  it('drafts the page from an Agent session, builds and applies it, and lists it under 应用', async () => {
    revision = (await draftAndApply(owner, edits)).applied.appliedRevision!
    const app = (await owner.json<AppSnapshot>('snapshot')).apps?.find(item => item.pluginId === PLUGIN)
    expect(app).toMatchObject({ title: TITLE, status: 'ready', capabilities: { 'tasks.start': { projects: 'any' } } })
    context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    contexts.push(context)
    page = await context.newPage()
    await enrollBrowser(page, host)
    await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '应用', exact: true }).waitFor()
  })

  it('starts empty, then keeps the checklist with ifVersion and says so when another device changed it first', async () => {
    const frame = await openPage(page)
    await frame.getByText('还没有检查项').waitFor()
    expect(await frame.getByRole('button', { name: '开始检查' }).isDisabled()).toBe(true)
    // The Harness by the name this device shows for it, never its ID.
    await frame.locator('.rc-target').getByText('Fake', { exact: true }).waitFor()
    expect(await frame.locator('.rc-target').getByText('fake', { exact: true }).count()).toBe(0)
    await shots(page, frame, 'empty')

    await frame.getByRole('button', { name: '添加第一项' }).click()
    const fill = async (index: number, title: string, where: string) => {
      await frame.getByRole('textbox', { name: `第 ${index} 项` }).fill(title)
      await frame
        .getByRole('textbox', { name: '看哪里' })
        .nth(index - 1)
        .fill(where)
    }
    await fill(1, '版本号已更新', 'package.json')
    await frame.getByRole('button', { name: '添加一项' }).click()
    await fill(2, '变更记录写到这一版', 'CHANGELOG.md')
    await frame.getByRole('button', { name: '添加一项' }).click()
    await fill(3, 'e2e 通过', 'pnpm test:e2e')
    await shots(page, frame, 'editing')

    // Another device saved a checklist first: the page says so instead of overwriting it, and keeps its own on request.
    const via = { app: `${PLUGIN}/main`, revision }
    const other = await owner.request(`apps/${PLUGIN}/data/project%3Adefault/checklist`, {
      method: 'PUT',
      body: { via, requestId: randomUUID(), ifVersion: 0, value: { items: [{ id: 'other', title: '别处加的一项', where: '' }] } },
    })
    expect(other.status).toBe(200)
    await frame.getByRole('button', { name: '保存', exact: true }).click()
    await frame.getByText('清单在别处改过').waitFor()
    await shots(page, frame, 'checklist-conflict')
    await frame.getByRole('button', { name: '保留我的' }).click()
    await frame.getByRole('button', { name: '编辑' }).waitFor()
    const saved = await stored('project:default', 'checklist')
    expect(saved?.version).toBe(2)
    expect((saved?.value as { items: Array<{ title: string }> }).items.map(item => item.title)).toEqual([
      '版本号已更新',
      '变更记录写到这一版',
      'e2e 通过',
    ])
    expect(await frame.getByRole('button', { name: '开始检查' }).isEnabled()).toBe(true)
    await shots(page, frame, 'ready')
  })

  it('starts one session, follows it, reads the block into per-item results, and saves the note', async () => {
    const frame = await openPage(page)
    const before = await sessions()
    await queue({ text: VALID, until: hold })
    await frame.getByRole('button', { name: '开始检查' }).click()
    await frame.getByText('运行中', { exact: true }).waitFor(SLOW)
    // The request was kept before the session was asked for, and now names the session.
    await expect
      .poll(async () => ((await stored('plugin', 'pending'))?.value as { sessionId?: string } | undefined)?.sessionId, SLOW)
      .toBeTruthy()
    const pending = (await stored('plugin', 'pending'))!.value as { sessionId: string; requestId: string }
    const started = (await owner.json<TaskDetail>(`tasks/${pending.sessionId}`)).summary
    expect(started.origin?.app).toBe(`${PLUGIN}/main`)
    expect(started.title).toBe('发布检查 · 默认文件夹')
    await shots(page, frame, 'running')

    await writeFile(hold, '')
    await frame.getByText('刚刚完成 · 2 项通过，1 项没通过').waitFor(SLOW)
    expect(await sessions()).toBe(before + 1)
    expect(await stored('plugin', 'pending')).toBeUndefined()
    const rows = frame.locator('.ui-row')
    await expect.poll(() => rows.filter({ hasText: '版本号已更新' }).textContent()).toContain('通过')
    await expect.poll(() => rows.filter({ hasText: '变更记录写到这一版' }).textContent()).toContain('没通过')
    expect(await rows.filter({ hasText: '变更记录写到这一版' }).textContent()).toContain('CHANGELOG 缺 0.10.0 一节')

    await frame.getByRole('textbox', { name: '意见' }).fill('补完 CHANGELOG 再发；签名下周换证书。')
    await frame.getByText('已保存').waitFor(SLOW)
    const run = await stored('project:default', `runs/${pending.sessionId}`)
    expect(run?.value).toMatchObject({ structured: true, note: '补完 CHANGELOG 再发；签名下周换证书。', requestId: pending.requestId })
    await shots(page, frame, 'results')
  })

  it('reopens on the saved results and note, and opens no second session', async () => {
    const before = await sessions()
    await page.reload()
    const frame = await openPage(page)
    await frame.getByText(/^上次检查 · .+ · 2 项通过，1 项没通过$/u).waitFor(SLOW)
    expect(await frame.getByRole('textbox', { name: '意见' }).inputValue()).toBe('补完 CHANGELOG 再发；签名下周换证书。')
    await new Promise(done => setTimeout(done, 1_000))
    expect(await sessions()).toBe(before)
    await shots(page, frame, 'reopened')
  })

  it('shows the reply marked 没有结构化结果 when its block cannot be read', async () => {
    const frame = await openPage(page)
    await queue(MALFORMED)
    await frame.getByRole('button', { name: '再查一次' }).click()
    await frame.getByText('没有结构化结果').first().waitFor(SLOW)
    await expect.poll(() => frame.locator('.rc-reply').textContent()).toContain('版本号对了，变更记录还差一节。')
    await shots(page, frame, 'unstructured')
  })

  it('says the check did not finish when the session fails', async () => {
    const frame = await openPage(page)
    await queue({ error: 'Authentication required' })
    await frame.getByRole('button', { name: '再查一次' }).click()
    await frame.getByText('检查没有完成').waitFor(SLOW)
    await shots(page, frame, 'failed')
  })

  it('keeps an unknown start unknown, then finds its one session by request ID, on 查询结果 and on reopening', async () => {
    let frame = await openPage(page)
    const lost = async () => {
      // The Host takes the next start; its answer never reaches the page.
      let taken = false
      await page.route(/\/link\/api\/tasks$/u, async route => {
        if (taken || route.request().method() !== 'POST') return route.continue()
        taken = true
        await route.fetch()
        await route.abort('failed')
      })
    }
    const before = await sessions()
    await queue(VALID)
    await lost()
    await frame.getByRole('button', { name: '再查一次' }).click()
    await frame.getByText('开始结果未知').waitFor(SLOW)
    const pending = (await stored('plugin', 'pending'))!.value as { requestId: string; sessionId?: string }
    expect(pending.sessionId).toBeUndefined()
    await frame.getByText(pending.requestId).waitFor()
    await shots(page, frame, 'unknown')
    await page.unrouteAll()
    await frame.getByRole('button', { name: '查询结果' }).click()
    await frame.getByText('刚刚完成 · 2 项通过，1 项没通过').waitFor(SLOW)
    expect(await sessions()).toBe(before + 1)

    // Lost again, and the page is reopened instead: the pending request is looked up, never started twice.
    await queue(VALID)
    await lost()
    await frame.getByRole('button', { name: '再查一次' }).click()
    await frame.getByText('开始结果未知').waitFor(SLOW)
    await page.unrouteAll()
    await page.reload()
    frame = await openPage(page)
    await frame.getByText(/2 项通过，1 项没通过$/u).waitFor(SLOW)
    await expect.poll(() => stored('plugin', 'pending'), SLOW).toBeUndefined()
    expect(await sessions()).toBe(before + 2)
  })

  it('keeps the checklist read-only while the Mac is offline', async () => {
    const frame = await openPage(page)
    await context.setOffline(true)
    await page.locator('.app-page-offline').waitFor(SLOW)
    await frame.getByText('离线 · 清单只能看，连上后才能检查').waitFor(SLOW)
    expect(await frame.getByRole('button', { name: '编辑' }).isDisabled()).toBe(true)
    expect(await frame.getByRole('button', { name: '再查一次' }).isDisabled()).toBe(true)
    expect(await frame.getByRole('textbox', { name: '意见' }).isDisabled()).toBe(true)
    await shots(page, frame, 'offline')
    await context.setOffline(false)
    await page.locator('.app-page-offline').waitFor({ state: 'detached', ...SLOW })
    await expect.poll(() => frame.getByRole('button', { name: '编辑' }).isEnabled(), SLOW).toBe(true)
  })

  it('reads the same saved results on a 390 phone from the 应用 tab', async () => {
    const phoneContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: 'zh-CN',
    })
    contexts.push(phoneContext)
    const phone = await phoneContext.newPage()
    await enrollBrowser(phone, host)
    const before = await sessions()
    await phone.locator('.phone-tabs').getByRole('button', { name: '应用', exact: true }).click()
    await phone
      .locator('.apps-list')
      .getByRole('button', { name: new RegExp(TITLE, 'u') })
      .click()
    const frame = await pageFrame(phone.locator('iframe.app-frame:not([hidden])'))
    await frame.getByText(/^上次检查 · .+ · 2 项通过，1 项没通过$/u).waitFor(SLOW)
    expect(await sessions()).toBe(before)
    await noHorizontalOverflow(phone)
    expect(await frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await shots(phone, frame, 'phone-reopened')
    // A note written on the phone is saved, and the page open on the desktop shows it without a reload.
    await frame.getByRole('textbox', { name: '意见' }).fill('手机上看过，等 CHANGELOG。')
    await frame.getByText('已保存').waitFor(SLOW)
    const desktop = await openPage(page)
    await expect.poll(() => desktop.getByRole('textbox', { name: '意见' }).inputValue(), SLOW).toBe('手机上看过，等 CHANGELOG。')
    await shots(phone, frame, 'phone-note')
    // The narrowest phone and a tablet: nothing scrolls sideways; the results and the note stay in reach.
    for (const [width, height] of [
      [320, 700],
      [768, 1024],
    ] as const) {
      await phone.setViewportSize({ width, height })
      await noHorizontalOverflow(phone)
      expect(await frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await shots(phone, frame, 'phone-note')
    }
    // Keyboard: Tab reaches the page's controls in order, with the focus ring drawn; reduced motion keeps it still.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const again = await openPage(page)
    await again.getByRole('button', { name: '再查一次' }).focus()
    await page.keyboard.press('Tab')
    // The hint's label is the stop: its detail is the tooltip, open while it has the focus.
    expect(await again.evaluate(() => document.activeElement?.textContent)).toBe('开一个真实会话')
    await again.locator('.ui-tooltip:popover-open').waitFor()
    await page.keyboard.press('Tab')
    expect(await again.evaluate(() => document.activeElement?.textContent)).toBe('编辑')
    await page.screenshot({ path: `${OUTPUT}/focus-reduced-1440.png` })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  })
})

const electronE2E = latchEnv(process.env, 'ELECTRON_E2E') === '1'

describe.skipIf(!electronE2E || process.platform !== 'darwin')('发布检查 drafted on this Mac (desktop)', () => {
  it('goes from the session to 作为应用草稿 › 构建 › 预览 › 应用, and the 应用 entry opens the page', async () => {
    await mkdir(OUTPUT, { recursive: true })
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-release-check-'))
    const testHost = await startTestHost({ uiDir: resolve('dist/web'), hostName: '工作电脑', sessionFolders: true })
    const { host } = testHost
    let application: ElectronApplication | undefined
    try {
      const owner = await testHost.enroll({ listener: 'unix' })
      const edits = join(testHost.root, 'edits.json')
      await fakeAgent(testHost, owner, edits, join(testHost.root, 'replies.json'))
      await writeFile(edits, JSON.stringify([await exampleEdits()]))
      const started = await owner.confirmed('tasks', {
        body: { prompt: '做一个发布检查页', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', appDraft: true },
      })
      const { sessionId } = (await started.json()) as { sessionId: string }
      await idle(owner, sessionId)
      await writeHostState(testHost.dataDir, {
        version: 2,
        pid: process.pid,
        hostId: host.hostId,
        instanceId: host.instanceId,
        socketPath: host.socketPath,
        loopbackOrigin: host.loopbackOrigin,
        tlsOrigin: host.tlsOrigin ?? null,
        startedAt: new Date().toISOString(),
        dataDir: testHost.dataDir,
      })
      application = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${join(testHost.dataDir, 'host.json')}`,
          `--latch-user-data=${join(root, 'electron')}`,
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: Object.fromEntries(
          Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        timeout: 30_000,
      })
      const window: Page = await application.firstWindow()
      window.setDefaultTimeout(20_000)
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 960))
      const connect = window.getByRole('button', { name: '继续', exact: true })
      const connected = window.locator('.app-shell[data-connection="connected"]')
      await connect.or(connected).first().waitFor()
      if (await connect.isVisible()) await connect.click()
      await connected.waitFor()

      // The session the Agent wrote the page in: 改动 › 作为应用草稿 opens 设置 › 插件 with the draft's card.
      await window.locator(`[data-task-id="${sessionId}"]`).click()
      await window
        .getByRole('tab', { name: '改动' })
        .or(window.getByRole('button', { name: '改动' }))
        .first()
        .click()
      await window.getByRole('button', { name: '作为应用草稿' }).click()
      const settings = window.locator('.settings-page')
      await settings.getByRole('heading', { name: TITLE, exact: true }).waitFor()
      const card = settings.locator('.new-app-card').filter({ hasText: PLUGIN })
      await card.waitFor()
      await expect.poll(() => card.getAttribute('data-phase')).toBe('draft')
      await window.screenshot({ path: `${OUTPUT}/desktop-draft-1440.png` })
      await card.getByRole('button', { name: '构建' }).click()
      await expect.poll(() => card.getAttribute('data-phase'), SLOW).toBe('preview')
      // The preview: the sample sessions' project, no data, and every write and start inert.
      const preview = await pageFrame(card.locator('iframe.app-frame'))
      await preview.getByText('还没有检查项').waitFor()
      await preview.getByText('ledger-web').first().waitFor()
      expect(await preview.getByRole('button', { name: '添加第一项' }).isDisabled()).toBe(true)
      expect(await preview.getByRole('button', { name: '开始检查' }).isDisabled()).toBe(true)
      // The page knows it is a preview, and says so rather than calling this device view-only.
      await preview.getByText('预览', { exact: true }).waitFor()
      expect(await preview.getByText('这台设备只能查看').count()).toBe(0)
      const before = (await owner.json<AppSnapshot>('snapshot')).tasks.length
      await window.screenshot({ path: `${OUTPUT}/desktop-preview-1440.png` })
      await window.emulateMedia({ colorScheme: 'dark' })
      await window.screenshot({ path: `${OUTPUT}/desktop-preview-dark-1440.png` })
      await window.emulateMedia({ colorScheme: 'light' })

      await card.getByRole('button', { name: '应用', exact: true }).click()
      await window
        .getByRole('dialog', { name: '审阅并应用插件', exact: true })
        .getByRole('button', { name: '确认安装', exact: true })
        .click()
      await expect.poll(() => card.getAttribute('data-phase'), SLOW).toBe('applied')
      expect((await owner.json<AppSnapshot>('snapshot')).tasks.length).toBe(before)
      await card.getByRole('button', { name: '打开' }).click()
      await window.locator('.sidebar-apps').getByRole('button', { name: TITLE }).waitFor()
      const applied = await pageFrame(window.locator('iframe.app-frame'))
      // The preview's data stayed in the preview: the applied page starts from an empty checklist.
      await applied.getByText('还没有检查项').waitFor()
      await window.screenshot({ path: `${OUTPUT}/desktop-applied-1440.png` })
      await window.emulateMedia({ colorScheme: 'dark' })
      await window.screenshot({ path: `${OUTPUT}/desktop-applied-dark-1440.png` })
      await window.emulateMedia({ colorScheme: 'light' })
    } finally {
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
