// The login routes in a real Host, with a fake program; nothing here can reach one installed on this computer.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HARNESS_LOGIN_SESSION, type HarnessInfo, type HarnessLoginTerminalResponse, type TerminalSummary } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import type { HelperEvent, LaunchTerminal, TerminalLaunch } from '../src/terminal/helper.ts'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(options: TestHostOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'latch-agent-login-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const bin = join(directory, 'bin')
  await mkdir(bin)
  const loginFile = join(directory, 'login')
  /** Written each time the login program starts. */
  const ranFile = join(directory, 'ran')
  for (const name of ['codex', 'codex-acp']) {
    await writeFile(
      join(bin, name),
      `#!/bin/sh\n${name === 'codex' ? `printf x >> '${ranFile}'\n` : ''}export FAKE_ACP_LOGIN_FILE='${loginFile}'\nexec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"\n`,
    )
    await chmod(join(bin, name), 0o755)
  }
  const scripts: string[] = []
  const t: TestHost = await startTestHost({
    tls: true,
    demo: false,
    detectPreset: preset => (preset.id === 'codex' ? { found: true, path: join(bin, 'codex-acp') } : { found: false }),
    loginPrograms: name => (existsSync(join(bin, name)) ? join(bin, name) : undefined),
    commandDirectories: () => [bin],
    loginTerminal: script => {
      scripts.push(script)
      return Promise.resolve()
    },
    ...options,
  })
  cleanups.push(() => t.close())
  return { t, scripts, loginFile, ranFile, bin }
}

const reply = async (response: Response) => [response.status, await response.json()] as const
const audited = async (t: TestHost, action: string) =>
  (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { action: string; detail: unknown })
    .filter(entry => entry.action === action)

