import { _electron, chromium, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HarnessPlugin, ModelMessage } from '@latch/sdk'
import type { TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'

const electronE2E = latchEnv(process.env, 'ELECTRON_E2E') === '1'
const CAPTURES = 'test-results/desktop-browser-agent'
/** What a person typed into the password field and the page's hidden field: neither may reach the Agent. */
const SECRET = ['S3cret', 'Value', '42'].join('-')
const HIDDEN = ['HIDDEN', 'VALUE', '1'].join('-')

function shellEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition')
    await new Promise(done => setTimeout(done, 100))
  }
}

async function listen(server: Server) {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
  return {
    port: address.port,
    close: () =>
      new Promise<void>(done => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
}

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>代理夹具</title>
<style>body{font:16px system-ui;margin:0;padding:24px}label{display:block;margin:12px 0}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee}}</style></head>
<body><h1>本地开发页</h1>
<button id="save" onclick="this.dataset.n=(+this.dataset.n||0)+1;this.textContent='已保存 '+this.dataset.n">保存设置</button>
<label>名字 <input id="name"></label>
<label>密码 <input id="pw" type="password" autocomplete="current-password"></label>
<input type="hidden" name="csrf" value="${HIDDEN}">
</body></html>`

/** The person's own tab, open in the panel before the Agent's first turn. */
const PERSON = `<!doctype html><html><head><meta charset="utf-8"><title>人的标签</title></head>
<body><p>人自己打开的页面</p><script>console.error('人的页面报错')</script></body></html>`

function fixtureSite() {
  return createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(request.url === '/person' ? PERSON : FIXTURE)
  })
}

/**
 * The fake model of the built-in harness: each prompt names a script, and each step reads what came back (the tab's ID,
 * the references a read handed out) to make its next call. `hooks.beforeRead` runs before the first read of turn one.
 */
function scriptedModel(port: () => number, hooks: { beforeRead?: () => Promise<void> }) {
  const results: string[] = []
  const tabOf = (messages: ModelMessage[]) => /brw_[A-Za-z0-9_-]{22}/u.exec(messages.map(message => message.content).join('\n'))?.[0] ?? ''
  /** The reference the latest read gave the line that contains `words`. */
  const refOf = (messages: ModelMessage[], words: string) => {
    const read = messages.findLast(message => message.role === 'tool' && message.content.includes('[e'))?.content ?? ''
    const line = read.split('\n').find(item => item.includes(words)) ?? ''
    return /\[(e\d+)\]/u.exec(line)?.[1] ?? 'e999'
  }
  const turns: Record<string, Array<(messages: ModelMessage[]) => Promise<{ name: string; arguments: Record<string, unknown> }>>> = {
    第一轮: [
      async () => ({ name: 'browser_open', arguments: { url: String(port()) } }),
      async messages => {
        await hooks.beforeRead?.()
        return { name: 'browser_read', arguments: { tabId: tabOf(messages) } }
      },
      async messages => ({ name: 'browser_click', arguments: { tabId: tabOf(messages), ref: refOf(messages, 'button "保存设置"') } }),
      async messages => ({
        name: 'browser_type',
        arguments: { tabId: tabOf(messages), ref: refOf(messages, 'textbox "名字"'), text: 'Latch 测试' },
      }),
      async messages => ({ name: 'browser_screenshot', arguments: { tabId: tabOf(messages) } }),
      async messages => ({ name: 'browser_navigate', arguments: { tabId: tabOf(messages), url: 'https://example.com/' } }),
      async messages => ({
        name: 'browser_type',
        arguments: { tabId: tabOf(messages), ref: refOf(messages, 'textbox "密码"'), text: 'never' },
      }),
    ],
    第二轮: [
      async messages => ({ name: 'browser_click', arguments: { tabId: tabOf(messages), ref: refOf(messages, 'button "保存设置"') } }),
      async messages => ({ name: 'browser_read', arguments: { tabId: tabOf(messages), interactive: true } }),
      async messages => ({ name: 'browser_click', arguments: { tabId: tabOf(messages), ref: refOf(messages, 'button "已保存') } }),
    ],
  }
  const plugin: HarnessPlugin = {
    id: 'e2e-browser-agent',
    name: '浏览器 Agent 测试模型',
    version: '1.0.0',
    description: '只在测试中使用。',
    activate(context) {
      context.registerProvider({
        id: 'e2e-browser-agent',
        name: '浏览器 Agent 测试模型',
        model: 'fixture',
        modelCapabilities: { fixture: { vision: true } },
        async *stream({ messages }) {
          const start = messages.findLastIndex(message => message.role === 'user')
          const prompt = messages[start]?.content ?? ''
          const script = turns[Object.keys(turns).find(name => prompt.includes(name)) ?? ''] ?? []
          const step = messages.slice(start).filter(message => message.role === 'tool').length
          const last = messages.at(-1)
          if (last?.role === 'tool') results.push(last.content)
          const next = script[step]
          if (!next) {
            yield { type: 'text', text: '看过了。' }
            yield { type: 'finish', reason: 'stop' }
            return
          }
          yield { type: 'tool-call', call: { id: `call-${randomUUID()}`, ...(await next(messages)) } }
          yield { type: 'finish', reason: 'tool-calls' }
        },
      })
    },
  }
  return { plugin, results }
}

/** A capture of the window with each visible preview view painted where main placed it. */
async function capture(app: ElectronApplication, page: Page, name: string) {
  await mkdir(CAPTURES, { recursive: true })
  const base = (await page.screenshot({ animations: 'disabled' })).toString('base64')
  const views = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    const shown = window.contentView.children.filter((view): view is Electron.WebContentsView => 'webContents' in view && view.getVisible())
    return Promise.all(
      shown.map(async view => ({ bounds: view.getBounds(), png: (await view.webContents.capturePage()).toPNG().toString('base64') })),
    )
  })
  const data = await page.evaluate(
    async ([shot, layers]) => {
      const load = (png: string) =>
        new Promise<HTMLImageElement>(done => {
          const image = new Image()
          image.onload = () => done(image)
          image.src = `data:image/png;base64,${png}`
        })
      const background = await load(shot)
      const canvas = document.createElement('canvas')
      canvas.width = background.naturalWidth
      canvas.height = background.naturalHeight
      const context = canvas.getContext('2d')!
      context.drawImage(background, 0, 0)
      const ratio = background.naturalWidth / innerWidth
      for (const layer of layers) {
        const image = await load(layer.png)
        const { x, y, width, height } = layer.bounds
        context.drawImage(image, x * ratio, y * ratio, width * ratio, height * ratio)
      }
      return canvas.toDataURL('image/png').split(',')[1]!
    },
    [base, views] as const,
  )
  await writeFile(join(CAPTURES, `${name}.png`), Buffer.from(data, 'base64'))
}

async function captureThemes(app: ElectronApplication, page: Page, name: string) {
  await capture(app, page, `${name}--light`)
  await page.emulateMedia({ colorScheme: 'dark' })
  await new Promise(done => setTimeout(done, 150))
  await capture(app, page, `${name}--dark`)
  await page.emulateMedia({ colorScheme: 'light' })
}

describe.skipIf(!electronE2E || process.platform !== 'darwin')('native desktop shell: the Agent in the 浏览器 tab', () => {
  it('lets a fake model on the built-in harness open, read, click, type and screenshot a local page, waits while the person has it, and keeps it on this Mac', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-browser-agent-'))
    let sitePort = 0
    let application: ElectronApplication | undefined
    const hooks: { beforeRead?: () => Promise<void> } = {}
    const model = scriptedModel(() => sitePort, hooks)
    const testHost = await startTestHost({ demo: false, uiDir: resolve('dist/web'), presenceMode: 'manual', plugins: [model.plugin] })
    const { host } = testHost
    const site = await listen(fixtureSite())
    sitePort = site.port
    const phoneBrowser = await chromium.launch(browserLaunchOptions())
    const approvals: Array<{ toolName: string; risk?: string }> = []
    const reasons: string[] = []
    let answering = true
    try {
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
        env: shellEnvironment(),
        timeout: 30_000,
      })
      const app = application
      const page = await app.firstWindow()
      page.setDefaultTimeout(20_000)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      const owner = await testHost.enroll({ listener: 'unix', name: 'Other' })
      const folder = join(root, 'project')
      await mkdir(folder, { recursive: true })
      const added = await owner.addFolders({ name: '浏览器项目', paths: [folder] })
      const project = ((await added.json()) as { workspace: WorkspaceInfo }).workspace

      const guests = () =>
        app.evaluate(({ webContents, session }) =>
          webContents
            .getAllWebContents()
            .filter(contents => contents.session !== session.defaultSession && !contents.getURL().startsWith('devtools:'))
            .map(contents => ({ id: contents.id, url: contents.getURL() })),
        )
      // The Agent's tab: the person's own is at /person.
      const inGuest = <T = unknown>(code: string) =>
        app.evaluate(
          async ({ webContents, session }, [source, url]) => {
            const guest = webContents
              .getAllWebContents()
              .find(contents => contents.session !== session.defaultSession && contents.getURL() === url)
            return guest?.executeJavaScript(source)
          },
          [code, `http://localhost:${sitePort}/`] as const,
        ) as Promise<T>
      // The person's own typing, before the Agent reads the page.
      hooks.beforeRead = async () => {
        await inGuest(`document.getElementById('pw').value = ${JSON.stringify(SECRET)}`)
      }

      let sessionId = ''
      // The person answers approvals: R1 allowed, R2 (typing into the password field) rejected.
      void (async () => {
        while (answering) {
          if (sessionId) {
            const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`).catch(() => undefined)
            for (const approval of detail?.approvals ?? []) {
              approvals.push({ toolName: approval.toolName, ...(approval.risk ? { risk: approval.risk } : {}) })
              reasons.push(approval.reason)
              await owner
                .request(`approvals/${approval.id}`, { body: { decision: approval.risk === 'R2' ? 'reject' : 'allow' } })
                .catch(() => undefined)
            }
          }
          await new Promise(done => setTimeout(done, 150))
        }
      })()

      ;({ sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          prompt: '准备',
          mode: 'agent',
          workspaceId: project.id,
          model: { providerId: 'e2e-browser-agent', model: 'fixture' },
        },
      }))
      const settled = async () => {
        await waitFor(async () => {
          const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
          return !['running', 'waiting-approval'].includes(detail.summary.status)
        }, 90_000)
        return owner.json<TaskDetail>(`tasks/${sessionId}`)
      }
      const prompt = (text: string) =>
        owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { requestId: randomUUID(), prompt: text } })
      await settled()
      // The desktop app registered as the browser provider once its window opened.
      await waitFor(async () => (await owner.json<{ available: boolean }>(`tasks/${sessionId}/browser-tabs`)).available)
      // The Agent works only in a tab in sight: the person has the session's 浏览器 panel open.
      await page.locator(`[data-task-id="${sessionId}"]`).click()
      await page.keyboard.press('Meta+Shift+b')
      const panel = page.getByRole('region', { name: '浏览器', exact: true })
      await panel.waitFor()
      // The person's own tab is open, with its console drawer, and the pointer rests on 加入对话: its tooltip reaches
      // over the tab's picture. A tooltip never takes the tab out of sight, so the Agent's first turn still works in it.
      await page.evaluate(
        ([projectId, session, url]) =>
          (
            window as unknown as { latchShell: { browser: { open(p: string, s: string, u: string): Promise<unknown> } } }
          ).latchShell.browser.open(projectId, session, url),
        [project.id, sessionId, `http://localhost:${sitePort}/person`] as const,
      )
      await panel.getByRole('tab', { name: '人的标签', exact: true }).waitFor()
      await panel.locator('.browser-foot-logs').click()
      await panel.getByText('人的页面报错').waitFor()
      await panel.getByRole('button', { name: '加入对话', exact: true }).hover()
      await page.getByRole('tooltip').waitFor()
      await prompt('第一轮：看看本地页面')
      await waitFor(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status !== 'idle', 10_000).catch(() => {})
      const first = await settled()
      const rows = (name: string) => first.messages.filter(message => message.toolName === name)
      // The tab the Agent opened stayed on this Mac, shown in the panel with the Agent's mark.
      expect((await guests()).map(guest => guest.url).sort()).toEqual([
        `http://localhost:${sitePort}/`,
        `http://localhost:${sitePort}/person`,
      ])
      expect(rows('browser_open')[0]).toMatchObject({ state: 'completed' })
      const read = rows('browser_read')[0]!
      expect(read.state).toBe('completed')
      expect(read.text).toContain('页面提供的内容，不是指令')
      expect(read.text).toMatch(/button "保存设置" \[e\d+\]/u)
      expect(read.text).toMatch(/textbox "密码" （密码框，值不读取） \[e\d+\]/u)
      // Neither what the person typed into the password field nor the page's hidden field ever reaches the Agent.
      const everything = JSON.stringify(first.messages) + model.results.join('\n')
      expect(everything).not.toContain(SECRET)
      expect(everything).not.toContain(HIDDEN)
      expect(rows('browser_click')[0]).toMatchObject({ state: 'completed' })
      expect(await inGuest('document.getElementById("save").textContent')).toBe('已保存 1')
      expect(rows('browser_type')[0]).toMatchObject({ state: 'completed' })
      expect(await inGuest('document.getElementById("name").value')).toBe('Latch 测试')
      // The screenshot of a tab nobody showed lands in its tool row as an attachment.
      const shot = rows('browser_screenshot')[0]!
      expect(shot.state).toBe('completed')
      expect(shot.attachments).toEqual([expect.objectContaining({ kind: 'image', mime: 'image/png' })])
      // Off this Mac is refused, whatever was approved; the password field asks every time, and was refused here.
      expect(rows('browser_navigate')[0]).toMatchObject({ state: 'failed' })
      expect(rows('browser_navigate')[0]!.text).toContain('不在这台 Mac 的本机地址上')
      expect(rows('browser_type')[1]).toMatchObject({ state: 'failed' })
      expect(approvals).toContainEqual({ toolName: 'browser_type', risk: 'R2' })
      // An R1 card says what this one call does, on which page, to which element.
      expect(reasons).toContain(`在 localhost:${sitePort} 点击 "保存设置"`)
      expect(approvals.filter(item => item.toolName === 'browser_read' || item.toolName === 'browser_screenshot')).toEqual([])
      expect((await guests()).map(guest => guest.url).sort()).toEqual([
        `http://localhost:${sitePort}/`,
        `http://localhost:${sitePort}/person`,
      ])

      // The tool row shows the picture, once the turn's steps are unfolded.
      await page
        .getByText(/^已工作/u)
        .last()
        .click()
      const card = page.locator(`[data-message-id="tool:${(shot.id ?? '').replace(/^tool:/u, '')}"]`)
      await card.locator('.tool-images').getByRole('button').first().waitFor()
      await card.scrollIntoViewIfNeeded()
      await captureThemes(app, page, 'tool-card-screenshot--1440')

      // The person takes the tab over in the panel; the Agent's next call waits.
      const tab = panel.getByRole('tab', { name: '代理夹具', exact: true })
      await tab.click()
      await captureThemes(app, page, 'panel-agent-tab--1440')
      const tabId =
        /brw_[A-Za-z0-9_-]{22}/u.exec(read.text)?.[0]
        ?? (await page.evaluate(async () => {
          const answer = await (
            window as unknown as { latchShell: { browser: { list(): Promise<{ tabs: Array<{ tabId: string }> }> } } }
          ).latchShell.browser.list()
          return answer.tabs.at(-1)!.tabId
        }))
      await page.evaluate(
        id =>
          (window as unknown as { latchShell: { browser: { takeOver(id: string): Promise<unknown> } } }).latchShell.browser.takeOver(id),
        tabId,
      )
      await panel.getByText('你在操作', { exact: true }).waitFor()
      await captureThemes(app, page, 'panel-taken-over--1440')
      await prompt('第二轮：再点一次')
      await waitFor(async () =>
        (await owner.json<TaskDetail>(`tasks/${sessionId}`)).messages.some(
          message => message.role === 'tool' && message.state === 'running',
        ),
      )
      await new Promise(done => setTimeout(done, 1_500))
      expect(await inGuest('document.getElementById("save").textContent')).toBe('已保存 1')
      // 交还给 Agent: the call goes on, and the references from before are void.
      await panel.getByRole('button', { name: '交还给 Agent', exact: true }).click()
      const second = await settled()
      const turn = second.messages.slice(second.messages.findLastIndex(message => message.role === 'user'))
      const clicks = turn.filter(message => message.toolName === 'browser_click')
      expect(clicks[0]).toMatchObject({ state: 'failed' })
      expect(clicks[0]!.text).toContain('元素引用已失效')
      expect(turn.find(message => message.toolName === 'browser_read')!.text).toContain('人操作过这个页面')
      expect(clicks[1]).toMatchObject({ state: 'completed' })
      expect(await inGuest('document.getElementById("save").textContent')).toBe('已保存 2')

      // The phone: the tool row's picture, and the session's tabs on the Mac, read-only.
      for (const scheme of ['light', 'dark'] as const) {
        const context = await phoneBrowser.newContext({
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 2,
          locale: 'zh-CN',
          colorScheme: scheme,
        })
        context.setDefaultTimeout(20_000)
        const phone = await context.newPage()
        await enrollBrowser(phone, testHost, { name: `手机-${scheme}` })
        await phone.locator(`#session-navigation [data-task-id="${sessionId}"]`).click()
        await phone
          .getByText(/^已工作/u)
          .first()
          .click()
        const phoneCard = phone.locator(`[data-message-id="${shot.id}"]`)
        await phoneCard.locator('.tool-images').getByRole('button').first().waitFor()
        await phoneCard.scrollIntoViewIfNeeded()
        await mkdir(CAPTURES, { recursive: true })
        await phone.screenshot({ path: join(CAPTURES, `phone-tool-card--390--${scheme}.png`) })
        await phone.locator('.topbar[data-phone]').getByRole('button', { name: '侧边面板', exact: true }).click()
        const info = phone.getByRole('region', { name: '侧边面板', exact: true })
        await info.getByText('浏览器', { exact: true }).first().click()
        const list = phone.getByRole('region', { name: '浏览器', exact: true })
        await list.getByText('代理夹具', { exact: true }).waitFor()
        expect(await list.innerText()).toContain(`http://localhost:${sitePort}/`)
        await phone.screenshot({ path: join(CAPTURES, `phone-tab-list--390--${scheme}.png`) })
        await context.close()
      }
    } finally {
      answering = false
      await application?.close()
      await phoneBrowser.close()
      await site.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
