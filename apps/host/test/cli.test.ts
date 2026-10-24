import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir, uptime } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@latch/protocol'
import { verifyAuditFile } from '../src/audit.ts'
import { HostConfig } from '../src/config.ts'
import { acquireDataDirLock, bootTime, readDataDirLock, writeHostState } from '../src/host-state.ts'
import { defaultPolicy } from '../src/policy.ts'
import { runLatch, type CliIO } from '../scripts/latch.ts'
import { pnpmFromEnvironment } from '../../../scripts/supply-canaries.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const run = promisify(execFile)
const TSX = resolve('node_modules/.bin/tsx')
const TSX_LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href
const LATCH = resolve('apps/host/scripts/latch.ts')

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'lt-cli-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function cli(options: { tty?: boolean; secret?: string; cwd?: string } = {}) {
  const output = { stdout: '', stderr: '' }
  const io: CliIO = {
    stdout: {
      write: (text: string) => {
        output.stdout += text
      },
      isTTY: options.tty ?? false,
    },
    stderr: {
      write: (text: string) => {
        output.stderr += text
      },
    },
    readSecret: async () => options.secret ?? '',
    env: {},
    cwd: options.cwd ?? tmpdir(),
  }
  return { io, output, latch: (...argv: string[]) => runLatch(argv, io) }
}

/** An in-process Host recorded in host.json, as start.ts would write it. */
async function runningHost(options: Parameters<typeof startTestHost>[0] = {}): Promise<TestHost> {
  const t = await startTestHost(options)
  cleanups.push(() => t.close())
  await writeHostState(t.dataDir, {
    version: 2,
    pid: process.pid,
    hostId: t.host.hostId,
    instanceId: t.host.instanceId,
    socketPath: t.host.socketPath,
    loopbackOrigin: t.host.loopbackOrigin,
    tlsOrigin: t.host.tlsOrigin ?? null,
    startedAt: t.host.startedAt,
    dataDir: t.dataDir,
  })
  return t
}

async function auditActions(
  dataDir: string,
): Promise<Array<{ action: string; actor: { listener: string; via?: string }; stepup: string }>> {
  return (await readFile(join(dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
}

/**
 * A data dir with one provider, ready for offline commands. Its policy turns local confirmation off, so no path through
 * `presence test` can ever reach the real helper.
 */
async function stoppedDataDir(): Promise<string> {
  const dataDir = join(await temporaryDirectory(), 'data')
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await writeFile(
    join(dataDir, 'policy.json'),
    JSON.stringify({ ...defaultPolicy(process.platform), presence: { backend: 'none', helperCdhash: null } }),
    { mode: 0o600 },
  )
  const config = await HostConfig.open(dataDir)
  await config.updateProviders(draft => {
    draft.push({
      id: 'lab',
      name: 'Lab',
      kind: 'openai-compatible',
      baseURL: 'https://lab.example/v1',
      apiKey: '',
      enabled: true,
      models: ['m'],
      defaultModel: 'm',
    })
  })
  return dataDir
}

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(child, 'exit')
  return child.pid!
}

/**
 * Processes that each take the data-dir lock when told `go` and give it back when told `release`, so a test can start
 * them all at the same moment.
 */
async function lockContenders(directory: string, dataDir: string, count: number) {
  const script = join(directory, 'contender.mts')
  await writeFile(
    script,
    `import { createInterface } from 'node:readline'
import { acquireDataDirLock } from ${JSON.stringify(pathToFileURL(resolve('apps/host/src/host-state.ts')).href)}
let lock
createInterface({ input: process.stdin }).on('line', async line => {
  if (line === 'go') {
    try { lock = await acquireDataDirLock(${JSON.stringify(dataDir)}, 'cli'); console.log('held ' + lock.instanceId) }
    catch (error) { console.log('refused ' + error.code) }
  } else if (line === 'release') { await lock.release(); console.log('released') }
})
console.log('ready')
`,
  )
  return Promise.all(
    Array.from({ length: count }, async () => {
      const child: ChildProcess = spawn(process.execPath, ['--import', TSX_LOADER, script], {
        cwd: directory,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.stdin!.end()
          await once(child, 'exit')
        }
      })
      let stderr = ''
      child.stderr!.on('data', chunk => {
        stderr += String(chunk)
      })
      const lines: string[] = []
      let waiting: ((line: string) => void) | undefined
      const deliver = (line: string) => {
        if (waiting) {
          const done = waiting
          waiting = undefined
          done(line)
        } else lines.push(line)
      }
      createInterface({ input: child.stdout! }).on('line', deliver)
      child.once('exit', code => deliver(`exited ${code} ${stderr}`))
      const next = () =>
        lines.length > 0
          ? Promise.resolve(lines.shift()!)
          : new Promise<string>(done => {
              waiting = done
            })
      expect(await next()).toBe('ready')
      return { send: (line: string) => child.stdin!.write(`${line}\n`), next }
    }),
  )
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => [])
  const files = entries
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .sort()
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(file, 'utf8')] as const)))
}

