import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isMcpToolOn,
  type Automation,
  type AutomationDetail,
  type CustomAgent,
  type McpComputerCheck,
  type McpServerView,
  type TaskDetail,
} from '@latch/protocol'
import { createAcpAgentPlugin } from '@latch/harness-acp'
import type { HarnessDriver, HarnessPlugin } from '@latch/sdk'
import { FAKE_ACP_AGENT, writeFakeCuaDriver, type TestDevice } from '@latch/testkit'
import { widens, type McpStdioState } from '../src/mcp.ts'
import { checkComputerDriver, COMPUTER_ENV, COMPUTER_KNOWN_TOOLS, COMPUTER_MINIMUM, COMPUTER_TOOLS_OFF } from '../src/mcp-computer.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'latch-computer-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

const signed = async () => true

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, attempts = 400): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
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
const lastText = (detail: TaskDetail) => detail.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? ''

async function audit(t: TestHost): Promise<Array<{ action: string; detail: Record<string, unknown> }>> {
  return (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
}

describe('「操控这台 Mac」: finding Cua Driver', () => {
  it('says absent, too old, refused or found, from the bundle, the signature and `--version` alone', async () => {
    const root = await folder()
    expect(await checkComputerDriver({ app: join(root, 'missing.app'), verify: signed })).toMatchObject({ state: 'absent' })

    const ok = await writeFakeCuaDriver(join(root, 'ok'), { version: '0.44.0' })
    const found = await checkComputerDriver({ app: ok, verify: signed })
    expect(found).toMatchObject({
      state: 'ok',
      version: '0.44.0',
      minimum: COMPUTER_MINIMUM,
      command: join(ok, 'Contents/MacOS/cua-driver'),
    })
    // The install line is pinned and keeps the installer from connecting agent CLIs, testing, or editing a profile.
    expect(found.install).toMatch(
      /CUA_DRIVER_RS_VERSION=\d+\.\d+\.\d+ CUA_DRIVER_NO_CONNECT=1 CUA_DRIVER_NO_TEST=1 CUA_DRIVER_NO_MODIFY_PATH=1 /u,
    )

    const old = await writeFakeCuaDriver(join(root, 'old'), { version: '0.7.1' })
    expect(await checkComputerDriver({ app: old, verify: signed })).toMatchObject({ state: 'old', version: '0.7.1' })

    // Not signed as Cua Driver: refused before it is run.
    const log = join(root, 'ran')
    const unsigned = await writeFakeCuaDriver(join(root, 'unsigned'))
    await writeFile(join(unsigned, 'Contents/MacOS/cua-driver'), `#!/bin/sh\ntouch '${log}'\necho 'cua-driver 0.44.0'\n`)
    expect(await checkComputerDriver({ app: unsigned, verify: async () => false })).toMatchObject({ state: 'refused', reason: 'signature' })
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' })

    // Anything but `cua-driver <version>` is no version.
    const odd = await writeFakeCuaDriver(join(root, 'odd'), { versionLine: 'something 1.2.3' })
    expect(await checkComputerDriver({ app: odd, verify: signed })).toMatchObject({ state: 'refused', reason: 'version' })

    // The app or its program as a link, or a program others may write: not a regular app.
    const linked = join(root, 'linked.app')
    await symlink(ok, linked)
    expect(await checkComputerDriver({ app: linked, verify: signed })).toMatchObject({ state: 'refused', reason: 'bundle' })
    const swapped = join(root, 'swapped.app', 'Contents', 'MacOS')
    await mkdir(swapped, { recursive: true })
    await symlink(join(ok, 'Contents/MacOS/cua-driver'), join(swapped, 'cua-driver'))
    expect(await checkComputerDriver({ app: join(root, 'swapped.app'), verify: signed })).toMatchObject({
      state: 'refused',
      reason: 'bundle',
    })
    const writable = await writeFakeCuaDriver(join(root, 'writable'))
    await chmod(join(writable, 'Contents/MacOS/cua-driver'), 0o777)
    expect(await checkComputerDriver({ app: writable, verify: signed })).toMatchObject({ state: 'refused', reason: 'bundle' })
  })
})

describe('「操控这台 Mac」: a server that keeps new tools off', () => {
  it('offers a tool only when it is known and not switched off, and counts a tool coming on as widening', () => {
    const server = { disabledTools: ['clipboard_read'], knownTools: ['click', 'clipboard_read'] }
    expect(isMcpToolOn(server, 'click')).toBe(true)
    expect(isMcpToolOn(server, 'clipboard_read')).toBe(false)
    expect(isMcpToolOn(server, 'browser_motion_policy')).toBe(false)
    expect(isMcpToolOn({ disabledTools: [] }, 'anything')).toBe(true)
    const state: McpStdioState = {
      command: '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
      args: ['mcp'],
      env: {},
      secretNames: [],
      projectCwd: false,
      scope: { all: true, agents: [], projects: [] },
      enabled: true,
      disabledTools: [],
      knownTools: ['click'],
      secretHashes: {},
    }
    expect(widens(state, { ...state, knownTools: ['click', 'browser_motion_policy'] })).toBe('use')
    expect(widens(state, { ...state, knownTools: undefined })).toBe('use')
    expect(widens(state, { ...state, disabledTools: ['click'] })).toBe(false)
  })
})

async function computerHost(options: { tools?: string[]; version?: string } = {}) {
  const root = await folder()
  const app = await writeFakeCuaDriver(root, { tools: options.tools ?? [], ...(options.version ? { version: options.version } : {}) })
  const t = await startTestHost({ demo: false, computerDriver: { app, verify: signed } })
  cleanups.push(() => t.close())
  const desktop = await t.enroll({ listener: 'unix' })
  const browser = await t.enroll({ scopes: ['view', 'run', 'admin'] })
  return { t, root, app, desktop, browser }
}

const addBody = () => ({ requestId: randomUUID(), baseRevision: 0, preset: 'computer', scope: { all: false, agents: [], projects: [] } })

describe('「操控这台 Mac」 in 设置 › MCP', () => {
  it('is offered and added only on this Mac, with the Host’s own definition, the confirmation and its record', async () => {
    const { t, app, desktop, browser } = await computerHost()
    // Another device sees neither the preset nor a way to add it.
    expect((await browser.request('mcp/computer')).status).toBe(403)
    expect((await browser.request('mcp/servers', { body: addBody() })).status).toBe(403)
    const check = await desktop.json<McpComputerCheck>('mcp/computer')
    expect(check).toMatchObject({ state: 'ok', version: '0.44.0' })
    expect(check.added).toBeUndefined()

    // The page names nothing about what runs: a command in the body is refused.
    expect((await desktop.request('mcp/servers', { body: { ...addBody(), command: '/bin/sh' } })).status).toBe(400)
    const asked = await desktop.request('mcp/servers', { body: addBody() })
    expect(asked.status).toBe(403)
    const ticket = (await asked.json()).confirmation
    const program = join(app, 'Contents/MacOS/cua-driver')
    expect(ticket).toMatchObject({ action: 'mcp.server.apply', form: 'mcp.server.apply' })
    expect(ticket.reason).toMatch(/^让 Agent 运行 .*CuaDriver\.app\/Contents\/MacOS\/cua-driver（MCP 服务器「computer」）$/u)
    expect(ticket.lines).toContainEqual({ label: '命令', value: program })
    expect(ticket.lines).toContainEqual({ label: '参数', value: 'mcp' })
    expect(ticket.lines).toContainEqual({
      label: '环境变量',
      value: Object.entries(COMPUTER_ENV)
        .map(([key, value]) => `${key}=${value}`)
        .join(' '),
    })
    expect(ticket.lines).toContainEqual({ label: '用在', value: '尚未选择' })

    const before = t.presence.requests.length
    const { server } = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', { body: addBody() })
    expect(t.presence.requests).toHaveLength(before + 1)
    expect(server).toMatchObject({
      name: 'computer',
      transport: 'stdio',
      preset: 'computer',
      command: program,
      args: ['mcp'],
      projectCwd: false,
      scope: { all: false, agents: [], projects: [] },
      disabledTools: [...COMPUTER_TOOLS_OFF],
      knownTools: [...COMPUTER_KNOWN_TOOLS],
    })
    expect(server.transport === 'stdio' && server.env).toEqual(
      Object.entries(COMPUTER_ENV).map(([name, value]) => ({ name, set: true, secret: false, value })),
    )
    // Clipboard, scripts and batches, browser automation and update are off by name.
    for (const tool of [
      'clipboard_read',
      'clipboard_write',
      'run_script',
      'run_steps',
      'launch_app',
      'kill_app',
      'start_recording',
      'set_agent_cursor_enabled',
      'browser_click',
      'page',
      'check_for_update',
    ])
      expect(COMPUTER_TOOLS_OFF).toContain(tool)
    expect((await audit(t)).find(record => record.action === 'mcp.server.added')?.detail).toMatchObject({
      serverId: server.id,
      preset: 'computer',
    })
    expect(await desktop.json<McpComputerCheck>('mcp/computer')).toMatchObject({ added: server.id })
    expect((await desktop.request('mcp/servers', { body: addBody() })).status).toBe(409)
  })

  it('refuses a driver too old, and is not there at all on a Host that names no place for it', async () => {
    const { desktop } = await computerHost({ version: '0.7.1' })
    expect(await desktop.json<McpComputerCheck>('mcp/computer')).toMatchObject({ state: 'old', version: '0.7.1' })
    const refused = await desktop.request('mcp/servers', { body: addBody() })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: 'mcp-computer-old' })

    const plain = await startTestHost({ demo: false })
    cleanups.push(() => plain.close())
    const local = await plain.enroll({ listener: 'unix' })
    expect((await local.request('mcp/computer')).status).toBe(404)
    expect((await local.request('mcp/servers', { body: addBody() })).status).toBe(404)
  })
})

