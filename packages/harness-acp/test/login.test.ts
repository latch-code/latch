import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRecord } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { personCommandDirectories, redactor, resolveCommand, setCommandSearch } from '../src/command.ts'
import { agentEnvironment, assertAccountWorkspace, programPaths } from '../src/environment.ts'
import { assertCommandVersion, createAcpAgentPlugin } from '../src/index.ts'
import { checkLogin, harnessLogin, loginTerminalScript, presetRecord, setLoginPrograms } from '../src/login.ts'
import { ALWAYS_INHERITED, loadLoginShell, loginShellValues, readLoginShell, setLoginShellValues } from '../src/login-shell.ts'
import { launchHash, selectProfile } from '../src/permission.ts'
import { agentProbePreview, probeAgent } from '../src/probe.ts'
import { FALLBACK_PROFILES, HARNESS_PROFILES, profileFor } from '../src/profiles/index.ts'
import { AcpWire } from '../src/wires/acp.ts'
import { activate, openBridge } from './helpers/replay.ts'

const run = promisify(execFile)
/** The Codex preset on its ACP adapter, as a definition saved before Codex was reached directly. */
const codexAdapter = (): AgentRecord => ({ ...presetRecord('codex')!, command: 'codex-acp' })
const roots: string[] = []
const cleanups: Array<() => Promise<void> | void> = []
const savedPath = process.env.PATH
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
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
    const shellEnv = { CODEX_HOME: '/me/.codex', QWEN_HOME: '/me/.qwen' }
    const codex = agentEnvironment({
      ...base,
      profile: FALLBACK_PROFILES.get('codex')!.permission,
      hostEnv: { PATH: '/usr/bin' },
      shellEnv,
    })
    expect(codex.CODEX_HOME).toBe('/me/.codex')
    expect(codex).not.toHaveProperty('QWEN_HOME')
    const plain = agentEnvironment({ ...base, hostEnv: { PATH: '/usr/bin', CODEX_HOME: '/me/.codex' }, shellEnv })
    expect(plain).not.toHaveProperty('CODEX_HOME')
  })

  it('uses only the bound store for a named account and refuses a missing or redirected directory', async () => {
    const directory = await root()
    const own = join(directory, 'selected')
    await mkdir(own)
    const use = (id: string) =>
      agentEnvironment({
        ...base,
        account: { presetId: id, accountDirectory: own },
        profile: profileFor(id)?.permission,
        hostEnv: { PATH: '/usr/bin', CODEX_HOME: '/other', CODEX_SQLITE_HOME: '/other-db', PI_CODING_AGENT_SESSION_DIR: '/other-sessions' },
        shellEnv: {},
      })
    expect(use('codex')).toMatchObject({ CODEX_HOME: own, CODEX_SQLITE_HOME: own })
    expect(use('qwen')).toMatchObject({ HOME: own, QWEN_HOME: own, QWEN_RUNTIME_DIR: own })
    expect(use('goose')).toMatchObject({ GOOSE_PATH_ROOT: own, GOOSE_DISABLE_KEYRING: '1' })
    expect(use('pi')).not.toHaveProperty('PI_CODING_AGENT_SESSION_DIR')
    expect(() => use('custom')).toThrow(expect.objectContaining({ code: 'harness-account-unsupported' }))
    expect(() => use('antigravity')).toThrow(expect.objectContaining({ code: 'harness-account-unavailable' }))
    const adc = join(own, 'application_default_credentials.json')
    const other = join(directory, 'project-credentials')
    await writeFile(other, 'fixture')
    await symlink(other, adc)
    expect(() => use('antigravity')).toThrow(expect.objectContaining({ code: 'harness-account-unavailable' }))
    await rm(adc)
    await writeFile(adc, 'fixture')
    expect(use('antigravity')).toMatchObject({ AGY_ADC_AUTH: 'true', GOOGLE_APPLICATION_CREDENTIALS: adc, CLOUDSDK_CONFIG: own })
    expect(use('opencode').XDG_DATA_HOME).toBe(join(own, 'data'))
    await symlink(directory, join(own, 'data'))
    expect(() => use('opencode')).toThrow(expect.objectContaining({ code: 'harness-account-unavailable' }))
    const moved = join(directory, 'moved')
    await rename(own, moved)
    expect(() => use('codex')).toThrow(expect.objectContaining({ code: 'harness-account-unavailable' }))
    await symlink(moved, own)
    expect(() => use('codex')).toThrow(expect.objectContaining({ code: 'harness-account-unavailable' }))
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

  it(
    'skips expired probe reads and runs login and version together with the remaining budget',
    { timeout: 40_000 },
    async ({ onTestFinished }) => {
      const directory = await root()
      const bin = join(directory, 'bin')
      await mkdir(bin)
      for (const [name, body] of Object.entries({ 'codex-acp': 'exit 0', codex: 'exec /bin/sleep 30' })) {
        await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
      }
      useOnly(bin)
      const record = codexAdapter()
      const options = { dataDir: directory, cwd: directory }
      const { launchHash: expectedLaunchHash } = await agentProbePreview(record, options)

      // Only the handshake's time on the deadline clock is simulated. The two optional commands and their kill timers are real.
      const start = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
      const handshake = vi.spyOn(AcpWire.prototype, 'request')
      onTestFinished(() => {
        vi.restoreAllMocks()
      })
      const probeAfter = (handshakeMs: number) => {
        clock.mockReturnValue(start)
        handshake.mockImplementationOnce(async () => {
          clock.mockReturnValue(start + handshakeMs)
          return { protocolVersion: 1 }
        })
        return probeAgent(record, { ...options, expectedLaunchHash, timeoutMs: 1500 })
      }
      const reads = await import('../src/login.ts')
      const { checkLogin: login, readProgramVersion: version } = reads
      let active = 0
      let overlapped = false
      let started: number | undefined
      function observe<T>(read: Promise<T>): Promise<T> {
        started ??= performance.now()
        if (active > 0) overlapped = true
        active++
        return read.finally(() => {
          active--
        })
      }
      const loginRead = vi.spyOn(reads, 'checkLogin').mockImplementation((...args) => observe(login(...args)))
      const versionRead = vi.spyOn(reads, 'readProgramVersion').mockImplementation((...args) => observe(version(...args)))

      const expired = await probeAfter(1500)
      expect(expired).toMatchObject({ status: 'ready', login: 'unknown' })
      expect(expired.program).toBeUndefined()
      expect(loginRead).not.toHaveBeenCalled()
      expect(versionRead).not.toHaveBeenCalled()

      const result = await probeAfter(1000)
      expect(loginRead).toHaveBeenCalledExactlyOnceWith(record, { timeoutMs: 500 })
      expect(versionRead).toHaveBeenCalledExactlyOnceWith(record, { timeoutMs: 500 })
      expect(overlapped).toBe(true)
      expect(performance.now() - started!).toBeLessThan(4000)
      expect(result).toMatchObject({ status: 'ready', login: 'unknown', program: { name: 'Codex' } })
      expect(result.program).not.toHaveProperty('version')
    },
  )

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

  it('runs Codex login and its status against the selected directory even when the terminal uses a different account', async () => {
    const directory = await root()
    const own = join(directory, "work's account")
    const elsewhere = join(directory, 'personal')
    const bin = join(directory, 'bin')
    for (const path of [own, elsewhere, bin]) await mkdir(path)
    const proxy = 'http://fixture-user:fake-proxy-password@proxy.example:8080'
    const mise = "fixture's mise state\n$(echo uninterpreted-mise-state) café\n"
    const otherKey = 'unrelated-account-key'
    const program = join(bin, 'codex')
    await writeFile(
      program,
      [
        '#!/bin/sh',
        '[ "$CODEX_HOME" = "$CODEX_SQLITE_HOME" ] && [ -z "$OPENAI_API_KEY" ] || exit 7',
        'if [ "$2" = status ]; then [ -f "$CODEX_HOME/login" ] || { echo "Not logged in"; exit 1; };',
        'else [ "$#" = 1 ] && [ "$1" = login ] && [ "$SSL_CERT_FILE" = "/fixtures/CA bundle.pem" ] || exit 8;',
        '[ -z "${ALL_PROXY+x}" ] && IFS= read -r reply && [ "$reply" = "browser reply" ] || exit 9;',
        'printf "%s" "$HTTPS_PROXY" > "$CODEX_HOME/proxy"; printf "%s" "$__MISE_DIFF" > "$CODEX_HOME/mise";',
        'touch "$CODEX_HOME/login"; fi',
      ].join('\n'),
      { mode: 0o700 },
    )
    useOnly(bin)
    const record = { ...codexAdapter(), accountDirectory: own }
    expect((await checkLogin(record)).status).toBe('unauthenticated')
    const script = join(directory, 'login.command')
    const source = loginTerminalScript(record, undefined, { inLatch: true })!
    for (const value of [proxy, otherKey, 'uninterpreted-mise-state']) expect(source).not.toContain(value)
    // Let the clean shell try to read the pipe before awk writes its first byte.
    const delayed = source.replace(/^(  LC_ALL=C \/usr\/bin\/awk[\s\S]+?)( \|\n    \/usr\/bin\/env -i )/mu, '{ /bin/sleep 0.5; $1; }$2')
    expect(delayed).not.toBe(source)
    await writeFile(script, delayed, { mode: 0o700 })
    const login = run('/bin/sh', ['-x', script], {
      env: {
        PATH: '/usr/bin:/bin',
        CODEX_HOME: elsewhere,
        OPENAI_API_KEY: otherKey,
        HTTPS_PROXY: proxy,
        __MISE_DIFF: mise,
        SSL_CERT_FILE: '/fixtures/CA bundle.pem',
      },
    })
    login.child.stdin!.end('browser reply\n')
    const { stdout, stderr } = await login
    for (const value of [proxy, otherKey, 'uninterpreted-mise-state']) {
      expect(stdout).not.toContain(value)
      expect(stderr).not.toContain(value)
    }
    await expect(readFile(join(own, 'proxy'), 'utf8')).resolves.toBe(proxy)
    await expect(readFile(join(own, 'mise'), 'utf8')).resolves.toBe(mise)
    expect((await checkLogin(record)).status).toBe('authenticated')
    expect(existsSync(join(elsewhere, 'login'))).toBe(false)
  })

  it('allows Enterprise ADC only with a known agy version and leaves personal quota and sign-in to the default profile', async () => {
    const directory = await root()
    const bin = join(directory, 'bin')
    await mkdir(bin)
    const recorded = join(directory, 'application_default_credentials.json')
    await writeFile(recorded, 'fixture')
    const program = join(bin, 'agy')
    useOnly(bin)
    const original = presetRecord('antigravity')!
    const account = { ...original, accountDirectory: directory }
    await writeFile(program, '#!/bin/sh\necho unknown', { mode: 0o700 })
    await expect(assertCommandVersion(account)).rejects.toMatchObject({ code: 'harness-version-unsupported' })
    await writeFile(program, '#!/bin/sh\necho 1.5.8')
    await expect(assertCommandVersion(account)).resolves.toBeUndefined()
    expect(loginTerminalScript(account)).toBeUndefined()
    expect(selectProfile(account).profile?.quota).toBeUndefined()
    expect(selectProfile(original).profile?.quota).toBeDefined()
  })

  it('runs named Qwen only on a known version, with login in the account home and project dotenv confined to the project', async () => {
    const directory = await root()
    const bin = join(directory, 'bin')
    const own = join(directory, "work's account")
    const elsewhere = join(directory, 'others')
    const workspace = join(elsewhere, 'project')
    await Promise.all([mkdir(bin), mkdir(own), mkdir(workspace, { recursive: true })])
    const path = join(bin, 'qwen')
    const version = join(bin, 'version')
    await writeFile(
      path,
      [
        '#!/bin/sh',
        '[ "$PWD" = "$HOME" ] && [ "$QWEN_HOME" = "$HOME" ] && [ "$QWEN_RUNTIME_DIR" = "$HOME" ] || exit 7',
        '[ -z "$OPENAI_API_KEY" ] || exit 8',
        'if [ "$1" = "--version" ]; then exec /bin/cat "${0%/*}/version"; fi',
        'touch "$HOME/signed-in"',
      ].join('\n'),
      { mode: 0o700 },
    )
    useOnly(bin)
    const legacy = presetRecord('qwen')!
    const account = { ...legacy, accountDirectory: own }
    const script = join(directory, 'login.command')
    const open = async () => {
      await writeFile(script, loginTerminalScript(account, undefined, { inLatch: true })!, { mode: 0o700 })
      return run('/bin/sh', [script], {
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin', HOME: elsewhere, QWEN_HOME: elsewhere, OPENAI_API_KEY: 'fake-other' },
      })
    }
    for (const rejected of ['unknown', ' ', '0.27.3', '0.27.4-rc.1']) {
      await writeFile(version, `${rejected}\n`)
      await expect(assertCommandVersion(account)).rejects.toMatchObject({ code: 'harness-version-unsupported' })
      await expect(open()).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('0.27.4') })
    }
    expect(existsSync(join(own, 'signed-in'))).toBe(false)
    await expect(assertCommandVersion(legacy)).resolves.toBeUndefined()
    await writeFile(version, 'v0.27.4\n')
    await expect(assertCommandVersion(account)).resolves.toBeUndefined()
    await open()
    expect(existsSync(join(own, 'signed-in'))).toBe(true)
    expect(existsSync(join(elsewhere, 'signed-in'))).toBe(false)
    expect(selectProfile(account).profile?.quota).toBeUndefined()

    await writeFile(join(workspace, '.env'), 'PROJECT_VALUE=fixture\n')
    expect(() => assertAccountWorkspace(account, workspace)).not.toThrow()
    const ancestorEnv = join(elsewhere, '.env')
    await writeFile(ancestorEnv, 'OPENAI_API_KEY=fake-personal\n')
    expect(() => assertAccountWorkspace(account, workspace)).toThrow(expect.objectContaining({ code: 'harness-account-unavailable' }))
    expect(() => assertAccountWorkspace(legacy, workspace)).not.toThrow()
    await expect(agentProbePreview(account, { dataDir: directory, cwd: workspace })).rejects.toMatchObject({
      code: 'harness-account-unavailable',
    })
    await rm(join(workspace, '.env'))
    const outsideEnv = join(directory, 'outside.env')
    await rename(ancestorEnv, outsideEnv)
    await symlink(outsideEnv, join(workspace, '.env'))
    expect(() => assertAccountWorkspace(account, workspace)).toThrow(expect.objectContaining({ code: 'harness-account-unavailable' }))
  })

  it('probes, lists models and starts a Qwen session with the same named home', async () => {
    const directory = await root()
    const workspace = join(directory, 'workspace')
    const own = join(directory, 'account')
    const bin = join(directory, 'bin')
    const marks = join(directory, 'started')
    const dataDir = join(directory, 'data')
    const tmpRoot = join(directory, 'tmp')
    await Promise.all([mkdir(workspace), mkdir(own), mkdir(bin), mkdir(tmpRoot, { mode: 0o700 })])
    await writeFile(
      join(bin, 'qwen'),
      [
        '#!/bin/sh',
        `[ "$HOME" = '${own}' ] && [ "$HOME" = "$QWEN_HOME" ] && [ "$HOME" = "$QWEN_RUNTIME_DIR" ] || exit 7`,
        'if [ "$1" = "--version" ]; then [ "$PWD" = "$HOME" ] || exit 8; echo 0.27.4; exit 0; fi',
        `printf '%s\\n' "$HOME" >> '${marks}'`,
        'export FAKE_ACP_CONFIG=options FAKE_ACP_MODES=plan,default,auto-edit,auto,yolo FAKE_ACP_INITIAL_MODE=default',
        `exec '${process.execPath}' '${FAKE_ACP_AGENT}'`,
      ].join('\n'),
      { mode: 0o700 },
    )
    useOnly(bin)
    const account = { ...presetRecord('qwen')!, accountDirectory: own }
    const projectEnv = join(workspace, '.env')
    await writeFile(projectEnv, 'MODEL=one\n')
    const fixedMtime = new Date('2026-10-01T00:00:00Z')
    await utimes(projectEnv, fixedMtime, fixedMtime)
    const preview = await agentProbePreview(account, { dataDir, cwd: workspace })
    expect(await probeAgent(account, { dataDir, cwd: workspace, expectedLaunchHash: preview.launchHash })).toMatchObject({
      status: 'ready',
    })
    const driver = await activate(createAcpAgentPlugin(account, { log: () => {}, stopGraceMs: 300 }), cleanups)
    const bridge = await openBridge(driver, { dataDir, workspace, tmpRoot }, cleanups)
    expect(await bridge.readCatalogue!({ auto: false })).toEqual({ ran: true })
    expect(bridge.catalogue?.()?.options).toContainEqual(expect.objectContaining({ category: 'model' }))
    const { sessionId } = await bridge.createTask({ prompt: 'fixture', requestId: 'qwen-bound' })
    await expect.poll(async () => (await bridge.detail(sessionId)).summary.status).toBe('idle')
    expect(bridge.quotaRead?.()).toBeUndefined()
    expect((await readFile(marks, 'utf8')).trim().split('\n')).toEqual([own, own, own])
    const initial = await bridge.launchPreview!({ cwd: workspace })
    await writeFile(join(own, '.env'), 'MODEL=private\n')
    expect((await bridge.launchPreview!({ cwd: workspace })).launchHash).toBe(initial.launchHash)
    await writeFile(projectEnv, 'MODEL=two\n')
    await utimes(projectEnv, fixedMtime, fixedMtime)
    await expect(bridge.prompt(sessionId, 'changed', 'qwen-changed')).rejects.toMatchObject({ code: 'project-config-changed' })
    await writeFile(join(directory, '.env'), 'OPENAI_API_KEY=fake-personal\n')
    await expect(bridge.prompt(sessionId, 'blocked', 'qwen-blocked')).rejects.toMatchObject({ code: 'harness-account-unavailable' })
    expect((await readFile(marks, 'utf8')).trim().split('\n')).toEqual([own, own, own])
  })

  it('fingerprints a named Qwen project dotenv link, changes to its target, and its removal', async () => {
    const directory = await root()
    const workspace = join(directory, 'workspace')
    const own = join(directory, 'account')
    const bin = join(directory, 'bin')
    await Promise.all([mkdir(workspace), mkdir(own), mkdir(bin)])
    await writeFile(join(bin, 'qwen'), '#!/bin/sh\n', { mode: 0o700 })
    useOnly(bin)
    const legacy = presetRecord('qwen')!
    const account = { ...legacy, accountDirectory: own }
    const qwenDir = join(workspace, '.qwen')
    const qwenEnv = join(qwenDir, '.env')
    const first = join(workspace, 'first.env')
    const second = join(workspace, 'second.env')
    await mkdir(qwenDir)
    await writeFile(first, 'MODEL=one\n')
    await writeFile(second, 'MODEL=one\n')
    const preview = (record: AgentRecord = account) => agentProbePreview(record, { dataDir: directory, cwd: workspace })
    const legacyBefore = await preview(legacy)
    await writeFile(join(workspace, '.env'), 'MODEL=legacy\n')
    expect((await preview(legacy)).launchHash).toBe(legacyBefore.launchHash)
    const absent = await preview()
    await symlink(first, qwenEnv)
    const linked = await preview()
    expect(linked.launchHash).not.toBe(absent.launchHash)
    await writeFile(first, 'MODEL=new-version\n')
    const changed = await preview()
    expect(changed.launchHash).not.toBe(linked.launchHash)
    await rm(qwenEnv)
    await symlink(second, qwenEnv)
    expect((await preview()).launchHash).not.toBe(changed.launchHash)
    await rm(qwenEnv)
    expect((await preview()).launchHash).toBe(absent.launchHash)
  })

  it('ends a Latch terminal’s script with the same command and its exit code, without words about a window', async () => {
    const directory = await root()
    const bin = join(directory, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'codex'), '#!/bin/sh\necho "ran $*"\nexit 7\n')
    await chmod(join(bin, 'codex'), 0o755)
    useOnly(bin)
    const record = codexAdapter()
    const script = loginTerminalScript(record, undefined, { inLatch: true })!
    // What the default terminal app is handed, less its closing line.
    expect(loginTerminalScript(record)!.startsWith(script)).toBe(true)
    expect(script).not.toContain('Latch')
    const path = join(directory, 'run.command')
    await writeFile(path, script, { mode: 0o700 })
    await expect(run('/bin/sh', [path], { cwd: directory })).rejects.toMatchObject({ code: 7, stdout: 'ran login\n' })
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
    // Directly, the check is the person's own `claude`; on the adapter, the CLI the adapter ships.
    await expect(checkLogin(presetRecord('claude-agent')!)).resolves.toEqual({ status: 'unknown' })
    expect(await readFile(ran, 'utf8')).toBe('claude auth status --json\n')
    const adapter = { ...presetRecord('claude-agent')!, command: 'claude-agent-acp' }
    expect(harnessLogin(adapter)).toEqual({ note: expect.stringContaining('Claude Code 自己的方式登录'), checkable: true })
    await expect(checkLogin(adapter)).resolves.toEqual({ status: 'unknown' })
    const both = 'claude auth status --json\nclaude-agent-acp --cli auth status --json\n'
    expect(await readFile(ran, 'utf8')).toBe(both)
    expect(harnessLogin(presetRecord('cursor')!)).toEqual({ command: 'cursor-agent login' })
    expect(loginTerminalScript(presetRecord('cursor')!)).toContain(`'${join(bin, 'cursor-agent')}' 'login'`)
    // Cursor has no status command, and a script is only written.
    expect(await readFile(ran, 'utf8')).toBe(both)
  })
})
