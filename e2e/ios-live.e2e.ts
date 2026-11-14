import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { FAKE_ACP_AGENT, fakeConversation, writeFakeHistory, type TestDevice } from '@latch/testkit'
import { expect, it } from 'vitest'
import type { AutomationDetail, AutomationList, TaskDetail } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { clipboardLease, compileClipboardLease } from './helpers/iosClipboardLease.ts'
import { clipboardGui, validateGuiPairing } from './helpers/iosClipboardValidation.ts'
import { readDeviceClipboard, writeDeviceClipboard } from './helpers/iosDeviceClipboard.ts'
import { pairingStagePage } from './helpers/iosPairingStage.ts'
import { iosSlashEnvironment, prepareIosSlash } from './helpers/iosSlash.ts'

const run = promisify(execFile)
const PREFIX = 'latch-live-'
const BUNDLE = 'dev.latch.ios.screens'
const TYPES = ['iPhone-17-Pro', 'iPhone-16-Pro', 'iPhone-17', 'iPhone-16']
const SCHEDULE_MODEL = { providerId: 'ios-live-schedule', model: 'fixture' }
/** Optional normal-API templates and actual ACP command reports for the native Slash acceptance pass. */
const SLASH = process.env.LATCH_IOS_SLASH === '1'
/** The fake Agent really reports these ACP options; no fixture fills permission or model DTOs by hand. */
const LIVE_AGENT_ENV = { FAKE_ACP_CONFIG: 'legacy', ...(SLASH ? iosSlashEnvironment : {}) }
/** Scheduled work uses Standard under the existing unattended ceiling, with only a local scripted reply. */
const scheduledProvider: HarnessPlugin = {
  id: SCHEDULE_MODEL.providerId,
  name: 'iOS live schedule fixture',
  version: '1',
  description: 'Local replies for manual native UI acceptance.',
  activate(context) {
    context.registerProvider({
      id: SCHEDULE_MODEL.providerId,
      name: '本地验收模型',
      model: SCHEDULE_MODEL.model,
      async *stream({ messages }) {
        yield { type: 'text', text: `已整理：${messages.findLast(message => message.role === 'user')?.content ?? ''}` }
        yield { type: 'finish', reason: 'stop' }
      },
    })
  },
}
/** Live mode's markers and what only its software keys import; `ios-app.e2e.ts` checks the product has none of them. */
const MARKERS = ['LatchLive software keys', 'LatchLive pairing-stage', 'LiveSoftwareKeys', 'LiveIdentityProvider', '-LatchLive']
const SOFTWARE_KEY_SYMBOLS = ['_SecKeyCreateWithData', '_kSecAttrKeyClassPrivate']
/** Any use of a CryptoKit P-256 signing private key: its type, methods and metadata all carry this mangled name. */
const P256_PRIVATE_KEY = 'CryptoKit4P256O7SigningO10PrivateKeyV'
/**
 * `LATCH_IOS_LIVE_HOLD=<file>`: keep everything running until that file exists or `LATCH_IOS_LIVE_HOLD_MINUTES` (120)
 * pass; `<file>.pair` puts a fresh code on the clipboard; `<file>.info` names the simulator once the App is ready.
 */
const HOLD = process.env.LATCH_IOS_LIVE_HOLD
/** Only a controlled manual run may validate the official GUI's ON/OFF behavior before one ten-second code. */
const GUI_CLIPBOARD = process.env.LATCH_IOS_LIVE_GUI_CLIPBOARD === '1'
/**
 * `LATCH_IOS_LIVE_HOSTS=2`: a second test Host on the same private address, with its own data, the fake ACP Agent and a
 * project, for several computers; with hold, `<file>.pair2` puts a fresh code for it on the clipboard.
 */
