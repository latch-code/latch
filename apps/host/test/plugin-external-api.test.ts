import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createPluginPackageTemplate,
  type PluginExternalFind,
  type PluginExternalPreview,
  type PluginExternalStage,
  type PluginPackageBundle,
  type PluginPackageDetail,
} from '@latch/protocol'
import type { TestDevice } from '@latch/testkit'
import { startTestHost } from './helpers/host.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const remove of cleanup.splice(0).toReversed()) await remove()
})
const routes = 'plugin-packages/external'
const pluginId = 'external-sample'

async function fixture(options: Parameters<typeof startTestHost>[0] = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-external-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const host = await startTestHost(options)
  cleanup.push(() => host.close())
  const owner = await host.enroll({ listener: 'unix' })
  const file = join(root, 'sample.latch-plugin.json')
  return { root, owner, host, file }
}

function bundle(version: string, description = 'Externally supplied plugin'): PluginPackageBundle {
  const value = createPluginPackageTemplate('tool', pluginId, 'External Sample')
  return { ...value, manifest: { ...value.manifest, description, version } }
}

const writeBundle = (file: string, version: string, description?: string) =>
  writeFile(file, JSON.stringify(bundle(version, description)), { mode: 0o600 })

async function preview(device: TestDevice, selector: { input: string } | { pluginId: string }) {
  const found = await device.json<PluginExternalFind>(`${routes}/find`, { body: selector })
  expect(found.packages).toMatchObject([{ id: pluginId }])
  return device.json<PluginExternalPreview>(`${routes}/preview`, { body: { token: found.token, path: found.packages[0].path } })
}

function stageInput(view: PluginExternalPreview): PluginExternalStage {
  return {
    requestId: randomUUID(),
    token: view.token,
    revision: view.revision,
    ...(view.installed && { update: { installId: view.installed.installId, baseRevision: view.installed.revision } }),
  }
}

const stage = (owner: TestDevice, body: PluginExternalStage) => owner.json<{ package: PluginPackageDetail }>(`${routes}/stage`, { body })

async function refusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ error: code })
}

it('restricts external reads to the full local admin and binds staged bytes and replays to their preview', async () => {
  const { owner, host, file } = await fixture()
  await writeBundle(file, '1.0.0')
  const browser = await host.enroll({ scopes: ['view', 'run', 'admin'] })
  const reduced = await host.enroll({ listener: 'unix', scopes: ['view', 'admin'], dataScope: 'work' })
  for (const device of [browser, reduced]) {
    const response = await device.request(`${routes}/find`, { body: { input: file } })
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain(file)
  }
  const another = await host.enroll({ listener: 'unix' })
  const first = await preview(owner, { input: file })
  expect(first.review).toMatchObject({
    source: { kind: 'external', source: { kind: 'local-bundle', file }, path: '', version: '1.0.0' },
    confirmationRequired: true,
  })
  await refusal(await another.request(`${routes}/stage`, { body: stageInput(first) }), 409, 'plugin-external-preview-expired')
  await writeBundle(file, '1.0.0', 'Updated after preview')
  await refusal(await owner.request(`${routes}/stage`, { body: stageInput(first) }), 409, 'plugin-package-changed')
  const viewed = await preview(owner, { input: file })
  const request = stageInput(viewed)
  expect((await owner.request(`${routes}/stage`, { body: { ...request, source: { kind: 'catalog' } } })).status).toBe(400)
  const staged = await stage(owner, request)
  expect(staged.package).toMatchObject({
    id: pluginId,
    state: 'draft',
    enabled: false,
    trusted: false,
    external: { source: { kind: 'local-bundle', file }, version: '1.0.0', revision: viewed.revision },
  })
  expect(staged.package.catalog).toBeUndefined()
  expect(host.host.registry.list().some(plugin => plugin.id === pluginId)).toBe(false)
  const response = await apply(owner, staged.package)
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ confirmation: { action: 'plugin.package.apply' } })
  await rm(file)
  expect(await stage(owner, request)).toEqual(staged)
  await refusal(await owner.request(`${routes}/stage`, { body: { ...request, revision: '0'.repeat(64) } }), 409, 'request-conflict')
})

it('joins the same in-flight stage after its preview expires and rejects a different payload', async () => {
  const repository = 'example/ext-plugins'
  const commit = '1'.repeat(40)
  const tree = '2'.repeat(40)
  const path = 'latch-plugin.json'
  const content = JSON.stringify(bundle('1.0.0'))
  const size = Buffer.byteLength(content)
  const sha = createHash('sha1').update(`blob ${size}\0${content}`).digest('hex')
  let startStageRead = () => {}
  const stageReadStarted = new Promise<void>(resolve => {
    startStageRead = resolve
  })
  let releaseStageRead = () => {}
  const stageReadReleased = new Promise<void>(resolve => {
    releaseStageRead = resolve
  })
  let pauseDownload = false
  let stageDownloads = 0
  const { owner } = await fixture({
    async pluginRegistryFetch(input) {
      const url = new URL(input)
      if (url.pathname === `/repos/${repository}/commits`) return Response.json([{ sha: commit, commit: { tree: { sha: tree } } }])
      if (url.pathname === `/repos/${repository}/git/commits/${commit}`) return Response.json({ sha: commit, tree: { sha: tree } })
      if (url.pathname === `/repos/${repository}/git/trees/${tree}`)
        return Response.json({ sha: tree, truncated: false, tree: [{ path, size, sha, mode: '100644', type: 'blob' }] })
      if (url.pathname !== `/${repository}/${commit}/${path}`) return new Response(null, { status: 404 })
      if (pauseDownload) {
        stageDownloads++
        startStageRead()
        await stageReadReleased
      }
      return new Response(content)
    },
  })
  const viewed = await preview(owner, { input: `https://github.com/${repository}` })
  const request = stageInput(viewed)
  const clock = vi.spyOn(performance, 'now')
  pauseDownload = true
  const first = owner.request(`${routes}/stage`, { body: request })
  let retry: Promise<Response> | undefined
  try {
    await stageReadStarted
    clock.mockReturnValue(performance.now() + 16 * 60 * 1000)
    await refusal(
      await owner.request(`${routes}/stage`, { body: { ...request, requestId: randomUUID() } }),
      409,
      'plugin-external-preview-expired',
    )
    await refusal(await owner.request(`${routes}/stage`, { body: { ...request, revision: '0'.repeat(64) } }), 409, 'request-conflict')
    retry = owner.request(`${routes}/stage`, { body: request })
    // Both stage requests stay in progress until the reader releases its bytes.
    await expect.poll(async () => (await owner.request('plugin-packages')).status).toBe(429)
    releaseStageRead()
    const [original, joined] = await Promise.all([first, retry])
    expect(original.status).toBe(201)
    expect(joined.status).toBe(201)
    const receipt: unknown = await original.json()
    expect(await joined.json()).toEqual(receipt)
    expect(await stage(owner, request)).toEqual(receipt)
    expect(stageDownloads).toBe(1)
  } finally {
    releaseStageRead()
    clock.mockRestore()
    await Promise.allSettled([first, retry])
  }
})

