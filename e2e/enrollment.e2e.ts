import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createOfflineTicket } from '@latch/host/auth'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const OUTPUT = 'test-results/enrollment'
const UI_DIR = resolve(process.env.HARNESS_E2E_UI_DIR ?? 'dist/web')
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

  it('shows the fingerprint the Host shows, handles a denial, then connects after approval', async () => {
    const testHost = await host({ presenceMode: 'manual' })
    const page = await (await context()).newPage()
    await page.goto(`${testHost.host.loopbackOrigin}/link/`)
    await page.getByRole('heading', { name: '连接到 Latch', exact: true }).waitFor()
    // The first device of a Host is offered 管理此 Host.
    expect(await page.getByRole('checkbox', { name: '管理此 Host（模型服务、插件、项目和设备）' }).isChecked()).toBe(true)
    await page.getByLabel('设备名称', { exact: true }).fill('验收浏览器')
    await captureSizes(page, 'form')

    await page.getByRole('button', { name: '请求本机确认', exact: true }).click()
    const request = await testHost.presence.waitForRequest()
    await page.getByRole('heading', { name: '等待本机确认', exact: true }).waitFor()
    const shown = (await page.locator('.fingerprint span').allTextContents()).join(' ')
    expect(request.preview.lines.find(line => line.label === '设备指纹')?.value).toBe(shown)
    expect(request.preview.lines.find(line => line.label === '设备名称')?.value).toBe('验收浏览器')
    await captureSizes(page, 'waiting')
    testHost.presence.denyNext()
    await page.getByText('本机拒绝了此设备。', { exact: true }).waitFor()
    await captureSizes(page, 'denied')

    await page.getByRole('button', { name: '请求本机确认', exact: true }).click()
    await testHost.presence.waitForRequest()
    testHost.presence.approveNext()
    await connected(page)
    expect(await page.evaluate(() => document.cookie)).toBe('')
    expect(await page.evaluate(() => JSON.stringify(localStorage)).then(text => /ldc1\./.test(text))).toBe(false)
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
    await page.goto(`${testHost.host.loopbackOrigin}/link/`)
    await page.getByRole('heading', { name: '此设备需要在本机重新确认', exact: true }).waitFor()
    await page
      .getByText('Latch 已升级设备凭据，旧的登录状态不再有效。请提交确认请求，并在运行 Latch 的电脑上核对指纹。', { exact: true })
      .waitFor()
    expect(await page.getByLabel('设备名称', { exact: true }).getAttribute('placeholder')).toBe('旧版浏览器')
    await captureSizes(page, 'legacy')
    await page.getByRole('button', { name: '在本机重新确认', exact: true }).click()
    await connected(page)
    expect(await page.locator('.sidebar-footer').getByText('旧版浏览器', { exact: true }).count()).toBe(1)
  })

  it('offers the offline code when local confirmation is unavailable', async () => {
    const testHost = await host({ presenceMode: 'unavailable' })
    const page = await (await context()).newPage()
    await page.goto(`${testHost.host.loopbackOrigin}/link/`)
    await page.getByText(/^本机确认不可用：.*pnpm latch device enroll --offline/).waitFor()
    expect(await page.getByRole('button', { name: '请求本机确认', exact: true }).count()).toBe(0)
    await captureSizes(page, 'unavailable')
    const { code } = await createOfflineTicket(join(testHost.dataDir, 'auth'))
    await page.getByLabel('离线登记码', { exact: true }).fill(code)
    await page.getByRole('button', { name: '使用离线登记码', exact: true }).click()
    await connected(page)
  })

  it('enrolls a phone over HTTPS only with an invitation', async () => {
    const tls = await browserTls()
    cleanups.push(() => rm(tls.directory, { recursive: true, force: true }))
    const testHost = await host({ tls: tls.options })
    const phone = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true })
    const page = await phone.newPage()
    await page.goto(`${testHost.host.tlsOrigin}/link/`)
    await page.getByText(/^手机或其他电脑需要配对邀请。/).waitFor()
    expect(await page.getByLabel('设备名称', { exact: true }).count()).toBe(0)

    const invitation = await testHost.invite()
    await page.goto(invitation.url)
    await page.getByText('已收到配对邀请。提交后，请在运行 Latch 的电脑上核对指纹并确认。', { exact: true }).waitFor()
    // The fragment never stays in the address bar.
    expect(new URL(page.url()).hash).toBe('')
    await page.getByLabel('设备名称', { exact: true }).fill('我的手机')
    await page.getByRole('button', { name: '请求本机确认', exact: true }).click()
    await connected(page)
    const request = testHost.presence.requests.at(-1)!
    expect(request.preview.lines.find(line => line.label === '设备名称')?.value).toBe('我的手机')
  })
})