const HOSTS = process.env.LATCH_IOS_LIVE_HOSTS === '2' ? 2 : 1
/**
 * With two Hosts and hold, `<file>.wait<n>` starts a session of the fake ACP Agent on Host n that waits for a decision,
 * `<file>.revoke<n>` removes every phone from Host n, as its owner would, and `<file>.stop<n>` stops Host n; n is 1 or 2.
 */
const HOST_ACTIONS = ['wait', 'revoke', 'stop'] as const
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
/** `LATCH_IOS_LIVE_HISTORY=1`: also a project of two folders and the fake agent as Codex with sessions of its own, for 接入已有会话. */
const HISTORY = process.env.LATCH_IOS_LIVE_HISTORY === '1'
/** `LATCH_IOS_LIVE_AGENTS=1`: also a Standard Agent on a local fixture provider with an allowed daily schedule. */
const AGENTS = process.env.LATCH_IOS_LIVE_AGENTS === '1'
/**
 * `LATCH_IOS_LIVE_ATTACH=1`: also the fake agent declaring images and text (「Fake Images」), so attachments can be sent; the
 * plain 「Fake Agent」 takes none. With hold, `<file>.received` writes the attachment references the Host's sessions hold
 * (names, kinds, sizes and types, never bytes) to `<file>.received.json`.
 */
const ATTACH = process.env.LATCH_IOS_LIVE_ATTACH === '1'
/**
 * `LATCH_IOS_LIVE_ACTIVITY=1`: also 资讯, an Agent on the fake ACP Agent in a project of its own, with a disabled saved task
 * that edits a file when run manually, for result cards, schedule proposals (`schedule <name> <when> <HH:MM> <input>`),
 * 动态 and 资料库. With hold, `<file>.run` runs it now, as its owner would, and `<file>.fail` runs a second one whose agent exits
 * mid-run, so its card offers 立即运行.
 */
const ACTIVITY = process.env.LATCH_IOS_LIVE_ACTIVITY === '1'
/**
 * `LATCH_IOS_LIVE_COMPUTER=1`: also 晨报助手 on Standard and the local fixture provider with a daily schedule the Mac "slept" past: the Host's
 * clock moves past the time between a sleep and a wake report, as `agent-computer.e2e.ts` does, and back before the phone
 * pairs, so its 「电脑」 shows 错过 1 次 with the cause.
 */
const COMPUTER = process.env.LATCH_IOS_LIVE_COMPUTER === '1'
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
 * Every step's own limit, added up, so the test's budget always outlasts them: the build; boot, boot status and install;
 * 13 quick simctl calls in a run, 3 more that can start just before the hold or pairing deadline; nm,
 * the Host and pauses.
 */
const BUDGET = STEPS.build + 3 * STEPS.boot + 16 * STEPS.simctl + 120_000 + PAIR_MS + HOLD_MS
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
const toClipboard = writeDeviceClipboard

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
 * Simulator.app or its DeviceHub successor is open.
 */
async function simulatorAppOpen(): Promise<boolean> {
  return (await clipboardGui()).kind !== 'closed'
}
const SIMULATOR_APP =
  'Simulator or DeviceHub is open: its pasteboard sync could carry the pairing code to this Mac’s clipboard, so no code was written'

/**
 * Opt-in (`LATCH_IOS_LIVE=1`, macOS with an iOS Simulator runtime): the LatchScreens target in live mode, against a
 * temporary test Host, so an iOS change can be tried by tapping through it. Live mode swaps the Secure Enclave keys,
 * which the simulator lacks, for in-memory software keys (`native/ios/Screens/LiveKeys.swift`); it proves nothing about
 * the Secure Enclave, Face ID or a real device. The test builds the target, makes and boots its own simulator,
 * installs the App, then starts a Host with the demo model, the fake ACP Agent
 * (「Fake Agent」), a temporary Git project and test presence, launches the App with `-LatchLive 1` and puts a pairing
 * code on the simulator's clipboard for 「粘贴」, clearing it once the App has used that code. Everything it made is removed at
 * the end. Screenshots go to `LATCH_IOS_LIVE_DIR`, or `test-results/ios-live/`.
 */
