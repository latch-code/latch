import { _electron, chromium, type ElectronApplication, type Frame, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot, PluginBuild, PluginPackageDetail, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { writeHostState } from '@latch/host/host-state'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSection, openSettings, settleShell } from './helpers/layout.ts'

const OUTPUT = 'test-results/app-build'
const TITLE = '计数页'
const SLOW = { timeout: 30_000 }

/** What the fake agent writes into the draft, turn by turn (FAKE_ACP_EDIT_QUEUE): a page, a broken one, a fixed one. */
const manifest = (id: string) =>
  JSON.stringify(
    {
      formatVersion: 2,
      id,
      name: TITLE,
      version: '0.1.0',
      description: '',
      requires: { appSdk: '^1' },
      apps: [
        {
          id: 'main',
          title: TITLE,
          icon: 'list-checks',
          entry: 'index.tsx',
          dataVersion: 1,
          capabilities: { 'tasks.read': true, 'tasks.start': { projects: 'any' } },
          preview: { tasks: [{ title: '样例会话', status: 'idle' }] },
        },
      ],
    },
    null,
    2,
  )
const page = (label: string) => `import { useEffect, useState } from 'react'
import { defineApp, type AppTask, type PageProps } from '@latch/app-sdk'

function Page({ latch, ui }: PageProps) {
  const [tasks, setTasks] = useState<AppTask[]>([])
  const [result, setResult] = useState('')
  useEffect(() => latch.tasks.subscribe({ limit: 5 }, update => setTasks(update.tasks)), [])
  return (
    <ui.Group title="${label}">
      <p id="label">${label}</p>
      <p id="count">{String(tasks.length)}</p>
      <ul id="tasks">{tasks.map(task => <li key={task.id}>{task.title}</li>)}</ul>
      <ui.Button
        variant="primary"
        onClick={() => {
          latch.tasks.start({ prompt: '开始' }).then(
            value => setResult('started:' + value.sessionId),
            (error: { code: string }) => setResult(error.code),
          )
        }}>
        开始
      </ui.Button>
      <p id="result">{result}</p>
    </ui.Group>
  )
}

export default defineApp({ page: Page })
`
const BROKEN = `import { defineApp } from '@latch/app-sdk'
const count: number = 'one'
export default defineApp({ page: () => null })
`

async function fakeAgent(host: TestHost, owner: TestDevice, queue: string): Promise<void> {
  const saved = await owner.request('agents', {
    method: 'POST',
    body: {
      id: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_LOG: join(host.root, 'agent.log'), FAKE_ACP_EDIT_QUEUE: queue },
    },
  })
  expect(saved.status).toBe(201)
}

async function idle(owner: TestDevice, sessionId: string) {
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, SLOW).toBe('idle')
}

async function frameIn(locator: Locator, selector: string): Promise<Frame> {
  let found: Frame | null = null
  await expect
    .poll(async () => {
      found = (await (await locator.elementHandle({ timeout: 1_000 }).catch(() => null))?.contentFrame()) ?? null
      return found
        ? await found
            .locator(selector)
            .count()
            .catch(() => 0)
        : 0
    }, SLOW)
    .toBe(1)
  return found!
}

