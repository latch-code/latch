import { _electron, type ElectronApplication, type Locator, type Response as BrowserResponse } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  createPluginPackageTemplate,
  OFFICIAL_PLUGIN_CATALOG_REPOSITORY,
  PLUGIN_MARKETPLACE_PAGE,
  type AppSnapshot,
  type Message,
  type PluginCatalogPreview,
  type PluginPackageBundle,
  type PluginPackageDetail,
  type TaskDetail,
} from '@latch/protocol'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { writeHostState } from '@latch/host/host-state'
import { FAKE_ACP_AGENT, officialGithubResponse, type TestDevice } from '@latch/testkit'
import { describe, expect, it, vi } from 'vitest'
import { jumpToLargestResult, openContextPanel, reviewPlugin, reviewSession, selectFourthRequest } from './helpers/context.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import {
  backToSection,
  closeSettings,
  noHorizontalOverflow,
  openPanelTab,
  openSection,
  openSession,
  openSettings,
  reachable,
  settleShell,
} from './helpers/layout.ts'
import { promptValue } from './helpers/prompt.ts'

const OUTPUT = 'test-results/plugin-registry'
const installedTabName = /^已安装(?:（\d+）)?$/u
const REGISTRY = 'https://registry.example.test/npm/'
const NAME = '@example/handoff'
const ID = 'registry-handoff'
const TITLE = '交接记录'
const HANDOFF = { name: NAME, id: ID, title: TITLE, description: '用清单核对交接。' }
const CHECKLIST = { name: '@example/checklist', id: 'registry-checklist', title: '发布核对单', description: '发布前复核检查结果。' }
const CHECKLIST_METADATA = REGISTRY + CHECKLIST.name.replace('/', '%2f') + '/'
const CONTEXT_ID = 'context-insights'
const CONTEXT_TITLE = '上下文'
const CONTEXT_VERSION = '1.2.0'
const METADATA = REGISTRY + NAME.replace('/', '%2f') + '/'
const LATEST = METADATA + 'latest'
const officialRefs = OFFICIAL_PLUGIN_CATALOG_REPOSITORY + '.git/info/refs?service=git-upload-pack'

async function singleWindowSession(host: TestHost, owner: TestDevice) {
  await owner.confirmedJson('agents', {
    body: { id: 'window-fixture', name: '窗口验收', command: process.execPath, args: [FAKE_ACP_AGENT] },
  })
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    body: { requestId: randomUUID(), harnessId: 'window-fixture', prompt: 'window-report 238761 1048576' },
  })
  await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status, { timeout: 15_000 }).toBe('idle')
  // The fake Harness reports the window. Reconstruct a long tool history at the same detail boundary used by HTTP and SSE.
  const tools: Message[] = []
  const start = Date.UTC(2026, 10, 24, 6)
  for (const [kind, calls, longest] of [
    ['read', 34, 0],
    ['execute', 19, 539_000],
    ['edit', 15, 2900],
    ['other', 4, 1500],
  ] as const) {
    for (let index = 0; index < calls; index++)
      tools.push({
        id: `report-${kind}-${index}`,
        role: 'tool',
        tool: { kind },
        state: kind === 'execute' && index === 0 ? 'failed' : 'completed',
        startedAt: new Date(start).toISOString(),
        completedAt: new Date(start + (index === 0 ? longest : 100)).toISOString(),
        text: '',
      })
  }
  const read = host.host.bridge.detail.bind(host.host.bridge)
  vi.spyOn(host.host.bridge, 'detail').mockImplementation(async id => {
    const detail = await read(id)
    if (id !== sessionId) return detail
    const [prompt, ...reply] = detail.messages
    return { ...detail, messages: [prompt!, ...tools, ...reply] }
  })
  return sessionId
}

async function launchDesktop(host: Awaited<ReturnType<typeof startTestHost>>): Promise<ElectronApplication> {
  await writeHostState(host.dataDir, {
    version: 2,
    pid: process.pid,
    hostId: host.host.hostId,
    instanceId: host.host.instanceId,
    socketPath: host.host.socketPath,
    loopbackOrigin: host.host.loopbackOrigin,
    tlsOrigin: host.host.tlsOrigin ?? null,
    startedAt: new Date().toISOString(),
    dataDir: host.dataDir,
  })
  return _electron.launch({
    args: [
      resolve('apps/desktop/src/main.cjs'),
      '--latch-host-state=' + join(host.dataDir, 'host.json'),
      '--latch-user-data=' + join(host.root, 'electron'),
      '--use-mock-keychain',
    ],
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  })
}

/** Commit-pinned GitHub API and raw file responses for the public repositories served by the fixture. */
function githubRepositoryResponse(url: URL, repo: string, commit: string, tree: string, files: Map<string, string>): Response {
  const prefix = `/repos/${repo}`
  const ref = { sha: commit, commit: { tree: { sha: tree } } }
  if (url.origin === 'https://api.github.com') {
    if (url.pathname === prefix + '/commits') return Response.json([ref])
    if (url.pathname === prefix + '/commits/main') return Response.json(ref)
    if (url.pathname === prefix + '/git/commits/' + commit) return Response.json({ sha: commit, tree: { sha: tree } })
    if (url.pathname === prefix + '/git/trees/' + tree) {
      const directories = new Set<string>()
      const blobs = [...files].map(([path, content]) => {
        const parts = path.split('/')
        for (let depth = 1; depth < parts.length; depth++) directories.add(parts.slice(0, depth).join('/'))
        const size = Buffer.byteLength(content)
        return { path, size, mode: '100644', type: 'blob', sha: createHash('sha1').update(`blob ${size}\0${content}`).digest('hex') }
      })
      return Response.json({
        sha: tree,
        truncated: false,
        tree: [...Array.from(directories, path => ({ path, type: 'tree', mode: '040000', sha: tree })), ...blobs],
      })
    }
  }
  const rawPrefix = `/${repo}/${commit}/`
  if (url.origin === 'https://raw.githubusercontent.com' && url.pathname.startsWith(rawPrefix)) {
    const content = files.get(url.pathname.slice(rawPrefix.length))
    if (content !== undefined) return new Response(content)
  }
  return new Response(null, { status: 404 })
}

async function npmRelease(root: string, version: string, instructions: string, plugin = HANDOFF) {
  const folder = join(root, plugin.id, version)
  const packageDir = join(folder, 'package')
  await mkdir(packageDir, { recursive: true })
  const bundle: PluginPackageBundle = {
    manifest: {
      formatVersion: 1,
      id: plugin.id,
      name: plugin.title,
      version,
      description: plugin.description,
      skills: [{ id: 'handoff', name: plugin.title, description: plugin.description, file: 'SKILL.md' }],
    },
    files: [{ path: 'SKILL.md', content: instructions }],
  }
  const files = [
    ['package/package.json', { name: plugin.name, version }],
    ['package/latch-plugin.json', bundle],
  ] as const
  for (const [file, content] of files) {
    await writeFile(join(folder, file), JSON.stringify(content), { mode: 0o644 })
    await utimes(join(folder, file), 0, 0)
  }
  const bytes = gzipSync(execFileSync('tar', ['--format=ustar', '-cf', '-', '-C', folder, ...files.map(([file]) => file)]))
  const tarball = `${REGISTRY}${plugin.name}/-/${plugin.name.split('/').at(-1)}-${version}.tgz`
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
  return { bytes, metadata: { name: plugin.name, version, dist: { tarball, integrity } } }
}

async function visibleCover(preview: Locator, markers: string) {
  await preview.waitFor()
  const clipped = await preview.evaluate((element, selector) => {
    const frame = element.getBoundingClientRect()
    const parts = [...element.querySelectorAll<HTMLElement>(selector)]
    if (parts.length === 0) return [selector]
    const fits = (rect: DOMRect) =>
      rect.left >= frame.left - 1 && rect.right <= frame.right + 1 && rect.top >= frame.top - 1 && rect.bottom <= frame.bottom + 1
    return parts
      .filter(part => {
        const rect = part.getBoundingClientRect()
        const style = getComputedStyle(part)
        const content = document.createRange()
        content.selectNodeContents(part)
        return (
          style.visibility !== 'visible'
          || rect.width <= 0
          || rect.height <= 0
          || !fits(rect)
          || (!!part.textContent?.trim() && !fits(content.getBoundingClientRect()))
          || (style.overflowX !== 'visible' && part.scrollWidth > part.clientWidth + 1)
          || (style.overflowY !== 'visible' && part.scrollHeight > part.clientHeight + 1)
        )
      })
      .map(part => part.className || part.tagName)
  }, markers)
  expect(clipped).toEqual([])
}

async function contextSample(preview: Locator) {
  await visibleCover(preview, '.market-context-sequence > strong, .market-context-nodes > li, .market-context-band, .market-context-label')
  const nodes = preview.locator('.market-context-nodes > li')
  const selected = await nodes.evaluateAll(elements => elements.findIndex(element => element.hasAttribute('data-selected')) + 1)
  expect(selected).toBe(4)
  const sizes = await preview
    .locator('.market-context-band > span')
    .evaluateAll(elements => elements.map(element => Number(getComputedStyle(element).flexGrow)))
  expect(sizes).toHaveLength(4)
  expect(sizes.every(size => size > 0)).toBe(true)
  expect(sizes.reduce((total, size) => total + size, 0)).toBe(100)
  return {
    selected,
    sizes,
    request: await preview.locator('.market-context-sequence > strong').textContent(),
    composition: await preview.locator('.market-context-label').textContent(),
  }
}

async function bundledArtwork(gallery: Locator) {
  const handoff = gallery.locator('[data-preview="document"]')
  const checklist = gallery.locator('[data-preview="checklist"]')
  const release = gallery.locator('[data-preview="history"]')
  await visibleCover(handoff, '.market-handoff-note')
  expect(await handoff.locator('.market-handoff-note[data-note="done"]').count()).toBe(1)
  expect(await handoff.locator('.market-handoff-note[data-note="next"]').count()).toBe(1)
  expect(await handoff.locator('.market-handoff-arrow').isVisible()).toBe(true)
  await visibleCover(checklist, '.market-checklist-score, .market-checklist-progress')
  expect(await checklist.locator('.market-checklist-progress > [data-complete]').count()).toBe(2)
  await visibleCover(release, '.market-release-track > li')
  expect(
    await release
      .locator('.market-release-track > li[data-state]')
      .evaluateAll(elements => elements.map(element => element.getAttribute('data-state'))),
  ).toEqual(['passed', 'pending'])
}

async function fallbackArtwork(cover: Locator) {
  await cover.waitFor()
  return cover.evaluate(element => {
    const texture = element.querySelector('[data-plugin-pattern]')
    return {
      pattern: texture?.getAttribute('data-plugin-pattern'),
      texture: texture && getComputedStyle(texture).backgroundImage,
      tone: element.getAttribute('data-plugin-tone'),
      background: getComputedStyle(element).backgroundColor,
    }
  })
}

