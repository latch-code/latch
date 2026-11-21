import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_LAUNCH_FILE,
  desktopLaunchOptions,
  desktopShellEnvironment,
  ensureDesktopHost,
  hostSettingsInEnvironment,
  probeDesktopHost,
  REBUILT_NOTICE,
} from '../scripts/desktop-host.ts'
import { queryHostInfo, readHostState } from '../src/host-state.ts'
import { defaultPolicy } from '../src/policy.ts'

const require = createRequire(import.meta.url)
const TSX = pathToFileURL(require.resolve('tsx/esm')).href
const FAKE_HOST_ID = 'fpi3wdcevcl4gct2ucmrzxry3adc7zcb3zinud2gqjjuj5qc5atq'
const SECRET_MARKERS = ['ldc1.', 'lpi1-', 'lpo1-', 'token=', 'harness_link=']

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'latch-desktop-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Stops a Host this test started, and only that one. */
function stopLater(pid: number) {
  cleanups.push(async () => {
    if (!alive(pid)) return
    process.kill(pid, 'SIGTERM')
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 })
  })
}

/** A stand-in Host: serves host-info on its own 0700 socket dir, writes host.json v2 and records how it was launched. */
const FAKE_HOST = `
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
const args = process.argv.slice(2)
const dataDir = args[args.indexOf('--data-dir') + 1]
const runtime = join(dataDir, 'run')
mkdirSync(runtime, { recursive: true, mode: 0o700 })
const socketPath = join(runtime, 'host.sock')
const instanceId = randomUUID()
const startedAt = new Date().toISOString()
writeFileSync(join(dataDir, 'launch-' + process.pid + '.json'), JSON.stringify({ argv: args, execArgv: process.execArgv, env: process.env }))
// As readCodeBuild: this script's bytes as it started, and no page build beside it.
const build = createHash('sha256').update(readFileSync(process.argv[1])).update('\0').update('').digest('hex')
const info = { product: 'Latch', version: '0.1.0', hostId: '${FAKE_HOST_ID}', instanceId, pid: process.pid, startedAt,
  loopbackOrigin: 'http://h-${FAKE_HOST_ID}.localhost:1', tlsOrigin: null, devMode: true, presence: { status: 'unavailable' }, activeSessions: 0, build }
const server = createServer((req, res) => {
  if (req.url !== '/link/api/host-info') { res.writeHead(404); res.end(); return }
  // <data>/busy.json: the sessions running and waiting that the test sets.
  let activity = { running: 0, waiting: 0 }
  try { activity = JSON.parse(readFileSync(join(dataDir, 'busy.json'), 'utf8')) } catch {}
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ...info, activeSessions: activity.running + activity.waiting, activity }))
})
server.listen(socketPath, () => {
  const state = { version: 2, pid: process.pid, hostId: info.hostId, instanceId, socketPath, loopbackOrigin: info.loopbackOrigin, tlsOrigin: null, startedAt, dataDir }
  writeFileSync(join(dataDir, '.host.tmp'), JSON.stringify(state), { mode: 0o600 })
  renameSync(join(dataDir, '.host.tmp'), join(dataDir, 'host.json'))
})
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`

async function fakeHostScript() {
  const path = join(await directory(), 'fake-host.mjs')
  await writeFile(path, FAKE_HOST)
  return path
}

function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // Neither the developer's Host settings nor runner flags such as LATCH_BROWSER_PATH are part of this fixture's.
  for (const name of Object.keys(env)) if (/^(?:LATCH|HARNESS)_/u.test(name)) delete env[name]
  return { ...env, ...extra }
}

