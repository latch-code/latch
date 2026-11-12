import { chromium, type Browser, type BrowserContext, type Frame, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { mkdir } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppSnapshot, PluginPackageBundle, PluginPackageDetail } from '@latch/protocol'
import type { TestDevice } from '@latch/testkit'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const OUTPUT = 'test-results/app-pages'
const PLUGIN = 'frame-check'
const TITLE = '页面检查'

/**
 * A prebuilt page (format 2, one page): it lists sessions, starts one, reads its reply, draws a look-alike approval
 * card, and tries what an opaque frame must not be able to do, writing each outcome where the test reads it.
 */
const PAGE = String.raw`
const { createElement: h, useEffect, useState } = globalThis.__latchModules.react
const { defineApp } = globalThis.__latchModules['@latch/app-sdk']
const attempt = async (name, run) => {
  try {
    const value = await run()
    return name + ':' + (value === undefined || value === null || value === '' ? 'empty' : 'open')
  } catch {
    return name + ':blocked'
  }
}
function Page({ latch, ui }) {
  const [tasks, setTasks] = useState([])
  const [offline, setOffline] = useState(false)
  const [started, setStarted] = useState('')
  const [reply, setReply] = useState('')
  const [probes, setProbes] = useState('')
  const [failure, setFailure] = useState('')
  useEffect(() => latch.tasks.subscribe({}, update => { setTasks(update.tasks); setOffline(update.offline) }), [])
  const start = prompt => latch.tasks.start({ prompt, title: '页面开始的会话' }).then(result => setStarted(result.sessionId), error => setFailure(error.code))
  const read = () => latch.tasks.readReply(started).then(result => setReply(result.reply ? result.reply.text : '(none)'), error => setFailure(error.code))
  const openStarted = () => latch.nav.openSession(started || (tasks.find(task => task.originApp) || {}).id || '').then(() => setFailure('opened'), error => setFailure(error.code))
  const forge = () => {
    // A page can find the runtime's port and send key messages of its own, or dispatch keys no person pressed.
    let port = null
    const original = MessagePort.prototype.postMessage
    MessagePort.prototype.postMessage = function (...args) { port = this; return original.apply(this, args) }
    latch.diag.report('forge')
    MessagePort.prototype.postMessage = original
    for (const key of ['n', 'k', 'f']) {
      const code = 'Key' + key.toUpperCase()
      dispatchEvent(new KeyboardEvent('keydown', { key, code, metaKey: true, ctrlKey: true, bubbles: true }))
      if (port) port.postMessage({ t: 'key', key, code, meta: true, ctrl: true, shift: false, alt: false })
    }
    setFailure(port ? 'forged' : 'no-port')
  }
  const rtc = async () => {
    const names = Object.getOwnPropertyNames(globalThis).filter(name => /RTC|WebTransport|MediaStream/.test(name))
    let peer = 'missing'
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:__UDP__' }, { urls: 'turn:127.0.0.1:__UDP__?transport=udp', username: 'SECRET-DATA', credential: 'x' }] })
      pc.createDataChannel('x')
      await pc.setLocalDescription(await pc.createOffer())
      peer = 'made'
    } catch {
      peer = 'blocked'
    }
    setProbes(['rtc:' + names.join(','), 'peer:' + peer, 'media:' + typeof navigator.mediaDevices, 'connection:' + typeof navigator.connection].join('\n'))
  }
  const probe = async () => {
    const lines = [
      await attempt('fetch', () => fetch('/link/api/snapshot').then(response => response.text())),
      await attempt('cookie', () => document.cookie),
      await attempt('parent', () => parent.document.title),
      await attempt('open', () => window.open('https://example.com/')),
      await attempt('alert', () => { alert('page'); return undefined }),
      await attempt('top', () => { top.location.href = 'https://example.com/'; return 'navigated' }),
      await attempt('fullscreen', () => document.documentElement.requestFullscreen().then(() => 'full')),
      await attempt('storage', () => localStorage.length),
      await attempt('denied', () => latch.storage.list('plugin')),
    ]
    setProbes(lines.join('\n'))
  }
  return h('div', null,
    h('p', { id: 'state' }, offline ? 'offline' : 'online'),
    h('p', { id: 'count' }, String(tasks.length)),
    h('ul', { id: 'tasks' }, tasks.map(task => h('li', { key: task.id, 'data-keys': Object.keys(task).sort().join(',') }, task.title))),
    h(ui.Button, { variant: 'primary', onClick: () => start('页面开始的检查') }, '开始会话'),
    h(ui.Button, { onClick: () => start('生成需要审批的报告') }, '开始需要审批的会话'),
    h(ui.Button, { onClick: read }, '读回复'),
    h(ui.Button, { onClick: probe }, '试探'),
    h(ui.Button, { onClick: rtc }, 'WebRTC'),
    h(ui.Button, { onClick: openStarted }, '打开会话'),
    h(ui.Button, { onClick: forge }, '伪造按键'),
    h('p', { id: 'started' }, started),
    h('p', { id: 'failure' }, failure),
    h('pre', { id: 'reply' }, reply),
    h('pre', { id: 'probes' }, probes),
    h('section', { id: 'fake-approval' }, h('p', null, '等你批准：写入 report.md'), h(ui.Button, { variant: 'primary' }, '允许')),
  )
}
export default defineApp({ page: Page })
`

