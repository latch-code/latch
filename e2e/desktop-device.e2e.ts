// The 设备 panel in the real desktop app. Real simulator tests require an explicitly named, dedicated `latch-` device.
// Every simctl call naming another device is refused. The test never opens Device Hub.
import { _electron, chromium, type ElectronApplication, type Page } from '@playwright/test'
import { spawn as spawnChild } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { attachSimulatorHelper } from '@latch/host/simulator-live'
import { spawnSimctl, xcrunDevicectl, xcrunSimctl, type SimctlChild, type SimctlRunner, type SimctlSpawner } from '@latch/host/simulators'
import type { McpServerView } from '@latch/protocol'
import { FAKE_ACP_AGENT, fakeIdbCompanion, fakeSimulatorLive } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { noHorizontalOverflow, openSession } from './helpers/layout.ts'

const electronE2E = latchEnv(process.env, 'ELECTRON_E2E') === '1'
const OUT = 'test-results/desktop-device'

function shellEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

/** The explicitly named test simulator, shut down. */
async function testDevice(): Promise<{ udid: string; name: string } | undefined> {
  const name = latchEnv(process.env, 'E2E_SIMULATOR')
  if (process.platform !== 'darwin' || !name?.startsWith('latch-')) return undefined
  const listed = await xcrunSimctl(['list', 'devices', '--json', 'available'], { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 })
  if (listed.code !== 0) return undefined
  const groups = (
    JSON.parse(listed.stdout.toString('utf8')) as { devices: Record<string, Array<{ udid: string; name: string; state: string }>> }
  ).devices
  const matches = Object.values(groups)
    .flat()
    .filter(device => device.name === name)
  return matches.length === 1 && matches[0]?.state === 'Shutdown' ? matches[0] : undefined
}

async function capture(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: `${OUT}/${name}-dark.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light' })
}

async function captureDeviceWidths(app: ElectronApplication, page: Page, state: string) {
  for (const width of [1100, 1440]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size, 900), width)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
    await noHorizontalOverflow(page)
    await capture(page, `${state}-${width}`)
  }
}

const device = electronE2E ? await testDevice() : undefined

describe.skipIf(!electronE2E || !device)('native desktop shell: 设备', () => {
  it('lists, boots the latch- device, shows its picture, opens an address, and shuts it down', async () => {
    const target = device!
    // Only list, or a call naming the test device: nothing else of the person's can be touched.
    const calls: string[][] = []
    const guarded: SimctlRunner = async (args, options) => {
      if (args[0] !== 'list' && !args.includes(target.udid)) throw new Error(`refused simctl ${args[0]}`)
      calls.push([...args])
      return xcrunSimctl(args, options)
    }
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-device-'))
    const testHost = await startTestHost({
      demo: true,
      hostName: '验收电脑',
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
      presenceMode: 'manual',
      simulators: { run: guarded },
    })
    const { host } = testHost
    let application: ElectronApplication | undefined
    try {
      await writeHostState(testHost.dataDir, {
        version: 2,
        pid: process.pid,
        hostId: host.hostId,
        instanceId: host.instanceId,
        socketPath: host.socketPath,
        loopbackOrigin: host.loopbackOrigin,
        tlsOrigin: host.tlsOrigin ?? null,
        startedAt: new Date().toISOString(),
        dataDir: testHost.dataDir,
      })
      await mkdir(OUT, { recursive: true })
      application = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${join(testHost.dataDir, 'host.json')}`,
          `--latch-user-data=${join(root, 'electron')}`,
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: shellEnvironment(),
        timeout: 30_000,
      })
      const app = application
      const page = await app.firstWindow()
      page.setDefaultTimeout(30_000)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      const { sessionId } = await host.bridge.createTask({ prompt: '看设备', requestId: randomUUID(), mode: 'chat' })
      await page.locator(`[data-task-id="${sessionId}"]`).click()

      const panes = page.getByRole('group', { name: '工作台面板', exact: true })
      const rightToggle = panes.getByRole('button', { name: '侧边面板', exact: true })
      if ((await rightToggle.getAttribute('aria-pressed')) !== 'true') await rightToggle.click()
      const add = page.getByRole('button', { name: '打开面板', exact: true }).filter({ visible: true })
      await add.click()
      await page.getByRole('menuitem', { name: '设备', exact: true }).click()
      const panel = page.getByRole('region', { name: '设备', exact: true })
      const list = panel.getByRole('list', { name: '设备', exact: true })
      await list.waitFor()
      const row = list.getByRole('button', { name: new RegExp(`^${target.name}`, 'u') })
      await row.click()
      await capture(page, 'list')
      await panel.getByRole('button', { name: '启动', exact: true }).first().click()
      await panel.getByText('启动中', { exact: true }).waitFor()
      await capture(page, 'booting')
      const screen = panel.locator('img.sim-screen')
      await screen.waitFor({ timeout: 180_000 })
      await panel.getByText('运行中', { exact: true }).waitFor()
      // A few frames, to measure, and time for the home screen.
      await page.waitForTimeout(20_000)
      const frameMs = await panel.locator('.sim-canvas').getAttribute('data-frame-ms')
      process.stderr.write(`device frame round trip: ${frameMs} ms\n`)
      await capture(page, 'running')
      await panel.getByRole('button', { name: '打开地址', exact: true }).click()
      await panel.getByRole('textbox', { name: '设备上打开的地址' }).fill('https://example.com')
      await page.keyboard.press('Enter')
      await expect.poll(() => calls.some(args => args[0] === 'openurl')).toBe(true)
      // Opened: the field closes.
      await panel.getByRole('textbox', { name: '设备上打开的地址' }).waitFor({ state: 'hidden' })
      await page.waitForTimeout(6_000)
      await capture(page, 'opened-url')
      // Whatever the device had, the button turns it to the other one.
      const toggle = panel.getByRole('button', { name: /^外观：/u })
      const before = await toggle.getAttribute('aria-label')
      await toggle.click()
      await panel.getByRole('button', { name: before === '外观：深色' ? '外观：浅色' : '外观：深色', exact: true }).waitFor()
      await page.waitForTimeout(4_000)
      await capture(page, 'appearance-dark')
      await panel.getByRole('button', { name: '关机', exact: true }).click()
      await list.waitFor({ timeout: 90_000 })
      await panel.getByText('未启动', { exact: true }).waitFor()
      expect(host.security.audit.lastOf('simulator.action')).toMatchObject({ detail: { action: 'shutdown', udid: target.udid } })
      // Nothing but the test device was named.
      expect(calls.every(args => args[0] === 'list' || args.includes(target.udid))).toBe(true)
    } finally {
      await application?.close()
      await testHost.close()
      // Whatever happened, the test device ends shut down.
      await xcrunSimctl(['shutdown', target.udid], { timeoutMs: 60_000, maxBytes: 65_536 })
      await rm(root, { recursive: true, force: true })
    }
  }, 600_000)
})

