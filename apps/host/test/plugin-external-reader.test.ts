import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EgressDenied, type FetchLike } from '../src/egress.ts'
import {
  findExternalPluginSource,
  listExternalPlugins,
  readExternalPlugin,
  refreshExternalPluginSource,
} from '../src/plugin-external-reader.ts'

const manifest = {
  formatVersion: 1,
  id: 'handoff',
  name: 'Handoff notes',
  version: '1.0.0',
  description: 'Prepare handoff notes.',
  skills: [{ id: 'handoff', name: 'Handoff notes', description: 'Prepare handoff notes.', file: 'SKILL.md' }],
}
const catalogEntry = { id: manifest.id, folder: 'plugins/handoff', manifest: 'latch-plugin.json', files: ['SKILL.md'] }
const catalog = (...plugins: unknown[]) => JSON.stringify({ formatVersion: 1, plugins })
const bundle = { manifest, files: [{ path: 'SKILL.md', content: 'Write a short note.' }] }
const temp: string[] = []
const noNetwork = vi.fn<FetchLike>(() => Promise.reject(new Error('Local plugin reads must be offline')))

afterEach(async () => {
  await Promise.all(temp.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function write(root: string, path: string, content: string | Uint8Array) {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
  return file
}

async function local() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'latch-external-')))
  temp.push(home)
  const directory = join(home, 'selected')
  const dataDir = join(home, 'private-host')
  await mkdir(directory)
  await mkdir(dataDir)
  return { directory, options: { fetch: noNetwork, dataDir, home } }
}

