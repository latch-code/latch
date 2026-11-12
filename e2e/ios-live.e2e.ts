import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { expect, it } from 'vitest'
import { startTestHost, type TestHost } from './helpers/host.ts'

const run = promisify(execFile)
const PREFIX = 'latch-live-'
const BUNDLE = 'dev.latch.ios.screens'
const TYPES = ['iPhone-17-Pro', 'iPhone-16-Pro', 'iPhone-17', 'iPhone-16']
/** Live mode's markers and what only its software keys import; `ios-app.e2e.ts` checks the product has none of them. */
const MARKERS = ['LatchLive software keys', 'LiveSoftwareKeys', 'LiveIdentityProvider', '-LatchLive']
const SOFTWARE_KEY_SYMBOLS = ['_SecKeyCreateWithData', '_kSecAttrKeyClassPrivate']
/** Any use of a CryptoKit P-256 signing private key: its type, methods and metadata all carry this mangled name. */
const P256_PRIVATE_KEY = 'CryptoKit4P256O7SigningO10PrivateKeyV'
/**
 * `LATCH_IOS_LIVE_HOLD=<file>`: keep everything running until that file exists or `LATCH_IOS_LIVE_HOLD_MINUTES` (120)
 * pass; `<file>.pair` puts a fresh code on the clipboard; `<file>.info` names the simulator once the App is ready.
 */
const HOLD = process.env.LATCH_IOS_LIVE_HOLD
const HOLD_MS = HOLD ? Number(process.env.LATCH_IOS_LIVE_HOLD_MINUTES ?? 120) * 60_000 : 0
/** `LATCH_IOS_LIVE_PAIR_SECONDS`: without hold, wait this long for someone to pair through 「粘贴」, and fail if nobody does. */
const PAIR_MS = Number(process.env.LATCH_IOS_LIVE_PAIR_SECONDS ?? 0) * 1000
const STEPS = { build: 300_000, simctl: 120_000, boot: 600_000 }
/**
 * The reusable simulator for hands-on passes: the simulator control tool asks the owner once per device, so this is the
 * one device they grant. `LATCH_IOS_LIVE_KEEP=1` creates it (or reuses one of that name) and leaves it;
 * `LATCH_IOS_LIVE_DEVICE=<udid>` runs on it, or on any existing simulator, which the test never shuts down, erases or
 * deletes: it only installs, launches and stops the App and clears the clipboard.
 */
const HANDS_ON = 'latch-hands-on'
const DEVICE = process.env.LATCH_IOS_LIVE_DEVICE
const KEEP = process.env.LATCH_IOS_LIVE_KEEP === '1'
type Simulators = { devices: Record<string, Array<{ name: string; udid: string; state?: string }>> }
const listSimulators = (): Simulators['devices'][string] =>
  Object.values(
    (
      JSON.parse(
        execFileSync('/usr/bin/xcrun', ['simctl', 'list', 'devices', '-j'], { timeout: 60_000, encoding: 'utf8', maxBuffer: 16_777_216 }),
      ) as Simulators
    ).devices,
  ).flat()
/**
 * Simulators with this test's own prefix that a run which did not finish left, read now so the budget counts them;
 * never the given device or the hands-on one, whatever its name.
 */
const LEFTOVERS: string[] = (() => {
  if (process.platform !== 'darwin' || process.env.LATCH_IOS_LIVE !== '1') return []
  try {
    return listSimulators()
      .filter(item => item.name.startsWith(PREFIX) && item.udid !== DEVICE && item.name !== HANDS_ON)
      .map(item => item.udid)
  } catch {
    return []
  }
})()
/**
 * Every step's own limit, added up, so the test's budget always outlasts them: the build; boot, boot status and install;
 * 13 quick simctl calls in a run, 3 more that can start just before the hold or pairing deadline, 2 per leftover; nm,
 * the Host and pauses.
 */