describe('harness login routes', () => {
  it('answers in three states from the program, and remembers only for a moment', async () => {
    const { t, loginFile } = await fixture()
    const desktop = await t.enroll({ listener: 'unix', name: 'Mac', scopes: ['view', 'run', 'admin'] })
    expect(await reply(await desktop.request('harnesses/codex/login-status', { body: {} }))).toEqual([200, { status: 'unauthenticated' }])
    await writeFile(loginFile, 'yes')
    // Asked again without `fresh`, the cached answer stands; after logging in, the page asks for a fresh one.
    expect((await reply(await desktop.request('harnesses/codex/login-status', { body: {} })))[1]).toEqual({ status: 'unauthenticated' })
    await new Promise(resolve => setTimeout(resolve, 2100))
    expect((await reply(await desktop.request('harnesses/codex/login-status', { body: { fresh: true } })))[1]).toEqual({
      status: 'authenticated',
    })
    expect((await audited(t, 'agent.login.checked')).map(entry => entry.detail)).toEqual([
      { agentId: 'codex', status: 'unauthenticated' },
      { agentId: 'codex', status: 'authenticated' },
    ])
  })

  it('takes a test start’s different answer as newer than the one it remembers', async () => {
    const { t, loginFile } = await fixture()
    const desktop = await t.enroll({ listener: 'unix', name: 'Mac', scopes: ['view', 'run', 'admin'] })
    await desktop.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex-acp', args: [], env: {} },
    })
    const status = async () => (await reply(await desktop.request('harnesses/codex/login-status', { body: {} })))[1]
    const probe = () => desktop.json<{ login?: string }>('agents/codex/probe', { method: 'POST', body: { requestId: randomUUID() } })
    expect(await status()).toEqual({ status: 'unauthenticated' })

    // Logged in elsewhere; the test start reads it, and the remembered answer no longer stands.
    await writeFile(loginFile, 'yes')
    expect((await probe()).login).toBe('authenticated')
    expect(await status()).toEqual({ status: 'authenticated' })
    // A test start that agrees leaves it remembered.
    expect((await probe()).login).toBe('authenticated')
    expect(await status()).toEqual({ status: 'authenticated' })

    // And the other way.
    await rm(loginFile)
    expect((await probe()).login).toBe('unauthenticated')
    expect(await status()).toEqual({ status: 'unauthenticated' })
    // The status route ran the program three times: first, and after each test start that said otherwise.
    expect((await audited(t, 'agent.login.checked')).map(entry => (entry.detail as { status: string }).status)).toEqual([
      'unauthenticated',
      'authenticated',
      'unauthenticated',
    ])
  })

  it('does not run the program when the audit cannot be written, and keeps nothing from it', async () => {
    const { t, ranFile } = await fixture()
    const desktop = await t.enroll({ listener: 'unix', name: 'Mac', scopes: ['view', 'run', 'admin'] })
    const append = t.host.security.audit.append.bind(t.host.security.audit)
    const failing = vi
      .spyOn(t.host.security.audit, 'append')
      .mockImplementation(event =>
        event.action.startsWith('agent.login.') ? Promise.reject(new AppError(503, 'audit-unavailable', '审计不可用')) : append(event),
      )
    expect((await desktop.request('harnesses/codex/login-status', { body: {} })).status).toBe(503)
    await expect(stat(ranFile)).rejects.toMatchObject({ code: 'ENOENT' })
    failing.mockRestore()
    expect(await reply(await desktop.request('harnesses/codex/login-status', { body: {} }))).toEqual([200, { status: 'unauthenticated' }])
    expect(await readFile(ranFile, 'utf8')).toBe('x')
    expect((await audited(t, 'agent.login.requested')).map(entry => entry.detail)).toEqual([{ agentId: 'codex' }])
    expect((await audited(t, 'agent.login.checked')).map(entry => entry.detail)).toEqual([{ agentId: 'codex', status: 'unauthenticated' }])
  })

  it('needs `run`, and a preset with no saved definition needs a device that could save one: this Mac with admin', async () => {
    const { t } = await fixture()
    const viewer = await t.enroll({ listener: 'unix', name: 'Viewer', scopes: ['view'] })
    expect((await viewer.request('harnesses/codex/login-status', { body: {} })).status).toBe(403)
    const runner = await t.enroll({ listener: 'tls', name: 'Phone', scopes: ['view', 'run'] })
    expect((await runner.request('harnesses/codex/login-status', { body: {} })).status).toBe(404)
    // Saving a definition takes a confirmation on this Mac, so only its desktop app could.
    const tablet = await t.enroll({ listener: 'tls', name: 'Tablet', scopes: ['view', 'run', 'admin'] })
    expect((await tablet.request('harnesses/codex/login-status', { body: {} })).status).toBe(404)
    const owner = await t.enroll({ listener: 'unix', name: 'Mac', scopes: ['view', 'run', 'admin'] })
    expect((await owner.request('harnesses/codex/login-status', { body: {} })).status).toBe(200)
    expect((await owner.request('harnesses/nothing/login-status', { body: {} })).status).toBe(404)
  })

  it('opens a terminal only for this computer, records it, and says so through the flag', async () => {
    const { t, scripts, bin } = await fixture()
    const desktop = await t.enroll({ listener: 'unix', name: 'Mac', scopes: ['view', 'run', 'admin'] })
    const phone = await t.enroll({ listener: 'tls', name: 'Phone', scopes: ['view', 'run', 'admin'] })
    const browser = await t.enroll({ name: 'Browser', scopes: ['view', 'run', 'admin'] })
    for (const remote of [phone, browser]) {
      expect(await reply(await remote.request('harnesses/codex/login-terminal', { body: {} }))).toMatchObject([
        403,
        { error: 'local-only' },
      ])
      expect(
        (await remote.json<{ catalog: { features: Record<string, unknown> } }>('snapshot')).catalog.features.loginTerminal,
      ).toBeUndefined()
    }
    expect(scripts).toEqual([])
    expect((await desktop.json<{ catalog: { features: Record<string, unknown> } }>('snapshot')).catalog.features.loginTerminal).toBe(true)
    expect(await reply(await desktop.request('harnesses/codex/login-terminal', { body: {} }))).toEqual([200, { opened: true }])
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain(`'${join(bin, 'codex')}' 'login'`)
    expect(await audited(t, 'agent.login.opened')).toHaveLength(1)
  })

  it('runs no real program and offers no login in a Host that did not ask for it', async () => {
    const { t, loginFile } = await fixture({ loginPrograms: undefined })
    const desktop = await t.enroll({ listener: 'unix', name: 'Mac', scopes: ['view', 'run', 'admin'] })
    expect(await reply(await desktop.request('harnesses/codex/login-status', { body: {} }))).toEqual([200, { status: 'unknown' }])
    expect((await desktop.request('harnesses/codex/login-terminal', { body: {} })).status).toBe(404)
    await expect(stat(loginFile)).rejects.toThrow()
    await expect(readFile(loginFile)).rejects.toThrow()
  })
})

