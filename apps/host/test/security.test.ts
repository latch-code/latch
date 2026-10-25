import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Device, EnrollmentView, InvitationView } from '@latch/protocol'
import { enrollSigningText, testDeviceKey, makeTestTls } from '@latch/testkit'
import { verifyAuditFile } from '../src/audit.ts'
import { BACKUP_EXCLUSION_ATTRIBUTE, BACKUP_EXCLUSION_VALUE } from '../src/backup.ts'
import { bootTime, readHostState, unixRequest, verifyHostState, writeHostState } from '../src/host-state.ts'
import { loadOrCreateHostIdentity } from '../src/identity.ts'
import { tlsListenerClass } from '../src/listeners.ts'
import { prepareRuntimeDir } from '../src/paths.ts'
import { defaultPolicy } from '../src/policy.ts'
import { hostBundleOptions } from '../scripts/host-bundle.ts'
import { startTestHost } from './helpers/host.ts'

const run = promisify(execFile)
const TSX = resolve('node_modules/.bin/tsx')
/** The Host runs in this very process (no tsx wrapper), so its pid is the child's pid. */
const TSX_LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href
const START = resolve('apps/host/scripts/start.ts')
const STOP = resolve('apps/host/scripts/stop.ts')
const LATCH = resolve('apps/host/scripts/latch.ts')
const SECRET_PATTERNS = [/ldc1\./u, /lpi1-/u, /lpo1-/u, /harness_link=/u, /token=/u]

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** The child sees no HARNESS_* variable from the developer's shell. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HARNESS_'))), ...extra }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  await new Promise<void>(done => server.close(() => done()))
  if (!address || typeof address === 'string') throw new Error('no port')
  return address.port
}

