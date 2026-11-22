import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, it } from 'vitest'
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
    ['/zh/download/', 'zh-CN'],
    ['/zh/', 'zh-CN'],
  ])
})

it('derives canonical links, the sitemap and robots.txt from SITE_URL', async () => {
  const home = await readFile(join(dist, 'zh/download/index.html'), 'utf8')
  expect(home).toContain(`<link rel="canonical" href="${ORIGIN}/zh/download/"`)
  const sitemap = await readFile(join(dist, 'sitemap.xml'), 'utf8')
  const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(match => match[1])
  expect(listed.toSorted()).toEqual([`${ORIGIN}/`, `${ORIGIN}/download/`, `${ORIGIN}/zh/`, `${ORIGIN}/zh/download/`])
  expect(await readFile(join(dist, 'robots.txt'), 'utf8')).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`)
  expect(await readFile(join(dist, '404.html'), 'utf8')).toMatch(/name="robots" content="noindex"/u)
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