const pageBundle = (udp: number): PluginPackageBundle => ({
  manifest: {
    formatVersion: 2,
    id: PLUGIN,
    name: '框检查',
    version: '1.0.0',
    description: '检查插件页面的隔离。',
    requires: { appSdk: '^1' },
    apps: [
      {
        id: 'main',
        title: TITLE,
        icon: 'list-checks',
        entry: 'page.js',
        dataVersion: 1,
        capabilities: { 'tasks.read': true, 'tasks.start': { projects: 'any' }, 'tasks.readOwn': true },
      },
    ],
  } as PluginPackageBundle['manifest'],
  files: [{ path: 'page.js', content: PAGE.replaceAll('__UDP__', String(udp)) }],
})

async function install(owner: TestDevice, bundle: PluginPackageBundle): Promise<PluginPackageDetail> {
  const draft = (await owner.json<{ package: PluginPackageDetail }>('plugin-packages', { body: { requestId: randomUUID(), bundle } }))
    .package
  const applied = await owner.confirmed(`plugin-packages/${PLUGIN}/apply`, { body: { requestId: randomUUID(), revision: draft.revision } })
  expect(applied.status).toBe(200)
  return ((await applied.json()) as { package: PluginPackageDetail }).package
}

/** The drawn page's frame (a migration runs in a hidden one first). */
async function pageFrame(page: Page): Promise<Frame> {
  let found: Frame | null = null
  await expect
    .poll(
      async () => {
        const handle = await page
          .locator('iframe.app-frame:not([hidden])')
          .elementHandle({ timeout: 1_000 })
          .catch(() => null)
        found = (await handle?.contentFrame()) ?? null
        return found
          ? await found
              .locator('#count')
              .count()
              .catch(() => 0)
          : 0
      },
      { timeout: 30_000 },
    )
    .toBe(1)
  return found!
}

