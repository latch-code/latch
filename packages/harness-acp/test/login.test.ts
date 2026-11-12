import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRecord } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { personCommandDirectories, redactor, resolveCommand, setCommandSearch } from '../src/command.ts'
import { agentEnvironment, programPaths } from '../src/environment.ts'
import { checkLogin, harnessLogin, loginTerminalScript, presetRecord, setLoginPrograms } from '../src/login.ts'
import { ALWAYS_INHERITED, loadLoginShell, loginShellValues, readLoginShell, setLoginShellValues } from '../src/login-shell.ts'
import { launchHash } from '../src/permission.ts'
import { agentProbePreview, probeAgent } from '../src/probe.ts'
import { FALLBACK_PROFILES, HARNESS_PROFILES, profileFor } from '../src/profiles/index.ts'

const run = promisify(execFile)
/** The Codex preset on its ACP adapter, as a definition saved before Codex was reached directly. */
const codexAdapter = (): AgentRecord => ({ ...presetRecord('codex')!, command: 'codex-acp' })
const roots: string[] = []
const savedPath = process.env.PATH
afterEach(async () => {
  setLoginShellValues({})
  setLoginPrograms(undefined)
  setCommandSearch(undefined)
  process.env.PATH = savedPath
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function root(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'latch-login-')))
  roots.push(directory)
  return directory
}

/** A shell that behaves like a profile: it prints noise, sets variables, and runs the script it is given with /bin/sh. */
async function fakeShell(directory: string, body: string): Promise<string> {
  const path = join(directory, 'fake-shell')
  await writeFile(path, ['#!/bin/sh', 'echo "welcome to my prompt"', body, 'shift', 'exec /bin/sh -c "$1"'].join('\n'))
  await chmod(path, 0o755)
  return path
}

/** A directory holding `codex` and `codex-acp`, both the fake agent, so the Codex preset finds them with no real program. */
async function fakeCodex(directory: string, loginFile: string, names = ['codex', 'codex-acp']): Promise<string> {
  const bin = join(directory, 'bin')
  await mkdir(bin, { recursive: true })
  for (const name of names) {
    const path = join(bin, name)
    await writeFile(
      path,
      [
        '#!/bin/sh',
        `export FAKE_ACP_LOGIN_FILE='${loginFile}'`,
        `[ "$1" = cli ] && shift`,
        `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
      ].join('\n'),
    )
    await chmod(path, 0o755)
  }
  useOnly(bin)
  return bin
}

/** Commands are found in `bin` alone, as the start script finds them: never one installed on the computer running this test. */
function useOnly(bin: string): void {
  process.env.PATH = `${bin}:/usr/bin:/bin`
  setCommandSearch(() => [bin])
  setLoginPrograms(resolveCommand)
}

describe('reading the login shell', () => {
  it('keeps only the named variables, whatever else the profile prints or sets', async () => {
    const directory = await root()
    const shell = await fakeShell(
      directory,
      'export CODEX_HOME=/home/me/.codex OPENAI_API_KEY=sk-should-never-be-read PATH=/opt/me/bin:/usr/bin',
    )
    const values = await readLoginShell(['PATH', 'CODEX_HOME', 'NOT_SET', 'bad name; rm -rf'], { shell, env: { PATH: '/usr/bin:/bin' } })
    expect(values).toEqual({ PATH: '/opt/me/bin:/usr/bin', CODEX_HOME: '/home/me/.codex' })
  })

  it('never hands the Host settings to the profile', async () => {
    const directory = await root()
    const shell = await fakeShell(directory, 'export SEEN="${LATCH_API_KEY:-none} ${NODE_OPTIONS:-none}"')
    const values = await readLoginShell(['SEEN'], {
      shell,
      env: { PATH: '/usr/bin:/bin', LATCH_API_KEY: 'sk-host-key', NODE_OPTIONS: '--inspect' },
    })
    expect(values).toEqual({ SEEN: 'none none' })
  })

  it('gives up on a profile that hangs and leaves nothing running, and falls back', async () => {
    const directory = await root()
    const marker = join(directory, 'survived')
    const shell = await fakeShell(directory, `(sleep 2; touch '${marker}') & sleep 30`)
    const started = Date.now()
    await expect(readLoginShell(['PATH'], { shell, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 200 })).resolves.toEqual({})
    expect(Date.now() - started).toBeLessThan(5000)
    await loadLoginShell({ shell: join(directory, 'missing-shell'), env: { PATH: '/usr/bin:/bin' } })
    expect(loginShellValues()).toEqual({})
    await new Promise(resolve => setTimeout(resolve, 2300))
    await expect(stat(marker)).rejects.toThrow()
  }, 15_000)

  it('does not wait for a daemon a profile leaves holding its output', async () => {
    const directory = await root()
    const shell = await fakeShell(directory, 'sleep 30 & export CODEX_HOME=/home/me/.codex')
    const started = Date.now()
    await expect(readLoginShell(['CODEX_HOME'], { shell, env: { PATH: '/usr/bin:/bin' } })).resolves.toEqual({
      CODEX_HOME: '/home/me/.codex',
    })
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('asks for what every profile inherits, and finds a command only the login shell knows', async () => {
    const directory = await root()
    const elsewhere = join(directory, 'elsewhere')
    await mkdir(elsewhere)
    await writeFile(join(elsewhere, 'codex-acp'), '#!/bin/sh\n')
    await chmod(join(elsewhere, 'codex-acp'), 0o755)
    const shell = await fakeShell(
      directory,
      `export PATH='${elsewhere}':/usr/bin:/bin CODEX_HOME=/home/me/.codex https_proxy=http://proxy.test:8080 __MISE_DIFF=opaque`,
    )
    await loadLoginShell({ shell, env: { PATH: '/usr/bin:/bin' } })
    expect(loginShellValues()).toMatchObject({ CODEX_HOME: '/home/me/.codex', https_proxy: 'http://proxy.test:8080' })
    // What the login shell adds is searched; only this test's directories are, so no installed Codex is found.
    expect(personCommandDirectories()).toContain(elsewhere)
    setCommandSearch(() => personCommandDirectories().filter(path => path.startsWith(`${directory}/`)))
    const preview = await agentProbePreview(codexAdapter(), { dataDir: directory, cwd: directory })
    expect(preview.command).toBe(join(elsewhere, 'codex-acp'))
    expect(preview.envNames).not.toContain('CODEX_PATH')
    expect(preview.envNames).toEqual(expect.arrayContaining(['CODEX_HOME', 'https_proxy', '__MISE_DIFF']))
  })
})