const BUDGET = STEPS.build + 3 * STEPS.boot + (16 + 2 * LEFTOVERS.length) * STEPS.simctl + 120_000 + PAIR_MS + HOLD_MS
const simctl = (...args: string[]) => run('/usr/bin/xcrun', ['simctl', ...args], { timeout: STEPS.simctl, maxBuffer: 16_777_216 })
/** A runtime's first boot migrates its data and can take minutes. */
const simctlSlow = (...args: string[]) => run('/usr/bin/xcrun', ['simctl', ...args], { timeout: STEPS.boot, maxBuffer: 16_777_216 })
const pause = (ms: number) => new Promise(done => setTimeout(done, ms))

/**
 * The App's QR must name a private address, and the simulator shares the Mac's network, so the test Host's native
 * listener binds, for this run only, the private IPv4 of the default route's interface: Wi‑Fi or Ethernet, never a VPN
 * tunnel or a VM bridge. Without one the test skips.
 */
async function lanAddress(): Promise<string | undefined> {
  const route = await run('/sbin/route', ['-n', 'get', 'default'], { timeout: 10_000 }).catch(() => undefined)
  const name = /interface:\s*(\S+)/u.exec(route?.stdout ?? '')?.[1]
  if (!name || !/^en\d+$/u.test(name)) return undefined
  for (const row of networkInterfaces()[name] ?? []) {
    if (row.internal || row.family !== 'IPv4') continue
    const [a, b] = row.address.split('.').map(Number) as [number, number]
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return row.address
  }
  return undefined
}

/** The code goes to the simulator's clipboard through stdin only: never an argument, the environment, a file or a log. */
function toClipboard(udid: string, payload: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn('/usr/bin/xcrun', ['simctl', 'pbcopy', udid], { stdio: ['pipe', 'ignore', 'ignore'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), STEPS.simctl)
    child.once('error', fail)
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) done()
      else fail(new Error(`simctl pbcopy exited ${code}`))
    })
    child.stdin.end(payload)
  })
}

async function pairingCode(owner: TestDevice): Promise<string> {
  const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
  return invitation.payload
}

/**
 * How many phones have used a code so far: registered on the native listener or waiting to be. A code on the clipboard
 * is cleared once this rises above what it was when that code was written.
 */
function usage(host: TestHost): number {
  return host.host.security.devices.nativeCandidates().length + host.host.security.enrollments.waiting().length
}

/**
 * Simulator.app's 「Automatically Sync Pasteboard」 (on by default) copies the simulator's clipboard to this Mac's and on
 * to Universal Clipboard, and has no command-line switch; the test runs the simulator headless and writes no code while
 * Simulator.app is open.
 */
async function simulatorAppOpen(): Promise<boolean> {
  return Boolean((await run('/usr/bin/pgrep', ['-x', 'Simulator']).catch(() => ({ stdout: '' }))).stdout.trim())
}
const SIMULATOR_APP =
  'Simulator.app is open: its pasteboard sync would carry the pairing code to this Mac’s clipboard, so no code was written'

/**
 * Opt-in (`LATCH_IOS_LIVE=1`, macOS with an iOS Simulator runtime): the LatchScreens target in live mode, against a
 * temporary test Host, so an iOS change can be tried by tapping through it. Live mode swaps the Secure Enclave keys,
 * which the simulator lacks, for in-memory software keys (`native/ios/Screens/LiveKeys.swift`); it proves nothing about
 * the Secure Enclave, Face ID or a real device. The test builds the target, deletes `latch-live-` simulators an earlier
 * run left, makes and boots one of its own, installs the App, then starts a Host with the demo model, the fake ACP Agent
 * (「Fake Agent」), a temporary Git project and test presence, launches the App with `-LatchLive 1` and puts a pairing
 * code on the simulator's clipboard for 「粘贴」, clearing it once the App has used that code. Everything it made is removed at
 * the end. Screenshots go to `LATCH_IOS_LIVE_DIR`, or `test-results/ios-live/`.
 */
