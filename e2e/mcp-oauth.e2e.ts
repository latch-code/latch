import { chromium, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot, McpHttpServerView, McpServersResponse } from '@latch/protocol'
import { startFakeMcpHttp, startFakeOAuth, type FakeOAuth, type FakeOAuthOptions, type TestDevice } from '@latch/testkit'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { backToSection, noHorizontalOverflow, openSection, openSettings } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'

const SHOTS = resolve('test-results/mcp-oauth')
/** Captured at rest: a page that is fading or sliding in is shown as it ends. */
const STILL = { animations: 'disabled', caret: 'hide' } as const

/** A page that is this Mac's desktop app as far as the client can tell; its MCP requests go over host.sock. */
async function asDesktop(page: Page, desktop: TestDevice): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'latchShell', { value: { kind: 'electron', devMode: false, platform: 'darwin' } })
  })
  await page.route('**/link/api/snapshot', async route => {
    const response = await route.fetch()
    const snapshot: AppSnapshot = await response.json()
    await route.fulfill({ response, json: { ...snapshot, device: { ...snapshot.device, listener: 'unix' } } })
  })
  await page.route('**/link/api/mcp/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const answer = await desktop.confirmed(`${url.pathname.replace('/link/api/', '')}${url.search}`, {
      method: request.method(),
      ...(request.postData() ? { body: request.postDataJSON() } : {}),
    })
    await route.fulfill({ status: answer.status, contentType: 'application/json', body: await answer.text() })
  })
  await page.reload()
  await connected(page)
}

