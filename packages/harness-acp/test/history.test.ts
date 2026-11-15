import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DriverTaskDetail } from '@latch/protocol'
import type { Bridge, HarnessDriver, HarnessPlugin, HostProject } from '@latch/sdk'
import {
  FAKE_ACP_AGENT,
  FAKE_HISTORY_SECRETS,
  fakeConversation,
  fakeLongConversation,
  writeFakeHistory,
  type FakeHistorySession,
} from '@latch/testkit'
import { createAcpAgentPlugin, forgetCommandLookups, setCommandSearch, type AcpAgentOptions, type AgentRecord } from '../src/index.ts'
import { adoptedMessages, CAPTURE_MESSAGES } from '../src/history.ts'
import { sessionList } from '../src/protocol.ts'

const FAST: AcpAgentOptions = { cancelGraceMs: 300, stopGraceMs: 200, restartDelayMs: 0, requestTimeoutMs: 5_000, log: () => {} }
const CODEX = {
  FAKE_ACP_CONFIG: 'options',
  FAKE_ACP_MODES: 'read-only,workspace-write,agent,agent-full-access',
  FAKE_ACP_INITIAL_MODE: 'agent-full-access',
  FAKE_ACP_CAPS: 'list,load,resume,close,delete,dirs',
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setCommandSearch(undefined)
  forgetCommandLookups()
})

interface LogEntry {
  pid: number
  event: string
  method?: string | null
  params?: Record<string, unknown>
  cwd?: string
}

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

/**
 * The fake agent as Codex (its profile, selected by preset), with a project `proj` of two folders and history sessions in
 * its primary folder, a subfolder, its other folder, outside it, one held elsewhere, and one too long to keep whole.
 */
async function fixture(
  env: Record<string, string> = {},
  overrides: Partial<AgentRecord> = { presetId: 'codex' },
  extra: (folders: { main: string; other: string }) => FakeHistorySession[] = () => [],
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-history-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const main = join(root, 'app')
  const other = join(root, 'docs')
  const outside = join(root, 'elsewhere')
  for (const folder of [main, join(main, 'packages', 'web'), other, outside]) await mkdir(folder, { recursive: true })
  await symlink(join(main, 'packages', 'web'), join(main, 'link'))
  const secret = FAKE_HISTORY_SECRETS.openai
  const chunk = (sessionUpdate: string, text: string) => ({ sessionUpdate, content: { type: 'text', text } })
  const dataDir = join(root, 'data')
  const tmpRoot = join(root, 'run-tmp')
  await mkdir(tmpRoot, { mode: 0o700 })
  const logFile = join(root, 'agent.log')
  const sessions: FakeHistorySession[] = [
    { sessionId: 'ext-main', cwd: main, title: 'Fix the login bug', updatedAt: '2026-11-10T08:00:00.000Z', updates: fakeConversation() },
    { sessionId: 'ext-sub', cwd: join(main, 'packages', 'web'), title: 'Web build', updatedAt: '2026-11-09T08:00:00.000Z', updates: [] },
    { sessionId: 'ext-other', cwd: other, title: 'Docs', updates: [] },
    { sessionId: 'ext-outside', cwd: outside, title: 'Private elsewhere', updates: [] },
    { sessionId: 'ext-busy', cwd: main, title: 'Open in a terminal', busy: true, updates: fakeConversation() },
    { sessionId: 'ext-long', cwd: main, title: 'Long', updates: fakeLongConversation(300, 6_000) },
    { sessionId: 'ext-link', cwd: join(main, 'link'), title: 'Through a link', updates: fakeConversation() },
    {
      sessionId: 'ext-split',
      cwd: main,
      title: 'Split key',
      updates: [
        chunk('user_message_chunk', `my key ${secret.slice(0, 14)}`),
        chunk('user_message_chunk', secret.slice(14)),
        chunk('agent_message_chunk', `echoed ${secret.slice(0, 20)}`),
        chunk('agent_message_chunk', secret.slice(20)),
      ],
    },
  ]
  sessions.push(...extra({ main, other }))
  const history = await writeFakeHistory(root, sessions)
  const record: AgentRecord = {
    id: 'codex',
    name: 'Codex',
    command: process.execPath,
    args: [FAKE_ACP_AGENT],
    enabled: true,
    env: { ...CODEX, FAKE_ACP_STATE: join(root, 'agent-state.json'), FAKE_ACP_LOG: logFile, FAKE_ACP_HISTORY_FILE: history, ...env },
    ...overrides,
  }
  const driver = await activate(createAcpAgentPlugin(record, FAST))
  const projects: HostProject[] = [
    {
      id: 'proj',
      folders: [
        { id: 'app', path: main },
        { id: 'docs', path: other },
      ],
    },
  ]
  const open = async (): Promise<Bridge> => {
    const bridge = driver.create({
      dataDir,
      workspaceRoot: main,
      tmpRoot,
      workspaces: () => projects.map(project => project.folders[0]!.path),
      projects: () => structuredClone(projects),
      providerId: 'unused',
      registry: {
        acquire() {
          throw new Error('unused')
        },
      },
      securityEvent: () => {},
    })
    cleanups.push(() => bridge.close())
    await bridge.start()
    return bridge
  }
  const place = (agentSessionId: string, cwd = main) => ({ agentSessionId, cwd, workspaceId: 'proj', folders: projects[0]!.folders })
  return {
    root,
    main,
    other,
    outside,
    tmpRoot,
    dataDir,
    driver,
    open,
    place,
    async log(): Promise<LogEntry[]> {
      const text = await readFile(logFile, 'utf8').catch(() => '')
      return text
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as LogEntry)
    },
  }
}

