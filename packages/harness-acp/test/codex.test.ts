// Codex over its own app-server (`wires/codex.ts`), driven against the fake app-server: no network, no model.
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DriverTaskDetail } from '@latch/protocol'
import type { Bridge, HarnessDriver, HarnessHostOptions, HarnessPlugin, HarnessSecurityEvent, HostProject, ToolGateway } from '@latch/sdk'
import { FAKE_ACP_AGENT, FAKE_CODEX_APP_SERVER } from '@latch/testkit'
import {
  createAcpAgentPlugin,
  forgetCommandLookups,
  presetRoute,
  resolveCommand,
  selectProfile,
  setCommandSearch,
  setLoginPrograms,
  type AcpAgentOptions,
  type AgentRecord,
} from '../src/index.ts'
import { codexVersion } from '../src/wires/codex.ts'

const FAST: AcpAgentOptions = { cancelGraceMs: 2_000, stopGraceMs: 200, restartDelayMs: 0, requestTimeoutMs: 5_000, log: () => {} }
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setCommandSearch(undefined)
  setLoginPrograms(undefined)
  forgetCommandLookups()
})

let requests = 0
const rid = () => `codex-${++requests}`

async function activate(plugin: HarnessPlugin): Promise<HarnessDriver> {
  const drivers: HarnessDriver[] = []
  const disposers: Array<() => void | Promise<void>> = []
  await plugin.activate({
    registerHarness: driver => void drivers.push(driver),
    registerProvider: () => {},
    registerTool: () => {},
    registerClientPanel: () => {},
    registerSkill: () => {},
    registerTransport: () => {},
    registerUiPanel: () => {},
    onDispose: dispose => void disposers.push(dispose),
  })
  cleanups.push(async () => {
    for (const dispose of disposers.reverse()) await dispose()
  })
  return drivers[0]!
}

interface LogEntry {
  pid: number
  argv?: string[]
  answer?: { decision?: string } & Record<string, unknown>
  event: string
  method?: string | null
  params?: Record<string, unknown>
  result?: unknown
}