async function fallbackIcon(parent: Locator) {
  const icon = parent.locator('.plugin-market-icon[data-plugin-tone][data-plugin-glyph]')
  await icon.waitFor()
  return icon.evaluate(element => ({
    tone: element.getAttribute('data-plugin-tone'),
    glyph: element.getAttribute('data-plugin-glyph'),
    drawing: element.querySelector('svg')?.innerHTML,
  }))
}

async function scrollBelowControls(results: Locator, controls: Locator[]) {
  const position = () => results.evaluate(element => element.scrollTop)
  await results.evaluate(element => (element.scrollTop = 0))
  const tops = () => Promise.all(controls.map(control => control.evaluate(element => Math.round(element.getBoundingClientRect().top))))
  const before = await tops()
  await results.focus()
  await results.press('End')
  await expect.poll(position).toBeGreaterThan(0)
  await expect
    .poll(() => results.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop)))
    .toBeLessThanOrEqual(1)
  expect(await tops()).toEqual(before)
  expect(await results.evaluate(element => element.closest('.marketplace-workspace')?.scrollTop)).toBe(0)
  return await position()
}

describe.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')('desktop plugin marketplace', () => {
  it('shows one settings card per plugin and keeps its details separate from the enable switch', async () => {
    const host = await startTestHost({ sessionFolders: true, pluginRegistryFetch: async () => new Response(null, { status: 503 }) })
    let application: ElectronApplication | undefined
    try {
      const owner = await host.enroll({ listener: 'unix' })
      for (const pluginId of [CONTEXT_ID, 'shift-handoff', 'release-review']) {
        const { review } = await owner.json<PluginCatalogPreview>('plugin-packages/catalog/preview', { body: { pluginId } })
        const body = { revision: review.revision, requestId: randomUUID() }
        await owner.json('plugin-packages/catalog/stage', { body: { ...body, pluginId } })
        if (pluginId === CONTEXT_ID)
          await owner.confirmedJson(`plugin-packages/${pluginId}/apply`, { body: { revision: review.revision, requestId: randomUUID() } })
      }
      application = await launchDesktop(host)
      const page = await application.firstWindow()
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      const settings = await openSettings(page)
      await openSection(settings, '插件')
      await settings.getByRole('button', { name: '创建插件…', exact: true }).waitFor()
      const list = settings.getByRole('list', { name: '插件', exact: true })
      const cards = list.getByRole('listitem')
      const card = (name: string) => cards.filter({ has: page.getByText(name, { exact: true }) })
      const panel = card(CONTEXT_TITLE)
      const draft = card('交接清单')
      const core = card('向你提问')
      await panel.waitFor()
      expect(await card('发布清单面板').count()).toBe(1)
      expect(
        await settings
          .locator('.settings-subpage')
          .getByRole('heading', { name: /^(工作台|会话面板|技能|工具)$/u })
          .count(),
      ).toBe(0)
      await settings.getByRole('button', { name: '新建工具', exact: true }).waitFor()
      expect(await list.getByRole('button', { name: '新建工具', exact: true }).count()).toBe(0)
      await draft.getByText('草稿', { exact: true }).waitFor()
      expect(await draft.getByRole('switch').count()).toBe(0)
      await core.getByText('始终开启', { exact: true }).waitFor()
      expect(await core.getByRole('switch').count()).toBe(0)
      const toggle = panel.getByRole('switch', { name: '启用 上下文', exact: true })
      const record = async () => (await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${CONTEXT_ID}`)).package
      const description = panel.getByText((await record()).description, { exact: true })
      const details = panel.locator('.plugin-nav-row')
      const viewDetails = panel.getByText('查看详情', { exact: true })
      await page.mouse.move(1, 1)
      await description.waitFor()
      await viewDetails.waitFor()
      expect(await viewDetails.evaluate(element => element.checkVisibility({ opacityProperty: true, visibilityProperty: true }))).toBe(true)
      await toggle.click()
      await expect.poll(record).toMatchObject({ enabled: false, appliedVersion: CONTEXT_VERSION })
      await expect.poll(() => toggle.isChecked()).toBe(false)
      expect(await viewDetails.isVisible()).toBe(true)
      expect(await settings.getByRole('button', { name: '编辑…', exact: true }).count()).toBe(0)
      await toggle.click()
      const review = page.getByRole('dialog', { name: '审阅并启用插件', exact: true })
      await review.waitFor()
      expect((await record()).enabled).toBe(false)
      await review.getByRole('button', { name: '确认启用', exact: true }).click()
      await expect.poll(record).toMatchObject({ enabled: true, appliedVersion: CONTEXT_VERSION })
      await viewDetails.click()
      await settings.getByRole('button', { name: '编辑…', exact: true }).waitFor()
      await backToSection(settings)
      await mkdir(OUTPUT, { recursive: true })
      for (const [width, theme] of [
        [1440, 'light'],
        [1440, 'dark'],
        [820, 'dark'],
        [390, 'dark'],
        [320, 'dark'],
      ] as const) {
        await application.evaluate(({ BrowserWindow }, width) => {
          const window = BrowserWindow.getAllWindows()[0]!
          window.setMinimumSize(320, 560)
          window.setContentSize(width, width < 820 ? 844 : 960)
        }, width)
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
        await settleShell(page)
        await noHorizontalOverflow(page, settings)
        await description.waitFor()
        await reachable(viewDetails)
        await reachable(details)
        await reachable(toggle)
        if (width === 1440 || width === 320) {
          const [first, second] = await Promise.all([cards.nth(0).boundingBox(), cards.nth(1).boundingBox()])
          if (width === 1440) {
            expect(Math.abs(first!.y - second!.y)).toBeLessThan(1)
            expect(second!.x).toBeGreaterThan(first!.x)
          } else {
            expect(Math.abs(first!.x - second!.x)).toBeLessThan(1)
            expect(second!.y).toBeGreaterThan(first!.y)
          }
        }
        await settings.getByRole('button', { name: '添加插件…', exact: true }).scrollIntoViewIfNeeded()
        await page.mouse.move(1, 1)
        await settings.screenshot({ path: `${OUTPUT}/settings-cards-${width}-${theme}.png`, animations: 'disabled', scale: 'css' })
      }
      await details.focus()
      await page.keyboard.press('Tab')
      await expect.poll(() => toggle.evaluate(element => element === document.activeElement)).toBe(true)
      await page.keyboard.press('Shift+Tab')
      await expect.poll(() => details.evaluate(element => element === document.activeElement)).toBe(true)
      await page.keyboard.press('Enter')
      await settings.getByRole('button', { name: '编辑…', exact: true }).waitFor()
      await backToSection(settings)
      await expect
        .poll(() => page.evaluate(() => [document.activeElement?.tagName, document.activeElement?.getAttribute('aria-labelledby')]))
        .toEqual(['BUTTON', await details.getAttribute('aria-labelledby')])
    } finally {
      await application?.close()
      await host.close()
    }
  })

  it('adds from GitHub and a local catalog without npm and recovers an update receipt through settings', async () => {
    const repository = 'https://github.com/example/guide-plugins'
    const githubId = 'team-review'
    const githubTitle = '团队审阅指南'
    const commit = 'ab'.repeat(20)
    const tree = 'cd'.repeat(20)
    const sourceFiles = new Map<string, string>()
    const published = (id: string, name: string) => {
      const bundle = createPluginPackageTemplate('tool', id, name)
      const content = JSON.stringify(bundle)
      const sha256 = createHash('sha256').update(content).digest('hex')
      const version = bundle.manifest.version
      const path = `${id}-${version}-${sha256.slice(0, 12)}.latch-plugin.json`
      sourceFiles.set(path, content)
      return { id, name, version, sha256, bundle: path }
    }
    const githubOtherTitle = '团队交接指南'
    const githubPackages = [published(githubId, githubTitle), published('team-handoff', githubOtherTitle)]
    sourceFiles.set('latch.catalog.json', JSON.stringify({ formatVersion: 1, plugins: githubPackages }))
    const sourceRequests: string[] = []
    const host = await startTestHost({
      hostName: '工作电脑',
      sessionFolders: true,
      pluginRegistryFetch: async (input, request) => {
        expect(request).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' })
        expect(new Headers(request.headers).has('authorization')).toBe(false)
        const url = new URL(input)
        if (!url.pathname.includes('/example/guide-plugins/')) return new Response(null, { status: 404 })
        sourceRequests.push(url.pathname)
        return githubRepositoryResponse(url, 'example/guide-plugins', commit, tree, sourceFiles)
      },
    })
    let application: ElectronApplication | undefined
    try {
      await mkdir(OUTPUT, { recursive: true })
      const directory = join(await realpath(host.root), 'local-catalog')
      const id = 'local-notes'
      const anotherId = 'local-checklist'
      const title = '团队工作笔记'
      const anotherTitle = '团队核对单'
      const writePackage = async (id: string, name: string, version: string) => {
        const bundle = createPluginPackageTemplate('skill', id, name)
        bundle.manifest.version = version
        const folder = join(directory, id)
        await mkdir(folder, { recursive: true })
        await writeFile(join(folder, 'latch-plugin.json'), JSON.stringify(bundle.manifest))
        for (const { path, content } of bundle.files) await writeFile(join(folder, path), content)
        return { id, folder: id, manifest: 'latch-plugin.json', files: bundle.files.map(file => file.path) }
      }
      const plugins = await Promise.all([writePackage(id, title, '1.0.0'), writePackage(anotherId, anotherTitle, '1.0.0')])
      await writeFile(join(directory, 'latch.catalog.json'), JSON.stringify({ formatVersion: 1, plugins }))
      const owner = await host.enroll({ listener: 'unix' })
      const record = async () => (await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${id}`)).package
      const desktop = await launchDesktop(host)
      application = desktop
      const page = await desktop.firstWindow()
      page.setDefaultTimeout(20_000)
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      const resize = async (width: number, colorScheme: 'light' | 'dark') => {
        await desktop.evaluate(({ BrowserWindow }, width) => {
          const window = BrowserWindow.getAllWindows()[0]!
          window.setMinimumSize(320, 560)
          window.setContentSize(width, width === 1440 ? 960 : 844)
        }, width)
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
        await settleShell(page)
      }
      const capture = async (name: string) => {
        await page.mouse.move(4, 4)
        await page.screenshot({ path: `${OUTPUT}/${name}.png`, animations: 'disabled', scale: 'css' })
      }
      await resize(1440, 'light')
      const settings = await openSettings(page)
      await openSection(settings, '插件')
      const add = settings.getByRole('button', { name: '添加插件…', exact: true })
      await settings.getByRole('button', { name: '创建插件…', exact: true }).waitFor()
      await reachable(add)
      await capture('settings-plugins-1440-light')
      await add.click()
      const market = page.locator('.marketplace-workspace')
      const panel = market.getByRole('tabpanel', { name: '添加插件', exact: true })
      const input = panel.getByRole('textbox', { name: 'npm 包名、GitHub 地址或文件夹路径', exact: true })
      const find = panel.getByRole('button', { name: '查找', exact: true })
      const registry = panel.getByRole('combobox', { name: 'npm 源', exact: true })
      const back = page.getByRole('button', { name: '返回', exact: true })
      await reachable(input)
      await expect.poll(() => back.count()).toBe(1)
      await capture('add-from-settings-1440-light')
      await input.fill(NAME)
      await registry.waitFor()
      expect(await registry.inputValue()).toBe('')
      expect(await find.isDisabled()).toBe(true)

      await input.fill(repository)
      await registry.waitFor({ state: 'hidden' })
      await find.click()
      const githubEntry = panel.getByRole('button', { name: '预览版本 ' + githubTitle, exact: true })
      await githubEntry.waitFor()
      await panel.getByRole('button', { name: '预览版本 ' + githubOtherTitle, exact: true }).waitFor()
      expect(sourceRequests.some(path => path.endsWith('.latch-plugin.json'))).toBe(false)
      await capture('github-results-1440-light')
      await githubEntry.click()
      await panel.getByRole('heading', { name: githubTitle, exact: true }).waitFor()
      await panel.getByText('GitHub 仓库', { exact: true }).waitFor()
      await panel.getByText('工作台代码', { exact: true }).waitFor()
      expect(sourceRequests.some(path => path.endsWith('/' + githubPackages[0]!.bundle))).toBe(true)
      await capture('github-preview-1440-light')
      expect((await owner.request(`plugin-packages/${githubId}`)).status).toBe(404)
      const approvals = host.presence.requests.length
      await panel.getByRole('button', { name: '保存为草稿', exact: true }).click()
      await panel.getByRole('button', { name: '审阅草稿', exact: true }).waitFor()
      const githubPackage = (await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${githubId}`)).package
      expect(githubPackage).toMatchObject({
        state: 'draft',
        enabled: false,
        trusted: false,
        external: { source: { kind: 'github', repository, commit } },
      })
      expect(githubPackage.appliedRevision).toBeUndefined()
      expect(host.host.registry.list().some(plugin => plugin.id === githubId)).toBe(false)
      expect(host.presence.requests).toHaveLength(approvals)
      await panel.getByRole('button', { name: '返回查找', exact: true }).click()
      const afterGithub = sourceRequests.length

      await input.fill(directory)
      await registry.waitFor({ state: 'hidden' })
      await find.click()
      const choose = panel.getByRole('button', { name: '预览版本 ' + title, exact: true })
      await panel.getByRole('button', { name: '预览版本 ' + anotherTitle, exact: true }).waitFor()
      await capture('local-results-1440-light')
      await choose.click()
      await panel.getByRole('heading', { name: title, exact: true }).waitFor()
      await panel.getByText('这台 Mac 上的文件夹', { exact: true }).waitFor()
      await panel.getByText('技能指令', { exact: true }).waitFor()
      await panel.getByRole('button', { name: '返回插件列表', exact: true }).click()
      await expect.poll(() => choose.evaluate(element => element === document.activeElement)).toBe(true)
      await choose.click()
      const stage = panel.getByRole('button', { name: '保存为草稿', exact: true })
      for (const [width, colorScheme] of [
        [1440, 'light'],
        [768, 'dark'],
        [390, 'dark'],
        [320, 'dark'],
      ] as const) {
        await resize(width, colorScheme)
        expect(await back.count()).toBe(1)
        await reachable(back)
        await reachable(stage)
        await noHorizontalOverflow(page, market)
        await capture(`local-preview-${width}-${colorScheme}`)
      }
      await stage.click()
      const review = panel.getByRole('button', { name: '审阅草稿', exact: true })
      await review.waitFor()
      await expect.poll(record).toMatchObject({ enabled: false, state: 'draft', external: { version: '1.0.0' } })
      expect((await record()).appliedRevision).toBeUndefined()
      expect(host.host.registry.list().some(plugin => plugin.id === id)).toBe(false)
      expect(sourceRequests).toHaveLength(afterGithub)

      await panel.getByRole('button', { name: '返回查找', exact: true }).click()
      await writePackage(id, title, '2.0.0')
      const localRow = panel.locator('.marketplace-fact').filter({ has: page.getByText(title, { exact: true }) })
      const checkUpdate = localRow.getByRole('button', { name: '检查更新', exact: true })
      await checkUpdate.click()
      const update = panel.getByRole('button', { name: '保存更新草稿', exact: true })
      await update.waitFor()
      await panel.getByRole('button', { name: '返回查找', exact: true }).click()
      await expect.poll(() => checkUpdate.evaluate(element => element === document.activeElement)).toBe(true)
      expect((await record()).external?.version).toBe('1.0.0')
      await checkUpdate.click()
      await reachable(update)
      await capture('local-update-320-dark')
      const attempts: unknown[] = []
      page.on('request', request => {
        if (request.url().endsWith('/plugin-packages/external/stage')) attempts.push(request.postDataJSON())
      })
      await page.evaluate(() => {
        const fetchRequest = window.fetch.bind(window)
        window.fetch = async (input, options) => {
          const result = await fetchRequest(input, options)
          if (typeof input === 'string' && input.endsWith('/plugin-packages/external/stage') && result.status === 201)
            throw new TypeError('Simulated lost response after delivery')
          return result
        }
      })
      await update.click()
      const retry = panel.getByRole('button', { name: '重试同一请求', exact: true })
      await reachable(retry)
      expect(await panel.getByText(/连不上.*Latch/u).count()).toBe(0)
      await capture('local-update-retry-320-dark')
      await expect.poll(record).toMatchObject({ enabled: false, state: 'draft', external: { version: '2.0.0' } })
      await page.reload()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      await market.getByRole('tab', { name: '添加插件', exact: true }).click()
      await retry.click()
      await review.waitFor()
      expect(attempts).toHaveLength(2)
      expect(attempts[1]).toEqual(attempts[0])
      expect((await record()).appliedRevision).toBeUndefined()
      await review.click()
      // The draft is reviewed and applied in the marketplace's dialog, not in plugin settings.
      const pluginContent = page.locator('dialog.plugin-market-dialog[open]')
      await reachable(pluginContent.getByRole('button', { name: '审阅文件：SKILL.md', exact: true }))
      await expect.poll(() => pluginContent.locator('pre[aria-label="SKILL.md"]').textContent()).toContain('先理解用户的目标和约束')
      // The shared highlighter has tokenized the file (this one is a heading and prose, so its spans are plain).
      await pluginContent.locator('pre[aria-label="SKILL.md"] span[class^="syn-"]').first().waitFor()
      const apply = pluginContent.getByRole('button', { name: '应用', exact: true })
      await expect.poll(() => apply.getAttribute('aria-disabled')).toBe(null)
      await pluginContent.getByText('这台 Mac 上的文件夹', { exact: true }).waitFor()
      await reachable(apply)
      expect(await page.locator('.settings-page').count()).toBe(0)
      await noHorizontalOverflow(page, market)
      await capture('local-review-320-dark')
      await pluginContent.getByRole('button', { name: '取消', exact: true }).click()
      await pluginContent.waitFor({ state: 'hidden' })
      expect(host.presence.requests).toHaveLength(approvals)
      expect((await record()).enabled).toBe(false)
      await panel.waitFor()
      await review.waitFor()
      await resize(1440, 'light')
      const localDraft = await record()
      await owner.confirmedJson(`plugin-packages/${id}/apply`, { body: { revision: localDraft.revision, requestId: randomUUID() } })
      await market.getByRole('tab', { name: installedTabName }).click()
      const installed = market.getByRole('tabpanel', { name: installedTabName })
      const installedLocal = installed.getByRole('listitem').filter({ hasText: title })
      await installedLocal.getByText('已安装 v2.0.0', { exact: true }).waitFor()
      expect(await installed.getByText(githubTitle, { exact: true }).count()).toBe(0)
      await writePackage(id, title, '2.1.0')
      const lookup = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/plugin-packages/external/find'))
      await installedLocal.getByRole('button', { name: '检查更新', exact: true }).click()
      expect((await lookup).postDataJSON()).toEqual({ pluginId: id })
      await installed.getByRole('button', { name: '保存更新草稿', exact: true }).click()
      await installedLocal.getByRole('button', { name: '审阅草稿', exact: true }).waitFor()
      expect(await record()).toMatchObject({ version: '2.1.0', appliedVersion: '2.0.0' })
      await openSettings(page)
      await openSection(settings, '插件')
      await settings.locator('.plugin-nav-row', { hasText: '插件市场' }).click()
      const toggleMarket = settings.getByRole('switch', { name: '启用 插件市场', exact: true })
      await toggleMarket.click()
      await expect.poll(() => toggleMarket.isChecked()).toBe(false)
      await backToSection(settings)
      await add.click()
      await market.getByRole('heading', { name: '添加插件', exact: true }).waitFor()
      expect(await market.getByRole('tablist', { name: '插件来源', exact: true }).count()).toBe(0)
      const addResults = market.getByRole('region', { name: '添加插件结果', exact: true })
      await addResults.getByText(title, { exact: true }).waitFor()
      await addResults.getByText(githubTitle, { exact: true }).waitFor()
      await expect.poll(() => back.count()).toBe(1)
      await capture('market-disabled-add-1440-light')
      await back.click()
      await reachable(add)
    } finally {
      await application?.close()
      await host.close()
    }
  })

  it('applies the context panel from its market listing and falls back in the same tab when disabled or removed', async () => {
    const host = await startTestHost({
      hostName: '工作电脑',
      plugins: [reviewPlugin],
      pluginRegistryFetch: async () => new Response(null, { status: 503 }),
    })
    let application: ElectronApplication | undefined
    try {
      const desktop = await launchDesktop(host)
      application = desktop
      const page = await desktop.firstWindow()
      page.setDefaultTimeout(20_000)
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setMinimumSize(320, 560))
      const resize = async (width: number, height: number) => {
        await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), {
          width,
          height,
        })
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      }
      await resize(1280, 900)
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
      const owner = await host.enroll({ listener: 'unix' })
      const report = await singleWindowSession(host, owner)
      const session = await reviewSession(host, owner)
      const sessionId = session.summary.id
      const path = `plugin-packages/${CONTEXT_ID}`
      const installed = async () => (await owner.json<{ package: PluginPackageDetail }>(path)).package
      const openContext = async (id = sessionId) => {
        await openSession(page, id)
        const toggle = page.getByRole('button', { name: '侧边面板', exact: true })
        if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
        await openPanelTab(page, CONTEXT_TITLE)
      }
      const plugin = page.locator('.context-insights')
      const builtin = page.locator('.session-context:not(.context-insights)')
      const onlyContextTab = async () => {
        const tabs = page
          .getByRole('tablist', { name: '会话面板', exact: true })
          .getByRole('tab', { name: /^上下文/u })
          .filter({ visible: true })
        await expect.poll(() => tabs.count()).toBe(1)
        expect(await tabs.getAttribute('aria-selected')).toBe('true')
      }
      const marketOpen = page.locator('#session-navigation').getByRole('button', { name: '插件市场', exact: true })
      const market = page.getByRole('region', { name: '插件市场', exact: true })
      expect((await owner.request(path)).status).toBe(404)
      await openContext()
      await builtin.getByRole('heading', { name: '上下文演变', exact: true }).waitFor()
      await onlyContextTab()
      expect(await plugin.count()).toBe(0)

      await marketOpen.click()
      const listing = market.getByRole('button', { name: CONTEXT_TITLE, exact: true })
      const card = market.locator('.plugin-market-card').filter({ has: page.getByRole('button', { name: CONTEXT_TITLE, exact: true }) })
      const cardCover = card.locator('[data-preview="context"]')
      await listing.waitFor()
      await card.getByText(`v${CONTEXT_VERSION}`, { exact: true }).waitFor()
      expect(await card.getByText(`已安装 v${CONTEXT_VERSION}`, { exact: true }).count()).toBe(0)
      const cardSample = await contextSample(cardCover)
      expect(cardSample.request).toBe('第 4 次请求')
      expect(cardSample.composition).toContain('工具定义')
      expect(cardSample.composition).toContain('55%')
      await card.screenshot({ path: `${OUTPUT}/context-card-1280-light.png`, animations: 'disabled', scale: 'css' })
      await listing.focus()
      await listing.press('Enter')
      // The card opens a dialog over the list: the list, its filters and its scroll stay where they were.
      const detail = page.getByRole('dialog', { name: CONTEXT_TITLE, exact: true })
      await detail.waitFor()
      await expect.poll(() => detail.evaluate(element => element.contains(document.activeElement))).toBe(true)
      const review = detail.getByRole('button', { name: '审阅并安装', exact: true })
      await expect.poll(() => review.getAttribute('aria-disabled')).toBe(null)
      const detailCover = detail.locator('[data-preview="context"]')
      expect(await contextSample(detailCover)).toEqual(cardSample)
      await detail.getByText('先保存草稿，应用后才会启用。', { exact: true }).waitFor()
      await reachable(review)
      await noHorizontalOverflow(page, market)
      await page.screenshot({ path: `${OUTPUT}/context-detail-1280-light.png`, animations: 'disabled', scale: 'css' })
      await detail
        .locator('.ui-dialog-surface')
        .screenshot({ path: `${OUTPUT}/context-detail-crop-1280-light.png`, animations: 'disabled', scale: 'css' })
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark')
      for (const [width, height] of [
        [768, 900],
        [390, 844],
      ] as const) {
        await resize(width, height)
        await settleShell(page)
        await reachable(review)
        await noHorizontalOverflow(page, market)
        expect(await contextSample(detailCover)).toEqual(cardSample)
        await page.screenshot({ path: `${OUTPUT}/context-detail-${width}-dark.png`, animations: 'disabled', scale: 'css' })
      }
      await resize(1280, 900)
      await page.emulateMedia({ colorScheme: 'light' })
      await review.click()
      // The saved draft is reviewed in the same dialog: where its code runs, every file with colours, the Host's review.
      const apply = detail.getByRole('button', { name: '应用', exact: true })
      await expect.poll(() => apply.getAttribute('aria-disabled')).toBe(null)
      expect(await page.locator('.settings-page').count()).toBe(0)
      await detail.getByText('代码在哪里运行', { exact: true }).waitFor()
      await detail.getByText('运行权限与风险', { exact: true }).waitFor()
      const files = detail.getByRole('button', { name: /^审阅文件/u })
      const sourceView = detail.locator('.creator-plugin-source')
      await expect.poll(() => sourceView.getAttribute('data-path')).toBe('panel.mjs')
      await sourceView.locator('.syn-keyword').first().waitFor()
      const saved = await installed()
      const name = saved.name
      const source = saved.bundle.files.find(file => file.path === 'panel.mjs')!.content
      expect(source).toContain('export default')
      expect(await sourceView.textContent()).toBe(source)
      expect(await files.count()).toBe(1)
      expect(saved).toMatchObject({ state: 'draft', enabled: false, catalog: { version: CONTEXT_VERSION } })
      const actions = host.presence.requests.length
      host.presence.mode = 'manual'
      await apply.click()
      await expect.poll(() => host.presence.requests.length).toBe(actions + 1)
      expect(host.presence.requests.at(-1)?.preview).toMatchObject({
        action: 'plugin.package.apply',
        lines: expect.arrayContaining([
          { label: '插件', value: name },
          { label: 'Host 模块', value: '0' },
          { label: 'React 面板', value: '1' },
        ]),
      })
      expect(await installed()).toMatchObject({ state: 'draft', enabled: false, trusted: false })
      expect(host.host.registry.uiPanels().some(panel => panel.pluginId === CONTEXT_ID)).toBe(false)
      const moduleUrl = /\/link\/api\/ui-modules\/context-insights%3Ainsights\/[a-f0-9]{64}\.mjs$/u
      const modules: BrowserResponse[] = []
      page.on('response', response => {
        if (moduleUrl.test(new URL(response.url()).pathname)) modules.push(response)
      })
      const applied = page.waitForResponse(
        response => response.url().includes(`/plugin-packages/${CONTEXT_ID}/apply`) && response.request().method() === 'POST',
      )
      host.presence.approveNext()
      host.presence.mode = 'approve'
      expect((await applied).status()).toBe(200)
      await expect.poll(installed).toMatchObject({ state: 'applied', enabled: true, trusted: true, appliedVersion: CONTEXT_VERSION })
      await detail.getByText(`已安装 v${CONTEXT_VERSION}`, { exact: true }).waitFor()
      await detail.getByRole('button', { name: '完成', exact: true }).click()
      await detail.waitFor({ state: 'hidden' })
      await expect.poll(() => listing.evaluate(element => element === document.activeElement)).toBe(true)
      await card.getByText(`已安装 v${CONTEXT_VERSION}`, { exact: true }).waitFor()
      await openContext()
      await expect.poll(() => modules.length, { timeout: 20_000 }).toBeGreaterThan(0)
      const response = modules[0]!
      expect(response.status()).toBe(200)
      expect(response.headers()['content-type']).toMatch(/^text\/javascript/u)
      expect(await response.text()).toBe(source)
      await plugin.getByRole('heading', { name: '上下文演变', exact: true }).waitFor()
      await onlyContextTab()
      await selectFourthRequest(plugin)
      await page.mouse.move(4, 4)
      await page.screenshot({ path: `${OUTPUT}/context-request-4-installed-1280-light.png`, animations: 'disabled', scale: 'css' })
      await resize(880, 780)
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark')
      await settleShell(page)
      await noHorizontalOverflow(page, plugin)
      await selectFourthRequest(plugin)
      await page.mouse.move(4, 4)
      await page.screenshot({ path: `${OUTPUT}/context-panel-880-dark.png`, animations: 'disabled', scale: 'css' })
      await resize(390, 844)
      await settleShell(page)
      await openContextPanel(page, plugin)
      await selectFourthRequest(plugin)
      await plugin.locator('.context-request-tools').scrollIntoViewIfNeeded()
      await noHorizontalOverflow(page, plugin)
      await page.screenshot({ path: `${OUTPUT}/context-tool-contributions-installed-390-dark.png`, animations: 'disabled', scale: 'css' })
      await jumpToLargestResult(page, plugin, session)
      await plugin.waitFor({ state: 'hidden' })
      await page.screenshot({ path: `${OUTPUT}/context-tool-jump-installed-390-dark.png`, animations: 'disabled', scale: 'css' })
      await resize(1280, 900)
      await openContext(report)
      const meter = plugin.getByRole('meter', { name: '上下文窗口', exact: true })
      await meter.waitFor()
      expect(await meter.getAttribute('aria-valuetext')).toBe('238,761 / 1,048,576 tokens · 22.77%')
      const percentage = (await plugin.getByText('22.77%', { exact: true }).boundingBox())!
      const usedLabel = (await plugin.getByText('已用', { exact: true }).boundingBox())!
      expect(usedLabel.x - (percentage.x + percentage.width)).toBeLessThanOrEqual(16)
      await plugin.getByText('809,815 tokens', { exact: true }).waitFor()
      expect(await plugin.getByRole('heading', { name: '逐轮窗口占用', exact: true }).count()).toBe(0)
      const activity = plugin.locator('.context-tool-activity')
      await activity.getByText(/共 72 次.*1 次失败/u).waitFor()
      const tools = activity.getByRole('listitem')
      expect(await tools.count()).toBe(4)
      for (const [name, calls, share] of [
        ['read', '34 次', '47.2%'],
        ['execute', '19 次', '26.4%'],
        ['edit', '15 次', '20.8%'],
        ['other', '4 次', '5.6%'],
      ]) {
        const row = tools.filter({ has: page.getByText(name, { exact: true }) })
        await row.getByText(calls, { exact: true }).waitFor()
        await row.getByText(share, { exact: true }).waitFor()
      }
      const execution = tools.filter({ hasText: 'execute' })
      expect(await execution.innerText()).toContain('1 次失败')
      expect(await execution.innerText()).toContain('8m 59s')
      for (const [width, height] of [
        [1280, 900],
        [768, 900],
        [390, 844],
      ] as const) {
        await resize(width, height)
        await settleShell(page)
        await openContextPanel(page, plugin)
        for (const theme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: theme })
          await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(theme)
          await noHorizontalOverflow(page, plugin)
          await page.mouse.move(4, 4)
          await plugin.screenshot({
            path: `${OUTPUT}/context-window-installed-${width}-${theme}.png`,
            animations: 'disabled',
            scale: 'css',
          })
        }
      }
      await plugin.getByRole('button', { name: '查看第 1 轮对话', exact: true }).click()
      await plugin.waitFor({ state: 'hidden' })
      await page.locator('.transcript .user-bubble').getByText('window-report 238761 1048576', { exact: true }).waitFor()
      await resize(1280, 900)
      await openContext()

      const settings = page.locator('.settings-page')
      const manage = async () => {
        const panel = await openSettings(page)
        await openSection(panel, '插件')
        await panel.locator('.plugin-nav-row').filter({ hasText: name }).click()
        return panel
      }
      await manage()
      const enable = settings.getByRole('switch', { name: `启用 ${name}`, exact: true })
      await enable.click()
      await expect.poll(() => enable.isChecked()).toBe(false)
      await closeSettings(settings)
      await builtin.getByRole('heading', { name: '上下文演变', exact: true }).waitFor()
      await onlyContextTab()
      expect(await plugin.count()).toBe(0)
      const modulePath = new URL(response.url()).pathname.replace('/link/api/', '')
      expect((await owner.request(modulePath)).status).toBe(404)

      await manage()
      await enable.click()
      await page.getByRole('dialog', { name: '审阅并启用插件', exact: true }).getByRole('button', { name: '确认启用', exact: true }).click()
      await expect.poll(() => enable.isChecked()).toBe(true)
      await closeSettings(settings)
      await plugin.getByRole('heading', { name: '上下文演变', exact: true }).waitFor()
      expect(host.presence.requests.length).toBe(actions + 1)

      await manage()
      await settings.getByRole('button', { name: '编辑…', exact: true }).click()
      const editor = page.locator('dialog:is(.ui-dialog, .ui-sheet)').filter({ has: page.locator('.plugin-editor') })
      await editor.getByRole('button', { name: '删除', exact: true }).click()
      await page.getByRole('button', { name: '删除插件', exact: true }).click()
      await editor.waitFor({ state: 'hidden' })
      expect((await owner.request(path)).status).toBe(404)
      await closeSettings(settings)
      await builtin.getByRole('heading', { name: '上下文演变', exact: true }).waitFor()
      await onlyContextTab()
      expect(await plugin.count()).toBe(0)
      expect((await owner.request(modulePath)).status).toBe(404)
      await marketOpen.click()
      await listing.click()
      await detail.waitFor()
      await expect.poll(() => review.getAttribute('aria-disabled')).toBe(null)
      await reachable(review)
    } finally {
      await application?.close()
      await host.close()
    }
  })

  it('retries an official check from Installed and applies the reviewed GitHub update', async () => {
    const files = new Map<string, string>()
    const commit = 'a6'.repeat(20)
    const remoteVersion = '1.2.1'
    let reachableGitHub = false
    let checks = 0
    const fetched = new Set<string>()
    const host = await startTestHost({
      pluginRegistryFetch: async (url, init) => {
        expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' })
        expect(new Headers(init.headers).has('authorization')).toBe(false)
        fetched.add(new URL(url).hostname)
        if (url === officialRefs) {
          checks++
          if (!reachableGitHub) return new Response(null, { status: 429, headers: { 'retry-after': '1' } })
        }
        return officialGithubResponse(url, commit, files)
      },
    })
    let application: ElectronApplication | undefined
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const ids = ['shift-handoff', 'release-review', 'release-check', CONTEXT_ID]
      const catalog = []
      for (const pluginId of ids) {
        const { bundle, review } = await owner.json<PluginCatalogPreview>('plugin-packages/catalog/preview', { body: { pluginId } })
        const folder = `plugins/${pluginId}`
        const manifest = pluginId === 'release-check' ? 'latch-app.json' : 'latch-plugin.json'
        catalog.push({ id: pluginId, folder, manifest, files: bundle.files.map(file => file.path) })
        if (pluginId !== 'release-check')
          await owner.json('plugin-packages/catalog/stage', { body: { pluginId, revision: review.revision, requestId: randomUUID() } })
        if (pluginId === 'shift-handoff' || pluginId === CONTEXT_ID)
          await owner.confirmedJson(`plugin-packages/${pluginId}/apply`, { body: { revision: review.revision, requestId: randomUUID() } })
        if (pluginId === 'shift-handoff')
          await owner.json(`plugin-packages/${pluginId}/enabled`, { body: { enabled: false, requestId: randomUUID() } })
        if (pluginId === CONTEXT_ID) {
          bundle.manifest.version = remoteVersion
          bundle.files[0]!.content += '\n// Updated official release.\n'
        }
        files.set(`${folder}/${manifest}`, JSON.stringify(bundle.manifest))
        for (const file of bundle.files) files.set(`${folder}/${file.path}`, file.content)
      }
      files.set('latch.catalog.json', JSON.stringify({ formatVersion: 1, plugins: catalog }))
      application = await launchDesktop(host)
      const page = await application.firstWindow()
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 900))
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      await page.locator('#session-navigation').getByRole('button', { name: '插件市场', exact: true }).click()
      const market = page.getByRole('region', { name: '插件市场', exact: true })
      const card = market.locator('.plugin-market-card').filter({ has: page.getByRole('button', { name: CONTEXT_TITLE, exact: true }) })
      await expect.poll(() => checks).toBe(1)
      await card.getByText(`已安装 v${CONTEXT_VERSION}`, { exact: true }).waitFor()
      const check = market.getByRole('button', { name: '检查更新', exact: true })
      await expect.poll(() => check.isEnabled()).toBe(true)
      await market.getByText(/GitHub 暂时限制匿名读取/u).waitFor()
      await market.screenshot({ path: `${OUTPUT}/official-check-retry.png`, animations: 'disabled', scale: 'css' })
      await market.getByRole('tab', { name: installedTabName }).click()
      const inventory = market.getByRole('tabpanel', { name: installedTabName })
      const cards = inventory.getByRole('list')
      const context = cards.getByRole('listitem').filter({ has: page.getByRole('heading', { name: CONTEXT_TITLE, exact: true }) })
      const disabled = cards.getByRole('listitem').filter({ has: page.getByRole('heading', { name: '交接清单', exact: true }) })
      await reachable(disabled.getByRole('button', { name: '管理', exact: true }))
      expect(await cards.count()).toBe(1)
      expect(await cards.getByRole('listitem').count()).toBe(2)
      await market.getByRole('tab', { name: '已安装（2）', exact: true }).waitFor()
      expect(await inventory.getByRole('heading', { name: '官方插件', exact: true }).count()).toBe(0)
      await context.getByText(/窗口/u).waitFor()
      expect(await disabled.getByRole('switch').isChecked()).toBe(false)
      const toggle = context.getByRole('switch')
      expect(await toggle.isChecked()).toBe(true)
      expect(await inventory.getByText('发布清单面板', { exact: true }).count()).toBe(0)
      expect(await inventory.locator('.plugin-market-preview, .plugin-market-icon, .plugin-market-inline-icon, img').count()).toBe(0)
      await reachable(disabled.getByRole('button', { name: '检查更新', exact: true }))
      const retry = context.getByRole('button', { name: '检查更新', exact: true })
      const update = context.getByRole('button', { name: '审阅更新', exact: true })
      await retry.click()
      await context.getByText(/GitHub 暂时限制匿名读取/u).waitFor()
      expect(await disabled.getByText(/GitHub 暂时限制匿名读取/u).count()).toBe(0)
      reachableGitHub = true
      await retry.click()
      await context.getByText(`可更新到 v${remoteVersion}`, { exact: true }).waitFor()
      expect(await inventory.getByText(/个官方插件可更新/u).count()).toBe(0)
      expect(checks).toBe(3)
      await market.getByRole('tab', { name: 'Latch 官方', exact: true }).click()
      await card.getByText(`可更新到 v${remoteVersion}`, { exact: true }).waitFor()
      await market.screenshot({ path: `${OUTPUT}/official-update-available.png`, animations: 'disabled', scale: 'css' })
      await card.getByRole('button', { name: CONTEXT_TITLE, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: CONTEXT_TITLE })
      await dialog.getByRole('button', { name: '检查更新', exact: true }).click()
      await expect.poll(() => checks).toBe(4)
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await market.getByRole('tab', { name: installedTabName }).click()
      const desktop = application
      for (const [width, theme] of [
        [1440, 'light'],
        [1440, 'dark'],
        [820, 'dark'],
        [390, 'dark'],
        [320, 'dark'],
      ] as const) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
        await desktop.evaluate(({ BrowserWindow }, width) => {
          const window = BrowserWindow.getAllWindows()[0]!
          window.setMinimumSize(320, 560)
          window.setContentSize(width, width >= 820 ? 900 : 844)
        }, width)
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
        await settleShell(page)
        await noHorizontalOverflow(page, inventory)
        await reachable(retry)
        await reachable(update)
        await reachable(toggle)
        await reachable(context.getByRole('button', { name: '管理', exact: true }))
        const [first, second] = await Promise.all([disabled.boundingBox(), context.boundingBox()])
        if (width >= 1440) expect(Math.abs(first!.y - second!.y)).toBeLessThan(1)
        if (width <= 390) expect(Math.abs(first!.x - second!.x)).toBeLessThan(1)
        await page.mouse.move(2, 2)
        await market.screenshot({ path: `${OUTPUT}/installed-update-${width}-${theme}.png`, animations: 'disabled', scale: 'css' })
      }
      const record = async () => (await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${CONTEXT_ID}`)).package
      await toggle.click()
      await expect.poll(record).toMatchObject({ enabled: false, appliedVersion: CONTEXT_VERSION })
      await expect.poll(() => toggle.isChecked()).toBe(false)
      expect(await cards.getByRole('listitem').count()).toBe(2)
      await toggle.click()
      await page.getByRole('dialog', { name: '审阅并启用插件', exact: true }).getByRole('button', { name: '确认启用', exact: true }).click()
      await expect.poll(record).toMatchObject({ enabled: true, appliedVersion: CONTEXT_VERSION })
      await expect.poll(() => toggle.isChecked()).toBe(true)
      await update.click()
      await dialog.getByRole('button', { name: '审阅更新', exact: true }).click()
      await expect.poll(record).toMatchObject({ catalog: { version: remoteVersion, commit }, appliedVersion: CONTEXT_VERSION })
      await dialog.getByRole('button', { name: '应用', exact: true }).click()
      await expect.poll(record).toMatchObject({ appliedVersion: remoteVersion, enabled: true })
      await dialog.getByRole('button', { name: '完成', exact: true }).click()
      await context.getByText(`已安装 v${remoteVersion}`, { exact: true }).waitFor()
      expect(await update.count()).toBe(0)
      const { catalog: live } = await owner.json<AppSnapshot>('snapshot')
      expect(live?.uiPanels?.find(panel => panel.id === 'context-insights:insights')?.officialContext).toBe(true)
      expect(fetched).toEqual(new Set(['github.com', 'codeload.github.com', 'raw.githubusercontent.com']))
    } finally {
      await application?.close()
      await host.close()
    }
  })

  it('browses independently and changes an npm plugin only when its downloaded draft is applied', async () => {
    const v1 = '先核对交接日期。'
    const v2 = '先核对交接日期，再确认下一步。'
    const requests: string[] = []
    const releases = new Map<string, Awaited<ReturnType<typeof npmRelease>>>()
    let checklist: Awaited<ReturnType<typeof npmRelease>>
    let latest = '1.0.0'
    const host = await startTestHost({
      hostName: '工作电脑',
      sessionFolders: true,
      pluginRegistryFetch: async url => {
        if (url === officialRefs) return new Response(null, { status: 503 })
        requests.push(url)
        if (url === CHECKLIST_METADATA + 'latest' || url === CHECKLIST_METADATA + checklist.metadata.version)
          return Response.json(checklist.metadata)
        if (url === checklist.metadata.dist.tarball) return new Response(Uint8Array.from(checklist.bytes))
        const release = [...releases.values()].find(item => item.metadata.dist.tarball === url)
        if (release) return new Response(Uint8Array.from(release.bytes))
        if (url.startsWith(METADATA)) {
          const metadata = releases.get(url === LATEST ? latest : url.slice(METADATA.length))?.metadata
          if (metadata) return Response.json(metadata)
        }
        throw new Error('Unexpected registry request: ' + url)
      },
    })
    let application: ElectronApplication | undefined
    try {
      await mkdir(OUTPUT, { recursive: true })
      releases.set('1.0.0', await npmRelease(host.root, '1.0.0', v1))
      releases.set('2.0.0', await npmRelease(host.root, '2.0.0', v2))
      releases.set('3.0.0', await npmRelease(host.root, '3.0.0', '核对交接日期、下一步和负责人。'))
      checklist = await npmRelease(host.root, '1.0.0', '发布前复核结果。', CHECKLIST)
      const electron = await launchDesktop(host)
      application = electron
      const page = await application.firstWindow()
      page.setDefaultTimeout(20_000)
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(320, 560))
      const resize = async (width: number, height: number) => {
        await electron.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), {
          width,
          height,
        })
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      }
      await resize(1440, 960)
      await page.emulateMedia({ colorScheme: 'light' })
      const owner = await host.enroll({ listener: 'unix' })
      const installed = async () => (await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${ID}`)).package
      const activeSkill = () => {
        const lease = host.host.registry.acquire('demo')
        try {
          return lease.skills?.find(skill => skill.name === TITLE)?.content
        } finally {
          lease.release()
        }
      }

      const composer = page.locator('.workbench-home').getByRole('textbox', { name: '新会话消息', exact: true })
      const draft = '切换市场时保留这份普通会话草稿。'
      await composer.fill(draft)
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        body: { prompt: '核对发布准备工作', requestId: randomUUID(), mode: 'chat' },
      })
      await openSession(page, sessionId)
      const reply = page.getByRole('textbox', { name: '继续对话', exact: true })
      const replyDraft = '保留在已有会话里的草稿。'
      await reply.fill(replyDraft)
      const navigation = page.locator('#session-navigation')
      const open = navigation.getByRole('button', { name: '插件市场', exact: true })
      const newSession = navigation.getByRole('button', { name: '新建会话', exact: true })
      expect(await open.evaluate(element => element.previousElementSibling?.textContent?.trim())).toBe('定时任务')
      const market = page.getByRole('region', { name: '插件市场', exact: true })
      const sources = market.getByRole('tablist', { name: '插件来源', exact: true })
      const bundled = sources.getByRole('tab', { name: 'Latch 官方', exact: true })
      const installedTab = sources.getByRole('tab', { name: installedTabName })
      const npm = sources.getByRole('tab', { name: '添加插件', exact: true })
      const bundledPanel = market.getByRole('tabpanel', { name: 'Latch 官方', exact: true })
      const installedPanel = market.getByRole('tabpanel', { name: installedTabName })
      const npmPanel = market.getByRole('tabpanel', { name: '添加插件', exact: true })
      await open.click()
      await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('marketplace')
      await expect.poll(() => open.getAttribute('aria-current')).toBe('page')
      expect(await bundled.getAttribute('aria-selected')).toBe('true')
      expect(await bundled.getAttribute('tabindex')).toBe('0')
      expect(await npm.getAttribute('tabindex')).toBe('-1')
      expect(await bundledPanel.getAttribute('id')).toBeTruthy()
      expect(await bundled.getAttribute('aria-controls')).toBe(await bundledPanel.getAttribute('id'))
      await npmPanel.waitFor({ state: 'hidden' })
      expect(await page.getByRole('dialog').count()).toBe(0)
      expect(await page.locator('dialog[open]').count()).toBe(0)
      expect(await open.evaluate(element => !!element.closest('[inert]'))).toBe(false)
      expect(await reply.isVisible()).toBe(false)
      const search = market.getByRole('searchbox', { name: '搜索任务或插件', exact: true })
      const categories = market.getByRole('group', { name: '贡献类型', exact: true })
      const all = categories.getByRole('button', { name: '全部', exact: true })
      const tools = categories.getByRole('button', { name: '工具', exact: true })
      const create = market.getByRole('button', { name: '创建插件', exact: true })
      const handoff = market.getByRole('button', { name: '交接清单', exact: true })
      const releasePanel = market.getByRole('button', { name: '发布清单面板', exact: true })
      const releaseHistory = market.getByRole('button', { name: '发布检查记录', exact: true })
      const englishMarket = page.getByRole('region', { name: 'Plugin marketplace', exact: true })
      const capture = async (name: string, region = market) => {
        await settleShell(page)
        await page.mouse.move(4, 4)
        await noHorizontalOverflow(page, region)
        await page.screenshot({ path: `${OUTPUT}/${name}.png`, animations: 'disabled', scale: 'css' })
      }
      const verifyHeader = async (english = false) => {
        const region = english ? englishMarket : market
        const action = english ? region.getByRole('button', { name: 'Create plugin', exact: true }) : create
        const title = region.getByRole('heading', { name: english ? 'Plugin marketplace' : '插件市场', exact: true })
        const introduction = region.locator('.plugin-market-introduction')
        const tabs = english ? region.getByRole('tablist', { name: 'Plugin source', exact: true }) : sources
        const field = english ? region.getByRole('searchbox', { name: 'Search by task or plugin', exact: true }) : search
        await reachable(action)
        await reachable(field)
        const [titleBox, actionBox, introBox, tabsBox, fieldBox] = await Promise.all(
          [title, action, introduction, tabs, field].map(locator => locator.boundingBox()),
        )
        const alongside =
          titleBox!.x + titleBox!.width <= actionBox!.x
          && actionBox!.y < titleBox!.y + titleBox!.height
          && titleBox!.y < actionBox!.y + actionBox!.height
        if (english) {
          expect(alongside || actionBox!.y >= titleBox!.y + titleBox!.height).toBe(true)
          const wordLines = await title.evaluate(element => {
            const text = element.firstChild!
            const word = 'marketplace'
            const start = text.textContent!.indexOf(word)
            const range = document.createRange()
            range.setStart(text, start)
            range.setEnd(text, start + word.length)
            return range.getClientRects().length
          })
          expect(wordLines).toBe(1)
        } else {
          expect(alongside).toBe(true)
        }
        expect(introBox!.y).toBeGreaterThanOrEqual(Math.max(titleBox!.y + titleBox!.height, actionBox!.y + actionBox!.height))
        expect(tabsBox!.y).toBeGreaterThanOrEqual(introBox!.y + introBox!.height)
        expect(fieldBox!.y).toBeGreaterThanOrEqual(tabsBox!.y + tabsBox!.height)
        expect(await action.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      }
      await handoff.waitFor()
      await releasePanel.waitFor()
      await releaseHistory.waitFor()
      expect(await market.locator('.plugin-market-card-heading').allTextContents()).toEqual([
        '交接清单',
        '发布清单面板',
        '发布检查记录',
        CONTEXT_TITLE,
      ])
      const panels = categories.getByRole('button', { name: '会话面板', exact: true })
      await panels.click()
      await market
        .getByRole('status')
        .filter({ hasText: /^2 个插件$/u })
        .waitFor()
      expect(await market.locator('.plugin-market-card-heading').allTextContents()).toEqual(['发布清单面板', CONTEXT_TITLE])
      await search.fill(CONTEXT_ID)
      await market
        .getByRole('status')
        .filter({ hasText: /^1 个插件$/u })
        .waitFor()
      const contextCard = market.getByRole('button', { name: CONTEXT_TITLE, exact: true })
      await contextCard.waitFor()
      expect(await contextCard.getAttribute('aria-describedby')).toBeTruthy()
      expect(await releasePanel.count()).toBe(0)
      await tools.click()
      await market.getByText('没有匹配的插件', { exact: true }).waitFor()
      await market.getByRole('button', { name: '清除搜索和筛选', exact: true }).click()
      await handoff.waitFor()
      await verifyHeader()
      const panelContributions = ['会话面板', '工具', '技能']
      const panelTags = market
        .getByRole('listitem')
        .filter({ has: page.getByRole('button', { name: '发布清单面板', exact: true }) })
        .locator('.plugin-market-tags li')
      expect((await panelTags.allTextContents()).toSorted()).toEqual(panelContributions)
      const contextCover = market.locator('.plugin-market-card [data-preview="context"]')
      const context = await contextSample(contextCover)
      const gallery = market.locator('.plugin-market-gallery')
      const coverColors = () =>
        gallery.locator('.market-feature').evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor))
      await capture('bundled-1440-light')
      expect(await gallery.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(4)
      expect(await gallery.getByText('v1.0.0', { exact: true }).count()).toBe(1)
      expect(await gallery.getByText('v1.0.1', { exact: true }).count()).toBe(2)
      await gallery.getByText(`v${CONTEXT_VERSION}`, { exact: true }).waitFor()
      expect(await gallery.getByText(/随附 v/u).count()).toBe(0)
      await bundledArtwork(gallery)
      const lightColors = await coverColors()
      expect(new Set(lightColors).size).toBe(4)
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark')
      await capture('bundled-1440-dark')
      await gallery.screenshot({ path: `${OUTPUT}/bundled-gallery-1440-dark.png`, animations: 'disabled', scale: 'css' })
      await bundledArtwork(gallery)
      const darkColors = await coverColors()
      expect(new Set(darkColors).size).toBe(4)
      expect(darkColors.every((color, index) => color !== lightColors[index])).toBe(true)
      await panels.click()
      await expect.poll(() => gallery.locator('.plugin-market-card').count()).toBe(2)
      await capture('context-panel-pair-1440-dark')
      await gallery.screenshot({ path: `${OUTPUT}/context-panel-pair-crop-1440-dark.png`, animations: 'disabled', scale: 'css' })
      await all.click()
      for (const [width, height] of [
        [768, 1024],
        [390, 844],
        [320, 844],
      ] as const) {
        await resize(width, height)
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme })
          expect(await contextSample(contextCover)).toEqual(context)
          await bundledArtwork(gallery)
          await capture(`bundled-${width}-${colorScheme}`)
          if (width === 768)
            await gallery.screenshot({ path: `${OUTPUT}/bundled-gallery-2x2-${colorScheme}.png`, animations: 'disabled', scale: 'css' })
        }
        await verifyHeader()
        await reachable(bundled)
        await reachable(npm)
        await reachable(tools)
      }
      const changeLanguage = async (language: 'en' | 'zh-CN') => {
        await page.evaluate(locale => {
          Object.defineProperty(navigator, 'languages', { configurable: true, get: () => [locale] })
          window.dispatchEvent(new Event('languagechange'))
        }, language)
        await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(language)
      }
      await changeLanguage('en')
      await verifyHeader(true)
      const englishContext = await contextSample(englishMarket.locator('.plugin-market-card [data-preview="context"]'))
      expect(englishContext.request).toBe('Request 4')
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await capture(`bundled-320-en-${colorScheme}`, englishMarket)
      }
      await changeLanguage('zh-CN')
      await resize(390, 560)
      const scroll = bundledPanel.getByRole('region', { name: '精选插件', exact: true })
      const pinned = [market.getByRole('heading', { name: '插件市场', exact: true }), sources, search, categories]
      const featured = scroll.getByRole('heading', { name: '精选插件', exact: true })
      await scroll.evaluate(element => (element.scrollTop = 0))
      const featuredBefore = await featured.evaluate(element => element.getBoundingClientRect().top)
      const offset = await scrollBelowControls(scroll, pinned)
      expect(await featured.evaluate(element => element.getBoundingClientRect().top)).toBeLessThan(featuredBefore)
      await capture('bundled-scrolled-390-dark')
      await bundled.focus()
      await page.keyboard.press('ArrowRight')
      await installedPanel.waitFor()
      await page.keyboard.press('ArrowLeft')
      await bundledPanel.waitFor()
      await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(offset)
      const contextListing = market.getByRole('button', { name: CONTEXT_TITLE, exact: true })
      await contextListing.scrollIntoViewIfNeeded()
      const beforeDetail = await scroll.evaluate(element => element.scrollTop)
      await contextListing.press('Enter')
      await page.getByRole('dialog', { name: CONTEXT_TITLE, exact: true }).getByRole('button', { name: '取消', exact: true }).click()
      await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(beforeDetail)
      await expect.poll(() => contextListing.evaluate(element => element === document.activeElement)).toBe(true)
      await resize(1440, 960)
      await page.emulateMedia({ colorScheme: 'light' })
      await search.fill('发布')
      await categories.getByRole('button', { name: '技能', exact: true }).click()
      await releasePanel.waitFor()
      expect(await handoff.count()).toBe(0)
      expect(await releaseHistory.count()).toBe(0)
      await tools.click()
      await releasePanel.waitFor()
      await market
        .getByRole('status')
        .filter({ hasText: /^1 个插件$/u })
        .waitFor()
      await capture('bundled-filtered-1440-light')
      await bundled.focus()
      await page.keyboard.press('ArrowRight')
      await installedPanel.waitFor()
      expect(await installedTab.getAttribute('aria-controls')).toBe(await installedPanel.getAttribute('id'))
      expect(await installedTab.evaluate(element => element === document.activeElement)).toBe(true)
      await installedPanel.getByText('还没有已安装的插件', { exact: true }).waitFor()
      await page.keyboard.press('ArrowRight')
      await npmPanel.waitFor()
      expect(await create.count()).toBe(0)
      expect(await npm.getAttribute('aria-selected')).toBe('true')
      expect(await npm.getAttribute('tabindex')).toBe('0')
      expect(await bundled.getAttribute('tabindex')).toBe('-1')
      expect(await npmPanel.getAttribute('id')).toBeTruthy()
      expect(await npm.getAttribute('aria-controls')).toBe(await npmPanel.getAttribute('id'))
      expect(await npm.evaluate(element => element === document.activeElement)).toBe(true)
      await bundledPanel.waitFor({ state: 'hidden' })
      await page.keyboard.press('ArrowLeft')
      await installedPanel.waitFor()
      await page.keyboard.press('ArrowLeft')
      await bundledPanel.waitFor()
      await create.waitFor()
      expect(await bundled.evaluate(element => element === document.activeElement)).toBe(true)
      await page.keyboard.press('End')
      await npmPanel.waitFor()
      await page.keyboard.press('Home')
      await bundledPanel.waitFor()
      expect(await bundled.getAttribute('aria-selected')).toBe('true')
      expect(await search.inputValue()).toBe('发布')
      expect(await tools.getAttribute('aria-pressed')).toBe('true')
      expect(await handoff.count()).toBe(0)
      await releasePanel.focus()
      await page.keyboard.press('Enter')
      const panelDialog = page.getByRole('dialog', { name: '发布清单面板', exact: true })
      await panelDialog.waitFor()
      expect((await panelDialog.locator('.plugin-market-tags li').allTextContents()).toSorted()).toEqual(panelContributions)
      await page.keyboard.press('Escape')
      await panelDialog.waitFor({ state: 'hidden' })
      expect(await search.inputValue()).toBe('发布')
      expect(await tools.getAttribute('aria-pressed')).toBe('true')
      await expect.poll(() => releasePanel.evaluate(element => element === document.activeElement)).toBe(true)
      await search.fill('交接')
      await market.getByText('没有匹配的插件', { exact: true }).waitFor()
      await market.getByRole('button', { name: '清除搜索和筛选', exact: true }).click()
      expect(await search.inputValue()).toBe('')
      expect(await all.getAttribute('aria-pressed')).toBe('true')
      await expect.poll(() => search.evaluate(element => element === document.activeElement)).toBe(true)
      await handoff.waitFor()
      await releaseHistory.waitFor()
      await search.fill('发布检查记录')
      expect(await handoff.count()).toBe(0)
      await releaseHistory.click()
      const historyDialog = page.getByRole('dialog', { name: '发布检查记录', exact: true })
      await historyDialog.waitFor()
      await historyDialog.getByRole('img').evaluate(async (image: HTMLImageElement) => image.decode())
      await capture('bundled-detail-1440-light')
      await historyDialog.getByRole('button', { name: '取消', exact: true }).click()
      expect(await search.inputValue()).toBe('发布检查记录')
      await expect.poll(() => releaseHistory.evaluate(element => element === document.activeElement)).toBe(true)
      await search.clear()
      await openSession(page, sessionId)
      await market.waitFor({ state: 'hidden' })
      await expect.poll(() => promptValue(reply)).toBe(replyDraft)
      await open.click()
      await market.waitFor()
      await newSession.click()
      await market.waitFor({ state: 'hidden' })
      expect(await page.locator('.settings-page').count()).toBe(0)
      await expect.poll(() => promptValue(composer)).toBe(draft)
      expect(requests).toEqual([])

      await open.click()
      await npm.click()
      const name = market.getByRole('textbox', { name: 'npm 包名、GitHub 地址或文件夹路径', exact: true })
      await name.fill(NAME)
      const configure = npmPanel.getByRole('button', { name: '配置 npm 源', exact: true })
      await configure.waitFor()
      await capture('npm-1440-light')
      await page.emulateMedia({ colorScheme: 'dark' })
      await capture('npm-1440-dark')
      for (const width of [390, 320]) {
        await resize(width, 844)
        await capture(`npm-${width}-dark`)
        await reachable(npm)
        await reachable(configure)
      }
      await resize(1440, 960)
      await page.emulateMedia({ colorScheme: 'light' })
      await configure.click()
      await market.getByRole('textbox', { name: 'npm 源地址', exact: true }).fill(REGISTRY.slice(0, -1))
      await page.screenshot({ path: `${OUTPUT}/npm-source-1440-light.png`, animations: 'disabled', scale: 'css' })
      const approvals = host.presence.requests.length
      host.presence.mode = 'manual'
      await market.getByRole('button', { name: '保存来源', exact: true }).click()
      await expect.poll(() => host.presence.requests.length).toBe(approvals + 1)
      expect(host.presence.requests.at(-1)?.preview.action).toBe('policy.change')
      expect(await bundled.isDisabled()).toBe(true)
      await npm.focus()
      await page.keyboard.press('ArrowLeft')
      expect(await npm.getAttribute('aria-selected')).toBe('true')
      expect(await npm.evaluate(element => element === document.activeElement)).toBe(true)
      expect(await owner.json('plugin-packages/npm/registry')).toMatchObject({ registry: null })
      expect(requests).toEqual([])
      host.presence.approveNext()
      host.presence.mode = 'approve'
      await expect.poll(() => npmPanel.getByRole('combobox', { name: 'npm 源', exact: true }).inputValue()).toBe(REGISTRY)
      await name.fill(NAME)
      await market.getByRole('button', { name: '查找', exact: true }).click()
      await market.getByText('1.0.0', { exact: true }).waitFor()
      const download = market.getByRole('button', { name: '下载为草稿', exact: true })
      await reachable(download)
      expect(requests).toEqual([LATEST, releases.get('1.0.0')!.metadata.dist.tarball])
      const fallback = market.locator('.plugin-market-preview[data-preview="fallback"]')
      const previewIdentity = market.locator('.plugin-market-npm-preview')
      const firstArtwork = await fallbackArtwork(fallback)
      expect(firstArtwork).toMatchObject({ pattern: expect.any(String), tone: expect.any(String) })
      expect(firstArtwork.texture).toMatch(/gradient/u)
      const firstIcon = await fallbackIcon(previewIdentity)
      expect(firstIcon).toMatchObject({ tone: firstArtwork.tone, glyph: expect.any(String), drawing: expect.any(String) })
      const downloadedRow = (title: string) => npmPanel.locator('.marketplace-fact').filter({ has: page.getByText(title, { exact: true }) })
      await noHorizontalOverflow(page, market)
      await page.screenshot({ path: `${OUTPUT}/npm-preview-1440-light.png`, animations: 'disabled', scale: 'css' })
      await download.click()
      const review = market.getByRole('button', { name: '审阅草稿', exact: true })
      await review.waitFor()
      const firstDraft = await installed()
      expect(firstDraft).toMatchObject({ state: 'draft', enabled: false, npm: { name: NAME, version: '1.0.0', registry: REGISTRY } })
      expect(firstDraft.appliedRevision).toBeUndefined()
      expect(activeSkill()).toBeUndefined()
      const settings = page.locator('.settings-page')
      const consent = page.locator('dialog.plugin-market-dialog[open]')
      const applyDraft = async (baseAppliedRevision: string | null) => {
        if (!(await consent.isVisible())) await review.click()
        const apply = consent.getByRole('button', { name: '应用', exact: true })
        await consent.getByText(REGISTRY, { exact: true }).waitFor()
        await expect.poll(() => apply.getAttribute('aria-disabled')).toBe(null)
        expect((await installed()).appliedRevision ?? null).toBe(baseAppliedRevision)
        const applying = page.waitForResponse(
          response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/plugin-packages/${ID}/apply`),
        )
        await apply.click()
        const response = await applying
        expect(response.ok()).toBe(true)
        expect(response.request().postDataJSON()).toMatchObject({ baseAppliedRevision })
        await consent.getByRole('button', { name: '完成', exact: true }).click()
        await consent.waitFor({ state: 'hidden' })
      }
      await applyDraft(null)
      await expect.poll(installed).toMatchObject({ state: 'applied', appliedRevision: firstDraft.revision, enabled: true })
      expect(activeSkill()).toBe(v1)
      expect(await settings.count()).toBe(0)
      await market.waitFor()
      expect(await open.getAttribute('aria-current')).toBe('page')
      expect(await npm.getAttribute('aria-selected')).toBe('true')
      await downloadedRow(TITLE).getByText('已安装 v1.0.0', { exact: true }).waitFor()

      latest = '2.0.0'
      const previousRequests = requests.length
      await page.emulateMedia({ colorScheme: 'dark' })
      await name.clear()
      expect(requests.length).toBe(previousRequests)
      const checking = page.waitForRequest(
        request => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/plugin-packages/npm/preview'),
      )
      await market.getByRole('button', { name: '检查更新', exact: true }).click()
      expect((await checking).postDataJSON()).toEqual({ name: NAME, pluginId: ID })
      const versions = market.getByText('1.0.0 → 2.0.0', { exact: true })
      await versions.waitFor()
      const downloadUpdate = market.getByRole('button', { name: '下载更新草稿', exact: true })
      await reachable(downloadUpdate)
      expect(requests.slice(previousRequests)).toEqual([LATEST, releases.get('2.0.0')!.metadata.dist.tarball])
      expect((await installed()).revision).toBe(firstDraft.revision)
      const updateArtwork = await fallbackArtwork(fallback)
      expect(updateArtwork).toMatchObject({ pattern: firstArtwork.pattern, tone: firstArtwork.tone })
      expect(await fallbackIcon(previewIdentity)).toEqual(firstIcon)
      await page.screenshot({ path: `${OUTPUT}/npm-update-1440-dark.png`, animations: 'disabled', scale: 'css' })
      await fallback.screenshot({ path: `${OUTPUT}/npm-update-cover-1440-dark.png`, animations: 'disabled', scale: 'css' })
      for (const width of [320, 390]) {
        await resize(width, 844)
        await versions.waitFor()
        await reachable(downloadUpdate)
        await noHorizontalOverflow(page, market)
        await page.screenshot({ path: `${OUTPUT}/npm-update-${width}-dark.png`, animations: 'disabled', scale: 'css' })
      }
      await resize(1440, 960)
      await market.getByRole('button', { name: '返回查找', exact: true }).click()
      await downloadedRow(TITLE).getByText('可更新到 v2.0.0', { exact: true }).waitFor()
      const updateButton = downloadedRow(TITLE).getByRole('button', { name: '检查更新', exact: true })
      await expect.poll(() => updateButton.evaluate(element => element === document.activeElement)).toBe(true)
      await updateButton.click()
      await downloadUpdate.waitFor()
      const stageAttempts: Array<string | null> = []
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/plugin-packages/npm/stage'))
          stageAttempts.push(request.postData())
      })
      await page.evaluate(() => {
        const original = window.fetch.bind(window)
        window.fetch = async (input, options) => {
          const response = await original(input, options)
          if (
            typeof input === 'string'
            && input.endsWith('/plugin-packages/npm/stage')
            && options?.method === 'POST'
            && response.status === 201
          )
            throw new TypeError('Simulated lost response after delivery')
          return response
        }
      })
      await downloadUpdate.click()
      const retryStage = market.getByRole('button', { name: '重试同一请求', exact: true })
      await retryStage.waitFor()
      const update = await installed()
      expect(update).toMatchObject({
        state: 'update-available',
        enabled: true,
        appliedRevision: firstDraft.revision,
        npm: { version: '2.0.0', registry: REGISTRY },
      })
      expect(update.revision).not.toBe(firstDraft.revision)
      expect(activeSkill()).toBe(v1)
      expect(stageAttempts).toHaveLength(1)
      expect(requests.slice(-2)).toEqual([METADATA + '2.0.0', releases.get('2.0.0')!.metadata.dist.tarball])
      const afterStage = requests.length
      await page.reload()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      await market.waitFor()
      expect(await open.getAttribute('aria-current')).toBe('page')
      if ((await npm.getAttribute('aria-selected')) !== 'true') await npm.click()
      await reachable(retryStage)
      expect(await downloadedRow(TITLE).locator('.plugin-market-icon').count()).toBe(0)
      await page.screenshot({ path: `${OUTPUT}/npm-retry-1440-dark.png`, animations: 'disabled', scale: 'css' })
      await retryStage.click()
      await review.waitFor()
      expect(stageAttempts).toHaveLength(2)
      expect(stageAttempts[0]).toMatch(/"requestId":"[^"]+"/u)
      expect(stageAttempts[1]).toBe(stageAttempts[0])
      expect(requests.length).toBe(afterStage)
      expect((await installed()).appliedRevision).toBe(firstDraft.revision)
      await review.click()
      await expect.poll(() => consent.locator('.creator-plugin-source').textContent()).toContain(v2)
      expect((await installed()).appliedRevision).toBe(firstDraft.revision)
      await page.screenshot({ path: `${OUTPUT}/npm-draft-1440-dark.png`, animations: 'disabled', scale: 'css' })
      await applyDraft(firstDraft.revision)
      await expect.poll(installed).toMatchObject({ state: 'applied', appliedRevision: update.revision, enabled: true })
      expect(activeSkill()).toBe(v2)

      const { bundle } = await installed()
      bundle.files[0].content = '我的本地修改。'
      const { package: edited } = await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${ID}`, {
        method: 'PUT',
        body: { requestId: randomUUID(), baseRevision: update.revision, bundle },
      })
      latest = '3.0.0'
      await market.waitFor()
      expect(await npm.getAttribute('aria-selected')).toBe('true')
      await installedTab.click()
      const installedHandoff = installedPanel.getByRole('listitem').filter({ hasText: TITLE })
      await installedHandoff.getByRole('button', { name: '检查更新', exact: true }).click()
      await installedPanel.getByRole('button', { name: '导出本地草稿', exact: true }).waitFor()
      const backToInstalled = installedPanel.getByRole('button', { name: '返回已安装', exact: true })
      await backToInstalled.click()
      const checkInstalled = installedHandoff.getByRole('button', { name: '检查更新', exact: true })
      await expect.poll(() => checkInstalled.evaluate(button => button === document.activeElement)).toBe(true)
      await checkInstalled.click()
      const replace = installedPanel.getByRole('button', { name: '替换本地草稿', exact: true })
      const confirmation = page.getByRole('dialog', { name: '替换本地草稿', exact: true })
      await replace.click()
      const confirm = confirmation.getByRole('button', { name: '确认替换草稿', exact: true })
      await confirm.waitFor()
      await page.screenshot({ path: `${OUTPUT}/npm-replace-confirm-1440-dark.png`, animations: 'disabled', scale: 'css' })
      await confirmation.getByRole('button', { name: '取消', exact: true }).click()
      await confirmation.waitFor({ state: 'hidden' })
      expect(stageAttempts).toHaveLength(2)
      expect((await installed()).revision).toBe(edited.revision)
      await replace.click()
      await confirm.click()
      await installedHandoff.getByRole('button', { name: '审阅草稿', exact: true }).waitFor()
      expect(await installed()).toMatchObject({
        state: 'update-available',
        enabled: true,
        appliedRevision: update.revision,
        npm: { version: '3.0.0' },
      })
      expect(activeSkill()).toBe(v2)
      expect(host.presence.requests.length).toBe(approvals + 1)

      const pluginSettings = await openSettings(page)
      await openSection(pluginSettings, '插件')
      await pluginSettings.locator('.plugin-nav-row', { hasText: '插件市场' }).click()
      const toggle = pluginSettings.getByRole('switch', { name: '启用 插件市场', exact: true })
      const builtin = () => host.host.registry.list().find(plugin => plugin.id === PLUGIN_MARKETPLACE_PAGE.pluginId)
      expect(await toggle.isChecked()).toBe(true)
      expect(builtin()?.enabled).toBe(true)
      await toggle.click()
      await expect.poll(() => toggle.isChecked()).toBe(false)
      await expect.poll(() => builtin()?.enabled).toBe(false)
      await closeSettings(pluginSettings)
      await market.waitFor({ state: 'hidden' })
      expect(await open.count()).toBe(0)
      await expect.poll(() => new URL(page.url()).searchParams.has('page')).toBe(false)
      expect(activeSkill()).toBe(v2)
      const restoreSettings = await openSettings(page)
      await openSection(restoreSettings, '插件')
      await restoreSettings.locator('.plugin-nav-row', { hasText: '插件市场' }).click()
      await toggle.click()
      await expect.poll(() => toggle.isChecked()).toBe(true)
      await expect.poll(() => builtin()?.enabled).toBe(true)
      await closeSettings(restoreSettings)
      await open.click()
      await market.waitFor()
      if ((await npm.getAttribute('aria-selected')) !== 'true') await npm.click()
      await name.fill(CHECKLIST.name + '@1.0.0')
      await market.getByRole('button', { name: '查找', exact: true }).click()
      await market.getByRole('heading', { name: CHECKLIST.title, exact: true }).waitFor()
      const checklistArtwork = await fallbackArtwork(fallback)
      const checklistIcon = await fallbackIcon(previewIdentity)
      expect(checklistArtwork.tone).not.toBe(updateArtwork.tone)
      expect(checklistArtwork.pattern).not.toBe(updateArtwork.pattern)
      expect(checklistArtwork.texture).toMatch(/gradient/u)
      expect(checklistArtwork.texture).not.toBe(updateArtwork.texture)
      expect(checklistArtwork.background).not.toBe(updateArtwork.background)
      expect(checklistIcon.glyph).not.toBe(firstIcon.glyph)
      expect(checklistIcon.drawing).not.toBe(firstIcon.drawing)
      await capture('npm-checklist-1440-dark')
      await fallback.screenshot({ path: `${OUTPUT}/npm-checklist-cover-1440-dark.png`, animations: 'disabled', scale: 'css' })
      await download.click()
      const checklistRow = downloadedRow(CHECKLIST.title)
      await reachable(checklistRow.getByRole('button', { name: '检查更新', exact: true }))
      expect(await checklistRow.locator('.plugin-market-icon').count()).toBe(0)
      await capture('npm-downloaded-1440-dark')
      await resize(390, 560)
      const npmResults = npmPanel.getByRole('region', { name: '添加插件结果', exact: true })
      await scrollBelowControls(npmResults, [sources, name])
      expect(await npmResults.evaluate(element => element.clientHeight)).toBeGreaterThan(140)
      await capture('npm-scrolled-390-dark')
      await resize(1440, 960)
      await page.reload()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      await market.waitFor()
      if ((await npm.getAttribute('aria-selected')) !== 'true') await npm.click()
      for (const row of [checklistRow, downloadedRow(TITLE)]) {
        await reachable(row.getByRole('button', { name: '检查更新', exact: true }))
        expect(await row.locator('.plugin-market-icon').count()).toBe(0)
      }
    } finally {
      await application?.close()
      await host.close()
    }
  })
})
