import { expect, it, vi } from 'vitest'
import type { FetchLike } from '../src/egress.ts'
import { createOfficialCatalog } from '../src/plugin-official-catalog.ts'
import { officialCatalogFixture } from './helpers/official-catalog.ts'

const id = 'context-insights'
const authorize = () => {}
const refs = 'https://github.com/latch-code/plugin-market.git/info/refs?service=git-upload-pack'
const codeload = 'https://codeload.github.com/latch-code/plugin-market/tar.gz/'
const raw = 'https://raw.githubusercontent.com/latch-code/plugin-market/'

it('checks all four packages in one anonymous, commit-pinned read and rechecks only main when it has not changed', async () => {
  const github = officialCatalogFixture()
  const catalog = createOfficialCatalog({ fetch: github.fetch, dataDir: '' })
  const bundled = catalog.get(id)!
  expect(bundled.commit).toBeUndefined()
  expect(catalog.get('not-in-market')).toBeUndefined()
  const commit = github.publishContext('9.0.0')
  const [snapshot, same] = await Promise.all([catalog.checkAll(authorize), catalog.checkAll(authorize)])
  expect(snapshot).toEqual(same)
  expect(snapshot).toHaveLength(4)
  const candidate = catalog.get(id)!
  expect(candidate).toMatchObject({ commit, checked: { bundle: { manifest: { id, version: '9.0.0' } } } })
  expect(catalog.at(id, bundled.checked.revision)).toBeUndefined()
  expect(catalog.at(id, candidate.checked.revision)).toEqual(candidate)
  const calls = github.fetch.mock.calls
  expect(calls.filter(([url]) => url === refs)).toHaveLength(1)
  expect(calls.filter(([url]) => url === codeload + commit)).toHaveLength(1)
  expect(calls.filter(([url]) => url.endsWith('/latch.catalog.json'))).toHaveLength(1)
  for (const [url, init] of calls) {
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' })
    expect(new Headers(init.headers).has('authorization')).toBe(false)
    if (url !== refs && url !== codeload + commit) expect(url.startsWith(raw + commit + '/')).toBe(true)
  }
  const count = calls.length
  await catalog.checkAll(authorize)
  expect(calls).toHaveLength(count)
  await catalog.checkAll(authorize, true)
  expect(calls.slice(count).map(([url]) => url)).toEqual([refs])
  const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 6 * 60 * 1000)
  try {
    const newer = github.publishContext('9.1.0')
    await catalog.checkAll(authorize)
    expect(catalog.get(id)?.commit).toBe(newer)
  } finally {
    clock.mockRestore()
  }
})

it('reads the advertised commit even when main moves between discovery and archive download', async () => {
  const github = officialCatalogFixture()
  const first = github.publishContext('9.0.0')
  let next: string | undefined
  const fetch: FetchLike = async (url, init) => {
    const response = await github.fetch(url, init)
    if (url === refs && !next) next = github.publishContext('9.1.0')
    return response
  }
  const catalog = createOfficialCatalog({ fetch, dataDir: '' })
  const releases = await catalog.checkAll(authorize)
  expect(releases.every(release => release.commit === first)).toBe(true)
  expect(catalog.get(id)?.checked.bundle.manifest.version).toBe('9.0.0')
  expect(github.fetch.mock.calls.some(([url]) => url.includes(next!))).toBe(false)
  await catalog.checkAll(authorize, true)
  expect(catalog.get(id)).toMatchObject({ commit: next, checked: { bundle: { manifest: { version: '9.1.0' } } } })
})

it.each(['raw corruption', 'revoked permission'])('retains the complete last good catalog on %s in the last plugin', async failure => {
  const github = officialCatalogFixture()
  github.publishContext('9.0.0')
  let rejectReading = false
  let permitted = true
  const fetch: FetchLike = async (url, init) => {
    const response = await github.fetch(url, init)
    if (!rejectReading || !url.endsWith('/plugins/context-insights/panel.mjs')) return response
    if (failure === 'revoked permission') permitted = false
    else {
      const bytes = new Uint8Array(await response.arrayBuffer())
      bytes[0] = bytes[0]! ^ 1
      return new Response(bytes)
    }
    return response
  }
  const catalog = createOfficialCatalog({ fetch, dataDir: '' })
  const good = await catalog.checkAll(authorize)
  github.publishContext('9.1.0')
  rejectReading = true
  const checking = catalog.checkAll(() => {
    if (!permitted) throw new Error('Permission revoked')
  }, true)
  if (failure === 'revoked permission') await expect(checking).rejects.toThrow('Permission revoked')
  else await expect(checking).rejects.toMatchObject({ code: 'plugin-external-github-invalid' })
  for (const release of good) expect(catalog.get(release.checked.bundle.manifest.id)).toEqual(release)
})

it('keeps the last good snapshot on read failures, same-version changes and remote downgrades', async () => {
  const github = officialCatalogFixture()
  const catalog = createOfficialCatalog({ fetch: github.fetch, dataDir: '' })
  const original = catalog.get(id)
  github.fetch.mockRejectedValueOnce(new Error('offline'))
  await expect(catalog.checkAll(authorize, true)).rejects.toMatchObject({ code: 'plugin-external-github-unreachable' })
  expect(catalog.get(id)).toEqual(original)
  github.publishContext('9.0.0')
  const good = await catalog.checkAll(authorize, true)
  const candidate = catalog.get(id)
  github.publishContext('9.0.0', '\n// A second build with the same version.')
  await expect(catalog.checkAll(authorize, true)).rejects.toMatchObject({ code: 'plugin-catalog-same-version-changed' })
  for (const release of good) expect(catalog.get(release.checked.bundle.manifest.id)).toEqual(release)
  github.publishContext('8.0.0')
  await expect(catalog.checkAll(authorize, true)).rejects.toMatchObject({ code: 'plugin-catalog-older' })
  expect(catalog.get(id)).toEqual(candidate)
})

it('keeps a newer bundled release and rechecks permission even when serving a cached result', async () => {
  const github = officialCatalogFixture()
  const catalog = createOfficialCatalog({ fetch: github.fetch, dataDir: '' })
  const bundled = catalog.get(id)
  github.publishContext('0.9.0')
  await catalog.checkAll(authorize)
  expect(catalog.get(id)).toEqual(bundled)
  const denied = vi.fn(() => {
    throw new Error('Permission revoked')
  })
  await expect(catalog.checkAll(denied)).rejects.toThrow('Permission revoked')
})