function apply(owner: TestDevice, record: PluginPackageDetail) {
  return owner.request(`plugin-packages/${record.id}/apply`, { body: { requestId: randomUUID(), revision: record.revision } })
}

it('only stages newer exact releases from the original source and preserves edits or a replacement installation', async () => {
  const { owner, root, file } = await fixture()
  await writeBundle(file, '1.0.0')
  const firstRequest = stageInput(await preview(owner, { input: file }))
  const first = (await stage(owner, firstRequest)).package
  await writeBundle(file, '1.0.0+different', 'Same precedence')
  const sameVersion = await preview(owner, { pluginId })
  expect(sameVersion.updateStatus).toBe('same-version-changed')
  await refusal(await owner.request(`${routes}/stage`, { body: stageInput(sameVersion) }), 409, 'plugin-external-version-conflict')

  const otherDir = join(root, 'other')
  await mkdir(otherDir)
  const other = join(otherDir, 'sample.latch-plugin.json')
  await writeBundle(other, '3.0.0')
  const otherSource = await preview(owner, { input: other })
  expect(otherSource.updateStatus).toBe('different-source')
  await refusal(await owner.request(`${routes}/stage`, { body: stageInput(otherSource) }), 409, 'plugin-external-source-mismatch')

  await writeBundle(file, '2.0.0')
  const update = await preview(owner, { pluginId })
  expect(update).toMatchObject({
    updateStatus: 'available',
    updateAvailable: true,
    installed: { revision: first.revision, modified: false },
  })
  const staged = (await stage(owner, stageInput(update))).package
  await writeBundle(file, '3.0.0')
  const stale = await preview(owner, { pluginId })
  const edited = (
    await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${pluginId}`, {
      method: 'PUT',
      body: { requestId: randomUUID(), baseRevision: staged.revision, bundle: bundle('2.0.0', 'Local edits') },
    })
  ).package
  expect(edited.review.source).toMatchObject({ kind: 'external', modified: true, version: '2.0.0' })
  await refusal(await owner.request(`${routes}/stage`, { body: stageInput(stale) }), 409, 'plugin-package-changed')
  const modified = await preview(owner, { pluginId })
  expect(modified).toMatchObject({ updateStatus: 'local-changes', installed: { revision: edited.revision, modified: true } })
  await refusal(await owner.request(`${routes}/stage`, { body: stageInput(modified) }), 409, 'plugin-external-local-changes')
  expect((await owner.json<{ package: PluginPackageDetail }>(`plugin-packages/${pluginId}`)).package.revision).toBe(edited.revision)

  await owner.json(`plugin-packages/${pluginId}`, { method: 'DELETE', body: { requestId: randomUUID(), baseRevision: edited.revision } })
  await owner.json('plugin-packages', { body: { requestId: randomUUID(), bundle: bundle('4.0.0') } })
  await refusal(await owner.request(`${routes}/stage`, { body: firstRequest }), 410, 'plugin-package-removed')
})

it('updates a catalog release whose content-addressed package filename changes', async () => {
  const { owner, root } = await fixture()
  const publish = async (version: string) => {
    const bytes = JSON.stringify(bundle(version))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const file = `${pluginId}-${version}-${sha256.slice(0, 12)}.latch-plugin.json`
    await writeFile(join(root, file), bytes)
    await writeFile(
      join(root, 'latch.catelog.json'),
      JSON.stringify({
        formatVersion: 1,
        plugins: [{ id: pluginId, bundle: file, sha256, version }],
      }),
    )
    return file
  }
  const firstFile = await publish('1.0.0')
  const first = await preview(owner, { input: root })
  expect(first.entry.path).toBe(firstFile)
  const initial = (await stage(owner, stageInput(first))).package
  const nextFile = await publish('2.0.0')
  await rm(join(root, firstFile))
  const next = await preview(owner, { pluginId })
  expect(next).toMatchObject({ entry: { path: nextFile, version: '2.0.0' }, updateStatus: 'available' })
  const nextRecord = (await stage(owner, stageInput(next))).package
  expect(nextRecord).toMatchObject({
    external: { pluginId, path: nextFile, version: '2.0.0', source: { kind: 'local-folder', directory: root } },
    state: 'draft',
    review: { installId: initial.review.installId },
  })
})
