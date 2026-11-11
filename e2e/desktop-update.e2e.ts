import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { makeTestTls } from '@latch/testkit'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost, type TestHost } from './helpers/host.ts'

const SHOTS = 'test-results/desktop-update'

/** A model whose runs wait until the test lets them finish: a session that runs while the install waits. */
function heldModel() {
  const gates = new Map<string, () => void>()
  const plugin: HarnessPlugin = {
    id: 'update-fixture',
    name: 'Update fixture',
    version: '1',
    description: 'Only an isolated test provider.',
    activate(context) {
      context.registerProvider({
        id: 'update-fixture',
        name: 'Update fixture',
        model: 'fixture',
        async *stream({ messages, signal }) {
          const prompt = messages.findLast(message => message.role === 'user')?.content ?? ''
          yield { type: 'text', text: 'Working' }
          await new Promise<void>(done => {
            gates.set(prompt, done)
            signal.addEventListener('abort', () => done(), { once: true })
          })
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  return {
    plugin,
    release: (prompt: string) => gates.get(prompt)?.(),
    started: (prompt: string) => gates.has(prompt),
  }
}

type AssetMode = 'ok' | 'interrupt' | 'stall'

/** The signed feed on 127.0.0.1 over HTTPS with a test certificate, and the asset it names, as the test sets them. */
async function fakeFeed(directory: string) {
  const tls = await makeTestTls(join(directory, 'tls'))
  const keys = generateKeyPairSync('ed25519')
  const asset = randomBytes(512 * 1024)
  const sha512 = createHash('sha512').update(asset).digest('hex')
  let feed = ''
  let mode: AssetMode = 'ok'
  let unstall: (() => void) | undefined
  const requests: string[] = []
  const server: Server = createServer({ cert: await readFile(tls.certPath), key: await readFile(tls.keyPath) }, (request, response) => {
    requests.push(request.url ?? '')
    if (request.url === '/latch/feed.json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(feed)
      return
    }
    if (request.url === '/latch/Latch-0.2.0.zip') {
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(asset.length) })
      const half = asset.subarray(0, asset.length / 2)
      if (mode === 'ok') response.end(asset)
      else if (mode === 'interrupt') response.write(half, () => response.socket?.destroy())
      else
        response.write(half, () => {
          unstall = () => response.end(asset.subarray(asset.length / 2))
        })
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
  const publish = (version: string, hash = sha512) => {
    const payload = Buffer.from(
      JSON.stringify({
        version,
        notes: { 'zh-CN': '更快的启动与更稳的重连。', en: 'Faster start and steadier reconnects.' },
        minHostProtocol: 1,
        host: { version, protocol: 1 },
        pluginApi: { formats: [1] },
        assets: [
          { platform: process.platform, arch: process.arch, url: `${origin}/latch/Latch-0.2.0.zip`, sha512: hash, size: asset.length },
        ],
        publishedAt: '2026-11-12T00:00:00.000Z',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    )
    feed = JSON.stringify({ payload: payload.toString('base64'), sig: sign(null, payload, keys.privateKey).toString('base64') })
  }
  return {
    feedUrl: `${origin}/latch/feed.json`,
    publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    ca: tls.ca,
    sha512,
    requests,
    publish,
    setMode(next: AssetMode) {
      mode = next
    },
    stalled: () => unstall !== undefined,
    unstall() {
      unstall?.()
      unstall = undefined
    },
    close: () =>
      new Promise<void>(done => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
}

/**
 * The bootstrap gives the product updater a feed of its own (this test's, trusted through the test certificate) and a
 * fake installer that records what it was handed; main, the preload, the gate and the Host stay real.
 */
async function updateBootstrap(directory: string, feed: { feedUrl: string; publicKey: string; ca: string }): Promise<string> {
  const path = join(directory, 'update-main.cjs')
  await writeFile(
    path,
    `
'use strict'
const https = require('node:https'), { createHash } = require('node:crypto'), { readFileSync } = require('node:fs')
const updater = require(${JSON.stringify(resolve('apps/desktop/src/updater.cjs'))})
const fixture = globalThis.updateFixture = { installs: [] }
const ca = ${JSON.stringify(feed.ca)}
const get = (url, options = {}) => new Promise((done, fail) => {
  const req = https.request(url, { ca, checkServerIdentity: () => undefined, signal: options.signal }, res => done({ status: res.statusCode, body: res }))
  req.once('error', fail)
  req.end()
})
const createFeedSource = updater.createFeedSource
updater.configuration = () => ({ feedUrl: ${JSON.stringify(feed.feedUrl)}, publicKey: ${JSON.stringify(feed.publicKey)}, signed: true })
updater.unsupportedReason = () => undefined
updater.createFeedSource = options => createFeedSource({ ...options, get })
updater.createElectronInstaller = () => ({
  async install({ file, plan, version }) {
    fixture.installs.push({ plan, version, sha512: createHash('sha512').update(readFileSync(file)).digest('hex') })
  },
})
require(${JSON.stringify(resolve('apps/desktop/src/main.cjs'))})
`,
    { mode: 0o600 },
  )
  return path
}

interface Install {
  plan: string
  version: string
  sha512: string
}

async function updateState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    const shell = Reflect.get(globalThis, 'latchShell') as { updates: { get(): Promise<Record<string, unknown>> } }
    return shell.updates.get()
  })
}

async function waitForState(page: Page, state: string) {
  await vi.waitFor(async () => expect((await updateState(page)).state).toBe(state), { timeout: 15_000, interval: 100 })
}

describe.skipIf(process.platform !== 'darwin' || latchEnv(process.env, 'ELECTRON_E2E') !== '1')('desktop updates', () => {
  it('checks a signed feed, refuses a bad file, recovers an interrupted download and installs once sessions settle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latch-electron-update-'))
    const model = heldModel()
    const feed = await fakeFeed(directory)
    const testHost = await startTestHost({ plugins: [model.plugin], providerId: 'update-fixture' })
    const userData = join(directory, 'electron')
    let application: ElectronApplication | undefined
    try {
      const host = testHost.host
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
      const environment = Object.fromEntries(
        Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
      )
      application = await _electron.launch({
        args: [
          await updateBootstrap(directory, feed),
          '--latch-host-state=' + join(testHost.dataDir, 'host.json'),
          '--latch-user-data=' + userData,
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: environment,
        timeout: 30_000,
      })
      const app = application
      const page = await app.firstWindow()
      page.setDefaultTimeout(20_000)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900))
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      await mkdir(SHOTS, { recursive: true })

      const about = page.locator('.settings-page')
      /** Settings › 关于 in one look, through main's own 「检查更新…」 message (without starting a check). */
      async function show(theme: 'light' | 'dark') {
        await page.evaluate(look => {
          const key = 'latch.preferences'
          const saved = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>
          localStorage.setItem(key, JSON.stringify({ ...saved, theme: look }))
        }, theme)
        await page.reload()
        await page.locator('.app-shell[data-connection="connected"]').waitFor()
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('latch:updates:show'))
        await about.locator('.about-updates').waitFor()
        await page.evaluate(() => document.fonts.ready)
      }
      async function shots(name: string) {
        for (const theme of ['light', 'dark'] as const) {
          await show(theme)
          await page.screenshot({ path: join(SHOTS, `about-${name}--${theme}--1440.png`) })
        }
        await show('light')
      }

      // 「检查更新…」 is in the app menu.
      const menuLabel = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('check-for-updates')?.label ?? null)
      await vi.waitFor(async () => expect(await menuLabel()).toBe('检查更新…'))

      // No update: the feed names this version. 「检查更新…」 checks and opens 关于.
      feed.publish('0.1.0')
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('check-for-updates')?.click())
      await about.locator('.about-head').waitFor()
      await waitForState(page, 'up-to-date')
      await about.getByText('已是最新版本', { exact: true }).waitFor()
      await about.getByText('Latch 应用', { exact: true }).waitFor()
      await about.getByText('这台 Mac 上的 Host', { exact: true }).waitFor()
      await shots('up-to-date')

      // A file whose hash does not match the signed one is refused and removed.
      feed.publish('0.2.0', 'f'.repeat(128))
      await about.getByRole('button', { name: '检查更新', exact: true }).click()
      await waitForState(page, 'failed')
      expect((await updateState(page)).failure).toEqual({ stage: 'verify', code: 'hash-mismatch' })
      expect(await readdir(join(userData, 'updates'))).toEqual([])
      await shots('failed-verify')

      // With automatic downloads off, a check offers the download and its notes.
      await about.getByRole('switch', { name: '自动下载更新' }).click()
      await vi.waitFor(async () =>
        expect(JSON.parse(await readFile(join(userData, 'updates.json'), 'utf8'))).toEqual({ version: 1, autoDownload: false }),
      )
      feed.publish('0.2.0')
      await about.getByRole('button', { name: '重试', exact: true }).click()
      await waitForState(page, 'available')
      await about.getByText('更快的启动与更稳的重连。', { exact: true }).waitFor()
      await shots('available')

      // An interrupted download fails without touching this version, and a retry starts again.
      feed.setMode('interrupt')
      await about.getByRole('button', { name: '下载', exact: true }).click()
      await waitForState(page, 'failed')
      expect((await updateState(page)).failure).toEqual({ stage: 'download', code: 'interrupted' })
      expect(await readdir(join(userData, 'updates'))).toEqual([])
      await shots('failed-download')

      feed.setMode('stall')
      await about.getByRole('button', { name: '重试', exact: true }).click()
      await vi.waitFor(() => expect(feed.stalled()).toBe(true))
      await waitForState(page, 'downloading')
      await shots('downloading')
      feed.unstall()
      await waitForState(page, 'ready')
      await shots('ready')

      // The page never learns where the update comes from or where it is kept.
      const visible = JSON.stringify(await updateState(page))
      expect(visible).not.toContain('127.0.0.1')
      expect(visible).not.toContain(userData)
      expect(visible).not.toContain('.zip')

      // Installing while a session runs: the Host enters its install window, new starts are refused, and the install
      // waits; cancelling leaves the window, and installing again goes on once the session has finished.
      const prompt = `Keep running ${randomUUID()}`
      const running = await host.bridge.createTask({
        prompt,
        requestId: randomUUID(),
        mode: 'chat',
        model: { providerId: 'update-fixture', model: 'fixture' },
      })
      await vi.waitFor(() => expect(model.started(prompt)).toBe(true))
      await about.getByRole('button', { name: '重启并安装', exact: true }).click()
      await waitForState(page, 'waiting')
      await about.getByText('等 1 项结束', { exact: true }).waitFor()
      const other = await testHost.enroll({ listener: 'unix', name: 'Other' })
      const refused = await other.request('tasks', { method: 'POST', body: { prompt: 'New', requestId: randomUUID(), mode: 'chat' } })
      expect(refused.status).toBe(409)
      expect(await refused.json()).toMatchObject({ error: 'host-updating' })
      await shots('waiting')
      await about.getByRole('button', { name: '取消', exact: true }).click()
      await waitForState(page, 'ready')
      const allowed = await other.request('tasks', { method: 'POST', body: { prompt: 'Allowed', requestId: randomUUID(), mode: 'chat' } })
      expect(allowed.status).toBe(201)
      const allowedId = ((await allowed.json()) as { sessionId: string }).sessionId
      await vi.waitFor(() => expect(model.started('Allowed')).toBe(true))
      model.release('Allowed')
      await vi.waitFor(async () => expect((await host.bridge.summary(allowedId)).status).toBe('idle'), { timeout: 15_000 })

      await about.getByRole('button', { name: '重启并安装', exact: true }).click()
      await waitForState(page, 'waiting')
      await about.getByRole('button', { name: '查看会话', exact: true }).click()
      await about
        .locator('.settings-row', { hasText: prompt.slice(0, 12) })
        .first()
        .waitFor()
      expect(await app.evaluate(() => (Reflect.get(globalThis, 'updateFixture') as { installs: Install[] }).installs)).toEqual([])
      model.release(prompt)
      await vi.waitFor(async () => expect((await host.bridge.summary(running.sessionId)).status).toBe('idle'), { timeout: 15_000 })
      await waitForState(page, 'installing')
      const installs = await app.evaluate(() => (Reflect.get(globalThis, 'updateFixture') as { installs: Install[] }).installs)
      expect(installs).toEqual([{ plan: 'host', version: '0.2.0', sha512: feed.sha512 }])

      const audit = (await readFile(join(testHost.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { action: string; detail: Record<string, unknown> })
        .filter(record => record.action === 'host.update-window')
        .map(record => record.detail)
      expect(audit).toEqual([
        { state: 'entered', busy: 1, planned: true },
        { state: 'left', reason: 'cancelled', busy: 1 },
        { state: 'entered', busy: 1, planned: true },
        { state: 'committed', busy: 0 },
      ])
      // One request per check and per download: three checks, three downloads (refused, interrupted, completed).
      expect(feed.requests.filter(url => url.endsWith('feed.json'))).toHaveLength(3)
      expect(feed.requests.filter(url => url.endsWith('.zip'))).toHaveLength(3)
    } finally {
      try {
        await application?.close()
      } finally {
        try {
          await testHost.close()
        } finally {
          await feed.close()
          await rm(directory, { recursive: true, force: true })
        }
      }
    }
  })
})