/** A computer whose only `codex` is the fake app-server, found as the start script finds programs. */
async function computer(
  env: Record<string, string> = {},
  extra: string[] = [],
  options: AcpAgentOptions = {},
  host: Pick<HarnessHostOptions, 'toolGateway'> = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-codex-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  const main = join(root, 'main')
  const docs = join(root, 'docs')
  const dataDir = join(root, 'data')
  const tmpRoot = join(root, 'run-tmp')
  await mkdir(bin)
  await mkdir(main)
  await mkdir(docs)
  await mkdir(tmpRoot, { mode: 0o700 })
  const logFile = join(root, 'codex.log')
  const exports = Object.entries({ FAKE_ACP_LOG: logFile, FAKE_CODEX_STATE: join(root, 'threads.json'), ...env })
    .map(([name, value]) => `export ${name}='${value}'`)
    .join('\n')
  await writeFile(join(bin, 'codex'), `#!/bin/sh\n${exports}\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`)
  await chmod(join(bin, 'codex'), 0o755)
  for (const name of extra) {
    await writeFile(join(bin, name), `#!/bin/sh\nexec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"\n`)
    await chmod(join(bin, name), 0o755)
  }
  setCommandSearch(() => [bin])
  setLoginPrograms(resolveCommand)
  forgetCommandLookups()
  const record: AgentRecord = { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex', args: [], env: {}, enabled: true }
  const projects: HostProject[] = [
    {
      id: 'proj',
      folders: [
        { id: 'app', path: main },
        { id: 'docs', path: docs },
      ],
    },
  ]
  const driver = await activate(createAcpAgentPlugin(record, { ...FAST, ...options }))
  const events: HarnessSecurityEvent[] = []
  const open = async (): Promise<Bridge> => {
    const bridge = driver.create({
      ...host,
      dataDir,
      workspaceRoot: main,
      tmpRoot,
      workspaces: () => [main],
      projects: () => structuredClone(projects),
      providerId: 'unused',
      registry: {
        acquire() {
          throw new Error('unused')
        },
      },
      securityEvent: event => void events.push(event),
    })
    cleanups.push(() => bridge.close())
    await bridge.start()
    return bridge
  }
  const log = async (): Promise<LogEntry[]> =>
    (await readFile(logFile, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as LogEntry)
  return { root, bin, main, docs, record, driver, open, log, events }
}

async function start(bridge: Bridge, cwd: string, prompt: string, folders?: HostProject['folders']): Promise<string> {
  const where = folders ? { workspaceId: 'proj', folders } : {}
  const { launchHash } = await bridge.launchPreview!({ cwd, ...where })
  return (await bridge.createTask({ prompt, requestId: rid(), cwd, ...where, expectedLaunchHash: launchHash })).sessionId
}

async function until(bridge: Bridge, id: string, predicate: (detail: DriverTaskDetail) => boolean): Promise<DriverTaskDetail> {
  await vi.waitFor(async () => expect(predicate(await bridge.detail(id))).toBe(true), { timeout: 8_000, interval: 10 })
  return bridge.detail(id)
}
const settled = (bridge: Bridge, id: string) =>
  until(bridge, id, detail => detail.summary.status !== 'running' && detail.summary.status !== 'waiting-approval')
const said = (detail: DriverTaskDetail, role: string) =>
  detail.messages
    .filter(message => message.role === role)
    .map(message => message.text)
    .join('\n')
const sent = (log: LogEntry[], method: string) => log.filter(entry => entry.event === 'recv' && entry.method === method)

describe('Codex over its app-server', () => {
  it('is the preset’s route for `codex`, and the adapter only for any other command', () => {
    expect(selectProfile({ id: 'c', name: 'C', presetId: 'codex', command: 'codex', args: [], env: {}, enabled: true }).profile?.wire).toBe(
      'codex',
    )
    const adapter = selectProfile({ id: 'c', name: 'C', presetId: 'codex', command: 'codex-acp', args: [], env: {}, enabled: true })
    expect(adapter.profile?.wire).toBeUndefined()
    expect(adapter.verified).toBe(true)
    expect(codexVersion('latch/0.167.0 (Mac OS 27.3.0; arm64) unknown (latch; 0.1.0)')).toBe('0.167.0')
  })

  it('streams a reply in pieces, with the read-only mode’s approval policy and sandbox on the turn', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo hello there')
    const detail = await settled(bridge, id)
    expect(detail.summary.status).toBe('idle')
    expect(said(detail, 'assistant')).toBe('echo: echo hello there')
    const log = await t.log()
    expect(log.find(entry => entry.event === 'start')?.argv).toEqual(['app-server'])
    expect(sent(log, 'thread/start')[0]!.params).toMatchObject({
      cwd: t.main,
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      approvalsReviewer: 'user',
    })
    expect(sent(log, 'turn/start')[0]!.params).toMatchObject({
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      input: [{ type: 'text', text: 'echo hello there' }],
    })
    expect(detail.config?.find(option => option.category === 'mode')?.currentValue).toBe('read-only')
    expect(detail.config?.find(option => option.category === 'model')?.currentValue).toBe('gpt-fake')
  })

  it('gives the thread latch-browser as Codex config with paths only, and a fresh token file when it resumes', async () => {
    const leases: Array<{ token: string; tokenFile: string; closed: boolean }> = []
    const toolGateway: ToolGateway = {
      open() {
        const lease = {
          token: `lbt1.${String(leases.length).repeat(43)}`,
          tokenFile: `/tmp/latch-test/tools/${leases.length}.lbt`,
          closed: false,
        }
        leases.push(lease)
        return {
          socketPath: '/tmp/latch-test/tools/gateway.sock',
          tokenFile: lease.tokenFile,
          token: lease.token,
          active: () => !lease.closed,
          cancel() {},
          settled: async () => ({ resultUnknown: false }),
          close: () => void (lease.closed = true),
        }
      },
    }
    const t = await computer({}, [], {}, { toolGateway })
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo hello')
    await settled(bridge, id)
    const started = sent(await t.log(), 'thread/start')[0]!.params as { config: { mcp_servers: Record<string, any> } }
    const server = started.config.mcp_servers['latch-browser']
    expect(server).toMatchObject({ command: process.execPath, env: {} })
    expect(server.args.slice(-2)).toEqual(['/tmp/latch-test/tools/gateway.sock', leases[0]!.tokenFile])
    // Codex may keep the thread's config in its own files: only the paths are in it.
    expect(JSON.stringify(started)).not.toContain('lbt1.')
    await bridge.close()
    expect(leases[0]!.closed).toBe(true)
    const again = await t.open()
    await again.prompt(id, 'echo again', rid())
    await settled(again, id)
    const resumed = sent(await t.log(), 'thread/resume')[0]!.params as { config: { mcp_servers: Record<string, any> } }
    expect(resumed.config.mcp_servers['latch-browser'].args.at(-1)).toBe(leases[1]!.tokenFile)
  })

  it('gives the thread each of Latch’s MCP servers as a latch-mcp bridge: paths only, no secret, a longer start', async () => {
    const closed: string[] = []
    const toolGateway: ToolGateway = {
      open: () => undefined,
      async openMcp(input) {
        expect(input).toMatchObject({ projectId: 'default' })
        return [
          {
            name: 'github',
            socketPath: '/tmp/latch-test/tools/gateway.sock',
            tokenFile: '/tmp/latch-test/tools/github.lbt',
            token: `lbt1.${'g'.repeat(43)}`,
            close: () => void closed.push('github'),
          },
        ]
      },
    }
    const t = await computer({}, [], {}, { toolGateway })
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo hello')
    await settled(bridge, id)
    const started = sent(await t.log(), 'thread/start')[0]!.params as { config: { mcp_servers: Record<string, any> } }
    const server = started.config.mcp_servers.github
    expect(server).toMatchObject({ command: process.execPath, env: {}, startup_timeout_sec: 60 })
    expect(server.args.slice(-2)).toEqual(['/tmp/latch-test/tools/gateway.sock', '/tmp/latch-test/tools/github.lbt'])
    expect(JSON.stringify(started)).not.toContain('lbt1.')
    await bridge.close()
    expect(closed).toEqual(['github'])
  })

  it('puts Codex’s approvals to the person with one-time answers, and tells Codex what they chose', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'run the listing')
    const waiting = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    const [approval] = waiting.approvals
    expect(approval?.options?.map(option => option.id)).toEqual(['accept', 'decline'])
    await bridge.decide(approval!.id, 'allow')
    const done = await settled(bridge, id)
    expect(done.summary.status).toBe('idle')
    expect(done.messages.find(message => message.role === 'tool')).toMatchObject({ state: 'completed' })
    expect(JSON.stringify(done.messages)).toContain('file-b')
    const answered = (await t.log()).filter(entry => entry.event === 'recv' && entry.method === null && entry.result)
    expect(answered.map(entry => entry.result)).toEqual([{ decision: 'accept' }])

    await bridge.prompt(id, 'edit the notes', rid())
    const asked = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    await bridge.decide(asked.approvals[0]!.id, 'reject')
    const declined = await settled(bridge, id)
    expect(said(declined, 'assistant')).toContain('not edited')
    expect(declined.messages.filter(message => message.role === 'tool').at(-1)).toMatchObject({ state: 'failed' })
  })

  it('sends each mode’s policy with every turn and thread, the project’s other folders writable only in a writing mode', async () => {
    const t = await computer({}, [], { idleMs: 300 })
    const bridge = await t.open()
    const folders = [
      { id: 'app', path: t.main },
      { id: 'docs', path: t.docs },
    ]
    const id = await start(bridge, t.main, 'echo one', folders)
    await settled(bridge, id)
    expect(sent(await t.log(), 'turn/start')[0]!.params).toMatchObject({ sandboxPolicy: { type: 'readOnly', networkAccess: false } })
    for (const [mode, expected] of [
      [
        'workspace-write',
        {
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          sandboxPolicy: { type: 'workspaceWrite', writableRoots: [t.docs], networkAccess: false },
        },
      ],
      [
        'agent',
        {
          approvalPolicy: 'on-request',
          approvalsReviewer: 'auto_review',
          sandboxPolicy: { type: 'workspaceWrite', writableRoots: [t.docs], networkAccess: false },
        },
      ],
      ['agent-full-access', { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } }],
    ] as const) {
      await bridge.setConfig!(id, 'mode', mode)
      await bridge.prompt(id, 'echo again', rid())
      await settled(bridge, id)
      expect(sent(await t.log(), 'turn/start').at(-1)!.params).toMatchObject(expected)
    }
    // An idle process stops; the next turn resumes the thread at the strictest mode, then sets the chosen one on the turn.
    await vi.waitFor(async () => expect((await t.log()).some(entry => entry.event === 'exit')).toBe(true), { timeout: 5_000 })
    await bridge.prompt(id, 'echo after', rid())
    await settled(bridge, id)
    const log = await t.log()
    expect(sent(log, 'thread/resume')[0]!.params).toMatchObject({
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      approvalsReviewer: 'user',
    })
    expect(sent(log, 'turn/start').at(-1)!.params).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } })
  })

  it('answers a stop only once Codex reports the interrupted turn ended', async () => {
    const t = await computer({ FAKE_CODEX_INTERRUPT_MS: '600' })
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'sleep until told')
    await vi.waitFor(async () => expect(sent(await t.log(), 'turn/start')).toHaveLength(1), { timeout: 5_000 })
    await bridge.cancel(id)
    let completedFirst = true
    await vi.waitFor(
      async () => {
        const status = (await bridge.detail(id)).summary.status
        if (status === 'cancelled' && !(await t.log()).some(entry => entry.event === 'completed')) completedFirst = false
        expect(status).toBe('cancelled')
      },
      { timeout: 5_000, interval: 10 },
    )
    expect(completedFirst).toBe(true)
    expect(sent(await t.log(), 'turn/interrupt')).toHaveLength(1)
  })

  it('stops a process whose interrupted turn never ends, and says so', async () => {
    const t = await computer({ FAKE_CODEX_INTERRUPT_NEVER: '1' }, [], { cancelGraceMs: 500 })
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'sleep until told')
    await vi.waitFor(async () => expect(sent(await t.log(), 'turn/start')).toHaveLength(1), { timeout: 5_000 })
    await bridge.cancel(id)
    const detail = await settled(bridge, id)
    expect(said(detail, 'system')).toContain('取消未在 1 秒内完成，已强制结束 Codex 进程')
  })

  it('answers cancel to an approval Codex asks after the stop', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'sleep late')
    await vi.waitFor(async () => expect(sent(await t.log(), 'turn/start')).toHaveLength(1), { timeout: 5_000 })
    await bridge.cancel(id)
    await settled(bridge, id)
    const late = (await t.log()).find(entry => entry.event === 'answered' && entry.method === 'late')
    expect(late?.answer).toEqual({ decision: 'cancel' })
  })

  it('adds text to the running turn with turn/steer', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'sleep until told')
    await vi.waitFor(async () => expect(sent(await t.log(), 'turn/start')).toHaveLength(1), { timeout: 5_000 })
    expect(await bridge.steer!(id, 'also this', rid())).toBe('injected')
    const [steered] = sent(await t.log(), 'turn/steer')
    expect(steered!.params).toMatchObject({ input: [{ type: 'text', text: 'also this' }] })
    expect(steered!.params!.expectedTurnId).toEqual(expect.stringMatching(/^turn-/u))
    await bridge.cancel(id)
    await settled(bridge, id)
  })

  it('fails the turn when Codex exits in the middle of it', async () => {
    const t = await computer()
    const bridge = await t.open()
    const detail = await settled(bridge, await start(bridge, t.main, 'crash now'))
    expect(detail.summary.status).toBe('failed')
    expect(said(detail, 'system')).toContain('Codex')
  })

  it('says and records each request it answers without asking, and names one it does not know', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'widen please')
    await settled(bridge, id)
    for (const prompt of ['elicit please', 'odd please']) {
      await bridge.prompt(id, prompt, rid())
      await settled(bridge, id)
    }
    const detail = await bridge.detail(id)
    const notes = said(detail, 'system')
    expect(notes).toContain('已自动拒绝：Codex 请求联网。权限只随你在「权限」里选的模式变。')
    expect(notes).toContain('已自动拒绝：Codex 的 MCP 服务器「docs」想问你「Which page?」')
    expect(notes).toContain('item/tool/requestUserInput')
    const answered = (await t.log()).filter(entry => entry.event === 'answered')
    expect(answered.map(entry => entry.answer)).toEqual([{ permissions: {}, scope: 'turn' }, { action: 'decline' }, undefined])
    expect(t.events.filter(event => event.type === 'approval-auto-rejected')).toEqual([
      { type: 'approval-auto-rejected', sessionId: id, reason: 'harness-declined' },
      { type: 'approval-auto-rejected', sessionId: id, reason: 'harness-declined' },
    ])
  })

  it('shows what allowing a network request grants', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'fetch the page')
    const waiting = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    const [approval] = waiting.approvals
    expect(approval!.reason).toBe('联网：example.com')
    expect(approval!.arguments).toContain('允许后，这条命令可以访问 example.com（https）')
    await bridge.decide(approval!.id, 'reject')
    expect(said(await settled(bridge, id), 'assistant')).toContain('network decline')
  })

  it('shows a subagent’s calls as its own and asks about them as its', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'sub task')
    const waiting = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    expect(waiting.approvals[0]).toMatchObject({ subagent: expect.any(String) })
    expect(waiting.approvals[0]!.toolCallId).toBeUndefined()
    await bridge.decide(waiting.approvals[0]!.id, 'reject')
    const done = await settled(bridge, id)
    expect(said(done, 'assistant')).toContain('subagent done')
    expect(JSON.stringify(done.messages)).toContain('rm -rf build')
    const answer = (await t.log()).find(entry => entry.event === 'answered' && entry.method === 'subagent')?.answer
    expect(answer).toEqual({ decision: 'decline' })
  })

  it('in the model-reviewed mode, shows the review of a subagent’s call as the subagent’s, and records its verdict', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo one')
    await settled(bridge, id)
    await bridge.setConfig!(id, 'mode', 'agent')
    await bridge.prompt(id, 'sub task', rid())
    const done = await settled(bridge, id)
    expect(said(done, 'assistant')).toContain('subagent done')
    expect(JSON.stringify(done.messages)).toContain('Removes the build')
    expect(t.events.filter(event => event.type === 'tool-judged').map(event => event.type === 'tool-judged' && event.outcome)).toContain(
      'denied',
    )
    expect(t.events.some(event => event.type === 'tool-judged' && event.outcome === 'ran-unasked')).toBe(false)
  })

  it('asks the person before an MCP tool runs, showing the server, the tool and its arguments', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'tool please')
    const waiting = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    const [approval] = waiting.approvals
    expect(approval!.reason).toBe('调用 docs.search')
    expect(approval!.arguments).toContain('允许后，Codex 调用 MCP 服务器「docs」的工具「search」一次')
    expect(approval!.arguments).toContain('latch')
    // Started before it asked, it is not shown as running yet.
    expect(waiting.messages.filter(message => message.role === 'tool').every(message => message.state !== 'running')).toBe(true)
    await bridge.decide(approval!.id, 'allow')
    const done = await settled(bridge, id)
    expect(said(done, 'assistant')).toContain('tool ran')
    expect((await t.log()).find(entry => entry.event === 'answered' && entry.method === 'tool')?.answer).toEqual({
      action: 'accept',
      content: {},
    })
  })

  it('answers the two old-style approval requests itself, and says so', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'legacy asks')
    const done = await settled(bridge, id)
    const answered = (await t.log()).filter(entry => entry.event === 'answered')
    expect(answered.map(entry => [entry.method, entry.answer])).toEqual([
      ['execCommandApproval', { decision: 'abort' }],
      ['applyPatchApproval', { decision: 'abort' }],
    ])
    expect(said(done, 'system')).toContain('已自动拒绝：Codex 用旧式请求要求运行命令')
    expect(said(done, 'system')).toContain('已自动拒绝：Codex 用旧式请求要求改文件')
    expect(t.events.filter(event => event.type === 'approval-auto-rejected')).toHaveLength(2)
  })

  it('in the model-reviewed mode, shows Codex’s reviews and records a denied call as denied, never as run unasked', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo one')
    await settled(bridge, id)
    await bridge.setConfig!(id, 'mode', 'agent')
    await bridge.prompt(id, 'run it', rid())
    await settled(bridge, id)
    await bridge.prompt(id, 'risky run', rid())
    const detail = await settled(bridge, id)
    const tools = detail.messages.filter(message => message.role === 'tool')
    expect(tools.filter(tool => tool.tool?.judged).map(tool => tool.tool?.judged?.outcome)).toEqual(
      expect.arrayContaining(['approved', 'denied']),
    )
    expect(tools.find(tool => tool.tool?.blocked)?.tool?.blocked).toMatchObject({ source: 'model', reason: 'Deletes too much' })
    const judged = t.events.flatMap(event => (event.type === 'tool-judged' ? [event.outcome] : []))
    expect(judged).toEqual(expect.arrayContaining(['approved', 'denied']))
    expect(judged).not.toContain('ran-unasked')
  })

  it('keeps Codex’s own reason when resuming fails for any reason but a missing thread', async () => {
    const t = await computer({ FAKE_CODEX_RESUME_ERROR: 'thread is in use by another client' }, [], { idleMs: 300 })
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo one')
    await settled(bridge, id)
    await vi.waitFor(async () => expect((await t.log()).some(entry => entry.event === 'exit')).toBe(true), { timeout: 5_000 })
    // Refused before the turn was recorded: a code that says nothing was accepted, with Codex's own words.
    await expect(bridge.prompt(id, 'echo two', rid())).rejects.toMatchObject({
      code: 'agent-refused',
      message: 'Codex 返回错误：thread is in use by another client',
    })
  })

  it('fails a turn Codex ends failed, with its reason, and reports its retry on the way', async () => {
    const t = await computer()
    const bridge = await t.open()
    const detail = await settled(bridge, await start(bridge, t.main, 'fail now'))
    expect(detail.summary.status).toBe('failed')
    expect(said(detail, 'system')).toContain('The model service failed')
  })

  it('says Codex is not logged in when its account says so, before any thread', async () => {
    const t = await computer({ FAKE_CODEX_LOGGED_OUT: '1' })
    const bridge = await t.open()
    const detail = await settled(bridge, await start(bridge, t.main, 'echo hi'))
    expect(detail.summary.status).toBe('failed')
    expect(said(detail, 'system')).toContain('Codex 还没登录')
    expect(sent(await t.log(), 'thread/start')).toEqual([])
  })

  it('lists and brings in Codex’s threads through its own requests', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo remember me')
    await settled(bridge, id)
    const listed = await bridge.listExternalSessions!()
    expect(listed.sessions).toHaveLength(1)
    expect(listed.sessions[0]).toMatchObject({ cwd: t.main, title: 'echo remember me' })
    const load = await bridge.loadExternalSession!({
      agentSessionId: listed.sessions[0]!.agentSessionId,
      cwd: t.main,
      workspaceId: 'proj',
      folders: [{ id: 'app', path: t.main }],
    })
    expect(load.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(load.messages[1]!.text).toBe('echo: echo remember me')
    const log = await t.log()
    expect(sent(log, 'thread/list')).toHaveLength(1)
    expect(sent(log, 'thread/read')[0]!.params).toMatchObject({ includeTurns: true })
  })

  it('refuses a Codex below the floor, and offers the adapter only when Codex is not installed at all', async () => {
    const t = await computer({ FAKE_CODEX_VERSION: '0.150.0' }, ['codex-acp'])
    const bridge = await t.open()
    const detail = await settled(bridge, await start(bridge, t.main, 'echo hi'))
    expect(detail.summary.status).toBe('failed')
    expect(said(detail, 'system')).toContain('Codex 需要 0.156.0 或更高版本（当前 0.150.0）。升级：npm i -g @openai/codex@latest')
    // Still Codex itself: the adapter would run this same old Codex.
    expect(presetRoute('codex')?.command).toBe('codex')
    await rm(join(t.bin, 'codex'))
    forgetCommandLookups()
    expect(presetRoute('codex')).toMatchObject({ command: 'codex-acp', args: [] })
  })
})