describe('local plugin sources', () => {
  it('reads only declared source files and accepts exported bundle wrappers', async () => {
    const { directory, options } = await local()
    await write(directory, 'latch-plugin.json', JSON.stringify(manifest))
    await write(directory, 'SKILL.md', bundle.files[0].content)
    await write(directory, 'personal.txt', 'Unrelated notes')
    const found = await findExternalPluginSource('~/selected', options)
    expect(found.source).toEqual({ kind: 'local-folder', directory })
    expect(found.packages).toEqual([
      { path: '', id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description },
    ])
    const checked = await readExternalPlugin(found.source, '', options)
    expect(checked.bundle.files).toEqual(bundle.files)
    const file = await write(directory, 'export.latch-plugin.json', JSON.stringify({ bundle }))
    const exported = await findExternalPluginSource(file, options)
    expect(exported.packages).toEqual(found.packages)
    expect(await readExternalPlugin(exported.source, '', options)).toEqual(checked)
    expect(noNetwork).not.toHaveBeenCalled()
  })

  it('lists source and published entries, checks the declared files and verifies the original published bytes', async () => {
    const { directory, options } = await local()
    const nextBundle = { ...bundle, manifest: { ...manifest, id: 'published', version: '2.0.0+build.7' } }
    const published = JSON.stringify(nextBundle, null, 2) + '\n'
    const sha256 = createHash('sha256').update(published).digest('hex')
    const release = {
      id: nextBundle.manifest.id,
      name: 'Published Handoff',
      bundle: `files/${nextBundle.manifest.id}-${nextBundle.manifest.version}-${sha256}.latch-plugin.json`,
      version: nextBundle.manifest.version,
      sha256,
    }
    await write(directory, 'latch.catalog.json', catalog(catalogEntry, release))
    await write(directory, 'plugins/handoff/latch-plugin.json', JSON.stringify(manifest))
    const found = await findExternalPluginSource(directory, options)
    expect(found.packages.map(entry => [entry.path, entry.name])).toEqual([
      ['plugins/handoff', manifest.name],
      [release.bundle, release.name],
    ])
    await expect(readExternalPlugin(found.source, catalogEntry.folder, options)).rejects.toMatchObject({
      code: 'plugin-external-package-missing',
    })
    await write(directory, 'plugins/handoff/SKILL.md', 'Write a short note.')
    expect((await readExternalPlugin(found.source, catalogEntry.folder, options)).bundle.files).toEqual(bundle.files)
    await write(directory, release.bundle, published)
    expect((await readExternalPlugin(found.source, release.bundle, options)).bundle.manifest).toMatchObject({
      id: release.id,
      version: release.version,
    })
    await write(directory, release.bundle, published.trimEnd())
    await expect(readExternalPlugin(found.source, release.bundle, options)).rejects.toMatchObject({ code: 'plugin-external-integrity' })
    const renamed = { ...release, bundle: 'files/published-v2.latch-plugin.json' }
    await write(directory, renamed.bundle, published)
    await write(directory, 'latch.catalog.json', catalog(catalogEntry, renamed))
    expect((await listExternalPlugins(found.source, options)).at(-1)).toMatchObject({ path: renamed.bundle, id: release.id })
    expect((await readExternalPlugin(found.source, renamed.bundle, options)).bundle.manifest.id).toBe('published')
  })

  it('loads a standalone page with its bounded src directory', async () => {
    const { directory, options } = await local()
    await write(
      directory,
      'latch-app.json',
      JSON.stringify({
        formatVersion: 2,
        id: 'page',
        name: 'Example page',
        version: '1.0.0',
        description: '',
        requires: { appSdk: '^1' },
        apps: [{ id: 'main', title: 'Example page', entry: 'src/main.tsx', dataVersion: 1, capabilities: {} }],
      }),
    )
    await write(directory, 'src/main.tsx', "import './style.css'")
    await write(directory, 'src/style.css', ':root { color: black }')
    await write(directory, 'src/notes.txt', 'Not part of the page')
    const found = await findExternalPluginSource(directory, options)
    expect((await readExternalPlugin(found.source, '', options)).bundle.files.map(file => file.path)).toEqual([
      'src/main.tsx',
      'src/style.css',
    ])
  })

  it('rejects linked paths, protected targets and undeclared file selection', async () => {
    const { directory, options } = await local()
    const outside = await write(options.home, 'outside.md', 'Other notes')
    await write(directory, 'latch-plugin.json', JSON.stringify(manifest))
    const source = (await findExternalPluginSource(directory, options)).source
    await expect(readExternalPlugin(source, 'notes', options)).rejects.toMatchObject({ code: 'plugin-external-package-missing' })
    await symlink(outside, join(directory, 'SKILL.md'))
    await expect(readExternalPlugin(source, '', options)).rejects.toMatchObject({ code: 'plugin-external-path' })
    await rm(join(directory, 'SKILL.md'))
    await link(outside, join(directory, 'SKILL.md'))
    await expect(readExternalPlugin(source, '', options)).rejects.toMatchObject({ code: 'plugin-external-path' })
    const protectedFile = await write(directory, 'SKILL.md-copy', 'Protected domain data')
    await write(directory, 'latch-plugin.json', JSON.stringify({ ...manifest, skills: [{ ...manifest.skills[0], file: 'SKILL.md-copy' }] }))
    await expect(readExternalPlugin(source, '', { ...options, protectedPaths: [protectedFile] })).rejects.toMatchObject({
      code: 'plugin-external-path',
    })
    await symlink(directory, join(options.home, 'linked'))
    await expect(findExternalPluginSource(join(options.home, 'linked'), options)).rejects.toMatchObject({ code: 'plugin-external-path' })
    await expect(findExternalPluginSource(options.dataDir, options)).rejects.toMatchObject({ code: 'plugin-external-path' })
    await expect(findExternalPluginSource('~/selected/../selected', options)).rejects.toMatchObject({
      code: 'plugin-external-source-invalid',
    })
  })

  it('rejects traversal, duplicate paths, malformed UTF-8 and oversized files', async () => {
    const { directory, options } = await local()
    await write(directory, 'plugins/handoff/latch-plugin.json', JSON.stringify(manifest))
    for (const files of [['../notes.md'], ['notes.MD', 'NOTES.md'], ['secrets/.env'], ['latch-plugin.json']]) {
      await write(directory, 'latch.catalog.json', catalog({ ...catalogEntry, files }))
      await expect(findExternalPluginSource(directory, options)).rejects.toMatchObject({ code: 'plugin-external-content-invalid' })
    }
    await write(directory, 'latch.catalog.json', catalog(catalogEntry))
    const { source } = await findExternalPluginSource(directory, options)
    await write(directory, 'plugins/handoff/SKILL.md', Buffer.from([0xff]))
    await expect(readExternalPlugin(source, catalogEntry.folder, options)).rejects.toMatchObject({
      code: 'plugin-external-content-invalid',
    })
    await write(directory, 'plugins/handoff/SKILL.md', Buffer.alloc(1_000_001))
    await expect(readExternalPlugin(source, catalogEntry.folder, options)).rejects.toMatchObject({ code: 'plugin-external-limit' })
  })

  it('refuses embedded repositories while allowing the selected directory to be a Git checkout', async () => {
    const { directory, options } = await local()
    await write(directory, '.git', 'gitdir: selected-checkout')
    await write(directory, 'latch.catalog.json', catalog(catalogEntry))
    await write(directory, 'plugins/handoff/latch-plugin.json', JSON.stringify(manifest))
    const found = await findExternalPluginSource(directory, options)
    await write(directory, 'plugins/handoff/.git', 'gitdir: embedded-checkout')
    await expect(readExternalPlugin(found.source, catalogEntry.folder, options)).rejects.toMatchObject({ code: 'plugin-external-path' })
  })
})