describe('the environment an agent inherits', () => {
  const base = { resolvedCommand: '/usr/bin/true', definitionEnv: {}, sessionTmpDir: '/tmp/s' }

  it('takes the proxy and CA file from the Host or the login shell, the Host first', () => {
    const env = agentEnvironment({
      ...base,
      hostEnv: { PATH: '/usr/bin', HTTPS_PROXY: 'http://host.test:1' },
      shellEnv: {
        PATH: '/shell/bin',
        HTTPS_PROXY: 'http://shell.test:2',
        http_proxy: 'http://shell.test:3',
        NODE_EXTRA_CA_CERTS: '/me/ca.pem',
      },
    })
    expect(env).toMatchObject({ HTTPS_PROXY: 'http://host.test:1', http_proxy: 'http://shell.test:3', NODE_EXTRA_CA_CERTS: '/me/ca.pem' })
    expect(env.PATH?.split(':').slice(0, 2)).toEqual(['/shell/bin', '/usr/bin'])
    expect(agentEnvironment({ ...base, hostEnv: { PATH: '/usr/bin' }, shellEnv: {} })).not.toHaveProperty('HTTPS_PROXY')
  })

  it("inherits a profile's home, and only that profile's", () => {
    const shellEnv = { CODEX_HOME: '/me/.codex', GEMINI_CLI_HOME: '/me/.gemini' }
    const codex = agentEnvironment({
      ...base,
      profile: FALLBACK_PROFILES.get('codex')!.permission,
      hostEnv: { PATH: '/usr/bin' },
      shellEnv,
    })
    expect(codex.CODEX_HOME).toBe('/me/.codex')
    expect(codex).not.toHaveProperty('GEMINI_CLI_HOME')
    const plain = agentEnvironment({ ...base, hostEnv: { PATH: '/usr/bin', CODEX_HOME: '/me/.codex' }, shellEnv })
    expect(plain).not.toHaveProperty('CODEX_HOME')
  })

  it('never inherits a name that holds a secret or a loader', () => {
    for (const profile of HARNESS_PROFILES.values()) {
      for (const name of profile.permission.inheritEnv ?? []) {
        expect(name, profile.presetId).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|^LD_|^DYLD_|NODE_OPTIONS/iu)
      }
    }
    for (const name of ALWAYS_INHERITED) expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/iu)
  })

  it('points the adapter at the program the person installed, and leaves it out otherwise', async () => {
    const directory = await root()
    const bin = await fakeCodex(directory, join(directory, 'login'))
    const profile = FALLBACK_PROFILES.get('codex')!.permission
    expect(agentEnvironment({ ...base, profile, hostEnv: { PATH: bin }, shellEnv: {} }).CODEX_PATH).toBe(join(bin, 'codex'))
    expect(
      programPaths({ approvals: 'prompts', defaultEnv: {}, readback: 'none', notes: [], programEnv: { X: 'no-such-program-here' } }),
    ).toEqual({})
  })
})

