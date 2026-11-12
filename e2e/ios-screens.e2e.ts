import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const run = promisify(execFile)
const simctl = (...args: string[]) => run('/usr/bin/xcrun', ['simctl', ...args], { timeout: 120_000, maxBuffer: 16_777_216 })
/** A runtime's first boot migrates its data and can take minutes. */
const simctlSlow = (...args: string[]) => run('/usr/bin/xcrun', ['simctl', ...args], { timeout: 600_000, maxBuffer: 16_777_216 })
const pause = (ms: number) => new Promise(done => setTimeout(done, ms))

/** Scenes of the LatchScreens target (`native/ios/Screens/ScreensStage.swift`), chosen by a launch argument. */
const SCENES = [
  'code',
  'conversation',
  'conversation-actions',
  'subagents',
  'steer',
  'clearing',
  'approval-more',
  'approval-hidden',
  'fork',
  'rename',
  'delete',
  'archived',
  'search',
  'agents',
  'agents-faces',
  'agents-locked',
  'agent-chat',
  'agent-new',
  'agent-waiting',
  'agent-unavailable',
  'agent-profile',
  'agent-memory',
  'agent-schedules',
  'general',
  'apps',
  'app-page',
  'pairing',
  'review-list',
  'updating',
  'review',
  'review-locked',
  'commit',
  'commit-hook',
  'commit-unknown',
  'handoff',
  'returned',
  'history-entry',
  'history-locked',
  'history-list',
  'history-preview',
  'history-rebuild',
  'history-unknown',
  'history-busy',
  'history-imported',
  'history-seed',
  'history-lost',
  'brands',
  'about',
  'licenses',
  'computers',
  'computers-settings',
]
/** A narrow and a wide iPhone, and an iPad; the first device type of each list that this Xcode has. */
const DEVICES = [
  { name: 'iphone-narrow', types: ['iPhone-16e', 'iPhone-17e', 'iPhone-16'] },
  { name: 'iphone-wide', types: ['iPhone-17-Pro-Max', 'iPhone-16-Pro-Max', 'iPhone-16-Plus'] },
  { name: 'ipad', types: ['iPad-Pro-11-inch-M5-12GB', 'iPad-Pro-11-inch-M4-8GB', 'iPad-Air-11-inch-M3'] },
]

/**
 * `LATCH_IOS_SCREENS_DEVICE=<udid>`: run on that existing simulator alone, which the test boots when it is not running
 * and never creates, shuts down, erases or deletes; its light or dark appearance is put back at the end.
 */
const DEVICE = process.env.LATCH_IOS_SCREENS_DEVICE
type Listed = { devices: Record<string, Array<{ name: string; udid: string; state?: string; deviceTypeIdentifier?: string }>> }

/**
 * Opt-in (`LATCH_IOS_SCREENS=1`, macOS with an iOS Simulator runtime): builds the separate LatchScreens target, whose
 * canned scenes never enter the Latch product (`ios-app.e2e.ts` checks the product), then screenshots each scene light
 * and dark on simulators this test creates and deletes. No Host, key or secret is involved. Screenshots go to
 * `LATCH_IOS_SCREENS_DIR`, or `test-results/ios-screens/`; `LATCH_IOS_SCENES` (comma-separated prefixes) keeps only the
 * scenes a change touches.
 */
