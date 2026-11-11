import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSnapshot, PluginPackageBundle, PluginPackageDetail } from '@latch/protocol'
import type { TestDevice } from '@latch/testkit'
import { appFrameCsp, readAppFrame } from '../src/app-frame.ts'
import { startTestHost } from './helpers/host.ts'

const clean: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of clean.splice(0).reverse()) await close()
})

async function uiFixture() {
  const root = await mkdtemp(join(tmpdir(), 'latch-app-frame-'))
  clean.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'app-frame'))
  const script = 'parent.postMessage({type:"ready"},"*")'
  const hash = `sha256-${createHash('sha256').update(script).digest('base64')}`
  const html = `<!doctype html><html><body><div id="app"></div><script>${script}</script></body></html>`
  await writeFile(join(root, 'app-frame/runtime.html'), html)
  await writeFile(join(root, 'app-frame/runtime.json'), JSON.stringify({ file: 'runtime.html', scriptHash: hash }))
  return { root, html, hash }
}

const MODULE = 'export default globalThis.__latchModules["@latch/app-sdk"].defineApp({ page: () => null })\n'
function pageBundle(entry: string, content: string): PluginPackageBundle {
  return {
    manifest: {
      formatVersion: 2,
      id: 'pages',
      name: '页面',
      version: '1.0.0',
      description: '',
      apps: [{ id: 'main', title: '页面', entry, dataVersion: 1, capabilities: { 'tasks.read': true } }],
    },
    files: [{ path: entry, content }],
  }
}
async function install(owner: TestDevice, bundle: PluginPackageBundle): Promise<PluginPackageDetail> {
  const existing = await owner.request(`plugin-packages/${bundle.manifest.id}`)
  const draft =
    existing.status === 404
      ? (await owner.json<{ package: PluginPackageDetail }>('plugin-packages', { body: { requestId: randomUUID(), bundle } })).package
      : (
          await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${bundle.manifest.id}`, {
            method: 'PUT',
            body: {
              requestId: randomUUID(),
              baseRevision: ((await existing.json()) as { package: PluginPackageDetail }).package.revision,
              bundle,
            },
          })
        ).package
  const applied = await owner.confirmed(`plugin-packages/${draft.id}/apply`, {
    body: { requestId: randomUUID(), revision: draft.revision },
  })
  expect(applied.status).toBe(200)
  return ((await applied.json()) as { package: PluginPackageDetail }).package
}

describe('the plugin page runtime', () => {
  it('binds the runtime bytes to the script hash in its policy and refuses a changed file', async () => {
    const { root, html, hash } = await uiFixture()
    const frame = await readAppFrame(root)
    expect(frame).toMatchObject({ data: Buffer.from(html), hash })
    expect(frame.csp).toBe(appFrameCsp(hash))
    for (const directive of [
      'sandbox allow-scripts;',
      `script-src '${hash}' blob:;`,
      "connect-src 'none'",
      "worker-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ])
      expect(frame.csp).toContain(directive)
    expect(frame.csp).not.toContain('allow-same-origin')
    await writeFile(join(root, 'app-frame/runtime.html'), html.replace('ready', 'other'))
    await expect(readAppFrame(root)).rejects.toMatchObject({ code: 'app-frame-unavailable' })
  })

  it('serves the runtime without a credential, only as a frame from another device, and nothing else under app-frame/', async () => {
    const { root, hash } = await uiFixture()
    const host = await startTestHost({ uiDir: root })
    clean.push(() => host.close())
    const local = await host.raw('unix', 'app-frame/runtime.html')
    expect(local.status).toBe(200)
    expect(local.headers.get('content-security-policy')).toBe(appFrameCsp(hash))
    expect(local.headers.get('cache-control')).toBe('no-store')
    expect(local.headers.get('x-frame-options')).toBeNull()
    expect(local.headers.get('set-cookie')).toBeNull()
    expect((await host.raw('unix', 'app-frame/runtime.json')).status).toBe(404)
    expect((await host.raw('loopback-tcp', 'app-frame/runtime.html')).status).toBe(403)
    expect((await host.raw('loopback-tcp', 'app-frame/runtime.html', { headers: { 'sec-fetch-dest': 'iframe' } })).status).toBe(200)
  })
})

describe('page modules', () => {
  it('serves the applied prebuilt module by its hash to a device that can view, and nothing for an old hash', async () => {
    const host = await startTestHost()
    clean.push(() => host.close())
    const owner = await host.enroll({ listener: 'unix' })
    await install(owner, pageBundle('page.js', MODULE))
    const hash = createHash('sha256').update(MODULE).digest('hex')
    const summary = (await owner.json<AppSnapshot>('snapshot')).apps?.[0]
    expect(summary?.bundleHash).toBe(hash)

    const served = await owner.request(`app-modules/pages/main/${hash}.js`)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('application/octet-stream')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    // Never as a script, frame or document on the shell's origin.
    for (const dest of ['script', 'iframe', 'document'])
      expect((await owner.request(`app-modules/pages/main/${hash}.js`, { headers: { 'sec-fetch-dest': dest } })).status).toBe(403)
    expect((await owner.request(`app-modules/pages/main/${hash}.js`, { headers: { 'sec-fetch-dest': 'empty' } })).status).toBe(200)
    expect(served.headers.get('cache-control')).toBe('no-store')
    expect(await served.text()).toBe(MODULE)
    expect((await host.raw('loopback-tcp', `api/app-modules/pages/main/${hash}.js`)).status).toBe(401)
    expect((await owner.request(`app-modules/pages/other/${hash}.js`)).status).toBe(404)

    // A new version: the old hash is gone.
    await install(owner, pageBundle('page.js', `${MODULE}// 2\n`))
    const old = await owner.request(`app-modules/pages/main/${hash}.js`)
    expect([old.status, ((await old.json()) as { error: string }).error]).toEqual([404, 'app-module-not-found'])
    const next = (await owner.json<AppSnapshot>('snapshot')).apps?.[0]?.bundleHash
    expect(next).toBe(createHash('sha256').update(`${MODULE}// 2\n`).digest('hex'))

    // A disabled plugin serves nothing.
    expect((await owner.request('plugin-packages/pages/enabled', { body: { requestId: randomUUID(), enabled: false } })).status).toBe(200)
    const disabled = await owner.request(`app-modules/pages/main/${next}.js`)
    expect([disabled.status, ((await disabled.json()) as { error: string }).error]).toEqual([409, 'app-disabled'])
  })

  it('has no module for a source entry until pages are built, and refuses other entry kinds', async () => {
    const host = await startTestHost()
    clean.push(() => host.close())
    const owner = await host.enroll({ listener: 'unix' })
    await install(owner, pageBundle('src/index.tsx', 'export default null'))
    expect((await owner.json<AppSnapshot>('snapshot')).apps?.[0]).not.toHaveProperty('bundleHash')
    const refused = await owner.request('plugin-packages', {
      body: {
        requestId: randomUUID(),
        bundle: { ...pageBundle('page.mjs', MODULE), manifest: { ...pageBundle('page.mjs', MODULE).manifest, id: 'other' } },
      },
    })
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([400, 'plugin-package-app-entry'])
  })
})