describe('the launch fingerprint', () => {
  const input = { resolvedCommand: '/usr/bin/agent', args: [], definitionEnv: {}, profileVersion: 1 as const }

  it('counts the names a profile inherits and the programs it points at, never a value', async () => {
    const hash = launchHash(input)
    expect(launchHash({ ...input, inheritEnv: [] })).toBe(hash)
    expect(launchHash({ ...input, programs: {} })).toBe(hash)
    expect(launchHash({ ...input, inheritEnv: ['CODEX_HOME'] })).not.toBe(hash)
    expect(launchHash({ ...input, programs: { CODEX_PATH: '/a/codex' } })).not.toBe(
      launchHash({ ...input, programs: { CODEX_PATH: '/b/codex' } }),
    )
    const directory = await root()
    await fakeCodex(directory, join(directory, 'login'))
    const before = await agentProbePreview(codexAdapter(), { dataDir: directory, cwd: directory })
    setLoginShellValues({ CODEX_HOME: '/somewhere/else', HTTPS_PROXY: 'http://user:pass@proxy.test:8080' })
    const after = await agentProbePreview(codexAdapter(), { dataDir: directory, cwd: directory })
    expect(after.launchHash).toBe(before.launchHash)
    expect(JSON.stringify(after)).not.toContain('pass')
    expect(after.envNames).toEqual(expect.arrayContaining(['HTTPS_PROXY']))
  })
})

describe('secrets in what is inherited', () => {
  it('masks a proxy password in diagnostics, with or without a scheme', () => {
    setLoginShellValues({ HTTPS_PROXY: 'proxyuser:hunter2hunter2@proxy.test:8080' })
    const mask = redactor({})
    expect(mask('dial proxyuser:hunter2hunter2@proxy.test:8080 failed')).not.toContain('hunter2')
  })

  it('keeps a proxy password out of a failed test start', async () => {
    const directory = await root()
    const secret = 'plainuser:hunter2hunter2@proxy.test:8080'
    setLoginShellValues({ HTTPS_PROXY: secret })
    const agent: AgentRecord = {
      id: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [FAKE_ACP_AGENT],
      env: { FAKE_ACP_INIT_ERROR: '1', FAKE_SECRET: secret },
      enabled: true,
    }
    const options = { dataDir: directory, cwd: directory }
    const preview = await agentProbePreview(agent, options)
    const result = await probeAgent(agent, { ...options, expectedLaunchHash: preview.launchHash })
    expect(result.status).toBe('failed')
    expect(JSON.stringify(result)).not.toContain('hunter2')
  })
})

describe('the login check', () => {
  it('runs nothing and shows nothing until the start script turns it on', async () => {
    const directory = await root()
    const file = join(directory, 'login')
    await fakeCodex(directory, file)
    setLoginPrograms(undefined)
    await expect(checkLogin(codexAdapter())).resolves.toEqual({ status: 'unknown' })
    expect(harnessLogin(codexAdapter())).toBeUndefined()
    expect(loginTerminalScript(codexAdapter())).toBeUndefined()
  })

  it('has three states, and only the sentence itself means logged out', async () => {
    const directory = await root()
    const file = join(directory, 'login')
    await fakeCodex(directory, file)
    const record = codexAdapter()
    await expect(checkLogin(record)).resolves.toEqual({ status: 'unauthenticated' })
    await writeFile(file, 'yes')
    await expect(checkLogin(record)).resolves.toEqual({ status: 'authenticated' })
    const read = FALLBACK_PROFILES.get('codex')!.loginStatus!.read
    expect(read({ code: 1, output: 'Error checking login status: disk on fire' })).toBe('unknown')
    expect(read({ code: null, output: '' })).toBe('unknown')
    expect(read({ code: 127, output: 'Not logged in' })).toBe('unknown')
    // A harness with no such command, or one not installed, is never called logged out.
    await expect(checkLogin(presetRecord('goose')!)).resolves.toEqual({ status: 'unknown' })
    setLoginPrograms(() => undefined)
    await expect(checkLogin(record)).resolves.toEqual({ status: 'unknown' })
    expect(harnessLogin(record)).toBeUndefined()
  })

  it('reports a status command that hangs as unknown and stops it', async () => {
    const directory = await root()
    const bin = join(directory, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'codex'), '#!/bin/sh\nsleep 30\n')
    await chmod(join(bin, 'codex'), 0o755)
    useOnly(bin)
    await expect(checkLogin(codexAdapter(), { timeoutMs: 100 })).resolves.toEqual({ status: 'unknown' })
  })

  it('uses the copy an adapter ships when the program itself is not installed', async () => {
    const directory = await root()
    const file = join(directory, 'login')
    await fakeCodex(directory, file, ['codex-acp'])
    expect(harnessLogin(codexAdapter())).toEqual({ command: 'codex-acp cli login', checkable: true })
    await expect(checkLogin(codexAdapter())).resolves.toEqual({ status: 'unauthenticated' })
  })

  it('adds the verdict to a test start without keeping what the command printed', async () => {
    const directory = await root()
    const file = join(directory, 'login')
    await fakeCodex(directory, file)
    const record = codexAdapter()
    const options = { dataDir: directory, cwd: directory }
    const preview = await agentProbePreview(record, options)
    const result = await probeAgent(record, { ...options, expectedLaunchHash: preview.launchHash })
    expect(result).toMatchObject({ status: 'ready', login: 'unauthenticated' })
    expect(JSON.stringify(result)).not.toContain('Not logged in')
  })
})