describe('「操控这台 Mac」 in sessions', () => {
  it('keeps new tools off until switched on, and never goes to an automation’s run', async () => {
    const { t, root, desktop } = await computerHost({ tools: ['click', 'clipboard_read'] })
    await desktop.confirmedJson('agents', {
      body: {
        id: 'mcp-agent',
        name: 'MCP Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_STATE: join(root, 'state.json') },
      },
    })
    const added = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', { body: addBody() })
    const used = await desktop.json<{ server: McpServerView }>(`mcp/servers/${added.server.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: added.server.revision, scope: { all: true, agents: [], projects: [] } },
    })

    // The fake lists echo, slow, env_names and where (new to this server), click (known) and clipboard_read (off).
    const { sessionId } = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'mcp-list computer', requestId: randomUUID(), harnessId: 'mcp-agent' },
    })
    expect(lastText(await settled(desktop, sessionId))).toBe('computer tools: click')
    // A tool that is off or new is refused at the Host, never sent.
    for (const tool of ['clipboard_read', 'echo']) {
      await desktop.json(`tasks/${sessionId}/prompt`, { body: { requestId: randomUUID(), prompt: `mcp computer ${tool}` } })
      expect(lastText(await settled(desktop, sessionId))).toMatch(new RegExp(`^computer\\.${tool}: error: `, 'u'))
    }
    await desktop.json(`tasks/${sessionId}/prompt`, { body: { requestId: randomUUID(), prompt: 'mcp computer click' } })
    expect(lastText(await settled(desktop, sessionId))).toBe('computer.click: ok: click: ok')
    const called = (await audit(t)).filter(record => record.action === 'mcp.tool.called' && record.detail.serverId === added.server.id)
    expect(called).toHaveLength(1)

    // Switched on, a new tool joins the known ones: on record, no confirmation.
    const asked = t.presence.requests.length
    const listed = await waitFor(
      () => desktop.json<{ servers: McpServerView[] }>('mcp/servers'),
      list => list.servers[0]?.report?.via === 'session',
    )
    const current = listed.servers[0]!
    expect(current.report?.tools).toContain('echo')
    await desktop.json(`mcp/servers/${current.id}`, {
      method: 'PATCH',
      body: {
        requestId: randomUUID(),
        baseRevision: current.revision,
        knownTools: [...(current.transport === 'stdio' ? (current.knownTools ?? []) : []), 'echo'],
      },
    })
    expect(t.presence.requests).toHaveLength(asked)
    const next = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'mcp-list computer', requestId: randomUUID(), harnessId: 'mcp-agent' },
    })
    expect(lastText(await settled(desktop, next.sessionId))).toBe('computer tools: echo,click')

    // An automation's run of an Agent on the same Harness does not get it, from its very first start.
    const agent = await desktop.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: { requestId: randomUUID(), name: '定时', description: '', harnessId: 'mcp-agent', mode: 'agent', instructions: '', skills: [] },
    })
    const automation = await desktop.json<Automation>('automations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '每天看看',
        customAgentId: agent.id,
        prompt: 'mcp-list computer',
        schedule: { kind: 'daily', time: '09:00' },
        notify: false,
        // A full-access Harness never runs on its own schedule by default; 立即运行 is still a run nobody is in.
        enabled: false,
      },
    })
    await desktop.json(`automations/${automation.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
    const run = await waitFor(
      () => desktop.json<AutomationDetail>(`automations/${automation.id}`),
      detail => detail.automation.lastRun?.state !== undefined && detail.automation.lastRun.state !== 'running',
    )
    const runSession = run.automation.lastRun!.sessionId!
    expect(lastText(await desktop.json<TaskDetail>(`tasks/${runSession}`))).toBe('no MCP server computer')
    // The same Agent in a conversation someone is in does get it.
    const chat = await desktop.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { customAgentId: agent.id, prompt: 'mcp-list computer', requestId: randomUUID() },
    })
    expect(lastText(await settled(desktop, chat.sessionId))).toBe('computer tools: echo,click')
  })

  it('is not given to an automation’s run whose agent starts while the session is still being created', async () => {
    const root = await folder()
    const app = await writeFakeCuaDriver(root, { tools: ['click'] })
    const agentLog = join(root, 'agent.log')
    const starts = async () =>
      (await readFile(agentLog, 'utf8').catch(() => '')).split('\n').filter(line => line.includes('"session/new"')).length
    // A Harness whose createTask returns only once its agent has opened the session (and so taken its MCP servers):
    // the run's record that it is an automation is written after that.
    const holdUntilStarted = (driver: HarnessDriver): HarnessDriver =>
      new Proxy(driver, {
        get(target, key, receiver) {
          if (key !== 'create') return Reflect.get(target, key, receiver)
          return (...args: Parameters<HarnessDriver['create']>) => {
            const bridge = target.create(...args)
            return new Proxy(bridge, {
              get(inner, name, innerReceiver) {
                const value = Reflect.get(inner, name, innerReceiver)
                if (name !== 'createTask' || typeof value !== 'function') return typeof value === 'function' ? value.bind(inner) : value
                return async (...input: unknown[]) => {
                  const before = await starts()
                  const created = await (value as (...a: unknown[]) => Promise<unknown>).apply(inner, input)
                  await waitFor(starts, count => count > before)
                  return created
                }
              },
            })
          }
        },
      })
    const t = await startTestHost({
      demo: false,
      computerDriver: { app, verify: signed },
      agentPlugin: agent => {
        const plugin = createAcpAgentPlugin(agent)
        return {
          ...plugin,
          activate: ctx =>
            plugin.activate(
              new Proxy(ctx, {
                get(target, key, receiver) {
                  if (key === 'registerHarness') return (driver: HarnessDriver) => target.registerHarness(holdUntilStarted(driver))
                  const value = Reflect.get(target, key, receiver)
                  return typeof value === 'function' ? value.bind(target) : value
                },
              }),
            ),
        } satisfies HarnessPlugin
      },
    })
    cleanups.push(() => t.close())
    const desktop = await t.enroll({ listener: 'unix' })
    await desktop.confirmedJson('agents', {
      body: {
        id: 'mcp-agent',
        name: 'MCP Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_STATE: join(root, 'state.json'), FAKE_ACP_LOG: agentLog },
      },
    })
    const added = await desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', { body: addBody() })
    await desktop.json(`mcp/servers/${added.server.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: added.server.revision, scope: { all: true, agents: [], projects: [] } },
    })
    const agent = await desktop.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: { requestId: randomUUID(), name: '定时', description: '', harnessId: 'mcp-agent', mode: 'agent', instructions: '', skills: [] },
    })
    const automation = await desktop.json<Automation>('automations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '每天看看',
        customAgentId: agent.id,
        prompt: 'mcp-list computer',
        schedule: { kind: 'daily', time: '09:00' },
        notify: false,
        enabled: false,
      },
    })
    await desktop.json(`automations/${automation.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
    const run = await waitFor(
      () => desktop.json<AutomationDetail>(`automations/${automation.id}`),
      detail => detail.automation.lastRun?.state !== undefined && detail.automation.lastRun.state !== 'running',
    )
    expect(lastText(await desktop.json<TaskDetail>(`tasks/${run.automation.lastRun!.sessionId!}`))).toBe('no MCP server computer')
    // The same Harness, held the same way, in a conversation someone is in does get it.
    const chat = await desktop.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { customAgentId: agent.id, prompt: 'mcp-list computer', requestId: randomUUID() },
    })
    expect(lastText(await settled(desktop, chat.sessionId))).toBe('computer tools: click')
  })
})
