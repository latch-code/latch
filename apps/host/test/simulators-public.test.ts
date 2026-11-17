// The 设备 panel's public commands beyond the picture: rotation through devicectl, recording, apps and permissions,
// new devices, the logs pane, and shutting down the devices Latch booted when idle or as the Host stops. Stand-in
// runners only; nothing here runs the real simctl or devicectl.
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ModelMessage, ToolDefinition } from '@latch/sdk'
import type { TestDevice } from '@latch/testkit'
import {
  Simulators,
  parseOldPlist,
  removeStaleSimulatorTemp,
  type SimctlChild,
  type SimctlResult,
  type SimctlRunner,
  type SimctlSpawner,
  type SimulatorOptions,
} from '../src/simulators.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const OURS = '11111111-1111-4111-8111-111111111111'
const THEIRS = '22222222-2222-4222-8222-222222222222'
const CREATED = '33333333-3333-4333-8333-333333333333'
const MOVIE = Buffer.from('....ftypmp42 a recording')
const TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro'
const IPAD = 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11'
const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-27-2'
const ok = (stdout = ''): SimctlResult => ({ code: 0, stdout: Buffer.from(stdout), stderr: '' })

/** `simctl listapps` as Xcode 27.2 prints it: an old-style property list. */
const APPS = `{
    "com.apple.mobilesafari" =     {
        ApplicationType = System;
        CFBundleDisplayName = Safari;
        CFBundleExecutable = MobileSafari;
        CFBundleIdentifier = "com.apple.mobilesafari";
        GroupContainers =         {
            "group.com.apple.safari" = "file:///x/";
        };
        IsHidden = 0;
        SBAppTags =         (
            "a", b
        );
    };
    "com.example.latch-demo" =     {
        ApplicationType = User;
        CFBundleDisplayName = "Latch \\"Demo\\"";
        CFBundleExecutable = "Latch Demo";
        IsHidden = 0;
    };
    "com.apple.webapp" =     {
        ApplicationType = System;
        CFBundleName = Web;
        CFBundleExecutable = Web;
        IsHidden = 1;
    };
    "com.apple.weird" =     {
        ApplicationType = System;
        CFBundleName = Weird;
        CFBundleExecutable = "a\\"; rm -rf /";
    };
}`

interface FakeChild {
  args: string[]
  interrupted: boolean
  killed: boolean
  out: (text: string) => void
  exit: (code: number) => void
}

/** simctl, devicectl and long children as far as Latch uses them. */
function fakes(
  options: {
    rotates?: boolean
    orientation?: boolean
    stuck?: boolean
    recordStarts?: boolean
    marks?: boolean
    holdApps?: Promise<void>
  } = {},
) {
  const states = new Map([
    [OURS, 'Shutdown'],
    [THEIRS, 'Booted'],
  ])
  const calls: string[][] = []
  const ctl: string[][] = []
  const children: FakeChild[] = []
  /** `lastUsedAt`: new on each boot; `marks: false` lists none, as an Xcode without the field would. */
  const marks = new Map<string, string>()
  let boots = 0
  const spawnOptions: Array<{ limitSeconds?: number }> = []
  let orientation = 'portrait'
  const run: SimctlRunner = async args => {
    calls.push([...args])
    const [command, udid] = args
    if (command === 'list' && args[1] === 'devices') {
      const devices = [...states].map(([id, state]) => ({
        udid: id,
        name: id === THEIRS ? 'iPhone 18 Pro' : 'latch-test',
        state,
        isAvailable: true,
        ...(options.marks !== false && marks.has(id) ? { lastUsedAt: marks.get(id) } : {}),
      }))
      return ok(JSON.stringify({ devices: { [RUNTIME]: devices } }))
    }
    if (command === 'list' && args[1] === 'devicetypes')
      return ok(
        JSON.stringify({
          devicetypes: [
            { identifier: TYPE, name: 'iPhone 18 Pro', productFamily: 'iPhone' },
            { identifier: IPAD, name: 'iPad Pro 11', productFamily: 'iPad' },
            { identifier: '--help', name: 'bad' },
          ],
        }),
      )
    if (command === 'list' && args[1] === 'runtimes')
      return ok(
        JSON.stringify({
          runtimes: [
            { identifier: RUNTIME, name: 'iOS 27.2', isAvailable: true, supportedDeviceTypes: [{ identifier: TYPE }] },
            { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0', name: 'iOS 26.0', isAvailable: false, supportedDeviceTypes: [] },
          ],
        }),
      )
    if (command === 'boot') {
      states.set(udid!, 'Booted')
      marks.set(udid!, `2026-11-17T02:00:${String(++boots).padStart(2, '0')}Z`)
    } else if (command === 'shutdown') states.set(udid!, 'Shutdown')
    else if (command === 'listapps') {
      await options.holdApps
      return ok(APPS)
    } else if (command === 'io') await writeFile(args.at(-1)!, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]))
    else if (command === 'create') {
      states.set(CREATED, 'Shutdown')
      return ok(`${CREATED}\n`)
    }
    return ok()
  }
  const devicectl: SimctlRunner = async args => {
    ctl.push([...args])
    if (options.orientation === false)
      return {
        code: 1,
        stdout: Buffer.from('{"error":{"code":1001}}'),
        stderr: 'ERROR: The capability “Device Orientation” is not supported by this device.',
      }
    if (args[2] === 'rotate' && options.rotates !== false)
      orientation = { portrait: args[5] === 'left' ? 'landscapeLeft' : 'landscapeRight' }[orientation] ?? 'portrait'
    return ok(
      JSON.stringify({ result: { deviceIdentifier: args[4], deviceOrientation: 'unknown', deviceOrientationNonFlat: orientation } }),
    )
  }
  const spawn: SimctlSpawner = (args, spawned) => {
    spawnOptions.push(spawned ?? {})
    let exit!: (code: number) => void
    const exited = new Promise<number>(resolve => (exit = resolve))
    const stdout: Array<(chunk: Buffer) => void> = []
    const stderr: Array<(chunk: Buffer) => void> = []
    const child: FakeChild = {
      args: [...args],
      interrupted: false,
      killed: false,
      out: text => stdout.forEach(listener => listener(Buffer.from(text))),
      exit: code => exit(code),
    }
    children.push(child)
    if (args[1] && args.includes('recordVideo') && options.recordStarts !== false)
      setTimeout(() => stderr.forEach(listener => listener(Buffer.from('Note: No display specified.\nRecording started\n'))), 5)
    const handle: SimctlChild = {
      onStdout: listener => void stdout.push(listener),
      onStderr: listener => void stderr.push(listener),
      interrupt: () => {
        child.interrupted = true
        if (options.stuck) return
        if (args.includes('recordVideo')) void writeFile(args.at(-1)!, MOVIE).then(() => exit(0))
        else exit(0)
      },
      kill: () => {
        child.killed = true
        exit(-1)
      },
      exited,
    }
    return handle
  }
  return { run, devicectl, spawn, calls, ctl, children, states, marks, spawnOptions }
}

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

