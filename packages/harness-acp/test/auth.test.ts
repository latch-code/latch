// Logins a harness advertises for a terminal, what it pushes about its own login, and logging out; with the fake agent
// only. Nothing here can reach a program installed on this computer: every lookup is a temporary directory.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bridge, HarnessDriver, HarnessPlugin } from '@latch/sdk'
import type { DriverTaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { reportedLogin, terminalLogins } from '../src/auth.ts'
import { createAcpAgentPlugin, forgetCommandLookups, resolveCommand, setCommandSearch, type AgentRecord } from '../src/index.ts'
import { harnessLogin, loginTerminalScript } from '../src/login.ts'
import { agentProbePreview, probeAgent } from '../src/probe.ts'
import { readClaudeStatus } from '../src/profiles/claude-agent.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setCommandSearch(undefined)
  forgetCommandLookups()
})

let requests = 0
const rid = () => `auth-${++requests}`
const EMAIL = 'person@example.com'

async function activate(plugin: HarnessPlugin): Promise<HarnessDriver> {
  const drivers: HarnessDriver[] = []
  const disposers: Array<() => void | Promise<void>> = []
  await plugin.activate({
    registerHarness: driver => {
      drivers.push(driver)
    },
    registerProvider: () => {},
    registerTool: () => {},
    registerClientPanel: () => {},
    registerSkill: () => {},
    registerTransport: () => {},
    registerUiPanel: () => {},
    onDispose: dispose => {
      disposers.push(dispose)
    },
  })
  cleanups.push(async () => {
    for (const dispose of disposers.reverse()) await dispose()
  })
  return drivers[0]!
}

/** `fake-agent` in `bin`: the fake ACP agent with these variables, found by name as an installed command would be. */
async function install(bin: string, env: Record<string, string>): Promise<string> {
  await mkdir(bin, { recursive: true })
  const exports = Object.entries(env).map(([name, value]) => `export ${name}='${value}'`)
  await writeFile(join(bin, 'fake-agent'), ['#!/bin/sh', ...exports, `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`, ''].join('\n'))
  await chmod(join(bin, 'fake-agent'), 0o755)
  return join(bin, 'fake-agent')
}

