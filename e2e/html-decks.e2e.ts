import { chromium, type Browser, type Frame, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { openSession, settleShell } from './helpers/layout.ts'

const slides = (active = ' active') =>
  Array.from({ length: 4 }, (_, index) => `<section class="slide${index === 0 ? active : ''}"><h1>Slide ${index + 1}</h1></section>`).join(
    '',
  )
const keys = `let at=0;const all=[...document.querySelectorAll('.slide')];
function show(n){at=Math.max(0,Math.min(all.length-1,n));all.forEach((s,i)=>s.classList.toggle('active',i===at));document.body.dataset.at=String(at)}
document.addEventListener('keydown',e=>{if(e.key==='ArrowRight')show(at+1);if(e.key==='ArrowLeft')show(at-1)});`
const scaler = (width: number, height: number, transform: string) =>
  `function fit(){const s=Math.min(innerWidth/${width},innerHeight/${height});document.getElementById('stage').style.transform=${transform};document.body.dataset.scale=String(s)}`
const page = (css: string, body: string, script = '', attributes = '') =>
  `<!doctype html><html lang="en"><head><style>html,body{margin:0;background:#0b0d12;color:#eee}.slide{display:none}.slide.active{display:block}${css}</style></head><body ${attributes}>${body}${script && `<script>${script}</script>`}</body></html>`
const clip = 'html,body{overflow:hidden;height:100%}'
const startFirst = `${keys}document.addEventListener('DOMContentLoaded',()=>show(0))`
const words = '<p>Words words words words words words.</p>'.repeat(40)

const decks = {
  // The translate that centres this stage exists only in its script, bound to DOMContentLoaded.
  centred: page(
    `${clip}#stage{position:absolute;left:50%;top:50%;width:1280px;height:720px}`,
    `<div id="stage">${slides()}</div>`,
    `${keys}${scaler(1280, 720, "'translate(-50%,-50%) scale('+s+')'")}document.addEventListener('DOMContentLoaded',fit);addEventListener('resize',fit)`,
  ),
  loaded: page(
    `${clip}#stage{position:absolute;left:0;top:0;width:1920px;height:1080px;transform-origin:0 0}`,
    `<div id="stage">${slides()}</div>`,
    `${keys}${scaler(1920, 1080, "'scale('+s+')'")}addEventListener('load',fit);addEventListener('resize',fit)`,
  ),
  // Its layout hangs off a class on <body>, and it starts from body onload.
  bodyClass: page(
    'body.deck{display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden}#stage{flex:none;width:1920px;height:1080px}',
    `<div id="stage">${slides()}</div>`,
    `${keys}${scaler(1920, 1080, "'scale('+s+')'")}addEventListener('resize',fit)`,
    'class="deck" onload="fit()"',
  ),
  margins: page(
    `${clip}#stage{position:absolute;left:50%;top:50%;width:1280px;height:720px;margin:-360px 0 0 -640px}`,
    `<div id="stage">${slides()}</div>`,
  ),
  viewportUnits: page(`${clip}.slide{width:100vw;height:100vh}h1{font-size:7vw}`, slides(), keys),
  scrollSnap: page(
    'html{scroll-snap-type:y mandatory}.slide,.slide.active{display:block;height:100vh;scroll-snap-align:start}',
    slides(''),
  ),
  // No slide is visible until the script turns the first one on.
  revealedByScript: page(
    `${clip}#stage{position:absolute;left:0;top:0;width:1280px;height:720px}`,
    `<div id="stage">${slides('')}</div>`,
    `${keys}document.addEventListener('DOMContentLoaded',()=>show(0))`,
  ),
  report: `<!doctype html><html><head><style>section{margin:24px}.hero{width:1200px;height:700px}</style></head><body><h1>Report</h1><div class="hero"></div>${'<section>Words words words.</section>'.repeat(30)}</body></html>`,
  // Each hides its slides differently, and each first slide is switched on by a script that does not run here.
  fadedIn: page(
    `${clip}.slide,.slide.active{display:block;position:absolute;inset:0;opacity:0;transition:opacity .4s}.slide.active{opacity:1}`,
    slides(''),
    startFirst,
  ),
  hiddenAndFaded: page(
    `${clip}.slide,.slide.active{display:block;position:absolute;inset:0;visibility:hidden;opacity:0;transition:all .4s}.slide.active{visibility:visible;opacity:1}`,
    slides(''),
    startFirst,
  ),
  movedAway: page(
    `${clip}.slide,.slide.active{display:block;position:absolute;inset:0;transform:translateX(100%)}.slide.active{transform:none}`,
    slides(''),
    startFirst,
  ),
  unknownSwitch: page(`${clip}.slide,.slide.active{display:none}.slide.on{display:block}`, slides('')),
  // Runs what follows only if start-up is seen once, the way a real load would show it.
  checksReadiness: page(
    clip,
    slides(),
    `let runs=0;function init(){runs++;document.body.dataset.runs=String(runs)}document.addEventListener('DOMContentLoaded',init);if(document.readyState!=='loading')init();`,
  ),
  checksReadinessElse: page(
    clip,
    slides(),
    `let runs=0;function init(){runs++;document.body.dataset.runs=String(runs);document.body.dataset.state=document.readyState}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();`,
  ),
  removesBody: page(clip, slides(), `document.body.remove()`),
  slowStart: page(clip, slides(), `const until=Date.now()+300;while(Date.now()<until);document.body.dataset.started='yes'`),
  // Attributes copied across must pass the same filter as any other element's.
  handlers: `<!doctype html><html lang="en" onclick="document.body.dataset.ran='html'"><head><style>body.deck{margin:0}</style></head><body class="deck" onload="document.body.dataset.ran='body'"><h1>Handlers</h1></body></html>`,
  dataOnly: `${page(clip, slides()).replace('</body>', '<script type="application/ld+json">{}</script></body>')}`,
  frameworkDeck: `<!doctype html><html><head><link rel="stylesheet" href="https://cdn.example.invalid/deck.css"><script src="https://cdn.example.invalid/deck.js"></script></head><body><div class="slides"><section>One</section><section>Two</section></div></body></html>`,
  externalReport: `<!doctype html><html><head><link rel="stylesheet" href="https://cdn.example.invalid/site.css"></head><body><h1>Report</h1>${words}</body></html>`,
  // Long documents that happen to hold a block as large as a slide.
  closedDialog: `<!doctype html><html><head><style>body{margin:16px}.modal{position:fixed;left:10%;top:10%;width:800px;height:500px;display:none}</style></head><body><h1>Report</h1>${words}<div class="modal">Dialog</div></body></html>`,
  charts: `<!doctype html><html><head><style>.chart{width:900px;height:500px;margin:8px}</style></head><body><h1>Report</h1><div class="chart"></div><div class="chart"></div>${words}</body></html>`,
  sidewaysClipped: `<!doctype html><html><head><style>html,body{overflow-x:hidden}.hero{width:1200px;height:700px}</style></head><body><h1>Report</h1><div class="hero"></div>${words}</body></html>`,
  carousel: `<!doctype html><html><head><style>.carousel{width:900px;height:500px}.slide{display:none}.slide.active{display:block}</style></head><body><h1>Report</h1><div class="carousel">${slides()}</div>${words}</body></html>`,
  // Slides nothing shows until a script does, in a page that is not clipped.
  hiddenUnclipped: page('', slides(''), keys),
} as const

const parent = `<!doctype html><body style="margin:0"><iframe id="frame" sandbox="allow-scripts" style="display:block;border:0;width:510px;height:710px"></iframe><script>
const query=new URLSearchParams(location.search),nonce='a'.repeat(32),frame=document.getElementById('frame');window.events=[];
addEventListener('message',async event=>{if(event.data?.type!=='ready')return;const data=await (await fetch('/deck/'+query.get('deck'))).arrayBuffer(),channel=new MessageChannel();
window.channel=channel.port1;channel.port1.onmessage=message=>{events.push(message.data);const canvas=message.data.canvas;if(canvas){frame.style.width=canvas.width+'px';frame.style.height=canvas.height+'px'}};
frame.contentWindow.postMessage({type:'init',protocol:1,nonce,kind:query.get('kind'),data,options:{}},'*',[channel.port2,data])});
frame.src='/preview-frame/'+query.get('kind')+'.html#nonce='+nonce</script>`

const stageBox = (frame: Frame) =>
  frame.evaluate(() => {
    const box = document.getElementById('stage')!.getBoundingClientRect()
    return { left: Math.round(box.left), top: Math.round(box.top), right: Math.round(box.right), bottom: Math.round(box.bottom) }
  })

/** The slides a person can see: rendered, opaque and inside the viewport. */
const slidesInView = (frame: Frame) =>
  frame.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.slide')]
      .filter(slide => {
        const style = getComputedStyle(slide),
          box = slide.getBoundingClientRect()
        return (
          box.width > 0
          && box.height > 0
          && style.visibility === 'visible'
          && style.opacity === '1'
          && box.left < innerWidth
          && box.right > 0
          && box.top < innerHeight
          && box.bottom > 0
        )
      })
      .map(slide => slide.textContent),
  )

