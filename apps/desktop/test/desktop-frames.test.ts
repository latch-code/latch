import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startTestHost } from './helpers/host.ts'
const require = createRequire(import.meta.url)
const { isAllowedRendererDetails, isPreviewFrameUrl, createShellProxy } = require('../src/proxy.cjs') as {
  isPreviewFrameUrl(url: string): boolean
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
})