describe('latch CLI', () => {
  it('lists and revokes devices over host.sock while the Host runs', async () => {
    const t = await runningHost()
    const phone = await t.enroll({ name: '测试手机' })
    const { output, latch } = cli()
    expect(await latch('device', 'list', '--data-dir', t.dataDir)).toBe(0)
    expect(output.stdout).toMatch(/ID\s+名称\s+连接方式\s+权限\s+状态\s+最近使用/u)
    expect(output.stdout).toContain(phone.id)
    expect(output.stdout).toContain('本机浏览器')
    const json = cli()
    expect(await json.latch('device', 'list', '--json', '--data-dir', t.dataDir)).toBe(0)
    expect((JSON.parse(json.output.stdout) as Device[]).map(device => device.id)).toEqual([phone.id])
    const revoke = cli()
    expect(await revoke.latch('device', 'revoke', phone.id, '--data-dir', t.dataDir)).toBe(0)
    expect(t.host.security.devices.get(phone.id)?.status).toBe('revoked')
    expect((await auditActions(t.dataDir)).find(record => record.action === 'device.revoked')).toMatchObject({
      actor: { listener: 'unix', via: 'cli' },
    })
    const missing = cli()
    expect(await missing.latch('device', 'list', '--data-dir', await temporaryDirectory())).toBe(1)
    expect(missing.output.stderr).toContain('没有可确认的运行中 Host')
  })

  it('prints an invitation only to a terminal or a 0600 file', async () => {
    const t = await runningHost({ tls: true })
    const refused = cli()
    expect(await refused.latch('device', 'invite', '--data-dir', t.dataDir)).toBe(1)
    expect(refused.output.stderr).toContain('--code-file')
    const directory = await temporaryDirectory()
    const file = cli({ cwd: directory })
    expect(await file.latch('device', 'invite', '--scopes', 'view,run', '--code-file', 'invite.txt', '--data-dir', t.dataDir)).toBe(0)
    expect(file.output.stdout).not.toMatch(/lpi1-/)
    expect(await readFile(join(directory, 'invite.txt'), 'utf8')).toMatch(
      new RegExp(`^${t.host.tlsOrigin}/link/#pair=lpi1-[A-Z2-7]{26}\\n$`),
    )
    expect((await stat(join(directory, 'invite.txt'))).mode & 0o777).toBe(0o600)
    const tty = cli({ tty: true })
    expect(await tty.latch('device', 'invite', '--data-dir', t.dataDir)).toBe(0)
    expect(tty.output.stdout).toContain('#pair=lpi1-')
    expect(
      await cli().latch('device', 'invite', '--scopes', 'view,secrets', '--code-file', join(directory, 'x'), '--data-dir', t.dataDir),
    ).toBe(1)
  })

  it('creates an offline enrollment code only while the Host is stopped, and the Host accepts it once', async () => {
    const t = await runningHost({ dataDir: join(await temporaryDirectory(), 'data') })
    const busy = cli({ tty: true })
    expect(await busy.latch('device', 'enroll', '--offline', '--data-dir', t.dataDir)).toBe(1)
    expect(busy.output.stderr).toContain('Host 正在运行，请先停止（pnpm stop）')
    const { dataDir } = t
    await t.close()
    await rm(join(dataDir, 'host.json'), { force: true })
    const directory = await temporaryDirectory()
    const stopped = cli({ cwd: directory })
    expect(await stopped.latch('device', 'enroll', '--offline', '--code-file', 'code.txt', '--port', '4999', '--data-dir', dataDir)).toBe(0)
    expect(stopped.output.stderr).toContain('离线登记依赖本机此刻没有恶意的同用户进程')
    expect(stopped.output.stdout).toContain(`http://h-${t.host.hostId}.localhost:4999/link/`)
    const code = (await readFile(join(directory, 'code.txt'), 'utf8')).trim()
    expect(code).toMatch(/^lpo1-[A-Z2-7]{26}$/)
    expect((await stat(join(directory, 'code.txt'))).mode & 0o777).toBe(0o600)
    expect((await auditActions(dataDir)).at(-1)).toMatchObject({ action: 'offline.ticket.created', actor: { listener: 'cli', via: 'cli' } })

    const again = await startTestHost({ dataDir, presenceMode: 'unavailable' })
    cleanups.push(() => again.close())
    const device = await again.enroll({ offlineCode: code, scopes: ['view', 'run', 'approve:standard', 'admin'] })
    expect(device.device.pairedBy.method).toBe('offline')
    await expect(again.enroll({ offlineCode: code })).rejects.toMatchObject({ status: 403, body: { error: 'offline-code-invalid' } })
  })

  it('sets a provider key offline, bound to the provider origin and audited', async () => {
    const dataDir = join(await temporaryDirectory(), 'data')
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const config = await HostConfig.open(dataDir)
    await config.updateProviders(draft => {
      draft.push({
        id: 'lab',
        name: 'Lab',
        kind: 'openai-compatible',
        baseURL: 'https://lab.example/v1',
        apiKey: '',
        enabled: true,
        models: ['m'],
        defaultModel: 'm',
      })
    })
    const { output, latch } = cli({ secret: 'sk-offline-secret\n' })
    expect(await latch('provider', 'set-key', 'lab', '--data-dir', dataDir)).toBe(0)
    expect(output.stdout).toContain('https://lab.example:443')
    expect(output.stdout + output.stderr).not.toContain('sk-offline-secret')
    expect((await HostConfig.open(dataDir)).provider('lab')).toMatchObject({
      apiKey: 'sk-offline-secret',
      keyOrigin: 'https://lab.example:443',
    })
    expect((await auditActions(dataDir)).at(-1)).toMatchObject({
      action: 'provider.secret.set',
      stepup: 'offline',
      actor: { listener: 'cli' },
    })
    expect(await cli({ secret: 'x' }).latch('provider', 'set-key', 'missing', '--data-dir', dataDir)).toBe(1)
    expect(await cli({ secret: '' }).latch('provider', 'set-key', 'lab', '--data-dir', dataDir)).toBe(1)
  })

  it('refuses every offline command while a starting Host holds the data-dir lock, before host.json exists', async () => {
    const dataDir = await stoppedDataDir()
    const directory = await temporaryDirectory()
    const host = await acquireDataDirLock(dataDir, 'host')
    cleanups.push(() => host.release())
    const before = await snapshot(dataDir)
    const commands = [
      ['device', 'enroll', '--offline', '--code-file', 'code.txt'],
      ['provider', 'set-key', 'lab'],
      ['presence', 'status'],
      ['presence', 'test'],
      ...(process.platform === 'darwin' ? [['presence', 'repin']] : []),
    ]
    for (const command of commands) {
      const { output, latch } = cli({ cwd: directory, secret: 'sk-during-startup\n' })
      expect(await latch(...command, '--data-dir', dataDir)).toBe(1)
      expect(output.stderr).toContain('这个数据目录已有 Host 在运行或正在启动')
      expect(output.stderr).toContain(
        `请先停止它（pnpm stop），或使用其他 --data-dir；如果确认没有 Host 在运行，删除锁文件 ${join(dataDir, 'host.lock')} 后重试。`,
      )
    }
    expect(await snapshot(dataDir)).toEqual(before)
    await expect(lstat(join(directory, 'code.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

    await host.release()
    expect(await cli({ cwd: directory }).latch('device', 'enroll', '--offline', '--code-file', 'code.txt', '--data-dir', dataDir)).toBe(0)
    await expect(lstat(join(dataDir, 'host.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('takes over a lock whose process is gone, and never one it cannot read or that a live command holds', async () => {
    const dataDir = await stoppedDataDir()
    const directory = await temporaryDirectory()
    const lockPath = join(dataDir, 'host.lock')
    await writeFile(lockPath, JSON.stringify({ pid: await deadPid(), instanceId: randomUUID(), role: 'host' }), { mode: 0o600 })
    expect(await cli({ cwd: directory }).latch('device', 'enroll', '--offline', '--code-file', 'one.txt', '--data-dir', dataDir)).toBe(0)
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(lockPath, JSON.stringify({ pid: process.pid, instanceId: randomUUID(), role: 'cli' }), { mode: 0o600 })
    const busy = cli({ cwd: directory })
    expect(await busy.latch('device', 'enroll', '--offline', '--code-file', 'two.txt', '--data-dir', dataDir)).toBe(1)
    expect(busy.output.stderr).toContain('另一个 latch 命令正在使用这个数据目录')
    expect(busy.output.stderr).toContain(`删除锁文件 ${lockPath} 后重试`)
    await rm(lockPath)

    for (const plant of [() => writeFile(lockPath, '{"pid":', { mode: 0o600 }), () => symlink(join(directory, 'elsewhere'), lockPath)]) {
      await plant()
      const invalid = cli({ cwd: directory, secret: 'sk-x\n' })
      expect(await invalid.latch('provider', 'set-key', 'lab', '--data-dir', dataDir)).toBe(1)
      expect(invalid.output.stderr).toContain(
        `数据目录锁 ${lockPath} 无法读取。请先停止 Host（pnpm stop）；如果确认没有 Host 或 latch 命令在使用这个目录，删除该文件后重试。`,
      )
      expect((await lstat(lockPath)).isFile() || (await lstat(lockPath)).isSymbolicLink()).toBe(true)
      await rm(lockPath)
    }
    await expect(lstat(join(directory, 'elsewhere'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await HostConfig.open(dataDir)).provider('lab')?.apiKey).toBe('')

    const held = await acquireDataDirLock(dataDir, 'host')
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual({
      pid: process.pid,
      instanceId: held.instanceId,
      role: 'host',
      bootTime: await bootTime(),
    })
    await expect(acquireDataDirLock(dataDir, 'host')).rejects.toMatchObject({
      status: 409,
      code: 'data-dir-locked',
      details: { role: 'host' },
    })
    await held.release()
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reads the boot time from the kernel', async () => {
    const boot = await bootTime()
    if (process.platform === 'darwin') {
      const { stdout } = await run('/usr/sbin/sysctl', ['-n', 'kern.boottime'])
      expect(boot).toBe(Number(/\bsec = (\d+)/u.exec(stdout)![1]))
    } else if (process.platform === 'linux') {
      expect(boot).toBe(Number(/^btime (\d+)$/mu.exec(await readFile('/proc/stat', 'utf8'))![1]))
    }
    expect(Math.abs(boot - (Date.now() / 1000 - uptime()))).toBeLessThan(5)
  })

  it('takes over a lock written before this boot even when its pid is alive again, and holds one from this boot', async () => {
    const dataDir = await stoppedDataDir()
    const directory = await temporaryDirectory()
    const lockPath = join(dataDir, 'host.lock')
    const boot = await bootTime()
    // This test process stands in for whatever process reused the recorded pid.
    const plant = (record: Record<string, unknown>) =>
      writeFile(lockPath, JSON.stringify({ pid: process.pid, instanceId: randomUUID(), role: 'host', ...record }), { mode: 0o600 })

    await plant({ bootTime: boot - 3_600 })
    expect(
      await cli({ cwd: directory }).latch('device', 'enroll', '--offline', '--code-file', 'after-reboot.txt', '--data-dir', dataDir),
    ).toBe(0)
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

    for (const record of [{ bootTime: boot }, { bootTime: boot - 2 }, {}]) {
      await plant(record)
      const held = cli({ cwd: directory })
      expect(await held.latch('device', 'enroll', '--offline', '--code-file', 'held.txt', '--data-dir', dataDir)).toBe(1)
      expect(held.output.stderr).toContain(`这个数据目录已有 Host 在运行或正在启动（进程 ${process.pid}）`)
      expect(held.output.stderr).toContain(`删除锁文件 ${lockPath} 后重试`)
      expect((await lstat(lockPath)).isFile()).toBe(true)
      await rm(lockPath)
    }
    await expect(lstat(join(directory, 'held.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lets exactly one of several processes take over a stale lock at the same moment', async () => {
    const directory = await temporaryDirectory()
    const dataDir = join(directory, 'data')
    await mkdir(dataDir, { mode: 0o700 })
    const lockPath = join(dataDir, 'host.lock')
    const contenders = await lockContenders(directory, dataDir, 8)
    const boot = await bootTime()
    const gone = await deadPid()
    // A process that has exited, and a live pid (this test process) recorded before the last reboot.
    const stale = [{ pid: gone }, { pid: process.pid, bootTime: boot - 3_600 }]
    for (let trial = 0; trial < 6; trial++) {
      await writeFile(lockPath, JSON.stringify({ instanceId: randomUUID(), role: 'host', ...stale[trial % 2] }), { mode: 0o600 })
      for (const contender of contenders) contender.send('go')
      const outcomes = await Promise.all(contenders.map(contender => contender.next()))
      const holders = outcomes.flatMap((outcome, index) => (outcome.startsWith('held ') ? [{ index, instanceId: outcome.slice(5) }] : []))
      expect({ trial, holders: holders.length, refused: outcomes.filter(outcome => outcome === 'refused data-dir-locked').length }).toEqual(
        { trial, holders: 1, refused: 7 },
      )
      expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ instanceId: holders[0]!.instanceId, role: 'cli' })
      contenders[holders[0]!.index]!.send('release')
      expect(await contenders[holders[0]!.index]!.next()).toBe('released')
      expect(await readdir(dataDir)).toEqual([])
    }
  }, 60_000)

  it('clears a takeover left by a process that died or hung, and waits for one in progress', async () => {
    const dataDir = join(await temporaryDirectory(), 'data')
    await mkdir(dataDir, { mode: 0o700 })
    const lockPath = join(dataDir, 'host.lock')
    const guard = join(dataDir, '.host-lock-takeover')
    const plantStale = () =>
      writeFile(lockPath, JSON.stringify({ pid: process.pid, instanceId: randomUUID(), role: 'host', bootTime: 1 }), { mode: 0o600 })
    const plantGuard = async (pid: number) => {
      await mkdir(guard, { mode: 0o700 })
      const marker = join(guard, randomUUID())
      await writeFile(marker, JSON.stringify({ pid }), { mode: 0o600 })
      return marker
    }

    // A takeover in progress (its process is alive and it is recent) is waited for, and the stale lock stays.
    await plantStale()
    const marker = await plantGuard(process.pid)
    const before = await readFile(lockPath, 'utf8')
    await expect(acquireDataDirLock(dataDir, 'cli')).rejects.toMatchObject({
      status: 409,
      code: 'data-dir-locked',
      message: expect.stringContaining(`无法取得数据目录锁 ${lockPath}，请稍后重试`),
    })
    expect(await readFile(lockPath, 'utf8')).toBe(before)
    expect(await readdir(guard)).toHaveLength(1)

    // The same marker once it is older than any takeover takes, as when the pid was reused.
    const old = new Date(Date.now() - 31_000)
    await utimes(marker, old, old)
    const afterHang = await acquireDataDirLock(dataDir, 'cli')
    await afterHang.release()
    expect(await readdir(dataDir)).toEqual([])

    // A takeover whose process has exited, and one that stopped after emptying its directory.
    for (const leftover of [
      async () => {
        await plantGuard(await deadPid())
      },
      () => mkdir(guard, { mode: 0o700 }),
    ]) {
      await plantStale()
      await leftover()
      const lock = await acquireDataDirLock(dataDir, 'cli')
      expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ instanceId: lock.instanceId, role: 'cli' })
      await lock.release()
      expect(await readdir(dataDir)).toEqual([])
    }

    // What a process killed part-way leaves next to the lock is removed by the next holder once it is old enough, even
    // when no takeover follows.
    const left = (suffix: string) => `.host-lock-${randomUUID()}.${suffix}`
    const [created, claimed, movedAside, recent] = [left('new'), left('claim'), left('stale'), left('new')]
    await writeFile(join(dataDir, created), '{}', { mode: 0o600 })
    await mkdir(join(dataDir, claimed, randomUUID()), { recursive: true, mode: 0o700 })
    await writeFile(join(dataDir, movedAside), '{}', { mode: 0o600 })
    await writeFile(join(dataDir, recent), '{}', { mode: 0o600 })
    for (const name of [created, claimed, movedAside]) await utimes(join(dataDir, name), old, old)
    await plantGuard(await deadPid())
    const sweeping = await acquireDataDirLock(dataDir, 'cli')
    await sweeping.release()
    expect(await readdir(dataDir)).toEqual([recent])
  })

  it('counts a host.json it cannot read as a running Host unless the pid it records is gone', async () => {
    const dataDir = await stoppedDataDir()
    const directory = await temporaryDirectory()
    const older = (pid: number) =>
      JSON.stringify({ pid, origin: 'http://127.0.0.1:1', instanceId: randomUUID(), startedAt: new Date().toISOString() })
    await writeFile(join(dataDir, 'host.json'), older(process.pid), { mode: 0o600 })
    const running = cli({ cwd: directory })
    expect(await running.latch('device', 'enroll', '--offline', '--code-file', 'a.txt', '--data-dir', dataDir)).toBe(1)
    expect(running.output.stderr).toContain('Host 正在运行，请先停止（pnpm stop）')
    await writeFile(join(dataDir, 'host.json'), '{"version":', { mode: 0o600 })
    const damaged = cli({ cwd: directory, secret: 'sk-x\n' })
    expect(await damaged.latch('provider', 'set-key', 'lab', '--data-dir', dataDir)).toBe(1)
    expect(damaged.output.stderr).toContain('不能确认 Host 已停止')
    expect(await snapshot(join(dataDir, 'audit'))).toEqual({})
    await writeFile(join(dataDir, 'host.json'), older(await deadPid()), { mode: 0o600 })
    expect(await cli({ cwd: directory }).latch('device', 'enroll', '--offline', '--code-file', 'b.txt', '--data-dir', dataDir)).toBe(0)
  })

  it('keeps the data dir locked while a key is typed, and saves nothing if a Host without the lock started meanwhile', async () => {
    const dataDir = await stoppedDataDir()
    const output = { stdout: '', stderr: '' }
    let lockDuringPrompt: unknown
    let host: TestHost | undefined
    const io: CliIO = {
      stdout: {
        write: (text: string) => {
          output.stdout += text
        },
      },
      stderr: {
        write: (text: string) => {
          output.stderr += text
        },
      },
      env: {},
      cwd: dataDir,
      async readSecret() {
        lockDuringPrompt = await acquireDataDirLock(dataDir, 'host').then(
          async lock => {
            await lock.release()
            return 'acquired'
          },
          (error: unknown) => error,
        )
        // An in-process Host takes no lock, like a Host from an older build.
        host = await runningHost({ dataDir })
        return 'sk-typed-while-starting\n'
      },
    }
    expect(await runLatch(['provider', 'set-key', 'lab', '--data-dir', dataDir], io)).toBe(1)
    expect(lockDuringPrompt).toMatchObject({ code: 'data-dir-locked', details: { role: 'cli' } })
    expect(output.stderr).toContain('Host 正在运行，请先停止（pnpm stop）')
    expect(output.stdout + output.stderr).not.toContain('sk-typed-while-starting')
    expect((await HostConfig.open(dataDir)).provider('lab')?.apiKey).toBe('')
    expect((await auditActions(dataDir)).map(record => record.action)).not.toContain('provider.secret.set')
    await host!.enroll()
    expect(await verifyAuditFile(join(dataDir, 'audit', 'audit.jsonl'))).toMatchObject({ ok: true })
  })

  it('starts pnpm latch deaf to SIGUSR1, so no debugger opens in the process holding a key that is being typed', async () => {
    const pnpm = pnpmFromEnvironment()
    if (!pnpm) throw new Error('run this test through pnpm (pnpm test) so npm_execpath names the pinned pnpm')
    const dataDir = await stoppedDataDir()
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HARNESS_')))
    const child = spawn(pnpm.file, [...pnpm.args, '--silent', 'latch', 'provider', 'set-key', 'lab', '--data-dir', dataDir], {
      cwd: resolve(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = once(child, 'exit')
    cleanups.push(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.stdin.end()
      await exited
    })
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.stdout.resume()
    child.stdin.write('sk-typed-')
    // The command holds the data-dir lock while it reads the key; the lock names the process, below pnpm and its shell.
    const holder = await vi.waitFor(
      async () => {
        const lock = await readDataDirLock(dataDir)
        expect(lock).toMatchObject({ held: true, holder: { role: 'cli' } })
        return lock!.holder!
      },
      { timeout: 20_000, interval: 50 },
    )
    // SIGUSR1 is what process._debugProcess sends: without --disable-sigusr1 it opens an inspector in that process.
    process.kill(holder.pid, 'SIGUSR1')
    await delay(300)
    child.stdin.end('slowly\n')
    expect(await exited).toEqual([0, null])
    expect(stderr).not.toMatch(/debugger|inspector/iu)
    expect((await HostConfig.open(dataDir)).provider('lab')?.apiKey).toBe('sk-typed-slowly')
  }, 30_000)

  it('runs presence test against a running Host without writing its audit log or policy', async () => {
    const t = await runningHost()
    const policyPath = join(t.dataDir, 'policy.json')
    // An edit made outside Latch: a second policy store on this data dir would audit it and fork the Host's chain.
    const policy = JSON.parse(await readFile(policyPath, 'utf8'))
    await writeFile(policyPath, JSON.stringify({ ...policy, presence: { ...policy.presence, backend: 'none' } }, null, 2), { mode: 0o600 })
    const files = () => Promise.all([readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'), readFile(policyPath, 'utf8')])
    const before = await files()
    const { output, latch } = cli()
    expect(await latch('presence', 'test', '--data-dir', t.dataDir)).toBe(1)
    expect(output.stderr).toContain('本机确认不可用')
    expect(await files()).toEqual(before)
    await t.enroll()
    expect(await verifyAuditFile(join(t.dataDir, 'audit', 'audit.jsonl'))).toMatchObject({ ok: true })
  })

  it('writes a code only to a file it creates: never through a symlink, over an existing file or in a shared directory', async () => {
    const directory = await temporaryDirectory()
    const victim = join(directory, 'victim-rc')
    await writeFile(victim, 'export PATH=/usr/bin\n', { mode: 0o644 })
    await symlink(victim, join(directory, 'linked.txt'))
    await symlink(join(directory, 'created-elsewhere'), join(directory, 'dangling.txt'))
    await writeFile(join(directory, 'existing.txt'), 'keep\n', { mode: 0o600 })
    const dataDir = await stoppedDataDir()
    for (const name of ['linked.txt', 'dangling.txt', 'existing.txt']) {
      const { output, latch } = cli({ cwd: directory })
      expect(await latch('device', 'enroll', '--offline', '--code-file', name, '--data-dir', dataDir)).toBe(1)
      expect(output.stderr).toContain('已存在')
      expect(output.stdout + output.stderr).not.toMatch(/lpo1-/u)
    }
    expect(await readFile(victim, 'utf8')).toBe('export PATH=/usr/bin\n')
    expect((await stat(victim)).mode & 0o777).toBe(0o644)
    await expect(lstat(join(directory, 'created-elsewhere'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(directory, 'existing.txt'), 'utf8')).toBe('keep\n')
    // A refused path mints no code.
    await expect(lstat(join(dataDir, 'auth', 'offline-enrollments.json'))).rejects.toMatchObject({ code: 'ENOENT' })

    const shared = join(directory, 'shared')
    await mkdir(shared)
    await chmod(shared, 0o777)
    const open = cli({ cwd: directory })
    expect(await open.latch('device', 'enroll', '--offline', '--code-file', join(shared, 'code.txt'), '--data-dir', dataDir)).toBe(1)
    expect(open.output.stderr).toContain('其他用户也能写入')
    await expect(lstat(join(shared, 'code.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

    const missing = cli({ cwd: directory })
    expect(
      await missing.latch('device', 'enroll', '--offline', '--code-file', join(directory, 'absent', 'code.txt'), '--data-dir', dataDir),
    ).toBe(1)
    expect(missing.output.stderr).toContain('无法访问目录')
    await expect(lstat(join(dataDir, 'auth', 'offline-enrollments.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.runIf(typeof process.getuid === 'function' && process.getuid() !== 0)(
    'writes a code file only into a directory this user owns, or a sticky one root owns',
    async () => {
      const dataDir = await stoppedDataDir()
      // The root directory belongs to root and has no sticky bit: another owner could swap the file.
      const foreign = cli()
      expect(
        await foreign.latch('device', 'enroll', '--offline', '--code-file', `/lt-cli-${randomUUID()}.txt`, '--data-dir', dataDir),
      ).toBe(1)
      expect(foreign.output.stderr).toContain('/ 不属于当前用户')
      await expect(lstat(join(dataDir, 'auth', 'offline-enrollments.json'))).rejects.toMatchObject({ code: 'ENOENT' })

      const shared = await realpath('/tmp').catch(() => undefined)
      const info = shared ? await stat(shared) : undefined
      const listing = shared && process.platform === 'darwin' ? (await run('/bin/ls', ['-led', shared])).stdout.trim().split('\n') : []
      if (!shared || info?.uid !== 0 || (info.mode & 0o1000) === 0 || listing.length > 1) return
      const file = join(shared, `lt-cli-${randomUUID()}.txt`)
      cleanups.push(() => rm(file, { force: true }))
      expect(await cli().latch('device', 'enroll', '--offline', '--code-file', file, '--data-dir', dataDir)).toBe(0)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect(await readFile(file, 'utf8')).toMatch(/^lpo1-[A-Z2-7]{26}\n$/u)
    },
  )

  it.runIf(process.platform === 'darwin')('refuses a code-file directory with access-control entries, whatever they grant', async () => {
    const directory = await temporaryDirectory()
    const dataDir = await stoppedDataDir()
    // Entries that let others swap the file, that a new file would inherit, and a deny entry like the one on home folders.
    for (const [name, entry] of [
      ['writable', 'everyone allow add_file,delete_child'],
      ['inherited', 'everyone allow read,file_inherit'],
      ['denying', 'everyone deny delete'],
    ] as const) {
      const target = join(directory, name)
      await mkdir(target, { mode: 0o700 })
      await run('/bin/chmod', ['+a', entry, target])
      cleanups.push(async () => {
        await run('/bin/chmod', ['-N', target]).catch(() => {})
      })
      const { output, latch } = cli({ cwd: directory })
      expect(await latch('device', 'enroll', '--offline', '--code-file', join(target, 'code.txt'), '--data-dir', dataDir)).toBe(1)
      expect(output.stderr).toContain(`${target} 带有访问控制列表（ACL）`)
      await expect(lstat(join(target, 'code.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await expect(lstat(join(dataDir, 'auth', 'offline-enrollments.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('verifies the audit chain and reports a tampered line', async () => {
    const t = await startTestHost()
    const dataDir = t.dataDir
    await t.enroll()
    const copy = join(await temporaryDirectory(), 'data')
    await mkdir(join(copy, 'audit'), { recursive: true, mode: 0o700 })
    const text = await readFile(join(dataDir, 'audit', 'audit.jsonl'), 'utf8')
    await t.close()
    await writeFile(join(copy, 'audit', 'audit.jsonl'), text, { mode: 0o600 })
    const ok = cli()
    expect(await ok.latch('audit', 'verify', '--data-dir', copy)).toBe(0)
    expect(ok.output.stdout).toMatch(/审计记录完整：共 \d+ 条/u)
    const lines = text.trim().split('\n')
    lines[1] = JSON.stringify({ ...JSON.parse(lines[1]!), at: '2000-01-01T00:00:00.000Z' })
    await writeFile(join(copy, 'audit', 'audit.jsonl'), lines.join('\n') + '\n', { mode: 0o600 })
    const broken = cli()
    expect(await broken.latch('audit', 'verify', '--data-dir', copy)).toBe(1)
    expect(broken.output.stderr).toContain('第 2 行')
  })

  it('runs as a script with the documented usage and exit codes', async () => {
    const directory = await temporaryDirectory()
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HARNESS_')))
    const usage = await run(TSX, [LATCH], { cwd: directory, env }).catch((error: { code: number; stdout: string }) => error)
    expect(usage).toMatchObject({ code: 1 })
    expect((usage as { stdout: string }).stdout).toContain('用法：pnpm latch')
    const missing = await run(TSX, [LATCH, 'audit', 'verify', '--data-dir', join(directory, 'data')], { cwd: directory, env }).catch(
      (error: { code: number; stderr: string }) => error,
    )
    expect(missing).toMatchObject({ code: 1, stderr: expect.stringContaining('找不到审计记录') })
    const t = await startTestHost()
    cleanups.push(() => t.close())
    const verified = await run(TSX, [LATCH, 'audit', 'verify', '--data-dir', t.dataDir], { cwd: directory, env })
    expect(verified.stdout).toMatch(/审计记录完整：共 \d+ 条/u)
  })
})
