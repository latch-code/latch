import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultPolicy } from '../src/policy.ts'

const run = promisify(execFile)
const packageApp = process.env.LATCH_PACKAGE_APP
const presenceChildSource = resolve('native/macos/LatchPresenceChild.swift')
const swiftEnvironment = { PATH: '/usr/bin:/bin', TMPDIR: tmpdir() }
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean()
})

describe.runIf(process.platform === 'darwin' && packageApp !== undefined)('application package outside the checkout', () => {
  it('starts and stops its own temporary Host and runs the linked CLI with an untrusted project PATH and Node loader environment', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'latch-package-'))
    cleanup.push(() => rm(temporary, { recursive: true, force: true }))
    const resources = join(temporary, 'Moved Latch.app/Contents/Resources')
    await cp(join(packageApp!, 'Contents/Resources/app'), join(resources, 'app'), { recursive: true })
    await cp(join(packageApp!, 'Contents/Resources/bin'), join(resources, 'bin'), { recursive: true })
    const directory = join(temporary, 'project')
    const data = join(temporary, 'data')
    await mkdir(directory)
    await mkdir(data, { mode: 0o700 })
    await writeFile(
      join(data, 'policy.json'),
      JSON.stringify({ ...defaultPolicy('darwin'), presence: { backend: 'none', helperCdhash: null } }),
      { mode: 0o600 },
    )
    await writeFile(join(directory, 'node'), '#!/bin/sh\nprintf project-node-ran >&2\nexit 71\n', { mode: 0o755 })
    const loader = join(temporary, 'loader.mjs')
    await writeFile(loader, 'throw new Error("loader-injection-ran")\n')
    const command = join(temporary, 'latch')
    await symlink(join(resources, 'bin/latch'), command)
    const env = {
      PATH: `${directory}:/usr/bin:/bin`,
      NODE_OPTIONS: `--import=${loader}`,
      NODE_PATH: directory,
      DYLD_INSERT_LIBRARIES: '/does-not-exist',
      ELECTRON_RUN_AS_NODE: '1',
      LATCH_API_KEY: 'not-a-real-key',
    }
    const cli = (args: string[]) => run(command, args, { cwd: directory, env, timeout: 90_000, maxBuffer: 64 * 1024 })
    expect((await cli(['--help', '--data-dir', data])).stdout).toContain('用法：latch <命令>')
    expect((await cli(['--version', '--data-dir', data])).stdout).toMatch(/^Latch \d+\.\d+\.\d+/u)
    expect((await cli(['--runtime-check'])).stdout).toMatch(/^Node.js /u)
    cleanup.push(() => cli(['stop', '--data-dir', data]))
    const started = await cli(['--internal-desktop-bootstrap', '--data-dir', data, '--workspace', directory, '--port', '0', '--demo'])
    expect(JSON.parse(started.stdout)).toEqual({ hostStatePath: join(data, 'host.json') })
    await expect.poll(() => readFile(join(data, 'host.log'), 'utf8')).toContain('或运行 latch device invite --loopback')
    const status = JSON.parse((await cli(['status', '--json', '--data-dir', data])).stdout)
    expect(status).toMatchObject({ status: 'running', dataDir: data, needsRestart: false })
    const record = JSON.parse(await readFile(join(data, 'desktop-launch.json'), 'utf8'))
    expect(record.launch).toMatchObject({ script: await realpath(join(resources, 'app/dist/start.js')), nodeArgs: [] })
    expect((await run('/bin/ps', ['-p', String(status.pid), '-o', 'command='])).stdout).toContain('--disable-sigusr1')
    expect((await cli(['device', 'list', '--json', '--data-dir', data])).stdout.trim()).toBe('[]')

    await writeFile(join(resources, 'app/dist/web/build.json'), JSON.stringify({ build: '20000101T000000Z-abcdef' }))
    const olderHost = JSON.parse((await cli(['status', '--json', '--data-dir', data])).stdout)
    expect(olderHost).toMatchObject({ status: 'running', pid: status.pid, needsRestart: true })
    for (const args of [
      ['device', 'list'],
      ['customization', 'reset'],
      ['presence', 'status'],
      ['presence', 'test'],
    ])
      await expect(cli([...args, '--data-dir', data])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('运行中的 Host 与此 Latch 应用版本不一致'),
      })
    expect((await cli(['stop', '--data-dir', data])).stdout).toContain('已停止')
  }, 120_000)
})

describe.runIf(process.platform === 'darwin')('native release presence launcher', () => {
  it('builds without an Apple account and refuses an executable outside the fixed release identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-launch-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const generated = join(directory, 'ReleaseTeam.swift')
    await writeFile(generated, 'enum ReleaseTeam { static let id = "ABCDE12345" }\n')
    const launcher = join(directory, 'latch-presence-launch')
    await run(
      '/usr/bin/xcrun',
      [
        'swiftc',
        '-swift-version',
        '6',
        '-parse-as-library',
        '-o',
        launcher,
        resolve('native/macos/LatchPresenceLaunch.swift'),
        presenceChildSource,
        generated,
        '-framework',
        'Security',
      ],
      { env: swiftEnvironment, timeout: 120_000 },
    )
    await cp('/bin/echo', join(directory, 'latch-presence'))
    await expect(run(launcher, [], { env: {}, timeout: 5_000 })).rejects.toMatchObject({
      code: 1,
      stdout: '{"result":"error","error":"helper-identity"}\n',
    })
  }, 120_000)

  it('verifies the suspended child by PID and kills and reaps it before it runs if the identity is wrong', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-presence-child-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const childSource = join(directory, 'Child.swift')
    const child = join(directory, 'child')
    await writeFile(childSource, 'print("fixture child ran")\n')
    await run('/usr/bin/xcrun', ['swiftc', '-o', child, childSource], { env: swiftEnvironment, timeout: 120_000 })
    const identifier = 'dev.latch.presence.child-fixture'
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', identifier, child], { env: {}, timeout: 10_000 })

    const runner = join(directory, 'runner')
    await run(
      '/usr/bin/xcrun',
      [
        'swiftc',
        '-swift-version',
        '6',
        '-parse-as-library',
        '-o',
        runner,
        presenceChildSource,
        resolve('apps/host/test/fixtures/PresenceChildFixture.swift'),
        '-framework',
        'Security',
      ],
      { env: swiftEnvironment, timeout: 120_000 },
    )
    await expect(run(runner, [child, identifier], { env: {}, timeout: 10_000 })).resolves.toMatchObject({
      stdout: 'rejected and reaped\nfixture child ran\naccepted and reaped\n',
      stderr: '',
    })
  }, 120_000)
})