describe('a remote MCP server’s login, end to end', () => {
  it('logs in from 设置 › MCP on this Mac through the browser, and shows every state at three widths in light and dark', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-mcp-oauth-e2e-'))
    const uiDir = resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web')
    const closers: Array<() => Promise<void>> = []
    const browser = await chromium.launch(browserLaunchOptions())
    let testHost: TestHost | undefined
    try {
      await mkdir(SHOTS, { recursive: true })
      const authorizer = async (options: FakeOAuthOptions = {}) => {
        const auth = await startFakeOAuth(options)
        closers.push(() => auth.close())
        return auth
      }
      const good = await authorizer()
      const stale = await authorizer({ refreshFails: true })
      const impostor = await authorizer({ iss: 'wrong' })
      const host = await startTestHost({ demo: false, uiDir, dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace') })
      testHost = host
      const desktop = await host.enroll({ listener: 'unix', name: '本机桌面端' })
      const add = async (name: string, auth: FakeOAuth) => {
        const mcp = await startFakeMcpHttp({ protect: { issuer: auth.issuer, valid: token => auth.valid(token), scopes: ['docs.read'] } })
        closers.push(() => mcp.close())
        const { server } = await desktop.confirmedJson<{ server: McpHttpServerView }>('mcp/servers', {
          body: {
            requestId: randomUUID(),
            baseRevision: (await desktop.json<McpServersResponse>('mcp/servers')).revision,
            transport: 'http',
            name,
            url: mcp.url,
            headers: {},
            scope: { all: true, agents: [], projects: [] },
          },
        })
        // 测试 is how the server first says it wants a login.
        await desktop.json(`mcp/servers/${server.id}/test`, { body: { requestId: randomUUID() } })
        return { id: server.id, auth }
      }
      const begin = (id: string) =>
        desktop.confirmedJson<{ authorizationUrl: string }>(`mcp/servers/${id}/oauth/login`, { body: { requestId: randomUUID() } })
      const stateOf = async (id: string) =>
        (await desktop.json<McpServersResponse>('mcp/servers')).servers.flatMap(server =>
          server.id === id && server.transport === 'http' ? [server.oauth?.state] : [],
        )[0]

      // Five servers, one for each state a person sees.
      const docs = await add('docs', good) // 未登录, then logged in through the page below
      await add('tickets', good) // stays 未登录
      const design = await add('design', good) // 登录中
      const errors = await add('errors', stale) // 需要重新登录
      const issues = await add('issues', impostor) // 登录失败
      await begin(design.id)
      await fetch(await stale.authorize((await begin(errors.id)).authorizationUrl))
      await expect.poll(() => stateOf(errors.id)).toBe('signed-in')
      stale.expireAccess()
      await desktop.json(`mcp/servers/${errors.id}/test`, { body: { requestId: randomUUID() } })
      await expect.poll(() => stateOf(errors.id)).toBe('relogin')
      await fetch(await impostor.authorize((await begin(issues.id)).authorizationUrl))
      await expect.poll(() => stateOf(issues.id)).toBe('failed')
      // 退出登录 while this Mac cannot delete the tokens: said as it is, with 重试.
      const archive = await add('archive', good)
      await fetch(await good.authorize((await begin(archive.id)).authorizationUrl))
      await expect.poll(() => stateOf(archive.id)).toBe('signed-in')
      await chmod(join(root, 'data', 'mcp'), 0o500)
      const stuck = await desktop.json<{ oauth: string }>(`mcp/servers/${archive.id}/oauth/logout`, { body: { requestId: randomUUID() } })
      await chmod(join(root, 'data', 'mcp'), 0o700)
      expect(stuck.oauth).toBe('undeleted')

      // Another computer's browser sees how each login stands, and has nothing to log in with.
      const far = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
      far.setDefaultTimeout(15_000)
      const farPage = await far.newPage()
      await enrollBrowser(farPage, host, { name: '另一台电脑', scopes: ['view', 'run', 'approve:standard', 'admin'] })
      const farSettings = await openSettings(farPage)
      await openSection(farSettings, 'MCP')
      await expect.poll(() => farSettings.locator('[data-mcp-server="tickets"]').textContent()).toContain('未登录')
      await expect.poll(() => farSettings.locator('[data-mcp-server="design"]').textContent()).toContain('登录中')
      await expect.poll(() => farSettings.locator('[data-mcp-server="errors"]').textContent()).toContain('需要重新登录')
      await expect.poll(() => farSettings.locator('[data-mcp-server="issues"]').textContent()).toContain('登录失败')
      await farSettings.getByRole('button', { name: '打开 tickets', exact: true }).click()
      await farSettings.locator('.mcp-login').getByText('未登录', { exact: true }).waitFor()
      expect(await farSettings.getByRole('button', { name: '登录', exact: true }).count()).toBe(0)
      await far.close()

      // On this Mac: 登录, the confirmation, the person's own click to the browser, and back.
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
      context.setDefaultTimeout(15_000)
      const page = await context.newPage()
      await enrollBrowser(page, host, { name: 'MCP 电脑', scopes: ['view', 'run', 'approve:standard', 'admin'] })
      await asDesktop(page, desktop)
      const settings = await openSettings(page)
      await openSection(settings, 'MCP')
      await settings.getByRole('button', { name: '打开 docs', exact: true }).click()
      const login = settings.locator('.mcp-login')
      await login.getByText('未登录', { exact: true }).waitFor()
      const confirmations = host.presence.requests.length
      await settings.getByRole('button', { name: '登录', exact: true }).click()
      await login.getByText('登录中', { exact: true }).waitFor()
      expect(host.presence.requests.length).toBe(confirmations + 1)
      expect(host.presence.requests.at(-1)?.preview.action).toBe('mcp.server.apply')
      await page.screenshot({ path: join(SHOTS, 'page-signing-in-with-open--light--1440.png'), ...STILL })
      const [popup] = await Promise.all([
        context.waitForEvent('page'),
        settings.getByRole('button', { name: '在浏览器中打开', exact: true }).click(),
      ])
      // The browser ends on the Host's own listener, which says one fixed thing.
      await popup.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{22}\/callback\?/u)
      await expect.poll(() => popup.locator('body').textContent()).toBe('可以关闭这个页面，回到 Latch。')
      await popup.close()
      await login.getByText('已登录', { exact: true }).waitFor()
      await expect.poll(() => login.textContent()).toContain('到期')
      await settings.getByRole('button', { name: '退出登录', exact: true }).waitFor()
      // The token is on this Mac's disk and nowhere in the page.
      const kept = await readFile(join(root, 'data', 'mcp', 'secrets.json'), 'utf8')
      const html = await page.content()
      for (const token of good.issued) {
        expect(kept.includes(token) || !good.valid(token)).toBe(true)
        expect(html).not.toContain(token)
      }
      expect(html).not.toMatch(/fake-(?:access|refresh|code)-/u)
      // 测试 now reaches the server with the login.
      await settings.getByRole('button', { name: '测试', exact: true }).click()
      await expect.poll(() => settings.locator('.mcp-heading').textContent()).toContain('可用 · 3 个工具')
      await context.close()
      expect(await stateOf(docs.id)).toBe('signed-in')

      // Every state, in the list and on its own page, at three widths, light and dark.
      const states: Array<[string, string, string]> = [
        ['tickets', 'signed-out', '未登录'],
        ['design', 'signing-in', '登录中'],
        ['docs', 'signed-in', '已登录'],
        ['errors', 'relogin', '需要重新登录'],
        ['issues', 'failed', '登录失败'],
        ['archive', 'undeleted', '没能删除这台 Mac 上的登录'],
      ]
      for (const scheme of ['light', 'dark'] as const)
        for (const [width, height] of [
          [1440, 900],
          [768, 1024],
          [390, 844],
        ] as const) {
          const sized = await browser.newContext({
            viewport: { width, height },
            colorScheme: scheme,
            locale: 'zh-CN',
            reducedMotion: 'reduce',
          })
          sized.setDefaultTimeout(15_000)
          // Pages push over one another on a phone: captured at rest, never mid-way.
          await stillMotion(sized)
          const view = await sized.newPage()
          await enrollBrowser(view, host, { name: `MCP ${scheme} ${width}`, scopes: ['view', 'run', 'approve:standard', 'admin'] })
          await asDesktop(view, desktop)
          const pane = await openSettings(view)
          await openSection(pane, 'MCP')
          await pane.locator('[data-mcp-server="issues"]').waitFor()
          await noHorizontalOverflow(view)
          await view.screenshot({ path: join(SHOTS, `list--${scheme}--${width}.png`), ...STILL })
          for (const [name, state, word] of states) {
            await pane.getByRole('button', { name: `打开 ${name}`, exact: true }).click()
            await pane.locator('.mcp-login').getByText(word, { exact: true }).waitFor()
            if (state === 'undeleted') await pane.getByRole('button', { name: '重试', exact: true }).waitFor()
            await expect.poll(() => pane.locator('.settings-level[data-state="leaving"]').count()).toBe(0)
            await noHorizontalOverflow(view)
            await view.screenshot({ path: join(SHOTS, `page-${state}--${scheme}--${width}.png`), ...STILL })
            await backToSection(pane)
            await pane.locator('[data-mcp-server="issues"]').waitFor()
          }
          await sized.close()
        }
    } finally {
      await browser.close()
      await testHost?.close()
      for (const close of closers.reverse()) await close().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})