it.skipIf(process.platform !== 'darwin' || process.env.LATCH_IOS_LIVE !== '1')(
  'runs the App in live mode on a simulator of its own against a temporary test Host, ready to pair',
  async context => {
    if (await simulatorAppOpen()) {
      context.skip(SIMULATOR_APP)
      return
    }
    const address = await lanAddress()
    if (!address) {
      context.skip('The default route is not Wi‑Fi or Ethernet with a private IPv4 for the test Host’s native listener')
      return
    }
    const runtimes = JSON.parse((await simctl('list', 'runtimes', '-j')).stdout) as {
      runtimes: Array<{ identifier: string; version?: string; isAvailable?: boolean; supportedDeviceTypes?: Array<{ identifier: string }> }>
    }
    const typeId = (name: string) => `com.apple.CoreSimulator.SimDeviceType.${name}`
    const choice = runtimes.runtimes
      .filter(item => item.isAvailable && item.identifier.includes('iOS'))
      .toSorted((a, b) => (b.version ?? '').localeCompare(a.version ?? '', undefined, { numeric: true }))
      .map(item => ({ runtime: item, type: TYPES.map(typeId).find(id => item.supportedDeviceTypes?.some(type => type.identifier === id)) }))
      .find(item => item.type)
    if (!choice?.type) {
      context.skip('No installed iOS Simulator runtime runs an iPhone from the list')
      return
    }
    // Only simulators with this test's own prefix, left by a run that did not finish.
    for (const leftover of LEFTOVERS) {
      await simctl('shutdown', leftover).catch(() => {})
      await simctl('delete', leftover).catch(() => {})
    }
    const output = resolve(process.env.LATCH_IOS_LIVE_DIR ?? 'test-results/ios-live')
    await mkdir(output, { recursive: true })
    let derived: string | undefined
    let udid: string | undefined
    /** Whether this run made the simulator and so shuts it down and deletes it. */
    let owned = false
    let host: TestHost | undefined
    try {
      derived = await mkdtemp(join(tmpdir(), 'latch-ios-live-'))
      await run(
        '/usr/bin/xcodebuild',
        [
          '-project',
          'native/ios/Latch.xcodeproj',
          '-scheme',
          'LatchScreens',
          '-configuration',
          'Debug',
          '-sdk',
          'iphonesimulator',
          '-destination',
          'generic/platform=iOS Simulator',
          '-derivedDataPath',
          derived,
          '-clonedSourcePackagesDirPath',
          'native/ios/.build/xcode-packages',
          '-disableAutomaticPackageResolution',
          '-onlyUsePackageVersionsFromResolvedFile',
          'CODE_SIGNING_ALLOWED=NO',
          'ARCHS=arm64',
          'ONLY_ACTIVE_ARCH=YES',
          'build',
        ],
        { timeout: STEPS.build, maxBuffer: 16_777_216 },
      )
      const application = join(derived, 'Build/Products/Debug-iphonesimulator/LatchScreens.app')
      // The markers and symbols the product check looks for are really in this target, so their absence there means something.
      const files = [
        join(application, 'LatchScreens'),
        ...(await readdir(application)).filter(name => name.endsWith('.dylib')).map(name => join(application, name)),
      ]
      const product = Buffer.concat(await Promise.all(files.map(file => readFile(file))))
      for (const marker of MARKERS) expect(product.includes(Buffer.from(marker))).toBe(true)
      const imported = (
        await Promise.all(files.map(async file => (await run('/usr/bin/nm', ['-u', file], { maxBuffer: 67_108_864 })).stdout))
      )
        .join('\n')
        .split('\n')
      for (const symbol of SOFTWARE_KEY_SYMBOLS) expect(imported).toContain(symbol)
      expect(imported.some(symbol => symbol.includes(P256_PRIVATE_KEY))).toBe(true)

      if (DEVICE) {
        if (!listSimulators().some(item => item.udid === DEVICE)) throw new Error('LATCH_IOS_LIVE_DEVICE names no simulator on this Mac')
        udid = DEVICE
      } else if (KEEP) {
        udid =
          listSimulators().find(item => item.name === HANDS_ON)?.udid
          ?? (await simctl('create', HANDS_ON, choice.type, choice.runtime.identifier)).stdout.trim()
      } else udid = (await simctl('create', `${PREFIX}${Date.now()}`, choice.type, choice.runtime.identifier)).stdout.trim()
      owned = !DEVICE && !KEEP
      if (listSimulators().find(item => item.udid === udid)?.state !== 'Booted') await simctlSlow('boot', udid)
      await simctlSlow('bootstatus', udid, '-b')
      if (KEEP) await writeFile(join(output, 'device.txt'), `${HANDS_ON} ${udid}\n`)
      await simctlSlow('install', udid, application)
      // The pairing page asks for the camera before it shows 「粘贴」; the simulator has none to scan with.
      await simctl('privacy', udid, 'grant', 'camera', BUNDLE).catch(() => {})

      // The Host's native listener is on the LAN from here until `finally`.
      host = await startTestHost({ native: { host: address, port: 0 } })
      // A project with one commit and the fake ACP Agent, so a session can start, stream and ask for a step.
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
          cwd: host!.workspaceRoot,
          stdio: 'pipe',
        })
      git('init', '-q', '-b', 'main')
      git('commit', '-q', '--allow-empty', '-m', 'first')
      const owner = await host.enroll({ listener: 'unix' })
      const saved = await owner.request('agents', {
        method: 'POST',
        body: { name: 'Fake Agent', command: process.execPath, args: [FAKE_ACP_AGENT] },
      })
      expect(saved.status).toBe(201)

      await simctl('launch', '--terminate-running-process', udid, BUNDLE, '-LatchLive', '1')
      /** The usage count when the code now on the clipboard was written; undefined when none is. */
      let written: number | undefined
      /** Puts a fresh code on the clipboard, unless Simulator.app is open; returns why not. */
      const place = async (): Promise<string | undefined> => {
        if (await simulatorAppOpen()) return SIMULATOR_APP
        const before = usage(host!)
        await toClipboard(udid!, await pairingCode(owner))
        written = before
        return undefined
      }
      /** Clears the clipboard once a phone has used the code written last. */
      const watch = async () => {
        if (written !== undefined && usage(host!) > written) {
          await toClipboard(udid!, '')
          written = undefined
        }
      }
      const refused = await place()
      if (refused && !HOLD) throw new Error(refused)
      await pause(3000)
      await simctl('io', udid, 'screenshot', join(output, 'ready.png'))
      expect((await simctl('spawn', udid, 'launchctl', 'list')).stdout).toContain(BUNDLE)

      if (HOLD) {
        // Names and paths only, in `<file>.info` since the runner may hold console output back.
        const info = [`simulator ${udid}`, `stop: touch ${HOLD}`, `fresh code: touch ${HOLD}.pair`]
        await writeFile(`${HOLD}.info`, [...info, ...(refused ? [refused] : [])].join('\n') + '\n')
        const deadline = Date.now() + HOLD_MS
        while (!existsSync(HOLD) && Date.now() < deadline) {
          await watch()
          if (existsSync(`${HOLD}.pair`) && Date.now() < deadline) {
            await rm(`${HOLD}.pair`, { force: true })
            await toClipboard(udid, '')
            written = undefined
            const why = await place()
            await writeFile(`${HOLD}.info`, [...info, ...(why ? [why] : [])].join('\n') + '\n')
          }
          await pause(Math.min(1000, Math.max(0, deadline - Date.now())))
        }
        await rm(HOLD, { force: true })
        await rm(`${HOLD}.info`, { force: true })
      } else if (PAIR_MS) {
        const deadline = Date.now() + PAIR_MS
        while (host.host.security.devices.nativeCandidates().length === 0 && Date.now() < deadline) {
          await watch()
          await pause(Math.min(500, Math.max(0, deadline - Date.now())))
        }
        await watch()
        expect(host.host.security.devices.nativeCandidates().length).toBe(1)
        expect(written).toBeUndefined()
        await pause(3000)
        await simctl('io', udid, 'screenshot', join(output, 'paired.png'))
      }
    } finally {
      // The clipboard is emptied and the App stopped on any device; only a simulator this run made is shut down and deleted.
      if (udid) {
        await toClipboard(udid, '').catch(() => {})
        await simctl('terminate', udid, BUNDLE).catch(() => {})
        if (owned) {
          await simctl('shutdown', udid).catch(() => {})
          await simctl('delete', udid).catch(() => {})
        }
      }
      await host?.close()
      if (derived) await rm(derived, { recursive: true, force: true })
    }
  },
  BUDGET,
)
