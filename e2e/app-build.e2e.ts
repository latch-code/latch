import { _electron, chromium, type ElectronApplication, type Frame, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPluginPackageTemplate, type AppSnapshot, type PluginBuild, type PluginPackageDetail, type TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { writeHostState } from '@latch/host/host-state'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import {
  backToPhoneSessions,
  closeSettings,
  noHorizontalOverflow,
  openSection,
  openSettings,
  phoneStartScreen,
  reachable,
  settleShell,
} from './helpers/layout.ts'
import { promptValue } from './helpers/prompt.ts'

const OUTPUT = 'test-results/app-build'
const TITLE = '计数页'
const SLOW = { timeout: 30_000 }

const creatorPluginId = 'creator-checklist'
const creatorTitle = '创作交接清单'
const creatorInstructions = '先核对交接清单，再总结待办。'
const creatorTemplate = createPluginPackageTemplate('tool', creatorPluginId, creatorTitle)

/** A single fake ACP turn writes one installable plugin with both an executable tool and a text skill. */
const creatorEdits = [
  {
    path: 'latch-plugin/latch-plugin.json',
    content: JSON.stringify({
      ...creatorTemplate.manifest,
      skills: [{ id: 'handoff', name: creatorTitle, description: '交接检查', file: 'SKILL.md' }],
    }),
  },
  ...creatorTemplate.files.map(file => ({ ...file, path: `latch-plugin/${file.path}` })),
  { path: 'latch-plugin/SKILL.md', content: creatorInstructions },
]

/** Starts on the imported draft's settings page. All confirmation goes through the fixture's test backend. */
async function verifyCreatorPlugin(page: Page, host: TestHost): Promise<void> {
  const review = page.locator('.creator-plugin-review')
  const files = review.getByRole('button', { name: /^审阅文件/u })
  const loaded = () => host.host.registry.list().find(plugin => plugin.id === creatorPluginId)
  await review.waitFor()
  expect(loaded()).toBeUndefined()
  expect(await review.locator('.creator-plugin-source').textContent()).toContain('registerTool')
  await files.click()
  await page
    .getByRole('menuitemradio', { name: 'SKILL.md', exact: true })
    .or(page.getByRole('radio', { name: 'SKILL.md', exact: true }))
    .click()
  await expect.poll(() => review.locator('.creator-plugin-source').textContent()).toBe(creatorInstructions)
  await review.getByRole('button', { name: '返回创作会话', exact: true }).click()
  await page.locator('.settings-page').waitFor({ state: 'hidden' })
  const settings = await openSettings(page)
  await openSection(settings, '插件')
  await settings.locator('.plugin-nav-row').filter({ hasText: creatorTitle }).click()
  await review.waitFor()
  const mode = host.presence.mode
  const before = host.presence.requests.length
  host.presence.mode = 'manual'
  try {
    await review.getByRole('button', { name: '应用此草稿', exact: true }).click()
    const consent = page.getByRole('dialog', { name: '审阅并应用插件', exact: true })
    await consent.getByText('工作台代码', { exact: true }).waitFor()
    await consent.getByText('可能注册 Agent 工具', { exact: true }).waitFor()
    expect(host.presence.requests).toHaveLength(before)
    expect(loaded()).toBeUndefined()
    await page.screenshot({ path: `${OUTPUT}/creator-risk-review.png`, animations: 'disabled' })
    await consent.getByRole('button', { name: '确认安装', exact: true }).click()
    await expect.poll(() => host.presence.requests.length).toBe(before + 1)
    expect(host.presence.requests.at(-1)?.preview.action).toBe('plugin.package.apply')
    expect(loaded()).toBeUndefined()
    host.presence.approveNext()
    await expect.poll(() => loaded()?.capabilities).toContain('tool:creator_checklist_uppercase')
    const lease = host.host.registry.acquire('demo')
    try {
      expect(lease.skills?.find(skill => skill.name === creatorTitle)?.content).toBe(creatorInstructions)
      const tool = lease.tools.find(tool => tool.name === 'creator_checklist_uppercase')!
      expect(
        await tool.execute(
          { text: 'handoff-42' },
          {
            sessionId: 'review',
            callId: 'check',
            workspaceRoot: host.workspaceRoot,
            signal: new AbortController().signal,
          },
        ),
      ).toEqual({ text: 'HANDOFF-42' })
    } finally {
      lease.release()
    }
    await review.getByText('技能已启用。可在「我的 Agent」里为支持 Latch 技能的 Agent 选用。', { exact: true }).waitFor()
  } finally {
    host.presence.mode = mode
  }
}

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
  const saved = await owner.confirmed('agents', {
    method: 'POST',
    body: {
      id: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: {
        FAKE_ACP_LOG: join(host.root, 'agent.log'),
        FAKE_ACP_CONFIG: 'options',
        FAKE_ACP_EDIT_QUEUE: queue,
        FAKE_ACP_REPLY_QUEUE: join(host.root, 'replies.json'),
      },
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
  it.each([
    { width: 390, height: 844, theme: 'dark', mobile: true, navigation: '.phone-list:not([inert])' },
    { width: 768, height: 1024, theme: 'light', mobile: true, navigation: '.workbench-tablet-rail' },
    { width: 1440, height: 960, theme: 'light', mobile: false, navigation: '#session-navigation' },
  ] as const)(
    'filters the public catalog at $width without reading plugin assets and restores its draft on return',
    async ({ width, height, theme, mobile, navigation }) => {
      const registryRequests: string[] = []
      const host = await startTestHost({
        hostName: '工作电脑',
        sessionFolders: true,
        pluginRegistryFetch: async url => {
          registryRequests.push(url)
          throw new Error('Unexpected registry request')
        },
      })
      const browser = await chromium.launch(browserLaunchOptions())
      try {
        await host.enroll({ listener: 'unix' })
        const page = await browser.newPage({
          viewport: { width, height },
          isMobile: mobile,
          hasTouch: mobile,
          colorScheme: theme,
          ...(mobile
            ? { userAgent: 'Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' }
            : {}),
        })
        await enrollBrowser(page, host, { scopes: ['view', 'run'] })
        await phoneStartScreen(page)
        const home = page.locator('.workbench-home')
        const prompt = home.getByRole('textbox', { name: '新会话消息' })
        const draft = '没有发送的普通会话草稿'
        await prompt.fill(draft)
        expect(await home.getByRole('button', { name: /^模式：/u }).count()).toBe(0)
        const assetReads: string[] = []
        page.on('request', request => {
          if (new URL(request.url()).pathname.includes('/api/plugin-packages')) assetReads.push(request.method())
        })
        if (width < 768) await backToPhoneSessions(page)
        const entry = page.locator(navigation).getByRole('button', { name: '插件市场', exact: true })
        await entry.click()
        const catalog = page.getByRole('region', { name: '插件市场', exact: true })
        const search = catalog.getByRole('searchbox', { name: '搜索任务或插件', exact: true })
        await search.waitFor()
        if (width >= 768) expect(await entry.getAttribute('aria-current')).toBe('page')
        expect(await catalog.getByRole('tablist', { name: '插件来源', exact: true }).count()).toBe(0)
        expect(await catalog.getByText('添加插件', { exact: true }).count()).toBe(0)
        expect(await catalog.getByRole('button', { name: '创建插件', exact: true }).count()).toBe(0)
        await noHorizontalOverflow(page, catalog)
        await search.fill('交接')
        const categories = catalog.getByRole('group', { name: '贡献类型', exact: true })
        const skills = categories.getByRole('button', { name: '技能', exact: true })
        await skills.click()
        const handoff = catalog.getByRole('button', { name: '交接清单', exact: true })
        expect(await catalog.getByRole('button', { name: '发布清单面板', exact: true }).count()).toBe(0)
        await handoff.click()
        const details = page.getByRole('dialog', { name: '交接清单', exact: true })
        await details.waitFor()
        await details.getByText('运行权限', { exact: true }).waitFor()
        await details.getByText('安装名称与标识', { exact: true }).waitFor()
        await details.getByText('请在这台 Mac 的 Latch 桌面端安装插件。', { exact: true }).waitFor()
        expect(await details.getByRole('button', { name: '审阅并安装', exact: true }).count()).toBe(0)
        await noHorizontalOverflow(page, catalog)
        await details.getByRole('button', { name: '取消', exact: true }).click()
        await details.waitFor({ state: 'hidden' })
        expect(await search.inputValue()).toBe('交接')
        expect(await skills.getAttribute('aria-pressed')).toBe('true')
        await expect.poll(() => handoff.evaluate(element => element === document.activeElement)).toBe(true)
        if (width < 768) await page.getByRole('button', { name: '返回', exact: true }).click()
        else await page.goBack()
        await catalog.waitFor({ state: 'hidden' })
        if (width < 768) await phoneStartScreen(page)
        await expect.poll(() => promptValue(prompt)).toBe(draft)
        expect(assetReads).toEqual([])
        expect(registryRequests).toEqual([])
      } finally {
        await browser.close()
        await host.close()
      }
    },
  )

  it.each([
    {
      device: 'iPhone Safari',
      viewport: { width: 390, height: 844 },
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
      isMobile: true,
    },
    {
      device: 'iPad Safari in desktop mode',
      viewport: { width: 1024, height: 768 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
      isMobile: false,
    },
  ])(
    'keeps the marketplace unavailable on $device and lets the user send a normal handoff message',
    async ({ viewport, userAgent, isMobile }) => {
      const registryRequests: string[] = []
      const host = await startTestHost({
        pluginRegistryFetch: async url => {
          registryRequests.push(url)
          throw new Error('Unexpected registry request')
        },
      })
      const browser = await chromium.launch(browserLaunchOptions())
      try {
        const page = await browser.newPage({ viewport, userAgent, isMobile, hasTouch: true })
        if (!isMobile) {
          await page.addInitScript(() => {
            Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })
            Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 })
          })
        }
        await enrollBrowser(page, host, { scopes: ['view', 'run', 'admin'] })
        const marketEntry = page.getByRole('button', { name: '插件市场', exact: true })
        const market = page.getByRole('region', { name: '插件市场', exact: true })
        const packageRequests: string[] = []
        page.on('request', request => {
          const path = new URL(request.url()).pathname
          if (path.includes('/api/plugin-packages')) packageRequests.push(path)
        })
        expect(await marketEntry.count()).toBe(0)
        if (viewport.width < 768) await phoneStartScreen(page)
        const composer = page.getByRole('textbox', { name: '新会话消息', exact: true })
        await composer.waitFor()

        const settings = await openSettings(page)
        const loadingPlugins = page.waitForResponse(response => new URL(response.url()).pathname === '/link/api/plugins')
        await openSection(settings, '插件')
        expect((await loadingPlugins).ok()).toBe(true)
        expect(await marketEntry.count()).toBe(0)
        expect(await settings.getByRole('button', { name: '浏览插件市场', exact: true }).count()).toBe(0)
        await closeSettings(settings)

        await page.goto(new URL('?page=marketplace', page.url()).href)
        await page.locator('.app-shell[data-connection="connected"]').waitFor()
        await expect.poll(() => new URL(page.url()).searchParams.has('page')).toBe(false)
        expect(await market.count()).toBe(0)
        expect(await marketEntry.count()).toBe(0)
        await composer.waitFor()
        const handoff = '把交接事项整理成下一步。'
        await composer.fill(handoff)
        const sent = page.waitForResponse(
          response => new URL(response.url()).pathname === '/link/api/tasks' && response.request().method() === 'POST',
        )
        await page.getByRole('button', { name: '发送', exact: true }).click()
        expect((await sent).status()).toBe(201)
        await page.locator('.user-bubble').getByText(handoff, { exact: true }).waitFor()
        expect(packageRequests).toEqual([])
        expect(registryRequests).toEqual([])
      } finally {
        await browser.close()
        await host.close()
      }
    },
  )

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

      // Even an admin browser can browse plugins without the desktop's creation or import controls.
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' })
      const phone = await context.newPage()
      await enrollBrowser(phone, host, { scopes: ['view', 'run', 'admin'] })
      const settings = await openSettings(phone)
      await openSection(settings, '插件')
      await settings.getByRole('button', { name: '浏览插件市场', exact: true }).waitFor()
      expect(await settings.getByRole('button', { name: '添加插件…', exact: true }).count()).toBe(0)
      expect(await settings.getByRole('button', { name: '导入文件…', exact: true }).count()).toBe(0)
      await closeSettings(settings)
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
  const scenarios = [
    {
      name: 'goes from 创建插件 to the conversation, reviews, builds and applies its page, and hands a failed build back',
      responsive: false,
    },
    {
      name: 'opens the creator composer in one click at desktop, tablet and phone widths, then starts with the chosen Harness, model and effort',
      responsive: true,
    },
    { name: 'creates and reviews a skill and tool from the composer without using the regular project or its draft', creator: true },
  ]
  it.each(scenarios)('$name', async ({ responsive, creator }) => {
    await mkdir(OUTPUT, { recursive: true })
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-app-build-'))
    const testHost = await startTestHost({
      hostName: '工作电脑',
      sessionFolders: true,
      pluginRegistryFetch: async () => new Response(null, { status: 503 }),
    })
    const { host } = testHost
    let application: ElectronApplication | undefined
    try {
      const owner = await testHost.enroll({ listener: 'unix' })
      const queue = join(testHost.root, 'edits.json')
      await fakeAgent(testHost, owner, queue)
      const regularProject = join(testHost.root, 'regular-project')
      if (creator) {
        await mkdir(regularProject)
        const project = await owner.addFolders({ name: '开发项目', paths: [regularProject] })
        expect(project.status).toBe(201)
        const { workspace } = (await project.json()) as { workspace: { id: string } }
        await owner.json('preferences', {
          method: 'PUT',
          body: { defaults: { workspaceId: workspace.id, harnessId: 'fake', pinned: true } },
        })
      }
      if (responsive) {
        // Learn the custom ACP's model-specific thinking options, then start with a different pinned Harness.
        const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
          body: { prompt: '读取模型选项', requestId: randomUUID(), harnessId: 'fake', workspaceId: 'default' },
        })
        await idle(owner, sessionId)
        for (const value of ['large', 'small']) await owner.json(`tasks/${sessionId}/config`, { body: { configId: 'model', value } })
        await owner.json('preferences', { method: 'PUT', body: { defaults: { harnessId: 'standard', pinned: true } } })
      }
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

      if (responsive) await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setMinimumSize(320, 560))
      const resizeContent = (width: number, height: number) =>
        application!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), {
          width,
          height,
        })
      if (creator) {
        const home = window.locator('.workbench-home')
        const prompt = home.getByRole('textbox', { name: '新会话消息' })
        const mode = home.getByRole('button', { name: /^模式：/u })
        const regular = '普通项目尚未发送的草稿'
        const request = '做一个交接插件，能帮我整理待办，并把交接编号统一转成大写。'
        await prompt.fill(regular)
        const switchMode = async (name: string) => {
          await mode.click()
          await window.getByRole('menuitemradio', { name: new RegExp(name, 'u') }).click()
        }
        await switchMode('创造模式')
        await expect.poll(() => promptValue(prompt)).toBe(regular)
        await prompt.fill(request)
        await switchMode('常规')
        await expect.poll(() => promptValue(prompt)).toBe(regular)
        await home.getByRole('button', { name: '项目：开发项目', exact: true }).waitFor()
        const settings = await openSettings(window)
        await openSection(settings, '插件')
        await settings.getByRole('button', { name: '创建插件…', exact: true }).click()
        await expect.poll(() => promptValue(prompt)).toBe(request)
        await switchMode('常规')
        await expect.poll(() => promptValue(prompt)).toBe(regular)
        const browsePlugins = window.locator('#session-navigation').getByRole('button', { name: '插件市场', exact: true })
        await browsePlugins.press('Enter')
        const marketplace = window.getByRole('region', { name: '插件市场', exact: true })
        const marketSearch = marketplace.getByRole('searchbox', { name: '搜索任务或插件', exact: true })
        await marketSearch.waitFor()
        await window.goBack()
        await marketplace.waitFor({ state: 'hidden' })
        expect(await window.locator('.settings-page').count()).toBe(0)
        await expect.poll(() => browsePlugins.evaluate(element => element === document.activeElement)).toBe(true)
        await expect.poll(() => promptValue(prompt)).toBe(regular)
        const create = marketplace.getByRole('button', { name: '创建插件', exact: true })
        await browsePlugins.click()
        await marketSearch.fill('另一个搜索词')
        await create.click()
        await expect.poll(() => promptValue(prompt)).toBe(request)
        await prompt.clear()
        await switchMode('常规')
        await expect.poll(() => promptValue(prompt)).toBe(regular)
        await browsePlugins.click()
        await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setMinimumSize(320, 560))
        await resizeContent(320, 844)
        await expect.poll(() => window.evaluate(() => innerWidth)).toBe(320)
        await marketSearch.fill('  交接清单  ')
        await reachable(create)
        await create.click()
        await marketplace.waitFor({ state: 'hidden' })
        await home.getByRole('button', { name: '模式：创造模式', exact: true }).waitFor()
        await expect.poll(() => promptValue(prompt)).toBe('交接清单')
        await expect.poll(() => prompt.evaluate(input => input === document.activeElement)).toBe(true)
        await window.screenshot({ path: `${OUTPUT}/marketplace-seeded-320.png`, animations: 'disabled', caret: 'hide' })
        await prompt.fill(request)
        for (const [width, scheme] of [
          [1440, 'light'],
          [768, 'dark'],
          [390, 'dark'],
        ] as const) {
          await resizeContent(width, width === 1440 ? 960 : 844)
          await window.emulateMedia({ colorScheme: scheme })
          await expect.poll(() => window.evaluate(() => innerWidth)).toBe(width)
          await reachable(mode)
          await noHorizontalOverflow(window, home)
          await window.screenshot({ path: `${OUTPUT}/creator-${width}-${scheme}.png`, animations: 'disabled' })
        }
        await resizeContent(1440, 960)
        await window.emulateMedia({ colorScheme: 'light' })
        await mode.click()
        await window.getByRole('menuitemradio', { name: /创造模式/u }).waitFor()
        await window.screenshot({ path: `${OUTPUT}/creator-mode-menu.png`, animations: 'disabled' })
        await window.keyboard.press('Escape')
        const before = (await owner.json<AppSnapshot>('snapshot')).tasks.length
        expect(before).toBe(0)
        await writeFile(queue, JSON.stringify([creatorEdits]))
        await writeFile(
          join(testHost.root, 'replies.json'),
          JSON.stringify(['交接插件草稿已准备好。技能会先核对清单再整理待办，工具可以把交接编号转换为大写。']),
        )
        const sent = window.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/link/api/tasks')
        await home.getByRole('button', { name: '发送', exact: true }).click()
        const body: unknown = (await sent).postDataJSON()
        expect(body).toMatchObject({ pluginCreation: true, harnessId: 'fake', prompt: request, mode: 'agent' })
        expect(body).not.toHaveProperty('workspaceId')
        await expect.poll(async () => (await owner.json<AppSnapshot>('snapshot')).tasks[0]?.pluginCreation, SLOW).toBe(true)
        const task = (await owner.json<AppSnapshot>('snapshot')).tasks[0]!
        expect(task.cwd).not.toBe(regularProject)
        await idle(owner, task.id)
        const detail = await owner.json<TaskDetail>(`tasks/${task.id}`)
        expect(detail.messages.find(message => message.role === 'user')?.text).toBe(request)
        const artifact = window.locator('[data-draft-place="conversation"]').getByRole('button', { name: '审阅插件草稿' })
        await artifact.waitFor()
        expect(await window.getByRole('button', { name: '审阅插件草稿' }).count()).toBe(1)
        const sidebar = window.getByRole('button', { name: '侧边面板', exact: true })
        if ((await sidebar.getAttribute('aria-pressed')) === 'true') await sidebar.click()
        await settleShell(window)
        await window.screenshot({ path: `${OUTPUT}/creator-artifact.png`, animations: 'disabled' })
        await artifact.click()
        await verifyCreatorPlugin(window, testHost)
        await window.screenshot({ path: `${OUTPUT}/creator-applied.png`, animations: 'disabled' })
        await closeSettings(window.locator('.settings-page'))
        await window.getByRole('button', { name: '新建会话', exact: true }).click()
        await home.waitFor()
        await window.locator('.ui-toast').getByText('已导入插件草稿，可以审阅后应用', { exact: true }).waitFor({ state: 'hidden' })
        await window.screenshot({ path: `${OUTPUT}/creator-return.png`, animations: 'disabled' })
        await expect.poll(() => home.locator('.home-headline').innerText()).toContain('开发项目')
        await home.getByRole('button', { name: '项目：开发项目', exact: true }).waitFor()
        await expect.poll(() => promptValue(prompt)).toBe(regular)
        expect((await owner.json<AppSnapshot>('snapshot')).tasks).toHaveLength(1)
        return
      }
      const home = window.locator('.workbench-home')
      const prompt = home.getByRole('textbox', { name: '新会话消息', exact: true })
      const harness = home.getByRole('button', { name: /^Harness：/u })
      const model = home.getByRole('button', { name: /^模型：/u })
      const start = home.getByRole('button', { name: '发送', exact: true })
      const picker = window.locator(':popover-open, dialog[open]')
      const option = (name: RegExp) =>
        picker
          .getByRole('menuitemradio', { name })
          .or(picker.getByRole('radio', { name }))
          .or(picker.getByRole('option', { name }))
          .filter({ visible: true })
          .first()
      const before = (await owner.json<AppSnapshot>('snapshot')).tasks.map(task => task.id)
      const submissions: unknown[] = []
      window.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/link/api/tasks') submissions.push(request.postDataJSON())
      })
      if (!responsive) await prompt.fill('继续处理普通项目')
      const views = [
        [1440, 'dark'],
        [768, 'light'],
        [320, 'light'],
        [390, 'dark'],
      ] as const
      for (const [width, theme] of responsive ? views : ([[1440, 'light']] as const)) {
        await resizeContent(width, responsive ? 844 : 960)
        await expect.poll(() => window.evaluate(() => innerWidth)).toBe(width)
        await window.emulateMedia({ colorScheme: theme })
        const settings = await openSettings(window)
        await openSection(settings, '插件')
        const create = settings.getByRole('button', { name: '创建插件…', exact: true })
        await reachable(create)
        if (responsive) await window.screenshot({ path: `${OUTPUT}/settings-add-plugin-${width}-${theme}.png`, animations: 'disabled' })
        await create.click()
        await settings.waitFor({ state: 'hidden' })
        await home.getByRole('button', { name: '模式：创造模式', exact: true }).waitFor()
        expect(await window.getByRole('dialog', { name: '创建插件', exact: true }).count()).toBe(0)
        await expect.poll(() => prompt.evaluate(input => input === document.activeElement)).toBe(true)
        await expect.poll(() => promptValue(prompt)).toBe('')
        await noHorizontalOverflow(window, home)
        await reachable(prompt)
        await reachable(harness)
        await reachable(model)
        expect(await start.isEnabled()).toBe(false)
        if (responsive) await window.screenshot({ path: `${OUTPUT}/settings-creator-${width}-${theme}.png`, animations: 'disabled' })
      }
      if (responsive) await expect.poll(() => harness.getAttribute('aria-label')).toBe('Harness：Latch 内置')
      await harness.click()
      await option(/^Fake$/u).click()
      await expect.poll(() => harness.getAttribute('aria-label')).toBe('Harness：Fake')
      if (responsive) {
        await model.click()
        await option(/^Large$/u).click()
        if ((await model.getAttribute('aria-expanded')) !== 'true') await model.click()
        await option(/^High/u).click()
        await window.keyboard.press('Escape')
        await expect.poll(() => model.innerText()).toContain('Large')
        await expect.poll(() => model.innerText()).toContain('High')
      }
      const request = '做一个计数页，列出最近的会话'
      const id = 'creator-counter'
      await prompt.fill(request)
      if (responsive) {
        for (const width of [1440, 390]) {
          await resizeContent(width, 844)
          await expect.poll(() => window.evaluate(() => innerWidth)).toBe(width)
          await settleShell(window)
          await reachable(start)
          await window.mouse.move(0, 0)
          await window.getByRole('tooltip').waitFor({ state: 'hidden' })
          await window.screenshot({ path: `${OUTPUT}/settings-creator-chosen-${width}-dark.png`, animations: 'disabled' })
        }
      }
      await writeFile(
        queue,
        JSON.stringify([
          [
            { path: 'latch-app/latch-app.json', content: manifest(id) },
            { path: 'latch-app/index.tsx', content: page('第一版') },
          ],
        ]),
      )
      expect(submissions).toEqual([])
      expect((await owner.json<AppSnapshot>('snapshot')).tasks.map(task => task.id)).toEqual(before)
      await start.click()
      await expect.poll(() => submissions).toHaveLength(1)
      expect(submissions[0]).toMatchObject({ prompt: request, pluginCreation: true, harnessId: 'fake' })
      expect(submissions[0]).not.toHaveProperty('workspaceId')
      if (responsive)
        expect(submissions[0]).toMatchObject({
          config: expect.arrayContaining([
            { configId: 'model', value: 'large' },
            { configId: 'effort', value: 'high' },
          ]),
        })
      const created = async () => (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => !before.includes(task.id))
      await expect.poll(created, SLOW).toMatchObject({ pluginCreation: true, harnessId: 'fake' })
      const sessionId = (await created())!.id
      await idle(owner, sessionId)
      const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
      expect(await readFile(join(detail.summary.cwd!, 'latch-app', 'index.tsx'), 'utf8')).toBe(page('第一版'))
      if (responsive) {
        expect(Object.fromEntries((detail.config ?? []).map(option => [option.id, option.currentValue]))).toMatchObject({
          model: 'large',
          effort: 'high',
        })
        return
      }
      await window.locator('[data-draft-place="conversation"]').getByRole('button', { name: '查看页面草稿', exact: true }).click()
      let settings = window.locator('.settings-page')
      const card = settings.locator('.new-app-card').filter({ hasText: id })
      await card.waitFor()
      await expect.poll(() => card.getAttribute('data-phase')).toBe('draft')
      await window.screenshot({ path: `${OUTPUT}/desktop-draft-1440.png` })
      await card.getByRole('button', { name: '构建' }).click()
      await expect.poll(() => card.getAttribute('data-phase'), SLOW).toBe('preview')
      // The preview: the same frame and bundle, samples instead of sessions, and starting does nothing.
      const previewFrame = card.locator('iframe.app-frame')
      const preview = await frameIn(previewFrame, '#label')
      expect(await preview.locator('#tasks').textContent()).toBe('样例会话')
      await window.locator('.ui-toast').getByText('已作为应用草稿导入', { exact: true }).waitFor({ state: 'hidden' })
      await expect
        .poll(() =>
          previewFrame.evaluate(frame => {
            const settingsDialog = frame.closest('dialog.settings-overlay[open]:not([data-secure])')
            const covers = [...document.querySelectorAll('[data-secure], dialog[open], .ui-toast')]
              .filter(surface => surface !== settingsDialog && !surface.closest('[inert]') && surface.getClientRects().length > 0)
              .map(surface => Array.from(surface.classList).join(' ') || surface.tagName)
            return { inert: frame.hasAttribute('inert'), covers }
          }),
        )
        .toEqual({ inert: false, covers: [] })
      await settings.getByRole('button', { name: '编辑…', exact: true }).click()
      const editor = window.locator('dialog.ui-dialog:has(> .ui-dialog-surface .plugin-editor)')
      await editor.waitFor()
      await expect.poll(() => previewFrame.getAttribute('inert')).toBe('')
      await editor.getByRole('button', { name: '关闭', exact: true }).click()
      await expect.poll(() => previewFrame.getAttribute('inert')).toBeNull()
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

      const requests = testHost.presence.requests.length
      testHost.presence.mode = 'manual'
      await card.getByRole('button', { name: '应用', exact: true }).click()
      const consent = window.getByRole('dialog', { name: '审阅并应用插件', exact: true })
      await consent.getByText('在任意项目开始会话', { exact: true }).waitFor()
      expect(testHost.presence.requests).toHaveLength(requests)
      await consent.getByRole('button', { name: '确认安装', exact: true }).click()
      await expect.poll(() => testHost.presence.requests.length).toBe(requests + 1)
      await card.locator('.new-app-confirm .inline-confirm[data-secure]').waitFor()
      await expect.poll(() => previewFrame.getAttribute('inert')).toBe('')
      await expect(preview.getByRole('button', { name: '开始' }).click({ trial: true, timeout: 600 })).rejects.toThrow()
      testHost.presence.approveNext()
      testHost.presence.mode = 'approve'
      await expect.poll(() => card.getAttribute('data-phase'), SLOW).toBe('applied')
      expect((await owner.json<AppSnapshot>('snapshot')).tasks.length).toBe(sessionsBefore)
      // 打开 goes to the page, in the sidebar's 应用 group.
      await card.getByRole('button', { name: '打开' }).click()
      await window.locator('.sidebar-apps').getByRole('button', { name: TITLE }).waitFor()
      const liveFrame = window.locator('.apps-page iframe.app-frame')
      const first = await frameIn(liveFrame, '#label')
      await expect.poll(() => liveFrame.getAttribute('inert')).toBeNull()
      expect(await first.locator('#label').textContent()).toBe('第一版')
      await window.locator('.apps-page').getByRole('button', { name: '新建会话' }).click()
      await window.locator('.apps-page').waitFor({ state: 'detached' })
      settings = await openSettings(window)
      await openSection(settings, '插件')
      await settings.locator('.plugin-nav-row', { hasText: TITLE }).click()
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
      const composer = window.locator('.composer .composer-input [role="textbox"]').first()
      await expect.poll(() => promptValue(composer), SLOW).toContain('index.tsx:2:7')
      expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.length).toBe(messages)

      // The next turn fixes it: built again, and 应用新版本 rebuilds the page's frame everywhere.
      await writeFile(queue, JSON.stringify([{ path: 'latch-app/index.tsx', content: page('第二版') }]))
      await owner.json(`tasks/${sessionId}/prompt`, { body: { prompt: '修好', requestId: randomUUID() } })
      await idle(owner, sessionId)
      settings = await openSettings(window)
      await openSection(settings, '插件')
      await settings.locator('.plugin-nav-row', { hasText: TITLE }).click()
      const again = settings.locator('.new-app-card').filter({ hasText: id })
      await expect.poll(() => again.getAttribute('data-phase'), SLOW).toBe('preview')
      await again.getByRole('button', { name: '应用新版本' }).click()
      await consent.getByText('应用页面能力未扩大', { exact: true }).waitFor()
      await consent.getByRole('button', { name: '确认应用', exact: true }).click()
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
