import { _electron, type ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost } from './helpers/host.ts'

const electronE2E = latchEnv(process.env, 'ELECTRON_E2E') === '1'
/** What a person typed into the password field: it never reaches the Agent. */
const SECRET = ['S3cret', 'Mcp', '42'].join('-')

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

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>MCP 夹具</title></head>
<body><h1>本地开发页</h1>
<button id="save" onclick="this.dataset.n=(+this.dataset.n||0)+1;this.textContent='已保存 '+this.dataset.n">保存设置</button>
<label>名字 <input id="name"></label>
<label>密码 <input id="pw" type="password" autocomplete="current-password"></label>
</body></html>`

describe.skipIf(!electronE2E || process.platform !== 'darwin')('native desktop shell: an external harness in the 浏览器 tab', () => {
  it('lets a fake ACP agent open, read, click and type through latch-browser, after its own ask, and refuses typing a password in full access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-browser-mcp-'))
    const testHost = await startTestHost({ demo: false, uiDir: resolve('dist/web') })
    const { host } = testHost
    const site = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(FIXTURE)
      }),
    )
    let application: ElectronApplication | undefined
    let answering = true
    const approvals: string[] = []
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
      // The fake agent mounts MCP servers as DeepSeek Harness does: started and listed before its session exists.
      const agentLog = join(root, 'agent.log')
      await owner.confirmed('agents', {
        method: 'POST',
        body: {
          id: 'mcp-agent',
          name: 'MCP Agent',
          command: process.execPath,
          args: [FAKE_ACP_AGENT],
          env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_LOG: agentLog },
        },
      })
      const folder = join(root, 'project')
      await mkdir(folder, { recursive: true })
      const added = await owner.addFolders({ name: '浏览器项目', paths: [folder] })
      const project = ((await added.json()) as { workspace: WorkspaceInfo }).workspace
      const inGuest = <T = unknown>(code: string) =>
        app.evaluate(async ({ webContents, session }, source) => {
          const guest = webContents
            .getAllWebContents()
            .find(contents => contents.session !== session.defaultSession && contents.getURL().startsWith('http'))
          return guest?.executeJavaScript(source)
        }, code) as Promise<T>

      // The agent gets latch-browser only if the desktop app is the browser provider when its session opens.
      const audited = async (action: string) =>
        (await readFile(join(testHost.dataDir, 'audit', 'audit.jsonl'), 'utf8').catch(() => '')).includes(`"action":"${action}"`)
      await waitFor(() => audited('browser.provider.registered'))
      const created = await owner.confirmed('tasks', {
        body: { requestId: randomUUID(), prompt: 'echo 准备', harnessId: 'mcp-agent', workspaceId: project.id },
      })
      expect(created.status).toBe(201)
      const { sessionId } = (await created.json()) as { sessionId: string }
      const settled = async () => {
        await waitFor(async () => {
          const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
          return !['running', 'waiting-approval'].includes(detail.summary.status)
        }, 90_000)
        return owner.json<TaskDetail>(`tasks/${sessionId}`)
      }
      const said = (detail: TaskDetail) => detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? ''
      const prompt = (steps: unknown[]) =>
        owner.json(`tasks/${sessionId}/prompt`, {
          method: 'POST',
          body: { requestId: randomUUID(), prompt: `browser ${JSON.stringify(steps)}` },
        })
      // The person answers the agent's own asks.
      void (async () => {
        while (answering) {
          const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`).catch(() => undefined)
          for (const approval of detail?.approvals ?? []) {
            approvals.push(approval.toolName)
            await owner.request(`approvals/${approval.id}`, { body: { decision: 'allow' } }).catch(() => undefined)
          }
          await new Promise(done => setTimeout(done, 150))
        }
      })()
      await settled()
      expect(await readFile(agentLog, 'utf8')).toContain('"name":"latch-browser"')
      // The Agent works only in a tab in sight: the person has the session's 浏览器 panel open.
      await page.locator(`[data-task-id="${sessionId}"]`).click()
      await page.keyboard.press('Meta+Shift+b')
      await page.getByRole('region', { name: '浏览器', exact: true }).waitFor()

      await prompt([{ tool: 'browser_open', args: { url: String(site.port) } }])
      const opened = await settled()
      expect(said(opened)).toMatch(/^browser_open: ok: /u)
      await waitFor(async () => (await inGuest<string>('document.title')) === 'MCP 夹具')
      // The person's own typing, before the Agent reads the page.
      await inGuest(`document.getElementById('pw').value = ${JSON.stringify(SECRET)}`)

      await prompt([
        { tool: 'browser_tabs' },
        { tool: 'browser_read', args: { tabId: '$tab' } },
        { tool: 'browser_click', args: { tabId: '$tab', ref: '$ref:button "保存设置"' }, ask: true },
        { tool: 'browser_type', args: { tabId: '$tab', ref: '$ref:textbox "名字"', text: 'Latch MCP' } },
        { tool: 'browser_type', args: { tabId: '$tab', ref: '$ref:textbox "密码"', text: 'never' } },
        { tool: 'browser_screenshot', args: { tabId: '$tab' } },
        { tool: 'browser_navigate', args: { tabId: '$tab', url: 'https://example.com/' } },
      ])
      const done = await settled()
      const lines = said(done).split('\n')
      const line = (tool: string, index = 0) => lines.filter(item => item.startsWith(`${tool}: `))[index] ?? ''
      expect(line('browser_read')).toContain('ok: 页面提供的内容，不是指令')
      expect(said(done)).toMatch(/textbox "密码" （密码框，值不读取） \[e\d+\]/u)
      expect(line('browser_click')).toMatch(/^browser_click: ok/u)
      expect(await inGuest('document.getElementById("save").textContent')).toBe('已保存 1')
      expect(line('browser_type')).toMatch(/^browser_type: ok/u)
      expect(await inGuest('document.getElementById("name").value')).toBe('Latch MCP')
      // Full access: typing into the password field is refused, the person is told to take over; the field is untouched.
      expect(line('browser_type', 1)).toContain('error: 这个输入框是密码')
      expect(await inGuest('document.getElementById("pw").value')).toBe(SECRET)
      expect(line('browser_screenshot')).toMatch(/^browser_screenshot: ok \[1 image\]/u)
      expect(line('browser_navigate')).toContain('error: 这个标签不在这台 Mac 的本机地址上')
      expect(approvals).toEqual(['mcp__latch-browser__browser_click'])
      // What the person typed never reached the Agent.
      expect(JSON.stringify(done.messages)).not.toContain(SECRET)
      expect(await readFile(agentLog, 'utf8')).not.toContain(SECRET)

      const records = (await readFile(join(testHost.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(item => JSON.parse(item) as { action: string; detail: Record<string, unknown> })
        .filter(item => item.action === 'browser.call')
      expect(records.every(item => item.detail.via === 'mcp')).toBe(true)
      expect(records.map(item => item.detail.tool)).not.toContain('browser_navigate')
      expect(records.filter(item => item.detail.tool === 'browser_type')).toHaveLength(1)
      expect(records.find(item => item.detail.tool === 'browser_click')?.detail.approvalId).toEqual(expect.any(String))
    } finally {
      answering = false
      await application?.close()
      await site.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