describe('page drafts from a session, built by the Host (browser)', () => {
  it('starts a session with the skeleton, builds what the agent wrote, and shows the applied page on a 390 phone', async () => {
    await mkdir(OUTPUT, { recursive: true })
    const host = await startTestHost({ hostName: '工作电脑', sessionFolders: true })
    const browser = await chromium.launch(browserLaunchOptions())
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const queue = join(host.root, 'edits.json')
      await fakeAgent(host, owner, queue)
      // The first turn writes the page; the skeleton's own manifest is replaced so the page has a name and samples.
      const started = await owner.confirmed('tasks', {
        body: { prompt: '做一个计数页', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', appDraft: true },
      })
      expect(started.status).toBe(201)
      const { sessionId } = (await started.json()) as { sessionId: string }
      await idle(owner, sessionId)
      const cwd = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.cwd!
      const skeleton = JSON.parse(await readFile(join(cwd, 'latch-app', 'latch-app.json'), 'utf8')) as { id: string }
      await writeFile(queue, JSON.stringify([{ path: 'latch-app/index.tsx', content: page('第一版') }]))
      await writeFile(join(cwd, 'latch-app', 'latch-app.json'), manifest(skeleton.id))
      await owner.json(`tasks/${sessionId}/prompt`, { body: { prompt: '写页面', requestId: randomUUID() } })
      await idle(owner, sessionId)

      const draft = (
        await owner.json<{ package: PluginPackageDetail }>('plugin-packages/import', { body: { requestId: randomUUID(), sessionId } })
      ).package
      const build = (
        await owner.json<{ build: PluginBuild }>(`plugin-packages/${draft.id}/build`, {
          body: { requestId: randomUUID(), revision: draft.revision },
        })
      ).build
      expect(build.status).toBe('ok')
      expect(
        (await owner.confirmed(`plugin-packages/${draft.id}/apply`, { body: { requestId: randomUUID(), revision: draft.revision } }))
          .status,
      ).toBe(200)
      expect((await owner.json<AppSnapshot>('snapshot')).apps?.[0]?.bundleHash).toBe(build.modules[0]!.bundleHash)

      // A phone's browser: the page from the 应用 tab, and 设置 › 插件 says where pages are changed.
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' })
      const phone = await context.newPage()
      await enrollBrowser(phone, host)
      await phone
        .getByRole('tab', { name: '应用' })
        .or(phone.getByRole('button', { name: '应用', exact: true }))
        .first()
        .click()
      await phone.getByRole('button', { name: TITLE }).first().click()
      const frame = await frameIn(phone.locator('iframe.app-frame'), '#label')
      expect(await frame.locator('#label').textContent()).toBe('第一版')
      await settleShell(phone)
      await noHorizontalOverflow(phone)
      await phone.screenshot({ path: `${OUTPUT}/phone-page-390.png` })
      // Changing the page happens on the Mac: the page's menu says where.
      await phone.getByRole('button', { name: '页面操作' }).click()
      await phone.getByRole('menuitem', { name: '在 工作电脑 上修改' }).waitFor()
      await phone.screenshot({ path: `${OUTPUT}/phone-menu-390.png` })
      await phone.keyboard.press('Escape')

      // A new version that throws before it draws: the open page falls back to the version it showed, and says so.
      await writeFile(
        join(cwd, 'latch-app', 'index.tsx'),
        "import { defineApp } from '@latch/app-sdk'\nexport default defineApp({ page: () => { throw new Error('第二版打不开') } })\n",
      )
      const second = (
        await owner.json<{ package: PluginPackageDetail }>('plugin-packages/import', { body: { requestId: randomUUID(), sessionId } })
      ).package
      const secondBuild = (
        await owner.json<{ build: PluginBuild }>(`plugin-packages/${second.id}/build`, {
          body: { requestId: randomUUID(), revision: second.revision },
        })
      ).build
      expect(secondBuild.status).toBe('ok')
      expect(
        (await owner.confirmed(`plugin-packages/${second.id}/apply`, { body: { requestId: randomUUID(), revision: second.revision } }))
          .status,
      ).toBe(200)
      await phone.getByText('新版本没有打开，正在显示上一个版本').waitFor({ timeout: 30_000 })
      const back = await frameIn(phone.locator('iframe.app-frame'), '#label')
      expect(await back.locator('#label').textContent()).toBe('第一版')
      await phone.screenshot({ path: `${OUTPUT}/phone-fallback-390.png` })
      await context.close()
    } finally {
      await browser.close()
      await host.close()
    }
  })
})

const electronE2E = latchEnv(process.env, 'ELECTRON_E2E') === '1'

