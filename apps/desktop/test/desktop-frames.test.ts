import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appFrameCsp as hostAppFrameCsp } from '@latch/host/app-frame'
import { startTestHost } from './helpers/host.ts'
const require = createRequire(import.meta.url)
const { isAllowedRendererDetails, isPreviewFrameUrl, isAppFrameUrl, appFrameCsp, createShellProxy } = require('../src/proxy.cjs') as {
  isPreviewFrameUrl(url: string): boolean
  isAppFrameUrl(url: string): boolean
  appFrameCsp(hash: string): string
  isAllowedRendererDetails(
    details: { url: string; resourceType: string; frame?: { url: string; parent: unknown } | null; initiatorOrigin?: string },
    options: { packaged: boolean },
  ): boolean
  createShellProxy(options: { hostId: string; resolveSocket(): Promise<string>; store: { current(): undefined } }): {
    previewFrame(request: Request): Promise<Response>
  }
}
describe('opaque desktop document frames', () => {
  it('refuses API requests from child, opaque, detached and worker frames while allowing the main page', () => {
    const request = { url: 'latch://app/link/api/snapshot', resourceType: 'xhr' }
    const options = { packaged: true }
    expect(isAllowedRendererDetails({ ...request, frame: { url: 'latch://app/link/', parent: null } }, options)).toBe(true)
    for (const extra of [
      { frame: null },
      {},
      { initiatorOrigin: 'null' },
      { frame: { url: 'latch-frame://preview/office.html', parent: {} } },
    ])
      expect(isAllowedRendererDetails({ ...request, ...extra }, options)).toBe(false)
    expect(
      isAllowedRendererDetails(
        { url: 'https://example.test/leak', resourceType: 'xhr', frame: { url: 'latch-frame://preview/office.html', parent: {} } },
        options,
      ),
    ).toBe(false)
    expect(isAllowedRendererDetails({ url: 'latch-frame://preview/office.html', resourceType: 'subFrame' }, options)).toBe(true)
    expect(isAllowedRendererDetails({ url: 'latch-frame://preview/office.html', resourceType: 'mainFrame' }, options)).toBe(false)
    expect(isPreviewFrameUrl('latch-frame://preview/office.html?file=/private/key')).toBe(false)
    expect(isPreviewFrameUrl('latch-frame://preview/api/snapshot')).toBe(false)
  })
  it('retrieves only fixed public bootstrap files without enrolling or possessing a credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-desktop-frame-'))
    await mkdir(join(root, 'preview-frame'))
    const script = 'void 0',
      hash = `sha256-${createHash('sha256').update(script).digest('base64')}`
    await writeFile(join(root, 'preview-frame/office.html'), `<script>${script}</script>`)
    await writeFile(join(root, 'preview-frame/office.json'), JSON.stringify({ file: 'office.html', scriptHash: hash }))
    const host = await startTestHost({ uiDir: root })
    try {
      const proxy = createShellProxy({
        hostId: host.host.hostId,
        resolveSocket: async () => host.host.socketPath,
        store: { current: () => undefined },
      })
      const frame = await proxy.previewFrame(new Request('latch-frame://preview/office.html'))
      expect(frame.status).toBe(200)
      expect(frame.headers.get('content-security-policy')).toContain('frame-ancestors latch://app')
      expect(frame.headers.has('set-cookie')).toBe(false)
      expect((await proxy.previewFrame(new Request('latch-frame://preview/api/snapshot'))).status).toBe(404)
      await writeFile(join(root, 'preview-frame/office.html'), '<script>void 1</script>')
      expect((await proxy.previewFrame(new Request('latch-frame://preview/office.html'))).status).toBe(404)
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads the plugin page runtime only as a subframe, with page code only from a Blob', () => {
    const options = { packaged: true }
    const frame = { url: 'latch-frame://app/runtime.html#nonce=' + 'a'.repeat(32), parent: {} }
    expect(isAppFrameUrl('latch-frame://app/runtime.html#nonce=x')).toBe(true)
    for (const url of [
      'latch-frame://app/runtime.html?x=1',
      'latch-frame://app/other.html',
      'latch-frame://preview/runtime.html',
      'latch://app/runtime.html',
    ])
      expect(isAppFrameUrl(url)).toBe(false)
    expect(isAllowedRendererDetails({ url: 'latch-frame://app/runtime.html', resourceType: 'subFrame' }, options)).toBe(true)
    expect(isAllowedRendererDetails({ url: 'latch-frame://app/runtime.html', resourceType: 'mainFrame' }, options)).toBe(false)
    expect(isAllowedRendererDetails({ url: 'blob:null/1234', resourceType: 'script', frame }, options)).toBe(true)
    for (const url of ['latch://app/link/api/app-modules/p/a/x.js', 'https://example.test/x.js', 'data:text/javascript,1'])
      expect(isAllowedRendererDetails({ url, resourceType: 'script', frame }, options)).toBe(false)
    expect(isAllowedRendererDetails({ url: 'latch://app/link/api/snapshot', resourceType: 'xhr', frame }, options)).toBe(false)
    // A preview bootstrap gets no scripts from a Blob.
    expect(
      isAllowedRendererDetails(
        { url: 'blob:null/1234', resourceType: 'script', frame: { url: 'latch-frame://preview/office.html', parent: {} } },
        options,
      ),
    ).toBe(false)
  })
  it("serves the page runtime with the Host's policy, framed only by the app page", async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-desktop-app-frame-'))
    await mkdir(join(root, 'app-frame'))
    const script = 'void 0',
      hash = `sha256-${createHash('sha256').update(script).digest('base64')}`
    await writeFile(join(root, 'app-frame/runtime.html'), `<div id="app"></div><script>${script}</script>`)
    await writeFile(join(root, 'app-frame/runtime.json'), JSON.stringify({ file: 'runtime.html', scriptHash: hash }))
    const host = await startTestHost({ uiDir: root })
    try {
      const proxy = createShellProxy({
        hostId: host.host.hostId,
        resolveSocket: async () => host.host.socketPath,
        store: { current: () => undefined },
      })
      const frame = await proxy.previewFrame(new Request('latch-frame://app/runtime.html'))
      expect(frame.status).toBe(200)
      expect(frame.headers.get('content-security-policy')).toBe(appFrameCsp(hash))
      expect(appFrameCsp(hash)).toBe(hostAppFrameCsp(hash, 'latch://app'))
      expect(frame.headers.has('set-cookie')).toBe(false)
      expect((await proxy.previewFrame(new Request('latch-frame://app/runtime.html?x=1'))).status).toBe(404)
      await writeFile(join(root, 'app-frame/runtime.html'), '<script>void 1</script>')
      expect((await proxy.previewFrame(new Request('latch-frame://app/runtime.html'))).status).toBe(404)
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