const repo = 'test-owner/plugin-repo'
const repositoryUrl = `https://github.com/${repo}`
const firstCommit = 'a'.repeat(40)
const secondCommit = 'b'.repeat(40)
const firstTree = 'c'.repeat(40)
const secondTree = 'd'.repeat(40)

function github() {
  const state = { commit: firstCommit, brokenHash: false, mode: '100644', truncated: false }
  const versions = new Map([
    [firstCommit, firstTree],
    [secondCommit, secondTree],
  ])
  const source = (tree: string) =>
    new Map([
      ['latch-plugin.json', JSON.stringify({ ...manifest, version: tree === firstTree ? '1.0.0' : '2.0.0' })],
      ['SKILL.md', tree === firstTree ? 'Original file.' : 'Updated file!'],
    ])
  const fetch = vi.fn<FetchLike>(async input => {
    const url = new URL(input)
    const path = url.pathname
    const prefix = `/repos/${repo}`
    if (url.hostname === 'api.github.com') {
      const head = { sha: state.commit, commit: { tree: { sha: versions.get(state.commit) } } }
      if (path === `${prefix}/commits`) return Response.json([head])
      if (path === `${prefix}/commits/feature%2Fnew`) return Response.json(head)
      if (path.startsWith(`${prefix}/git/commits/`)) {
        const sha = path.split('/').at(-1)!
        return Response.json({ sha, tree: { sha: versions.get(sha) } })
      }
      if (path.startsWith(`${prefix}/git/trees/`)) {
        const sha = path.split('/').at(-1)!
        const tree = [...source(sha)].map(([filename, content]) => {
          const size = Buffer.byteLength(content)
          const mode = filename === 'SKILL.md' ? state.mode : '100644'
          return {
            path: filename,
            size,
            mode,
            type: mode === '160000' ? 'commit' : 'blob',
            sha: createHash('sha1').update(`blob ${size}\0${content}`).digest('hex'),
          }
        })
        return Response.json({ sha, tree, truncated: state.truncated })
      }
    }
    if (url.hostname === 'raw.githubusercontent.com') {
      const [commit, filename] = path.slice(repo.length + 2).split('/')
      const tree = versions.get(commit)
      const body = tree === undefined ? undefined : source(tree).get(filename)
      if (body) return new Response(state.brokenHash && filename === 'SKILL.md' ? 'Mismatch file!' : body)
    }
    return new Response(null, { status: 404 })
  })
  return { state, fetch, options: { fetch, dataDir: '/unused' } }
}