describe.skipIf(!electronE2E || process.platform !== 'darwin')('page drafts on this Mac (desktop)', () => {
  it('goes 让 Agent 做 › 作为应用草稿 › 构建 › 预览 › 应用, hands a failed build back, and rebuilds while 开发中', async () => {
    await mkdir(OUTPUT, { recursive: true })
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-app-build-'))
    const testHost = await startTestHost({ uiDir: resolve('dist/web'), hostName: '工作电脑', sessionFolders: true })
    const { host } = testHost
    let application: ElectronApplication | undefined
    try {
      const owner = await testHost.enroll({ listener: 'unix' })
      const queue = join(testHost.root, 'edits.json')
      await fakeAgent(testHost, owner, queue)
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
      const connect = window.getByRole('button', { name: '继续', exact: true })
      const connected = window.locator('.app-shell[data-connection="connected"]')
      await connect.or(connected).first().waitFor()
      if (await connect.isVisible()) await connect.click()
      await connected.waitFor()

      // 让 Agent 做: a session of its own with the skeleton; the agent's first turn writes the page.
      let settings = await openSettings(window)
      await openSection(settings, '插件')
      await settings.getByRole('button', { name: '让 Agent 做' }).click()
      const ask = window.getByRole('dialog', { name: '让 Agent 做' })
      await ask.getByRole('textbox', { name: '想要的页面' }).fill('做一个计数页：列出最近的会话')
      const fake = ask.getByRole('radio', { name: 'Fake' })
      if (await fake.count()) await fake.click()
      // The agent's first turn finds the skeleton; the manifest it would write is set before it runs.
      const cwdBefore = new Set((await owner.json<AppSnapshot>('snapshot')).tasks.map(task => task.id))
      await writeFile(queue, JSON.stringify([{ path: 'latch-app/index.tsx', content: page('第一版') }]))
      await ask.getByRole('button', { name: '开始' }).click()
      await expect
        .poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => !cwdBefore.has(task.id))?.id, SLOW)
        .toBeTruthy()
      const sessionId = (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => !cwdBefore.has(task.id))!.id
      await idle(owner, sessionId)
      const cwd = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.cwd!
      const id = (JSON.parse(await readFile(join(cwd, 'latch-app', 'latch-app.json'), 'utf8')) as { id: string }).id
      await writeFile(join(cwd, 'latch-app', 'latch-app.json'), manifest(id))

      // 改动 › 作为应用草稿, which opens 设置 › 插件 with the draft's card.
      await window
        .getByRole('tab', { name: '改动' })
        .or(window.getByRole('button', { name: '改动' }))
        .first()
        .click()
      await window.getByRole('button', { name: '作为应用草稿' }).click()
      settings = window.locator('.settings-page')
      const card = settings.locator('.new-app-card').filter({ hasText: id })
      await card.waitFor()
      await expect.poll(() => card.getAttribute('data-phase')).toBe('draft')
      await window.screenshot({ path: `${OUTPUT}/desktop-draft-1440.png` })
      await card.getByRole('button', { name: '构建' }).click()
      await expect.poll(() => card.getAttribute('data-phase'), SLOW).toBe('preview')
      // The preview: the same frame and bundle, samples instead of sessions, and starting does nothing.
      const preview = await frameIn(card.locator('iframe.app-frame'), '#label')
      expect(await preview.locator('#tasks').textContent()).toBe('样例会话')
      await preview.getByRole('button', { name: '开始' }).click()
      await expect.poll(() => preview.locator('#result').textContent()).toBe('preview')
      await card.getByText('预览里不会开会话').waitFor()
      await window.screenshot({ path: `${OUTPUT}/desktop-preview-1440.png` })
      // The card and its preview at other widths, dark, with reduced motion, and with the keyboard on 应用.
      const resize = (width: number, height: number) =>
        application!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size.width, size.height), {
          width,
          height,
        })
      for (const [width, height] of [
        [768, 1000],
        [390, 844],
        [320, 700],
      ] as const) {
        await resize(width, height)
        await card.scrollIntoViewIfNeeded()
        const actual = await window.evaluate(() => document.documentElement.clientWidth)
        await window.screenshot({ path: `${OUTPUT}/desktop-preview-${actual}.png` })
      }
      await resize(1440, 960)
      await window.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
      await card.scrollIntoViewIfNeeded()
      await window.screenshot({ path: `${OUTPUT}/desktop-preview-dark-reduced-1440.png` })
      await window.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })
      await card.getByRole('button', { name: '应用', exact: true }).focus()
      await window.keyboard.press('Shift+Tab')
      await window.keyboard.press('Tab')
      await window.screenshot({ path: `${OUTPUT}/desktop-preview-focus-1440.png` })
      const sessionsBefore = (await owner.json<AppSnapshot>('snapshot')).tasks.length

      await card.getByRole('button', { name: '应用', exact: true }).click()
      await expect.poll(() => card.getAttribute('data-phase'), SLOW).toBe('applied')
      expect((await owner.json<AppSnapshot>('snapshot')).tasks.length).toBe(sessionsBefore)
      // 打开 goes to the page, in the sidebar's 应用 group.
      await card.getByRole('button', { name: '打开' }).click()
      await window.locator('.sidebar-apps').getByRole('button', { name: TITLE }).waitFor()
      const first = await frameIn(window.locator('iframe.app-frame'), '#label')
      expect(await first.locator('#label').textContent()).toBe('第一版')
      await window.locator('.apps-page').getByRole('button', { name: '新建会话' }).click()
      await window.locator('.apps-page').waitFor({ state: 'detached' })
      settings = await openSettings(window)
      await openSection(settings, '插件')
      await card.waitFor()

      // 开发中: a turn that breaks the page keeps the last preview and shows the diagnostics; 交回 Agent drafts them.
      await card.getByRole('switch', { name: '开发中' }).click()
      await expect
        .poll(async () => (await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${id}`)).package.source?.dev)
        .toBe(true)
      await writeFile(queue, JSON.stringify([{ path: 'latch-app/index.tsx', content: BROKEN }]))
      await owner.json(`tasks/${sessionId}/prompt`, { body: { prompt: '改一下', requestId: randomUUID() } })
      await idle(owner, sessionId)
      await expect.poll(() => card.getAttribute('data-phase'), SLOW).toBe('build-failed')
      await card.getByText('index.tsx:2:7').waitFor()
      await window.screenshot({ path: `${OUTPUT}/desktop-build-failed-1440.png` })
      await window.emulateMedia({ colorScheme: 'dark' })
      await window.screenshot({ path: `${OUTPUT}/desktop-build-failed-dark-1440.png` })
      await window.emulateMedia({ colorScheme: 'light' })
      const messages = (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.length
      await card.getByRole('button', { name: '交回 Agent' }).click()
      const composer = window.locator('.composer textarea').first()
      await expect.poll(() => composer.inputValue(), SLOW).toContain('index.tsx:2:7')
      expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.length).toBe(messages)

      // The next turn fixes it: built again, and 应用新版本 rebuilds the page's frame everywhere.
      await writeFile(queue, JSON.stringify([{ path: 'latch-app/index.tsx', content: page('第二版') }]))
      await owner.json(`tasks/${sessionId}/prompt`, { body: { prompt: '修好', requestId: randomUUID() } })
      await idle(owner, sessionId)
      settings = await openSettings(window)
      await openSection(settings, '插件')
      const again = settings.locator('.new-app-card').filter({ hasText: id })
      await expect.poll(() => again.getAttribute('data-phase'), SLOW).toBe('preview')
      await again.getByRole('button', { name: '应用新版本' }).click()
      await expect.poll(() => again.getAttribute('data-phase'), SLOW).toBe('applied')
      await again.getByRole('button', { name: '打开' }).click()
      const applied = await frameIn(window.locator('iframe.app-frame'), '#label')
      await expect.poll(() => applied.locator('#label').textContent(), SLOW).toBe('第二版')
      await window.screenshot({ path: `${OUTPUT}/desktop-applied-1440.png` })
    } finally {
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
