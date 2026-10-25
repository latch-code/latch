import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readPreviewFrame } from '../src/preview-frames.ts'
import { startTestHost } from './helpers/host.ts'

const clean: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of clean.splice(0).reverse()) await close()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'latch-frame-'))
  clean.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'preview-frame'))
  await mkdir(join(root, 'assets'))
  const script = 'parent.postMessage({type:"fixture"},"*")'
  const hash = `sha256-${createHash('sha256').update(script).digest('base64')}`
  const html = `<!doctype html><html><body><script>${script}</script></body></html>`
  await writeFile(join(root, 'preview-frame/office.html'), html)
  await writeFile(join(root, 'preview-frame/office.json'), JSON.stringify({ file: 'office.html', scriptHash: hash }))
  for (const name of ['html', 'html-script']) {
    await writeFile(join(root, `preview-frame/${name}.html`), html)
    await writeFile(join(root, `preview-frame/${name}.json`), JSON.stringify({ file: `${name}.html`, scriptHash: hash }))
  }
  await writeFile(join(root, 'assets/csv.worker-abcdefgh.js'), 'postMessage(1)')
  return { root, html, hash }
}
describe('document frame static boundary', () => {
  it('binds the final bootstrap bytes to one digest and rejects altered scripts and unknown renderers', async () => {
    const { root, html, hash } = await fixture()
    expect(await readPreviewFrame(root, 'office')).toMatchObject({ data: Buffer.from(html), hash })
    await expect(readPreviewFrame(root, '../index')).rejects.toMatchObject({ code: 'preview-unavailable' })
    await writeFile(join(root, 'preview-frame/office.html'), html.replace('fixture', 'changed'))
    await expect(readPreviewFrame(root, 'office')).rejects.toMatchObject({ code: 'preview-unavailable' })
  })
  it('serves public bootstrap HTML with its own CSP, closes manifest routes and removes network from workers', async () => {
    const { root, hash } = await fixture()
    const host = await startTestHost({ uiDir: root })
    clean.push(() => host.close())
    const frame = await host.raw('unix', 'preview-frame/office.html')
    expect(frame.status).toBe(200)
    expect(frame.headers.get('content-security-policy')).toContain(`script-src '${hash}'`)
    expect(frame.headers.get('content-security-policy')).toContain("connect-src 'none'")
    expect(frame.headers.get('content-security-policy')).toContain("frame-src 'none'")
    expect(frame.headers.get('content-security-policy')).not.toContain('allow-same-origin')
    expect(frame.headers.get('x-frame-options')).toBeNull()
    expect((await host.raw('unix', 'preview-frame/office.json')).status).toBe(404)
    const worker = await host.raw('unix', 'assets/csv.worker-abcdefgh.js')
    expect(worker.status).toBe(200)
    expect(worker.headers.get('content-security-policy')).toContain("connect-src 'none'")
    expect(worker.headers.get('content-security-policy')).not.toContain("connect-src 'self'")
  })
  it('refuses top-level browser frame navigation and never serves the script variant over TCP', async () => {
    const { root, hash } = await fixture()
    const host = await startTestHost({ uiDir: root })
    clean.push(() => host.close())
    expect((await host.raw('loopback-tcp', 'preview-frame/html.html')).status).toBe(403)
    const staticFrame = await host.raw('loopback-tcp', 'preview-frame/html.html', { headers: { 'sec-fetch-dest': 'iframe' } })
    expect(staticFrame.status).toBe(200)
    expect(staticFrame.headers.get('content-security-policy')).toContain(`script-src '${hash}'`)
    expect((await host.raw('loopback-tcp', 'preview-frame/html-script.html', { headers: { 'sec-fetch-dest': 'iframe' } })).status).toBe(403)
    const desktop = await host.raw('unix', 'preview-frame/html-script.html')
    expect(desktop.status).toBe(200)
    expect(desktop.headers.get('content-security-policy')).toContain("script-src 'unsafe-inline' 'unsafe-eval'")
    expect(desktop.headers.get('content-security-policy')).toContain("connect-src 'none'")
  })
})