it.skipIf(process.platform !== 'darwin' || process.env.LATCH_IOS_LIVE !== '1')(
  'runs the App in live mode on a simulator of its own against a temporary test Host, ready to pair',
  async context => {
    if (GUI_CLIPBOARD && (!HOLD || (KEEP && !DEVICE)))
      throw new Error('GUI clipboard validation needs HOLD and a new or explicitly owned DEVICE; implicit hands-on reuse is not allowed')
    if (!GUI_CLIPBOARD && (await simulatorAppOpen())) {
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
    const output = resolve(process.env.LATCH_IOS_LIVE_DIR ?? 'test-results/ios-live')
    await mkdir(output, { recursive: true })
    const status = GUI_CLIPBOARD ? await pairingStagePage() : undefined
    const phases: Array<{ phase: string; host: number; at: number }> = []
    const record = (phase: string, host: number) => {
      phases.push({ phase, host, at: Date.now() })
    }
    const savePhases = () => writeFile(join(output, 'pairing-phases.json'), JSON.stringify(phases, null, 2) + '\n')
    let derived: string | undefined
    let udid: string | undefined
    let appPid: string | undefined
    /** Whether this run made the simulator and so shuts it down and deletes it. */
    let owned = false
    let host: TestHost | undefined
    let other: TestHost | undefined
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
      let shift = 0
      host = await startTestHost({
        native: { host: address, port: 0 },
        now: () => Date.now() + shift,
        plugins: [scheduledProvider],
        nativeNearby: () => {
          record('native-nearby', 1)
          return true
        },
      })
      // A project with one commit and the fake ACP Agent, so a session can start, stream and ask for a step.
      /** A Host with one committed project and the fake ACP Agent, and its owner device. */
      const agents = new Map<TestHost, string>()
      const prepare = async (target: TestHost, label: 'A' | 'B'): Promise<TestDevice> => {
        const git = (...args: string[]) =>
          execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
            cwd: target.workspaceRoot,
            stdio: 'pipe',
          })
        git('init', '-q', '-b', 'main')
        await writeFile(join(target.workspaceRoot, 'computer.txt'), `Temporary computer ${label}\n`)
        git('add', '--', 'computer.txt')
        git('commit', '-q', '-m', 'first')
        const enrolled = await target.enroll({ listener: 'unix' })
        if (SLASH) await prepareIosSlash(enrolled)
        const saved = await enrolled.confirmed('agents', {
          method: 'POST',
          body: { name: 'Fake Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: LIVE_AGENT_ENV },
        })
        expect(saved.status).toBe(201)
        agents.set(target, ((await saved.json()) as { agent: { id: string } }).agent.id)
        return enrolled
      }
      const owner = await prepare(host, 'A')
      if (ATTACH) {
        const images = await owner.confirmed('agents', {
          method: 'POST',
          body: {
            name: 'Fake Images',
            command: process.execPath,
            args: [FAKE_ACP_AGENT],
            env: { ...LIVE_AGENT_ENV, FAKE_ACP_CAPS: 'images,embedded' },
          },
        })
        expect(images.status).toBe(201)
      }
      if (HISTORY) await addHistory(host, owner)
      if (AGENTS) await addAgent(owner)
      const scheduled = ACTIVITY ? await addActivityAgent(host, owner) : undefined
      if (COMPUTER)
        await addMissedAgent(host, owner, value => {
          shift = value
        })
      other =
        HOSTS === 2
          ? await startTestHost({
              native: { host: address, port: 0 },
              nativeNearby: () => {
                record('native-nearby', 2)
                return true
              },
            })
          : undefined
      const otherOwner = other ? await prepare(other, 'B') : undefined

      const launched = await simctl('launch', '--terminate-running-process', udid, BUNDLE, '-LatchLive', '1')
      appPid = /: ([0-9]+)\s*$/u.exec(launched.stdout)?.[1]
      const clipboardBinary = GUI_CLIPBOARD ? await compileClipboardLease(derived) : undefined
      /** The Host whose code is on the clipboard and its usage count when it was written; undefined when none is. */
      let written: number | undefined
      let writtenFor: TestHost = host
      /** Puts a fresh code on the clipboard, unless Simulator.app is open; returns why not. */
      const place = async (target: TestHost = host!, by: TestDevice = owner): Promise<string | undefined> => {
        if (GUI_CLIPBOARD) {
          if (!HOLD || !clipboardBinary || (!owned && !DEVICE)) throw new Error('GUI clipboard validation has no owned target')
          const before = usage(target)
          const index = target === host ? 1 : 2
          await validateGuiPairing(
            {
              device: udid!,
              clipboard: () => clipboardLease(clipboardBinary),
              hold: HOLD,
              guiPid: async () => {
                const gui = await clipboardGui()
                return gui.kind === 'open' ? gui.pid : undefined
              },
              guiClosed: async () => (await clipboardGui()).kind === 'closed',
              readDevice: () => readDeviceClipboard(udid!),
              // Process startup can exceed a second; the proof still expires ten seconds after the code window starts.
              writeDevice: value => toClipboard(udid!, value, 5000),
              stage: async text => {
                const phase = text.includes('Clipboard ON,')
                  ? 'on-control'
                  : text.includes('Clipboard OFF,')
                    ? 'off-control'
                    : text.startsWith('Clipboard controls passed.')
                      ? 'paste-ready'
                      : text.startsWith('Pairing code consumed.')
                        ? 'consumed'
                        : text.startsWith('Pairing code consumed and')
                          ? 'restored'
                          : 'cleanup'
                record(phase, index)
                status?.show(phase)
                await savePhases()
                await writeFile(`${HOLD}.clipboard-info`, text + '\n', { mode: 0o600 })
              },
            },
            async () => {
              record('invitation-start', index)
              const value = await pairingCode(by)
              record('invitation-ready', index)
              return value
            },
            () => usage(target) > before,
            () => target.close(),
          )
          return undefined
        }
        if (await simulatorAppOpen()) return SIMULATOR_APP
        const before = usage(target)
        await toClipboard(udid!, await pairingCode(by))
        written = before
        writtenFor = target
        return undefined
      }
      /** Clears the clipboard once a phone has used the code written last. */
      const watch = async () => {
        if (written !== undefined && usage(writtenFor) > written) {
          await toClipboard(udid!, '')
          written = undefined
        }
      }
      const refused = GUI_CLIPBOARD
        ? 'GUI clipboard validation has not run. Prepare the normal Paste page, then request one code through the hold control.'
        : await place()
      if (refused && !HOLD) throw new Error(refused)
      await pause(3000)
      await simctl('io', udid, 'screenshot', join(output, 'ready.png'))
      expect((await simctl('spawn', udid, 'launchctl', 'list')).stdout).toContain(BUNDLE)

      if (HOLD) {
        // Names and paths only, in `<file>.info` since the runner may hold console output back.
        const info = [
          `simulator ${udid}`,
          `stop: touch ${HOLD}`,
          `fresh code: touch ${HOLD}.pair`,
          ...(GUI_CLIPBOARD ? [`clipboard validation stage: ${HOLD}.clipboard-info`] : []),
          ...(status ? [`read-only public stage: ${status.url}`] : []),
          ...(other ? [`fresh code for the second computer: touch ${HOLD}.pair2`] : []),
        ]
        await writeFile(`${HOLD}.info`, [...info, ...(refused ? [refused] : [])].join('\n') + '\n')
        const deadline = Date.now() + HOLD_MS
        while (!existsSync(HOLD) && Date.now() < deadline) {
          await watch()
          if (existsSync(`${HOLD}.pair`) && Date.now() < deadline) {
            await rm(`${HOLD}.pair`, { force: true })
            if (!GUI_CLIPBOARD) await toClipboard(udid, '')
            written = undefined
            const why = await place()
            await writeFile(`${HOLD}.info`, [...info, ...(why ? [why] : [])].join('\n') + '\n')
          }
          if (other && otherOwner && existsSync(`${HOLD}.pair2`) && Date.now() < deadline) {
            for (const name of ['pair2', 'wait1', 'wait2', 'revoke1', 'revoke2', 'stop1', 'stop2'])
              await rm(`${HOLD}.${name}`, { force: true })
            if (!GUI_CLIPBOARD) await toClipboard(udid, '')
            written = undefined
            // A Host with a session waiting on the person makes no new code; that is said, and the hold goes on.
            const why = await place(other, otherOwner).catch((error: unknown) => {
              if (GUI_CLIPBOARD) throw error
              return `no code: ${String(error).slice(0, 200)}`
            })
            await writeFile(`${HOLD}.info`, [...info, ...(why ? [why] : [])].join('\n') + '\n')
          }
          for (const [flag, id] of scheduled
            ? ([
                ['run', scheduled.edits],
                ['fail', scheduled.fails],
              ] as const)
            : []) {
            if (!existsSync(`${HOLD}.${flag}`)) continue
            await rm(`${HOLD}.${flag}`, { force: true })
            await owner.request(`automations/${id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
          }
          if (ATTACH && existsSync(`${HOLD}.received`)) {
            await rm(`${HOLD}.received`, { force: true })
            const { tasks } = await owner.json<{ tasks: Array<{ id: string }> }>('snapshot')
            const received: unknown[] = []
            for (const task of tasks) {
              const detail = await owner.json<{ messages: Array<{ role: string; attachments?: Array<Record<string, unknown>> }> }>(
                `tasks/${encodeURIComponent(task.id)}`,
              )
              for (const message of detail.messages)
                for (const ref of message.attachments ?? [])
                  received.push({ session: task.id, name: ref.name, kind: ref.kind, mime: ref.mime, size: ref.size, width: ref.width })
            }
            await writeFile(`${HOLD}.received.json`, JSON.stringify(received, null, 2) + '\n')
          }
          for (const [index, [target, by]] of (other && otherOwner
            ? ([
                [host, owner],
                [other, otherOwner],
              ] as const)
            : []
          ).entries())
            for (const action of HOST_ACTIONS) {
              const flag = `${HOLD}.${action}${index + 1}`
              if (!existsSync(flag)) continue
              await rm(flag, { force: true })
              if (action === 'wait') {
                await by.json('tasks', {
                  method: 'POST',
                  body: { harnessId: agents.get(target), mode: 'agent', prompt: 'permission', requestId: randomUUID() },
                })
              } else if (action === 'stop') {
                await target.close().catch(() => {})
              } else {
                const { devices } = await by.json<{ devices: Array<{ id: string; native?: unknown; status?: string }> }>('devices')
                for (const device of devices.filter(item => item.native && item.status !== 'revoked'))
                  await by.request(`devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' })
              }
            }
          await pause(Math.min(1000, Math.max(0, deadline - Date.now())))
        }
        await rm(HOLD, { force: true })
        await rm(`${HOLD}.info`, { force: true })
        await rm(`${HOLD}.pair2`, { force: true })
        await rm(`${HOLD}.received.json`, { force: true })
        await rm(`${HOLD}.run`, { force: true })
        await rm(`${HOLD}.fail`, { force: true })
        if (GUI_CLIPBOARD) await rm(`${HOLD}.clipboard-info`, { force: true })
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
      await status?.close().catch(() => {})
      await savePhases().catch(() => {})
      // The clipboard is emptied and the App stopped on any device; only a simulator this run made is shut down and deleted.
      if (udid) {
        // This dedicated Screens-only subsystem emits fixed milestones and elapsed time, never pairing inputs.
        const timing = appPid
          ? await simctl(
              'spawn',
              udid,
              'log',
              'show',
              '--style',
              'compact',
              '--last',
              '1h',
              '--predicate',
              `processIdentifier == ${appPid} AND subsystem == "dev.latch.ios.screens" AND category == "pairing-timing"`,
            ).catch(() => undefined)
          : undefined
        if (timing) {
          await writeFile(
            join(output, 'pairing-app-timing.log'),
            timing.stdout
              .split('\n')
              .filter(line => line.includes('LatchLive pairing-stage '))
              .join('\n') + '\n',
          ).catch(() => {})
          await writeFile(
            join(output, 'connection-app-timing.log'),
            timing.stdout
              .split('\n')
              .filter(line => line.includes('LatchLive connection-stage '))
              .join('\n') + '\n',
          ).catch(() => {})
        }
        // The validated workflow clears its own clipboard. Never send an unguarded clear through an unknown GUI.
        if (!GUI_CLIPBOARD) await toClipboard(udid, '').catch(() => {})
        await simctl('terminate', udid, BUNDLE).catch(() => {})
        if (owned) {
          await simctl('shutdown', udid).catch(() => {})
          await simctl('delete', udid).catch(() => {})
        }
      }
      await other?.close().catch(() => {})
      await host?.close().catch(() => {})
      if (derived) await rm(derived, { recursive: true, force: true })
    }
  },
  BUDGET,
)

