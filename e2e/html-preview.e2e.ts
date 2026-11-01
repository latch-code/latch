import { _electron, chromium, type ElectronApplication } from '@playwright/test'
import { createSocket } from 'node:dgram'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { writeHostState } from '@latch/host/host-state'
import { latchEnv } from '@latch/host/env'
import { startTestHost } from './helpers/host.ts'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { closeActiveFile, settleShell } from './helpers/layout.ts'

async function beacon() {
  let requests = 0,
    datagrams = 0
  const http = createServer((_req, res) => {
    requests++
    res.end('unexpected')
  })
  const udp = createSocket('udp4')
  udp.on('message', () => {
    datagrams++
  })
  await Promise.all([
    new Promise<void>(done => http.listen(0, '127.0.0.1', done)),
    new Promise<void>(done => udp.bind(0, '127.0.0.1', done)),
  ])
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Missing local address')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    udpPort: udp.address().port,
    requests: () => requests,
    datagrams: () => datagrams,
    close: async () => {
      http.closeAllConnections()
      await Promise.all([new Promise<void>(done => http.close(() => done())), new Promise<void>(done => udp.close(done))])
    },
  }
}
const html = (origin: string) => `<!doctype html><html><head>
<meta http-equiv="refresh" content="0;url=${origin}/refresh"><base href="${origin}/">
<link rel="preconnect" href="${origin}"><style>body{font-family:system-ui;padding:24px}h1{font-size:24px}</style>
</head><body><h1>Local HTML slides</h1><p id="status">Static content</p>
<img src="${origin}/image" onerror="document.getElementById('status').textContent='Event ran'">
<iframe src="${origin}/frame"></iframe><a href="https://example.invalid/document-link">Document link</a>
<script src="${origin}/external.js"></script><script>
document.getElementById('status').textContent='Scripts ran';
try{parent.document.body.dataset.previewEscape='yes'}catch{}
fetch('${origin}/fetch').catch(()=>{});try{new WebSocket('${origin.replace('http:', 'ws:')}/socket')}catch{}
const img=new Image();img.src='${origin}/script-image';document.body.append(img);
fetch('latch://app/link/api/snapshot').then(()=>{document.body.dataset.hostAccess='yes'}).catch(()=>{});
setTimeout(()=>{document.body.dataset.settled='yes'},250);
</script></body></html>`
const deck = `<!doctype html><html><head><style>html,body{margin:0;overflow:hidden;height:100%;background:#000;color:#fff}
#stage{position:absolute;left:50%;top:50%;width:1280px;height:720px}.slide{display:none}.slide.active{display:block}</style></head><body>
<div id="stage"><section class="slide active"><h1>First slide</h1></section><section class="slide"><h1>Second slide</h1></section></div><script>
const all=[...document.querySelectorAll('.slide')];let at=0;
function fit(){const s=Math.min(innerWidth/1280,innerHeight/720);document.getElementById('stage').style.transform='translate(-50%,-50%) scale('+s+')'}
document.addEventListener('DOMContentLoaded',fit);addEventListener('resize',fit);
document.addEventListener('keydown',e=>{if(e.key!=='ArrowRight')return;at=Math.min(all.length-1,at+1);all.forEach((s,i)=>s.classList.toggle('active',i===at))});
</script></body></html>`
async function fixture(origin: string, manual = false) {
  const plugin: HarnessPlugin = {
    id: 'html-fixture',
    name: 'HTML fixture',
    version: '1',
    description: '',
    activate(ctx) {
      ctx.registerProvider({
        id: 'html',
        name: 'Fixture',
        model: 'fixture',
        async *stream() {
          yield { type: 'text', text: '[slides.html](slides.html) [deck.html](deck.html) [hang.html](hang.html)' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
    },
  }
  const host = await startTestHost({ demo: false, plugins: [plugin], ...(manual ? { presenceMode: 'manual' } : {}) })
  await writeFile(join(host.workspaceRoot, 'slides.html'), html(origin))
  await writeFile(join(host.workspaceRoot, 'deck.html'), deck)
  await writeFile(
    join(host.workspaceRoot, 'hang.html'),
    '<!doctype html><html><body><p>Hanging page</p><script>while(1);</script></body></html>',
  )
  const { sessionId } = await host.host.bridge.createTask({
    prompt: 'Preview HTML',
    requestId: randomUUID(),
    mode: 'chat',
    model: { providerId: 'html', model: 'fixture' },
  })
  await expect.poll(async () => (await host.host.bridge.detail(sessionId)).summary.status).toBe('idle')
  return { host, sessionId }
}
describe('opaque HTML previews', () => {
  it('shows static HTML at phone, tablet and desktop widths without executing document scripts or loading resources', async () => {
    const counter = await beacon(),
      { host, sessionId } = await fixture(counter.origin)
    const browser = await chromium.launch(browserLaunchOptions())
    try {
      for (const [width, theme] of [
        [390, 'light'],
        [900, 'dark'],
        [1440, 'light'],
      ] as const) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme })
        const page = await context.newPage()
        page.setDefaultTimeout(15_000)
        try {
          await enrollBrowser(page, host, { name: `HTML ${width}`, scopes: ['admin'] })
          if (width === 900) await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
          await page.locator(`[data-task-id="${sessionId}"]`).first().click()
          await page.getByRole('button', { name: '预览文件：slides.html', exact: true }).click()
          const preview = page.getByRole('region', { name: '文件预览', exact: true })
          const frame = page.frameLocator('iframe[title="文档预览"]')
          await frame.getByRole('heading', { name: 'Local HTML slides' }).waitFor()
          await frame.getByText('Static content', { exact: true }).waitFor()
          // External resources are skipped silently, and a page without a desktop app has no way to run scripts.
          expect(await preview.getByRole('note').count()).toBe(0)
          await preview.getByRole('button', { name: '文件操作', exact: true }).click()
          expect(await page.getByRole('menuitem', { name: /运行页面脚本/u }).count()).toBe(0)
          await page.keyboard.press('Escape')
          expect(await page.evaluate(() => document.body.dataset.previewEscape)).toBeUndefined()
          await settleShell(page)
          await page.evaluate(() => {
            window.open = url => {
              document.body.dataset.openedDocumentLink = String(url)
              return null
            }
          })
          await frame.getByRole('link', { name: 'Document link' }).click()
          await expect
            .poll(() => page.evaluate(() => document.body.dataset.openedDocumentLink))
            .toBe('https://example.invalid/document-link')
          expect(await preview.getByText('文档请求打开：', { exact: false }).count()).toBe(0)
          await preview.getByRole('button', { name: '源码', exact: true }).click()
          await preview.locator('.file-text').waitFor()
          await preview.getByRole('button', { name: '源码', exact: true }).click()
          await frame.getByText('Static content', { exact: true }).waitFor()
          await mkdir('test-results/html', { recursive: true })
          await page.screenshot({ path: `test-results/html/static-${width}-${theme}.png`, animations: 'disabled' })
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        } finally {
          await context.close()
        }
      }
      expect(counter.requests()).toBe(0)
      expect(counter.datagrams()).toBe(0)
    } finally {
      await browser.close()
      await host.close()
      await counter.close()
    }
  })
  it.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')(
    'runs explicitly enabled desktop scripts while blocking network, Host access, navigation and WebRTC UDP',
    async () => {
      const counter = await beacon(),
        { host, sessionId } = await fixture(counter.origin, true)
      const root = await mkdtemp(join(tmpdir(), 'latch-html-electron-'))
      let application: ElectronApplication | undefined
      try {
        const control = await chromium.launch(browserLaunchOptions())
        try {
          const controlPage = await control.newPage()
          await controlPage.evaluate(async port => {
            const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] })
            pc.createDataChannel('control')
            await pc.setLocalDescription(await pc.createOffer())
            await new Promise(done => setTimeout(done, 1500))
            pc.close()
          }, counter.udpPort)
          expect(counter.datagrams()).toBeGreaterThan(0)
        } finally {
          await control.close()
        }
        const controlDatagrams = counter.datagrams()
        await writeHostState(host.dataDir, {
          version: 2,
          pid: process.pid,
          hostId: host.host.hostId,
          instanceId: host.host.instanceId,
          socketPath: host.host.socketPath,
          loopbackOrigin: host.host.loopbackOrigin,
          tlsOrigin: host.host.tlsOrigin ?? null,
          startedAt: new Date().toISOString(),
          dataDir: host.dataDir,
        })
        application = await _electron.launch({
          args: [
            resolve('apps/desktop/src/main.cjs'),
            `--latch-host-state=${join(host.dataDir, 'host.json')}`,
            `--latch-user-data=${join(root, 'electron')}`,
            '--use-mock-keychain',
          ],
          cwd: process.cwd(),
          env: Object.fromEntries(
            Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
        })
        const page = await application.firstWindow()
        page.setDefaultTimeout(20_000)
        await page.getByRole('textbox', { name: '设备名称' }).fill('HTML desktop fixture')
        await page.getByRole('button', { name: '请求连接' }).click()
        await host.presence.waitForRequest(15_000)
        host.presence.approveNext()
        await page.locator('.app-shell[data-connection="connected"]').waitFor()
        await page.locator(`[data-task-id="${sessionId}"]`).first().click()
        await page.getByRole('button', { name: '预览文件：slides.html', exact: true }).click()
        const preview = page.getByRole('region', { name: '文件预览', exact: true })
        await page.frameLocator('iframe').getByText('Static content', { exact: true }).waitFor()
        await settleShell(page)
        await application.evaluate(({ shell, dialog }) => {
          const state = { opened: [] as string[], dialogs: 0 }
          Object.assign(globalThis, { documentLinks: state })
          shell.openExternal = async url => {
            state.opened.push(url)
          }
          dialog.showMessageBox = (async () => {
            state.dialogs++
            return { response: 1, checkboxChecked: false }
          }) as typeof dialog.showMessageBox
        })
        const link = page.frameLocator('iframe').getByRole('link', { name: 'Document link' })
        await link.evaluate(element => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
        const links = () =>
          application!.evaluate(() => (globalThis as unknown as { documentLinks: { opened: string[]; dialogs: number } }).documentLinks)
        expect(await links()).toEqual({ opened: [], dialogs: 0 })
        await link.click()
        await expect.poll(async () => (await links()).opened).toEqual(['https://example.invalid/document-link'])
        expect((await links()).dialogs).toBe(0)
        await page.evaluate(() => window.open('https://example.invalid/programmatic'))
        await expect.poll(async () => (await links()).dialogs).toBe(1)
        expect((await links()).opened).toEqual(['https://example.invalid/document-link'])
        await preview.getByRole('button', { name: '文件操作', exact: true }).click()
        await page.getByRole('menuitem', { name: /运行页面脚本/u }).click()
        await page.frameLocator('iframe').getByText('Scripts ran', { exact: true }).waitFor()
        const frame = page.frames().find(frame => frame.url().startsWith('latch-frame://preview/html-script.html'))!
        await expect.poll(() => frame.evaluate(() => document.body.dataset.settled)).toBe('yes')
        expect(await frame.evaluate(() => document.body.dataset.hostAccess)).toBeUndefined()
        expect(await page.evaluate(() => document.body.dataset.previewEscape)).toBeUndefined()
        // Exercise the platform policy using the original top-level constructor, independently of frame deletion.
        expect(
          await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getWebRTCIPHandlingPolicy()),
        ).toBe('disable_non_proxied_udp')
        await page.evaluate(async port => {
          const pc = new RTCPeerConnection({
            iceServers: [
              { urls: `stun:127.0.0.1:${port}` },
              { urls: `turn:127.0.0.1:${port}?transport=udp`, username: 'fixture', credential: 'fixture' },
            ],
          })
          pc.createDataChannel('fixture')
          await pc.setLocalDescription(await pc.createOffer())
          await new Promise(done => setTimeout(done, 3000))
          pc.close()
        }, counter.udpPort)
        expect(counter.datagrams()).toBe(controlDatagrams)
        expect(counter.requests()).toBe(0)
        await closeActiveFile(page)
        await page.getByRole('button', { name: '预览文件：slides.html', exact: true }).click()
        await page.frameLocator('iframe').getByText('Scripts ran', { exact: true }).waitFor()
        const reopened = page.frames().find(frame => frame.url().startsWith('latch-frame://preview/html-script.html'))!
        await reopened
          .evaluate(origin => {
            location.href = `${origin}/self-navigation`
          }, counter.origin)
          .catch(() => undefined)
        await page.waitForTimeout(400)
        expect(counter.requests()).toBe(0)
        expect(page.url()).toBe('latch://app/link/')
        await mkdir('test-results/html', { recursive: true })
        await page.screenshot({ path: 'test-results/html/desktop-scripts.png', animations: 'disabled' })
        // A deck offers its scripts where it shows, and running them hands it the keyboard.
        await page.getByRole('button', { name: '预览文件：deck.html', exact: true }).click()
        await page.frameLocator('iframe').getByText('First slide', { exact: true }).waitFor()
        await preview.getByRole('button', { name: '运行页面脚本', exact: true }).click()
        await preview.getByText('页面脚本没有运行', { exact: false }).waitFor({ state: 'detached' })
        await page.frameLocator('iframe').getByText('First slide', { exact: true }).waitFor()
        await page.screenshot({ path: 'test-results/html/desktop-deck.png', animations: 'disabled' })
        await page.keyboard.press('ArrowRight')
        await page.frameLocator('iframe').getByText('Second slide', { exact: true }).waitFor()
        // A page that never finishes starting is called stopped, not left looking loaded.
        await page.getByRole('button', { name: '预览文件：hang.html', exact: true }).click()
        await page.frameLocator('iframe').getByText('Hanging page', { exact: true }).waitFor()
        await preview.getByRole('button', { name: '文件操作', exact: true }).click()
        await page.getByRole('menuitem', { name: /运行页面脚本/u }).click()
        await preview.getByText('文档预览已停止', { exact: false }).waitFor({ timeout: 30_000 })
      } finally {
        await application?.close()
        await host.close()
        await counter.close()
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})