const received = (log: LogEntry[], method: string) => log.filter(entry => entry.event === 'recv' && entry.method === method)

/** The fake agent as OpenCode 2.x: its profile, its modes, and the session capabilities its 2.2.6 ACP service declares. */
const OPENCODE = {
  FAKE_ACP_CONFIG: 'options',
  FAKE_ACP_SHAPE: 'opencode',
  FAKE_ACP_MODES: 'plan,build,auto-edit,yolo',
  FAKE_ACP_INITIAL_MODE: 'yolo',
  FAKE_ACP_CAPS: 'list,load,resume,close,delete,dirs',
  FAKE_ACP_VERSION: '2.2.6',
}
const AS_OPENCODE: Partial<AgentRecord> = { presetId: 'opencode', id: 'opencode', name: 'OpenCode' }

async function settled(bridge: Bridge, id: string): Promise<DriverTaskDetail> {
  await vi.waitFor(async () => expect(['running', 'waiting-approval']).not.toContain((await bridge.detail(id)).summary.status), {
    timeout: 8_000,
    interval: 10,
  })
  return bridge.detail(id)
}

const newId = () => `task-${randomUUID()}`

describe('bringing in an earlier session of the agent', () => {
  it('declares itself only for a preset whose adapter was checked, and refuses the rest before starting anything', async () => {
    const codex = await fixture()
    expect(codex.driver.historyImport).toBe(true)
    const plain = await fixture({}, {})
    expect(plain.driver.historyImport).toBeUndefined()
    const bridge = await plain.open()
    await expect(bridge.listExternalSessions!()).rejects.toMatchObject({ status: 409, code: 'history-not-supported' })
    await expect(bridge.loadExternalSession!(plain.place('ext-main'))).rejects.toMatchObject({ code: 'history-not-supported' })
    expect(await plain.log()).toEqual([])
  })

  it('never sends session/list to an agent that does not declare it', async () => {
    const test = await fixture({ FAKE_ACP_CAPS: 'load,resume' })
    const bridge = await test.open()
    await expect(bridge.listExternalSessions!()).rejects.toMatchObject({ code: 'history-not-supported' })
    expect(received(await test.log(), 'session/list')).toEqual([])
  })

  it('lists page by page from a private empty folder, sends only initialize and session/list, and stops the process', async () => {
    const test = await fixture()
    const bridge = await test.open()
    const listed = await bridge.listExternalSessions!()
    expect(listed.truncated).toBe(false)
    expect(listed).not.toHaveProperty('withheld')
    expect(listed.sessions.map(row => row.agentSessionId)).toEqual([
      'ext-main',
      'ext-sub',
      'ext-other',
      'ext-outside',
      'ext-busy',
      'ext-long',
      'ext-link',
      'ext-split',
    ])
    expect(listed.sessions[0]).toEqual({
      agentSessionId: 'ext-main',
      cwd: test.main,
      title: 'Fix the login bug',
      updatedAt: '2026-11-10T08:00:00.000Z',
    })
    const log = await test.log()
    const methods = log.filter(entry => entry.event === 'recv' && entry.method).map(entry => entry.method)
    expect(new Set(methods)).toEqual(new Set(['initialize', 'session/list']))
    // Pages of two, each asked with the previous cursor; never with a cwd.
    expect(received(log, 'session/list').map(entry => entry.params)).toEqual([{}, { cursor: '2' }, { cursor: '4' }, { cursor: '6' }])
    const start = log.find(entry => entry.event === 'start')!
    expect(start.cwd!.startsWith(join(test.tmpRoot, 'history-'))).toBe(true)
    await vi.waitFor(async () => expect((await test.log()).some(entry => entry.event === 'stdin-end')).toBe(true))
    expect(existsSync(start.cwd!)).toBe(false)
  })

  it('binds before loading and keeps the replay: text and tools, output redacted, no thinking, nothing prompted', async () => {
    const test = await fixture()
    const bridge = await test.open()
    const load = await bridge.loadExternalSession!(test.place('ext-main'))
    expect(load.turns).toBe(2)
    expect(load.droppedBefore).toBe(0)
    expect(load.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user', 'assistant'])
    expect(load.messages.every(message => message.imported)).toBe(true)
    const all = JSON.stringify(load.messages)
    expect(all).not.toContain(FAKE_HISTORY_SECRETS.openai)
    expect(all).not.toContain(FAKE_HISTORY_SECRETS.gateway)
    expect(all).not.toContain('hidden reasoning')
    expect(load.messages[2]).toMatchObject({ role: 'tool', state: 'completed', tool: { title: 'Run printenv' } })
    expect(load.model).toBeTruthy()
    const log = await test.log()
    expect(received(log, 'session/prompt')).toEqual([])
    expect(received(log, 'session/load')[0]!.params).toEqual({
      sessionId: 'ext-main',
      cwd: test.main,
      mcpServers: [],
      additionalDirectories: [test.other],
    })
    // The process is held for the preview until it is closed: then session/close, and it stops.
    expect(log.some(entry => entry.event === 'stdin-end')).toBe(false)
    await bridge.closeExternalSession!(load.loadId)
    const closed = await test.log()
    expect(received(closed, 'session/close').map(entry => entry.params)).toEqual([{ sessionId: 'ext-main' }])
    expect(closed.some(entry => entry.event === 'stdin-end')).toBe(true)
  })

  it('refuses a session the agent holds open elsewhere, and one outside the project, without retrying', async () => {
    const test = await fixture()
    const bridge = await test.open()
    await expect(bridge.loadExternalSession!(test.place('ext-busy'))).rejects.toMatchObject({
      status: 409,
      code: 'history-session-busy',
    })
    expect(received(await test.log(), 'session/load')).toHaveLength(1)
    await expect(bridge.loadExternalSession!(test.place('ext-other', test.other))).rejects.toMatchObject({
      code: 'history-outside-project',
    })
    expect(received(await test.log(), 'session/load')).toHaveLength(1)
  })

  it('keeps the newest of an oversized replay and says how many it left to the agent', async () => {
    const test = await fixture()
    const bridge = await test.open()
    const load = await bridge.loadExternalSession!(test.place('ext-long'))
    expect(load.turns).toBe(300)
    expect(load.messages.at(-1)!.text.startsWith('answer 299 ')).toBe(true)
    const sessionId = newId()
    const adopted = await bridge.adoptExternalSession!({ ...test.place('ext-long'), sessionId, loadId: load.loadId, title: 'Long' })
    expect(adopted.messageCount).toBeLessThanOrEqual(500)
    expect(adopted.droppedBefore).toBe(600 - adopted.messageCount)
    const detail = await bridge.detail(sessionId)
    expect(detail.messages[0]).toMatchObject({ role: 'system', text: `更早的 ${adopted.droppedBefore} 条消息只在 Codex 里。` })
    expect(
      adoptedMessages(
        Array.from({ length: CAPTURE_MESSAGES }, (_, index) => ({ id: `${index}`, role: 'user', text: 'x' })),
        3,
      ),
    ).toMatchObject({
      droppedBefore: CAPTURE_MESSAGES - 500 + 3,
    })
  })

  it('adopts once per session ID, resumes it natively with Latch’s mode, and never deletes the agent’s own session', async () => {
    const test = await fixture()
    let bridge = await test.open()
    const load = await bridge.loadExternalSession!(test.place('ext-main'))
    const sessionId = newId()
    const input = { ...test.place('ext-main'), sessionId, loadId: load.loadId, title: 'Fix the login bug' }
    const adopted = await bridge.adoptExternalSession!(input)
    expect(adopted).toMatchObject({ sessionId, messageCount: 6, droppedBefore: 0 })
    // The model the agent's session reports, before any turn of Latch's.
    expect(load.model).toEqual(expect.any(String))
    expect((await bridge.detail(sessionId)).summary.model).toBe(load.model)
    // The same session ID answers again, also after a restart; another agent session under it is refused.
    expect((await bridge.adoptExternalSession!(input)).sessionId).toBe(sessionId)
    await bridge.close()
    bridge = await test.open()
    expect((await bridge.adoptExternalSession!(input)).sessionId).toBe(sessionId)
    await expect(bridge.adoptExternalSession!({ ...input, agentSessionId: 'ext-long' })).rejects.toMatchObject({ code: 'request-conflict' })
    // Nor is the same agent session adopted twice under another ID.
    await expect(bridge.adoptExternalSession!({ ...input, sessionId: newId(), loadId: undefined })).rejects.toMatchObject({
      code: 'history-already-imported',
    })
    // Not the driver's own session: never excluded as one, so the Host can show it as brought in.
    expect(bridge.agentSessionIds!()).not.toContain('ext-main')

    const detail = await bridge.detail(sessionId)
    expect(detail.summary).toMatchObject({ status: 'idle', cwd: test.main, workspaceId: 'proj', title: 'Fix the login bug' })
    expect(detail.messages.filter(message => message.imported)).toHaveLength(6)
    const before = received(await test.log(), 'session/load').length
    await bridge.prompt(sessionId, 'echo continue', `request-${randomUUID()}`)
    const after = await settled(bridge, sessionId)
    expect(after.summary.status).toBe('idle')
    expect(after.messages.at(-1)!.text).toBe('echo: echo continue')
    const log = await test.log()
    expect(received(log, 'session/resume').map(entry => entry.params?.sessionId)).toEqual(['ext-main'])
    expect(received(log, 'session/load')).toHaveLength(before)
    // The original ran in full access; Latch set its own default and read it back before the prompt.
    expect(received(log, 'session/set_config_option').map(entry => entry.params?.value)).toContain('read-only')
    expect(after.permission?.expectedMode).toBe('read-only')

    // A new context opens a session Latch owns; removing deletes that one only.
    await bridge.prompt(sessionId, 'echo fresh', `request-${randomUUID()}`, { freshContext: true })
    await settled(bridge, sessionId)
    const fresh = (
      JSON.parse(await readFile(join(test.dataDir, 'acp.json'), 'utf8')) as { tasks: Record<string, { acp: { acpSessionId: string } }> }
    ).tasks[sessionId]!.acp.acpSessionId
    expect(fresh).not.toBe('ext-main')
    await bridge.remove!(sessionId)
    await vi.waitFor(async () => expect(received(await test.log(), 'session/delete').length).toBeGreaterThan(0))
    await bridge.close()
    expect(received(await test.log(), 'session/delete').map(entry => entry.params?.sessionId)).toEqual([fresh])
  })

  it('loads again for an adoption whose preview is gone, and checks the place again', async () => {
    const test = await fixture()
    const bridge = await test.open()
    const sessionId = newId()
    await expect(
      bridge.adoptExternalSession!({ ...test.place('ext-outside', join(test.root, 'elsewhere')), sessionId, title: 'x' }),
    ).rejects.toMatchObject({ code: 'history-outside-project' })
    const adopted = await bridge.adoptExternalSession!({
      ...test.place('ext-sub', join(test.main, 'packages', 'web')),
      sessionId,
      title: 'Web build',
    })
    expect(adopted.sessionId).toBe(sessionId)
    expect((await bridge.detail(sessionId)).summary.cwd).toBe(join(test.main, 'packages', 'web'))
    expect(received(await test.log(), 'session/load')).toHaveLength(1)
    expect(await readdir(test.tmpRoot)).toEqual([])
  })

  it('records a seeded start with no turn and sends the seed only with the person’s first message', async () => {
    const test = await fixture()
    const bridge = await test.open()
    const { launchHash } = await bridge.launchPreview!({ cwd: test.main })
    const requestId = `request-${randomUUID()}`
    const start = { prompt: '', seed: 'SEED TEXT\n\n', requestId, cwd: test.main, expectedLaunchHash: launchHash }
    const { sessionId } = await bridge.createTask(start)
    expect((await bridge.createTask(start)).sessionId).toBe(sessionId)
    const waiting = await bridge.detail(sessionId)
    expect(waiting.summary.status).toBe('idle')
    expect(waiting.messages).toEqual([])
    const log = await test.log()
    expect(received(log, 'session/new')).toEqual([])
    expect(received(log, 'session/prompt')).toEqual([])
    await bridge.prompt(sessionId, 'echo first', `request-${randomUUID()}`)
    const after = await settled(bridge, sessionId)
    expect(after.messages[0]).toMatchObject({ role: 'user', text: 'SEED TEXT\n\necho first' })
    const prompts = received(await test.log(), 'session/prompt')
    expect(prompts).toHaveLength(1)
    expect((prompts[0]!.params!.prompt as Array<{ text: string }>)[0]!.text).toBe('SEED TEXT\n\necho first')
    // Only the first message carries it, and a first message in a new context carries none.
    const fresh = await bridge.createTask({ ...start, requestId: `request-${randomUUID()}` })
    await bridge.prompt(fresh.sessionId, 'echo fresh', `request-${randomUUID()}`, { freshContext: true })
    expect((await settled(bridge, fresh.sessionId)).messages.find(message => message.role === 'user')!.text).toBe('echo fresh')
    expect(JSON.stringify(received(await test.log(), 'session/prompt').at(-1)!.params)).not.toContain('SEED TEXT')
    await bridge.prompt(sessionId, 'echo second', `request-${randomUUID()}`)
    expect((await settled(bridge, sessionId)).messages.findLast(message => message.role === 'user')!.text).toBe('echo second')
  })

  it('works in the checked real folder, so a link swapped after the check cannot move the agent', async () => {
    const test = await fixture()
    const bridge = await test.open()
    const sessionId = newId()
    const web = join(test.main, 'packages', 'web')
    await bridge.adoptExternalSession!({ ...test.place('ext-link', join(test.main, 'link')), sessionId, title: 'Through a link' })
    const stored = JSON.parse(await readFile(join(test.dataDir, 'acp.json'), 'utf8')) as {
      tasks: Record<string, { summary: { cwd: string }; acp: { cwd: string; imported: { cwd: string } } }>
    }
    expect(stored.tasks[sessionId]!.acp).toMatchObject({ cwd: web, imported: { cwd: web } })
    expect(stored.tasks[sessionId]!.summary.cwd).toBe(web)
    // The link now points outside the project: the agent never goes through it.
    await rm(join(test.main, 'link'))
    await symlink(test.outside, join(test.main, 'link'))
    const starts = (await test.log()).filter(entry => entry.event === 'start').length
    await bridge.prompt(sessionId, 'echo inside', `request-${randomUUID()}`)
    expect((await settled(bridge, sessionId)).messages.at(-1)!.text).toBe('echo: echo inside')
    const log = await test.log()
    expect(
      log
        .filter(entry => entry.event === 'start')
        .slice(starts)
        .map(entry => entry.cwd),
    ).toEqual([web])
    expect(received(log, 'session/resume').map(entry => entry.params?.cwd)).toEqual([web])
    expect(received(log, 'session/load').map(entry => entry.params?.cwd)).toEqual([web])
  })

  it('refuses to go on once the folder of a session brought in resolves elsewhere', async () => {
    const test = await fixture()
    const bridge = await test.open()
    const sessionId = newId()
    const web = join(test.main, 'packages', 'web')
    await bridge.adoptExternalSession!({ ...test.place('ext-sub', web), sessionId, title: 'Web build' })
    // The folder itself is replaced by a link out of the project.
    await rm(web, { recursive: true })
    await symlink(test.outside, web)
    const starts = (await test.log()).filter(entry => entry.event === 'start').length
    await expect(bridge.prompt(sessionId, 'echo outside', `request-${randomUUID()}`)).rejects.toMatchObject({
      status: 409,
      code: 'workspace-changed',
    })
    const log = await test.log()
    expect(log.filter(entry => entry.event === 'start')).toHaveLength(starts)
    expect(received(log, 'session/resume')).toEqual([])
    expect(received(log, 'session/prompt')).toEqual([])
  })

  it('redacts a key the replay splits across chunks before anything keeps or sends it', async () => {
    const test = await fixture()
    const bridge = await test.open()
    const secret = FAKE_HISTORY_SECRETS.openai
    const load = await bridge.loadExternalSession!(test.place('ext-split'))
    expect(load.messages.map(message => message.text)).toEqual(['my key [redacted]', 'echoed [redacted]'])
    const sessionId = newId()
    await bridge.adoptExternalSession!({ ...test.place('ext-split'), sessionId, loadId: load.loadId, title: 'Split key' })
    expect(JSON.stringify((await bridge.detail(sessionId)).messages)).not.toContain(secret.slice(14))
    expect(await readFile(join(test.dataDir, 'acp.json'), 'utf8')).not.toContain(secret.slice(14))
  })

  it('counts a tool call’s diffs in what a session keeps', () => {
    const big = { id: 'd', role: 'tool' as const, text: '', tool: { diffs: [{ path: 'a', newText: 'x'.repeat(3 * 1024 * 1024) }] } }
    const small = { id: 's', role: 'user' as const, text: 'hello' }
    expect(adoptedMessages([big, big, small], 0)).toMatchObject({ droppedBefore: 1 })
  })

  it('reads session/list rows tolerantly: a row it cannot read is left out, not the page', () => {
    expect(
      sessionList.parse({
        sessions: [{ sessionId: 'a', cwd: '/x', title: 'T' }, { sessionId: 7 }, { sessionId: 'b', cwd: '/y', title: { not: 'text' } }],
        nextCursor: null,
      }),
    ).toEqual({
      sessions: [
        { sessionId: 'a', cwd: '/x', title: 'T' },
        { sessionId: 'b', cwd: '/y' },
      ],
      nextCursor: null,
    })
  })
})

describe('bringing in an earlier OpenCode session', () => {
  const granted = ({ main, other }: { main: string; other: string }): FakeHistorySession[] => [
    { sessionId: 'ext-granted', cwd: main, title: 'Granted elsewhere', additionalDirectories: [other], updates: fakeConversation() },
  ]

  it('declares itself for OpenCode, and not for pi, Qwen Code or goose, whose listing has no checked official interface', async () => {
    expect((await fixture(OPENCODE, AS_OPENCODE)).driver.historyImport).toBe(true)
    for (const presetId of ['pi', 'qwen', 'goose', 'claude-agent']) {
      const other = await fixture({}, { presetId, id: presetId, name: presetId })
      expect(other.driver.historyImport, presetId).toBeUndefined()
    }
    const qwen = await fixture({}, { presetId: 'qwen', id: 'qwen', name: 'Qwen Code' })
    await expect((await qwen.open()).listExternalSessions!()).rejects.toMatchObject({ code: 'history-not-supported' })
    expect(await qwen.log()).toEqual([])
  })

  it('refuses a version without session/list (1.x) before asking for a list, and a version line that was not checked', async () => {
    const old = await fixture({ ...OPENCODE, FAKE_ACP_CAPS: 'load,resume', FAKE_ACP_VERSION: '1.1.25' }, AS_OPENCODE)
    const bridge = await old.open()
    await expect(bridge.listExternalSessions!()).rejects.toMatchObject({ status: 409, code: 'history-not-supported' })
    await expect(bridge.loadExternalSession!(old.place('ext-main'))).rejects.toMatchObject({ code: 'history-not-supported' })
    const log = await old.log()
    expect(received(log, 'session/list')).toEqual([])
    expect(received(log, 'session/load')).toEqual([])

    // A version line the listing was not read in is not taken as checked on its capabilities alone.
    const unread = await fixture({ ...OPENCODE, FAKE_ACP_VERSION: '1.19.5' }, AS_OPENCODE)
    const other = await unread.open()
    await expect(other.listExternalSessions!()).rejects.toMatchObject({ status: 409, code: 'history-not-supported' })
    await expect(other.loadExternalSession!(unread.place('ext-main'))).rejects.toMatchObject({ code: 'history-not-supported' })
    expect(received(await unread.log(), 'session/list')).toEqual([])
    expect(received(await unread.log(), 'session/load')).toEqual([])
  })

  it('lists through the adapter alone and leaves out a session whose stored grants a load would rewrite', async () => {
    const test = await fixture(OPENCODE, AS_OPENCODE, granted)
    const bridge = await test.open()
    const listed = await bridge.listExternalSessions!()
    const ids = listed.sessions.map(row => row.agentSessionId)
    expect(ids).toContain('ext-main')
    expect(ids).not.toContain('ext-granted')
    expect(listed.sessions.every(row => !('additionalDirectories' in row))).toBe(true)
    // Told to the Host by directory alone, so it can count the ones in a project; never a title or an ID.
    expect(listed.withheld).toEqual([{ cwd: test.main }])
    const log = await test.log()
    expect(new Set(log.filter(entry => entry.event === 'recv' && entry.method).map(entry => entry.method))).toEqual(
      new Set(['initialize', 'session/list']),
    )
    // Listed from a private empty folder, never from the project or OpenCode's own directories.
    expect(log.find(entry => entry.event === 'start')!.cwd!.startsWith(join(test.tmpRoot, 'history-'))).toBe(true)
  })

  it('reads the row again before loading, and never loads a session that holds grants or is no longer listed', async () => {
    const test = await fixture(OPENCODE, AS_OPENCODE, granted)
    const bridge = await test.open()
    await expect(bridge.loadExternalSession!(test.place('ext-granted'))).rejects.toMatchObject({
      status: 409,
      code: 'history-session-changed',
    })
    await expect(bridge.loadExternalSession!(test.place('ext-gone'))).rejects.toMatchObject({ code: 'history-session-changed' })
    const log = await test.log()
    expect(received(log, 'session/load')).toEqual([])
    expect(received(log, 'session/prompt')).toEqual([])
    // Asked by the session's own directory, on the process that would have loaded it.
    expect(received(log, 'session/list').every(entry => entry.params?.cwd === test.main)).toBe(true)
  })

  it('previews without a prompt or folders of its own, adopts, resumes natively under Latch’s mode and never deletes the original', async () => {
    const test = await fixture(OPENCODE, AS_OPENCODE)
    const bridge = await test.open()
    const load = await bridge.loadExternalSession!(test.place('ext-main'))
    expect(load.turns).toBe(2)
    // OpenCode keeps no lock: a load that worked does not show the session is open nowhere else, and says so.
    expect(load.useUnknown).toBe(true)
    expect(load.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user', 'assistant'])
    const all = JSON.stringify(load.messages)
    expect(all).not.toContain(FAKE_HISTORY_SECRETS.openai)
    expect(all).not.toContain(FAKE_HISTORY_SECRETS.gateway)
    expect(all).not.toContain('hidden reasoning')
    let log = await test.log()
    // OpenCode gets no other folders from Latch, so the load stores none on the session.
    expect(received(log, 'session/load').map(entry => entry.params)).toEqual([{ sessionId: 'ext-main', cwd: test.main, mcpServers: [] }])
    expect(received(log, 'session/prompt')).toEqual([])

    const sessionId = newId()
    const input = { ...test.place('ext-main'), sessionId, loadId: load.loadId, title: 'Fix the login bug' }
    expect(await bridge.adoptExternalSession!(input)).toMatchObject({ sessionId, messageCount: 6, droppedBefore: 0 })
    await expect(bridge.adoptExternalSession!({ ...input, sessionId: newId(), loadId: undefined })).rejects.toMatchObject({
      code: 'history-already-imported',
    })
    expect(bridge.agentSessionIds!()).not.toContain('ext-main')

    const loads = received(await test.log(), 'session/load').length
    await bridge.prompt(sessionId, 'echo continue', `request-${randomUUID()}`)
    const after = await settled(bridge, sessionId)
    expect(after.summary.status).toBe('idle')
    expect(after.messages.at(-1)!.text).toBe('echo: echo continue')
    log = await test.log()
    expect(received(log, 'session/resume').map(entry => entry.params?.sessionId)).toEqual(['ext-main'])
    expect(received(log, 'session/load')).toHaveLength(loads)
    // Every load and resume went without folders, so none stored grants on the original.
    for (const entry of [...received(log, 'session/load'), ...received(log, 'session/resume')])
      expect(entry.params).not.toHaveProperty('additionalDirectories')
    // The original ran in the widest mode; Latch set its own default and read it back before the prompt.
    expect(received(log, 'session/set_config_option').map(entry => entry.params?.value)).toContain('build')
    expect(after.permission?.expectedMode).toBe('build')

    await bridge.remove!(sessionId)
    expect(received(await test.log(), 'session/delete')).toEqual([])
  })

  it('takes a refusal that names a lock or a session in use as held elsewhere, and does not retry', async () => {
    const test = await fixture(OPENCODE, AS_OPENCODE)
    const bridge = await test.open()
    await expect(bridge.loadExternalSession!(test.place('ext-busy'))).rejects.toMatchObject({ status: 409, code: 'history-session-busy' })
    expect(received(await test.log(), 'session/load')).toHaveLength(1)
  })
})