describe('a harness login in a Latch terminal', () => {
  /** The login fixture with stand-ins for latch-pty: nothing starts, and each launch is kept with a way to end it. */
  async function withTerminals(options: TestHostOptions = {}) {
    const launched: Array<{ launch: TerminalLaunch; emit: (event: HelperEvent) => void }> = []
    const launch: LaunchTerminal = (spec, emit) => {
      launched.push({ launch: spec, emit })
      emit({ type: 'started', pid: 1 })
      return {
        pendingInput: 0,
        input() {},
        resize() {},
        signal() {},
        pauseOutput() {},
        resumeOutput() {},
        close() {
          emit({ type: 'exit', signal: 1 })
          emit({ type: 'gone' })
          return Promise.resolve()
        },
      }
    }
    const made = await fixture({ terminal: { launch, shell: { file: '/bin/sh', argv: ['sh'] } }, ...options })
    const desktop = await made.t.enroll({ listener: 'unix', name: 'Mac', scopes: ['view', 'run', 'admin'] })
    const open = (device = desktop, body: Record<string, unknown> = {}) =>
      device.request('harnesses/codex/login-terminal', { body: { terminal: { cols: 80, rows: 24 }, ...body } })
    /** The script file the shell was handed, from the one command line it runs. */
    const scriptOf = (index: number) => /^exec \/bin\/sh (\/[\w./-]+)$/u.exec(launched[index]!.launch.argv.at(-1)!)![1]!
    return { ...made, desktop, launched, open, scriptOf }
  }

  it('runs the preset’s own command, which no caller can choose, in the home folder under the Harness’s name', async () => {
    const { t, desktop, launched, open, scriptOf, scripts, bin } = await withTerminals()
    const response = await open()
    expect(response.status).toBe(200)
    const { opened, terminal } = (await response.json()) as HarnessLoginTerminalResponse
    expect(opened).toBe(true)
    expect(terminal).toMatchObject({
      sessionId: HARNESS_LOGIN_SESSION,
      status: 'running',
      busy: true,
      login: { harnessId: 'codex', name: 'Codex' },
    })
    // The same login shell as any Latch terminal, interactive, running one path; the script is the external path's.
    expect(launched).toHaveLength(1)
    expect(launched[0]!.launch.argv.slice(0, 3)).toEqual(['sh', '-i', '-c'])
    expect(launched[0]!.launch.cwd).toBe(homedir())
    const script = await readFile(scriptOf(0), 'utf8')
    expect(script).toContain(`'${join(bin, 'codex')}' 'login'`)
    expect(script.trimEnd().split('\n').at(-1)).toBe(`'${join(bin, 'codex')}' 'login'`)
    expect((await stat(scriptOf(0))).mode & 0o777).toBe(0o700)
    // Not the default terminal app as well.
    expect(scripts).toEqual([])
    // Both records, the login's as the external path writes it, before the shell started.
    expect((await audited(t, 'agent.login.opened')).map(entry => entry.detail)).toEqual([{ agentId: 'codex' }])
    expect((await audited(t, 'terminal.open')).map(entry => entry.detail)).toEqual([
      { sessionId: HARNESS_LOGIN_SESSION, terminalId: terminal!.id },
    ])

    // A caller names the Harness and nothing of the command: any other field is refused, and nothing starts.
    for (const extra of [{ command: 'id' }, { argv: ['id'] }, { script: 'id' }, { terminal: { cols: 80, rows: 24, command: 'id' } }])
      expect((await open(desktop, extra)).status).toBe(400)
    expect(
      await reply(await desktop.request('harnesses/nothing/login-terminal', { body: { terminal: { cols: 80, rows: 24 } } })),
    ).toMatchObject([404, { error: 'harness-no-login' }])
    expect(launched).toHaveLength(1)
    // Nothing but a login opens outside a session.
    expect((await desktop.request(`tasks/${HARNESS_LOGIN_SESSION}/terminals`, { body: { cols: 80, rows: 24 } })).status).toBe(404)
    expect(launched).toHaveLength(1)

    // Its output is not attached to a conversation, and closing it while the command runs asks first.
    const base = `tasks/${HARNESS_LOGIN_SESSION}/terminals/${terminal!.id}`
    expect(await reply(await desktop.request(`${base}/attach`, { body: {} }))).toMatchObject([409, { error: 'terminal-login-output' }])
    expect(await reply(await desktop.request(`${base}/close`, { body: {} }))).toMatchObject([409, { error: 'terminal-busy' }])
    expect((await desktop.request(`${base}/close`, { body: { force: true } })).status).toBe(200)
    // A script the shell never ran is removed with its terminal.
    await expect.poll(() => existsSync(scriptOf(0))).toBe(false)
  })

  it('opens for this computer alone, for a device that may use Latch’s terminals, and only a preset with a login', async () => {
    const { t, desktop, launched, open } = await withTerminals()
    const phone = await t.enroll({ listener: 'tls', name: 'Phone', scopes: ['view', 'run', 'admin'] })
    const browser = await t.enroll({ name: 'Browser', scopes: ['view', 'run', 'admin'] })
    for (const remote of [phone, browser]) expect(await reply(await open(remote))).toMatchObject([403, { error: 'local-only' }])
    const viewer = await t.enroll({ listener: 'unix', name: 'Viewer', scopes: ['view'] })
    expect((await open(viewer)).status).toBe(403)
    // A shell reads whatever the account can: a window whose data scope is work gets none, as with any Latch terminal.
    const work = await t.enroll({ listener: 'unix', name: 'Work window', scopes: ['view', 'run', 'admin'] })
    expect((await desktop.request(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
    expect(await reply(await open(work))).toMatchObject([403, { error: 'terminal-scope' }])
    // Claude Agent has no login command of its own to run.
    expect(
      await reply(await desktop.request('harnesses/claude-agent/login-terminal', { body: { terminal: { cols: 80, rows: 24 } } })),
    ).toMatchObject([404, { error: 'harness-no-login' }])
    expect(launched).toEqual([])
    expect(await audited(t, 'agent.login.opened')).toEqual([])
    expect(await audited(t, 'terminal.open')).toEqual([])
  })

  it('runs nothing in a Host that was not told where the person’s programs are', async () => {
    const { launched, open } = await withTerminals({ loginPrograms: undefined })
    expect(await reply(await open())).toMatchObject([404, { error: 'harness-no-login' }])
    expect(launched).toEqual([])
  })

  it('asks the program again once the command has ended, whatever was remembered meanwhile', async () => {
    const { desktop, launched, open, scriptOf, loginFile, ranFile } = await withTerminals()
    const status = async () => (await reply(await desktop.request('harnesses/codex/login-status', { body: {} })))[1]
    const ran = async () => (await readFile(ranFile, 'utf8')).length
    expect(await status()).toEqual({ status: 'unauthenticated' })
    expect(await ran()).toBe(1)
    expect((await open()).status).toBe(200)
    // While the person is still logging in, a question is answered and remembered as before.
    expect(await status()).toEqual({ status: 'unauthenticated' })
    expect(await status()).toEqual({ status: 'unauthenticated' })
    expect(await ran()).toBe(2)
    // The command logs in and leaves with code 0: the remembered answer is dropped, without waiting out its 30 seconds.
    await writeFile(loginFile, 'yes')
    launched[0]!.emit({ type: 'exit', code: 0 })
    launched[0]!.emit({ type: 'gone' })
    expect(await status()).toEqual({ status: 'authenticated' })
    expect(await ran()).toBe(3)
    expect(existsSync(scriptOf(0))).toBe(false)
    // The terminal stays to be read, as one that ended: no longer busy, with the command's own code.
    const { terminals } = await desktop.json<{ terminals: TerminalSummary[] }>(`tasks/${HARNESS_LOGIN_SESSION}/terminals`)
    expect(terminals).toMatchObject([{ status: 'exited', exitCode: 0, busy: false, login: { harnessId: 'codex' } }])
  })

  it('runs in the session’s folder as one of its terminals when the page names a session', async () => {
    const { desktop, launched, open } = await withTerminals({ demo: true })
    const { sessionId } = await desktop.json<{ sessionId: string }>('tasks', { body: { requestId: randomUUID(), prompt: '你好' } })
    const plain = await desktop.json<{ terminal: TerminalSummary }>(`tasks/${sessionId}/terminals`, { body: { cols: 80, rows: 24 } })
    const { terminal } = (await (
      await open(desktop, { terminal: { sessionId, cols: 100, rows: 30 } })
    ).json()) as HarnessLoginTerminalResponse
    expect(terminal).toMatchObject({ sessionId, cols: 100, rows: 30, login: { harnessId: 'codex', name: 'Codex' } })
    expect(launched[1]!.launch.cwd).toBe(launched[0]!.launch.cwd)
    expect(launched[0]!.launch.argv).toEqual(['sh'])
    const { terminals } = await desktop.json<{ terminals: TerminalSummary[] }>(`tasks/${sessionId}/terminals`)
    expect(terminals.map(item => [item.id, item.login?.harnessId])).toEqual([
      [plain.terminal.id, undefined],
      [terminal!.id, 'codex'],
    ])
    // A session that does not exist takes none.
    expect((await open(desktop, { terminal: { sessionId: 'task_missing', cols: 80, rows: 24 } })).status).toBe(404)
    expect(launched).toHaveLength(2)
  })
})

describe('what a running harness says about its login', () => {
  const EMAIL = 'person@example.com'

  /** A saved definition around the fake agent, found by name in a temporary directory, with one settled turn. */
  async function running(env: Record<string, string>) {
    const directory = await mkdtemp(join(tmpdir(), 'latch-agent-auth-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const bin = join(directory, 'bin')
    await mkdir(bin)
    const loginFile = join(directory, 'login')
    const exports = Object.entries({ FAKE_ACP_LOGIN_FILE: loginFile, FAKE_ACP_CAPS: 'resume', ...env }).map(
      ([name, value]) => `export ${name}='${value}'`,
    )
    await writeFile(
      join(bin, 'fake-agent'),
      ['#!/bin/sh', ...exports, `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`, ''].join('\n'),
    )
    await chmod(join(bin, 'fake-agent'), 0o755)
    const scripts: string[] = []
    const t = await startTestHost({
      tls: true,
      demo: false,
      commandDirectories: () => [bin],
      loginPrograms: name => (existsSync(join(bin, name)) ? join(bin, name) : undefined),
      loginTerminal: script => {
        scripts.push(script)
        return Promise.resolve()
      },
    })
    cleanups.push(() => t.close())
    const desktop = await t.enroll({ listener: 'unix', name: 'Mac', scopes: ['view', 'run', 'admin'] })
    await desktop.confirmedJson('agents', { method: 'POST', body: { id: 'fake', name: 'Fake', command: 'fake-agent', args: [], env: {} } })
    await writeFile(loginFile, 'yes')
    const created = await desktop.confirmed('tasks', {
      method: 'POST',
      body: { prompt: 'echo hi', requestId: randomUUID(), mode: 'agent', harnessId: 'fake', workspaceId: 'default' },
    })
    expect(created.status).toBe(201)
    const { sessionId } = (await created.json()) as { sessionId: string }
    await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, { timeout: 15_000 }).toBe('idle')
    const login = async () =>
      (await desktop.json<{ catalog: { harnesses: HarnessInfo[] } }>('snapshot')).catalog.harnesses.find(item => item.id === 'fake')?.login
    return { t, desktop, bin, loginFile, scripts, login }
  }

  it('answers from the harness’s own push, runs nothing for it, and keeps no account anywhere', async () => {
    const { t, desktop, login } = await running({ FAKE_ACP_AUTH_STATUS: '1' })
    await expect.poll(async () => (await login())?.reported).toEqual({ status: 'authenticated', label: 'ChatGPT Plus' })
    expect(await reply(await desktop.request('harnesses/fake/login-status', { body: {} }))).toEqual([
      200,
      { status: 'authenticated', label: 'ChatGPT Plus' },
    ])
    expect(await audited(t, 'agent.login.requested')).toEqual([])
    expect(JSON.stringify(await desktop.json('snapshot'))).not.toContain(EMAIL)
    // Stores write a temporary file and rename it into place, so one can vanish mid-scan: then scan again.
    let vanished = true
    for (let round = 0; vanished && round < 10; round++) {
      vanished = false
      for (const name of await readdir(t.dataDir, { recursive: true })) {
        const text = await readFile(join(t.dataDir, String(name)), 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') vanished = true
          else if (error.code !== 'EISDIR') throw error
          return ''
        })
        expect(text).not.toContain(EMAIL)
      }
    }
    expect(vanished).toBe(false)
  })

  it('takes the program’s fresh answer over an older push from a Claude Agent process sitting idle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-agent-auth-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const bin = join(directory, 'bin')
    await mkdir(bin)
    const loginFile = join(directory, 'login')
    const ranFile = join(directory, 'ran')
    const ends = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString()
    const fake = {
      FAKE_ACP_LOGIN_FILE: loginFile,
      FAKE_ACP_AUTH_STATUS: '1',
      FAKE_ACP_CAPS: 'resume',
      FAKE_ACP_CONFIG: 'options',
      FAKE_ACP_MODES: 'default,acceptEdits,plan,auto,bypassPermissions',
      FAKE_ACP_INITIAL_MODE: 'auto',
      FAKE_ACP_VERSION: '0.101.0',
    }
    // Like the adapter's `--cli auth status --json`: it reads the login now, while the running process holds its last push.
    await writeFile(
      join(bin, 'claude-agent-acp'),
      [
        '#!/bin/sh',
        'if [ "$1" = "--cli" ]; then',
        `  echo "$0 $*" >> '${ranFile}'`,
        `  if [ -f '${loginFile}' ]; then echo '{"loggedIn":true,"loginExpiresAt":"${ends}"}'; exit 0; fi`,
        `  echo '{"loggedIn":false}'; exit 1`,
        'fi',
        ...Object.entries(fake).map(([name, value]) => `export ${name}='${value}'`),
        `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
        '',
      ].join('\n'),
    )
    await chmod(join(bin, 'claude-agent-acp'), 0o755)
    const t = await startTestHost({
      tls: true,
      demo: false,
      detectPreset: preset => (preset.id === 'claude-agent' ? { found: true, path: join(bin, 'claude-agent-acp') } : { found: false }),
      commandDirectories: () => [bin],
      loginPrograms: name => (existsSync(join(bin, name)) ? join(bin, name) : undefined),
    })
    cleanups.push(() => t.close())
    const desktop = await t.enroll({ listener: 'unix', name: 'Mac', scopes: ['view', 'run', 'admin'] })
    await desktop.confirmedJson('agents', {
      method: 'POST',
      body: { id: 'claude-agent', name: 'Claude Agent', presetId: 'claude-agent', command: 'claude-agent-acp', args: [], env: {} },
    })
    await writeFile(loginFile, 'yes')
    const created = await desktop.confirmed('tasks', {
      method: 'POST',
      body: { prompt: 'echo hi', requestId: randomUUID(), mode: 'agent', harnessId: 'claude-agent', workspaceId: 'default' },
    })
    expect(created.status).toBe(201)
    const { sessionId } = (await created.json()) as { sessionId: string }
    await expect.poll(async () => (await t.host.bridge.summary(sessionId)).status, { timeout: 15_000 }).toBe('idle')
    const login = async () =>
      (await desktop.json<{ catalog: { harnesses: HarnessInfo[] } }>('snapshot')).catalog.harnesses.find(item => item.id === 'claude-agent')
        ?.login
    await expect.poll(async () => (await login())?.reported).toEqual({ status: 'authenticated', label: 'ChatGPT Plus' })
    const status = async (fresh: boolean) => reply(await desktop.request('harnesses/claude-agent/login-status', { body: { fresh } }))
    expect(await status(false)).toEqual([200, { status: 'authenticated', label: 'ChatGPT Plus', expiresAt: ends }])

    // Logged out in another terminal: the idle process does not know yet, the program does.
    await rm(loginFile)
    await new Promise(resolve => setTimeout(resolve, 2100))
    expect(await status(true)).toEqual([200, { status: 'unauthenticated' }])
    expect((await login())?.reported).toEqual({ status: 'authenticated', label: 'ChatGPT Plus' })

    // And back: both say logged in again, so the harness's own label returns beside the program's date.
    await writeFile(loginFile, 'yes')
    await new Promise(resolve => setTimeout(resolve, 2100))
    expect(await status(true)).toEqual([200, { status: 'authenticated', label: 'ChatGPT Plus', expiresAt: ends }])
    // Only the fake in this test's folder ever ran.
    expect((await readFile(ranFile, 'utf8')).trim().split('\n')).toEqual(
      Array.from({ length: 3 }, () => `${join(bin, 'claude-agent-acp')} --cli auth status --json`),
    )
  })

  it('logs out from any device that may start sessions, recorded before the harness is asked', async () => {
    const { t, desktop, loginFile, login } = await running({ FAKE_ACP_AUTH_STATUS: '1', FAKE_ACP_LOGOUT: '1' })
    await expect.poll(async () => (await login())?.logout).toBe(true)
    const viewer = await t.enroll({ listener: 'tls', name: 'Viewer', scopes: ['view'] })
    expect((await viewer.request('harnesses/fake/logout', { body: {} })).status).toBe(403)
    const phone = await t.enroll({ listener: 'tls', name: 'Phone', scopes: ['view', 'run'] })
    expect((await phone.request('harnesses/fake/logout', { body: { extra: true } })).status).toBe(400)
    expect(await reply(await phone.request('harnesses/fake/logout', { body: {} }))).toEqual([200, { loggedOut: true }])
    expect(existsSync(loginFile)).toBe(false)
    expect((await audited(t, 'agent.logout')).map(entry => entry.detail)).toEqual([{ agentId: 'fake' }])
    await expect.poll(async () => (await login())?.reported).toBeUndefined()
    // With no report and no status command, the page is told it is not known rather than guessed.
    expect(await reply(await desktop.request('harnesses/fake/login-status', { body: { fresh: true } }))).toEqual([
      200,
      { status: 'unknown' },
    ])
  })

  it('refuses to log out a harness that does not offer it', async () => {
    const { desktop, loginFile } = await running({})
    expect(await reply(await desktop.request('harnesses/fake/logout', { body: {} }))).toMatchObject([409, { error: 'logout-unsupported' }])
    expect(existsSync(loginFile)).toBe(true)
  })

  it('opens the harness’s own terminal login on this computer, as the program it runs', async () => {
    const { t, desktop, bin, scripts, login } = await running({ FAKE_ACP_TERMINAL_LOGIN: '1' })
    await expect
      .poll(async () => (await login())?.methods?.map(method => method.command))
      .toEqual(['FAKE_ACP_LOGIN_VIA=terminal fake-agent login'])
    const phone = await t.enroll({ listener: 'tls', name: 'Phone', scopes: ['view', 'run', 'admin'] })
    expect((await phone.request('harnesses/fake/login-terminal', { body: { method: 'fake-terminal' } })).status).toBe(403)
    expect((await desktop.request('harnesses/fake/login-terminal', { body: { method: 'nothing' } })).status).toBe(404)
    expect(await reply(await desktop.request('harnesses/fake/login-terminal', { body: { method: 'fake-terminal' } }))).toEqual([
      200,
      { opened: true },
    ])
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain(`FAKE_ACP_LOGIN_VIA='terminal' '${join(bin, 'fake-agent')}' 'login'`)
    expect((await audited(t, 'agent.login.opened')).map(entry => entry.detail)).toEqual([{ agentId: 'fake', source: 'harness' }])
  })
})
