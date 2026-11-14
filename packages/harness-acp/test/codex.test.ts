// Codex over its own app-server (`wires/codex.ts`), driven against the fake app-server: no network, no model.
import { spawn } from 'node:child_process'
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
import { CodexWire, codexMcpServer, codexVersion, setCodexStopLimits } from '../src/wires/codex.ts'
import { MCP_STATUS_METHOD } from '../src/protocol.ts'
import { RequestTimeout, setProcessLister } from '../src/wires/process.ts'

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

  it('runs /compact as an idle native operation and preserves a first-turn brief for the next message', async () => {
    const t = await computer()
    const bridge = await t.open()
    const brief = { segments: [{ source: 'user' as const, text: 'Keep the public plan.' }] }
    const agentContext = { agent: { customAgentId: 'agt_slash' }, instructions: '', brief, revision: 'a'.repeat(64) }
    const { launchHash } = await bridge.launchPreview!({ cwd: t.main })
    const { sessionId: id } = await bridge.createTask({
      prompt: '/compact',
      requestId: rid(),
      cwd: t.main,
      expectedLaunchHash: launchHash,
      agentContext,
    })
    const done = await settled(bridge, id)
    expect(done.summary.status).toBe('idle')
    expect(done.commands).toContainEqual(expect.objectContaining({ name: 'compact', idleOnly: true }))
    expect(said(done, 'system')).toContain('Codex 已压缩上下文')
    expect(done.messages.find(message => message.role === 'user')?.agentBrief).toBeUndefined()
    expect(sent(await t.log(), 'turn/start')).toHaveLength(0)
    expect(sent(await t.log(), 'thread/compact/start')).toHaveLength(1)
    await bridge.prompt(id, 'Continue with the plan.', rid())
    const next = await settled(bridge, id)
    expect(next.messages.filter(message => message.role === 'user').at(-1)?.agentBrief).toEqual(brief)
    expect(sent(await t.log(), 'turn/start')[0]!.params?.input).toEqual([
      { type: 'text', text: 'Keep the public plan.', text_elements: [] },
      { type: 'text', text: 'Continue with the plan.', text_elements: [] },
    ])
  })

  it('does not settle a compact ACK or item completion before the actual cancelled turn', async () => {
    const t = await computer({ FAKE_CODEX_COMPACT_HOLD: '1', FAKE_CODEX_INTERRUPT_MS: '120' })
    const bridge = await t.open()
    const id = await start(bridge, t.main, '/compact')
    await until(bridge, id, detail => said(detail, 'system').includes('正在压缩上下文'))
    expect((await bridge.detail(id)).summary.status).toBe('running')
    await bridge.cancel(id)
    const done = await settled(bridge, id)
    expect(done.summary.status).toBe('cancelled')
    expect(said(done, 'system')).toContain('Codex 已取消压缩上下文')
    expect(said(done, 'system')).not.toContain('Codex 已压缩上下文')
    expect(sent(await t.log(), 'turn/interrupt')).toHaveLength(1)
  })

  it('keeps a failed compaction failed even when its item was completed', async () => {
    const t = await computer({ FAKE_CODEX_COMPACT_FAIL: '1' })
    const bridge = await t.open()
    const id = await start(bridge, t.main, '/compact')
    const done = await settled(bridge, id)
    expect(done.summary.status).toBe('failed')
    expect(said(done, 'system')).toContain('Codex 压缩上下文失败')
    expect(said(done, 'system')).not.toContain('Codex 已压缩上下文')
  })

  it.each([
    ['mode', 'workspace-write'],
    ['model', 'gpt-fake-mini'],
    ['reasoning_effort', 'high'],
  ])('refuses /compact after an unapplied %s change, then accepts after an ordinary turn', async (configId, value) => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'echo setup')
    await settled(bridge, id)
    await bridge.setConfig!(id, configId!, value!)
    await bridge.prompt(id, '/compact', rid())
    const refused = await settled(bridge, id)
    expect(refused.summary.status).toBe('failed')
    expect(said(refused, 'system')).toContain('与选择不一致')
    expect(sent(await t.log(), 'thread/compact/start')).toHaveLength(0)
    expect(sent(await t.log(), 'turn/start')).toHaveLength(1)
    await bridge.prompt(id, 'echo apply settings', rid())
    await settled(bridge, id)
    await bridge.prompt(id, '/compact', rid())
    const done = await settled(bridge, id)
    expect(done.summary.status).toBe('idle')
    expect(sent(await t.log(), 'thread/compact/start')).toHaveLength(1)
  })

  it('does not start compact when cancellation arrives while its native context is being read', async () => {
    const t = await computer({ FAKE_CODEX_CONTEXT_MS: '250' })
    const bridge = await t.open()
    const id = await start(bridge, t.main, '/compact')
    await vi.waitFor(async () => expect(sent(await t.log(), 'thread/resume').some(entry => entry.params?.cwd === undefined)).toBe(true))
    await bridge.cancel(id)
    expect((await settled(bridge, id)).summary.status).toBe('cancelled')
    expect(sent(await t.log(), 'thread/compact/start')).toHaveLength(0)
    expect(sent(await t.log(), 'turn/interrupt')).toHaveLength(0)
  })

  it('rejects compact arguments without treating them as a model prompt', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, '/compact keep the plan')
    const done = await settled(bridge, id)
    expect(done.summary.status).toBe('failed')
    expect(said(done, 'system')).toContain('不接受参数或附件')
    expect(sent(await t.log(), 'turn/start')).toHaveLength(0)
    expect(sent(await t.log(), 'thread/compact/start')).toHaveLength(0)
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

  describe('a stop while an allowed command runs', () => {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const killGroup = (pid: number) => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* ended */
      }
    }
    /** Starts `prompt` (a `hold`), allows its command, and returns the pid Codex runs it as after an interrupt. */
    async function holding(prompt: string, env: Record<string, string>, options: AcpAgentOptions = {}) {
      const t = await computer(env, [], options)
      const bridge = await t.open()
      const id = await start(bridge, t.main, prompt)
      const asked = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
      await bridge.decide(asked.approvals[0]!.id, 'allow')
      let pid = 0
      await vi.waitFor(
        async () => {
          pid = ((await t.log()).find(entry => entry.event === 'command-started') as (LogEntry & { osPid: number }) | undefined)?.osPid ?? 0
          expect(pid).toBeGreaterThan(0)
        },
        { timeout: 5_000 },
      )
      cleanups.push(() => killGroup(pid))
      // Allowed, it runs, though it prints nothing.
      await until(bridge, id, detail => detail.messages.some(message => message.role === 'tool' && message.state === 'running'))
      return { t, bridge, id, pid }
    }
    const row = (detail: DriverTaskDetail) => detail.messages.find(message => message.role === 'tool')
    const quick = (limits: Parameters<typeof setCodexStopLimits>[0]) => {
      setCodexStopLimits(limits)
      cleanups.push(() => setCodexStopLimits(undefined))
    }
    /** Stops it and says how long the stop took. */
    async function stop(bridge: Bridge, id: string): Promise<{ detail: DriverTaskDetail; ms: number }> {
      const began = Date.now()
      await bridge.cancel(id)
      return { detail: await settled(bridge, id), ms: Date.now() - began }
    }

    it('answers only once Codex has ended the command, and never says it did not start', async () => {
      const { t, bridge, id, pid } = await holding('hold on', {}, { cancelGraceMs: 10_000 })
      const { detail } = await stop(bridge, id)
      expect(detail.summary.status).toBe('cancelled')
      expect(alive(pid)).toBe(false)
      const log = await t.log()
      expect(log.findIndex(entry => entry.event === 'command-ended')).toBeGreaterThan(log.findIndex(entry => entry.event === 'interrupted'))
      expect(sent(log, 'thread/backgroundTerminals/terminate')).toHaveLength(1)
      expect(row(detail)?.state).toBe('failed')
      expect(row(detail)?.text).not.toContain('TOOL_NOT_STARTED')
      expect(said(detail, 'system')).not.toContain('强制结束')
    })

    it('ends the command’s own process group itself when Codex does not, before answering', async () => {
      quick({ commandMs: 300 })
      const { t, bridge, id, pid } = await holding('hold on', { FAKE_CODEX_TERMINALS: 'ignore' }, { cancelGraceMs: 10_000 })
      const { detail, ms } = await stop(bridge, id)
      expect(alive(pid)).toBe(false)
      expect(ms).toBeLessThan(5_000)
      expect(detail.summary.status).toBe('cancelled')
      expect((await t.log()).some(entry => entry.event === 'terminate')).toBe(true)
      expect(row(detail)?.text).not.toContain('TOOL_NOT_STARTED')
      expect(said(detail, 'system')).not.toContain('强制结束')
    })

    it.each(['hold quiet', 'hold sub quiet'])('waits for an accepted command with no started notification: %s', async prompt => {
      const { t, bridge, id, pid } = await holding(prompt, {}, { cancelGraceMs: 10_000 })
      const { detail } = await stop(bridge, id)
      expect(alive(pid)).toBe(false)
      expect(detail.summary.status).toBe('cancelled')
      expect(sent(await t.log(), 'thread/backgroundTerminals/terminate')).toHaveLength(1)
      expect(row(detail)?.text).not.toContain('TOOL_NOT_STARTED')
    })

    it('ends a subagent’s command through the subagent’s thread', async () => {
      const { t, bridge, id, pid } = await holding('hold sub', {}, { cancelGraceMs: 10_000 })
      const { detail, ms } = await stop(bridge, id)
      expect(alive(pid)).toBe(false)
      expect(ms).toBeLessThan(5_000)
      expect(detail.summary.status).toBe('cancelled')
      const listed = sent(await t.log(), 'thread/backgroundTerminals/list').map(entry => entry.params?.threadId)
      expect(listed).toHaveLength(2)
      expect(listed[1]).toMatch(/^thread-sub-/u)
    })

    it('waits for the command too when Codex ends the stopped turn failed', async () => {
      const { bridge, id, pid } = await holding('hold on', { FAKE_CODEX_INTERRUPT_STATUS: 'failed' }, { cancelGraceMs: 10_000 })
      await bridge.cancel(id)
      expect(alive(pid)).toBe(false)
      expect((await settled(bridge, id)).summary.status).toBe('cancelled')
    })

    it('does not wait for a command whose ask the stop left unanswered', async () => {
      const t = await computer({}, [], { cancelGraceMs: 10_000 })
      const bridge = await t.open()
      const id = await start(bridge, t.main, 'hold early')
      await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
      const { detail, ms } = await stop(bridge, id)
      expect(ms).toBeLessThan(3_000)
      expect(detail.summary.status).toBe('cancelled')
      expect((await t.log()).some(entry => entry.event === 'command-started')).toBe(false)
    })

    it('ends Codex when its own interrupted turn leaves a command running past the bound', async () => {
      quick({ commandMs: 200, unaskedMs: 800 })
      const { bridge, id, pid } = await holding('hold self', { FAKE_CODEX_TERMINALS: 'none' })
      const detail = await settled(bridge, id)
      expect(detail.summary.status).toBe('interrupted')
      expect(detail.summary.runEnd).toMatchObject({
        reason: 'forced-stop',
        unknownResults: [expect.objectContaining({ messageId: row(detail)?.id })],
      })
      expect(row(detail)).toMatchObject({ state: 'failed', text: expect.stringContaining('TOOL_OUTCOME_UNKNOWN') })
      expect(alive(pid)).toBe(false)
    })

    describe('never confirmed while it may still run: left to the cancel limit', () => {
      async function unconfirmed(prompt: string, env: Record<string, string>) {
        quick({ commandMs: 200 })
        const found = await holding(prompt, { FAKE_CODEX_TERMINALS: 'ignore', ...env }, { cancelGraceMs: 2_000 })
        const { detail, ms } = await stop(found.bridge, found.id)
        expect(ms).toBeGreaterThanOrEqual(1_900)
        expect(detail.summary.status).toBe('interrupted')
        expect(said(detail, 'system')).toContain('已强制结束 Codex 进程')
        expect(row(detail)?.text).not.toContain('TOOL_NOT_STARTED')
        return found
      }

      it('when the process Codex names is not one of its own, which is left alone', async () => {
        const foreign = spawn('sleep', ['600'], { stdio: 'ignore' })
        cleanups.push(() => void foreign.kill('SIGKILL'))
        const { pid } = await unconfirmed('hold on', { FAKE_CODEX_OS_PID: String(foreign.pid) })
        expect(alive(foreign.pid!)).toBe(true)
        // The limit ends Codex with the command it started in a group of its own.
        expect(alive(pid)).toBe(false)
      })

      it('when the process list cannot be read', async () => {
        setProcessLister(async () => undefined)
        cleanups.push(() => setProcessLister(undefined))
        await unconfirmed('hold on', {})
      })

      it('when the command’s group outlives its leader', async () => {
        const { pid } = await unconfirmed('hold orphan', {})
        expect(alive(pid)).toBe(false)
      })
    })

    it('with no way to find the command, ends Codex and what it started once the grace runs out, and says so', async () => {
      const { bridge, id, pid } = await holding('hold on', { FAKE_CODEX_TERMINALS: 'none' }, { cancelGraceMs: 800 })
      const { detail } = await stop(bridge, id)
      expect(alive(pid)).toBe(false)
      expect(detail.summary.status).toBe('interrupted')
      expect(said(detail, 'system')).toContain('已强制结束 Codex 进程')
      expect(row(detail)?.text).not.toContain('TOOL_NOT_STARTED')
    })
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
    expect(done.messages.filter(message => message.role === 'tool')).toHaveLength(1)
    expect(done.messages.find(message => message.role === 'tool')).toMatchObject({ state: 'completed' })
    expect(done.summary.runEnd?.unknownResults ?? []).toEqual([])
    expect((await t.log()).find(entry => entry.event === 'answered' && entry.method === 'tool')?.answer).toEqual({
      action: 'accept',
      content: {},
    })
  })

  it.each([
    { prompt: 'tool-fail', action: 'allow', state: 'failed', unknown: 0 },
    { prompt: 'tool', action: 'reject', state: 'failed', unknown: 0 },
    { prompt: 'tool-unsettled', action: 'allow', state: 'failed', unknown: 1 },
  ] as const)('settles MCP $prompt only from its own native result after $action', async ({ prompt, action, state, unknown }) => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, prompt)
    const waiting = await until(bridge, id, detail => detail.summary.status === 'waiting-approval')
    await bridge.decide(waiting.approvals[0]!.id, action)
    const done = await settled(bridge, id)
    const tools = done.messages.filter(message => message.role === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]!.state).toBe(state)
    expect(done.summary.runEnd?.unknownResults ?? []).toHaveLength(unknown)
  })

  it('keeps opposite decisions for parallel same-name MCP calls with different arguments and reverse completion', async () => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, 'tool-parallel')
    const waiting = await until(bridge, id, detail => detail.approvals.length === 2)
    const first = waiting.approvals.find(item => item.arguments?.includes('latch-0'))!
    const second = waiting.approvals.find(item => item.arguments?.includes('latch-1'))!
    await bridge.decide(second.id, 'reject')
    await bridge.decide(first.id, 'allow')
    const done = await settled(bridge, id)
    const tools = done.messages.filter(message => message.role === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools.find(item => item.tool?.input?.includes('latch-0'))).toMatchObject({
      state: 'completed',
      tool: { decision: { outcome: 'allowed' } },
    })
    expect(tools.find(item => item.tool?.input?.includes('latch-1'))).toMatchObject({
      state: 'failed',
      tool: { decision: { outcome: 'rejected' } },
    })
    expect(done.summary.runEnd?.unknownResults ?? []).toEqual([])
  })

  it.each([
    { prompt: 'tool-ambiguous', count: 2 },
    { prompt: 'tool-wrong-turn', count: 1 },
    { prompt: 'tool-missing-fields', count: 1 },
    { prompt: 'tool-not-started', count: 1 },
  ])('does not attach an MCP approval to $prompt without unique same-turn evidence', async ({ prompt, count }) => {
    const t = await computer()
    const bridge = await t.open()
    const id = await start(bridge, t.main, prompt)
    const waiting = await until(bridge, id, detail => detail.approvals.length === count)
    for (const approval of waiting.approvals) await bridge.decide(approval.id, 'allow')
    const done = await settled(bridge, id)
    const tools = done.messages.filter(message => message.role === 'tool')
    expect(tools).toHaveLength(count * 2)
    expect(tools.filter(item => item.state === 'completed')).toHaveLength(count)
    expect(done.summary.runEnd?.unknownResults ?? []).toHaveLength(count)
  })

  it('keeps parent and child MCP approvals separate even when their native IDs and arguments match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-codex-child-mcp-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const asks: Array<{ toolCall: { toolCallId: string; _meta?: Record<string, unknown> } }> = []
    const updates: Array<{ update?: { toolCallId?: string; status?: string; _meta?: Record<string, unknown> } }> = []
    const wire = CodexWire.spawn(
      {
        command: process.execPath,
        args: [FAKE_CODEX_APP_SERVER],
        cwd: root,
        env: { PATH: process.env.PATH },
        maxLineBytes: 1 << 20,
        redact: text => text,
      },
      {
        request: async (_method, params) => {
          asks.push(params as (typeof asks)[number])
          return { outcome: { outcome: 'selected', optionId: 'accept' } }
        },
        notification: (_method, params) => {
          updates.push(params as (typeof updates)[number])
        },
        exit: () => {},
      },
    )
    cleanups.push(() => void wire.stop('kill', 100))
    await wire.request('initialize', {}, 5_000)
    const opened = (await wire.request('session/new', { cwd: root, mcpServers: [] }, 5_000)) as { sessionId: string }
    await wire.request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text: 'tool-child' }] }, 5_000)
    expect(asks).toHaveLength(2)
    expect(asks[0]!.toolCall.toolCallId).toBe(asks[1]!.toolCall.toolCallId)
    expect(asks[0]!.toolCall.toolCallId).not.toContain('approval')
    expect(asks[0]!.toolCall._meta?.['latch/codexChild']).toBeUndefined()
    expect(asks[1]!.toolCall._meta?.['latch/codexChild']).toMatchObject({ id: 'thread-mcp-child', parentID: opened.sessionId })
    const completed = updates.filter(item => item.update?.status === 'completed')
    expect(completed).toHaveLength(2)
    expect(completed[0]!.update?._meta?.['latch/codexChild']).toMatchObject({ id: 'thread-mcp-child' })
    expect(completed[1]!.update?._meta?.['latch/codexChild']).toBeUndefined()
  })

  it('does not let a late MCP answer from a stopped turn approve the next same-name call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-codex-late-mcp-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const logFile = join(root, 'codex.jsonl')
    const answers: Array<(value: unknown) => void> = []
    const wire = CodexWire.spawn(
      {
        command: process.execPath,
        args: [FAKE_CODEX_APP_SERVER],
        cwd: root,
        env: { PATH: process.env.PATH, FAKE_ACP_LOG: logFile },
        maxLineBytes: 1 << 20,
        redact: text => text,
      },
      { request: () => new Promise(resolve => answers.push(resolve)), notification: () => {}, exit: () => {} },
    )
    cleanups.push(() => void wire.stop('kill', 100))
    await wire.request('initialize', {}, 5_000)
    const opened = (await wire.request('session/new', { cwd: root, mcpServers: [] }, 5_000)) as { sessionId: string }
    const prompt = () => wire.request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text: 'tool' }] }, 5_000)
    const old = prompt().catch(error => error)
    await vi.waitFor(() => expect(answers).toHaveLength(1))
    wire.notify('session/cancel')
    await expect(old).resolves.toMatchObject({ stopReason: 'cancelled' })
    const next = prompt().catch(error => error)
    await vi.waitFor(() => expect(answers).toHaveLength(2))
    answers[0]!({ outcome: { outcome: 'selected', optionId: 'accept' } })
    await vi.waitFor(async () => {
      const rows = (await readFile(logFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as LogEntry)
      expect(
        rows.find(entry => entry.event === 'recv' && entry.result && (entry.result as { action?: string }).action === 'cancel'),
      ).toBeDefined()
    })
    answers[1]!({ outcome: { outcome: 'selected', optionId: 'accept' } })
    await expect(next).resolves.toMatchObject({ stopReason: 'end_turn' })
  })

  it('cancels a late MCP allow while the same turn is cancelling but has not settled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-codex-cancelling-mcp-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const logFile = join(root, 'codex.jsonl')
    let answer: ((value: unknown) => void) | undefined
    const wire = CodexWire.spawn(
      {
        command: process.execPath,
        args: [FAKE_CODEX_APP_SERVER],
        cwd: root,
        env: { PATH: process.env.PATH, FAKE_ACP_LOG: logFile, FAKE_CODEX_INTERRUPT_MS: '2000' },
        maxLineBytes: 1 << 20,
        redact: text => text,
      },
      {
        request: () =>
          new Promise(resolve => {
            answer = resolve
          }),
        notification: () => {},
        exit: () => {},
      },
    )
    cleanups.push(() => void wire.stop('kill', 100))
    await wire.request('initialize', {}, 5_000)
    const opened = (await wire.request('session/new', { cwd: root, mcpServers: [] }, 5_000)) as { sessionId: string }
    const run = wire
      .request('session/prompt', { sessionId: opened.sessionId, prompt: [{ type: 'text', text: 'tool' }] }, 5_000)
      .catch(error => error)
    await vi.waitFor(() => expect(answer).toBeDefined())
    wire.notify('session/cancel')
    answer!({ outcome: { outcome: 'selected', optionId: 'accept' } })
    await expect(run).resolves.toMatchObject({ stopReason: 'cancelled' })
    const rows = (await readFile(logFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as LogEntry)
    expect(rows.find(entry => entry.event === 'answered' && entry.method === 'tool')?.answer).toEqual({ action: 'cancel' })
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

  describe('Codex’s own MCP servers', () => {
    const OWN = JSON.stringify([
      {
        name: 'github',
        runtimeStatus: 'connected',
        httpOrigin: 'https://api.github.com/mcp?x=1',
        tools: { a: {}, b: {} },
        authStatus: 'bearerToken',
      },
      { name: 'linear', runtimeStatus: 'authenticationRequired', tools: {}, authStatus: 'notLoggedIn' },
      { name: 'plugin-docs', runtimeStatus: 'connected', tools: {}, authStatus: 'unsupported', threadOnly: true },
    ])

    it('reads the thread’s servers without starting any, leaves Latch’s own out, and follows each start Codex reports', async () => {
      const toolGateway: ToolGateway = {
        open: () => undefined,
        openMcp: async () => [
          {
            name: 'files',
            socketPath: '/tmp/latch-test/tools/gateway.sock',
            tokenFile: '/tmp/latch-test/tools/f.lbt',
            token: `lbt1.${'f'.repeat(43)}`,
            close() {},
          },
        ],
      }
      const t = await computer({ FAKE_CODEX_MCP: OWN }, [], {}, { toolGateway })
      const bridge = await t.open()
      expect(bridge.ownMcp?.()).toEqual({})
      await settled(bridge, await start(bridge, t.main, 'echo hi'))
      await vi.waitFor(() => expect(bridge.ownMcp?.()?.last?.servers.find(server => server.name === 'github')?.state).toBe('ready'))
      await vi.waitFor(() => expect(bridge.ownMcp?.()?.last?.servers.find(server => server.name === 'linear')?.state).toBe('needs-login'))
      const last = bridge.ownMcp!()!.last!
      expect(last.via).toBe('session')
      expect(last.servers.map(server => server.name).sort()).toEqual(['github', 'linear', 'plugin-docs'])
      expect(last.servers.find(server => server.name === 'github')).toMatchObject({ tools: 2, origin: 'https://api.github.com' })
      expect(last.servers.find(server => server.name === 'github')?.login).toBeUndefined()
      expect(last.servers.find(server => server.name === 'linear')?.login).toBe('codex mcp login linear')
      const log = await t.log()
      expect(sent(log, 'mcpServerStatus/list')[0]!.params).toMatchObject({ detail: 'toolsAndAuthOnly', threadId: expect.any(String) })
    })

    it('读取 asks a process with no thread, in an empty folder of its own, and keeps the names Codex gives without a state', async () => {
      const t = await computer({ FAKE_CODEX_MCP: OWN })
      const bridge = await t.open()
      await bridge.readOwnMcp!()
      const read = bridge.ownMcp!()!
      expect(read.running).toBeUndefined()
      expect(read.last).toMatchObject({ via: 'read', namesOnly: true })
      expect(read.last!.servers).toEqual([
        { name: 'github', state: 'unknown', origin: 'https://api.github.com' },
        { name: 'linear', state: 'unknown' },
      ])
      const log = await t.log()
      const listed = sent(log, 'mcpServerStatus/list')
      expect(listed).toHaveLength(1)
      expect(listed[0]!.params).not.toHaveProperty('threadId')
      const started = log.filter(entry => entry.event === 'start').at(-1) as LogEntry & { cwd: string }
      expect(started.cwd).not.toBe(t.main)
      expect(sent(log, 'thread/start')).toHaveLength(0)
    })

    it('never replaces a session’s report with names alone', async () => {
      const t = await computer({ FAKE_CODEX_MCP: OWN })
      const bridge = await t.open()
      await settled(bridge, await start(bridge, t.main, 'echo hi'))
      await vi.waitFor(() => expect(bridge.ownMcp?.()?.last?.servers.find(server => server.name === 'github')?.state).toBe('ready'))
      await vi.waitFor(() => expect(bridge.ownMcp?.()?.last?.servers.find(server => server.name === 'linear')?.state).toBe('needs-login'))
      await vi.waitFor(() => expect(bridge.ownMcp?.()?.last?.servers.find(server => server.name === 'plugin-docs')?.state).toBe('ready'))
      const session = bridge.ownMcp!()!.last!
      await bridge.readOwnMcp!()
      expect(bridge.ownMcp!()!.last).toEqual(session)
      expect(sent(await t.log(), 'mcpServerStatus/list').at(-1)!.params).not.toHaveProperty('threadId')
    })

    it('shows a name with hidden characters written out, and gives a login command only for a plain one Codex says needs it', () => {
      expect(codexMcpServer('evil\u202eserver', 'needs-login').name).not.toContain('\u202e')
      expect(codexMcpServer('evil\u202eserver', 'needs-login').login).toBeUndefined()
      expect(codexMcpServer('a;rm -rf ~', 'needs-login').login).toBeUndefined()
      expect(codexMcpServer('ok-name', 'failed').login).toBeUndefined()
      expect(codexMcpServer('ok-name', 'needs-login').login).toBe('codex mcp login ok-name')
      // A leading `-` would read as one of Codex's own options.
      expect(codexMcpServer('-h', 'needs-login').login).toBeUndefined()
      expect(codexMcpServer('--help', 'needs-login').login).toBeUndefined()
    })

    it('gives the whole read one deadline, not one per page', async () => {
      const cwd = await realpath(await mkdtemp(join(tmpdir(), 'latch-codex-deadline-')))
      cleanups.push(() => rm(cwd, { recursive: true, force: true }))
      const servers = JSON.stringify([1, 2, 3].map(at => ({ name: `s${at}`, runtimeStatus: 'connected', tools: {} })))
      const wire = (pageMs: string) =>
        CodexWire.spawn(
          {
            command: process.execPath,
            args: [FAKE_CODEX_APP_SERVER],
            cwd,
            env: { ...process.env, FAKE_CODEX_MCP: servers, FAKE_CODEX_MCP_LIMIT: '1', FAKE_CODEX_MCP_PAGE_MS: pageMs },
            maxLineBytes: 1 << 20,
            redact: text => text,
          },
          { request: async () => ({}), notification: () => {}, exit: () => {} },
        )
      const slow = wire('150')
      cleanups.push(() => void slow.stop('kill', 100))
      await slow.request('initialize', {}, 5_000)
      // Each page alone is well within 300 ms; the three together are not.
      await expect(slow.request(MCP_STATUS_METHOD, {}, 300)).rejects.toBeInstanceOf(RequestTimeout)
      const quick = wire('10')
      cleanups.push(() => void quick.stop('kill', 100))
      await quick.request('initialize', {}, 5_000)
      expect(((await quick.request(MCP_STATUS_METHOD, {}, 300)) as { servers: unknown[] }).servers).toHaveLength(3)
    })
  })
})