/** The fake agent as Codex listing and loading sessions of its own (through its adapter), and a project to list them in. */
async function addHistory(host: TestHost, owner: TestDevice): Promise<void> {
  const root = join(await realpath(host.root), 'history')
  const main = join(root, 'app')
  const other = join(root, 'docs')
  for (const folder of [main, join(main, 'web'), other]) await mkdir(folder, { recursive: true })
  const at = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
  const file = await writeFakeHistory(root, [
    { sessionId: 'ext-web', cwd: join(main, 'web'), title: 'Web 构建变慢', updatedAt: at(1), updates: fakeConversation() },
    { sessionId: 'ext-login', cwd: main, title: '登录页的 token 刷新', updatedAt: at(20), updates: fakeConversation() },
    { sessionId: 'ext-rebuild', cwd: main, title: '拆分 relay 的握手', updatedAt: at(50), updates: fakeConversation() },
    { sessionId: 'ext-busy', cwd: main, title: '终端里还开着', updatedAt: at(70), busy: true, updates: [] },
    { sessionId: 'ext-docs', cwd: other, title: 'Docs', updates: [] },
  ])
  const env = {
    FAKE_ACP_CONFIG: 'options',
    FAKE_ACP_MODES: 'read-only,workspace-write,agent,agent-full-access',
    FAKE_ACP_INITIAL_MODE: 'agent-full-access',
    FAKE_ACP_CAPS: 'list,load,resume,close,delete,dirs',
    FAKE_ACP_STATE: join(root, 'codex-state.json'),
    FAKE_ACP_HISTORY_FILE: file,
  }
  const codex = await owner.confirmed('agents', {
    method: 'POST',
    body: { id: 'codex', name: 'Codex', presetId: 'codex', command: process.execPath, args: [FAKE_ACP_AGENT], env },
  })
  expect(codex.status).toBe(201)
  expect((await owner.addFolders({ paths: [main, other] })).status).toBe(201)
}