describe('desktop Host launch', () => {
  it('starts a Host in the chosen directory, verifies it over host.sock and reuses only that instance', async () => {
    const root = await directory()
    const cwd = join(root, 'cwd')
    await mkdir(cwd)
    const dataDir = join(root, 'data')
    // No local confirmation backend: the spawned Host neither builds nor runs the macOS helper.
    await mkdir(dataDir, { mode: 0o700 })
    await writeFile(
      join(dataDir, 'policy.json'),
      JSON.stringify({ ...defaultPolicy(process.platform), presence: { backend: 'none', helperCdhash: null } }),
      { mode: 0o600 },
    )
    const env = cleanEnvironment({ LATCH_DATA_DIR: join(root, 'environment') })
    const options = desktopLaunchOptions(['--data-dir', dataDir, '--demo', '--port', '0', '--workspace', join(root, 'workspace')], cwd, env)
    expect(options.args.filter(arg => arg === '--data-dir')).toHaveLength(1)
    const host = await ensureDesktopHost(options, { script: resolve('apps/host/scripts/start.ts'), nodeArgs: ['--import', TSX] })
    stopLater(host.pid)
    expect(host.reused).toBe(false)
    expect(host.hostStatePath).toBe(join(dataDir, 'host.json'))
    const state = await readHostState(dataDir)
    expect(state).toMatchObject({ version: 2, pid: host.pid, hostId: host.hostId, instanceId: host.instanceId })
    expect((await stat(join(dataDir, 'host.json'))).mode & 0o777).toBe(0o600)
    expect(await queryHostInfo(state!.socketPath)).toMatchObject({
      product: 'Latch',
      pid: host.pid,
      hostId: host.hostId,
      instanceId: host.instanceId,
    })
    await expect(stat(join(root, 'environment'))).rejects.toMatchObject({ code: 'ENOENT' })

    // The unknown Harness would make a fresh start fail, so success proves the live instance was reused.
    const reused = await ensureDesktopHost(desktopLaunchOptions(['--data-dir', dataDir, '--harness', 'missing-harness'], cwd, env))
    expect(reused).toMatchObject({ pid: host.pid, hostId: host.hostId, instanceId: host.instanceId, reused: true })
    expect(reused.notice).toContain('不会重新应用')

    // SIGUSR1 is what process._debugProcess sends; the Host ignores it instead of opening an inspector.
    process.kill(host.pid, 'SIGUSR1')
    await delay(300)
    expect(await probeDesktopHost(dataDir, 2_000, host.pid)).toMatchObject({ instanceId: host.instanceId })

    const log = await readFile(join(dataDir, 'host.log'), 'utf8')
    expect(log).not.toMatch(/debugger listening|inspector/iu)
    expect((await stat(join(dataDir, 'host.log'))).mode & 0o777).toBe(0o600)
    for (const marker of SECRET_MARKERS) expect(log).not.toContain(marker)
    const hostJson = await readFile(join(dataDir, 'host.json'), 'utf8')
    for (const marker of SECRET_MARKERS) expect(hostJson).not.toContain(marker)
  }, 90_000)

  // The move itself is macOS's (data-home.test.ts covers its rules on every platform).
  it.runIf(process.platform === 'darwin')(
    'moves the old default data directory before starting a Host, and leaves a running one where it is',
    async () => {
      // A short home: the stand-in Host listens on a socket inside the data directory, and a socket path is at most 103 bytes.
      const home = await mkdtemp('/tmp/lh-')
      cleanups.push(() => rm(home, { recursive: true, force: true }))
      const cwd = join(home, 'cwd')
      await mkdir(cwd)
      const old = join(home, 'Library', 'Application Support', 'Latch', 'Host')
      const now = join(home, '.latch', 'host')
      await mkdir(old, { recursive: true, mode: 0o700 })
      await writeFile(join(old, 'kept.json'), '{}', { mode: 0o600 })
      const script = await fakeHostScript()
      const env = cleanEnvironment()
      // As `pnpm desktop` with no flag finds it: the old place, not named by the person.
      const found = { ...desktopLaunchOptions(['--data-dir', old], cwd, env), dataDirExplicit: false }

      // A Host still running from the old place is reused there: nothing moves under it.
      const running = await ensureDesktopHost(found, { script })
      stopLater(running.pid)
      const again = await ensureDesktopHost(found, { script, home })
      expect(again).toMatchObject({ pid: running.pid, reused: true, hostStatePath: join(old, 'host.json') })
      expect((await lstat(old)).isDirectory()).toBe(true)
      // The packaged app asks for the new place while that Host runs: refused, nothing created there.
      await expect(ensureDesktopHost(desktopLaunchOptions(['--data-dir', now], cwd, env), { script, home })).rejects.toMatchObject({
        code: 'data-dir-move-busy',
      })
      await expect(lstat(now)).rejects.toMatchObject({ code: 'ENOENT' })

      // A new build: the launcher stops that Host, moves the directory, and starts and waits for the Host at the new
      // place (not at the old one, where nothing will ever appear).
      await writeFile(script, `${FAKE_HOST}\n// a newer build\n`)
      const moved = await ensureDesktopHost(found, { script, home, timeoutMs: 15_000 })
      stopLater(moved.pid)
      expect(alive(running.pid)).toBe(false)
      expect(moved.reused).toBe(false)
      expect(moved.hostStatePath).toBe(join(now, 'host.json'))
      expect(moved.notice).toContain(now)
      expect(moved.notice).toContain(REBUILT_NOTICE)
      expect(await readFile(join(now, 'kept.json'), 'utf8')).toBe('{}')
      expect((await lstat(old)).isFile()).toBe(true)
      const launched = JSON.parse(await readFile(join(now, `launch-${moved.pid}.json`), 'utf8')) as { argv: string[] }
      expect(launched.argv.slice(0, 2)).toEqual(['--data-dir', now])
      expect(alive(moved.pid)).toBe(true)

      // A launch that still names the old place (a record from before the move) reaches the Host where the data is.
      const stale = await ensureDesktopHost(desktopLaunchOptions(['--data-dir', old], cwd, env), { script, home })
      expect(stale).toMatchObject({ pid: moved.pid, reused: true, hostStatePath: join(now, 'host.json') })
    },
    90_000,
  )

  it('launches the Host without adding a URL or token to its environment', async () => {
    const root = await directory()
    const dataDir = join(root, 'data')
    const parent = cleanEnvironment({
      LATCH_DESKTOP_URL: 'http://127.0.0.1:1/link/#token=leak',
      ELECTRON_RUN_AS_NODE: '1',
    })
    const options = desktopLaunchOptions(['--data-dir', dataDir, '--demo'], root, parent)
    const host = await ensureDesktopHost(options, { script: await fakeHostScript(), timeoutMs: 10_000 })
    stopLater(host.pid)
    expect(host).toMatchObject({ reused: false, hostId: FAKE_HOST_ID, info: { pid: host.pid, instanceId: host.instanceId } })
    const launch = JSON.parse(await readFile(join(dataDir, `launch-${host.pid}.json`), 'utf8')) as {
      argv: string[]
      execArgv: string[]
      env: Record<string, string>
    }
    expect(launch.argv).toEqual(['--data-dir', dataDir, '--demo'])
    expect(launch.execArgv).toEqual(['--disable-sigusr1'])
    expect(launch.env.LATCH_DESKTOP_URL).toBeUndefined()
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    const added = Object.keys(launch.env).filter(name => !(name in parent) && name !== '__CF_USER_TEXT_ENCODING')
    expect(added).toEqual([])
    for (const [name, value] of Object.entries(launch.env)) {
      for (const marker of SECRET_MARKERS) expect(value, name).not.toContain(marker)
    }
    expect((await stat(join(dataDir, 'host.log'))).mode & 0o777).toBe(0o600)

    const reused = await ensureDesktopHost(options, { script: await fakeHostScript() })
    expect(reused).toMatchObject({ reused: true, pid: host.pid, instanceId: host.instanceId })
  })

  it('records how it started the Host, without the launch when the environment carries Host settings', async () => {
    const root = await directory()
    const script = await fakeHostScript()
    const dataDir = join(root, 'data')
    const options = desktopLaunchOptions(['--data-dir', dataDir, '--demo'], root, cleanEnvironment({ LATCH_DATA_DIR: join(root, 'x') }))
    expect(options.repeatable).toBe(true)
    const host = await ensureDesktopHost(options, { script, timeoutMs: 10_000 })
    stopLater(host.pid)
    const recordPath = join(dataDir, DESKTOP_LAUNCH_FILE)
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(recordPath, 'utf8'))).toEqual({
      version: 1,
      pid: host.pid,
      hostId: FAKE_HOST_ID,
      launch: { node: process.execPath, nodeArgs: [], script, args: ['--data-dir', dataDir, '--demo'], cwd: root },
    })
    // Reusing the Host leaves the record of the launch that started it.
    await ensureDesktopHost(desktopLaunchOptions(['--data-dir', dataDir, '--harness', 'other'], root, cleanEnvironment()), { script })
    expect(JSON.parse(await readFile(recordPath, 'utf8'))).toMatchObject({
      pid: host.pid,
      launch: { args: ['--data-dir', dataDir, '--demo'] },
    })

    // The desktop app runs without Host settings in its environment, so it could not start this Host the same way.
    for (const name of ['MODEL', 'API_KEY', 'TLS_CERT', 'PORT', 'WORKSPACE', 'AGENTS_DIR']) {
      expect(hostSettingsInEnvironment({ [`LATCH_${name}`]: 'x' }), name).toBe(true)
    }
    // The data directory becomes an argument; other LATCH_ variables (a build's Go toolchain, test switches) are no settings.
    expect(
      hostSettingsInEnvironment({ LATCH_DATA_DIR: 'x', LATCH_DESKTOP_URL: 'x', LATCH_RELAY_GO: 'go', LATCH_VISUAL_BASELINE: '1' }),
    ).toBe(false)
    const other = join(root, 'other')
    const fromEnvironment = desktopLaunchOptions(['--data-dir', other], root, { ...cleanEnvironment(), LATCH_MODEL: 'gpt-test' })
    expect(fromEnvironment.repeatable).toBe(false)
    const second = await ensureDesktopHost(fromEnvironment, { script, timeoutMs: 10_000 })
    stopLater(second.pid)
    expect(JSON.parse(await readFile(join(other, DESKTOP_LAUNCH_FILE), 'utf8'))).toEqual({
      version: 1,
      pid: second.pid,
      hostId: FAKE_HOST_ID,
      launch: null,
    })
  })

  it('restarts an idle Host it started from an older build, and keeps a busy one or one it did not start', async () => {
    const root = await directory()
    const script = await fakeHostScript()
    const dataDir = join(root, 'data')
    const options = desktopLaunchOptions(['--data-dir', dataDir], root, cleanEnvironment())
    const first = await ensureDesktopHost(options, { script, timeoutMs: 10_000 })
    stopLater(first.pid)
    // The same build: reused as before.
    const same = await ensureDesktopHost(options, { script })
    expect(same).toMatchObject({ pid: first.pid, reused: true })
    expect(same.notice).not.toContain('检测到新的构建')

    // A rebuild while a session waits for an approval: kept, and said so.
    const rebuild = (mark: string) => writeFile(script, `${FAKE_HOST}\n// ${mark}\n`)
    await rebuild('second build')
    await writeFile(join(dataDir, 'busy.json'), JSON.stringify({ running: 0, waiting: 1 }))
    const busy = await ensureDesktopHost(options, { script })
    expect(busy).toMatchObject({ pid: first.pid, reused: true })
    expect(busy.notice?.split('\n')[0]).toBe('检测到新的构建，但有会话正在运行或等待审批，未重启 Host；结束后在 Latch 中点「重启 Latch」。')
    expect(alive(first.pid)).toBe(true)

    // Idle: stopped (announced, SIGTERM, waited for) and started again from the build on disk.
    await rm(join(dataDir, 'busy.json'))
    const restarted = await ensureDesktopHost(options, { script, timeoutMs: 10_000 })
    stopLater(restarted.pid)
    expect(restarted.reused).toBe(false)
    expect(restarted.notice).toBe(REBUILT_NOTICE)
    expect(restarted.pid).not.toBe(first.pid)
    expect(alive(first.pid)).toBe(false)
    expect(JSON.parse(await readFile(join(dataDir, DESKTOP_LAUNCH_FILE), 'utf8'))).toMatchObject({ pid: restarted.pid })
    expect(await ensureDesktopHost(options, { script })).toMatchObject({ pid: restarted.pid, reused: true })

    // Not the Host the record names (`pnpm start`, another checkout): reused as before, its build not compared.
    await rebuild('third build')
    const recordPath = join(dataDir, DESKTOP_LAUNCH_FILE)
    const record = JSON.parse(await readFile(recordPath, 'utf8'))
    await writeFile(recordPath, JSON.stringify({ ...record, pid: restarted.pid + 1 }))
    const foreign = await ensureDesktopHost(options, { script })
    expect(foreign).toMatchObject({ pid: restarted.pid, reused: true })
    expect(foreign.notice).toBe(same.notice)
    // Settings from the environment that this launch does not have: kept, rather than started without them.
    await writeFile(recordPath, JSON.stringify({ ...record, launch: null }))
    const environment = await ensureDesktopHost(options, { script })
    expect(environment).toMatchObject({ pid: restarted.pid, reused: true })
    expect(environment.notice).toContain('设置来自环境变量，未重启')
    expect(environment.notice).toContain('在终端中直接运行 corepack pnpm desktop')
    expect(alive(restarted.pid)).toBe(true)
  }, 60_000)

  it('keeps the Host it started when the launch record cannot be written, and says what that means', async () => {
    const root = await directory()
    const script = await fakeHostScript()
    const dataDir = join(root, 'data')
    // A directory in the record's place: the atomic rename onto it fails.
    await mkdir(join(dataDir, DESKTOP_LAUNCH_FILE, 'occupied'), { recursive: true, mode: 0o700 })
    const host = await ensureDesktopHost(desktopLaunchOptions(['--data-dir', dataDir], root, cleanEnvironment()), {
      script,
      timeoutMs: 10_000,
    })
    stopLater(host.pid)
    expect(host.reused).toBe(false)
    expect(host.notice).toBe(
      `无法写入 ${join(dataDir, DESKTOP_LAUNCH_FILE)}（EISDIR）。Host 已启动，但它意外退出后桌面端不会自动重新启动它。`,
    )
    expect(await probeDesktopHost(dataDir, 2_000, host.pid)).toMatchObject({ pid: host.pid })
  })

  it('does not reuse a Host whose socket directory, pid or identity does not check out', async () => {
    const root = await directory()
    const dataDir = join(root, 'data')
    const host = await ensureDesktopHost(desktopLaunchOptions(['--data-dir', dataDir], root, cleanEnvironment()), {
      script: await fakeHostScript(),
      timeoutMs: 10_000,
    })
    stopLater(host.pid)
    const state = (await readHostState(dataDir))!
    expect(await probeDesktopHost(dataDir)).toMatchObject({ pid: host.pid, instanceId: host.instanceId })
    expect(await probeDesktopHost(dataDir, 2_000, host.pid + 1)).toBeUndefined()

    await chmod(join(dataDir, 'run'), 0o755)
    expect(await probeDesktopHost(dataDir)).toBeUndefined()
    await chmod(join(dataDir, 'run'), 0o700)
    expect(await probeDesktopHost(dataDir)).toBeDefined()

    const write = (value: unknown) => writeFile(join(dataDir, 'host.json'), JSON.stringify(value), { mode: 0o600 })
    const exited = spawnSync(process.execPath, ['-e', ''])
    await write({ ...state, pid: exited.pid })
    expect(await probeDesktopHost(dataDir)).toBeUndefined()
    await write({ ...state, instanceId: '00000000-0000-4000-8000-000000000000' })
    expect(await probeDesktopHost(dataDir)).toBeUndefined()
    await write({ pid: state.pid, origin: 'http://127.0.0.1:1', instanceId: state.instanceId })
    expect(await probeDesktopHost(dataDir)).toBeUndefined()
    await write(state)
    expect(await probeDesktopHost(dataDir)).toBeDefined()
  })

  it('refuses a symlinked host.log and stops a Host that never becomes ready', async () => {
    const root = await directory()
    const dataDir = join(root, 'data')
    await mkdir(dataDir, { mode: 0o700 })
    const target = join(root, 'elsewhere.txt')
    await writeFile(target, 'untouched')
    await symlink(target, join(dataDir, 'host.log'))
    await expect(
      ensureDesktopHost(desktopLaunchOptions(['--data-dir', dataDir], root, cleanEnvironment()), { script: await fakeHostScript() }),
    ).rejects.toMatchObject({ code: 'ELOOP' })
    expect(await readFile(target, 'utf8')).toBe('untouched')
    expect((await lstat(join(dataDir, 'host.log'))).isSymbolicLink()).toBe(true)

    const silent = join(root, 'silent.mjs')
    const pidFile = join(root, 'silent.pid')
    await writeFile(
      silent,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
    )
    const otherData = join(root, 'other')
    await expect(
      ensureDesktopHost(desktopLaunchOptions(['--data-dir', otherData], root, cleanEnvironment()), { script: silent, timeoutMs: 1_000 }),
    ).rejects.toThrow('节点启动失败')
    const pid = Number(await readFile(pidFile, 'utf8'))
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 })

    const crashing = join(root, 'crash.mjs')
    await writeFile(crashing, 'process.exit(3)')
    await expect(
      ensureDesktopHost(desktopLaunchOptions(['--data-dir', otherData], root, cleanEnvironment()), { script: crashing, timeoutMs: 10_000 }),
    ).rejects.toThrow(join(otherData, 'host.log'))
  })

  it('resolves the data directory once, like the Host, and rejects ambiguous values', async () => {
    const root = await directory()
    expect(desktopLaunchOptions(['--demo', '--data-dir=chosen'], root, { LATCH_DATA_DIR: 'ignored' }).args).toEqual([
      '--data-dir',
      join(root, 'chosen'),
      '--demo',
    ])
    expect(desktopLaunchOptions([], root, { LATCH_DATA_DIR: 'environment' }).dataDir).toBe(join(root, 'environment'))
    await mkdir(join(root, '.runtime'))
    const legacy = desktopLaunchOptions([], root, {})
    expect(legacy.dataDir).toBe(join(root, '.runtime'))
    expect(legacy.warnings.join('\n')).toContain('旧的数据目录')
    expect(legacy.hostStatePath).toBe(join(root, '.runtime', 'host.json'))
    expect(desktopLaunchOptions([], root, { LATCH_DESKTOP_URL: 'http://x/#token=y', PATH: '/bin' }).env).toEqual({ PATH: '/bin' })
    expect(() => desktopLaunchOptions(['--data-dir', '--demo'])).toThrow('requires a value')
    expect(() => desktopLaunchOptions(['--data-dir', 'one', '--data-dir=two'])).toThrow('only be specified once')
  })

  it('gives the shell no Host settings, model keys or debugging hooks', () => {
    expect(
      desktopShellEnvironment({
        PATH: '/bin',
        HOME: '/home/me',
        LANG: 'zh_CN.UTF-8',
        LATCH_API_KEY: 'sk-x',
        LATCH_DATA_DIR: '/d',
        LATCH_DESKTOP_URL: 'http://x/#token=y',
        NODE_OPTIONS: '--inspect',
        ELECTRON_RUN_AS_NODE: '1',
      }),
    ).toEqual({ PATH: '/bin', HOME: '/home/me', LANG: 'zh_CN.UTF-8' })
  })
})
