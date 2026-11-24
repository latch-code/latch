import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import { setKnownSecrets } from '@latch/core/node-kit'
import {
  createPluginPackageTemplate,
  type PluginNpmPreview,
  type PluginNpmRegistrySettings,
  type PluginNpmStage,
  type PluginPackageDetail,
} from '@latch/protocol'
import type { TestDevice } from '@latch/testkit'
import { readNpmPlugin } from '../src/plugin-npm.ts'
import { newerNpmVersion } from '../src/npm-source.ts'
import { startTestHost } from './helpers/host.ts'

const registry = 'https://registry.example.test/npm/'
const name = '@latch-fixture/checklist'
// Existing plugins may use this ID. The registry routes must leave their ordinary asset routes reachable.
const id = 'npm'
const route = 'plugin-packages/npm'
const registryRoute = `${route}/registry`
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close()
})

function tarFile(path: string, contents: string, type = '0'): Buffer {
  const bytes = Buffer.from(contents),
    header = Buffer.alloc(512)
  header.write(path)
  header.write(bytes.length.toString(8).padStart(11, '0'), 124)
  header.fill(32, 148, 156)
  header.write(type, 156)
  header.write('ustar\x0000', 257)
  header.write(
    `${header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0')}\0 `,
    148,
  )
  return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)])
}

function sample(version: string, kind: 'skill' | 'tool' = 'skill', packageId = id) {
  const bundle = createPluginPackageTemplate(kind, packageId)
  bundle.manifest.version = version
  return bundle
}

function archiveOf(version: string, extra: Buffer[] = [], kind: 'skill' | 'tool' = 'skill', packageId = id): Buffer {
  return gzipSync(
    Buffer.concat([
      tarFile('package/package.json', JSON.stringify({ name, version, scripts: { install: 'exit 42' }, dependencies: { unused: '*' } })),
      tarFile('package/latch-plugin.json', JSON.stringify(sample(version, kind, packageId))),
      ...extra,
      Buffer.alloc(1024),
    ]),
  )
}

function distribution(source: string, version: string, archive: Buffer) {
  return {
    tarball: `${source}${name}/-/checklist-${version}.tgz`,
    integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
  }
}

async function registryChange(owner: TestDevice, address: string | null) {
  const base = await owner.json<PluginNpmRegistrySettings>(registryRoute)
  return { method: 'PUT', body: { registry: address, baseRegistry: base.registry, baseRevision: base.revision, requestId: randomUUID() } }
}
async function configure(owner: TestDevice, address: string | null) {
  return owner.confirmedJson<PluginNpmRegistrySettings>(registryRoute, await registryChange(owner, address))
}
async function preview(owner: TestDevice, input: { name: string; pluginId?: string; version?: string } = { name }) {
  return owner.json<PluginNpmPreview>(`${route}/preview`, { body: input })
}
function stageInput(candidate: PluginNpmPreview, updating = false): PluginNpmStage {
  return {
    requestId: randomUUID(),
    release: candidate.release,
    revision: candidate.revision,
    ...(updating
      ? {
          update: {
            pluginId: candidate.installed!.id,
            installId: candidate.installed!.installId,
            baseRevision: candidate.installed!.revision,
          },
        }
      : {}),
  }
}
async function stage(owner: TestDevice, body: PluginNpmStage) {
  return (await owner.json<{ package: PluginPackageDetail }>(`${route}/stage`, { body })).package
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ error: code })
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