describe('HTML presentations', () => {
  let host: TestHost, browser: Browser, server: Server, origin: string
  beforeAll(async () => {
    host = await startTestHost({ demo: false })
    const frames = new Map<string, { body: Buffer; csp: string }>()
    for (const name of ['html', 'html-script']) {
      // The frame and its policy exactly as the Host serves them to a desktop app.
      const response = await host.raw('unix', `preview-frame/${name}.html`)
      frames.set(name, { body: Buffer.from(await response.arrayBuffer()), csp: response.headers.get('content-security-policy')! })
    }
    server = createServer((req, res) => {
      const path = new URL(req.url!, 'http://fixture').pathname
      const served = /^\/preview-frame\/(html|html-script)\.html$/u.exec(path)
      if (served) {
        const frame = frames.get(served[1]!)!
        res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': frame.csp }).end(frame.body)
      } else if (path === '/parent') res.writeHead(200, { 'content-type': 'text/html' }).end(parent)
      else res.writeHead(200, { 'content-type': 'text/html' }).end(decks[path.slice('/deck/'.length) as keyof typeof decks])
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing local address')
    origin = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch(browserLaunchOptions())
  })
  afterAll(async () => {
    await browser?.close()
    server?.closeAllConnections()
    await new Promise(done => server?.close(done))
    await host?.close()
  })
  async function open(deck: keyof typeof decks, kind: 'html' | 'html-script'): Promise<{ page: Page; frame: Frame }> {
    const context = await browser.newContext({ viewport: { width: 2000, height: 1200 } })
    const page = await context.newPage()
    await page.goto(`${origin}/parent?deck=${deck}&kind=${kind}`)
    await expect.poll(() => page.evaluate(() => (window as unknown as { events: unknown[] }).events.length)).toBeGreaterThan(1)
    return { page, frame: page.frames().find(frame => frame.url().includes('/preview-frame/'))! }
  }
  const canvasOf = (page: Page) => page.evaluate(() => (window as unknown as { events: Array<{ canvas?: unknown }> }).events.at(-1)?.canvas)

  it('starts a page from its own start-up events and rules on html and body, at the viewport it keeps', async () => {
    for (const [deck, canvas] of [
      ['centred', { width: 1280, height: 720 }],
      ['loaded', { width: 1920, height: 1080 }],
      ['bodyClass', { width: 1920, height: 1080 }],
    ] as const) {
      const { page, frame } = await open(deck, 'html-script')
      await expect.poll(() => canvasOf(page)).toEqual(canvas)
      // Scaled exactly once: the page fits itself to the viewport it was given, which is its own size.
      await expect.poll(() => frame.evaluate(() => document.body.dataset.scale)).toBe('1')
      expect(await stageBox(frame)).toEqual({ left: 0, top: 0, right: canvas.width, bottom: canvas.height })
      await page.locator('#frame').click({ position: { x: 20, y: 20 } })
      await page.keyboard.press('ArrowRight')
      await expect.poll(() => frame.evaluate(() => document.querySelector('.slide.active h1')?.textContent)).toBe('Slide 2')
      await page.context().close()
    }
  })
  it('brings a stage back into view when its placing script does not run, and shows the first slide', async () => {
    for (const deck of ['centred', 'loaded', 'bodyClass', 'revealedByScript', 'margins'] as const) {
      const { page, frame } = await open(deck, 'html')
      const { width, height } = (await canvasOf(page)) as { width: number; height: number }
      await expect.poll(() => stageBox(frame)).toEqual({ left: 0, top: 0, right: width, bottom: height })
      await frame.getByText('Slide 1', { exact: true }).waitFor()
      expect(await frame.evaluate(() => document.querySelectorAll('script').length)).toBe(0)
      await page.context().close()
    }
  })
  it('shows one slide of a static deck however it hides them, and pages through the rest', async () => {
    for (const deck of ['fadedIn', 'hiddenAndFaded', 'movedAway', 'unknownSwitch', 'centred', 'revealedByScript'] as const) {
      const { page, frame } = await open(deck, 'html')
      await expect.poll(() => canvasOf(page), { message: deck }).toBeDefined()
      const pages = () => page.evaluate(() => (window as unknown as { events: Array<{ pages?: unknown }> }).events.at(-1)?.pages)
      await expect.poll(pages, { message: deck }).toEqual({ index: 0, count: 4 })
      expect(await slidesInView(frame), deck).toEqual(['Slide 1'])
      await page.locator('#frame').click({ position: { x: 20, y: 20 } })
      await page.keyboard.press('ArrowRight')
      await expect.poll(pages, { message: deck }).toEqual({ index: 1, count: 4 })
      expect(await slidesInView(frame), deck).toEqual(['Slide 2'])
      await page.evaluate(() => (window as unknown as { channel: MessagePort }).channel.postMessage({ type: 'page', index: 3 }))
      await expect.poll(pages, { message: deck }).toEqual({ index: 3, count: 4 })
      expect(await slidesInView(frame), deck).toEqual(['Slide 4'])
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowLeft')
      await page.keyboard.press('ArrowLeft')
      await expect.poll(pages, { message: deck }).toEqual({ index: 1, count: 4 })
      expect(await slidesInView(frame), deck).toEqual(['Slide 2'])
      await page.context().close()
    }
  })
  it('leaves paging to the page where slides can be scrolled to', async () => {
    const { page, frame } = await open('scrollSnap', 'html')
    await expect.poll(() => canvasOf(page)).toEqual({ width: 1280, height: 720 })
    expect((await slidesInView(frame))[0]).toBe('Slide 1')
    expect(await page.evaluate(() => (window as unknown as { events: Array<{ pages?: unknown }> }).events.at(-1)?.pages)).toBeUndefined()
    await page.context().close()
  })
  it('recognises decks made of viewport units and scroll snap', async () => {
    for (const deck of ['viewportUnits', 'scrollSnap'] as const) {
      const { page } = await open(deck, 'html')
      await expect.poll(() => canvasOf(page)).toEqual({ width: 1280, height: 720 })
      await page.context().close()
    }
  })
  it('shows a page its readiness as a real load would, so a page that also checks it starts once', async () => {
    for (const deck of ['checksReadiness', 'checksReadinessElse'] as const) {
      const { page, frame } = await open(deck, 'html-script')
      await expect.poll(() => frame.evaluate(() => document.body.dataset.runs), { message: deck }).toBe('1')
      await expect.poll(() => frame.evaluate(() => document.readyState)).toBe('complete')
      await page.context().close()
    }
  })
  it('keeps the first report apart from the one that follows the page starting', async () => {
    const { page, frame } = await open('slowStart', 'html-script')
    await expect.poll(() => frame.evaluate(() => document.body.dataset.started)).toBe('yes')
    const reports = () =>
      page.evaluate(() =>
        (window as unknown as { events: Array<{ type: string; settled?: true }> }).events.filter(event => event.type === 'html'),
      )
    await expect.poll(async () => (await reports()).at(-1)?.settled).toBe(true)
    expect((await reports()).filter(report => report.settled).length).toBe(1)
    expect((await reports())[0]?.settled).toBeUndefined()
    await page.context().close()
  })
  it('keeps a running page whose script removes what the frame reads', async () => {
    const { page } = await open('removesBody', 'html-script')
    const events = () => page.evaluate(() => (window as unknown as { events: Array<{ type: string; settled?: true }> }).events)
    await expect.poll(async () => (await events()).at(-1)?.settled).toBe(true)
    expect((await events()).some(event => event.type === 'error')).toBe(false)
    await page.context().close()
  })
  it('keeps html and body attributes without their handlers when scripts are off', async () => {
    const { page, frame } = await open('handlers', 'html')
    await frame.getByRole('heading', { name: 'Handlers' }).waitFor()
    expect(
      await frame.evaluate(() => [
        document.documentElement.getAttribute('lang'),
        document.documentElement.getAttribute('onclick'),
        document.body.className,
        document.body.getAttribute('onload'),
      ]),
    ).toEqual(['en', null, 'deck', null])
    await frame.locator('h1').click()
    await page.waitForTimeout(100)
    expect(await frame.evaluate(() => document.body.dataset.ran)).toBeUndefined()
    await page.context().close()
  })
  it('says only what a page actually lost', async () => {
    const last = (page: Page) =>
      page.evaluate(() => (window as unknown as { events: Array<{ scripts?: true; external?: true; settled?: true }> }).events.at(-1))
    for (const [deck, lost] of [
      ['dataOnly', {}],
      ['margins', {}],
      ['centred', { scripts: true }],
      ['frameworkDeck', { external: true }],
      ['externalReport', {}],
    ] as const) {
      const { page } = await open(deck, 'html')
      await expect.poll(async () => (await last(page))?.settled, { message: deck }).toBe(true)
      const { scripts, external } = (await last(page))!
      expect({ ...(scripts ? { scripts } : {}), ...(external ? { external } : {}) }, deck).toEqual(lost)
      await page.context().close()
    }
  })
  it('recognises a deck whose slides wait for a script, whether or not its root is clipped', async () => {
    const { page, frame } = await open('hiddenUnclipped', 'html')
    await expect.poll(() => canvasOf(page)).toEqual({ width: 1280, height: 720 })
    await frame.getByText('Slide 1', { exact: true }).waitFor()
    await page.context().close()
  })
  it('leaves an ordinary page at the panel width, whatever large blocks it holds', async () => {
    for (const deck of ['report', 'closedDialog', 'charts', 'sidewaysClipped', 'carousel'] as const) {
      const { page, frame } = await open(deck, 'html')
      expect(await canvasOf(page), deck).toBeUndefined()
      expect(await frame.evaluate(() => innerWidth), deck).toBe(510)
      await page.context().close()
    }
  })

  it('fits a deck to the panel at every width, keeps it clickable, and can be put back to the panel width', async () => {
    const plugin: HarnessPlugin = {
      id: 'deck-fixture',
      name: 'Deck fixture',
      version: '1',
      description: '',
      activate(ctx) {
        ctx.registerProvider({
          id: 'deck',
          name: 'Fixture',
          model: 'fixture',
          async *stream() {
            yield { type: 'text', text: '[deck.html](deck.html) [report.html](report.html)' }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const app = await startTestHost({ demo: false, plugins: [plugin] })
    try {
      await writeFile(join(app.workspaceRoot, 'deck.html'), decks.centred)
      await writeFile(join(app.workspaceRoot, 'report.html'), decks.report)
      const { sessionId } = await app.host.bridge.createTask({
        prompt: 'Preview deck',
        requestId: randomUUID(),
        mode: 'chat',
        model: { providerId: 'deck', model: 'fixture' },
      })
      await expect.poll(async () => (await app.host.bridge.detail(sessionId)).summary.status).toBe('idle')
      await mkdir('test-results/html', { recursive: true })
      for (const [width, height, theme] of [
        [390, 844, 'light'],
        [900, 1100, 'dark'],
        [1440, 900, 'light'],
        [1440, 900, 'dark'],
      ] as const) {
        const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme })
        const page = await context.newPage()
        page.setDefaultTimeout(15_000)
        try {
          await enrollBrowser(page, app, { name: `Deck ${width}`, scopes: ['admin'] })
          await openSession(page, sessionId)
          await page.getByRole('button', { name: '预览文件：deck.html', exact: true }).click()
          const preview = page.getByRole('region', { name: '文件预览', exact: true })
          const element = page.locator('iframe[title="文档预览"]')
          await page.frameLocator('iframe[title="文档预览"]').getByText('Slide 1', { exact: true }).waitFor()
          await settleShell(page)
          await page.evaluate(() => Promise.allSettled(document.getAnimations().map(animation => animation.finished)))
          const frame = page.frames().find(item => item.url().includes('/preview-frame/html.html'))!
          await expect.poll(() => frame.evaluate(() => [innerWidth, innerHeight])).toEqual([1280, 720])
          await expect.poll(() => stageBox(frame)).toEqual({ left: 0, top: 0, right: 1280, bottom: 720 })
          const shown = (await element.boundingBox())!,
            panel = (await preview.boundingBox())!
          expect(shown.x).toBeGreaterThanOrEqual(panel.x - 1)
          expect(shown.x + shown.width).toBeLessThanOrEqual(panel.x + panel.width + 1)
          expect(shown.y + shown.height).toBeLessThanOrEqual(panel.y + panel.height + 1)
          expect(shown.width / shown.height).toBeCloseTo(16 / 9, 1)
          // No desktop app here, so the notice says where scripts can run and offers nothing it cannot do.
          await preview.getByText('页面脚本没有运行。', { exact: false }).waitFor()
          expect(await preview.getByRole('button', { name: '运行页面脚本', exact: true }).count()).toBe(0)
          await page.screenshot({ path: `test-results/html/deck-${width}-${theme}.png`, animations: 'disabled' })
          // Every slide can be reached without scripts, on a phone too.
          await expect.poll(() => preview.getByRole('status').filter({ hasText: '1 / 4' }).count()).toBe(1)
          expect(await preview.getByRole('button', { name: '上一页', exact: true }).isDisabled()).toBe(true)
          await preview.getByRole('button', { name: '下一页', exact: true }).click()
          await expect.poll(() => slidesInView(frame)).toEqual(['Slide 2'])
          await preview.getByRole('status').filter({ hasText: '2 / 4' }).waitFor()
          await preview.getByRole('button', { name: '上一页', exact: true }).click()
          await expect.poll(() => slidesInView(frame)).toEqual(['Slide 1'])
          // Clicks land where the scaled picture shows them.
          await frame.evaluate(() => {
            document.addEventListener('click', event => {
              document.body.dataset.clicked = (event.target as Element).tagName
            })
          })
          const inFrame = await frame.evaluate(() => {
            const box = document.querySelector('.slide.active h1')!.getBoundingClientRect()
            return { x: box.x + 200, y: box.y + box.height / 2 }
          })
          const scale = shown.width / 1280
          await page.mouse.click(shown.x + inFrame.x * scale, shown.y + inFrame.y * scale)
          await expect.poll(() => frame.evaluate(() => document.body.dataset.clicked)).toBe('H1')
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
          // The page's shape is only a guess, so it can be taken back.
          await preview.getByRole('button', { name: '文件操作', exact: true }).click()
          await page.getByRole('menuitem', { name: /按桌面尺寸显示/u }).click()
          await expect
            .poll(async () =>
              Math.abs(
                (await page
                  .frames()
                  .find(item => item.url().includes('/preview-frame/html.html'))!
                  .evaluate(() => innerWidth)) - (await element.boundingBox())!.width,
              ),
            )
            .toBeLessThan(2)
          await preview.getByRole('button', { name: '文件操作', exact: true }).click()
          await page.getByRole('menuitem', { name: /按桌面尺寸显示/u }).click()
          await page.frameLocator('iframe[title="文档预览"]').getByText('Slide 1', { exact: true }).waitFor()
          if (width === 1440 && theme === 'light') {
            // The row means nothing over the source, where no page is laid out.
            await preview.getByRole('button', { name: '源码', exact: true }).click()
            await preview.locator('.file-text').waitFor()
            await preview.getByRole('button', { name: '文件操作', exact: true }).click()
            expect(await page.getByRole('menuitem', { name: /按桌面尺寸显示/u }).count()).toBe(0)
            await page.keyboard.press('Escape')
            await preview.getByRole('button', { name: '源码', exact: true }).click()
            await page.frameLocator('iframe[title="文档预览"]').getByText('Slide 1', { exact: true }).waitFor()
            // A person's choice for this file outlives the page.
            await preview.getByRole('button', { name: '文件操作', exact: true }).click()
            await page.getByRole('menuitem', { name: /按桌面尺寸显示/u }).click()
            await page.reload()
            await page.locator('.app-shell[data-connection="connected"]').waitFor()
            await openSession(page, sessionId)
            if ((await page.locator('iframe[title="文档预览"]').count()) === 0)
              await page.getByRole('button', { name: '预览文件：deck.html', exact: true }).click()
            await page.frameLocator('iframe[title="文档预览"]').getByText('Slide 1', { exact: true }).waitFor()
            const panelWidth = () =>
              page
                .frames()
                .find(item => item.url().includes('/preview-frame/html.html'))!
                .evaluate(() => innerWidth)
            await expect.poll(async () => Math.abs((await panelWidth()) - (await element.boundingBox())!.width)).toBeLessThan(2)
            await preview.getByRole('button', { name: '文件操作', exact: true }).click()
            await page.getByRole('menuitem', { name: /按桌面尺寸显示/u }).click()
            await expect.poll(panelWidth).toBe(1280)
            // A rewritten file is read afresh: this one has stopped being a deck, and keeps none of what was said about it.
            await writeFile(join(app.workspaceRoot, 'deck.html'), decks.report)
            await page.frameLocator('iframe[title="文档预览"]').getByRole('heading', { name: 'Report' }).waitFor()
            await preview.getByText('页面脚本没有运行', { exact: false }).waitFor({ state: 'detached' })
            expect(await preview.getByRole('button', { name: '下一页', exact: true }).count()).toBe(0)
            await writeFile(join(app.workspaceRoot, 'deck.html'), decks.centred)
          }
        } finally {
          await context.close()
        }
      }
    } finally {
      await app.close()
    }
  }, 180_000)
})
