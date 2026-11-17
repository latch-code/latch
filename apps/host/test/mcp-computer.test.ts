import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile, chmod } from 'node:fs/promises'
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
import {
  checkComputerDriver,
  computerDefaultsUpgrade,
  computerGuide,
  computerRefusal,
  computerRules,
  COMPUTER_DEFAULTS,
  COMPUTER_ENV,
  COMPUTER_GUIDE_SKILL,
  COMPUTER_KNOWN_TOOLS,
  COMPUTER_MINIMUM,
  COMPUTER_REFUSAL_TEXT,
  COMPUTER_TOOLS_OFF,
} from '../src/mcp-computer.ts'
import { COMPUTER_TOOL_GROUPS } from '@latch/protocol'
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

async function computerHost(
  options: {
    tools?: string[]
    version?: string
    instructions?: string
    log?: string
    guide?: 'replace' | 'prepend'
    dataDir?: string
  } = {},
) {
  const root = await folder()
  const app = await writeFakeCuaDriver(root, {
    tools: options.tools ?? [],
    ...(options.version ? { version: options.version } : {}),
    ...(options.instructions ? { instructions: options.instructions } : {}),
    ...(options.log ? { log: options.log } : {}),
  })
  const t = await startTestHost({
    demo: false,
    computerDriver: { app, verify: signed, ...(options.guide ? { guide: options.guide } : {}) },
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
  })
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
    expect(check).toMatchObject({ state: 'ok', version: '0.44.0', minimum: '0.37.0' })
    expect(check.pinned).toMatch(/^0\.(45\.4|46\.1)$/u)
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
    // Clipboard, scripts, the whole-screen capture, browser automation and update are off by name; batches and
    // launching are on, checked by the Host.
    for (const tool of [
      'clipboard_read',
      'clipboard_write',
      'run_script',
      'kill_app',
      'get_desktop_state',
      'start_recording',
      'set_agent_cursor_enabled',
      'browser_click',
      'page',
      'check_for_update',
    ])
      expect(COMPUTER_TOOLS_OFF).toContain(tool)
    for (const tool of ['run_steps', 'launch_app', 'get_guide']) expect(COMPUTER_TOOLS_OFF).not.toContain(tool)
    expect((await audit(t)).find(record => record.action === 'mcp.server.added')?.detail).toMatchObject({
      serverId: server.id,
      preset: 'computer',
    })
    expect(await desktop.json<McpComputerCheck>('mcp/computer')).toMatchObject({ added: server.id })
    expect((await desktop.request('mcp/servers', { body: addBody() })).status).toBe(409)
  })

  it('refuses a driver too old, and is not there at all on a Host that names no place for it', async () => {
    const { desktop } = await computerHost({ version: '0.36.0' })
    expect(await desktop.json<McpComputerCheck>('mcp/computer')).toMatchObject({ state: 'old', version: '0.36.0' })
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

describe('「操控这台 Mac」: Latch’s guide for the agent', () => {
  it('puts the two stop rules first, names only the tools off now, and stays within its length', () => {
    const rules = computerRules(COMPUTER_TOOLS_OFF)
    const lines = rules.split('\n')
    expect(lines[1]).toMatch(/^1\. Never act on Latch or any other Electron or Chromium app/u)
    expect(lines[2]).toMatch(/^2\. At any login, password, payment or system permission dialog, stop/u)
    expect(rules.length).toBeLessThanOrEqual(1200)
    expect(rules).toContain('Never run cua-driver or cua in a shell.')
    expect(rules).toContain('run_steps({steps:[{tool,args}]})')
    expect(rules).toContain('launch_app({bundle_id})')
    expect(rules).toContain('Ask the person before taking the foreground')
    expect(rules).toContain('browser_*')
    expect(rules).toContain('clipboard_*')
    expect(rules).not.toMatch(/browser_click|clipboard_read/u)
    // The person switched batches and launching off: the rules say so instead.
    const closed = computerRules([...COMPUTER_TOOLS_OFF, 'run_steps', 'launch_app'])
    expect(closed).toContain('Make one call per step')
    expect(closed).toContain('ask the person to open it')
    expect(closed).not.toContain('run_steps({steps')
    // Every known tool off: the list is cut and counted, and the rules still fit.
    const worst = computerRules([...COMPUTER_KNOWN_TOOLS, 'new_tool_one', 'new_tool_two'])
    expect(worst.length).toBeLessThanOrEqual(1200)
    expect(worst).toMatch(/ and \d+ more; tools new to Latch too\.$/u)
  })

  it('keeps the rules whole within the 2,048 characters some agents read, in either way of meeting the driver’s text', () => {
    for (const disabled of [COMPUTER_TOOLS_OFF, [...COMPUTER_KNOWN_TOOLS]]) {
      const rules = computerRules(disabled)
      const replace = computerGuide(disabled, 'replace')
      expect(replace.length).toBeLessThanOrEqual(2048)
      expect(replace.slice(0, 2048).startsWith(rules)).toBe(true)
      expect(replace).toContain('get_guide')
      const prepend = `${computerGuide(disabled, 'prepend')}\n\n---\n\n${'driver text '.repeat(400)}`
      expect(prepend.slice(0, 2048).startsWith(rules)).toBe(true)
    }
  })

  it('groups every tool it knows, each once', () => {
    const grouped = COMPUTER_TOOL_GROUPS.flatMap(group => group.tools)
    expect(new Set(grouped).size).toBe(grouped.length)
    for (const tool of COMPUTER_KNOWN_TOOLS) expect(grouped).toContain(tool)
    expect(COMPUTER_TOOL_GROUPS.map(group => group.label)).toEqual([
      '看',
      '操作',
      '启动 App',
      '批量',
      '脚本',
      '浏览器',
      '剪贴板',
      '录屏',
      '管理',
    ])
  })

  it('reaches the agent in place of the driver’s own instructions, in the refusal of a tool that is off, and in latch-skills', async () => {
    const { t, root, desktop } = await computerHost({
      tools: ['click', 'run_steps', 'launch_app', 'run_script', 'get_desktop_state'],
      instructions: 'Act through run_steps, even for a single step.',
    })
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
    await desktop.json(`mcp/servers/${added.server.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: added.server.revision, scope: { all: true, agents: [], projects: [] } },
    })
    const { sessionId } = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'mcp-instructions computer', requestId: randomUUID(), harnessId: 'mcp-agent' },
    })
    // Latch's rules first, then the driver's own text, unchanged.
    const said = lastText(await settled(desktop, sessionId))
    expect(said).toBe(`${computerGuide(COMPUTER_TOOLS_OFF, 'prepend')}\n\n---\n\nAct through run_steps, even for a single step.`)
    for (const [tool, hint] of [
      ['run_script', 'Use run_steps for a batch of input steps, or one call per step.'],
      ['get_desktop_state', 'Read the one window the task needs with get_window_state.'],
    ]) {
      await desktop.json(`tasks/${sessionId}/prompt`, { body: { requestId: randomUUID(), prompt: `mcp computer ${tool}` } })
      expect(lastText(await settled(desktop, sessionId))).toBe(`computer.${tool}: error: This tool is switched off in Latch. ${hint}`)
    }

    // A session with latch-skills (a conversation with one of 我的 Agent) lists the rules after the agent's skills.
    const agent = await desktop.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: { requestId: randomUUID(), name: '桌面', description: '', harnessId: 'mcp-agent', mode: 'agent', instructions: '', skills: [] },
    })
    const chat = await desktop.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { customAgentId: agent.id, prompt: 'skills', requestId: randomUUID() },
    })
    const listed = lastText(await settled(desktop, chat.sessionId))
    expect(listed.startsWith('latch-skills: ')).toBe(true)
    expect(JSON.parse(listed.slice('latch-skills: '.length))).toEqual([
      { id: COMPUTER_GUIDE_SKILL.id, name: COMPUTER_GUIDE_SKILL.name, description: COMPUTER_GUIDE_SKILL.description },
    ])
    // Written only in the Host's own data directory, never into a CLI's skills folder or the project; the rules alone.
    // One per session that has latch-skills: the chat, and the Code session before it, which has it for the board's tools.
    const found = (await readdir(t.dataDir, { recursive: true })).filter(path => path.endsWith('guides.json'))
    expect(found).toHaveLength(2)
    for (const path of found)
      expect(JSON.parse(await readFile(join(t.dataDir, path), 'utf8'))[0].content).toBe(computerRules(COMPUTER_TOOLS_OFF))
    expect((await readdir(t.workspaceRoot, { recursive: true })).filter(path => /skill|guide/iu.test(path))).toEqual([])
  })

  it('leaves the driver’s own text out when the guide replaces it', async () => {
    const { root, desktop } = await computerHost({
      tools: ['click'],
      instructions: 'Act through run_steps, even for a single step.',
      guide: 'replace',
    })
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
    await desktop.json(`mcp/servers/${added.server.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: added.server.revision, scope: { all: true, agents: [], projects: [] } },
    })
    const { sessionId } = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'mcp-instructions computer', requestId: randomUUID(), harnessId: 'mcp-agent' },
    })
    expect(lastText(await settled(desktop, sessionId))).toBe(computerGuide(COMPUTER_TOOLS_OFF, 'replace'))
  })
})