function simulators(fake = fakes(), extra: SimulatorOptions = {}) {
  const value = new Simulators({ run: fake.run, devicectl: fake.devicectl, spawn: fake.spawn, idleMs: 0, ...extra })
  cleanups.push(() => value.stop())
  return value
}

describe('rotation', () => {
  it('runs devicectl with fixed arguments and answers the orientation it read back', async () => {
    const fake = fakes()
    const sim = simulators(fake)
    expect(await sim.orientation(THEIRS)).toEqual({ supported: true, orientation: 'portrait' })
    expect(await sim.rotate(THEIRS, 'left')).toBe('landscapeLeft')
    expect(fake.ctl.at(-1)).toEqual(['device', 'orientation', 'rotate', '--device', THEIRS, 'left', '-t', '20', '-j', '-'])
    for (const bad of ['up', '--help', undefined]) await expect(sim.rotate(THEIRS, bad)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(sim.rotate('booted', 'left')).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(sim.rotate(OURS, 'left')).rejects.toMatchObject({ code: 'simulator-not-booted' })
    expect(fake.ctl.every(args => args.includes(THEIRS))).toBe(true)
  })

  it('never reports a turn that did not happen, and refuses a device devicectl cannot turn', async () => {
    await expect(simulators(fakes({ rotates: false })).rotate(THEIRS, 'right')).rejects.toMatchObject({ code: 'simulator-rotate-failed' })
    const unsupported = simulators(fakes({ orientation: false }))
    expect(await unsupported.orientation(THEIRS)).toEqual({ supported: false, orientation: null })
    await expect(unsupported.rotate(THEIRS, 'right')).rejects.toMatchObject({ code: 'simulator-rotate-unsupported' })
    const fake = fakes()
    const none = new Simulators({ run: fake.run, idleMs: 0 })
    expect(await none.orientation(THEIRS)).toEqual({ supported: false, orientation: null })
    await expect(none.rotate(THEIRS, 'left')).rejects.toMatchObject({ code: 'simulator-rotate-unsupported' })
  })
})

describe('apps and permissions', () => {
  it('reads the old-style list, leaves hidden apps out, and puts the person’s own first', async () => {
    expect(parseOldPlist('{ a = "b\\"c"; d = ( 1, "2", ); e = { }; }')).toEqual({ a: 'b"c', d: ['1', '2'], e: {} })
    for (const bad of ['{ a = b }', '{ a = "b', '(', '{ a = b; } x']) expect(() => parseOldPlist(bad)).toThrow()
    const sim = simulators()
    expect(await sim.appList(THEIRS)).toEqual([
      { bundleId: 'com.example.latch-demo', name: 'Latch "Demo"', kind: 'user' },
      { bundleId: 'com.apple.mobilesafari', name: 'Safari', kind: 'system' },
      { bundleId: 'com.apple.weird', name: 'Weird', kind: 'system' },
    ])
  })

  it('launches, ends and changes permissions only for a listed app, by its bundle id alone', async () => {
    const fake = fakes()
    const sim = simulators(fake)
    for (const bad of ['-x', 'safari', '../x.y', 'com.apple.mobilesafari --console', 42])
      await expect(sim.launch(THEIRS, bad)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(sim.launch(THEIRS, 'com.example.missing')).rejects.toMatchObject({ code: 'simulator-app-not-found' })
    await sim.launch(THEIRS, 'com.apple.mobilesafari')
    await sim.terminate(THEIRS, 'com.apple.mobilesafari')
    await sim.privacy(THEIRS, 'grant', 'photos', 'com.example.latch-demo')
    for (const [action, service] of [
      ['grant', 'all'],
      ['erase', 'photos'],
      ['grant', '--help'],
    ] as const)
      await expect(sim.privacy(THEIRS, action, service, 'com.apple.mobilesafari')).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(sim.privacy(THEIRS, 'grant', 'photos', 'com.example.missing')).rejects.toMatchObject({ code: 'simulator-app-not-found' })
    expect(fake.calls.filter(args => ['launch', 'terminate', 'privacy'].includes(args[0]!))).toEqual([
      ['launch', THEIRS, 'com.apple.mobilesafari'],
      ['terminate', THEIRS, 'com.apple.mobilesafari'],
      ['privacy', THEIRS, 'grant', 'photos', 'com.example.latch-demo'],
    ])
  })
})

describe('new devices', () => {
  it('takes a plain name and a listed type and runtime, and never an option', async () => {
    const fake = fakes()
    const sim = simulators(fake)
    expect((await sim.catalog()).runtimes).toEqual([{ id: RUNTIME, name: 'iOS 27.2', deviceTypes: [TYPE] }])
    for (const bad of ['', '-rf', '--set x', 'a"b', 'a\nb', 'x'.repeat(65), ' ', 'a;b', 42])
      await expect(sim.create(bad, TYPE, RUNTIME)).rejects.toMatchObject({ code: 'invalid-name' })
    await expect(sim.create('latch-new', IPAD, RUNTIME)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(sim.create('latch-new', TYPE, 'com.apple.CoreSimulator.SimRuntime.iOS-26-0')).rejects.toMatchObject({
      code: 'invalid-input',
    })
    expect(await sim.create('  latch-new (试) ', TYPE, RUNTIME)).toBe(CREATED)
    expect(fake.calls.filter(args => args[0] === 'create')).toEqual([['create', 'latch-new (试)', TYPE, RUNTIME]])
  })
})

describe('recording', () => {
  it('records to a private file ended with SIGINT, hands it over once, and leaves nothing behind', async () => {
    const fake = fakes()
    const sim = simulators(fake)
    await sim.picture(THEIRS, 'jpeg', { frame: true })
    expect(await sim.startRecording(THEIRS, 'desk')).toMatchObject({ state: 'recording' })
    const child = fake.children[0]!
    expect(child.args.slice(0, 5)).toEqual(['io', THEIRS, 'recordVideo', '--codec=h264', '--force'])
    const file = child.args.at(-1)!
    expect((await stat(dirname(file))).mode & 0o777).toBe(0o700)
    await expect(sim.startRecording(THEIRS, 'desk')).rejects.toMatchObject({ code: 'simulator-recording' })
    // Another device of the person's cannot see, take or end it.
    expect(sim.recordingOf(THEIRS, 'phone')).toEqual({ state: 'none' })
    await expect(sim.takeRecording(THEIRS, 'phone')).rejects.toMatchObject({ code: 'simulator-no-recording' })
    expect(await sim.discardRecording(THEIRS, 'phone')).toBe(false)
    expect((await sim.takeRecording(THEIRS, 'desk')).equals(MOVIE)).toBe(true)
    expect(child.interrupted).toBe(true)
    await expect(stat(dirname(file))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(sim.recordingOf(THEIRS, 'desk')).toEqual({ state: 'none' })
    await expect(sim.startRecording(OURS, 'desk')).rejects.toMatchObject({ code: 'simulator-not-booted' })
  })

  it('ends by itself at its time, and waits to be taken', async () => {
    const fake = fakes()
    const sim = simulators(fake, { recordLimits: { ms: 50, bytes: 25 * 1024 * 1024 } })
    await sim.picture(THEIRS, 'jpeg', { frame: true })
    await sim.startRecording(THEIRS, 'desk')
    await tick(150)
    expect(sim.recordingOf(THEIRS, 'desk')).toMatchObject({ state: 'ready', ended: 'time' })
    expect((await sim.takeRecording(THEIRS, 'desk')).equals(MOVIE)).toBe(true)
  })

  it('is thrown away when the panel stops asking for frames, the device shuts down or the Host stops', async () => {
    let now = 1_000_000
    const fake = fakes()
    const sim = simulators(fake, { now: () => now })
    await sim.picture(THEIRS, 'jpeg', { frame: true })
    await sim.startRecording(THEIRS, 'desk')
    const first = fake.children[0]!.args.at(-1)!
    now += 30_000
    await tick(1_300)
    expect(sim.recordingOf(THEIRS, 'desk')).toEqual({ state: 'none' })
    await expect
      .poll(() =>
        stat(dirname(first)).then(
          () => 'there',
          () => 'gone',
        ),
      )
      .toBe('gone')
    // A frame of another device (a second window) does not end it.
    await sim.boot(OURS)
    await sim.picture(THEIRS, 'jpeg', { frame: true })
    await sim.startRecording(THEIRS, 'desk')
    await sim.picture(OURS, 'jpeg', { frame: true })
    await tick(1_300)
    expect(sim.recordingOf(THEIRS, 'desk')).toMatchObject({ state: 'recording' })
    expect(await sim.discardRecording(THEIRS, 'desk')).toBe(true)
    // Latch shuts down the device it booted.
    await sim.picture(OURS, 'jpeg', { frame: true })
    await sim.startRecording(OURS, 'desk')
    await sim.shutdown(OURS)
    await tick()
    expect(sim.recordingOf(OURS, 'desk')).toEqual({ state: 'none' })
    expect(fake.children[2]!.interrupted).toBe(true)
    await sim.picture(THEIRS, 'jpeg', { frame: true })
    await sim.startRecording(THEIRS, 'desk')
    await sim.stop()
    await tick()
    expect(fake.children[3]!.interrupted).toBe(true)
    await expect
      .poll(() =>
        stat(dirname(fake.children[3]!.args.at(-1)!)).then(
          () => 'there',
          () => 'gone',
        ),
      )
      .toBe('gone')
  })

  it('fails, leaving nothing, when simctl never starts recording, and kills a child that will not stop', async () => {
    const fake = fakes({ recordStarts: false })
    const sim = simulators(fake)
    setTimeout(() => fake.children[0]?.exit(1), 30)
    await expect(sim.startRecording(THEIRS, 'desk')).rejects.toMatchObject({ code: 'simulator-failed' })
    await expect(stat(dirname(fake.children[0]!.args.at(-1)!))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('recording bounds', () => {
  const gone = (path: string) =>
    stat(path).then(
      () => 'there',
      () => 'gone',
    )

  it('gives the spawner its own bound past the time limit, and none to a log stream', async () => {
    const fake = fakes()
    const sim = simulators(fake)
    await sim.picture(THEIRS, 'jpeg', { frame: true })
    await sim.startRecording(THEIRS, 'desk')
    await sim.logs(THEIRS, undefined, { lines: () => true, dropped: () => {}, closed: () => {} })
    expect(fake.spawnOptions).toEqual([{ limitSeconds: 90 }, { limitSeconds: 0 }])
  })

  it('removes the directory before stop resolves, even with no device of its own and a child that ignores SIGINT', async () => {
    const fake = fakes({ stuck: true })
    const sim = simulators(fake)
    await sim.picture(THEIRS, 'jpeg', { frame: true })
    await sim.startRecording(THEIRS, 'desk')
    const file = fake.children[0]!.args.at(-1)!
    await sim.stop()
    expect(await gone(dirname(file))).toBe('gone')
    // SIGINT only: a killed recordVideo leaves the device's recorder busy until it reboots.
    expect([fake.children[0]!.interrupted, fake.children[0]!.killed]).toEqual([true, false])
  })

  it('ends at the size bound and refuses to hand over a movie past it', async () => {
    const fake = fakes()
    const sim = simulators(fake, { recordLimits: { ms: 60_000, bytes: 4096 } })
    await sim.picture(THEIRS, 'jpeg', { frame: true })
    await sim.startRecording(THEIRS, 'desk')
    await writeFile(fake.children[0]!.args.at(-1)!, Buffer.alloc(4096, 1))
    await expect.poll(() => sim.recordingOf(THEIRS, 'desk'), { timeout: 3_000 }).toMatchObject({ state: 'ready', ended: 'size' })
    expect(fake.children[0]!.interrupted).toBe(true)
    // A movie larger than the bound (the fake writes 24 bytes) is never read out.
    const small = fakes()
    const tight = simulators(small, { recordLimits: { ms: 60_000, bytes: 10 } })
    await tight.picture(THEIRS, 'jpeg', { frame: true })
    await tight.startRecording(THEIRS, 'desk')
    await expect(tight.takeRecording(THEIRS, 'desk')).rejects.toMatchObject({ status: 413, code: 'simulator-recording-too-large' })
    expect(await gone(dirname(small.children[0]!.args.at(-1)!))).toBe('gone')
  })

  it('holds two recordings at most, also when three start at once', async () => {
    const fake = fakes()
    const sim = simulators(fake)
    await sim.create('latch-third', TYPE, RUNTIME)
    for (const udid of [OURS, CREATED]) await sim.boot(udid)
    for (const udid of [OURS, THEIRS, CREATED]) await sim.picture(udid, 'jpeg', { frame: true })
    const started = await Promise.allSettled([OURS, THEIRS, CREATED].map(udid => sim.startRecording(udid, 'desk')))
    expect(started.filter(result => result.status === 'fulfilled')).toHaveLength(2)
    expect(started.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason)).toEqual([
      expect.objectContaining({ status: 429, code: 'simulator-recording' }),
    ])
    expect(fake.children).toHaveLength(2)
  })

  it('starts nothing once the Host has begun to stop while a log stream was set up', async () => {
    let release!: () => void
    const fake = fakes({ holdApps: new Promise(resolve => (release = resolve)) })
    const sim = simulators(fake)
    const sink = { lines: () => true, dropped: () => {}, closed: () => {} }
    const pending = sim.logs(THEIRS, 'com.apple.mobilesafari', sink).catch(error => error)
    const abort = new AbortController()
    const left = sim.logs(THEIRS, 'com.apple.mobilesafari', sink, abort.signal).catch(error => error)
    await tick()
    abort.abort()
    const stopping = sim.stop()
    release()
    expect(await pending).toMatchObject({ code: 'simulator-unavailable' })
    expect(await left).toMatchObject({ code: expect.stringMatching(/^simulator-(unavailable|logs-gone)$/u) })
    await stopping
    expect(fake.children).toHaveLength(0)
  })
})

describe('what a crashed Host left behind', () => {
  it('removes only stale picture and recording directories of this user by their exact names, never through a link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-stale-test-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const old = new Date(Date.now() - 20 * 60_000)
    const make = async (name: string, options: { fresh?: boolean; freshFile?: boolean } = {}) => {
      const dir = join(root, name)
      await mkdir(dir)
      await writeFile(join(dir, 'recording.mp4'), 'x')
      if (!options.freshFile) await utimes(join(dir, 'recording.mp4'), old, old)
      if (!options.fresh) await utimes(dir, old, old)
      return dir
    }
    await make('latch-rec-AbC123')
    await make('latch-sim-xyz789')
    // Another Host recording now: its file has just changed.
    await make('latch-rec-Live01', { freshFile: true })
    await make('latch-rec-toolong1')
    await make('latch-other-ABCDEF')
    // A link by the right name to somewhere else: neither it nor its target is removed.
    const target = await make('target')
    await symlink(target, join(root, 'latch-rec-Link01'))
    await writeFile(join(root, 'latch-sim-File01'), 'not a directory')
    expect((await removeStaleSimulatorTemp(root)).sort()).toEqual(['latch-rec-AbC123', 'latch-sim-xyz789'])
    expect((await readdir(root)).sort()).toEqual([
      'latch-other-ABCDEF',
      'latch-rec-Link01',
      'latch-rec-Live01',
      'latch-rec-toolong1',
      'latch-sim-File01',
      'target',
    ])
    expect(await readdir(target)).toEqual(['recording.mp4'])
  })
})

describe('logs', () => {
  it('streams compact lines, filtered to a listed app’s process, cleaned and bounded, dropped while the page is behind', async () => {
    const fake = fakes()
    const sim = simulators(fake)
    const got: string[] = []
    let dropped = 0
    let accept = true
    const closed: string[] = []
    const sink = {
      lines: (lines: string[]) => {
        got.push(...lines)
        return accept
      },
      dropped: (count: number) => void (dropped += count),
      closed: (reason: string) => void closed.push(reason),
    }
    await expect(sim.logs(THEIRS, 'com.example.missing', sink)).rejects.toMatchObject({ code: 'simulator-app-not-found' })
    await expect(sim.logs(THEIRS, '-x', sink)).rejects.toMatchObject({ code: 'invalid-input' })
    // An executable outside the strict set never reaches a predicate.
    await expect(sim.logs(THEIRS, 'com.apple.weird', sink)).rejects.toMatchObject({ code: 'invalid-input' })
    const stream = await sim.logs(THEIRS, 'com.apple.mobilesafari', sink)
    const child = fake.children[0]!
    expect(child.args).toEqual(['spawn', THEIRS, 'log', 'stream', '--style', 'compact', '--predicate', 'process == "MobileSafari"'])
    child.out('Filtering the log data using "process == \\"MobileSafari\\""\nTimestamp               Ty Process[PID:TID]\n')
    child.out(`2026-11-17 10:32:38.906 Df MobileSafari[1:2] hello‮\u0007 there\n${'x'.repeat(5000)}\npart`)
    child.out('ial\n')
    await tick(300)
    expect(got).toEqual(['2026-11-17 10:32:38.906 Df MobileSafari[1:2] hello there', `${'x'.repeat(999)}…`, 'partial'])
    accept = false
    child.out('one\n')
    await tick(300)
    child.out('two\nthree\n')
    await tick(300)
    expect(got.at(-1)).toBe('one')
    expect(dropped).toBe(2)
    stream.resume()
    child.out('four\n')
    await tick(300)
    expect(got.at(-1)).toBe('four')
    const all = await sim.logs(THEIRS, undefined, sink)
    expect(fake.children[1]!.args).toEqual(['spawn', THEIRS, 'log', 'stream', '--style', 'compact'])
    await expect(sim.logs(THEIRS, undefined, sink)).rejects.toMatchObject({ code: 'simulator-logs-busy' })
    all.close()
    await sim.stop()
    expect(closed).toEqual(['exited', 'host'])
    expect(fake.children.every(item => item.interrupted)).toBe(true)
  })
})

describe('log stream bounds', () => {
  it('holds two streams per device and four in all', async () => {
    const fake = fakes()
    const sim = simulators(fake)
    const sink = { lines: () => true, dropped: () => {}, closed: () => {} }
    await sim.create('latch-third', TYPE, RUNTIME)
    for (const udid of [OURS, CREATED]) await sim.boot(udid)
    for (const udid of [THEIRS, THEIRS, OURS, OURS]) await sim.logs(udid, undefined, sink)
    await expect(sim.logs(CREATED, undefined, sink)).rejects.toMatchObject({ status: 429, code: 'simulator-logs-busy' })
    expect(fake.children).toHaveLength(4)
  })
})

describe('shutting down the devices Latch booted', () => {
  it('after ten minutes the panel has left one, never one the person started, nor one in use', async () => {
    let now = 5_000_000
    const fake = fakes()
    const reasons: string[] = []
    const sim = simulators(fake, {
      now: () => now,
      idleMs: 10 * 60_000,
      onAutoShutdown: async (udid, reason) => void reasons.push(`${udid}:${reason}`),
    })
    await sim.boot(OURS)
    now += 9 * 60_000
    expect(await sim.idleCheck()).toEqual([])
    // A frame starts the time again.
    await sim.picture(OURS, 'jpeg', { frame: true })
    now += 9 * 60_000
    expect(await sim.idleCheck()).toEqual([])
    // An agent's Xcode session holds it.
    sim.agentCall('s1', 'start', OURS)
    now += 11 * 60_000
    expect(await sim.idleCheck()).toEqual([])
    sim.agentEnded('s1')
    expect(await sim.idleCheck()).toEqual([OURS])
    expect(fake.states.get(OURS)).toBe('Shutdown')
    expect(fake.states.get(THEIRS)).toBe('Booted')
    expect(reasons).toEqual([`${OURS}:idle`])
    expect(fake.calls.filter(args => args[0] === 'shutdown')).toEqual([['shutdown', OURS]])
  })

  it('never one booted again by the person between two lists, nor one simctl gave no boot time for', async () => {
    let now = 5_000_000
    const fake = fakes()
    const sim = simulators(fake, { now: () => now, idleMs: 10 * 60_000 })
    await sim.boot(OURS)
    // The person shut it down and booted it again while no one listed: simctl's boot time is new.
    fake.marks.set(OURS, '2026-11-17T09:00:00Z')
    now += 11 * 60_000
    expect(await sim.idleCheck()).toEqual([])
    expect(fake.states.get(OURS)).toBe('Booted')
    // An Xcode that lists no boot time: Latch cannot tell, so it leaves the device running.
    const blind = fakes({ marks: false })
    const unsure = simulators(blind, { now: () => now, idleMs: 10 * 60_000 })
    await unsure.boot(OURS)
    now += 11 * 60_000
    expect(await unsure.idleCheck()).toEqual([])
    await unsure.stop()
    expect(blind.calls.some(args => args[0] === 'shutdown')).toBe(false)
    expect(blind.states.get(OURS)).toBe('Booted')
  })

  it('counts opening it in Device Hub as use', async () => {
    let now = 5_000_000
    const fake = fakes()
    const sim = simulators(fake, { now: () => now, idleMs: 10 * 60_000, openHub: async () => ok() })
    await sim.boot(OURS)
    now += 9 * 60_000
    await sim.openInHub(OURS)
    now += 9 * 60_000
    expect(await sim.idleCheck()).toEqual([])
  })

  it('as the Host stops, only its own, once however often stop is called', async () => {
    const fake = fakes()
    const reasons: string[] = []
    const sim = new Simulators({ run: fake.run, idleMs: 0, onAutoShutdown: async (udid, reason) => void reasons.push(`${udid}:${reason}`) })
    await sim.boot(OURS)
    await Promise.all([sim.stop(), sim.stop()])
    expect(fake.calls.filter(args => args[0] === 'shutdown')).toEqual([['shutdown', OURS]])
    expect(reasons).toEqual([`${OURS}:host-stop`])
    expect(fake.states.get(THEIRS)).toBe('Booted')
    // Booted again by the person since: listed again as the Host stops, and left running.
    const again = fakes()
    const rebooted = new Simulators({ run: again.run, idleMs: 0 })
    await rebooted.boot(OURS)
    again.marks.set(OURS, '2026-11-17T09:00:00Z')
    await rebooted.stop()
    expect(again.calls.some(args => args[0] === 'shutdown')).toBe(false)
  })
})

async function host(
  options: Parameters<typeof startTestHost>[0] = {},
  fake = fakes(),
): Promise<{ t: TestHost; fake: ReturnType<typeof fakes> }> {
  const t = await startTestHost({
    tls: true,
    simulators: { run: fake.run, devicectl: fake.devicectl, spawn: fake.spawn, idleMs: 0 },
    ...options,
  })
  cleanups.push(() => t.close())
  return { t, fake }
}

async function audit(t: TestHost): Promise<Array<{ action: string; actor: { listener: string }; detail: Record<string, unknown> }>> {
  return (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
}

describe('the new routes', () => {
  it('are this Mac’s alone, for a device allowed what the terminal is allowed', async () => {
    const { t, fake } = await host()
    const browser = await t.enroll({ name: 'Browser', scopes: ['view', 'run', 'admin'] })
    const phone = await t.enroll({ listener: 'tls', name: 'Phone', scopes: ['view', 'run', 'admin'] })
    const viewer = await t.enroll({ listener: 'unix', name: 'Viewer', scopes: ['view'] })
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    const work = await t.enroll({ listener: 'unix', name: 'Work window' })
    expect((await desktop.request(`devices/${work.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
    for (const elsewhere of [browser, phone, viewer, work]) {
      for (const [path, body] of [
        [`simulators/${THEIRS}/rotate`, { direction: 'left' }],
        [`simulators/${THEIRS}/record`, { action: 'start' }],
        [`simulators/${THEIRS}/launch`, { bundleId: 'com.apple.mobilesafari' }],
        [`simulators/${THEIRS}/terminate`, { bundleId: 'com.apple.mobilesafari' }],
        [`simulators/${THEIRS}/privacy`, { action: 'grant', service: 'photos', bundleId: 'com.apple.mobilesafari' }],
        ['simulators', { name: 'x', deviceType: TYPE, runtime: RUNTIME }],
      ] as const)
        expect((await elsewhere.request(path, { body })).status).toBe(403)
      for (const path of [
        `simulators/${THEIRS}/apps`,
        `simulators/${THEIRS}/logs`,
        `simulators/${THEIRS}/orientation`,
        'simulators/catalog',
      ])
        expect((await elsewhere.request(path)).status).toBe(403)
    }
    expect(fake.calls.some(args => args[0] !== 'list') || fake.ctl.length > 0 || fake.children.length > 0).toBe(false)
  })

  it('record each action first, with hashes for apps and no typed name, and hand a recording to its own panel only', async () => {
    const { t, fake } = await host()
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    const other = await t.enroll({ listener: 'unix', name: 'Other window' })
    const list = await desktop.json<{ abilities: Record<string, boolean> }>('simulators')
    expect(list.abilities).toEqual({ rotate: true, record: true, logs: true })
    expect(await desktop.json(`simulators/${THEIRS}/orientation`)).toEqual({ supported: true, orientation: 'portrait' })
    expect(await desktop.json(`simulators/${THEIRS}/rotate`, { body: { direction: 'right' } })).toEqual({ orientation: 'landscapeRight' })
    expect((await desktop.request(`simulators/${THEIRS}/rotate`, { body: { direction: 'up' } })).status).toBe(400)
    const apps = await desktop.json<{ apps: Array<{ bundleId: string }> }>(`simulators/${THEIRS}/apps`)
    expect(apps.apps.map(app => app.bundleId)).toContain('com.apple.mobilesafari')
    expect(JSON.stringify(apps)).not.toContain('MobileSafari')
    expect((await desktop.request(`simulators/${THEIRS}/launch`, { body: { bundleId: 'com.apple.mobilesafari' } })).status).toBe(200)
    expect((await desktop.request(`simulators/${THEIRS}/launch`, { body: { bundleId: '--console' } })).status).toBe(400)
    expect(
      (
        await desktop.request(`simulators/${THEIRS}/privacy`, {
          body: { action: 'grant', service: 'all', bundleId: 'com.apple.mobilesafari' },
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await desktop.request(`simulators/${THEIRS}/privacy`, {
          body: { action: 'grant', service: 'photos', bundleId: 'com.apple.mobilesafari' },
        })
      ).status,
    ).toBe(200)
    const catalog = await desktop.json<{ runtimes: unknown[] }>('simulators/catalog')
    expect(catalog.runtimes).toHaveLength(1)
    expect(await desktop.json('simulators', { body: { name: 'latch-secret-name', deviceType: TYPE, runtime: RUNTIME } })).toEqual({
      udid: CREATED,
    })
    expect((await desktop.request('simulators', { body: { name: '-x', deviceType: TYPE, runtime: RUNTIME } })).status).toBe(400)
    // A recording, started with a frame shown.
    await desktop.request(`simulators/${THEIRS}/frame`)
    expect(await desktop.json(`simulators/${THEIRS}/record`, { body: { action: 'start' } })).toMatchObject({ state: 'recording' })
    expect(await other.json(`simulators/${THEIRS}/record`)).toEqual({ state: 'none' })
    expect((await other.request(`simulators/${THEIRS}/record`, { body: { action: 'stop' } })).status).toBe(404)
    const movie = await desktop.request(`simulators/${THEIRS}/record`, { body: { action: 'stop' } })
    expect([movie.status, movie.headers.get('content-type'), movie.headers.get('cache-control')]).toEqual([200, 'video/mp4', 'no-store'])
    expect(Buffer.from(await movie.arrayBuffer()).equals(MOVIE)).toBe(true)
    const records = (await audit(t)).filter(record => record.action === 'simulator.action')
    expect(records.map(record => record.detail.action)).toEqual(['rotate', 'launch', 'privacy', 'create', 'record'])
    expect(records[0]!.detail).toEqual({ action: 'rotate', udid: THEIRS, direction: 'right' })
    expect(records[1]!.detail).toEqual({ action: 'launch', udid: THEIRS, bundleHash: expect.stringMatching(/^[0-9a-f]{64}$/u) })
    expect(records[2]!.detail).toMatchObject({ privacy: 'grant', service: 'photos' })
    expect(records[3]!.detail).toEqual({ action: 'create', deviceType: TYPE, runtime: RUNTIME })
    const text = JSON.stringify(await audit(t))
    expect(text).not.toContain('mobilesafari')
    expect(text).not.toContain('latch-secret-name')
    expect(fake.children[0]!.args[2]).toBe('recordVideo')
  })

  it('stream logs to the panel as text/event-stream, and end them when the device may no longer see them', async () => {
    const { t, fake } = await host()
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    const stop = new AbortController()
    cleanups.push(() => stop.abort())
    const response = await desktop.request(`simulators/${THEIRS}/logs?app=com.apple.mobilesafari`, { signal: stop.signal })
    expect([response.status, response.headers.get('content-type')]).toEqual([200, 'text/event-stream'])
    const reader = response.body!.getReader()
    const child = fake.children[0]!
    expect(child.args.at(-1)).toBe('process == "MobileSafari"')
    child.out('a line of the log\n')
    let text = ''
    for (let attempt = 0; attempt < 20 && !text.includes('a line of the log'); attempt++)
      text += new TextDecoder().decode((await reader.read()).value)
    expect(text).toContain('event: lines')
    expect((await audit(t)).filter(record => record.action === 'simulator.action').map(record => record.detail)).toEqual([
      { action: 'logs', udid: THEIRS, filtered: true },
    ])
    expect(JSON.stringify(await audit(t))).not.toContain('a line of the log')
    expect((await desktop.request(`simulators/${THEIRS}/logs?app=-x`)).status).toBe(400)
    stop.abort()
    await tick(50)
    expect(child.interrupted).toBe(true)
  })

  it('leave no log child behind for a page that closed while the stream was set up', async () => {
    let release!: () => void
    const { t, fake } = await host({}, fakes({ holdApps: new Promise(resolve => (release = resolve)) }))
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    const stop = new AbortController()
    const answer = desktop.request(`simulators/${THEIRS}/logs?app=com.apple.mobilesafari`, { signal: stop.signal }).catch(error => error)
    await expect.poll(() => fake.calls.some(args => args[0] === 'listapps')).toBe(true)
    stop.abort()
    await answer
    await tick(50)
    release()
    await tick(100)
    expect(fake.children.every(child => child.interrupted)).toBe(true)
    // Its places are free again: two more streams of this device open.
    for (const attempt of [1, 2]) {
      const again = new AbortController()
      cleanups.push(() => again.abort())
      expect((await desktop.request(`simulators/${THEIRS}/logs`, { signal: again.signal })).status, String(attempt)).toBe(200)
    }
  })

  it.each([
    ['its data scope narrowed', 'scope'],
    ['the device revoked', 'revoked'],
    ['its credential no longer current', 'credential'],
  ] as const)('end a log stream with %s while it runs', async (_, change) => {
    const { t, fake } = await host()
    const admin = await t.enroll({ listener: 'unix', name: 'Admin' })
    const desktop = await t.enroll({ listener: 'unix', name: 'Desktop' })
    const stop = new AbortController()
    cleanups.push(() => stop.abort())
    const response = await desktop.request(`simulators/${THEIRS}/logs`, { signal: stop.signal })
    const reader = response.body!.getReader()
    const child = fake.children[0]!
    child.out('first line\n')
    let text = ''
    for (let attempt = 0; attempt < 20 && !text.includes('first line'); attempt++)
      text += new TextDecoder().decode((await reader.read()).value)
    if (change === 'scope')
      expect((await admin.request(`devices/${desktop.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
    else if (change === 'revoked') expect((await admin.request(`devices/${desktop.id}`, { method: 'DELETE' })).status).toBe(200)
    else vi.spyOn(t.host.security.devices, 'streamAllowed').mockReturnValue(false)
    child.out('second line\n')
    let rest = ''
    for (let attempt = 0; attempt < 20; attempt++) {
      const { value, done } = await reader.read()
      if (done) break
      rest += new TextDecoder().decode(value)
    }
    vi.restoreAllMocks()
    expect(rest).not.toContain('second line')
    await expect.poll(() => child.interrupted).toBe(true)
  })
})

/** A model that calls the tools in `steps` one per step. */
function scripted(steps: Array<{ name: string; arguments: Record<string, unknown> }>) {
  const plugin: HarnessPlugin = {
    id: 'scripted',
    name: 'Scripted',
    version: '1',
    description: 'fixture',
    activate(context) {
      context.registerProvider({
        id: 'scripted',
        name: 'Scripted',
        model: 'scripted',
        modelCapabilities: { scripted: { vision: true } },
        async *stream({ messages }: { messages: ModelMessage[]; tools: ToolDefinition[] }) {
          const step = steps[messages.filter(message => message.role === 'tool').length]
          if (!step) {
            yield { type: 'text', text: 'done' }
            yield { type: 'finish', reason: 'stop' }
            return
          }
          yield { type: 'tool-call', call: { id: `call-${randomUUID()}`, ...step } }
          yield { type: 'finish', reason: 'tool-calls' }
        },
      })
    },
  }
  return { plugin }
}

async function provide(desktop: TestDevice) {
  const registered = await desktop.registerBrowserProvider()
  const { providerId } = (await registered.json()) as { providerId: string }
  const stop = new AbortController()
  cleanups.push(() => stop.abort())
  expect((await desktop.request('browser-provider/stream', { method: 'POST', body: { providerId }, signal: stop.signal })).status).toBe(200)
}

describe('device tools for agents', () => {
  it('rotate, list apps and launch a listed one with no arguments, on record with hashes', async () => {
    const { plugin } = scripted([
      { name: 'device_apps', arguments: { udid: THEIRS } },
      { name: 'device_launch', arguments: { udid: THEIRS, bundleId: 'com.apple.mobilesafari' } },
      { name: 'device_launch', arguments: { udid: THEIRS, bundleId: 'com.example.missing' } },
      { name: 'device_rotate', arguments: { udid: THEIRS, direction: 'left' } },
    ])
    const { t, fake } = await host({ demo: false, providerId: 'scripted', plugins: [plugin] })
    const desktop = await t.enroll({ listener: 'unix' })
    await provide(desktop)
    const { sessionId } = await desktop.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), prompt: '试试', mode: 'agent', model: { providerId: 'scripted', model: 'scripted' } },
    })
    let detail: TaskDetail | undefined
    for (let attempt = 0; attempt < 400; attempt++) {
      detail = await desktop.json<TaskDetail>(`tasks/${sessionId}`)
      for (const approval of detail.approvals ?? [])
        await desktop.request(`approvals/${approval.id}`, { body: { decision: 'allow', optionId: 'allow_always' } })
      if (!['running', 'waiting-approval'].includes(detail.summary.status)) break
      await tick(25)
    }
    const rows = detail!.messages.filter(message => message.toolName?.startsWith('device_'))
    expect(rows.map(row => [row.toolName, row.state])).toEqual([
      ['device_apps', 'completed'],
      ['device_launch', 'completed'],
      ['device_launch', 'failed'],
      ['device_rotate', 'completed'],
    ])
    expect(rows[0]!.text).toContain('com.apple.mobilesafari · Safari · system')
    expect(rows[2]!.text).toContain('device_apps')
    expect(rows[3]!.text).toContain('landscapeLeft')
    expect(fake.calls.filter(args => args[0] === 'launch')).toEqual([['launch', THEIRS, 'com.apple.mobilesafari']])
    const calls = (await audit(t)).filter(record => record.action === 'simulator.call')
    expect(calls.map(record => [record.detail.tool, record.detail.risk])).toEqual([
      ['device_apps', 'R0'],
      ['device_launch', 'R1'],
      ['device_launch', 'R1'],
      ['device_rotate', 'R1'],
    ])
    expect(calls[1]!.detail.bundleHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(calls[3]!.detail.direction).toBe('left')
    expect(JSON.stringify(calls)).not.toContain('mobilesafari')
  })
})