it('reads the live fake Agent configuration and continues its same session without touching a simulator', async () => {
  const host = await startTestHost()
  try {
    const owner = await host.enroll({ listener: 'unix' })
    if (SLASH) await prepareIosSlash(owner)
    const response = await owner.confirmed('agents', {
      method: 'POST',
      body: { name: 'Fake Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: LIVE_AGENT_ENV },
    })
    expect(response.status).toBe(201)
    const harnessId = ((await response.json()) as { agent: { id: string } }).agent.id
    const first = await owner.json<{ sessionId: string }>('tasks', {
      method: 'POST',
      body: { harnessId, mode: 'agent', prompt: SLASH ? 'plan' : 'first', requestId: randomUUID() },
    })
    const detail = () => owner.json<TaskDetail>(`tasks/${first.sessionId}`)
    await expect.poll(async () => (await detail()).summary.status).toBe('idle')
    const ready = await detail()
    if (SLASH) {
      expect(ready.commands).toHaveLength(200)
      expect((await owner.json<{ templates: unknown[] }>('prompts')).templates).toHaveLength(2)
    }
    expect(ready.config).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'mode',
          currentValue: 'build',
          options: expect.arrayContaining([expect.objectContaining({ value: 'build' }), expect.objectContaining({ value: 'plan' })]),
        }),
        expect.objectContaining({ id: 'model', currentValue: 'small' }),
      ]),
    )
    const requestId = randomUUID()
    await owner.json(`tasks/${first.sessionId}/prompt`, { method: 'POST', body: { prompt: 'second', requestId } })
    await expect.poll(async () => (await detail()).messages.filter(message => message.role === 'user').length).toBe(2)
    await expect.poll(async () => (await detail()).summary.status).toBe('idle')
    const continued = await detail()
    expect(
      continued.messages.some(message => message.role === 'user' && message.text === 'second' && message.requestId === requestId),
    ).toBe(true)
    expect(continued.permission?.drift).toBeUndefined()
  } finally {
    await host.close()
  }
})

