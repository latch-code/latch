import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DeviceScope } from '@latch/protocol'
import { latchEnv } from '@latch/host/env'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { testDeviceKey } from '@latch/testkit'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'
import { openSettings } from './helpers/layout.ts'
import { expectUnmovedByInjectedStyles } from './helpers/security.ts'

const OUTPUT = 'test-results/enrollment'
/** What `pnpm latch device invite --loopback` lets a browser ask for. */
const BROWSER_CEILING: DeviceScope[] = ['view', 'run', 'approve:standard', 'admin']
const UI_DIR = resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web')
const SIZES = [
  { width: 1440, height: 1000, label: 'desktop' },
  { width: 768, height: 1024, label: 'tablet' },
  { width: 390, height: 844, label: 'phone' },
] as const

/**
 * HTTPS material browsers accept: a P-256 key with the named-curve encoding (Chrome refuses certificates whose
 * EC parameters are spelled out explicitly, which `/usr/bin/openssl` produces unless told otherwise).
 */
async function browserTls(): Promise<{ directory: string; options: NonNullable<TestHostOptions['tls']> }> {
  const directory = await mkdtemp(join(tmpdir(), 'lt-tls-'))
  const certPath = join(directory, 'cert.pem')
  const keyPath = join(directory, 'key.pem')
  await promisify(execFile)(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-pkeyopt',
      'ec_param_enc:named_curve',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-subj',
      '/CN=latch-test.localhost',
      '-addext',
      'subjectAltName=DNS:latch-test.localhost',
    ],
    { env: { PATH: '/usr/bin:/bin' } },
  )
  await chmod(keyPath, 0o600)
  const server = createServer()
  await new Promise<void>(done => {
    server.listen(0, '127.0.0.1', done)
  })
  const port = (server.address() as { port: number }).port
  await new Promise<void>(done => {
    server.close(() => {
      done()
    })
  })
  return {
    directory,
    options: { host: '127.0.0.1', port, certPath, keyPath, publicOrigin: `https://latch-test.localhost:${port}`, allowLocalPeers: true },
  }
}

/** The same state at the three reference widths; screenshots never contain a credential (cookies and keys are not rendered). */
async function captureSizes(page: Page, name: string): Promise<void> {
  const original = page.viewportSize()
  for (const size of SIZES) {
    await page.setViewportSize({ width: size.width, height: size.height })
    await page.evaluate(
      () =>
        new Promise(done => {
          requestAnimationFrame(() => {
            requestAnimationFrame(done)
          })
        }),
    )
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    // The page's buttons are lg (44) on phones and md (32) from 768 up.
    const heights = await page
      .locator('.enroll-form .ui-button, .enroll-waiting .ui-button')
      .evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height))
    for (const height of heights) expect(height).toBe(size.label === 'phone' ? 44 : 32)
    await page.screenshot({ path: `${OUTPUT}/${name}-${size.label}.png`, fullPage: true, animations: 'disabled' })
  }
  if (original) await page.setViewportSize(original)
}

