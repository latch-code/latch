import { chromium } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot, McpServerView, TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, FAKE_MCP_STDIO, startFakeMcpHttp, startFakeModels, type TestDevice } from '@latch/testkit'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { openSection, openSettings } from './helpers/layout.ts'

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const value = await read()
    if (done(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('timed out')
}

const settled = (device: TestDevice, sessionId: string) =>
  waitFor(
    () => device.json<TaskDetail>(`tasks/${sessionId}`),
    detail => !['running', 'waiting-approval', 'starting'].includes(detail.summary.status),
  )
const said = (detail: TaskDetail) => detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? ''

describe('Latch’s MCP servers, end to end', () => {
  it('adds a local server with the confirmation, tests it, lets an agent call it, and drops it at the next resume once it is switched off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-mcp-e2e-'))
    const dataDir = join(root, 'data')
    const workspaceRoot = join(root, 'workspace')
    const uiDir = resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web')
    const browser = await chromium.launch(browserLaunchOptions())
    // 测试 runs no program from Latch's own directory: the fake server is copied out of it.
    const script = join(root, 'fake-mcp-stdio.mjs')
    await copyFile(FAKE_MCP_STDIO, script)
    let testHost = await startTestHost({ demo: false, uiDir, dataDir, workspaceRoot })
    try {
      const desktop = await testHost.enroll({ listener: 'unix', name: '本机桌面端' })
      await desktop.confirmedJson('agents', {
        body: {
          id: 'mcp-agent',
          name: 'MCP Agent',
          command: process.execPath,
          args: [FAKE_ACP_AGENT],
          env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_CAPS: 'resume', FAKE_ACP_STATE: join(root, 'acp-state.json') },
        },
      })
      // Added on this Mac with the test confirmation backend standing in for Touch ID.
      const before = testHost.presence.requests.length
      const { server } = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', {
        body: {
          requestId: randomUUID(),
          baseRevision: 0,
          name: 'files',
          command: process.execPath,
          args: [script],
          env: {},
          secrets: { API_TOKEN: 'e2e-secret-value-123' },
          projectCwd: false,
          scope: { all: true, agents: [], projects: [] },
        },
      })
      expect(testHost.presence.requests.length).toBe(before + 1)
      expect(testHost.presence.requests.at(-1)?.preview.action).toBe('mcp.server.apply')
      const tested = await desktop.json<{ status: string; tools: string[] }>(`mcp/servers/${server.id}/test`, {
        body: { requestId: randomUUID() },
      })
      expect(tested).toMatchObject({ status: 'ok', tools: ['echo', 'slow', 'env_names', 'where'] })

      // An agent in a session calls one of its tools through latch-mcp.
      const created = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
        body: { prompt: 'mcp files echo {"text":"来自 e2e"}', requestId: randomUUID(), harnessId: 'mcp-agent' },
      })
      expect(said(await settled(desktop, created.sessionId))).toBe('files.echo: ok: echo: 来自 e2e')

      // A browser that manages this Mac sees it in 设置 › MCP, never its secret, and may switch it off.
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', deviceScaleFactor: 1 })
      context.setDefaultTimeout(15_000)
      const page = await context.newPage()
      await enrollBrowser(page, testHost, { name: 'MCP 电脑', scopes: ['view', 'run', 'approve:standard', 'admin'] })
      const settings = await openSettings(page)
      await openSection(settings, 'MCP')
      const row = settings.locator('[data-mcp-server="files"]')
      await row.waitFor()
      await expect.poll(() => row.textContent()).toContain('可用 · 4 个工具')
      expect(await page.content()).not.toContain('e2e-secret-value-123')
      // Only 停用 is offered off this Mac.
      await expect.poll(() => settings.getByRole('button', { name: '添加…', exact: true }).count()).toBe(0)
      await row.getByRole('button', { name: '打开 files', exact: true }).click()
      await settings.getByRole('button', { name: '停用', exact: true }).click()
      // Switching it on again is this Mac's to do.
      await settings.locator('.mcp-heading').getByText('已停用', { exact: true }).waitFor()
      expect(await settings.getByRole('button', { name: '启用', exact: true }).count()).toBe(0)
      expect(await settings.getByRole('button', { name: '移除', exact: true }).count()).toBe(0)
      await context.close()

      // The next resume of the session, on a new agent process, does not get it.
      await testHost.close()
      testHost = await startTestHost({ demo: false, uiDir, dataDir, workspaceRoot })
      const again = await testHost.enroll({ listener: 'unix', name: '本机桌面端' })
      await again.json(`tasks/${created.sessionId}/prompt`, {
        body: { requestId: randomUUID(), prompt: 'mcp files echo {"text":"again"}' },
      })
      expect(said(await settled(again, created.sessionId))).toBe('no MCP server files')
    } finally {
      await browser.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('adds a remote server on this Mac’s loopback with one confirmation, and calls it from an external agent and from the built-in Harness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-mcp-remote-e2e-'))
    const uiDir = resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web')
    const remote = await startFakeMcpHttp({ answer: 'sse', keepHeaders: ['authorization'] })
    const models = await startFakeModels({
      replies: [{ tool: { name: /^mcp__remote__echo_[0-9a-f]{8}$/u, input: { text: '内置' } } }, { text: '内置完成' }],
    })
    const browser = await chromium.launch(browserLaunchOptions())
    const testHost = await startTestHost({ demo: false, uiDir, dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace') })
    try {
      const desktop = await testHost.enroll({ listener: 'unix', name: '本机桌面端' })
      await desktop.confirmedJson('agents', {
        body: {
          id: 'mcp-agent',
          name: 'MCP Agent',
          command: process.execPath,
          args: [FAKE_ACP_AGENT],
          env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_STATE: join(root, 'acp-state.json') },
        },
      })
      // One confirmation: the address, the header's name and the loopback allowance together.
      const before = testHost.presence.requests.length
      const { server } = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', {
        body: {
          requestId: randomUUID(),
          baseRevision: 0,
          transport: 'http',
          name: 'remote',
          url: remote.url,
          headers: { Authorization: 'Bearer e2e-remote-token-123' },
          scope: { all: true, agents: [], projects: [] },
        },
      })
      expect(testHost.presence.requests.length).toBe(before + 1)
      expect(testHost.presence.requests.at(-1)?.preview).toMatchObject({ action: 'mcp.server.apply' })
      expect(testHost.presence.requests.at(-1)?.preview.reason).toContain(new URL(remote.origin).host)

      // An external agent calls it through latch-mcp; the Host is the client.
      const created = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
        body: { prompt: 'mcp remote echo {"text":"外部"}', requestId: randomUUID(), harnessId: 'mcp-agent' },
      })
      expect(said(await settled(desktop, created.sessionId))).toBe('remote.echo: ok: {"text":"外部"}')

      // The built-in Harness gets it as mcp__remote__echo_<hash> and asks every time.
      await desktop.confirmedJson('providers', {
        method: 'POST',
        body: {
          name: 'Fake',
          kind: 'openai-compatible',
          baseURL: `${models.origin}/v1`,
          apiKey: 'e2e-model-key',
          models: ['fake-model'],
          defaultModel: 'fake-model',
          confirmOrigin: true,
        },
      })
      const builtin = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
        body: { prompt: '调用远程工具', requestId: randomUUID(), mode: 'agent', harnessId: 'standard' },
      })
      const approval = await waitFor(
        async () => (await desktop.json<AppSnapshot>('snapshot')).approvals.find(item => item.sessionId === builtin.sessionId),
        found => found !== undefined,
      )
      expect(approval).toMatchObject({
        risk: 'R2',
        riskReason: 'mcp-tool',
        toolName: expect.stringMatching(/^mcp__remote__echo_[0-9a-f]{8}$/u),
      })
      await desktop.json(`approvals/${approval!.id}`, { method: 'POST', body: { decision: 'allow' } })
      expect(said(await settled(desktop, builtin.sessionId))).toBe('内置完成')
      const calls = remote.requests.filter(request => request.rpc === 'tools/call')
      expect(calls).toHaveLength(2)
      expect(calls.every(request => request.headers.authorization === 'Bearer e2e-remote-token-123')).toBe(true)

      // 设置 › MCP shows it with its address and header by name, never the value.
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', deviceScaleFactor: 1 })
      context.setDefaultTimeout(15_000)
      const page = await context.newPage()
      await enrollBrowser(page, testHost, { name: 'MCP 电脑', scopes: ['view', 'run', 'approve:standard', 'admin'] })
      const settings = await openSettings(page)
      await openSection(settings, 'MCP')
      const row = settings.locator('[data-mcp-server="remote"]')
      await row.waitFor()
      await row.getByRole('button', { name: '打开 remote', exact: true }).click()
      await settings.getByText(remote.url, { exact: true }).waitFor()
      await settings.getByText('Authorization', { exact: true }).waitFor()
      expect(await page.content()).not.toContain('e2e-remote-token-123')
      await context.close()
      expect(server.id).toMatch(/^mcp_/u)
    } finally {
      await browser.close()
      await testHost.close()
      await remote.close()
      await models.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