describe('GitHub plugin sources', () => {
  it('reads through the policy fetch, stays on the discovered commit, and resolves a new head only to check updates', async () => {
    const { state, fetch, options } = github()
    const found = await findExternalPluginSource('https://github.com/Test-Owner/Plugin-Repo.git', options)
    expect(found.source).toEqual({ kind: 'github', repository: repositoryUrl, ref: 'HEAD', commit: firstCommit })
    expect(found.packages[0]?.version).toBe('1.0.0')
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/SKILL.md'))).toBe(false)
    state.commit = secondCommit
    expect((await readExternalPlugin(found.source, '', options)).bundle.files[0]?.content).toBe('Original file.')
    const refreshed = await refreshExternalPluginSource(found.source, options)
    expect(refreshed).toMatchObject({ commit: secondCommit })
    expect((await listExternalPlugins(refreshed, options))[0]?.version).toBe('2.0.0')
    for (const [url, request] of fetch.mock.calls) {
      expect(new URL(url).hostname).toMatch(/^(?:api\.github\.com|raw\.githubusercontent\.com)$/u)
      expect(request).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' })
      expect(new Headers(request.headers).has('authorization')).toBe(false)
    }
  })

  it('supports an explicit branch with slashes and accepts a full commit as a fixed ref', async () => {
    const { fetch, options } = github()
    const branch = await findExternalPluginSource(`${repositoryUrl}/tree/feature/new`, options)
    expect(branch.source).toMatchObject({ ref: 'feature/new', commit: firstCommit })
    fetch.mockClear()
    const fixed = await findExternalPluginSource(`${repositoryUrl}/tree/${firstCommit}`, options)
    expect(fixed.source).toMatchObject({ ref: firstCommit, commit: firstCommit })
    expect(fetch.mock.calls[0]?.[0]).toContain(`/git/commits/${firstCommit}`)
  })

  it('rejects links, submodules, incomplete trees and bytes inconsistent with the commit', async () => {
    const { state, fetch, options } = github()
    const { source } = await findExternalPluginSource(repositoryUrl, options)
    for (const mode of ['120000', '160000']) {
      state.mode = mode
      fetch.mockClear()
      await expect(readExternalPlugin(source, '', options)).rejects.toMatchObject({ code: 'plugin-external-path' })
      expect(fetch.mock.calls.some(([url]) => url.endsWith('/SKILL.md'))).toBe(false)
    }
    state.mode = '100644'
    state.brokenHash = true
    await expect(readExternalPlugin(source, '', options)).rejects.toMatchObject({ code: 'plugin-external-github-invalid' })
    state.truncated = true
    await expect(listExternalPlugins(source, options)).rejects.toMatchObject({ code: 'plugin-external-github-invalid' })
  })

  it('does not follow redirects, use credentials or mask a policy rejection', async () => {
    const { options } = github()
    const fetch = vi.fn<FetchLike>(async () => new Response(null, { status: 302, headers: { location: 'https://example.test/catalog' } }))
    await expect(findExternalPluginSource(repositoryUrl, { ...options, fetch })).rejects.toMatchObject({
      code: 'plugin-external-github-invalid',
    })
    for (const address of [
      'http://github.com/a/b',
      'https://github.com.evil.test/a/b',
      'https://github.com/a/b?download=1',
      'https://github.com/a/b/tree/../main',
    ]) {
      await expect(findExternalPluginSource(address, { ...options, fetch })).rejects.toMatchObject({
        code: 'plugin-external-source-invalid',
      })
    }
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(
      findExternalPluginSource(repositoryUrl, { ...options, fetch: async () => new Response(null, { status: 404 }) }),
    ).rejects.toMatchObject({
      code: 'plugin-external-github-unavailable',
    })
    await expect(
      findExternalPluginSource(repositoryUrl, {
        ...options,
        fetch: () => Promise.reject(new EgressDenied('api.github.com', 'private', 'Refused')),
      }),
    ).rejects.toMatchObject({ code: 'egress-denied' })
  })

  it('distinguishes a GitHub outage, an unreadable repository and rate limiting', async () => {
    const { options } = github()
    for (const [status, remaining, code] of [
      [503, '19', 'plugin-external-github-unreachable'],
      [403, '19', 'plugin-external-github-unavailable'],
      [403, '0', 'plugin-external-github-rate-limit'],
    ] as const) {
      const headers = { 'x-ratelimit-remaining': remaining }
      await expect(
        findExternalPluginSource(repositoryUrl, {
          ...options,
          fetch: async () => new Response(null, { status, headers }),
        }),
      ).rejects.toMatchObject({ code })
    }
  })
})