const FAKE_UDID = 'ABCDEF00-1111-4111-8111-111111111111'
const IDLE_UDID = 'ABCDEF00-2222-4222-8222-222222222222'

/** A stand-in simctl: one running device whose picture is Latch's icon, one shut down that will not start. */
function fakeSimctl(xcode: boolean): SimctlRunner {
  return async args => {
    if (!xcode) return { code: 72, stdout: Buffer.alloc(0), stderr: 'xcrun: error: unable to find utility "simctl"' }
    if (args[0] === 'list') {
      const devices = [
        { udid: FAKE_UDID, name: 'latch-fake', state: 'Booted', isAvailable: true },
        { udid: IDLE_UDID, name: 'latch-fake-idle', state: 'Shutdown', isAvailable: true },
      ]
      return {
        code: 0,
        stdout: Buffer.from(JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-2': devices } })),
        stderr: '',
      }
    }
    if (args[0] === 'boot') return { code: 149, stdout: Buffer.alloc(0), stderr: 'Unable to boot device in current state: Creating\n' }
    if (args[0] === 'io') await copyFile(resolve('apps/web/public/icon.png'), args.at(-1)!)
    if (args[0] === 'ui' && args.length === 3) return { code: 0, stdout: Buffer.from('light\n'), stderr: '' }
    return { code: 0, stdout: Buffer.alloc(0), stderr: '' }
  }
}

/** A stand-in for Xcode's bridge: DeviceInteractionStartSession answers after 20 s, so an agent holds the device meanwhile. */
const SLOW_BRIDGE = `
let buffer = ''
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
process.stdin.setEncoding('utf8').on('data', chunk => {
  buffer += chunk
  for (let end = buffer.indexOf('\\n'); end >= 0; end = buffer.indexOf('\\n')) {
    const request = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    if (request.id === undefined) continue
    if (request.method === 'initialize') send({ id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'xcode-tools', version: '1' } } })
    else if (request.method === 'tools/list') send({ id: request.id, result: { tools: [{ name: 'DeviceInteractionStartSession', inputSchema: { type: 'object' } }] } })
    else if (request.method === 'tools/call') setTimeout(() => send({ id: request.id, result: { content: [{ type: 'text', text: 'session ready' }] } }), 20000)
    else send({ id: request.id, result: {} })
  }
})
`

describe.skipIf(!electronE2E || process.platform !== 'darwin')('native desktop shell: 设备 states', () => {
  it('says 未安装 Xcode, 失败 with its reason, and Agent 正在使用, with stand-ins only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-device-states-'))
    const bridge = join(root, 'bridge.cjs')
    await writeFile(bridge, SLOW_BRIDGE)
    const xcrun = join(root, 'xcrun')
    await writeFile(xcrun, `#!/bin/sh\nexec '${process.execPath}' '${bridge}'\n`)
    await chmod(xcrun, 0o755)
    await mkdir(OUT, { recursive: true })
    const launch = async (xcode: boolean) => {
      const testHost = await startTestHost({
        demo: true,
        hostName: '验收电脑',
        uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
        simulators: { run: fakeSimctl(xcode), live: fakeSimulatorLive().attach },
        xcodeBridge: { probe: async () => ({ bridge: true, version: '27.2' }), command: xcrun },
      })
      const { host } = testHost
      await writeHostState(testHost.dataDir, {
        version: 2,
        pid: process.pid,
        hostId: host.hostId,
        instanceId: host.instanceId,
        socketPath: host.socketPath,
        loopbackOrigin: host.loopbackOrigin,
        tlsOrigin: host.tlsOrigin ?? null,
        startedAt: new Date().toISOString(),
        dataDir: testHost.dataDir,
      })
      const app = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${join(testHost.dataDir, 'host.json')}`,
          `--latch-user-data=${join(root, `electron-${xcode}`)}`,
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: shellEnvironment(),
        timeout: 30_000,
      })
      const page = await app.firstWindow()
      page.setDefaultTimeout(30_000)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      return { testHost, app, page }
    }
    const openPanel = async (page: Page, sessionId: string) => {
      await page.locator(`[data-task-id="${sessionId}"]`).click()
      const panes = page.getByRole('group', { name: '工作台面板', exact: true })
      const rightToggle = panes.getByRole('button', { name: '侧边面板', exact: true })
      if ((await rightToggle.getAttribute('aria-pressed')) !== 'true') await rightToggle.click()
      await page.getByRole('button', { name: '打开面板', exact: true }).filter({ visible: true }).click()
      await page.getByRole('menuitem', { name: '设备', exact: true }).click()
      return page.getByRole('region', { name: '设备', exact: true })
    }
    const none = await launch(false)
    try {
      const { sessionId } = await none.testHost.host.bridge.createTask({ prompt: '看设备', requestId: randomUUID(), mode: 'chat' })
      const panel = await openPanel(none.page, sessionId)
      await panel.getByText('未安装 Xcode', { exact: true }).waitFor()
      await captureDeviceWidths(none.app, none.page, 'no-xcode')
    } finally {
      await none.app.close()
      await none.testHost.close()
    }
    const some = await launch(true)
    try {
      const { testHost, page } = some
      const owner = await testHost.enroll({ listener: 'unix', name: 'Owner' })
      await owner.confirmedJson('agents', {
        body: { id: 'mcp-agent', name: 'MCP Agent', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_MCP: 'dsh' } },
      })
      const added = await owner.confirmedJson<{ server: McpServerView }>('mcp/servers', {
        body: { requestId: randomUUID(), baseRevision: 0, preset: 'xcode', scope: { all: false, agents: [], projects: [] } },
      })
      await owner.json(`mcp/servers/${added.server.id}`, {
        method: 'PATCH',
        body: { requestId: randomUUID(), baseRevision: added.server.revision, scope: { all: true, agents: [], projects: [] } },
      })
      const { sessionId } = await testHost.host.bridge.createTask({ prompt: '看设备', requestId: randomUUID(), mode: 'chat' })
      const panel = await openPanel(page, sessionId)
      // A device that will not start: 失败, with simctl's reason on hover.
      await panel.locator('.sim-picker').click()
      await page.getByRole('menuitemradio', { name: /^latch-fake-idle/u }).click()
      await panel.getByRole('button', { name: '启动', exact: true }).first().click()
      const failed = panel.getByText('失败', { exact: true })
      await failed.waitFor()
      expect(await panel.locator('[title*="Unable to boot device"]').count()).toBe(1)
      await captureDeviceWidths(some.app, page, 'failed')
      // An agent's Xcode device session on the running one.
      await panel.locator('.sim-picker').click()
      await page.getByRole('menuitemradio', { name: /^latch-fake(?!-)/u }).click()
      await panel.getByText('运行中', { exact: true }).waitFor()
      await owner.confirmedJson('tasks', {
        body: {
          requestId: randomUUID(),
          harnessId: 'mcp-agent',
          prompt: `mcp xcode DeviceInteractionStartSession {"deviceIdentifier":"${FAKE_UDID}","sessionIdentifier":"Check"}`,
        },
      })
      await panel.getByText('Agent 正在使用', { exact: true }).waitFor({ timeout: 15_000 })
      await captureDeviceWidths(some.app, page, 'agent-using')
    } finally {
      await some.app.close()
      await some.testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)
})

/** The desktop app on a test Host, at 1440 × 900, connected. */
async function launchDesktop(testHost: Awaited<ReturnType<typeof startTestHost>>, userData: string) {
  const { host } = testHost
  await writeHostState(testHost.dataDir, {
    version: 2,
    pid: process.pid,
    hostId: host.hostId,
    instanceId: host.instanceId,
    socketPath: host.socketPath,
    loopbackOrigin: host.loopbackOrigin,
    tlsOrigin: host.tlsOrigin ?? null,
    startedAt: new Date().toISOString(),
    dataDir: testHost.dataDir,
  })
  const app = await _electron.launch({
    args: [
      resolve('apps/desktop/src/main.cjs'),
      `--latch-host-state=${join(testHost.dataDir, 'host.json')}`,
      `--latch-user-data=${userData}`,
      '--use-mock-keychain',
    ],
    cwd: process.cwd(),
    env: shellEnvironment(),
    timeout: 30_000,
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(30_000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await page.locator('.app-shell[data-connection="connected"]').waitFor()
  return { app, page }
}

/** Saves the window's downloads into `dir` without a save panel; the file names that arrived. */
async function captureDownloads(app: ElectronApplication, dir: string): Promise<() => Promise<string[]>> {
  await app.evaluate(({ BrowserWindow }, folder) => {
    BrowserWindow.getAllWindows()[0]!.webContents.session.on('will-download', (_event, item) => {
      item.setSavePath(`${folder}/${item.getFilename()}`)
    })
  }, dir)
  return async () => (await readdir(dir)).filter(name => !name.endsWith('.crdownload'))
}

/** Opens a new chat session and the 设备 panel beside it. */
async function openDevicePanel(page: Page, testHost: Awaited<ReturnType<typeof startTestHost>>) {
  const { sessionId } = await testHost.host.bridge.createTask({ prompt: '看设备', requestId: randomUUID(), mode: 'chat' })
  await page.locator(`[data-task-id="${sessionId}"]`).click()
  const panes = page.getByRole('group', { name: '工作台面板', exact: true })
  const rightToggle = panes.getByRole('button', { name: '侧边面板', exact: true })
  if ((await rightToggle.getAttribute('aria-pressed')) !== 'true') await rightToggle.click()
  await page.getByRole('button', { name: '打开面板', exact: true }).filter({ visible: true }).click()
  await page.getByRole('menuitem', { name: '设备', exact: true }).click()
  return page.getByRole('region', { name: '设备', exact: true })
}

const TOOLBAR_UDID = 'ABCDEF00-3333-4333-8333-333333333333'
const TOOLBAR_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro'
const TOOLBAR_RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-27-2'

/** Stand-ins for the toolbar: one running device whose picture is Latch's icon, devicectl, and long children. */
function toolbarFakes(booted = true) {
  const calls: string[][] = []
  let orientation = 'portrait'
  const run: SimctlRunner = async args => {
    calls.push([...args])
    const ok = (text = '') => ({ code: 0, stdout: Buffer.from(text), stderr: '' })
    if (args[0] === 'boot') booted = true
    if (args[0] === 'shutdown') booted = false
    if (args[0] === 'list' && args[1] === 'devices')
      return ok(
        JSON.stringify({
          devices: {
            [TOOLBAR_RUNTIME]: [{ udid: TOOLBAR_UDID, name: 'latch-toolbar', state: booted ? 'Booted' : 'Shutdown', isAvailable: true }],
          },
        }),
      )
    if (args[0] === 'list' && args[1] === 'devicetypes')
      return ok(JSON.stringify({ devicetypes: [{ identifier: TOOLBAR_TYPE, name: 'iPhone 18 Pro', productFamily: 'iPhone' }] }))
    if (args[0] === 'list' && args[1] === 'runtimes')
      return ok(
        JSON.stringify({
          runtimes: [
            { identifier: TOOLBAR_RUNTIME, name: 'iOS 27.2', isAvailable: true, supportedDeviceTypes: [{ identifier: TOOLBAR_TYPE }] },
          ],
        }),
      )
    if (args[0] === 'listapps')
      return ok(
        '{ "com.apple.mobilesafari" = { ApplicationType = System; CFBundleDisplayName = Safari; CFBundleExecutable = MobileSafari; IsHidden = 0; }; "com.example.demo" = { ApplicationType = User; CFBundleDisplayName = Demo; CFBundleExecutable = Demo; IsHidden = 0; }; }',
      )
    if (args[0] === 'io') await copyFile(resolve('apps/web/public/icon.png'), args.at(-1)!)
    if (args[0] === 'ui' && args.length === 3) return ok('light\n')
    if (args[0] === 'spawn' && args.includes('KeyboardLastUsed')) return ok('en_US@sw=QWERTY;hw=Automatic\n')
    return ok()
  }
  const devicectl: SimctlRunner = async args => {
    calls.push(['devicectl', ...args])
    if (args[2] === 'rotate') {
      const turns: Record<string, [string, string]> = {
        portrait: ['landscapeLeft', 'landscapeRight'],
        landscapeRight: ['portrait', 'portraitUpsideDown'],
        portraitUpsideDown: ['landscapeRight', 'landscapeLeft'],
        landscapeLeft: ['portraitUpsideDown', 'portrait'],
      }
      orientation = turns[orientation]![args[5] === 'left' ? 0 : 1]
    }
    return { code: 0, stdout: Buffer.from(JSON.stringify({ result: { deviceOrientationNonFlat: orientation } })), stderr: '' }
  }
  const spawn: SimctlSpawner = args => {
    calls.push(['spawn', ...args])
    let exit!: (code: number) => void
    const exited = new Promise<number>(resolve => (exit = resolve))
    const out: Array<(chunk: Buffer) => void> = []
    const err: Array<(chunk: Buffer) => void> = []
    const logs = args.includes('log')
    const timer = logs
      ? setInterval(
          () => out.forEach(listener => listener(Buffer.from('2026-11-17 10:00:00.000 Df SpringBoard[1:2] a line of the log\n'))),
          300,
        )
      : undefined
    if (!logs) setTimeout(() => err.forEach(listener => listener(Buffer.from('Recording started\n'))), 50)
    const child: SimctlChild = {
      onStdout: listener => void out.push(listener),
      onStderr: listener => void err.push(listener),
      interrupt: () => {
        clearInterval(timer)
        if (logs) exit(0)
        else void copyFile(resolve('apps/web/public/icon.png'), args.at(-1)!).then(() => exit(0))
      },
      kill: () => exit(-1),
      exited,
    }
    return child
  }
  return { run, devicectl, spawn, calls, orientation: () => orientation }
}

describe.skipIf(!electronE2E || process.platform !== 'darwin')('native desktop shell: 设备 toolbar', () => {
  it('zooms, rotates, records into the draft, annotates, lists apps, streams logs and opens 新建设备, with stand-ins only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-device-toolbar-'))
    await mkdir(OUT, { recursive: true })
    const fake = toolbarFakes()
    const testHost = await startTestHost({
      demo: true,
      hostName: '验收电脑',
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
      simulators: { run: fake.run, devicectl: fake.devicectl, spawn: fake.spawn, idleMs: 0 },
    })
    let application: ElectronApplication | undefined
    try {
      const { app, page } = await launchDesktop(testHost, join(root, 'electron'))
      const saved = join(root, 'downloads')
      await mkdir(saved)
      const downloads = await captureDownloads(app, saved)
      application = app
      const panel = await openDevicePanel(page, testHost)
      await panel.locator('img.sim-screen').waitFor()
      const tools = panel.getByRole('toolbar', { name: '设备工具', exact: true })
      for (const name of ['向左旋转', '向右旋转', '截图', '录屏', '标注截图', 'App', '日志', '打开地址', '在 Device Hub 中打开'])
        await tools.getByRole('button', { name, exact: true }).waitFor()
      await capture(page, 'toolbar')
      // Zoom: 1:1 and back to fit.
      await panel.getByRole('button', { name: /^缩放：适应/u }).click()
      await expect.poll(() => panel.locator('.sim-canvas').getAttribute('data-zoom')).toBe('1')
      await panel.getByRole('button', { name: /^缩放：100%/u }).click()
      await expect.poll(() => panel.locator('.sim-canvas').getAttribute('data-zoom')).toBe('fit')
      // Rotate, then ⌘→ with focus in the panel.
      await tools.getByRole('button', { name: '向右旋转', exact: true }).click()
      await expect.poll(() => fake.orientation()).toBe('landscapeRight')
      await panel.locator('.sim-canvas').click()
      await page.keyboard.press('Meta+ArrowLeft')
      await expect.poll(() => fake.orientation()).toBe('portrait')
      // ⌘S puts a screenshot into the draft.
      await page.keyboard.press('Meta+s')
      await page
        .locator('.attachment-draft')
        .filter({ hasText: /latch-toolbar-.*\.png/u })
        .first()
        .waitFor()
      // ⇧⌘R starts recording and stops it (⌘R stays the menu's 重新载入): the movie is saved as a download.
      await panel.locator('.sim-canvas').click()
      await page.keyboard.press('Meta+Shift+R')
      await panel.getByText(/^录屏 0:0/u).waitFor()
      await capture(page, 'toolbar-recording')
      await page.keyboard.press('Meta+Shift+R')
      await expect.poll(downloads).toEqual([expect.stringMatching(/^latch-toolbar-.*\.mp4$/u)])
      expect(fake.calls.some(args => args[0] === 'spawn' && args.includes('recordVideo'))).toBe(true)
      // Annotate: draw an arrow and put it in the draft.
      await tools.getByRole('button', { name: '标注截图', exact: true }).click()
      const canvas = panel.getByLabel('在截图上标注')
      await canvas.waitFor()
      const box = (await canvas.boundingBox())!
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 6 })
      await page.mouse.up()
      await capture(page, 'toolbar-annotate')
      await panel.getByRole('button', { name: '放进草稿', exact: true }).click()
      await page
        .locator('.attachment-draft')
        .filter({ hasText: /标注/u })
        .first()
        .waitFor()
      // Apps, then logs.
      await tools.getByRole('button', { name: 'App', exact: true }).click()
      const apps = panel.getByRole('list', { name: '设备上的 App', exact: true })
      await apps.getByText('Safari', { exact: true }).waitFor()
      await apps.getByRole('button', { name: '启动 Safari', exact: true }).click()
      await expect.poll(() => fake.calls.some(args => args[0] === 'launch' && args[2] === 'com.apple.mobilesafari')).toBe(true)
      await capture(page, 'toolbar-apps')
      await tools.getByRole('button', { name: '日志', exact: true }).click()
      await panel
        .getByLabel('设备日志')
        .getByText(/a line of the log/u)
        .first()
        .waitFor()
      await capture(page, 'toolbar-logs')
      // 新建设备 lists what simctl offers.
      await panel.locator('.sim-picker').click()
      await page.getByRole('menuitemradio', { name: '新建设备…' }).click()
      const dialog = page.getByRole('dialog', { name: '新建设备' })
      await dialog.getByRole('textbox', { name: '名字' }).fill('latch-new')
      await dialog.getByText('iPhone 18 Pro').waitFor()
      await capture(page, 'toolbar-new-device')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      expect(fake.calls.some(args => args[0] === 'create')).toBe(false)
      // Every call named the stand-in device or listed.
      expect(fake.calls.every(args => args[0] === 'list' || args.includes(TOOLBAR_UDID))).toBe(true)
    } finally {
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)
})

describe.skipIf(!electronE2E || process.platform !== 'darwin')('native desktop shell: 设备 live picture and input', () => {
  it('decodes the live picture, sends a tap at the correct point, and closes access when the scope is reduced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ld-'))
    await mkdir(OUT, { recursive: true })
    const fake = toolbarFakes(false)
    const idb = fakeIdbCompanion()
    const live = fakeSimulatorLive()
    let allowPicture!: () => void
    const pictureReady = new Promise<void>(resolve => (allowPicture = resolve))
    const testHost = await startTestHost({
      demo: true,
      hostName: '验收电脑',
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
      simulators: {
        run: fake.run,
        devicectl: fake.devicectl,
        spawn: fake.spawn,
        idleMs: 0,
        live: async udid => {
          await pictureReady
          return live.attach(udid)
        },
        idb: { locate: idb.locate, spawn: idb.spawn, tempDir: root },
      },
    })
    let application: ElectronApplication | undefined
    try {
      const { app, page } = await launchDesktop(testHost, join(root, 'electron'))
      application = app
      // The desktop app's page has WebCodecs, and the Host's page policy lets it decode and draw.
      expect(await page.evaluate(() => typeof VideoDecoder)).toBe('function')
      const panel = await openDevicePanel(page, testHost)
      await panel
        .getByRole('list', { name: '设备', exact: true })
        .getByRole('button', { name: /^latch-toolbar/u })
        .click()
      await panel.getByText('未启动', { exact: true }).waitFor()
      await captureDeviceWidths(app, page, 'live-shutdown')
      await panel.getByRole('toolbar', { name: '设备', exact: true }).getByRole('button', { name: '启动', exact: true }).click()
      await panel.getByText('启动中', { exact: true }).waitFor()
      await captureDeviceWidths(app, page, 'live-connecting')
      allowPicture()
      const screen = panel.locator('canvas.sim-live')
      await screen.waitFor()
      // Frames decoded from the recorded H.264 stream reach the canvas.
      await expect.poll(async () => Number(await screen.getAttribute('data-fps')), { timeout: 20_000 }).toBeGreaterThan(0)
      expect(await panel.locator('img.sim-screen').count()).toBe(0)
      await panel.locator('[data-owner="none"]').waitFor()
      const tools = panel.getByRole('toolbar', { name: '设备工具', exact: true })
      // Every tool of the bar is there, the record and logs buttons too.
      for (const name of [
        '向左旋转',
        '向右旋转',
        '截图',
        '录屏',
        '主屏幕',
        '锁屏',
        '键盘输入到设备',
        '标注截图',
        'App',
        '日志',
        '打开地址',
        '在 Device Hub 中打开',
      ])
        await tools.getByRole('button', { name, exact: true }).waitFor()
      await captureDeviceWidths(app, page, 'live')
      // A click at (201, 160) points of the 402 × 874 screen: where the picture is drawn in the canvas (contain, by its
      // own 220 × 480 pixels), scaled.
      const box = await screen.evaluate(element => {
        const canvas = element as HTMLCanvasElement
        const rect = canvas.getBoundingClientRect()
        const scale = Math.min(canvas.clientWidth / canvas.width, canvas.clientHeight / canvas.height)
        const width = canvas.width * scale
        const height = canvas.height * scale
        return {
          left: rect.left + canvas.clientLeft + (canvas.clientWidth - width) / 2,
          top: rect.top + canvas.clientTop + (canvas.clientHeight - height) / 2,
          width,
          height,
        }
      })
      const click = { x: box.left + (box.width * 201) / 402, y: box.top + (box.height * 160) / 874 }
      await page.mouse.click(click.x, click.y)
      await expect.poll(() => idb.events.filter(event => event.kind === 'touch').length).toBe(2)
      await panel.locator('[data-owner="you"]').waitFor()
      const marker = panel.locator('.sim-touch-mark')
      await expect.poll(() => marker.getAttribute('style')).toContain('left:')
      const written = await marker.evaluate(node => {
        const mark = node as HTMLElement
        const stage = mark.parentElement!
        const rect = stage.getBoundingClientRect()
        return {
          x: rect.left + stage.clientLeft - stage.scrollLeft + Number.parseFloat(mark.style.left),
          y: rect.top + stage.clientTop - stage.scrollTop + Number.parseFloat(mark.style.top),
        }
      })
      expect(Math.abs(written.x - click.x)).toBeLessThan(2)
      expect(Math.abs(written.y - click.y)).toBeLessThan(2)
      await marker.waitFor({ state: 'hidden' })
      const [down, up] = idb.events.filter(event => event.kind === 'touch') as Array<{ x: number; y: number; direction: string }>
      expect(down!.direction).toBe('down')
      expect(up!.direction).toBe('up')
      expect(Math.abs(down!.x - 201)).toBeLessThanOrEqual(1.5)
      expect(Math.abs(down!.y - 160)).toBeLessThanOrEqual(1.5)
      expect(idb.events.every(event => event.udid === TOOLBAR_UDID)).toBe(true)
      // Home, and the keyboard toggle: Enter goes to the device as return.
      await tools.getByRole('button', { name: '主屏幕', exact: true }).click()
      await expect.poll(() => idb.events.some(event => event.kind === 'button' && event.button === 1)).toBe(true)
      await tools.getByRole('button', { name: '键盘输入到设备', exact: true }).click()
      // Printable ASCII is typed on the device's English (US) keyboard: Shift+a is A.
      await page.keyboard.press('Shift+A')
      await page.keyboard.press('Enter')
      await expect.poll(() => idb.events.some(event => event.kind === 'key' && event.code === 40)).toBe(true)
      expect(idb.events.filter(event => event.kind === 'key').map(event => (event as { code: number }).code)).toEqual(
        expect.arrayContaining([225, 4]),
      )
      await captureDeviceWidths(app, page, 'live-keyboard')
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 800))
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1100)
      const ownerBounds = (await panel.locator('[data-owner="you"]').boundingBox())!
      expect(ownerBounds.y + ownerBounds.height).toBeLessThan((await screen.boundingBox())!.y)
      for (const name of ['录屏', '日志', '在 Device Hub 中打开'])
        expect(await tools.getByRole('button', { name, exact: true }).isVisible()).toBe(true)
      expect(
        await tools.evaluate(
          toolbar => new Set([...toolbar.querySelectorAll('button')].map(button => button.getBoundingClientRect().top)).size,
        ),
      ).toBe(1)
      expect(idb.starts).toHaveLength(1)
      expect(idb.starts[0]!.args).not.toContain('--grpc-port')
      const desktop = testHost.host.security.devices.list().find(device => device.listener === 'unix')!
      const admin = await testHost.enroll({ listener: 'unix', name: '另一台本机客户端' })
      await admin.confirmedJson('agents', {
        body: { id: 'device-agent', name: '设备验收', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_MCP: 'dsh' } },
      })
      const { sessionId } = await admin.confirmedJson<{ sessionId: string }>('tasks', {
        body: { requestId: randomUUID(), harnessId: 'device-agent', prompt: 'echo hi' },
      })
      await expect.poll(async () => (await testHost.host.bridge.detail(sessionId)).summary.status, { timeout: 15_000 }).toBe('idle')
      const steps = [{ tool: 'device_tap', args: { udid: TOOLBAR_UDID, x: 25, y: 25, holdMs: 5000 } }]
      await admin.json(`tasks/${sessionId}/prompt`, { body: { requestId: randomUUID(), prompt: `browser ${JSON.stringify(steps)}` } })
      await panel.locator('[data-owner="agent"]').waitFor()
      await captureDeviceWidths(app, page, 'live-agent')
      await panel.locator('[data-owner="you"]').waitFor()
      expect((await admin.request(`devices/${desktop.id}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
      await panel.waitFor({ state: 'hidden' })
      await expect.poll(() => live.closed).toBe(live.attached.length)
      await captureDeviceWidths(app, page, 'live-scope-reduced')
    } finally {
      allowPicture()
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
    expect(idb.running()).toBe(0)
    expect(live.closed).toBe(live.attached.length)
  }, 300_000)

  it('shows 输入不可用 with the install command in its hover when idb_companion is not installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ld-'))
    await mkdir(OUT, { recursive: true })
    const fake = toolbarFakes()
    const idb = fakeIdbCompanion({ installed: false })
    const testHost = await startTestHost({
      demo: true,
      hostName: '验收电脑',
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
      simulators: {
        run: fake.run,
        devicectl: fake.devicectl,
        spawn: fake.spawn,
        idleMs: 0,
        live: fakeSimulatorLive().attach,
        idb: { locate: idb.locate, spawn: idb.spawn, tempDir: root },
      },
    })
    let application: ElectronApplication | undefined
    try {
      const { app, page } = await launchDesktop(testHost, join(root, 'electron'))
      application = app
      const panel = await openDevicePanel(page, testHost)
      const screen = panel.locator('canvas.sim-live')
      await expect.poll(async () => Number(await screen.getAttribute('data-fps')), { timeout: 20_000 }).toBeGreaterThan(0)
      await screen.click()
      const state = panel.locator('.ui-status-word', { hasText: '输入不可用' })
      await state.waitFor()
      expect(await state.getAttribute('title')).toContain('brew install meta/fb/idb-companion')
      expect(await panel.locator('.sim-touch-mark').getAttribute('style')).toBeNull()
      await captureDeviceWidths(app, page, 'live-input-unavailable')
      expect(idb.starts).toEqual([])
    } finally {
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)

  it('offers no device controls on a phone-width browser', async () => {
    const fake = toolbarFakes()
    const live = fakeSimulatorLive()
    const testHost = await startTestHost({
      hostName: '验收电脑',
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
      simulators: { run: fake.run, live: live.attach },
    })
    try {
      const browser = await chromium.launch(browserLaunchOptions())
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
        await enrollBrowser(page, testHost, { name: '验收手机', dataScope: 'work' })
        const { sessionId } = await testHost.host.bridge.createTask({ prompt: '看设备', requestId: randomUUID(), mode: 'chat' })
        await openSession(page, sessionId)
        expect(await page.getByRole('region', { name: '设备', exact: true }).count()).toBe(0)
        expect(await page.evaluate(async () => (await fetch('/link/api/simulators', { credentials: 'same-origin' })).status)).toBe(403)
        expect(live.attached).toEqual([])
        await noHorizontalOverflow(page)
        await capture(page, 'live-phone-390')
      } finally {
        await browser.close()
      }
    } finally {
      await testHost.close()
    }
  })
})

