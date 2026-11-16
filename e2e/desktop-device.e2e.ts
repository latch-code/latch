// The 设备 panel in the real desktop app with the real `xcrun simctl`, on one simulator whose name starts with `latch-`
// only: every simctl call that names any other device is refused before it runs. Skipped where Xcode or such a device
// is missing. The device is shut down at the end, and Device Hub is never opened.
import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { xcrunSimctl, type SimctlRunner } from '@latch/host/simulators'
import type { McpServerView } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

const electronE2E = latchEnv(process.env, 'ELECTRON_E2E') === '1'
const OUT = 'test-results/desktop-device'

function shellEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

/** A `latch-` simulator that is shut down, or undefined where there is none (or no Xcode). */
async function testDevice(): Promise<{ udid: string; name: string } | undefined> {
  if (process.platform !== 'darwin') return undefined
  const listed = await xcrunSimctl(['list', 'devices', '--json', 'available'], { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 })
  if (listed.code !== 0) return undefined
  const groups = (
    JSON.parse(listed.stdout.toString('utf8')) as { devices: Record<string, Array<{ udid: string; name: string; state: string }>> }
  ).devices
  const all = Object.values(groups).flat()
  const found =
    all.find(device => device.name === 'latch-hands-on' && device.state === 'Shutdown')
    ?? all.find(device => device.name.startsWith('latch-') && device.state === 'Shutdown')
  return found ? { udid: found.udid, name: found.name } : undefined
}

async function capture(page: Page, name: string) {
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: `${OUT}/${name}-dark.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light' })
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
        simulators: { run: fakeSimctl(xcode) },
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
      await capture(none.page, 'no-xcode')
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
      await capture(page, 'failed')
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
      await capture(page, 'agent-using')
    } finally {
      await some.app.close()
      await some.testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)
})