describe('the program an adapter drives, beside the adapter', () => {
  /** `codex-acp` reports `adapter` in its handshake, `codex --version` prints `program`; running `codex` leaves a mark. */
  async function pair(adapter: string, program: string | undefined) {
    const directory = await root()
    const bin = join(directory, 'bin')
    await mkdir(bin)
    const marks = join(directory, 'marks')
    const scripts: Record<string, string> = {
      'codex-acp': `export FAKE_ACP_VERSION='${adapter}'`,
      ...(program === undefined ? {} : { codex: `touch '${marks}'\nexport FAKE_ACP_CLI_VERSION='${program}'` }),
    }
    for (const [name, line] of Object.entries(scripts)) {
      await writeFile(join(bin, name), ['#!/bin/sh', line, `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`].join('\n'))
      await chmod(join(bin, name), 0o755)
    }
    useOnly(bin)
    const options = { dataDir: directory, cwd: directory }
    const probe = async (record: AgentRecord = codexAdapter()) =>
      probeAgent(record, { ...options, expectedLaunchHash: (await agentProbePreview(record, options)).launchHash })
    return { probe, ran: () => existsSync(marks) }
  }

  it('shows both versions and marks a pair the adapter was not built for, starting either way', async () => {
    expect(FALLBACK_PROFILES.get('codex')!.programVersion!.read('codex-cli 0.165.0\n')).toBe('0.165.0')
    const built = await pair('2.5.0', '0.165.3')
    expect(await built.probe()).toMatchObject({
      status: 'ready',
      agent: { version: '2.5.0' },
      program: { name: 'Codex', version: '0.165.3' },
    })
    expect((await built.probe()).program).not.toHaveProperty('unchecked')
    for (const [adapter, program] of [
      ['2.5.0', '0.167.0'],
      ['2.5.1-preview.24', '0.166.0'],
      ['2.3.0', '0.165.0'],
    ] as const) {
      const other = await pair(adapter, program)
      expect(await other.probe(), `${adapter} ${program}`).toMatchObject({
        status: 'ready',
        program: { name: 'Codex', version: program, unchecked: true },
      })
    }
  })

  it('says the version is unknown when the command fails, without a warning', async () => {
    const failed = await pair('2.5.0', 'fail')
    expect((await failed.probe()).program).toEqual({ name: 'Codex' })
    expect(failed.ran()).toBe(true)
  })

  it('reads the program the definition points the adapter at, not the one on PATH', async () => {
    const found = await pair('2.5.0', '0.167.0')
    const own = join(await root(), 'codex-0.165')
    const ownMark = `${own}.ran`
    await writeFile(
      own,
      [
        '#!/bin/sh',
        `touch '${ownMark}'`,
        `export FAKE_ACP_CLI_VERSION='0.165.2'`,
        `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
      ].join('\n'),
    )
    await chmod(own, 0o755)
    const probe = (env: Record<string, string>) => found.probe({ ...codexAdapter(), env })
    expect((await probe({ CODEX_PATH: own })).program).toEqual({ name: 'Codex', version: '0.165.2' })
    expect(existsSync(ownMark)).toBe(true)
    // A relative path resolves against the project, which a test start does not use: the version stays unknown.
    expect((await probe({ CODEX_PATH: 'tools/codex' })).program).toEqual({ name: 'Codex' })
    // An empty value leaves the adapter on its own copy.
    expect((await probe({ CODEX_PATH: '' })).program).toBeUndefined()
    expect((await probe({})).program).toEqual({ name: 'Codex', version: '0.167.0', unchecked: true })
  })

  it('keeps the whole test start, login and version reads included, within its time', { timeout: 40_000 }, async () => {
    const directory = await root()
    const bin = join(directory, 'bin')
    await mkdir(bin)
    const scripts = {
      'codex-acp': `export FAKE_ACP_VERSION='2.5.0'\nexec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
      codex: 'sleep 30',
    }
    for (const [name, body] of Object.entries(scripts)) {
      await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`)
      await chmod(join(bin, name), 0o755)
    }
    useOnly(bin)
    const record = codexAdapter()
    const options = { dataDir: directory, cwd: directory }
    const started = Date.now()
    const result = await probeAgent(record, {
      ...options,
      expectedLaunchHash: (await agentProbePreview(record, options)).launchHash,
      timeoutMs: 1500,
    })
    expect(Date.now() - started).toBeLessThan(4000)
    expect(result).toMatchObject({ status: 'ready', login: 'unknown', program: { name: 'Codex' } })
    expect(result.program).not.toHaveProperty('version')
  })

  it('shows no program when the adapter runs its own copy, and runs none until the start script turns it on', async () => {
    expect((await (await pair('2.5.0', undefined)).probe()).program).toBeUndefined()
    const off = await pair('2.5.0', '0.165.0')
    setLoginPrograms(undefined)
    expect((await off.probe()).program).toBeUndefined()
    expect(off.ran()).toBe(false)
  })
})

describe('the login command', () => {
  it('runs the program by its full path in a script that removes itself', async () => {
    const directory = await root()
    const file = join(directory, 'login')
    const bin = await fakeCodex(directory, file)
    const record = codexAdapter()
    expect(harnessLogin(record)).toEqual({ command: 'codex login', checkable: true })
    const script = loginTerminalScript(record)!
    expect(script).toContain(`'${join(bin, 'codex')}' 'login'`)
    const path = join(directory, 'run.command')
    await writeFile(path, script, { mode: 0o700 })
    await run(path, [], { cwd: directory })
    await expect(readFile(file, 'utf8')).resolves.toContain('logged in')
    await expect(stat(path)).rejects.toThrow()
  })

  it('tells a person what to do in a program that logs in from inside, and says nothing for one it does not know', async () => {
    const directory = await root()
    const bin = join(directory, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'qwen'), '#!/bin/sh\n')
    await chmod(join(bin, 'qwen'), 0o755)
    useOnly(bin)
    expect(harnessLogin(presetRecord('qwen')!)).toMatchObject({ command: 'qwen', note: expect.stringContaining('/auth') })
    expect(harnessLogin({ id: 'mine', name: 'Mine', command: '/usr/bin/true', args: [], env: {}, enabled: true })).toBeUndefined()
    expect(harnessLogin(presetRecord('dsh')!)).toBeUndefined()
  })

  it('offers no login for Claude Agent even with Claude Code installed, and Cursor’s own login for Cursor', async () => {
    const directory = await root()
    const bin = join(directory, 'bin')
    await mkdir(bin)
    const ran = join(directory, 'ran')
    for (const name of ['claude', 'claude-agent-acp', 'cursor-agent']) {
      await writeFile(join(bin, name), `#!/bin/sh\necho "$(basename "$0") $*" >> '${ran}'\n`)
      await chmod(join(bin, name), 0o755)
    }
    useOnly(bin)
    // How to sign in, in words only, and a status check: no command, no button, no terminal.
    expect(harnessLogin(presetRecord('claude-agent')!)).toEqual({
      note: expect.stringContaining('Claude Code 自己的方式登录'),
      checkable: true,
    })
    expect(loginTerminalScript(presetRecord('claude-agent')!)).toBeUndefined()
    await expect(checkLogin(presetRecord('claude-agent')!)).resolves.toEqual({ status: 'unknown' })
    // The check is the adapter's own, through the CLI it ships; the person's `claude` never runs.
    expect(await readFile(ran, 'utf8')).toBe('claude-agent-acp --cli auth status --json\n')
    expect(harnessLogin(presetRecord('cursor')!)).toEqual({ command: 'cursor-agent login' })
    expect(loginTerminalScript(presetRecord('cursor')!)).toContain(`'${join(bin, 'cursor-agent')}' 'login'`)
    // Cursor has no status command, and a script is only written.
    expect(await readFile(ran, 'utf8')).toBe('claude-agent-acp --cli auth status --json\n')
  })
})