it.skipIf(process.platform !== 'darwin' || process.env.LATCH_IOS_SCREENS !== '1')(
  'screenshots the App’s scenes from the LatchScreens target on simulators of its own',
  async context => {
    const runtimes = JSON.parse((await simctl('list', 'runtimes', '-j')).stdout) as {
      runtimes: Array<{ identifier: string; version?: string; isAvailable?: boolean; supportedDeviceTypes?: Array<{ identifier: string }> }>
    }
    // A runtime may be for one device alone (iOS 27.2's iPhone Duo build), so it is chosen by what it can run: the newest
    // that has a type from each list, never simply the last one listed.
    const typeId = (name: string) => `com.apple.CoreSimulator.SimDeviceType.${name}`
    const newer = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true })
    const runtime = runtimes.runtimes
      .filter(item => item.isAvailable && item.identifier.includes('iOS'))
      .filter(item => {
        const supported = new Set((item.supportedDeviceTypes ?? []).map(type => type.identifier))
        return DEVICES.every(device => device.types.some(name => supported.has(typeId(name))))
      })
      .toSorted((a, b) => newer(a.version ?? '', b.version ?? ''))[0]
    if (!runtime && !DEVICE) {
      context.skip('No installed iOS Simulator runtime supports a narrow iPhone, a wide iPhone and an iPad from the lists')
      return
    }
    const supported = new Set((runtime?.supportedDeviceTypes ?? []).map(type => type.identifier))
    const prefixes = (process.env.LATCH_IOS_SCENES ?? '').split(',').filter(Boolean)
    const chosen = prefixes.length ? SCENES.filter(scene => prefixes.some(prefix => scene.startsWith(prefix))) : SCENES
    const types = JSON.parse((await simctl('list', 'devicetypes', '-j')).stdout) as { devicetypes: Array<{ identifier: string }> }
    const known = new Set(types.devicetypes.map(item => item.identifier))
    const output = resolve(process.env.LATCH_IOS_SCREENS_DIR ?? 'test-results/ios-screens')
    await mkdir(output, { recursive: true })
    const derived = await mkdtemp(join(tmpdir(), 'latch-ios-screens-'))
    const created: string[] = []
    try {
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
        { timeout: 300_000, maxBuffer: 16_777_216 },
      )
      const application = join(derived, 'Build/Products/Debug-iphonesimulator/LatchScreens.app')
      // The marker the product check looks for is really in this target, so its absence there means something.
      const libraries = (await readdir(application)).filter(name => name.endsWith('.dylib'))
      const product = Buffer.concat(
        await Promise.all(
          [join(application, 'LatchScreens'), ...libraries.map(name => join(application, name))].map(file => readFile(file)),
        ),
      )
      expect(product.includes(Buffer.from('LatchScreens fixture state'))).toBe(true)
      const given = DEVICE
        ? Object.values((JSON.parse((await simctl('list', 'devices', '-j')).stdout) as Listed).devices)
            .flat()
            .find(item => item.udid === DEVICE)
        : undefined
      if (DEVICE && !given) throw new Error('LATCH_IOS_SCREENS_DEVICE names no simulator on this Mac')
      const targets = given ? [{ name: given.deviceTypeIdentifier?.includes('iPad') ? 'ipad' : 'iphone', types: [] as string[] }] : DEVICES
      let used = 0
      for (const device of targets) {
        let udid: string
        if (given) {
          udid = given.udid
          if (given.state !== 'Booted') await simctlSlow('boot', udid)
        } else {
          const type = device.types.map(typeId).find(id => known.has(id) && supported.has(id))
          if (!type || !runtime) continue
          udid = (await simctl('create', `latch-screens-${device.name}-${Date.now()}`, type, runtime.identifier)).stdout.trim()
          created.push(udid)
          await simctlSlow('boot', udid)
        }
        used += 1
        await simctlSlow('bootstatus', udid, '-b')
        await simctl('install', udid, application)
        await simctl('privacy', udid, 'grant', 'camera', 'dev.latch.ios.screens').catch(() => {})
        const before = given ? (await simctl('ui', udid, 'appearance')).stdout.trim() : undefined
        // A fresh install's first launch is slow, so the first scene would be shot blank.
        await simctl('launch', '--terminate-running-process', udid, 'dev.latch.ios.screens', '-LatchScene', chosen[0] ?? 'code')
        await pause(6000)
        for (const theme of ['light', 'dark']) {
          await simctl('ui', udid, 'appearance', theme)
          for (const scene of chosen) {
            await simctl('launch', '--terminate-running-process', udid, 'dev.latch.ios.screens', '-LatchScene', scene)
            await pause(2500)
            await simctl('io', udid, 'screenshot', join(output, `${scene}--${theme}--${device.name}.png`))
          }
        }
        await simctl('terminate', udid, 'dev.latch.ios.screens').catch(() => {})
        if (before === 'light' || before === 'dark') await simctl('ui', udid, 'appearance', before)
      }
      expect(used).toBeGreaterThan(0)
    } finally {
      // Only the simulators this test made are shut down and deleted.
      for (const udid of created) {
        await simctl('shutdown', udid).catch(() => {})
        await simctl('delete', udid).catch(() => {})
      }
      await rm(derived, { recursive: true, force: true })
    }
  },
  2_700_000,
)
