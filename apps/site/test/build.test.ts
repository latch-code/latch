import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { catalogPackages } from '../../../examples/marketplace/build.ts'
import { checkSeo } from '../scripts/seo-check.ts'

const run = promisify(execFile)
const SITE = fileURLToPath(new URL('..', import.meta.url))
const ORIGIN = 'https://site.test'
let folder = ''
let dist = ''

// One real Astro build into a temporary directory; the cases read its output. Telemetry stays off.
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'latch-site-'))
  dist = join(folder, 'dist')
  await run(join(SITE, 'node_modules/.bin/astro'), ['build', '--root', SITE, '--outDir', dist, '--silent'], {
    cwd: SITE,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', SITE_URL: ORIGIN },
  })
}, 120_000)

afterAll(async () => {
  if (folder) await rm(folder, { recursive: true, force: true })
})

it('builds every page in both languages with no SEO or link problems', () => {
  const { pages, problems } = checkSeo(dist)
  expect(problems).toEqual([])
  expect(pages.map(page => [page.path, page.lang])).toEqual([
    ['/404.html', 'en'],
    ['/download/', 'en'],
    ['/', 'en'],
    ['/plugins/', 'en'],
    ['/zh/download/', 'zh-CN'],
    ['/zh/', 'zh-CN'],
    ['/zh/plugins/', 'zh-CN'],
  ])
})

it('derives canonical links, the sitemap and robots.txt from SITE_URL', async () => {
  const home = await readFile(join(dist, 'zh/download/index.html'), 'utf8')
  expect(home).toContain(`<link rel="canonical" href="${ORIGIN}/zh/download/"`)
  const sitemap = await readFile(join(dist, 'sitemap.xml'), 'utf8')
  const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(match => match[1])
  expect(listed.toSorted()).toEqual([
    `${ORIGIN}/`,
    `${ORIGIN}/download/`,
    `${ORIGIN}/plugins/`,
    `${ORIGIN}/zh/`,
    `${ORIGIN}/zh/download/`,
    `${ORIGIN}/zh/plugins/`,
  ])
  expect(await readFile(join(dist, 'robots.txt'), 'utf8')).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`)
  expect(await readFile(join(dist, '404.html'), 'utf8')).toMatch(/name="robots" content="noindex"/u)
})

it('publishes the package a marketplace visitor actually downloads at its advertised digest', async () => {
  const catalog = JSON.parse(await readFile(join(dist, 'plugins/latch.catelog.json'), 'utf8')) as {
    formatVersion: number
    plugins: { id: string; version: string; sha256: string; bundle: string }[]
  }
  const index = JSON.parse(await readFile(join(dist, 'plugins/catalog.json'), 'utf8')) as {
    formatVersion: number
    plugins: { id: string; version: string; sha256: string; url: string }[]
  }
  expect(catalog.formatVersion).toBe(1)
  expect(index.plugins).toEqual(catalog.plugins.map(({ bundle, ...plugin }) => ({ ...plugin, url: '/plugins/' + bundle })))
  const page = await readFile(join(dist, 'zh/plugins/index.html'), 'utf8')
  expect(index.plugins.map(plugin => plugin.id)).toContain('context-insights')
  for (const { id, version, sha256, url } of index.plugins) {
    expect(page).toContain(`href="${url}"`)
    const bytes = await readFile(join(dist, url))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256)
    expect(JSON.parse(bytes.toString())).toMatchObject({ manifest: { id, version }, files: expect.any(Array) })
  }
})

it.each([
  ['examples', 'directory', 'symlink'],
  ['examples/latch.catelog.json', 'file', 'symlink'],
  ['examples/sample', 'directory', 'symlink'],
  ['examples/sample/latch-plugin.json', 'file', 'symlink'],
  ['examples/sample/src', 'directory', 'symlink'],
  ['examples/sample/src/panel.mjs', 'file', 'symlink'],
  ['examples/sample/src/panel.mjs', 'file', 'hardlink'],
  ['examples/sample/src/panel.mjs', 'file', 'directory'],
] as const)('rejects a release input at %s when it is a %s replaced with a %s', async (input, kind, replacement) => {
  const fixture = await mkdtemp(join(folder, 'catalog-'))
  const repository = join(fixture, 'checkout')
  const examples = join(repository, 'examples')
  const manifest = { id: 'sample', version: '1.0.0' }
  const content = 'export default function Panel() { return null }\n'
  await mkdir(join(examples, 'sample/src'), { recursive: true })
  await writeFile(
    join(examples, 'latch.catelog.json'),
    JSON.stringify({ plugins: [{ id: 'sample', folder: 'sample', manifest: 'latch-plugin.json', files: ['src/panel.mjs'] }] }),
  )
  await writeFile(join(examples, 'sample/latch-plugin.json'), JSON.stringify(manifest))
  await writeFile(join(examples, 'sample/src/panel.mjs'), content)
  expect(catalogPackages(repository)).toEqual({ sample: { manifest, files: [{ path: 'src/panel.mjs', content }] } })

  const original = join(fixture, 'outside-source')
  const path = join(repository, input)
  await rename(path, original)
  if (replacement === 'symlink') await symlink(original, path, kind === 'file' ? 'file' : 'dir')
  else if (replacement === 'hardlink') await link(original, path)
  else await mkdir(path)
  expect(() => catalogPackages(repository)).toThrow(/Invalid catalog source/u)
})

it('renders the four featured cover samples in both languages', async () => {
  for (const [pagePath, request, toolDefinitions] of [
    ['plugins/index.html', 'Request 4', 'Tool definitions'],
    ['zh/plugins/index.html', '第 4 次请求', '工具定义'],
  ] as const) {
    const page = await readFile(join(dist, pagePath), 'utf8')
    const article = (id: string) => page.match(new RegExp(`<article\\b[^>]*\\bid="${id}"[^>]*>(.*?)</article>`, 'su'))?.[1] ?? ''
    const handoff = article('shift-handoff')
    expect(handoff).toContain('data-note="done"')
    expect(handoff).toContain('data-note="next"')
    expect([...article('release-review').matchAll(/\bdata-complete\b/gu)]).toHaveLength(2)
    const release = article('release-check')
    expect(release).toContain('data-state="passed"')
    expect(release).toContain('data-state="pending"')
    const context = article('context-insights')
    expect(context).toContain(request)
    expect(context).toContain(toolDefinitions)
    expect([...context.matchAll(/\bdata-selected\b/gu)]).toHaveLength(1)
    expect([...context.matchAll(/\bflex-grow:\s*(\d+)/gu)].map(match => match[1])).toEqual(['55', '42', '2', '1'])
  }
})

it('reports a page that breaks the invariants', async () => {
  const page = join(dist, 'broken')
  await mkdir(page)
  const template = await readFile(join(dist, 'download/index.html'), 'utf8')
  await writeFile(
    join(page, 'index.html'),
    template.replace('</main>', '<h1>Second</h1><a href="/missing/">x</a><a href="#nowhere">y</a><img src="/x.png"></main>'),
  )
  try {
    const { problems } = checkSeo(dist)
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\/broken\/: canonical .* is not this page$/u),
        '/download/: title is the same as /broken/',
        '/broken/: 2 h1 elements',
        '/broken/: link to missing page /missing/',
        '/broken/: fragment #nowhere has no target',
        expect.stringMatching(/^\/broken\/: img without alt/u),
      ]),
    )
  } finally {
    await rm(page, { recursive: true, force: true })
  }
})
