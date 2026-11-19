import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DriverTaskDetail } from '@latch/protocol'
import type { Bridge, HarnessDriver, HarnessPlugin, HostProject } from '@latch/sdk'
import { FAKE_ACP_AGENT, FAKE_PI_AGENT } from '@latch/testkit'
import { createAcpAgentPlugin, forgetCommandLookups, setCommandSearch, type AcpAgentOptions } from '../src/index.ts'
import {
  deletePiSessionFile,
  listPiSessions,
  piFileId,
  piFolderName,
  piProjectTrust,
  piSessionRoot,
  readPiSession,
  type PiPlace,
} from '../src/pi-store.ts'
import { openWire } from '../src/wires/index.ts'

const FAST: AcpAgentOptions = { cancelGraceMs: 300, stopGraceMs: 200, restartDelayMs: 0, requestTimeoutMs: 5_000, log: () => {} }
const uid = process.getuid!()

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setCommandSearch(undefined)
  forgetCommandLookups()
})

async function temp(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`

/** A session file as pi 1.5.0 writes it: its header, then entries chained by `parentId`. */
async function sessionFile(
  directory: string,
  cwd: string,
  entries: Array<Record<string, unknown>>,
  options: { version?: number; id?: string } = {},
): Promise<string> {
  const id = options.id ?? randomUUID()
  await mkdir(directory, { recursive: true })
  const path = join(directory, `2026-11-19T10-00-00-000Z_${id}.jsonl`)
  let parentId: string | null = null
  const body = entries.map((entry, index) => {
    const item = { id: `e${index}`, parentId, timestamp: `2026-11-19T10:00:0${index % 10}.000Z`, ...entry }
    parentId = item.id as string
    return line(item)
  })
  await writeFile(
    path,
    line({ type: 'session', version: options.version ?? 3, id, timestamp: '2026-11-19T10:00:00.000Z', cwd }) + body.join(''),
  )
  return path
}

const user = (text: string) => ({ type: 'message', message: { role: 'user', content: text, timestamp: 1 } })
const reply = (text: string, tools: Array<{ id: string; name: string; arguments: unknown }> = []) => ({
  type: 'message',
  message: {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text }, ...tools.map(tool => ({ type: 'toolCall', ...tool }))],
  },
})
const result = (toolCallId: string, toolName: string, isError = false) => ({
  type: 'message',
  message: { role: 'toolResult', toolCallId, toolName, isError, content: [{ type: 'text', text: 'output stays out' }] },
})

/** Every path below `root` with its size and modification time, so a read can be shown to change nothing. */
async function tree(root: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name)
    const info = await stat(path).catch(() => undefined)
    out.push(`${path}:${info?.isFile() ? `${info.size}:${info.mtimeMs}` : 'dir'}`)
  }
  return out.sort()
}

describe('pi session store reads', () => {
  it('lists sessions by the folder in each header, never the lossy directory name, and changes nothing', async () => {
    const root = await temp('latch-pi-store-')
    const home = join(root, 'home')
    const agent = join(home, '.pi', 'agent')
    const sessions = join(agent, 'sessions')
    // `/a-b/c` and `/a/b-c` share one directory name in pi's layout.
    const project = join(root, 'a-b', 'c')
    const collision = join(root, 'a', 'b-c')
    for (const folder of [project, collision, join(project, 'web')]) await mkdir(folder, { recursive: true })
    expect(piFolderName(project)).toBe(piFolderName(collision))
    const shared = join(sessions, piFolderName(project))
    const named = await sessionFile(shared, project, [user('first words'), reply('ok'), { type: 'session_info', name: 'Named later' }])
    const plain = await sessionFile(shared, project, [user('  fix   the login  '), reply('done')])
    await sessionFile(shared, collision, [user('another project')])
    const below = await sessionFile(join(sessions, piFolderName(join(project, 'web'))), join(project, 'web'), [user('web')])
    // Not listed: an older format pi would rewrite, a file that is a link, a name that is not pi's.
    await sessionFile(shared, project, [user('old')], { version: 2 })
    await symlink(plain, join(shared, `2026-11-19T10-00-00-000Z_${randomUUID()}.jsonl`))
    await writeFile(join(shared, 'notes.jsonl'), line({ type: 'session', version: 3, id: 'notes', cwd: project }))
    const before = await tree(root)
    const place: PiPlace = { env: {}, home, uid }
    const listed = await listPiSessions(place, [project], 50)
    expect(listed.truncated).toBe(false)
    expect(listed.sessions.map(row => [row.path, row.cwd, row.title]).sort()).toEqual(
      [
        [named, project, 'Named later'],
        [plain, project, 'fix the login'],
        [below, join(project, 'web'), 'web'],
      ].sort(),
    )
    expect(await tree(root)).toEqual(before)
    // A folder that has no sessions creates nothing either.
    expect((await listPiSessions(place, [join(root, 'none')], 50)).sessions).toEqual([])
    expect(await listPiSessions({ env: {}, home: join(root, 'nobody'), uid }, [project], 50)).toEqual({ sessions: [], truncated: false })
    expect(existsSync(join(root, 'nobody'))).toBe(false)
    expect(await tree(root)).toEqual(before)
  })

  it('reads a flat session directory named by the environment or the global settings', async () => {
    const root = await temp('latch-pi-flat-')
    const project = join(root, 'proj')
    await mkdir(project)
    const flat = join(root, 'flat')
    const path = await sessionFile(flat, project, [user('flat one')])
    await sessionFile(flat, join(root, 'other'), [user('elsewhere')])
    const byEnv = await listPiSessions({ env: { PI_CODING_AGENT_SESSION_DIR: flat }, home: root, uid }, [project], 10)
    expect(byEnv.sessions.map(row => row.path)).toEqual([path])
    const agent = join(root, 'agent')
    await mkdir(agent)
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ sessionDir: flat, apiKey: 'not read' }))
    const bySetting = await listPiSessions({ env: { PI_CODING_AGENT_DIR: agent }, home: root, uid }, [project], 10)
    expect(bySetting.sessions.map(row => row.path)).toEqual([path])
  })

  it('previews the branch pi is on: messages as text, tools by name and how they ended', async () => {
    const root = await temp('latch-pi-read-')
    const project = join(root, 'proj')
    const path = await sessionFile(join(root, 's'), project, [
      user('read the file'),
      reply('reading', [{ id: 't1', name: 'read', arguments: { path: 'a.ts' } }]),
      result('t1', 'read'),
      { type: 'model_change', provider: 'anthropic', modelId: 'claude-x' },
      reply('done'),
    ])
    const read = await readPiSession(path, uid, project)
    expect(read?.model).toBe('anthropic/claude-x')
    expect(read?.updates.map(item => item.update)).toEqual([
      expect.objectContaining({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'read the file' } }),
      expect.objectContaining({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reading' } }),
      expect.objectContaining({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read a.ts', kind: 'read' }),
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
      expect.objectContaining({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }),
    ])
    expect(JSON.stringify(read)).not.toContain('output stays out')
    expect(JSON.stringify(read)).not.toContain('hidden')
    // Another folder's file is not this session's.
    expect(await readPiSession(path, uid, join(root, 'other'))).toBeUndefined()
  })

  it('deletes only an own session file of pi’s, in its store, of the folder it names', async () => {
    const root = await temp('latch-pi-delete-')
    const home = join(root, 'home')
    const sessions = join(home, '.pi', 'agent', 'sessions')
    const project = join(root, 'proj')
    await mkdir(project)
    const place: PiPlace = { env: {}, home, uid }
    const directory = join(sessions, piFolderName(project))
    const path = await sessionFile(directory, project, [user('bye')])
    const sibling = await sessionFile(directory, project, [user('stays')])
    // Another folder, a link, a file outside the store, a name that is not pi's: all left.
    expect(await deletePiSessionFile(path, join(root, 'other'), place)).toBe(false)
    const link = join(directory, `2026-11-19T10-00-00-000Z_${randomUUID()}.jsonl`)
    await symlink(sibling, link)
    expect(await deletePiSessionFile(link, project, place)).toBe(false)
    const outside = await sessionFile(join(root, 'elsewhere'), project, [user('outside')])
    expect(await deletePiSessionFile(outside, project, place)).toBe(false)
    const renamed = join(directory, 'copy.jsonl')
    await writeFile(renamed, await readFile(path))
    expect(await deletePiSessionFile(renamed, project, place)).toBe(false)
    expect(await deletePiSessionFile(path, project, place)).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(sibling) && existsSync(link) && existsSync(outside) && existsSync(renamed)).toBe(true)
  })

  it('says whether pi trusts a project’s .pi: the nearest decision, else the global default, else not', async () => {
    const root = await temp('latch-pi-trust-')
    const agent = join(root, 'agent')
    await mkdir(agent)
    const place: PiPlace = { env: { PI_CODING_AGENT_DIR: agent }, home: root, uid }
    const project = join(root, 'work', 'proj')
    expect(await piProjectTrust(place, project)).toBe('untrusted')
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'ask' }))
    expect(await piProjectTrust(place, project)).toBe('untrusted')
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always' }))
    expect(await piProjectTrust(place, project)).toBe('trusted')
    await writeFile(join(agent, 'trust.json'), JSON.stringify({ [join(root, 'work')]: false, [project]: null }))
    expect(await piProjectTrust(place, project)).toBe('untrusted')
    await writeFile(join(agent, 'trust.json'), JSON.stringify({ [join(root, 'work')]: false, [project]: true }))
    expect(await piProjectTrust(place, project)).toBe('trusted')
  })
})

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

async function start(bridge: Bridge, cwd: string, prompt: string): Promise<{ sessionId: string }> {
  const { launchHash } = await bridge.launchPreview!({ cwd })
  return bridge.createTask({ prompt, requestId: randomUUID(), cwd, expectedLaunchHash: launchHash })
}

async function settled(bridge: Bridge, id: string): Promise<DriverTaskDetail> {
  await vi.waitFor(async () => expect(['running', 'waiting-approval']).not.toContain((await bridge.detail(id)).summary.status), {
    timeout: 8_000,
    interval: 10,
  })
  return bridge.detail(id)
}

/** The fake pi as the pi preset, with its agent directory and session store in a temporary home. */
async function piFixture(options: { cliStore?: boolean } = {}) {
  const root = await temp('latch-pi-history-')
  const home = join(root, 'home')
  const agent = join(home, '.pi', 'agent')
  const main = join(root, 'app')
  await mkdir(main, { recursive: true })
  const store = join(agent, 'sessions', piFolderName(main))
  await mkdir(store, { recursive: true })
  const log = join(root, 'pi.log')
  const driver = await activate(
    createAcpAgentPlugin(
      {
        id: 'pi',
        name: 'pi',
        presetId: 'pi',
        command: process.execPath,
        args: [FAKE_PI_AGENT],
        enabled: true,
        env: { PI_CODING_AGENT_DIR: agent, FAKE_PI_SESSIONS: store, FAKE_PI_LOG: log },
      },
      { ...FAST, ...(options.cliStore === false ? {} : { cliStore: { home } }) },
    ),
  )
  const projects: HostProject[] = [{ id: 'proj', folders: [{ id: 'app', path: main }] }]
  const tmpRoot = join(root, 'run-tmp')
  await mkdir(tmpRoot, { mode: 0o700 })
  const open = async (): Promise<Bridge> => {
    const bridge = driver.create({
      dataDir: join(root, 'data'),
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
      securityEvent: () => {},
    })
    cleanups.push(() => bridge.close())
    await bridge.start()
    return bridge
  }
  const place = (agentSessionId: string) => ({ agentSessionId, cwd: main, workspaceId: 'proj', folders: projects[0]!.folders })
  const trace = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  return { root, home, agent, main, store, driver, open, place, trace }
}

describe('pi through Latch’s reads of its store', () => {
  it('offers nothing of pi’s store in a Host that may not read CLI stores', async () => {
    const pi = await piFixture({ cliStore: false })
    expect(pi.driver.historyImport).toBeUndefined()
    const bridge = await pi.open()
    await expect(bridge.listExternalSessions!()).rejects.toMatchObject({ code: 'history-not-supported' })
    const { sessionId } = await start(bridge, pi.main, 'hello')
    await settled(bridge, sessionId)
    const file = (await bridge.detail(sessionId)).summary
    expect(file).toBeDefined()
    const [written] = await readdir(pi.store)
    await bridge.remove!(sessionId)
    // Closing waits for the cleanup that follows a removal.
    await bridge.close()
    expect(await readdir(pi.store)).toEqual([written])
  })

  it('lists and previews without starting pi, adopts, resumes in its own folder, and deletes only its own file', async () => {
    const pi = await piFixture()
    expect(pi.driver.historyImport).toBe(true)
    const earlier = await sessionFile(pi.store, pi.main, [
      user('earlier question'),
      reply('earlier answer'),
      { type: 'thinking_level_change', thinkingLevel: 'medium' },
    ])
    const foreign = await sessionFile(pi.store, join(pi.root, 'elsewhere'), [user('not here')])
    const bridge = await pi.open()
    const listed = await bridge.listExternalSessions!()
    expect(listed.sessions.map(row => row.agentSessionId)).toEqual([earlier])
    expect(listed.sessions[0]).toMatchObject({ cwd: pi.main, title: 'earlier question' })
    const load = await bridge.loadExternalSession!(pi.place(earlier))
    expect(load.useUnknown).toBe(true)
    expect(load.messages.map(message => [message.role, message.text])).toEqual([
      ['user', 'earlier question'],
      ['assistant', 'earlier answer'],
    ])
    // A file of another folder is never loaded into this project.
    await expect(bridge.loadExternalSession!(pi.place(foreign))).rejects.toMatchObject({ code: 'history-session-changed' })
    expect(await pi.trace()).toEqual([])
    const before = await readFile(earlier, 'utf8')
    const sessionId = `task-${randomUUID()}`
    await bridge.adoptExternalSession!({ ...pi.place(earlier), sessionId, loadId: load.loadId, title: 'Brought in' })
    expect(await readFile(earlier, 'utf8')).toBe(before)
    expect(await pi.trace()).toEqual([])
    // The first turn opens the file in pi.
    await bridge.prompt(sessionId, 'go on', randomUUID())
    expect((await settled(bridge, sessionId)).summary.status).toBe('idle')
    expect((await pi.trace()).some(line => line.includes('"type":"switch_session"') && line.includes(earlier))).toBe(true)
    // Removing a session brought in leaves pi's file; one Latch started goes with it.
    await bridge.remove!(sessionId)
    const own = await start(bridge, pi.main, 'mine')
    await settled(bridge, own.sessionId)
    const files = (await readdir(pi.store)).filter(name => !before.includes(name))
    const mine = files.map(name => join(pi.store, name)).filter(path => path !== earlier && path !== foreign)
    expect(mine).toHaveLength(1)
    await bridge.remove!(own.sessionId)
    await vi.waitFor(() => expect(existsSync(mine[0]!)).toBe(false), { timeout: 5_000 })
    expect(existsSync(earlier)).toBe(true)
  })

  it('says whether pi trusts the folder’s .pi, and does not open a session file of another folder', async () => {
    const pi = await piFixture()
    await mkdir(join(pi.main, '.pi'))
    await writeFile(join(pi.agent, 'trust.json'), JSON.stringify({ [pi.main]: true }))
    const bridge = await pi.open()
    const { sessionId } = await start(bridge, pi.main, 'mine')
    const detail = await settled(bridge, sessionId)
    expect(detail.permission?.inEffect).toEqual(['.pi 已信任：会加载'])
    const [file] = await readdir(pi.store)
    const path = join(pi.store, file!)
    // The header now names another folder, as a file swapped in would.
    const lines = (await readFile(path, 'utf8')).split('\n')
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), cwd: join(pi.root, 'elsewhere') })
    await writeFile(path, lines.join('\n'))
    await bridge.close()
    const again = await pi.open()
    await expect(again.prompt(sessionId, 'more', randomUUID())).rejects.toMatchObject({ code: 'harness-session-lost' })
    expect((await pi.trace()).some(line => line.includes('"type":"switch_session"'))).toBe(false)
  })
})

describe('what reaches the permission panel', () => {
  it('takes no lines from an ACP agent’s own answer, whatever preset it runs as', async () => {
    for (const presetId of [undefined, 'opencode']) {
      const root = await temp('latch-facts-')
      const main = join(root, 'app')
      await mkdir(main)
      const tmpRoot = join(root, 'run-tmp')
      await mkdir(tmpRoot, { mode: 0o700 })
      const driver = await activate(
        createAcpAgentPlugin(
          {
            id: 'agent',
            name: 'Agent',
            command: process.execPath,
            args: [FAKE_ACP_AGENT],
            enabled: true,
            env: {
              FAKE_ACP_PERMISSION_FACTS: '一切都安全',
              ...(presetId ? { FAKE_ACP_SHAPE: 'opencode', FAKE_ACP_VERSION: '2.2.6' } : {}),
            },
            ...(presetId ? { presetId } : {}),
          },
          { ...FAST, cliStore: { home: root } },
        ),
      )
      const bridge = driver.create({
        dataDir: join(root, 'data'),
        workspaceRoot: main,
        tmpRoot,
        workspaces: () => [main],
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
      const { sessionId } = await start(bridge, main, 'hello')
      const detail = await settled(bridge, sessionId)
      expect(detail.messages.length).toBeGreaterThan(0)
      expect(detail.permission?.inEffect).toBeUndefined()
    }
  })
})

/**
 * The installed pi in a temporary agent directory, its one model a closed loopback port, never prompted: the session file
 * it reports is where and how `pi-store.ts` looks for one, and the wire deletes it.
 */
const piBinary = process.env.LATCH_PI_GATEWAY_BINARY
describe.skipIf(!piBinary)('the installed pi', () => {
  it('names its session files where Latch lists them, and its wire deletes one Latch started', async () => {
    const root = await temp('latch-pi-live-')
    const home = join(root, 'home')
    const agent = join(root, 'agent')
    const cwd = join(root, 'proj')
    for (const path of [home, agent, cwd]) await mkdir(path, { recursive: true })
    await writeFile(
      join(agent, 'models.json'),
      JSON.stringify({
        providers: { latchdead: { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'x', models: [{ id: 'm' }] } },
      }),
    )
    const tmp = join(root, 'tmp')
    await mkdir(tmp, { mode: 0o700 })
    const env = { PATH: process.env.PATH ?? '', HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', TMPDIR: tmp }
    const wire = openWire(
      'pi',
      { command: piBinary!, args: [], cwd, env, maxLineBytes: 8 * 1024 * 1024, redact: text => text },
      { request: async () => ({}), notification: () => {}, exit: () => {} },
      { cliStore: { home } },
    )
    cleanups.push(async () => void (await wire.stop('kill', 2_000)))
    const init = (await wire.request('initialize', { protocolVersion: 1 }, 30_000)) as {
      agentCapabilities: { sessionCapabilities: Record<string, unknown> }
    }
    expect(init.agentCapabilities.sessionCapabilities.delete).toEqual({})
    const { sessionId: path } = (await wire.request('session/new', { cwd, mcpServers: [] }, 30_000)) as { sessionId: string }
    const id = piFileId(path)
    expect(id).toBeDefined()
    const place: PiPlace = { env, home, uid }
    expect(join((await piSessionRoot(place))!.root, piFolderName(cwd))).toBe(join(path, '..'))
    // pi writes the file once something is said; written here as it would be, with the real ID and folder.
    await writeFile(
      path,
      line({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd })
        + line({
          type: 'message',
          id: 'a',
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: 'hello' },
        }),
    )
    expect((await listPiSessions(place, [cwd], 10)).sessions.map(row => row.path)).toEqual([path])
    expect(await wire.request('session/delete', { sessionId: path }, 30_000)).toEqual({ deleted: true })
    expect(existsSync(path)).toBe(false)
  }, 60_000)
})
