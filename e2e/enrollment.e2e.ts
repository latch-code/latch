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
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'
import { openSettings } from './helpers/layout.ts'
import { expectUnmovedByInjectedStyles } from './helpers/security.ts'

const OUTPUT = 'test-results/enrollment'
const ADMIN = '管理此 Host（模型服务、插件、项目和设备）'
/** What the desktop app's 「在这台电脑的浏览器中打开」 lets a browser ask for. */
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

  it('asks a browser on loopback for an invitation, shows the fingerprint the Host shows, handles a denial, then connects', async () => {
    const testHost = await host({ presenceMode: 'manual' })
    const page = await (await context()).newPage()
    // Loopback is not this computer: without an invitation the page only says where to get one.
    await page.goto(`${testHost.host.loopbackOrigin}/link/`)
    await page.getByText(/^这台电脑上的浏览器也需要一次性登记链接。.*在这台电脑的浏览器中打开/).waitFor()
    expect(await page.getByLabel('设备名称', { exact: true }).count()).toBe(0)
    await captureSizes(page, 'invitation')

    await page.goto((await testHost.invite(BROWSER_CEILING, 'loopback-tcp')).url)
    await page.getByText('已收到连接邀请。提交后，回到运行 Latch 的电脑上允许连接。', { exact: true }).waitFor()
    expect(new URL(page.url()).hash).toBe('')
    // An invited browser asks only for what it ticks.
    const admin = page.getByRole('checkbox', { name: ADMIN })
    expect(await admin.isChecked()).toBe(false)
    // What the choice allows from this device, and what stays on the computer running Latch.
    expect(await admin.getAttribute('aria-describedby')).toBeTruthy()
    await page
      .getByText(
        '可以修改模型服务、插件、项目列表和设备。密钥、Agent 的启动设置、新建项目和放宽安全策略仍只能在运行 Latch 的电脑上完成。',
        {
          exact: true,
        },
      )
      .waitFor()
    await page.getByLabel('设备名称', { exact: true }).fill('验收浏览器')
    await captureSizes(page, 'form')

    await page.getByRole('button', { name: '请求本机确认', exact: true }).click()
    const request = await testHost.presence.waitForRequest()
    await page.getByRole('heading', { name: '等待本机确认', exact: true }).waitFor()
    expect(await page.locator('.fingerprint').isVisible()).toBe(false)
    await captureSizes(page, 'waiting-simple')
    await page.getByText('连接详情', { exact: true }).click()
    const shown = (await page.locator('.fingerprint span').allTextContents()).join(' ')
    expect(request.preview.lines.find(line => line.label === '设备指纹')?.value).toBe(shown)
    expect(request.preview.lines.find(line => line.label === '设备名称')?.value).toBe('验收浏览器')
    expect(request.preview.lines.find(line => line.label === '来源地址')?.value).toMatch(/ · 回环端口（也可能是转发进来的连接）$/)
    // The five groups read as three and two, so no group stands alone on a line.
    const tops = await page
      .locator('.fingerprint > span')
      .evaluateAll(spans => spans.map(span => Math.round(span.getBoundingClientRect().top)))
    expect(tops).toEqual([tops[0], tops[0], tops[0], tops[3], tops[3]])
    expect(tops[3]).toBeGreaterThan(tops[0])
    await captureSizes(page, 'waiting')
    testHost.presence.denyNext()
    // The invitation is used up by that request, so the page asks for a new one.
    await page.getByText('本机拒绝了此设备。', { exact: true }).waitFor()
    await page.getByText(/^这台电脑上的浏览器也需要一次性登记链接。/).waitFor()
    await captureSizes(page, 'denied')

    await page.goto((await testHost.invite(BROWSER_CEILING, 'loopback-tcp')).url)
    await page.getByRole('button', { name: '请求本机确认', exact: true }).click()
    await testHost.presence.waitForRequest()
    testHost.presence.approveNext()
    await connected(page)
    expect(await page.evaluate(() => document.cookie)).toBe('')
    expect(await page.evaluate(() => JSON.stringify(localStorage)).then(text => /ldc1\./.test(text))).toBe(false)
  })

  it('keeps the enrollment page as it is under styles added to the page', async () => {
    const testHost = await host({ presenceMode: 'manual' })
    const page = await (await context()).newPage()
    await page.goto((await testHost.invite(undefined, 'loopback-tcp')).url)
    await page.getByRole('heading', { name: '连接到 Latch', exact: true }).waitFor()
    const name = page.getByLabel('设备名称', { exact: true })
    await name.fill('样式核对')
    await name.blur()
    await expectUnmovedByInjectedStyles(page, [
      '.enroll-card',
      '.enroll-header h1',
      '.enroll-description',
      '.enroll-card .ui-field-label',
      '.enroll-card .ui-input',
      '.enroll-scopes legend',
      '.enroll-scope',
      '.enroll-card .ui-check-label',
      '.enroll-card .ui-button',
    ])
    await page.getByRole('button', { name: '请求本机确认', exact: true }).click()
    await testHost.presence.waitForRequest()
    await page.getByRole('heading', { name: '等待本机确认', exact: true }).waitFor()
    // The pointer stays where 请求本机确认 was and may now rest on 取消; the injection moves the page under it, so a hover
    // would change the button's look for a reason that is not the styles.
    await page.mouse.move(0, 0)
    await expectUnmovedByInjectedStyles(page, [
      '.enroll-status h2',
      '.enroll-timer',
      '.enroll-compare',
      '.fingerprint-label',
      '.fingerprint',
      '.fingerprint > span',
      '.enroll-waiting .ui-button',
    ])
    testHost.presence.denyNext()
    await page.getByText('本机拒绝了此设备。', { exact: true }).waitFor()
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
    await page.getByRole('heading', { name: '此设备需要在本机重新确认', exact: true }).waitFor()
    await page.getByText('Latch 已更新连接方式。请在运行 Latch 的电脑上重新允许这台设备。', { exact: true }).waitFor()
    expect(await page.getByLabel('设备名称', { exact: true }).getAttribute('placeholder')).toBe('旧版浏览器')
    await captureSizes(page, 'legacy')
    await page.getByRole('button', { name: '在本机重新确认', exact: true }).click()
    await connected(page)
    // The device keeps its name; this device's name is in 设置 › 设备 (the sidebar names the Host's computer).
    const settings = await openSettings(page, '设备')
    expect(await settings.getByLabel('设备名称', { exact: true }).inputValue()).toBe('旧版浏览器')
  })

  it('keeps an invited browser from submitting while local confirmation is unavailable, and offers it no offline code', async () => {
    const testHost = await host({ presenceMode: 'unavailable' })
    const page = await (await context()).newPage()
    await page.goto((await testHost.invite(undefined, 'loopback-tcp')).url)
    await page.getByText(/^本机确认不可用：.*新设备要在运行 Latch 的电脑上确认后才能登记/).waitFor()
    await page.getByLabel('设备名称', { exact: true }).fill('等待中的浏览器')
    // Offline codes work only in the desktop app; submitting here would only use the invitation up.
    expect(await page.getByLabel('离线登记码', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '使用离线登记码', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '请求本机确认', exact: true }).isDisabled()).toBe(true)
    await page.getByLabel('设备名称', { exact: true }).press('Enter')
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
    const needs = page.getByText(/^手机或其他电脑需要配对邀请：在运行 Latch 的电脑上/)
    await needs.waitFor()
    expect(await needs.textContent()).not.toMatch(/pnpm|--[a-z]/u)
    expect(await page.getByLabel('设备名称', { exact: true }).count()).toBe(0)

    const invitation = await testHost.invite()
    await page.goto(invitation.url)
    await page.getByText('已收到连接邀请。提交后，回到运行 Latch 的电脑上允许连接。', { exact: true }).waitFor()
    // The fragment never stays in the address bar.
    expect(new URL(page.url()).hash).toBe('')
    await page.getByLabel('设备名称', { exact: true }).fill('我的手机')
    await page.getByRole('button', { name: '请求本机确认', exact: true }).click()
    await connected(page)
    const request = testHost.presence.requests.at(-1)!
    expect(request.preview.lines.find(line => line.label === '设备名称')?.value).toBe('我的手机')
  })
})