it('prepares native manual runs and an allowed missed schedule without touching a simulator', async () => {
  let shift = 0
  const host = await startTestHost({ now: () => Date.now() + shift, plugins: [scheduledProvider] })
  try {
    const owner = await host.enroll({ listener: 'unix' })
    await addAgent(owner)
    const saved = await addActivityAgent(host, owner)
    for (const [id, state] of [
      [saved.edits, 'completed'],
      [saved.fails, 'interrupted'],
    ] as const) {
      const before = await owner.json<AutomationDetail>(`automations/${id}`)
      expect(before.automation).toMatchObject({ enabled: false, state: 'off' })
      await owner.json(`automations/${id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
      await expect
        .poll(async () => (await owner.json<AutomationDetail>(`automations/${id}`)).runs[0]?.state, { timeout: 20_000 })
        .toBe(state)
      const ran = await owner.json<AutomationDetail>(`automations/${id}`)
      expect(ran.automation.enabled).toBe(false)
      expect(ran.runs[0]?.trigger).toBe('manual')
      expect(ran.runs[0]?.sessionId).toBeTypeOf('string')
      const detail = await owner.json<TaskDetail>(`tasks/${ran.runs[0].sessionId}`)
      expect(detail.summary).toMatchObject({ automationId: id, harnessId: 'fake-news' })
    }
    expect(await readFile(join(host.root, 'news', 'agent-edit.txt'), 'utf8')).toBe('edited by the agent\n')
    await addMissedAgent(host, owner, value => {
      shift = value
    })
    const all = (await owner.json<AutomationList>('automations')).automations
    expect(all).toHaveLength(4)
    const missed = all.find(item => item.name === '晨报')!
    expect(missed).toMatchObject({ enabled: true, state: 'ready' })
    const detail = await owner.json<AutomationDetail>(`automations/${missed.id}`)
    expect(detail.runs.some(attempt => attempt.state === 'missed' && attempt.trigger === 'schedule')).toBe(true)
    expect(detail.runs.some(attempt => attempt.sessionId)).toBe(false)
    await owner.json(`automations/${missed.id}/run`, { method: 'POST', body: { requestId: randomUUID() } })
    await expect
      .poll(async () => (await owner.json<AutomationDetail>(`automations/${missed.id}`)).runs[0]?.state, { timeout: 20_000 })
      .toBe('completed')
    const ran = (await owner.json<AutomationDetail>(`automations/${missed.id}`)).runs[0]
    expect(ran.trigger).toBe('manual')
    expect(ran.sessionId).toBeTypeOf('string')
    const morning = await owner.json<TaskDetail>(`tasks/${ran.sessionId}`)
    expect(morning.summary.harnessId).toBe('standard')
    expect(morning.messages.some(message => message.role === 'assistant' && message.text === '已整理：写今天的晨报')).toBe(true)
  } finally {
    await host.close()
  }
})

/** A Standard Agent with a local fixture provider and one allowed daily schedule, for 我的 Agent. */
async function addAgent(owner: TestDevice): Promise<void> {
  const agent = await owner.json<{ id: string }>('custom-agents', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '代码审阅',
      description: '只报真实的问题',
      harnessId: 'standard',
      mode: 'chat',
      model: SCHEDULE_MODEL,
      instructions: '只报真实的问题。',
      skills: [],
    },
  })
  await owner.json('automations', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '每日检查',
      customAgentId: agent.id,
      prompt: '看一下昨天的改动',
      schedule: { kind: 'daily', time: '09:00' },
      notify: false,
    },
  })
}

/** 晨报助手 with a daily schedule whose time passed while the Host's clock was moved on between a sleep and a wake report. */
async function addMissedAgent(host: TestHost, owner: TestDevice, shift: (ms: number) => void): Promise<void> {
  const report = (body: unknown) => host.raw('unix', 'api/host/state', { method: 'POST', body })
  const agent = await owner.json<{ id: string }>('custom-agents', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '晨报助手',
      description: '每天早上写一页晨报',
      harnessId: 'standard',
      mode: 'chat',
      model: SCHEDULE_MODEL,
    },
  })
  const at = new Date(Date.now() + 10 * 60_000)
  const pad = (value: number) => String(value).padStart(2, '0')
  const automation = await owner.json<{ id: string; nextRunAt: string }>('automations', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '晨报',
      customAgentId: agent.id,
      prompt: '写今天的晨报',
      schedule: { kind: 'daily', time: `${pad(at.getHours())}:${pad(at.getMinutes())}` },
      notify: false,
    },
  })
  expect((await report({ state: 'sleeping' })).status).toBe(200)
  shift(Date.parse(automation.nextRunAt) - Date.now() + 5 * 60_000)
  const deadline = Date.now() + 15_000
  while ((await owner.json<{ missed: unknown[] }>(`custom-agents/${agent.id}/computer`)).missed.length === 0) {
    if (Date.now() > deadline) throw new Error('The schedule was not recorded as missed')
    await pause(200)
  }
  expect((await report({ state: 'awake' })).status).toBe(200)
  shift(0)
}

/** Native L3 work stays disabled for background dispatch; a person can run the write and failure tasks now. */
async function addActivityAgent(host: TestHost, owner: TestDevice): Promise<{ edits: string; fails: string }> {
  const saved = await owner.confirmed('agents', {
    method: 'POST',
    body: { id: 'fake-news', name: 'Fake News', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_MCP: 'dsh' } },
  })
  expect(saved.status).toBe(201)
  const folder = join(host.root, 'news')
  await mkdir(folder, { recursive: true })
  expect((await owner.addFolders({ paths: [folder], name: 'news' })).status).toBeLessThan(300)
  const { workspaces } = await owner.json<{ workspaces: Array<{ id: string; name: string }> }>('workspaces')
  const project = workspaces.find(item => item.name === 'news')!
  const agent = await owner.json<{ id: string }>('custom-agents', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: '资讯',
      description: '整理新闻',
      harnessId: 'fake-news',
      mode: 'agent',
      defaultProjectId: project.id,
    },
  })
  const add = (name: string, prompt: string, time: string) =>
    owner.json<{ id: string }>('automations', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name,
        customAgentId: agent.id,
        projectId: project.id,
        prompt,
        schedule: { kind: 'daily', time },
        notify: false,
        enabled: false,
      },
    })
  return { edits: (await add('早间精选', 'shell-edit', '08:00')).id, fails: (await add('夜间检查', 'crash', '21:00')).id }
}