describe('device enrollment in the browser', () => {
  let browser: Browser
  const cleanups: Array<() => Promise<unknown>> = []

  beforeAll(async () => {
    browser = await chromium.launch(browserLaunchOptions())
    await mkdir(OUTPUT, { recursive: true })
  })
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
  })
  afterAll(async () => {
    await browser?.close()
  })

  async function host(options: TestHostOptions = {}): Promise<TestHost> {
    const testHost = await startTestHost({ demo: true, uiDir: UI_DIR, ...options })
    cleanups.push(() => testHost.close())
    return testHost
  }
  async function context(options: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
    const created = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', ...options })
    created.setDefaultTimeout(15_000)
    cleanups.push(() => created.close())
    return created
  }

  it('asks a browser on loopback for a link, keeps its first view to one button, says when the link can manage, handles a denial, then connects', async () => {
    const testHost = await host({ presenceMode: 'manual' })
    const page = await (await context()).newPage()
    // Loopback is not this computer: without an invitation the page only says where to get one.
    await page.goto(`${testHost.host.loopbackOrigin}/link/`)
    await page.getByText(/^这个浏览器还没连接到 Latch。.*在浏览器中打开/).waitFor()
    await page.getByText('pnpm latch device invite --loopback', { exact: true }).waitFor()
    expect(await page.getByRole('button').count()).toBe(0)
    await captureSizes(page, 'invitation')

    await page.goto((await testHost.invite(BROWSER_CEILING, 'loopback-tcp')).url)
    const connect = page.getByRole('button', { name: '连接这个浏览器', exact: true })
    await connect.waitFor()
    expect(new URL(page.url()).hash).toBe('')
    for (const word of ['指纹', '校验码', '剩余', '管理此 Host']) expect(await page.getByText(word).count()).toBe(0)
    expect(await page.getByRole('textbox').count()).toBe(0)
    expect(await page.getByRole('checkbox').count()).toBe(0)
    // Management is said before the press, and turning it down can be taken back.
    const line = page.getByText('这个链接还可以管理这台 Mac', { exact: true })
    await line.waitFor()
    await captureSizes(page, 'form')
    await page.getByRole('button', { name: '不要', exact: true }).click()
    await page.getByText('这个浏览器不会管理这台 Mac', { exact: true }).waitFor()
    expect(await line.count()).toBe(0)
    await captureSizes(page, 'form-declined')
    await page.getByRole('button', { name: '还是要', exact: true }).click()
    await line.waitFor()

    await page.locator('details.connection-details summary').click()
    await page.getByText(/管理这台 Mac（模型服务/).waitFor()
    await page.locator('details.connection-details summary').click()

    await connect.click()
    const request = await testHost.presence.waitForRequest()
    await page.getByRole('heading', { name: '在 Mac 上确认', exact: true }).waitFor()
    expect(await page.getByRole('timer').count()).toBe(0)
    const fingerprint = request.preview.lines.find(line => line.label === '设备指纹')?.value
    expect(fingerprint).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{4}){4}$/)
    // The code is folded; opened, it is the Host's, with the sheet's sentence and what is asked for.
    const code = page.locator('.connection-code')
    expect(await code.isVisible()).toBe(false)
    await page.locator('details.connection-details summary').click()
    expect(await code.getAttribute('aria-label')).toBe(`校验码 ${fingerprint}`)
    expect((await code.textContent())?.replace(/\s+/gu, ' ').trim()).toBe(fingerprint)
    await page.getByText(new RegExp(`连接这台 Mac$`)).first().waitFor()
    await page.getByText(/管理这台 Mac（模型服务/).waitFor()
    expect(request.preview.lines.find(line => line.label === '设备名称')?.value).toMatch(/上的 |^浏览器$/u)
    expect(request.preview.lines.find(line => line.label === '请求的权限')?.value).toContain('管理此 Host')
    expect(request.preview.lines.find(line => line.label === '来源地址')?.value).toMatch(/ · 回环端口（也可能是转发进来的连接）$/)
    await captureSizes(page, 'waiting')
    testHost.presence.denyNext()
    // The invitation is used up by that request, so the page asks for a new one.
    await page.getByText('Mac 上取消了连接。', { exact: true }).waitFor()
    await page.getByText(/^这个浏览器还没连接到 Latch。/).waitFor()
    await captureSizes(page, 'denied')

    await page.goto((await testHost.invite(BROWSER_CEILING, 'loopback-tcp')).url)
    await page.getByRole('button', { name: '连接这个浏览器', exact: true }).click()
    await testHost.presence.waitForRequest()
    testHost.presence.approveNext()
    await connected(page)
    expect(await page.evaluate(() => document.cookie)).toBe('')
    expect(await page.evaluate(() => JSON.stringify(localStorage)).then(text => /ldc1\./.test(text))).toBe(false)
  })

  it('never asks for management a person was not shown: the desktop link, 不要 and a read that failed', async () => {
    const testHost = await host({ presenceMode: 'manual' })
    const scopesAsked = async () =>
      (await testHost.presence.waitForRequest()).preview.lines.find(line => line.label === '请求的权限')?.value
    const open = async (url: string) => {
      const page = await (await context()).newPage()
      await page.goto(url)
      return page
    }

    // The desktop app's link allows no management, so nothing is said and nothing is asked.
    const plain = await open((await testHost.invite(['view', 'run', 'approve:standard'], 'loopback-tcp')).url)
    await plain.getByRole('button', { name: '连接这个浏览器', exact: true }).click()
    expect(await plain.getByText('这个链接还可以管理这台 Mac').count()).toBe(0)
    expect(await scopesAsked()).not.toContain('管理此 Host')
    testHost.presence.denyNext()

    // 不要 is what the Host hears.
    const declined = await open((await testHost.invite(BROWSER_CEILING, 'loopback-tcp')).url)
    await declined.getByRole('button', { name: '不要', exact: true }).click()
    await declined.getByRole('button', { name: '连接这个浏览器', exact: true }).click()
    expect(await scopesAsked()).not.toContain('管理此 Host')
    testHost.presence.denyNext()

    // When the Host's answer is not clear there is no line, so there is no request for management either.
    const unread = await (await context()).newPage()
    await unread.route('**/link/api/enrollment-invitation', route => route.abort())
    await unread.goto((await testHost.invite(BROWSER_CEILING, 'loopback-tcp')).url)
    await unread.getByRole('button', { name: '连接这个浏览器', exact: true }).click()
    expect(await unread.getByText('这个链接还可以管理这台 Mac').count()).toBe(0)
    expect(await scopesAsked()).not.toContain('管理此 Host')
    testHost.presence.denyNext()
  })

  it('says at once that a link no longer works, with nothing to press', async () => {
    const testHost = await host({ presenceMode: 'manual' })
    const spent = await testHost.invite(BROWSER_CEILING, 'loopback-tcp')
    const first = await testHost.raw('loopback-tcp', 'api/enrollments', {
      method: 'POST',
      body: {
        publicKey: testDeviceKey().spki,
        name: '别的设备',
        invitation: new URLSearchParams(new URL(spent.url).hash.slice(1)).get('pair'),
      },
    })
    expect(first.status).toBe(202)
    testHost.presence.denyNext()
    const late = await (await context()).newPage()
    await late.goto(spent.url)
    await late.getByText('这个链接已失效或已用过，请重新获取。', { exact: true }).waitFor()
    await late.getByText(/^这个浏览器还没连接到 Latch。/).waitFor()
    expect(await late.getByRole('button', { name: '连接这个浏览器', exact: true }).count()).toBe(0)
  })

  it('keeps a way to move the desktop window before the shell is there', async () => {
    const testHost = await host({ presenceMode: 'manual' })
    const page = await (await context()).newPage()
    await page.goto(`${testHost.host.loopbackOrigin}/link/`)
    await page.locator('.enroll-page').waitFor()
    const strip = await page.locator('.enroll-page').evaluate(element => {
      const style = getComputedStyle(element, '::before')
      return { region: style.getPropertyValue('-webkit-app-region'), height: style.height, events: style.pointerEvents }
    })
    expect(strip).toEqual({ region: 'drag', height: '52px', events: 'none' })
  })

  it('keeps the enrollment page as it is under styles added to the page', async () => {
    const testHost = await host({ presenceMode: 'manual' })
    const page = await (await context()).newPage()
    await page.goto((await testHost.invite(undefined, 'loopback-tcp')).url)
    await page.getByRole('heading', { name: '连接到 Latch', exact: true }).waitFor()
    await expectUnmovedByInjectedStyles(page, [
      '.enroll-card',
      '.enroll-header h1',
      '.enroll-description',
      '.enroll-card .ui-button',
      '.connection-details summary',
    ])
    await page.getByRole('button', { name: '连接这个浏览器', exact: true }).click()
    await testHost.presence.waitForRequest()
    await page.getByRole('heading', { name: '在 Mac 上确认', exact: true }).waitFor()
    await page.locator('details.connection-details summary').click()
    // The pointer stays where the button was and may now rest on 取消; the injection moves the page under it, so a hover
    // would change the button's look for a reason that is not the styles.
    await page.mouse.move(0, 0)
    await expectUnmovedByInjectedStyles(page, [
      '.enroll-status h2',
      '.enroll-compare',
      '.enroll-waiting .ui-button',
      '.connection-code',
      '.connection-details-row dt',
      '.connection-details-row dd',
      '.connection-code > span',
      '.connection-details-note',
      '.connection-details q',
    ])
    testHost.presence.denyNext()
    await page.getByText('Mac 上取消了连接。', { exact: true }).waitFor()
    await expectUnmovedByInjectedStyles(page, ['.enroll-card .ui-notice', '.enroll-card .ui-notice-text'])
  })

  it('renews an expiring credential without leaving the workspace', async () => {
    let offset = 0
    const testHost = await host({ now: () => Date.now() + offset })
    const page = await (await context()).newPage()
    await enrollBrowser(page, testHost, { name: '续期浏览器' })
    const renewals: number[] = []
    page.on('response', response => {
      if (new URL(response.url()).pathname === '/link/api/credentials/renew') renewals.push(response.status())
    })
    offset = 25 * 60 * 60 * 1000
    await page.reload()
    await connected(page)
    expect(renewals).toEqual([200])
    await page.reload()
    await connected(page)
    expect(renewals).toEqual([200])
  })

  it('asks a browser with a pre-upgrade login to confirm again and keeps its name', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'lt-legacy-'))
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
    const token = randomBytes(32).toString('base64url')
    await mkdir(join(dataDir, 'auth'), { recursive: true, mode: 0o700 })
    const now = new Date().toISOString()
    await writeFile(
      join(dataDir, 'auth', 'devices.json'),
      JSON.stringify({
        version: 1,
        pairings: [],
        devices: [
          {
            id: 'owner-1',
            name: '旧版浏览器',
            role: 'owner',
            createdAt: now,
            lastSeenAt: now,
            revoked: false,
            tokenHash: createHash('sha256').update(token).digest('hex'),
            expiresAt: Date.now() + 86_400_000,
          },
        ],
      }),
      { mode: 0o600 },
    )
    const testHost = await host({ dataDir })
    const browserContext = await context()
    await browserContext.addCookies([
      {
        name: 'harness_link',
        value: token,
        domain: new URL(testHost.host.loopbackOrigin).hostname,
        path: '/link',
        httpOnly: true,
        sameSite: 'Strict',
      },
    ])
    const page = await browserContext.newPage()
    await page.goto((await testHost.invite(undefined, 'loopback-tcp')).url)
    await page.getByRole('heading', { name: '这台设备要在 Mac 上重新确认', exact: true }).waitFor()
    await page.getByText('Latch 更新了连接方式。点下面的按钮，再到 Mac 上允许。', { exact: true }).waitFor()
    await captureSizes(page, 'legacy')
    await page.getByRole('button', { name: '重新确认', exact: true }).click()
    await connected(page)
    // The device keeps its name; this device's name is on the 手机 page (the sidebar names the Host's computer).
    const settings = await openSettings(page, '手机与设备')
    await settings.getByLabel('设备名称', { exact: true }).waitFor()
    expect(await settings.getByLabel('设备名称', { exact: true }).inputValue()).toBe('旧版浏览器')
  })

  it('keeps an invited browser from submitting while local confirmation is unavailable, and offers it no offline code', async () => {
    const testHost = await host({ presenceMode: 'unavailable' })
    const page = await (await context()).newPage()
    await page.goto((await testHost.invite(undefined, 'loopback-tcp')).url)
    await page.getByText(/^Mac 现在不能确认：.*要等它能确认后才能连接/).waitFor()
    // Offline codes work only in the desktop app; submitting here would only use the invitation up.
    expect(await page.getByLabel('离线连接码', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '使用离线连接码', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '连接这个浏览器', exact: true }).isDisabled()).toBe(true)
    // The intro is the invitation's; nothing on the page promises Touch ID.
    expect(await page.getByText(/Touch ID/).count()).toBe(0)
    await captureSizes(page, 'unavailable')
    expect(testHost.host.security.audit.lastOf('device.enroll.requested')).toBeUndefined()
  })

  it('enrolls a phone over HTTPS only with an invitation', async () => {
    const tls = await browserTls()
    cleanups.push(() => rm(tls.directory, { recursive: true, force: true }))
    const testHost = await host({ tls: tls.options })
    const phone = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true })
    const page = await phone.newPage()
    await page.goto(`${testHost.host.tlsOrigin}/link/`)
    // Where to make the invitation, in words: no terminal command for a person holding a phone.
    const needs = page.getByText(/^这台设备还没连接到 Latch。要连接手机，在 Mac 上的 Latch 里/)
    await needs.waitFor()
    expect(await needs.textContent()).not.toMatch(/pnpm|--[a-z]/u)

    const invitation = await testHost.invite(BROWSER_CEILING)
    await page.goto(invitation.url)
    const connect = page.getByRole('button', { name: '连接这个浏览器', exact: true })
    await connect.waitFor()
    // The fragment never stays in the address bar.
    expect(new URL(page.url()).hash).toBe('')
    expect(await page.getByText('这个链接还可以管理这台 Mac').count()).toBe(0)
    await connect.click()
    await connected(page)
    const request = testHost.presence.requests.at(-1)!
    expect(request.preview.lines.find(line => line.label === '设备名称')?.value).toMatch(/上的 |^浏览器$/u)
    // Over HTTPS a device starts without 管理此 Host, whatever its invitation allows.
    expect(request.preview.lines.find(line => line.label === '请求的权限')?.value).not.toContain('管理此 Host')
  })
})