describe('「操控这台 Mac」: the Host’s check of each call', () => {
  const server = { disabledTools: [...COMPUTER_TOOLS_OFF], knownTools: [...COMPUTER_KNOWN_TOOLS] }
  it.each([
    ['a batch of tools that are on', 'run_steps', { steps: ['click', 'type_text'], stepCount: 2 }, undefined],
    ['a batch with a step off', 'run_steps', { steps: ['click', 'get_desktop_state'], stepCount: 2 }, 'step-off'],
    ['a batch with a new tool', 'run_steps', { steps: ['browser_motion_policy'], stepCount: 1 }, 'step-off'],
    ['a batch it could not read', 'run_steps', { form: 'unknown' }, 'form'],
    ['a batch with no steps read', 'run_steps', {}, 'form'],
    ['no shape at all', 'click', undefined, 'form'],
    ['steps on another tool', 'click', { steps: ['click'], stepCount: 1 }, 'form'],
    ['launch_app by bundle ID', 'launch_app', { launch: 'ok' }, undefined],
    ['launch_app with more', 'launch_app', { launch: 'refused' }, 'launch-args'],
    ['launch_app unread', 'launch_app', {}, 'launch-args'],
    ['a launch shape on another tool', 'click', { launch: 'ok' }, 'form'],
    ['a screenshot to a file', 'get_window_state', { screenshotFile: true }, 'screenshot-file'],
    ['Latch by name', 'click', { latchName: true }, 'latch'],
    ['Latch’s pid', 'click', { pids: [501, 777] }, 'latch'],
    ['another app’s pid', 'click', { pids: [501] }, undefined],
    ['an unread batch aimed at Latch', 'run_steps', { form: 'unknown', pids: [777] }, 'latch'],
  ] as const)('%s', (_, tool, shape, refused) => {
    expect(computerRefusal(server, tool, shape as never, [777])).toBe(refused)
  })

  it.each([
    ['invoke_menu', ['click', 'get_window_state', 'invoke_menu', 'list_apps', 'list_windows']],
    ['get_window_state', ['get_window_state', 'list_apps', 'list_windows', 'type_text']],
    ['list_windows', ['get_window_state', 'list_apps', 'list_windows', 'type_text']],
  ])('refuses a batch when the person switched off %s, which the driver calls itself inside it', (off, steps) => {
    const narrowed = { ...server, disabledTools: [...server.disabledTools, off] }
    expect(computerRefusal(narrowed, 'run_steps', { steps, stepCount: 1 }, [])).toBe('step-off')
  })

  it('moves only the switches the person did not touch to the current defaults', () => {
    const revision1 = [...COMPUTER_TOOLS_OFF.filter(tool => tool !== 'get_desktop_state'), 'run_steps', 'launch_app']
    expect(computerDefaultsUpgrade(revision1)?.toSorted()).toEqual([...COMPUTER_TOOLS_OFF].toSorted())
    // Run_steps switched on and the clipboard on by the person: they stay.
    const touched = revision1.filter(tool => tool !== 'run_steps' && tool !== 'clipboard_read')
    expect(computerDefaultsUpgrade(touched)).not.toContain('clipboard_read')
    expect(computerDefaultsUpgrade(touched)).not.toContain('run_steps')
    expect(computerDefaultsUpgrade([...COMPUTER_TOOLS_OFF])).toBeUndefined()
  })

  it('brings a server added before the current defaults to them at the Host’s start, on record, once', async () => {
    const dataDir = join(await folder(), 'data')
    const first = await computerHost({ dataDir })
    const added = await first.desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', { body: addBody() })
    await first.t.close()
    // As revision 1 left it: batches and launching off, the whole-screen capture on, the clipboard switched on by the person.
    const file = join(dataDir, 'mcp', 'servers.json')
    const saved = JSON.parse(await readFile(file, 'utf8'))
    const record = saved.servers.find((item: { id: string }) => item.id === added.server.id)
    delete record.defaults
    record.disabledTools = [
      ...COMPUTER_TOOLS_OFF.filter(tool => tool !== 'get_desktop_state' && tool !== 'clipboard_read'),
      'run_steps',
      'launch_app',
    ]
    await writeFile(file, JSON.stringify(saved))

    const second = await computerHost({ dataDir })
    const after = (await second.desktop.json<{ servers: McpServerView[] }>('mcp/servers')).servers[0]!
    expect(after.disabledTools.toSorted()).toEqual(COMPUTER_TOOLS_OFF.filter(tool => tool !== 'clipboard_read').toSorted())
    const changed = (await audit(second.t)).filter(item => item.action === 'mcp.server.changed')
    expect(changed.at(-1)?.detail).toMatchObject({ serverId: added.server.id, kinds: ['tools'] })
    expect(JSON.parse(await readFile(file, 'utf8')).servers[0].defaults).toBe(COMPUTER_DEFAULTS)
    // Shown once: which switches moved, until any managing device dismisses it, alone.
    expect(after.transport === 'stdio' && after.defaultsMoved).toEqual(['run_steps', 'launch_app', 'get_desktop_state'])
    const mixed = await second.browser.request(`mcp/servers/${after.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: after.revision, defaultsSeen: true, enabled: false },
    })
    expect(mixed.status).not.toBe(200)
    const seen = await second.browser.request(`mcp/servers/${after.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: after.revision, defaultsSeen: true },
    })
    expect(seen.status).toBe(200)
    const dismissed = (await second.desktop.json<{ servers: McpServerView[] }>('mcp/servers')).servers[0]!
    expect(dismissed.transport === 'stdio' && dismissed.defaultsMoved).toBeUndefined()
    expect(dismissed.disabledTools.toSorted()).toEqual(after.disabledTools.toSorted())
    await second.t.close()
    // Brought once: a third start changes nothing.
    const third = await computerHost({ dataDir })
    expect((await audit(third.t)).filter(item => item.action === 'mcp.server.changed')).toHaveLength(changed.length)
  })

  async function session(options: { tools?: string[] } = {}) {
    const root = await folder()
    const log = join(root, 'driver.jsonl')
    const host = await computerHost({
      tools: options.tools ?? ['click', 'type_text', 'run_steps', 'launch_app', 'get_window_state', 'get_desktop_state'],
      log,
    })
    await host.desktop.confirmedJson('agents', {
      body: {
        id: 'mcp-agent',
        name: 'MCP Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_STATE: join(root, 'state.json') },
      },
    })
    const added = await host.desktop.confirmedJson<{ server: McpServerView }>('mcp/servers', { body: addBody() })
    await host.desktop.json(`mcp/servers/${added.server.id}`, {
      method: 'PATCH',
      body: { requestId: randomUUID(), baseRevision: added.server.revision, scope: { all: true, agents: [], projects: [] } },
    })
    const { sessionId } = await host.desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'mcp-list computer', requestId: randomUUID(), harnessId: 'mcp-agent' },
    })
    await settled(host.desktop, sessionId)
    const calls = async () =>
      (await readFile(log, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { event: string; method?: string; tool?: string })
        .filter(entry => entry.event === 'recv' && entry.method === 'tools/call')
        .map(entry => entry.tool)
    const call = async (tool: string, args: unknown) => {
      await host.desktop.json(`tasks/${sessionId}/prompt`, {
        body: { requestId: randomUUID(), prompt: `mcp computer ${tool} ${JSON.stringify(args)}` },
      })
      return lastText(await settled(host.desktop, sessionId))
    }
    return { ...host, serverId: added.server.id, sessionId, calls, call }
  }

  it('checks every step of run_steps, refuses the whole batch for one step off, and records steps and refusals', async () => {
    const { t, serverId, call, calls } = await session()
    expect(await call('run_steps', { steps: [{ tool: 'click', args: { element_token: 's1:2' } }, { type_text: { text: 'Hello' } }] })).toBe(
      'computer.run_steps: ok: run_steps: ok',
    )
    const off = await call('run_steps', { steps: [{ click: {} }, { get_desktop_state: {} }] })
    expect(off).toBe(`computer.run_steps: error: ${COMPUTER_REFUSAL_TEXT['step-off']}`)
    expect(await call('run_steps', { steps: [{ tool: 'run_script', args: {} }] })).toBe(
      `computer.run_steps: error: ${COMPUTER_REFUSAL_TEXT.form}`,
    )
    expect(await call('get_window_state', { pid: 1, screenshot_out_file: '/tmp/x.png' })).toBe(
      `computer.get_window_state: error: ${COMPUTER_REFUSAL_TEXT['screenshot-file']}`,
    )
    // Only the batch that passed reached the driver.
    expect(await calls()).toEqual(['run_steps'])
    const records = (await audit(t)).filter(record => record.detail.serverId === serverId)
    expect(records.filter(record => record.action === 'mcp.tool.called').map(record => record.detail.steps)).toEqual([2])
    expect(records.filter(record => record.action === 'mcp.tool.refused').map(record => record.detail.reason)).toEqual([
      'step-off',
      'form',
      'screenshot-file',
    ])
    // The record names no argument.
    expect(JSON.stringify(records)).not.toMatch(/Hello|s1:2|x\.png/u)
  })

  it('lets launch_app through with a bundle ID only, and refuses calls aimed at Latch by name or by its processes', async () => {
    const { t, call, calls } = await session()
    expect(await call('launch_app', { bundle_id: 'com.apple.TextEdit' })).toBe('computer.launch_app: ok: launch_app: ok')
    for (const args of [
      { bundle_id: 'com.apple.TextEdit', urls: ['/tmp/a.txt'] },
      { name: '/Applications/TextEdit.app' },
      { name: 'TextEdit', additional_arguments: ['-x'] },
    ])
      expect(await call('launch_app', args)).toBe(`computer.launch_app: error: ${COMPUTER_REFUSAL_TEXT['launch-args']}`)
    expect(await call('launch_app', { name: 'Latch' })).toBe(`computer.launch_app: error: ${COMPUTER_REFUSAL_TEXT.latch}`)
    expect(await call('click', { app: 'Latch' })).toBe(`computer.click: error: ${COMPUTER_REFUSAL_TEXT.latch}`)
    // The desktop app says which process it is; a call naming it, or the Host, is refused.
    expect(
      (await t.raw('unix', 'api/host/state', { method: 'POST', body: { state: 'desktop', keepAwake: null, pid: 424242 } })).status,
    ).toBe(200)
    expect(await call('click', { pid: 424242, window_id: 1 })).toBe(`computer.click: error: ${COMPUTER_REFUSAL_TEXT.latch}`)
    expect(await call('click', { pid: '424242', window_id: 1 })).toBe(`computer.click: error: ${COMPUTER_REFUSAL_TEXT.latch}`)
    expect(await call('run_steps', { pid: process.pid, steps: [{ click: {} }] })).toBe(
      `computer.run_steps: error: ${COMPUTER_REFUSAL_TEXT.latch}`,
    )
    expect(await call('click', { pid: 501, window_id: 11 })).toBe('computer.click: ok: click: ok')
    expect(await calls()).toEqual(['launch_app', 'click'])
  })

  it('shows the session it is in use, and 停 ends that session’s bridge, on record first', async () => {
    const { t, serverId, sessionId, call, calls, browser } = await session()
    const detail = await t.enroll({ scopes: ['view'] }).then(viewer => viewer.json<TaskDetail>(`tasks/${sessionId}`))
    expect(detail.computer).toEqual({ serverId })
    expect((await browser.request(`tasks/${sessionId}/computer-stop`, { method: 'POST', body: {} })).status).toBe(200)
    const after = await waitFor(
      () => browser.json<TaskDetail>(`tasks/${sessionId}`),
      value => value.computer === undefined,
    )
    expect(after.computer).toBeUndefined()
    expect((await audit(t)).find(record => record.action === 'mcp.server.stopped')?.detail).toEqual({ serverId, sessionId })
    expect(await call('click', {})).toMatch(/^computer\.click: error: /u)
    expect(await calls()).toEqual([])
    expect((await browser.request(`tasks/${sessionId}/computer-stop`, { method: 'POST', body: {} })).status).toBe(409)
  })

  it('says 正在停止 after 停 while a call it sent may still run in the driver', async () => {
    const { t, desktop, serverId, browser } = await session()
    const listed = (await desktop.json<{ servers: McpServerView[] }>('mcp/servers')).servers[0]!
    await desktop.json(`mcp/servers/${listed.id}`, {
      method: 'PATCH',
      body: {
        requestId: randomUUID(),
        baseRevision: listed.revision,
        knownTools: [...(listed.transport === 'stdio' ? (listed.knownTools ?? []) : []), 'slow'],
      },
    })
    // A new session takes the switch: its call waits 4 s in the stand-in, as a long batch would in the daemon.
    const { sessionId } = await desktop.confirmedJson<{ sessionId: string }>('tasks', {
      body: { prompt: 'mcp computer slow {"ms":4000}', requestId: randomUUID(), harnessId: 'mcp-agent' },
    })
    await waitFor(
      () => audit(t),
      records => records.some(record => record.action === 'mcp.tool.called' && record.detail.sessionId === sessionId),
    )
    expect((await browser.request(`tasks/${sessionId}/computer-stop`, { method: 'POST', body: {} })).status).toBe(200)
    const stopped = await browser.json<TaskDetail>(`tasks/${sessionId}`)
    expect(stopped.computer).toEqual({ serverId, stopping: true })
  })
})