/** The booted `latch-` device created and identified by the person running the test. */
async function liveDevice(): Promise<{ udid: string; name: string } | undefined> {
  const name = latchEnv(process.env, 'E2E_LIVE_DEVICE')
  const udid = latchEnv(process.env, 'E2E_LIVE_UDID')
  if (process.platform !== 'darwin' || !name?.startsWith('latch-') || !udid) return undefined
  const listed = await xcrunSimctl(['list', 'devices', '--json', 'available'], { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 })
  if (listed.code !== 0) return undefined
  const all = Object.values(
    (JSON.parse(listed.stdout.toString('utf8')) as { devices: Record<string, Array<{ udid: string; name: string; state: string }>> })
      .devices,
  ).flat()
  const matches = all.filter(item => item.name === name)
  return matches.length === 1 && matches[0]?.udid === udid && matches[0].state === 'Booted' ? matches[0] : undefined
}

const live = electronE2E ? await liveDevice() : undefined

/** A page for the device's Safari on 127.0.0.1 that reports where it was clicked. */
async function clickPage(): Promise<{ server: Server; url: string; clicks: Array<{ x: number; y: number; id: string }>; loads: number[] }> {
  const clicks: Array<{ x: number; y: number; id: string }> = []
  const loads: number[] = []
  const page = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><style>body{margin:0}#tap{height:200px;background:#cde}</style><div id="tap">TAP</div><script>addEventListener('load',()=>navigator.sendBeacon('/r','{"load":1}'));document.addEventListener('click',e=>navigator.sendBeacon('/r',JSON.stringify({x:e.clientX,y:e.clientY,id:e.target.id})))</script>`
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      let body = ''
      req.on('data', chunk => (body += chunk))
      req.on('end', () => {
        const event = JSON.parse(body) as { load?: number; x: number; y: number; id: string }
        if (event.load) loads.push(Date.now())
        else clicks.push(event)
        res.end()
      })
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(page)
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  return { server, url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`, clicks, loads }
}

/**
 * The live picture and input on a real booted `latch-` device (LATCH_E2E_LIVE_DEVICE and LATCH_E2E_LIVE_UDID), with the real latch-simulator and
 * the person's own idb_companion: the page in the device reports the click; a rotation turns the picture and taps still
 * land. Every simctl, devicectl, helper and companion must name that device or only list.
 */
describe.skipIf(!electronE2E || !live)('native desktop shell: 设备 live picture on the latch- device', () => {
  it('shows the real picture, taps where the person clicks, and keeps doing so turned sideways', async () => {
    const target = live!
    const guard = (args: readonly string[], kind: string) => {
      if (!(kind === 'simctl' && args[0] === 'list') && !args.includes(target.udid)) throw new Error(`refused ${kind} ${args[0]}`)
    }
    const run: SimctlRunner = async (args, options) => {
      guard(args, 'simctl')
      const result = await xcrunSimctl(args, options)
      if (result.code !== 0 || args[0] !== 'list' || !args.includes('devices')) return result
      // The test Host and its window see only the simulator that belongs to this run.
      const listed = JSON.parse(result.stdout.toString('utf8')) as { devices: Record<string, Array<{ udid: string }>> }
      for (const [runtime, devices] of Object.entries(listed.devices))
        listed.devices[runtime] = devices.filter(one => one.udid === target.udid)
      return { ...result, stdout: Buffer.from(JSON.stringify(listed)) }
    }
    const devicectl: SimctlRunner = async (args, options) => (guard(args, 'devicectl'), xcrunDevicectl(args, options))
    const page = await clickPage()
    const root = await mkdtemp(join(tmpdir(), 'ld-'))
    await mkdir(OUT, { recursive: true })
    const testHost = await startTestHost({
      demo: true,
      hostName: '验收电脑',
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
      simulators: {
        run,
        devicectl,
        // Recording and logs, so the whole bottom bar is there as the start script gives it.
        spawn: (args, options) => (guard(args, 'simctl'), spawnSimctl(args, options)),
        idleMs: 0,
        live: async udid => {
          guard([udid], 'helper')
          return attachSimulatorHelper(udid)
        },
        idb: {
          tempDir: root,
          spawn: (binary, args, options) => {
            guard(args, 'idb_companion')
            return spawnChild(binary, [...args], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'ignore'] })
          },
        },
      },
    })
    let application: ElectronApplication | undefined
    try {
      const { app, page: window } = await launchDesktop(testHost, join(root, 'electron'))
      application = app
      const panel = await openDevicePanel(window, testHost)
      await panel.locator('.sim-picker').click()
      await window.getByRole('menuitemradio', { name: new RegExp(`^${target.name}`, 'u') }).click()
      const desktop = await testHost.enroll({ listener: 'unix', name: 'Opener' })
      const { orientation } = await desktop.json<{ orientation: string | null }>(`simulators/${target.udid}/orientation`)
      expect(orientation).toBe('portrait')
      await desktop.json(`simulators/${target.udid}/open-url`, { body: { url: page.url } })
      await expect.poll(() => page.loads.length, { timeout: 60_000 }).toBeGreaterThan(0)
      const screen = panel.locator('canvas.sim-live')
      await expect.poll(async () => Number(await screen.getAttribute('data-fps')), { timeout: 30_000 }).toBeGreaterThan(0)
      await new Promise(done => setTimeout(done, 3000))
      // Where content point (x, y) is drawn: the picture's box inside the canvas, scaled by the content's size in points.
      const at = async (x: number, y: number, size: { width: number; height: number }) => {
        const box = await screen.evaluate(element => {
          const canvas = element as HTMLCanvasElement
          const rect = canvas.getBoundingClientRect()
          const scale = Math.min(canvas.clientWidth / canvas.width, canvas.clientHeight / canvas.height)
          return {
            left: rect.left + canvas.clientLeft + (canvas.clientWidth - canvas.width * scale) / 2,
            top: rect.top + canvas.clientTop + (canvas.clientHeight - canvas.height * scale) / 2,
            width: canvas.width * scale,
            height: canvas.height * scale,
          }
        })
        await window.mouse.click(box.left + (box.width * x) / size.width, box.top + (box.height * y) / size.height)
      }
      await at(201, 160, { width: 402, height: 874 })
      await expect.poll(() => page.clicks.length, { timeout: 15_000 }).toBeGreaterThan(0)
      expect(page.clicks[0]).toMatchObject({ id: 'tap' })
      expect(Math.abs(page.clicks[0]!.x - 201)).toBeLessThanOrEqual(3)
      const tools0 = panel.getByRole('toolbar', { name: '设备工具', exact: true })
      for (const name of ['录屏', '日志', '主屏幕', '锁屏', '键盘输入到设备'])
        await tools0.getByRole('button', { name, exact: true }).waitFor()
      await capture(window, 'real-live')
      // Turned: a new description arrives with the content sideways, the canvas turns, and a click still lands.
      const tools = panel.getByRole('toolbar', { name: '设备工具', exact: true })
      await tools.getByRole('button', { name: '向右旋转', exact: true }).click()
      await expect.poll(() => screen.getAttribute('data-orientation'), { timeout: 30_000 }).toMatch(/^[34]$/u)
      await new Promise(done => setTimeout(done, 2000))
      await at(437, 200, { width: 874, height: 402 })
      await expect.poll(() => page.clicks.length, { timeout: 15_000 }).toBeGreaterThan(1)
      expect(page.clicks[1]).toMatchObject({ id: 'tap' })
      await capture(window, 'real-live-turned')
      await tools.getByRole('button', { name: '向左旋转', exact: true }).click()
      await expect.poll(() => screen.getAttribute('data-orientation'), { timeout: 30_000 }).toBe('1')
    } finally {
      await application?.close()
      await testHost.close()
      page.server.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)
})

/**
 * The public commands on the real `latch-` device (pin it with LATCH_E2E_SIMULATOR): rotate, record a few seconds into
 * the draft, list apps, launch Safari, read the logs, grant a permission, annotate; then shut it down. Every simctl,
 * devicectl and long child must name that device or only list.
 */
describe.skipIf(!electronE2E || !device || latchEnv(process.env, 'E2E_SIMULATOR') === undefined)(
  'native desktop shell: 设备 public commands',
  () => {
    it('rotates, records, lists and launches apps, streams logs and grants a permission on the latch- device', async () => {
      const target = device!
      const calls: string[][] = []
      const guard = (args: readonly string[], kind: string) => {
        if (!(kind === 'simctl' && args[0] === 'list') && !args.includes(target.udid)) throw new Error(`refused ${kind} ${args[0]}`)
        calls.push([kind, ...args])
      }
      const run: SimctlRunner = async (args, options) => (guard(args, 'simctl'), xcrunSimctl(args, options))
      const devicectl: SimctlRunner = async (args, options) => (guard(args, 'devicectl'), xcrunDevicectl(args, options))
      // The options carry the recording's bound to the real spawner's watcher.
      const spawn: SimctlSpawner = (args, options) => (guard(args, 'spawn'), spawnSimctl(args, options))
      const root = await mkdtemp(join(tmpdir(), 'latch-electron-device-public-'))
      await mkdir(OUT, { recursive: true })
      const testHost = await startTestHost({
        demo: true,
        hostName: '验收电脑',
        uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
        presenceMode: 'manual',
        simulators: { run, devicectl, spawn, idleMs: 0 },
      })
      let application: ElectronApplication | undefined
      const orientation = async () => {
        const read = await xcrunDevicectl(['device', 'orientation', 'get', '--device', target.udid, '-t', '20', '-j', '-'], {
          timeoutMs: 30_000,
          maxBytes: 65_536,
        })
        return (JSON.parse(read.stdout.toString('utf8')) as { result?: { deviceOrientationNonFlat?: string } }).result
          ?.deviceOrientationNonFlat
      }
      try {
        const { app, page } = await launchDesktop(testHost, join(root, 'electron'))
        const saved = join(root, 'downloads')
        await mkdir(saved)
        const downloads = await captureDownloads(app, saved)
        application = app
        const panel = await openDevicePanel(page, testHost)
        const list = panel.getByRole('list', { name: '设备', exact: true })
        await list.waitFor()
        await list.getByRole('button', { name: new RegExp(`^${target.name}`, 'u') }).click()
        await panel.getByRole('button', { name: '启动', exact: true }).first().click()
        await panel.locator('img.sim-screen').waitFor({ timeout: 180_000 })
        await panel.getByText('运行中', { exact: true }).waitFor()
        // Until the home screen is up (a cold first boot under load can take a while).
        await page.waitForTimeout(60_000)
        await capture(page, 'public-running')
        const tools = panel.getByRole('toolbar', { name: '设备工具', exact: true })
        // Rotate right as soon as devicectl offers it (right after a boot it may not yet), then left, back again.
        const rotate = tools.getByRole('button', { name: '向右旋转', exact: true })
        const rotateLeft = tools.getByRole('button', { name: '向左旋转', exact: true })
        await expect.poll(() => rotate.getAttribute('aria-disabled'), { timeout: 60_000 }).toBeNull()
        await rotate.click()
        await expect.poll(orientation, { timeout: 30_000 }).toBe('landscapeRight')
        await page.waitForTimeout(5_000)
        await capture(page, 'public-rotated')
        await expect.poll(() => rotateLeft.getAttribute('aria-busy'), { timeout: 30_000 }).toBeNull()
        await rotateLeft.click()
        await expect.poll(orientation, { timeout: 30_000 }).toBe('portrait')
        await expect.poll(() => rotateLeft.getAttribute('aria-busy'), { timeout: 30_000 }).toBeNull()
        await rotateLeft.click()
        await expect.poll(orientation, { timeout: 30_000 }).toBe('landscapeLeft')
        await expect.poll(() => rotate.getAttribute('aria-busy'), { timeout: 30_000 }).toBeNull()
        await rotate.click()
        await expect.poll(orientation, { timeout: 30_000 }).toBe('portrait')
        // Three seconds of recording, into the draft.
        await tools.getByRole('button', { name: '录屏', exact: true }).click()
        await panel.getByText(/^录屏 0:0/u).waitFor({ timeout: 30_000 })
        await page.waitForTimeout(3_000)
        await tools.getByRole('button', { name: '停止录屏', exact: true }).click()
        await expect.poll(downloads, { timeout: 60_000 }).toEqual([expect.stringMatching(/\.mp4$/u)])
        const movie = await stat(join(saved, (await downloads())[0]!))
        process.stderr.write(`device recording: ${movie.size} bytes\n`)
        expect(movie.size).toBeGreaterThan(1000)
        // Apps: Safari is listed and launches by its bundle id; then photos for Safari.
        await tools.getByRole('button', { name: 'App', exact: true }).click()
        const apps = panel.getByRole('list', { name: '设备上的 App', exact: true })
        await apps.getByText('Safari', { exact: true }).waitFor({ timeout: 30_000 })
        await apps.getByRole('button', { name: '启动 Safari', exact: true }).click()
        await expect
          .poll(() => calls.some(args => args[1] === 'launch' && args[3] === 'com.apple.mobilesafari'), { timeout: 30_000 })
          .toBe(true)
        await page.waitForTimeout(15_000)
        await capture(page, 'public-apps')
        await apps.getByRole('button', { name: 'Safari：照片权限', exact: true }).click()
        await page.getByRole('menuitem', { name: '允许', exact: true }).click()
        await expect
          .poll(() =>
            calls.some(
              args => args[1] === 'privacy' && args[3] === 'grant' && args[4] === 'photos' && args[5] === 'com.apple.mobilesafari',
            ),
          )
          .toBe(true)
        expect(await panel.getByText('失败', { exact: true }).count()).toBe(0)
        // Logs for a few seconds.
        await tools.getByRole('button', { name: '日志', exact: true }).click()
        const log = panel.getByLabel('设备日志')
        await expect.poll(async () => ((await log.textContent()) ?? '').split('\n').length, { timeout: 30_000 }).toBeGreaterThan(3)
        await page.waitForTimeout(4_000)
        await capture(page, 'public-logs')
        await panel.getByRole('button', { name: '关闭日志', exact: true }).click()
        // Annotate.
        await tools.getByRole('button', { name: '标注截图', exact: true }).click()
        const canvas = panel.getByLabel('在截图上标注')
        await canvas.waitFor({ timeout: 30_000 })
        const box = (await canvas.boundingBox())!
        await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.2)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.35, { steps: 8 })
        await page.mouse.up()
        await panel.getByRole('radio', { name: '方框' }).click()
        await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.65, { steps: 8 })
        await page.mouse.up()
        await capture(page, 'public-annotate')
        await panel.getByRole('button', { name: '放进草稿', exact: true }).click()
        // In the draft, or named in the draft's own refusal: the demo model's session takes no picture this large.
        await canvas.waitFor({ state: 'hidden' })
        await page
          .getByText(/-标注\.(png|jpg)/u)
          .first()
          .waitFor()
        // 新建设备, not created.
        await panel.locator('.sim-picker').click()
        await page.getByRole('menuitemradio', { name: '新建设备…' }).click()
        const dialog = page.getByRole('dialog', { name: '新建设备' })
        await dialog.getByRole('textbox', { name: '名字' }).fill('latch-example')
        await page.waitForTimeout(1_500)
        await capture(page, 'public-new-device')
        await dialog.getByRole('button', { name: '取消', exact: true }).click()
        // The narrow panel.
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 800))
        await page.waitForTimeout(3_000)
        await capture(page, 'public-narrow')
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
        await panel.getByRole('button', { name: '关机', exact: true }).click()
        await list.waitFor({ timeout: 90_000 })
        await panel.getByText('未启动', { exact: true }).waitFor()
        const actions = (await readFile(join(testHost.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map(line => JSON.parse(line) as { action: string; detail: { action?: string } })
          .filter(entry => entry.action === 'simulator.action')
          .map(entry => entry.detail.action)
        expect(actions).toEqual(expect.arrayContaining(['boot', 'rotate', 'record', 'launch', 'privacy', 'logs', 'screenshot', 'shutdown']))
        expect(calls.every(args => (args[0] === 'simctl' && args[1] === 'list') || args.includes(target.udid))).toBe(true)
        process.stderr.write(
          `device public calls: ${JSON.stringify(calls.filter(args => args[1] !== 'list').map(args => args.slice(0, 4)))}\n`,
        )
      } finally {
        await application?.close()
        await testHost.close()
        // Whatever happened above, the device is not left running.
        await xcrunSimctl(['shutdown', target.udid], { timeoutMs: 60_000, maxBytes: 65_536 })
        await rm(root, { recursive: true, force: true })
      }
    }, 900_000)
  },
)