async function setup(env: Record<string, string>, overrides: Partial<AgentRecord> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'latch-auth-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const tmpRoot = join(root, 'run-tmp')
  await mkdir(workspace)
  await mkdir(tmpRoot, { mode: 0o700 })
  const loginFile = join(root, 'login')
  const logFile = join(root, 'agent.log')
  const agentEnv = {
    FAKE_ACP_LOGIN_FILE: loginFile,
    FAKE_ACP_LOG: logFile,
    FAKE_ACP_STATE: join(root, 'state.json'),
    FAKE_ACP_CAPS: 'resume',
    ...env,
  }
  const program = await install(bin, agentEnv)
  setCommandSearch(() => [bin])
  forgetCommandLookups()
  // An id per test: login facts are kept per definition for the life of the Host process.
  const record: AgentRecord = {
    id: `fake-${requests++}`,
    name: 'Fake',
    command: 'fake-agent',
    args: [],
    env: {},
    enabled: true,
    ...overrides,
  }
  const driver = await activate(
    createAcpAgentPlugin(record, { cancelGraceMs: 300, stopGraceMs: 200, restartDelayMs: 0, requestTimeoutMs: 5_000 }),
  )
  const bridge: Bridge = driver.create({
    dataDir,
    workspaceRoot: workspace,
    tmpRoot,
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
  const start = async (prompt: string): Promise<string> => {
    const { launchHash } = await bridge.launchPreview!({ cwd: workspace })
    return (await bridge.createTask({ prompt, requestId: rid(), expectedLaunchHash: launchHash })).sessionId
  }
  const turn = async (prompt: string): Promise<DriverTaskDetail> => {
    const sessionId = await start(prompt)
    await vi.waitFor(async () => expect(['running', 'waiting-approval']).not.toContain((await bridge.detail(sessionId)).summary.status), {
      timeout: 8_000,
      interval: 10,
    })
    return bridge.detail(sessionId)
  }
  const log = async () =>
    (await readFile(logFile, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event: string; method?: string; params?: Record<string, unknown> })
  return { root, bin, dataDir, loginFile, program, record, driver, bridge, start, turn, log }
}

describe('what an agent advertises about logging in', () => {
  it('keeps terminal logins only, and drops one that names a variable Latch controls', () => {
    const methods: Parameters<typeof terminalLogins>[0] = [
      { id: 'agent', name: 'Agent login' },
      { id: 'tty', name: 'Terminal', description: 'In a terminal', type: 'terminal', args: ['--login'], env: { MODE: '1' } },
      { id: 'loader', name: 'Loader', type: 'terminal', args: [], env: { NODE_OPTIONS: '--require x' } },
      { id: 'home', name: 'Home', type: 'terminal', env: { codex_home: '/tmp/x' } },
      { id: 'dyld', name: 'Dyld', type: 'terminal', env: { DYLD_INSERT_LIBRARIES: '/tmp/x' } },
      { id: 'bad-name', name: 'Bad', type: 'terminal', env: { 'A=B': '1' } },
      { id: 'tty', name: 'Same id again', type: 'terminal' },
      { id: 'many', name: 'Many', type: 'terminal', args: Array.from({ length: 17 }, () => 'x') },
      { id: 'nul', name: 'Nul', type: 'terminal', args: ['a\0b'] },
    ]
    expect(terminalLogins(methods)).toEqual([
      { id: 'tty', name: 'Terminal', description: 'In a terminal', args: ['--login'], env: { MODE: '1' } },
    ])
  })

  it('reads the kind of credential and its label from a push, never the account', () => {
    const account = reportedLogin({
      authStatus: { kind: 'account', label: 'ChatGPT Plus', account: { email: EMAIL, organization: 'Org' } },
    })
    expect(account).toEqual({ status: 'authenticated', label: 'ChatGPT Plus' })
    expect(JSON.stringify(account)).not.toContain(EMAIL)
    expect(reportedLogin({ authStatus: { kind: 'api_key', label: 'OpenAI API key' } })).toEqual({
      status: 'authenticated',
      label: 'OpenAI API key',
    })
    expect(reportedLogin({ authStatus: { kind: 'account', label: `ChatGPT · ${EMAIL}` } })).toEqual({ status: 'authenticated' })
    expect(reportedLogin({ authStatus: { kind: 'api_key', label: `key sk-${'a'.repeat(40)}` } })?.label).not.toContain('a'.repeat(40))
    expect(reportedLogin({ authStatus: { kind: 'none', label: 'Not logged in' } })).toEqual({ status: 'unauthenticated' })
    expect(reportedLogin({ authStatus: { kind: 'something-new', label: 'x' } })).toEqual({ status: 'unknown' })
    expect(reportedLogin({ authStatus: { label: 'no kind' } })).toBeUndefined()
    // Hidden characters are shown, and the label is short.
    expect(reportedLogin({ authStatus: { kind: 'gateway', label: `a‮b${'x'.repeat(200)}` } })?.label).toMatch(/^a\\u\{202E\}bx+$/u)
    expect(reportedLogin({ authStatus: { kind: 'gateway', label: 'x'.repeat(200) } })?.label).toHaveLength(80)
  })

  it('reads only whether Claude holds a credential and when a stored sign-in ends', () => {
    const at = new Date(Date.now() + 5 * 24 * 60 * 60_000)
    const signedIn = JSON.stringify({
      loggedIn: true,
      email: EMAIL,
      orgName: 'Org',
      subscriptionType: 'max',
      loginExpiresAt: at.toISOString(),
    })
    expect(readClaudeStatus(signedIn)).toEqual({ status: 'authenticated', expiresAt: at.toISOString() })
    expect(JSON.stringify(readClaudeStatus(signedIn))).not.toContain(EMAIL)
    expect(
      readClaudeStatus(`warning: something\n${JSON.stringify({ loggedIn: true, loginExpiresAt: Math.floor(at.getTime() / 1000) })}`),
    ).toEqual({
      status: 'authenticated',
      expiresAt: new Date(Math.floor(at.getTime() / 1000) * 1000).toISOString(),
    })
    expect(readClaudeStatus(JSON.stringify({ loggedIn: false }))).toEqual({ status: 'unauthenticated' })
    expect(readClaudeStatus(JSON.stringify({ loggedIn: false, apiKeySource: 'ANTHROPIC_API_KEY' }))).toEqual({ status: 'authenticated' })
    expect(readClaudeStatus(JSON.stringify({ loggedIn: false, apiProvider: 'bedrock' }))).toEqual({ status: 'authenticated' })
    expect(readClaudeStatus(JSON.stringify({ loggedIn: true, loginExpiresAt: '3000-01-01T00:00:00Z' }))).toEqual({
      status: 'authenticated',
    })
    expect(readClaudeStatus(JSON.stringify({ loggedIn: true, loginExpiresAt: 'soon' }))).toEqual({ status: 'authenticated' })
    expect(readClaudeStatus('error: not json')).toEqual({ status: 'unknown' })
    expect(readClaudeStatus(JSON.stringify({ email: EMAIL }))).toEqual({ status: 'unknown' })
  })
})

describe('logging in through what the agent advertised', () => {
  it('offers the agent’s own terminal login, runs it as the program the sessions run, and never another program', async () => {
    const t = await setup({ FAKE_ACP_TERMINAL_LOGIN: 'bad' })
    await writeFile(t.loginFile, 'yes')
    expect(harnessLogin(t.record)).toBeUndefined()
    await t.turn('echo hi')
    const initialize = (await t.log()).find(entry => entry.event === 'recv' && entry.method === 'initialize')
    expect(initialize?.params?.clientCapabilities).toMatchObject({ auth: { terminal: true } })
    expect(harnessLogin(t.record)).toEqual({
      methods: [
        {
          id: 'fake-terminal',
          name: 'Fake terminal login',
          description: 'Log in from a terminal',
          command: 'FAKE_ACP_LOGIN_VIA=terminal fake-agent login',
        },
      ],
    })
    const script = loginTerminalScript(t.record, 'fake-terminal')!
    expect(script).toContain(`FAKE_ACP_LOGIN_VIA='terminal' '${t.program}' 'login'`)
    expect(script.startsWith('#!/bin/sh\nrm -f -- "$0"\n')).toBe(true)
    // In a Latch terminal the advertised login is the script's last command, so its exit code is the terminal's.
    expect(loginTerminalScript(t.record, 'fake-terminal', { inLatch: true })!.trimEnd().split('\n').at(-1)).toBe(
      `FAKE_ACP_LOGIN_VIA='terminal' '${t.program}' 'login'`,
    )
    expect(loginTerminalScript(t.record, 'fake-loader')).toBeUndefined()
    expect(loginTerminalScript(t.record, 'nothing')).toBeUndefined()

    // The script logs in when run, and says whether it did.
    await rm(t.loginFile)
    const file = join(t.root, 'login.command')
    await writeFile(file, script, { mode: 0o700 })
    const { execFile } = await import('node:child_process')
    const output = await new Promise<string>((resolve, reject) => {
      execFile('/bin/sh', [file], { env: { PATH: '/usr/bin:/bin' } }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
    })
    expect(existsSync(t.loginFile)).toBe(true)
    expect(output).toContain('完成后回到 Latch')
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })

    // Another program found under the same name does not inherit what the first one advertised.
    await install(join(t.root, 'other'), {})
    setCommandSearch(() => [join(t.root, 'other')])
    forgetCommandLookups()
    expect(resolveCommand('fake-agent')).toBe(join(t.root, 'other', 'fake-agent'))
    expect(harnessLogin(t.record)?.methods).toBeUndefined()
    expect(() => loginTerminalScript(t.record, 'fake-terminal')).toThrow(expect.objectContaining({ code: 'login-program-changed' }))
  })

  it('does not ask for terminal logins where the vendor leaves signing in to its own flow', async () => {
    const t = await setup({ FAKE_ACP_TERMINAL_LOGIN: '1', FAKE_ACP_LOGOUT: '1', FAKE_ACP_VERSION: '0.101.0' }, { presetId: 'claude-agent' })
    await writeFile(t.loginFile, 'yes')
    const preview = await agentProbePreview(t.record, { dataDir: t.dataDir, cwd: t.root })
    const result = await probeAgent(t.record, { dataDir: t.dataDir, cwd: t.root, expectedLaunchHash: preview.launchHash })
    expect(result.status).toBe('ready')
    expect(result.authMethods).toEqual([])
    const initialize = (await t.log()).find(entry => entry.event === 'recv' && entry.method === 'initialize')
    expect(initialize?.params?.clientCapabilities).not.toHaveProperty('auth')
    // Logging out is not logging in: it stays where the agent offers it.
    expect(harnessLogin(t.record)).toMatchObject({ logout: true, note: expect.stringContaining('Claude Code') })
    expect(harnessLogin(t.record)?.methods).toBeUndefined()
    // Only this test's folder is searched: nothing installed on this computer can be found, let alone run.
    for (const name of ['claude', 'claude-agent-acp', 'codex', 'codex-acp']) expect(resolveCommand(name)).toBeUndefined()
  })
})

describe('what the agent pushes about its login', () => {
  it('holds a push while the process that sent it runs, without the account', async () => {
    const t = await setup({ FAKE_ACP_AUTH_STATUS: '1' })
    await writeFile(t.loginFile, 'yes')
    await t.turn('echo hi')
    await vi.waitFor(() => expect(harnessLogin(t.record)?.reported).toEqual({ status: 'authenticated', label: 'ChatGPT Plus' }))
    expect(JSON.stringify(harnessLogin(t.record))).not.toContain(EMAIL)
    await t.bridge.close()
    expect(harnessLogin(t.record)?.reported).toBeUndefined()
    // Nothing the bridge kept on disk holds the account either. Read once it is closed: while it runs, a write's
    // temporary file can be renamed away between listing the folder and reading it.
    const files = await readdir(t.dataDir, { recursive: true })
    for (const name of files) {
      const path = join(t.dataDir, String(name))
      if ((await stat(path)).isFile()) expect(await readFile(path, 'utf8')).not.toContain(EMAIL)
    }
  })

  it('takes a push in a launch test instead of running the status command', async () => {
    const t = await setup({ FAKE_ACP_AUTH_STATUS: '1', FAKE_ACP_AUTH_STATUS_DELAY: '200' })
    const preview = await agentProbePreview(t.record, { dataDir: t.dataDir, cwd: t.root })
    const result = await probeAgent(t.record, { dataDir: t.dataDir, cwd: t.root, expectedLaunchHash: preview.launchHash })
    expect(result).toMatchObject({ status: 'ready', login: 'unauthenticated' })
    expect(JSON.stringify(result)).not.toContain(EMAIL)
  })

  it('waits only a moment for a push that never comes', async () => {
    const t = await setup({ FAKE_ACP_AUTH_STATUS: 'silent' })
    const preview = await agentProbePreview(t.record, { dataDir: t.dataDir, cwd: t.root })
    const started = Date.now()
    const result = await probeAgent(t.record, { dataDir: t.dataDir, cwd: t.root, expectedLaunchHash: preview.launchHash })
    expect(result.status).toBe('ready')
    expect(result.login).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

describe('logging out', () => {
  it('asks the agent to log out in a process of its own, then stops idle ones so the next turn reads the new login', async () => {
    const t = await setup({ FAKE_ACP_LOGOUT: '1', FAKE_ACP_AUTH_STATUS: '1' })
    await writeFile(t.loginFile, 'yes')
    const first = await t.turn('echo hi')
    expect(first.summary.runEnd).toBeUndefined()
    expect(harnessLogin(t.record)?.logout).toBe(true)
    await t.bridge.logout!()
    expect(existsSync(t.loginFile)).toBe(false)
    expect((await t.log()).filter(entry => entry.event === 'recv' && entry.method === 'logout')).toHaveLength(1)
    await vi.waitFor(() => expect(harnessLogin(t.record)?.reported).toBeUndefined())
    const refused = await t.turn('echo again')
    expect(refused.summary.runEnd?.reason).toBe('login-required')
  })

  it('is refused while a session runs, and asks the agent nothing', async () => {
    const t = await setup({ FAKE_ACP_LOGOUT: '1' })
    await writeFile(t.loginFile, 'yes')
    const sessionId = await t.start('hang')
    await vi.waitFor(async () => expect((await t.bridge.detail(sessionId)).summary.status).toBe('running'), {
      timeout: 8_000,
      interval: 10,
    })
    await expect(t.bridge.logout!()).rejects.toMatchObject({ code: 'harness-busy' })
    expect(existsSync(t.loginFile)).toBe(true)
    expect((await t.log()).filter(entry => entry.event === 'recv' && entry.method === 'logout')).toEqual([])
  })

  it('is refused where the agent does not offer it', async () => {
    const t = await setup({})
    await writeFile(t.loginFile, 'yes')
    await t.turn('echo hi')
    expect(harnessLogin(t.record)?.logout).toBeUndefined()
    await expect(t.bridge.logout!()).rejects.toMatchObject({ code: 'logout-unsupported' })
    expect(existsSync(t.loginFile)).toBe(true)
  })
})