it('binds authorized npm downloads to the host source and stages executable updates for normal review', async () => {
  const secondSource = 'https://other-registry.example.test/npm/'
  let latest = '1.0.0'
  const fetch = vi.fn(async (text: string, init: RequestInit) => {
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' })
    expect(new Headers(init.headers).has('authorization')).toBe(false)
    const source = text.startsWith(registry) ? registry : secondSource
    const version = text.endsWith('/latest') ? latest : /(?:\/checklist-)?(\d+\.\d+\.\d+)(?:\.tgz)?$/u.exec(text)![1]
    const archive = archiveOf(version, [], version === '1.0.0' ? 'skill' : 'tool')
    const dist = distribution(source, version, archive)
    return text.endsWith('.tgz') ? new Response(Uint8Array.from(archive)) : Response.json({ name, version, dist })
  })
  const root = await mkdtemp(join(tmpdir(), 'latch-npm-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspaceRoot = join(root, 'workspace'),
    dataDir = join(root, 'data')
  await mkdir(workspaceRoot)
  const host = await startTestHost({ dataDir, workspaceRoot, pluginRegistryFetch: fetch })
  cleanups.push(() => host.close())
  const owner = await host.enroll({ listener: 'unix' })
  const browser = await host.enroll({ listener: 'loopback-tcp' })
  expect(await owner.json(registryRoute)).toMatchObject({ registry: null })
  await error(await owner.request(`${route}/preview`, { body: { name } }), 409, 'plugin-npm-registry-unconfigured')
  expect((await browser.request(`${route}/preview`, { body: { name } })).status).toBe(403)
  expect((await browser.request(`${route}/stage`, { body: {} })).status).toBe(403)
  expect((await browser.request(`${route}/registry`)).status).toBe(403)
  expect(fetch).not.toHaveBeenCalled()
  for (const invalid of [
    'http://registry.example.test/npm/',
    'https://user@registry.example.test/npm/',
    `${registry}?key=hello`,
    `${registry}a/../`,
  ])
    await error(await owner.request(registryRoute, await registryChange(owner, invalid)), 400, 'plugin-npm-registry-invalid')
  await error(await owner.request(registryRoute, await registryChange(owner, registry)), 403, 'stepup-required')
  const configured = await configure(owner, registry.slice(0, -1))
  expect(configured.registry).toBe(registry)
  expect(host.presence.requests.some(request => request.preview.action === 'policy.change')).toBe(true)
  expect(fetch).not.toHaveBeenCalled()

  const first = await preview(owner),
    firstRequest = stageInput(first)
  expect(first.review).toMatchObject({ revision: first.revision, source: { kind: 'npm', ...first.release } })
  expect(fetch.mock.calls[0]?.[0]).toBe(`${registry}@latch-fixture%2fchecklist/latest`)
  const draft = await stage(owner, firstRequest)
  expect(draft).toMatchObject({
    enabled: false,
    state: 'draft',
    revision: first.revision,
    npm: { ...first.release, revision: first.revision },
  })
  expect(host.host.registry.list().find(plugin => plugin.id === id)).toBeUndefined()
  await owner.json(`plugin-packages/${id}/apply`, { body: { requestId: randomUUID(), revision: draft.revision } })
  expect(host.host.registry.list().find(plugin => plugin.id === id)?.version).toBe('1.0.0')
  await host.close()

  const restarted = await startTestHost({ dataDir, workspaceRoot, pluginRegistryFetch: fetch })
  cleanups.push(() => restarted.close())
  // Keep the same enrolled device to exercise a durable, device-bound receipt after the host restarts.
  const sameOwner = await restarted.enroll({ listener: 'unix' })
  const replay = (body: PluginNpmStage) =>
    restarted.raw('unix', `api/${route}/stage`, {
      body,
      headers: { authorization: `Latch-Device ${owner.credential}` },
    })
  expect(await sameOwner.json(registryRoute)).toEqual(configured)
  const switchSource = await registryChange(sameOwner, secondSource)
  const switched = await sameOwner.confirmedJson<PluginNpmRegistrySettings>(registryRoute, switchSource)
  expect(switched.registry).toBe(secondSource)
  expect(await sameOwner.json(registryRoute, switchSource)).toEqual(switched)
  fetch.mockClear()
  const remembered = await replay(firstRequest)
  expect(remembered.status).toBe(201)
  expect(await remembered.json()).toMatchObject({ package: { appliedRevision: first.revision, npm: first.release } })
  await error(await sameOwner.request(`${route}/preview`, { body: { name, pluginId: id } }), 409, 'plugin-npm-source-mismatch')
  await error(await replay({ ...firstRequest, revision: 'a'.repeat(64) }), 409, 'request-conflict')
  expect(fetch).not.toHaveBeenCalled()
  await configure(sameOwner, registry)
  await error(await sameOwner.request(registryRoute, switchSource), 409, 'plugin-npm-registry-changed')
  latest = '1.1.0'
  const next = await preview(sameOwner, { name, pluginId: id })
  const update = stageInput(next, true)
  expect(next).toMatchObject({
    updateAvailable: true,
    installed: { id, modified: false },
    review: {
      revision: next.revision,
      baseAppliedRevision: draft.revision,
      comparison: { revision: draft.revision, version: '1.0.0', changedExecution: true, changedSource: false },
      findings: expect.arrayContaining([expect.objectContaining({ kind: 'host-access' })]),
    },
  })
  const staged = await stage(sameOwner, update)
  expect(staged).toMatchObject({
    enabled: true,
    trusted: false,
    version: latest,
    appliedRevision: draft.revision,
    state: 'update-available',
  })
  expect(restarted.host.registry.list().find(plugin => plugin.id === id)?.version).toBe('1.0.0')
  const apply = { requestId: randomUUID(), revision: staged.revision }
  const applyRoute = `plugin-packages/${id}/apply`
  await error(await sameOwner.request(applyRoute, { body: apply }), 403, 'stepup-required')
  await sameOwner.confirmedJson(applyRoute, { body: apply })
  expect(restarted.host.registry.list().find(plugin => plugin.id === id)?.version).toBe('1.1.0')
  expect(await configure(sameOwner, null)).toMatchObject({ registry: null })
})

it('protects a same-id manual draft, and only replaces an edited npm draft with exact reviewed bases and explicit consent', async () => {
  let latest = '1.0.0'
  let holdArchive: (() => Promise<void>) | undefined
  const fetch = vi.fn(async (text: string) => {
    const archive = archiveOf(latest)
    if (text.endsWith('.tgz')) await holdArchive?.()
    return text.endsWith('.tgz')
      ? new Response(Uint8Array.from(archive))
      : Response.json({ name, version: latest, dist: distribution(registry, latest, archive) })
  })
  const host = await startTestHost({ pluginRegistryFetch: fetch })
  cleanups.push(() => host.close())
  const owner = await host.enroll({ listener: 'unix' })
  await configure(owner, registry)
  const pluginRoute = `plugin-packages/${id}`
  const manual = (
    await owner.json<{ package: PluginPackageDetail }>('plugin-packages', { body: { requestId: randomUUID(), bundle: sample('1.0.0') } })
  ).package
  expect((await preview(owner)).installed).toMatchObject({ id, modified: true })
  const previewed = await preview(owner)
  await error(await owner.request(`${route}/stage`, { body: stageInput(previewed) }), 409, 'plugin-package-exists')
  await owner.json(pluginRoute, { method: 'DELETE', body: { requestId: randomUUID(), baseRevision: manual.revision } })
  const draft = await stage(owner, stageInput(previewed))
  const edit = async (baseRevision: string, change: string) => {
    const bundle = structuredClone(draft.bundle)
    bundle.files[0].content = change
    return (
      await owner.json<{ package: PluginPackageDetail }>(pluginRoute, {
        method: 'PUT',
        body: { requestId: randomUUID(), baseRevision, bundle },
      })
    ).package
  }
  latest = '1.1.0'
  const edited = await edit(draft.revision, 'first local edit')
  const changed = await preview(owner, { name, pluginId: id })
  expect(changed).toMatchObject({ updateAvailable: true, installed: { modified: true, revision: edited.revision } })
  const request = stageInput(changed, true)
  fetch.mockClear()
  await error(await owner.request(`${route}/stage`, { body: request }), 409, 'plugin-npm-local-changes')
  const revised = await edit(edited.revision, 'another local edit')
  request.update!.replaceLocalDraft = true
  await error(await owner.request(`${route}/stage`, { body: request }), 409, 'plugin-package-changed')
  expect(fetch).not.toHaveBeenCalled()
  expect((await owner.json<{ package: PluginPackageDetail }>(pluginRoute)).package.bundle.files[0]?.content).toBe('another local edit')
  const resolved = stageInput(await preview(owner, { name, pluginId: id }), true)
  expect(resolved.update!.baseRevision).toBe(revised.revision)
  resolved.update!.replaceLocalDraft = true
  const reading = deferred(),
    resume = deferred()
  holdArchive = async () => {
    reading.resolve()
    await resume.promise
  }
  const pending = owner.request(`${route}/stage`, { body: resolved })
  try {
    await reading.promise
    await edit(revised.revision, 'edited during download')
  } finally {
    holdArchive = undefined
    resume.resolve()
  }
  await error(await pending, 409, 'plugin-package-changed')
  expect((await owner.json<{ package: PluginPackageDetail }>(pluginRoute)).package.bundle.files[0]?.content).toBe('edited during download')
  const final = stageInput(await preview(owner, { name, pluginId: id }), true)
  final.update!.replaceLocalDraft = true
  expect(await stage(owner, final)).toMatchObject({ version: latest, state: 'draft' })
})

it('uses production egress restrictions even after a registry address is locally approved', async () => {
  const host = await startTestHost({
    egressLookup(hostname, _options, result) {
      expect(hostname).toBe('registry.example.test')
      result(null, [{ address: '127.0.0.1', family: 4 }])
    },
  })
  cleanups.push(() => host.close())
  const owner = await host.enroll({ listener: 'unix' })
  await configure(owner, registry)
  await error(await owner.request(`${route}/preview`, { body: { name } }), 403, 'egress-denied')
})

it('refuses external archive URLs and redirects and enforces the compressed digest and archive limits', async () => {
  const version = '1.0.0'
  const archive = archiveOf(version)
  const dist = distribution(registry, version, archive)
  const get = (serverDist: typeof dist, tarResponse: () => Response) =>
    vi.fn(async (url: string) => (url.endsWith('/latest') ? Response.json({ name, version, dist: serverDist }) : tarResponse()))
  const input = { registry, name }
  const check = () => {}
  for (const address of [
    'https://other.example.test/pkg.tgz',
    'https://registry.example.test/another/pkg.tgz',
    `${registry}foo%2f..%2f..%2fprivate.tgz`,
    `${dist.tarball}?secret=hidden`,
    `${dist.tarball}#fragment`,
  ]) {
    const fetch = get({ ...dist, tarball: address }, () => new Response())
    await expect(readNpmPlugin(fetch, input, check)).rejects.toMatchObject({ code: 'plugin-npm-tarball-source' })
    expect(fetch).toHaveBeenCalledTimes(1)
  }
  const redirect = get(dist, () => Response.redirect('https://other.example.test/denied.tgz'))
  await expect(readNpmPlugin(redirect, input, check)).rejects.toMatchObject({ code: 'plugin-npm-tarball-source' })
  expect(redirect).toHaveBeenCalledTimes(2)
  const republished = get({ ...dist, integrity: distribution(registry, version, archiveOf('1.1.0')).integrity }, () => new Response())
  await expect(readNpmPlugin(republished, input, check, dist.integrity)).rejects.toMatchObject({
    code: 'plugin-npm-integrity',
    status: 409,
  })
  expect(republished).toHaveBeenCalledTimes(1)
  await expect(
    readNpmPlugin(
      get(dist, () => new Response('wrong bytes')),
      input,
      check,
    ),
  ).rejects.toMatchObject({ code: 'plugin-npm-integrity' })
  for (const abnormal of [
    archiveOf(version, [tarFile('package/symlink', '', '2')]),
    archiveOf(version, [tarFile('package/../outside.mjs', '')]),
    archiveOf(version, [tarFile('package/LATCH-PLUGIN.JSON', '')]),
    archiveOf(version, [tarFile('package/latch-plugin.json/another', '')]),
    archiveOf(version, [tarFile('package/a.txt', 'a'.repeat(9 * 1024 * 1024))]),
  ]) {
    const fetch = get(distribution(registry, version, abnormal), () => new Response(Uint8Array.from(abnormal)))
    await expect(readNpmPlugin(fetch, input, check)).rejects.toMatchObject({ code: 'plugin-npm-archive-invalid' })
  }
  const claimedAnother = gzipSync(
    Buffer.concat([
      tarFile('package/package.json', JSON.stringify({ name: 'other-package', version })),
      tarFile('package/latch-plugin.json', JSON.stringify(sample(version))),
      Buffer.alloc(1024),
    ]),
  )
  await expect(
    readNpmPlugin(
      get(distribution(registry, version, claimedAnother), () => new Response(Uint8Array.from(claimedAnother))),
      input,
      check,
    ),
  ).rejects.toMatchObject({ code: 'plugin-npm-archive-invalid' })
})

it('supports only the matching npmmirror CDN release, and requires explicit versions for prereleases', async () => {
  const mirror = 'https://registry.npmmirror.com/'
  const version = '2.0.0-rc.10'
  const archive = archiveOf(version)
  const dist = distribution(mirror, version, archive)
  let cdn = `https://cdn.npmmirror.com/packages/${name}/${version}/checklist-${version}.tgz`
  const fetch = vi.fn(async (url: string) => {
    if (url === dist.tarball) return Response.redirect(cdn)
    if (url === cdn) return new Response(Uint8Array.from(archive))
    return Response.json({ name, version, dist })
  })
  await expect(readNpmPlugin(fetch, { registry: mirror, name }, () => {})).rejects.toMatchObject({ code: 'plugin-npm-prerelease' })
  expect(fetch).toHaveBeenCalledTimes(1)
  const exact = { registry: mirror, name, version }
  await expect(readNpmPlugin(fetch, exact, () => {})).resolves.toMatchObject({ release: { name, version, registry: mirror } })
  expect(fetch.mock.calls.at(-1)?.[0]).toBe(cdn)
  cdn = cdn.replace(`/packages/${name}/`, '/packages/different/')
  await expect(readNpmPlugin(fetch, exact, () => {})).rejects.toMatchObject({ code: 'plugin-npm-tarball-source' })
  expect(newerNpmVersion('2.0.0-rc.10', '2.0.0-rc.2')).toBe(true)
  expect(newerNpmVersion('2.0.0', version)).toBe(true)
  expect(newerNpmVersion('2.0.0+rebuild', '2.0.0')).toBe(false)
  expect(newerNpmVersion(version, '2.0.0')).toBe(false)
})

it('rejects npm bundles containing known secret values or credential files before returning package content', async () => {
  const version = '1.0.0'
  const knownSecret = 'test-configured-private-value'
  const body = sample(version)
  setKnownSecrets('npm-plugin-test', [knownSecret])
  try {
    for (const bundle of [
      { ...body, manifest: { ...body.manifest, description: knownSecret } },
      { ...body, files: [...body.files, { path: 'notes.txt', content: knownSecret }] },
      { ...body, files: [...body.files, { path: '.env', content: 'fixture=value' }] },
    ]) {
      const archive = gzipSync(
        Buffer.concat([
          tarFile('package/package.json', JSON.stringify({ name, version })),
          tarFile('package/latch-plugin.json', JSON.stringify(bundle)),
          Buffer.alloc(1024),
        ]),
      )
      const dist = distribution(registry, version, archive)
      const fetch = async (url: string) =>
        url === dist.tarball ? new Response(Uint8Array.from(archive)) : Response.json({ name, version, dist })
      await expect(readNpmPlugin(fetch, { registry, name }, () => {})).rejects.toMatchObject({ code: 'plugin-external-secret' })
    }
  } finally {
    setKnownSecrets('npm-plugin-test', [])
  }
})