describe('plugin pages in their opaque frame', () => {
  let host: TestHost
  let browser: Browser
  let owner: TestDevice
  /** A local UDP listener a page's STUN/TURN would reach: it must hear nothing. */
  const udp = createSocket('udp4')
  const packets: number[] = []
  const contexts: BrowserContext[] = []
  /** A browser of its own, enrolled on the Host, at a desktop width unless told otherwise. */
  async function connectedPage(options: Parameters<Browser['newContext']>[0] = { viewport: { width: 1440, height: 960 } }) {
    const context = await browser.newContext(options)
    contexts.push(context)
    const page = await context.newPage()
    await enrollBrowser(page, host)
    return page
  }
  beforeAll(async () => {
    await mkdir(OUTPUT, { recursive: true })
    host = await startTestHost({ hostName: '工作电脑' })
    owner = await host.enroll({ listener: 'unix' })
    udp.on('message', message => packets.push(message.length))
    await new Promise<void>(done => udp.bind(0, '127.0.0.1', done))
    await install(owner, pageBundle(udp.address().port))
    browser = await chromium.launch(browserLaunchOptions())
  })
  afterAll(async () => {
    for (const context of contexts) await context.close()
    udp.close()
    await browser?.close()
    await host?.close()
  })

  it('lists sessions, starts one, reads its reply, and fails every escape from the frame', async () => {
    const page = await connectedPage()
    const dialogs: string[] = []
    page.on('dialog', dialog => {
      dialogs.push(dialog.message())
      void dialog.dismiss()
    })
    const popups: string[] = []
    page.context().on('page', popup => popups.push(popup.url()))
    const shell = page.url()
    // 应用 sits at the sidebar's foot; its pages stand where the sidebar stands.
    await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '应用', exact: true }).click()
    const row = page.locator('.sidebar-apps').getByRole('button', { name: TITLE })
    await row.click()
    const head = page.locator('.app-page-head')
    await expect.poll(() => head.locator('h1').textContent()).toBe(TITLE)
    await expect.poll(() => head.locator('.app-page-plugin').textContent()).toBe('插件 · 框检查 1.0.0')
    const iframe = page.locator('iframe.app-frame')
    expect(await iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(await iframe.getAttribute('allow')).toContain("fullscreen 'none'")
    const frame = await pageFrame(page)
    await page.screenshot({ path: `${OUTPUT}/desktop-ready.png` })

    await frame.getByRole('button', { name: '开始会话', exact: true }).click()
    await expect.poll(() => frame.locator('#started').textContent(), { timeout: 15_000 }).not.toBe('')
    const sessionId = (await frame.locator('#started').textContent())!
    await expect.poll(async () => (await host.host.bridge.detail(sessionId)).summary.status, { timeout: 15_000 }).toBe('idle')
    // The list it is fed is the shell's synced snapshot, with only the whitelisted fields.
    await expect.poll(() => frame.locator('#count').textContent()).toBe('1')
    expect(await frame.locator('#tasks li').first().getAttribute('data-keys')).toMatch(
      /^harnessId,id,originApp,(projectId,)?(projectName,)?(runOutcome,)?running,status,title,updatedAt$/u,
    )
    await frame.getByRole('button', { name: '读回复', exact: true }).click()
    await expect.poll(() => frame.locator('#reply').textContent(), { timeout: 15_000 }).not.toBe('')
    expect(await frame.locator('#reply').textContent()).not.toBe('(none)')

    await frame.getByRole('button', { name: '试探', exact: true }).click()
    await expect.poll(() => frame.locator('#probes').textContent()).not.toBe('')
    const probes = (await frame.locator('#probes').textContent())!.split('\n')
    expect(probes).toEqual([
      'fetch:blocked',
      'cookie:blocked',
      'parent:blocked',
      'open:empty',
      'alert:empty',
      'top:blocked',
      'fullscreen:blocked',
      'storage:blocked',
      // A capability the manifest does not declare never reaches the Host.
      'denied:blocked',
    ])
    expect(dialogs).toEqual([])

    // No WebRTC, media or network information in the frame, and a local STUN/TURN listener hears nothing.
    await frame.getByRole('button', { name: 'WebRTC', exact: true }).click()
    await expect.poll(() => frame.locator('#probes').textContent()).toMatch(/^rtc:/u)
    expect((await frame.locator('#probes').textContent())!.split('\n')).toEqual([
      'rtc:',
      'peer:blocked',
      'media:undefined',
      'connection:undefined',
    ])
    await new Promise(done => setTimeout(done, 1_500))
    expect(packets).toEqual([])

    // Keys the page forges (dispatched, or sent on the runtime's own port) never open 新会话, the palette or find.
    await frame.getByRole('button', { name: '伪造按键', exact: true }).click()
    await expect.poll(() => frame.locator('#failure').textContent()).toBe('forged')
    await new Promise(done => setTimeout(done, 300))
    expect(await page.locator('.app-shell').getAttribute('data-entry')).toBe('apps')
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME')
    expect(await page.locator('dialog[open]').count()).toBe(0)
    expect(popups).toEqual([])
    expect(page.url()).toBe(shell)
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()

    // Back to Code: the session the page started says where it came from, and the shell kept its place.
    await page.locator('.apps-nav-top').getByRole('radio', { name: 'Code', exact: true }).click()
    const started = page.locator(`[data-task-id="${sessionId}"]`)
    await expect.poll(() => started.locator('.session-from').textContent()).toBe(`· 来自 ${TITLE}`)
    await started.click()
    await expect.poll(() => page.locator('.topbar .topbar-handoff').textContent()).toBe(`来自 ${TITLE}`)
  })

  it('keeps the real approval outside the frame, and the frame inert while it shows', async () => {
    const page = await connectedPage()
    await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '应用', exact: true }).click()
    await page.locator('.sidebar-apps').getByRole('button', { name: TITLE }).click()
    const frame = await pageFrame(page)
    expect(await frame.locator('#fake-approval').isVisible()).toBe(true)
    await frame.getByRole('button', { name: '开始需要审批的会话', exact: true }).click()
    const toast = page.locator('.toast').filter({ hasText: '另一个会话等你处理' })
    await toast.waitFor({ timeout: 15_000 })
    const iframe = page.locator('iframe.app-frame')
    await expect.poll(() => iframe.getAttribute('inert')).toBe('')
    await page.screenshot({ path: `${OUTPUT}/desktop-approval.png` })
    // The look-alike card inside the frame takes no input while the real one waits; the real one is reached and decided.
    await toast.getByRole('button', { name: '查看', exact: true }).click()
    const allow = page
      .locator('[data-secure]')
      .getByRole('button', { name: /^允许/u })
      .first()
    await allow.waitFor({ timeout: 15_000 })
    // Back on the page with the approval's card mounted under it: Esc and Cmd/Ctrl keys pressed in the frame reach the
    // shell's shortcuts only, never the approval (whose own Esc refuses).
    await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '应用', exact: true }).click()
    await page.locator('.sidebar-apps').first().getByRole('button', { name: TITLE }).click()
    const again = await pageFrame(page)
    await again.locator('#count').click()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    await new Promise(done => setTimeout(done, 500))
    expect(host.host.bridge.approvals()).toHaveLength(1)
    // The page cannot send the person to a session that waits for them; they go back from the list, and the card arms
    // again from the start there, so a click meant for the page cannot land on 允许.
    await again.getByRole('button', { name: '打开会话', exact: true }).click()
    await expect.poll(() => again.locator('#failure').textContent()).toBe('forbidden')
    expect(await page.locator('.app-shell').getAttribute('data-entry')).toBe('apps')
    await page.evaluate(() => {
      const record = { shown: 0, armed: 0 }
      Reflect.set(globalThis, 'arming', record)
      const tick = () => {
        const card = document.querySelector('.approval-panel')
        if (!record.shown && document.querySelector('.app-shell')?.getAttribute('data-entry') === 'sessions')
          record.shown = performance.now()
        if (record.shown && card && !card.hasAttribute('data-arming')) record.armed = performance.now()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await page.locator('.apps-nav-top').getByRole('radio', { name: 'Code', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (Reflect.get(globalThis, 'arming') as { armed: number }).armed)).toBeGreaterThan(0)
    const arming = (await page.evaluate(() => Reflect.get(globalThis, 'arming'))) as { shown: number; armed: number }
    expect(arming.armed - arming.shown).toBeGreaterThanOrEqual(250)
    await allow.waitFor()
    await allow.click()
    await expect.poll(() => host.host.bridge.approvals().length, { timeout: 15_000 }).toBe(0)
  })

  it('opens from the phone tab bar at 390', async () => {
    const page = await connectedPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    await page.locator('.phone-tabs').getByRole('button', { name: '应用', exact: true }).click()
    await page
      .locator('.apps-list')
      .getByRole('button', { name: new RegExp(TITLE, 'u') })
      .click()
    const frame = await pageFrame(page)
    await expect.poll(() => frame.locator('#state').textContent()).toBe('online')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `${OUTPUT}/phone-ready.png` })
  })

  it("runs the page's migrate once when its data is older, then opens the page on the new data", async () => {
    const migrating = (version: number, content: string): PluginPackageBundle => ({
      manifest: {
        formatVersion: 2,
        id: 'migrator',
        name: '迁移检查',
        version: `${version}.0.0`,
        description: '',
        requires: { appSdk: '^1' },
        apps: [{ id: 'main', title: '迁移', entry: 'page.js', dataVersion: version, capabilities: { storage: ['plugin'] } }],
      } as PluginPackageBundle['manifest'],
      files: [{ path: 'page.js', content }],
    })
    const later = String.raw`
const { createElement: h, useEffect, useState } = globalThis.__latchModules.react
const { defineApp } = globalThis.__latchModules['@latch/app-sdk']
function Page({ latch }) {
  const [value, setValue] = useState('')
  useEffect(() => { latch.storage.get('plugin', 'note').then(doc => setValue(JSON.stringify(doc && doc.value))) }, [])
  return h('p', { id: 'count' }, value)
}
export default defineApp({ page: Page, migrate: (from, docs) => docs.map(doc => ({ ...doc, value: { from, text: doc.value } })) })
`
    const first = (
      await owner.json<{ package: PluginPackageDetail }>('plugin-packages', {
        body: { requestId: randomUUID(), bundle: migrating(1, PAGE) },
      })
    ).package
    const applied = (
      (await (
        await owner.confirmed('plugin-packages/migrator/apply', { body: { requestId: randomUUID(), revision: first.revision } })
      ).json()) as {
        package: PluginPackageDetail
      }
    ).package
    const via = { app: 'migrator/main', revision: applied.appliedRevision! }
    expect(
      (
        await owner.request('apps/migrator/data/plugin/note', {
          method: 'PUT',
          body: { via, requestId: randomUUID(), ifVersion: 0, value: '旧' },
        })
      ).status,
    ).toBe(200)
    const second = (
      await owner.json<{ package: PluginPackageDetail }>('plugin-packages/migrator', {
        method: 'PUT',
        body: { requestId: randomUUID(), baseRevision: applied.revision, bundle: migrating(2, later) },
      })
    ).package
    expect(
      (await owner.confirmed('plugin-packages/migrator/apply', { body: { requestId: randomUUID(), revision: second.revision } })).status,
    ).toBe(200)
    expect((await owner.json<AppSnapshot>('snapshot')).apps?.find(item => item.pluginId === 'migrator')?.status).toBe('needs-migration')
    const page = await connectedPage()
    await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '应用', exact: true }).click()
    await page.locator('.sidebar-apps').first().getByRole('button', { name: '迁移' }).click()
    const frame = await pageFrame(page)
    await expect.poll(() => frame.locator('#count').textContent(), { timeout: 20_000 }).toBe(JSON.stringify({ from: 1, text: '旧' }))
    expect((await owner.json<AppSnapshot>('snapshot')).apps?.find(item => item.pluginId === 'migrator')?.status).toBe('ready')
    expect((await owner.request('plugin-packages/migrator/enabled', { body: { requestId: randomUUID(), enabled: false } })).status).toBe(
      200,
    )
  })

  it('takes the page away everywhere when the plugin is disabled', async () => {
    const page = await connectedPage()
    await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '应用', exact: true }).click()
    await page.locator('.sidebar-apps').getByRole('button', { name: TITLE }).click()
    await pageFrame(page)
    const response = await owner.request(`plugin-packages/${PLUGIN}/enabled`, { body: { requestId: randomUUID(), enabled: false } })
    expect(response.status).toBe(200)
    await expect.poll(async () => (await owner.json<AppSnapshot>('snapshot')).apps?.[0]?.status).toBe('disabled')
    // The entry, the frame, its port and its subscriptions go at once; the shell is back on Code.
    await expect.poll(() => page.locator('.sidebar-apps').count(), { timeout: 15_000 }).toBe(0)
    expect(
      await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '应用', exact: true }).count(),
    ).toBe(0)
    expect(await page.locator('iframe.app-frame').count()).toBe(0)
    expect(await page.locator('.app-shell').getAttribute('data-entry')).toBe('sessions')
  })
})