/** Temp root with a data dir whose policy turns local confirmation off: tests never build or show the real helper. */
async function prepare() {
  const root = await mkdtemp(join(tmpdir(), 'lt-sec-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { mode: 0o700 })
  await writeFile(
    join(dataDir, 'policy.json'),
    JSON.stringify({ ...defaultPolicy('darwin'), presence: { backend: 'none', helperCdhash: null } }),
    { mode: 0o600 },
  )
  return { root, dataDir, workspace: join(root, 'workspace') }
}

function collect(child: ChildProcess) {
  const output = { stdout: '', stderr: '' }
  child.stdout!.on('data', chunk => {
    output.stdout += String(chunk)
  })
  child.stderr!.on('data', chunk => {
    output.stderr += String(chunk)
  })
  return output
}

async function waitFor(check: () => boolean | Promise<boolean>, child: ChildProcess, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (child.exitCode !== null) throw new Error(`process exited with ${child.exitCode}`)
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(done => setTimeout(done, 50))
  }
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
}

describe('Host process', () => {
  it('prints exactly the documented lines, keeps every credential out of output and files, and stops through host.sock', async () => {
    const { root, dataDir, workspace } = await prepare()
    const tls = await makeTestTls(join(root, 'tls'))
    const tlsPort = await freePort()
    const codeFile = join(root, 'offline-code.txt')
    // Offline enrollment needs the Host stopped; it is how a device enrolls without local confirmation.
    const offline = await run(TSX, [LATCH, 'device', 'enroll', '--offline', '--code-file', codeFile, '--data-dir', dataDir], {
      cwd: root,
      env: childEnv(),
    })
    expect(offline.stdout).not.toMatch(/lpo1-/u)
    const code = (await readFile(codeFile, 'utf8')).trim()

    const child = spawn(
      process.execPath,
      [
        '--import',
        TSX_LOADER,
        START,
        '--data-dir',
        dataDir,
        '--workspace',
        workspace,
        '--port',
        '0',
        '--demo',
        '--tls-cert',
        tls.certPath,
        '--tls-key',
        tls.keyPath,
        '--public-origin',
        `https://${tls.hostname}:${tlsPort}`,
        '--tls-host',
        '127.0.0.1',
        '--tls-port',
        String(tlsPort),
      ],
      { cwd: root, env: childEnv({ HARNESS_API_KEY: 'sk-never-printed' }), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const output = collect(child)
    let socketDir: string | undefined
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await new Promise(done => child.once('exit', done))
      }
      if (socketDir) await rm(socketDir, { recursive: true, force: true })
    })
    await waitFor(() => output.stdout.split('\n').length > 4, child)
    const lines = output.stdout.trimEnd().split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe('Latch 0.1.0 · 演示模型 / 真实工具')
    expect(lines[1]).toMatch(
      /^浏览器：http:\/\/h-[a-z2-7]{52}\.localhost:\d+\/link\/（新浏览器从 Latch 桌面端「在这台电脑的浏览器中打开」，或运行 pnpm latch device invite --loopback）$/u,
    )
    expect(lines[2]).toBe(`启动目录：${workspace}`)
    expect(lines[3]).toBe(`手机接入：https://${tls.hostname}:${tlsPort}/link/（在电脑上的 Latch 桌面端生成配对二维码）`)

    const state = (await readHostState(dataDir))!
    socketDir = dirname(state.socketPath)
    expect(state).toMatchObject({ version: 2, pid: child.pid, tlsOrigin: `https://${tls.hostname}:${tlsPort}`, dataDir })
    expect(lines[1]).toContain(state.loopbackOrigin)
    expect((await stat(join(dataDir, 'host.json'))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(join(dataDir, 'host.lock'), 'utf8'))).toMatchObject({ pid: child.pid, role: 'host' })
    expect(await verifyHostState(state)).toMatchObject({ pid: child.pid, hostId: state.hostId, presence: { status: 'unavailable' } })

    const invited = await unixRequest(state.socketPath, '/link/api/pairings', { method: 'POST', body: {} })
    expect(invited.status).toBe(201)
    expect((invited.body as { invitation: InvitationView }).invitation.code).toMatch(/^lpi1-/u)

    const key = testDeviceKey()
    const created = await unixRequest(state.socketPath, '/link/api/enrollments', {
      method: 'POST',
      body: { publicKey: key.spki, name: 'CLI desktop', offlineCode: code },
    })
    expect(created.status).toBe(202)
    const enrollment = (created.body as { enrollment: EnrollmentView }).enrollment
    expect(enrollment.status).toBe('approved')
    const completed = await unixRequest(state.socketPath, `/link/api/enrollments/${enrollment.id}/complete`, {
      method: 'POST',
      body: { signature: key.sign(enrollSigningText(state.hostId, enrollment.id, enrollment.nonce!)) },
    })
    expect(completed.status).toBe(200)
    const { credential, device } = completed.body as { credential: string; device: Device }
    expect(device.pairedBy.method).toBe('offline')
    const snapshot = await unixRequest(state.socketPath, '/link/api/snapshot', { headers: { authorization: `Latch-Device ${credential}` } })
    expect(snapshot.status).toBe(200)

    for (const file of await filesUnder(dataDir)) {
      const text = await readFile(file, 'utf8').catch(() => '')
      for (const pattern of SECRET_PATTERNS) expect(`${file}: ${pattern.test(text) ? 'contains secret' : 'clean'}`).toBe(`${file}: clean`)
      expect(text).not.toContain('sk-never-printed')
    }
    for (const pattern of SECRET_PATTERNS) {
      expect(output.stdout).not.toMatch(pattern)
      expect(output.stderr).not.toMatch(pattern)
    }
    expect(output.stdout + output.stderr).not.toContain('sk-never-printed')

    if (process.platform === 'darwin') {
      // Key material is kept out of Time Machine from the first start.
      for (const entry of ['auth', 'identity']) {
        const { stdout } = await run('/usr/bin/xattr', ['-p', '-x', BACKUP_EXCLUSION_ATTRIBUTE, join(dataDir, entry)])
        expect(stdout.replace(/\s+/gu, '').toLowerCase()).toBe(BACKUP_EXCLUSION_VALUE)
      }
    }

    // `--reason` reaches the clients: the Host's last frame on an open stream says it is updating and when to retry.
    const events = { text: '' }
    const stream = httpRequest({
      socketPath: state.socketPath,
      path: '/link/api/events',
      headers: { host: 'latch.unix', authorization: `Latch-Device ${credential}`, accept: 'text/event-stream' },
    })
    const ended = new Promise<void>(done => {
      stream.on('response', response => {
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (events.text += chunk))
        response.on('end', done)
        response.on('close', done)
      })
      stream.on('error', () => done())
    })
    stream.end()
    await waitFor(() => events.text.includes('event: refresh'), child)
    const stopped = await run(TSX, [STOP, '--data-dir', dataDir, '--reason', 'update'], { cwd: root, env: childEnv() })
    expect(stopped.stdout).toContain('Latch 运行节点已停止。')
    await ended
    const announced = /event: host-state\ndata: (.*)\n\n$/u.exec(events.text)
    expect(JSON.parse(announced![1]!)).toMatchObject({
      type: 'host-state',
      instanceId: state.instanceId,
      state: 'stopping',
      reason: 'update',
      retryAfter: 10,
    })
    const refused = await run(TSX, [STOP, '--data-dir', dataDir, '--reason', 'later'], { cwd: root, env: childEnv() }).then(
      () => ({ code: 0, stderr: '' }),
      (error: { code: number; stderr: string }) => error,
    )
    expect(refused).toMatchObject({ code: 1, stderr: expect.stringContaining('--reason 只能是 restart、update、shutdown') })
    expect(child.exitCode ?? (await new Promise(done => child.once('exit', done)))).toBe(0)
    expect(await readHostState(dataDir)).toBeUndefined()
    expect(existsSync(join(dataDir, 'host.lock'))).toBe(false)
    const again = await run(TSX, [STOP, '--data-dir', dataDir], { cwd: root, env: childEnv() })
    expect(again.stdout).toContain('没有正在运行的 Host')
  }, 60_000)

  it('refuses plaintext LAN access at startup', async () => {
    const { root, dataDir, workspace } = await prepare()
    for (const flags of [
      ['--lan'],
      ['--tailnet'],
      ['--host', '192.168.1.20'],
      ['--tls-host', '192.168.1.20'],
      ['--tls-cert', join(root, 'cert.pem')],
    ]) {
      const failure = await run(TSX, [START, '--data-dir', dataDir, '--workspace', workspace, '--port', '0', ...flags], {
        cwd: root,
        env: childEnv(),
      }).then(
        () => ({ code: 0, stderr: '' }),
        (error: { code: number; stderr: string }) => error,
      )
      expect(failure.code).toBe(1)
      expect(failure.stderr).toContain(
        '明文局域网接入已移除：请提供 --tls-cert、--tls-key 和 --public-origin（例如用 tailscale cert 生成的证书）。',
      )
    }
    expect(await readHostState(dataDir)).toBeUndefined()
  }, 60_000)

  it('runs only the Host when started from its bundle, never the presence helper build bundled with it', async () => {
    const { root, dataDir, workspace } = await prepare()
    // Bundled as apps/host/scripts/build.ts bundles dist/start.js, but outside the repository, so even a stray build
    // would find no code root to build in; the linked node_modules resolves the external packages. The path is real (not
    // through the /var symlink), as for dist/start.js in a checkout, so a bundled "am I the entry" check would match here
    // as there.
    const bundle = join(await realpath(root), 'bundle')
    await build({ ...(await hostBundleOptions()), entryPoints: { start: START }, outdir: bundle, logLevel: 'silent' })
    await symlink(resolve('node_modules'), join(bundle, 'node_modules'), 'dir')
    // An invalid port ends startup right after the arguments are read: any other output comes from code run on load.
    const failure = await run(
      process.execPath,
      ['--disable-sigusr1', join(bundle, 'start.js'), '--data-dir', dataDir, '--workspace', workspace, '--port', 'none'],
      { cwd: root, env: childEnv() },
    ).then(
      () => ({ code: 0, stdout: '', stderr: '' }),
      (error: { code: number; stdout: string; stderr: string }) => error,
    )
    expect(failure).toMatchObject({ code: 1, stdout: '', stderr: '端口无效\n' })
  }, 60_000)

  it('fails a Host bundle that reaches test code: @latch/testkit by name, or a file under packages/testkit/ or tests/', async () => {
    const options = await hostBundleOptions()
    const bundle = (contents: string) =>
      build({ ...options, stdin: { contents, resolveDir: process.cwd(), loader: 'ts' }, write: false, logLevel: 'silent' })
    // The guard refuses only test code: a production module still bundles with the same options.
    await expect(bundle("export { buildPreview } from './apps/host/src/presence.ts'")).resolves.toMatchObject({ errors: [] })
    await expect(bundle("export * from '@latch/testkit'")).rejects.toThrow('导入了 @latch/testkit：@latch/testkit 只供测试使用')
    await expect(bundle("export * from './packages/testkit/src/presence.ts'")).rejects.toThrow(
      'packages/testkit/src/presence.ts 是测试代码，不能进入 Host 构建',
    )
    await expect(bundle("export * from './tests/redact.test.ts'")).rejects.toThrow('tests/redact.test.ts 是测试代码，不能进入 Host 构建')
  })

  it('fails a Host bundle that reaches the end-to-end tests under e2e/, helpers included', async () => {
    const options = await hostBundleOptions()
    const bundle = (contents: string) =>
      build({ ...options, stdin: { contents, resolveDir: process.cwd(), loader: 'ts' }, write: false, logLevel: 'silent' })
    await expect(bundle("export * from './e2e/helpers/browser.ts'")).rejects.toThrow(
      'e2e/helpers/browser.ts 是测试代码，不能进入 Host 构建',
    )
    await expect(bundle("export * from './e2e/takeover.e2e.ts'")).rejects.toThrow('e2e/takeover.e2e.ts 是测试代码，不能进入 Host 构建')
  })

  it("fails a Host bundle that reaches a workspace project's test/ directory, where the project's own tests live", async () => {
    const options = await hostBundleOptions()
    const bundle = (contents: string) =>
      build({ ...options, stdin: { contents, resolveDir: process.cwd(), loader: 'ts' }, write: false, logLevel: 'silent' })
    await expect(bundle("export * from './apps/host/test/helpers/host.ts'")).rejects.toThrow(
      'apps/host/test/helpers/host.ts 是测试代码，不能进入 Host 构建',
    )
    await expect(bundle("export * from './packages/harness-acp/test/acp.test.ts'")).rejects.toThrow(
      'packages/harness-acp/test/acp.test.ts 是测试代码，不能进入 Host 构建',
    )
  })

  it('locks the data dir from before startup until exit, so offline commands, stop and a second start wait for host.json', async () => {
    const { root, dataDir, workspace } = await prepare()
    // Startup stops inside this plugin's activation until the gate file appears: the Host has opened its audit log and
    // stores but has not written host.json yet.
    const gate = join(root, 'gate')
    const plugin = join(root, 'gate-plugin.mjs')
    await writeFile(
      plugin,
      `import { existsSync } from 'node:fs'
export default { id: 'gate', name: 'Gate', version: '0.0.1', description: 'Holds startup until a file appears.',
  async activate() { while (!existsSync(${JSON.stringify(gate)})) await new Promise(done => setTimeout(done, 25)) } }
`,
    )
    const child = spawn(
      process.execPath,
      ['--import', TSX_LOADER, START, '--data-dir', dataDir, '--workspace', workspace, '--port', '0', '--plugin', plugin],
      { cwd: root, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const output = collect(child)
    let socketDir: string | undefined
    cleanups.push(async () => {
      await writeFile(gate, '')
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await new Promise(done => child.once('exit', done))
      }
      if (socketDir) await rm(socketDir, { recursive: true, force: true })
    })
    const lockPath = join(dataDir, 'host.lock')
    const lockOf = () =>
      readFile(lockPath, 'utf8').then(
        text => JSON.parse(text) as { pid: number; role: string },
        () => undefined,
      )
    await waitFor(async () => (await lockOf()) !== undefined, child)
    expect(await lockOf()).toMatchObject({ pid: child.pid, role: 'host' })
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600)
    await waitFor(() => existsSync(join(dataDir, 'audit', 'audit.jsonl')), child)
    expect(await readHostState(dataDir)).toBeUndefined()

    const codeFile = join(root, 'code.txt')
    const offline = await run(TSX, [LATCH, 'device', 'enroll', '--offline', '--code-file', codeFile, '--data-dir', dataDir], {
      cwd: root,
      env: childEnv(),
    }).then(
      () => ({ code: 0, stderr: '' }),
      (error: { code: number; stderr: string }) => error,
    )
    expect(offline.code).toBe(1)
    expect(offline.stderr).toContain(`这个数据目录已有 Host 在运行或正在启动（进程 ${child.pid}）`)
    expect(offline.stderr).toContain(`删除锁文件 ${lockPath} 后重试`)
    expect(existsSync(codeFile)).toBe(false)

    const stop = await run(TSX, [STOP, '--data-dir', dataDir], { cwd: root, env: childEnv() }).then(
      () => ({ code: 0, stderr: '' }),
      (error: { code: number; stderr: string }) => error,
    )
    expect(stop.code).toBe(1)
    expect(stop.stderr).toContain(
      `数据目录锁 ${lockPath} 由进程 ${child.pid} 持有，Host 可能仍在启动，还不能通过 host.sock 确认，未发送停止信号。请稍后再运行 pnpm stop`,
    )
    expect(child.exitCode).toBeNull()

    const audit = await readFile(join(dataDir, 'audit', 'audit.jsonl'), 'utf8')
    const second = await run(TSX, [START, '--data-dir', dataDir, '--workspace', workspace, '--port', '0'], {
      cwd: root,
      env: childEnv(),
    }).then(
      () => ({ code: 0, stderr: '' }),
      (error: { code: number; stderr: string }) => error,
    )
    expect(second.code).toBe(1)
    expect(second.stderr).toContain(`这个数据目录已有 Host 在运行或正在启动（进程 ${child.pid}）`)
    expect(await readFile(join(dataDir, 'audit', 'audit.jsonl'), 'utf8')).toBe(audit)
    expect(await lockOf()).toMatchObject({ pid: child.pid })

    await writeFile(gate, '')
    await waitFor(() => output.stdout.split('\n').length > 4, child)
    const state = (await readHostState(dataDir))!
    socketDir = dirname(state.socketPath)
    const stopped = await run(TSX, [STOP, '--data-dir', dataDir], { cwd: root, env: childEnv() })
    expect(stopped.stdout).toContain('Latch 运行节点已停止。')
    expect(child.exitCode ?? (await new Promise(done => child.once('exit', done)))).toBe(0)
    expect(existsSync(lockPath)).toBe(false)
    expect(await verifyAuditFile(join(dataDir, 'audit', 'audit.jsonl'))).toMatchObject({ ok: true })
  }, 90_000)

  it('refuses every spelling of an all-interfaces or named HTTPS bind address', async () => {
    const { root, dataDir, workspace } = await prepare()
    const material = [
      '--tls-cert',
      join(root, 'cert.pem'),
      '--tls-key',
      join(root, 'key.pem'),
      '--public-origin',
      'https://latch-test.localhost:4318',
    ]
    const attempts: Array<{ flags: string[]; env?: Record<string, string>; message: string }> = [
      ...['0.0.0.0', '::', '[::]', '::0', '0:0:0:0:0:0:0:0', '[0:0::0]', '::ffff:0.0.0.0', '::0.0.0.0', '0', '000.0.0.0'].map(host => ({
        flags: ['--tls-host', host],
        message: '请使用具体网卡地址，不要绑定所有接口',
      })),
      { flags: ['--host', '0.0.0.0'], message: '请使用具体网卡地址，不要绑定所有接口' },
      { flags: [], env: { HARNESS_TLS_HOST: '[::]' }, message: '请使用具体网卡地址，不要绑定所有接口' },
      { flags: ['--tls-host', 'latch-test.localhost'], message: 'HTTPS 监听地址必须是本机网卡的 IP 地址' },
    ]
    for (const attempt of attempts) {
      const failure = await run(
        TSX,
        [START, '--data-dir', dataDir, '--workspace', workspace, '--port', '0', ...material, ...attempt.flags],
        { cwd: root, env: childEnv(attempt.env) },
      ).then(
        () => ({ code: 0, stderr: '' }),
        (error: { code: number; stderr: string }) => error,
      )
      expect({ flags: attempt.flags, code: failure.code, refused: failure.stderr.includes(attempt.message) }).toEqual({
        flags: attempt.flags,
        code: 1,
        refused: true,
      })
    }
    expect(await readHostState(dataDir)).toBeUndefined()
    expect(existsSync(join(dataDir, 'host.lock'))).toBe(false)
  }, 90_000)

  it('refuses to start next to a Host from the previous build, or on a host.json it cannot read', async () => {
    const { root, dataDir, workspace } = await prepare()
    // Startup that gets past the check fails right after it, on this plugin, before startServer runs.
    const plugin = join(root, 'not-a-plugin.mjs')
    await writeFile(plugin, 'export default {}\n')
    const hostJson = join(dataDir, 'host.json')
    const older = (pid: number) =>
      JSON.stringify({ pid, origin: 'http://127.0.0.1:1', instanceId: randomUUID(), startedAt: new Date().toISOString() })
    const start = () =>
      run(TSX, [START, '--data-dir', dataDir, '--workspace', workspace, '--port', '0', '--plugin', plugin], {
        cwd: root,
        env: childEnv(),
      }).then(
        () => ({ code: 0, stderr: '' }),
        (error: { code: number; stderr: string }) => error,
      )

    // The previous build's Host takes no lock; this test process stands in for it.
    await writeFile(hostJson, older(process.pid), { mode: 0o600 })
    const beside = await start()
    expect(beside.code).toBe(1)
    expect(beside.stderr).toContain(`${hostJson} 记录的进程 ${process.pid} 仍在运行，可能是旧版本的 Host。请先在它的终端中停止它（Ctrl+C）`)
    await writeFile(hostJson, '{"pid":', { mode: 0o600 })
    const damaged = await start()
    expect(damaged.code).toBe(1)
    expect(damaged.stderr).toContain(`无法识别 ${hostJson}，不能确认没有其他 Host 在运行。确认没有 Host 在运行后删除该文件再重试。`)
    expect(existsSync(join(dataDir, 'audit'))).toBe(false)
    expect(existsSync(join(dataDir, 'host.lock'))).toBe(false)

    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise(done => exited.once('exit', done))
    await writeFile(hostJson, older(exited.pid!), { mode: 0o600 })
    const stale = await start()
    expect(stale.stderr).toContain('插件模块无效')
  }, 60_000)

  it('explains a lock it will not signal, and ignores one left from before this boot', async () => {
    const { root, dataDir } = await prepare()
    const lockPath = join(dataDir, 'host.lock')
    const boot = await bootTime()
    const stop = () =>
      run(TSX, [STOP, '--data-dir', dataDir], { cwd: root, env: childEnv() }).then(
        result => ({ code: 0, ...result }),
        (error: { code: number; stdout: string; stderr: string }) => error,
      )
    // This test process stands in for a starting Host, or for whatever reused its pid after a reboot.
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, instanceId: randomUUID(), role: 'host', bootTime: boot }), { mode: 0o600 })
    const starting = await stop()
    expect(starting.code).toBe(1)
    expect(starting.stderr).toContain(`数据目录锁 ${lockPath} 由进程 ${process.pid} 持有`)
    expect(starting.stderr).toContain('未发送停止信号。请稍后再运行 pnpm stop；如果确认没有 Host 在运行')
    expect(starting.stderr).toContain('删除该锁文件后再启动')

    await writeFile(lockPath, JSON.stringify({ pid: process.pid, instanceId: randomUUID(), role: 'host', bootTime: boot - 3_600 }), {
      mode: 0o600,
    })
    const rebooted = await stop()
    expect(rebooted.code).toBe(0)
    expect(rebooted.stdout).toContain('没有正在运行的 Host')

    await writeFile(lockPath, '{"pid":', { mode: 0o600 })
    const unreadable = await stop()
    expect(unreadable.code).toBe(1)
    expect(unreadable.stderr).toContain(`数据目录锁 ${lockPath} 无法读取`)
    expect(unreadable.stderr).toContain('删除该文件后重试')
    expect(await readFile(lockPath, 'utf8')).toBe('{"pid":')
  }, 30_000)

  it('binds an IPv4-mapped Tailscale address as IPv4, so the HTTPS entry is classed as Tailscale', async () => {
    const { root, dataDir, workspace } = await prepare()
    const tls = await makeTestTls(join(root, 'tls'))
    const local = new Set(
      Object.values(networkInterfaces())
        .flat()
        .map(entry => entry?.address),
    )
    // An address in 100.64.0.0/10 that this machine does not have, so listen() reports the address it was given.
    const address = ['100.100.100.101', '100.127.254.253', '100.64.254.253'].find(candidate => !local.has(candidate))!
    expect(tlsListenerClass(address)).toBe('tailnet-tls')
    // The Host gets as far as its runtime directory before listen() fails; it is this identity's, so it goes afterwards.
    const { hostId8 } = await loadOrCreateHostIdentity(dataDir)
    cleanups.push(async () => {
      await rm((await prepareRuntimeDir({ hostId8 })).runtimeDir, { recursive: true, force: true })
    })
    const port = await freePort()
    const failure = await run(
      TSX,
      [
        START,
        '--data-dir',
        dataDir,
        '--workspace',
        workspace,
        '--port',
        '0',
        '--tls-cert',
        tls.certPath,
        '--tls-key',
        tls.keyPath,
        '--public-origin',
        `https://${tls.hostname}:${port}`,
        '--tls-host',
        `::ffff:${address}`,
        '--tls-port',
        String(port),
      ],
      { cwd: root, env: childEnv() },
    ).then(
      () => ({ code: 0, stderr: '' }),
      (error: { code: number; stderr: string }) => error,
    )
    expect(failure.code).toBe(1)
    expect(failure.stderr).toContain(`${address}:${port}`)
    expect(failure.stderr).not.toMatch(/::ffff/iu)
    expect(existsSync(join(dataDir, 'host.lock'))).toBe(false)
  }, 60_000)

  it('never signals an unverified host.json, nor a Host with running sessions unless forced', async () => {
    const { root, dataDir } = await prepare()
    await writeFile(
      join(dataDir, 'host.json'),
      JSON.stringify({
        version: 2,
        pid: process.pid,
        hostId: 'a'.repeat(52),
        instanceId: '00000000-0000-4000-8000-000000000000',
        socketPath: join(root, 'missing.sock'),
        loopbackOrigin: 'http://127.0.0.1:1',
        tlsOrigin: null,
        startedAt: new Date().toISOString(),
        dataDir,
      }),
      { mode: 0o600 },
    )
    const unverified = await run(TSX, [STOP, '--data-dir', dataDir], { cwd: root, env: childEnv() }).then(
      () => ({ code: 0, stderr: '' }),
      (error: { code: number; stderr: string }) => error,
    )
    expect(unverified.code).toBe(1)
    expect(unverified.stderr).toContain('未发送停止信号')
    // An older build's record has no socket to check, so a live pid in it is reported, not signalled.
    await writeFile(
      join(dataDir, 'host.json'),
      JSON.stringify({ pid: process.pid, origin: 'http://127.0.0.1:1', instanceId: randomUUID(), startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    )
    const older = await run(TSX, [STOP, '--data-dir', dataDir], { cwd: root, env: childEnv() }).then(
      () => ({ code: 0, stderr: '' }),
      (error: { code: number; stderr: string }) => error,
    )
    expect(older.code).toBe(1)
    expect(older.stderr).toContain('格式无法识别')
    expect(older.stderr).toContain('未发送停止信号')
    expect(older.stderr).toContain(
      `请在运行旧版本 Host 的终端中停止它（Ctrl+C）；如果确认没有 Host 在运行，删除 ${join(dataDir, 'host.json')} 后再启动。`,
    )
    // A damaged record proves nothing either way, so it is reported like the ones above rather than as no Host.
    await writeFile(join(dataDir, 'host.json'), '{"pid":', { mode: 0o600 })
    const damaged = await run(TSX, [STOP, '--data-dir', dataDir], { cwd: root, env: childEnv() }).then(
      result => ({ code: 0, ...result }),
      (error: { code: number; stdout: string; stderr: string }) => error,
    )
    expect(damaged.code).toBe(1)
    expect(damaged.stderr).toContain(
      `无法识别 ${join(dataDir, 'host.json')}，无法确认是否有 Host 在运行，未发送停止信号。如果确认没有 Host 在运行，删除该文件后再启动。`,
    )
    expect(damaged.stdout).not.toContain('没有正在运行的 Host')

    // This Host lives in the test process itself, so stop must refuse before it would signal anything.
    const t = await startTestHost()
    cleanups.push(() => t.close())
    const { sessionId } = await t.host.bridge.createTask({ prompt: '运行 30 秒长任务', requestId: randomUUID() })
    cleanups.push(async () => {
      await t.host.bridge.cancel(sessionId)
    })
    await expect.poll(async () => (await t.host.bridge.detail(sessionId)).summary.status).toBe('running')
    await writeHostState(t.dataDir, {
      version: 2,
      pid: process.pid,
      hostId: t.host.hostId,
      instanceId: t.host.instanceId,
      socketPath: t.host.socketPath,
      loopbackOrigin: t.host.loopbackOrigin,
      tlsOrigin: null,
      startedAt: t.host.startedAt,
      dataDir: t.dataDir,
    })
    const busy = await run(TSX, [STOP, '--data-dir', t.dataDir], { cwd: root, env: childEnv() }).then(
      () => ({ code: 0, stderr: '' }),
      (error: { code: number; stderr: string }) => error,
    )
    expect(busy.code).toBe(1)
    expect(busy.stderr).toContain('有 1 个会话正在运行。确认后使用 pnpm stop --force。')
  }, 30_000)
})
