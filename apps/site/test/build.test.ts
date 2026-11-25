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
import { heroTimeline, parseFilms } from '../src/media.ts'

const run = promisify(execFile)
const SITE = fileURLToPath(new URL('..', import.meta.url))
const ORIGIN = 'https://site.test'
let folder = ''
let dist = ''
let staged = ''

// The cases build with their own media index, so they hold whatever films the repository carries at the time.
const HERO = {
  duration: 11.738,
  marks: {
    typing: 0.25,
    team: 2.9,
    needs: 5.737,
    hold_start: 7.037,
    tap: 8.037,
    allowed: 8.438,
    handed_back: 9.038,
    settled: 10.738,
    end: 11.738,
  } as Record<string, number>,
  mac: { mp4: 'hero-mac.0123abcd.mp4', mp4Small: 'hero-mac-sm.0123abcd.mp4' },
  phone: { mp4: 'hero-phone.0123abcd.mp4', mp4Small: 'hero-phone-sm.0123abcd.mp4' },
  allow: { left: 51, top: 67, width: 40, height: 5 },
}
const FILM = {
  mp4: 'context-panel.0123abcd.mp4',
  mp4Small: 'context-panel-sm.0123abcd.mp4',
  poster: 'context-panel.0123abcd.webp',
  width: 1600,
  height: 1000,
  duration: 8,
  alt: 'The Context panel beside a conversation.',
}
// A longer film as the capture job would deliver it: eight steps, two segments, labels for steps the site has no name for.
const LABELS = { en: 'Extra step', zh: '额外一步' }
const EIGHT = {
  ...HERO,
  steps: [
    { id: 'ask', at: 0 },
    { id: 'plan', at: 1, label: LABELS },
    { id: 'team', at: 'team' },
    { id: 'needs', at: 'needs', hold: true },
    { id: 'allow', at: 'tap' },
    { id: 'review', at: 9, label: LABELS },
    { id: 'ship', at: 10, label: LABELS },
    { id: 'done', at: 'settled' },
  ],
  segments: [
    { from: 0, to: 6, mac: HERO.mac, phone: HERO.phone },
    { from: 6, to: HERO.duration, mac: HERO.mac, phone: HERO.phone },
  ],
}

const build = (out: string, env: Record<string, string> = {}) =>
  run(join(SITE, 'node_modules/.bin/astro'), ['build', '--root', SITE, '--outDir', out, '--silent'], {
    cwd: SITE,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', SITE_URL: ORIGIN, ...env },
  })

// Real Astro builds into a temporary directory; the cases read their output. Telemetry stays off. Both builds take
// their media index through SITE_FILMS and SITE_HERO: the first has no films and a five-step hero, the second stages a
// film and an eight-step, two-segment hero.
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'latch-site-'))
  dist = join(folder, 'dist')
  staged = join(folder, 'staged')
  await writeFile(join(folder, 'no-films.json'), '{}')
  await writeFile(join(folder, 'short-hero.json'), JSON.stringify(HERO))
  await build(dist, { SITE_FILMS: join(folder, 'no-films.json'), SITE_HERO: join(folder, 'short-hero.json') })
  await writeFile(join(folder, 'films.json'), JSON.stringify({ 'context-panel': { en: FILM } }))
  await writeFile(join(folder, 'hero.json'), JSON.stringify(EIGHT))
  await build(staged, { SITE_FILMS: join(folder, 'films.json'), SITE_HERO: join(folder, 'hero.json') })
}, 240_000)

afterAll(async () => {
  if (folder) await rm(folder, { recursive: true, force: true })
})

it('builds every page in both languages with no SEO or link problems', () => {
  const { pages, problems } = checkSeo(dist)
  expect(problems).toEqual([])
  // One page per plugin in the catalog, in both languages.
  const ids = Object.keys(catalogPackages()).toSorted()
  const listed = (lang: string, prefix: string) => [
    [`${prefix}/`, lang],
    [`${prefix}/download/`, lang],
    [`${prefix}/plugins/`, lang],
    ...ids.map(id => [`${prefix}/plugins/${id}/`, lang]),
  ]
  const byPath = (a: string[], b: string[]) => a[0]!.localeCompare(b[0]!)
  expect(pages.map(page => [page.path, page.lang]).toSorted(byPath)).toEqual(
    [['/404.html', 'en'], ...listed('en', ''), ...listed('zh-CN', '/zh')].toSorted(byPath),
  )
})

it('derives canonical links, the sitemap and robots.txt from SITE_URL', async () => {
  const home = await readFile(join(dist, 'zh/download/index.html'), 'utf8')
  expect(home).toContain(`<link rel="canonical" href="${ORIGIN}/zh/download/"`)
  const sitemap = await readFile(join(dist, 'sitemap.xml'), 'utf8')
  const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(match => match[1])
  const plugins = Object.keys(catalogPackages())
  expect(listed.toSorted()).toEqual(
    [
      `${ORIGIN}/`,
      `${ORIGIN}/download/`,
      `${ORIGIN}/plugins/`,
      ...plugins.map(id => `${ORIGIN}/plugins/${id}/`),
      `${ORIGIN}/zh/`,
      `${ORIGIN}/zh/download/`,
      `${ORIGIN}/zh/plugins/`,
      ...plugins.map(id => `${ORIGIN}/zh/plugins/${id}/`),
    ].toSorted(),
  )
  expect(await readFile(join(dist, 'robots.txt'), 'utf8')).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`)
  expect(await readFile(join(dist, '404.html'), 'utf8')).toMatch(/name="robots" content="noindex"/u)
})

it('publishes the package a marketplace visitor actually downloads at its advertised digest', async () => {
  const catalog = JSON.parse(await readFile(join(dist, 'plugins/latch.catalog.json'), 'utf8')) as {
    formatVersion: number
    plugins: { id: string; version: string; sha256: string; bundle: string }[]
  }
  const index = JSON.parse(await readFile(join(dist, 'plugins/catalog.json'), 'utf8')) as {
    formatVersion: number
    plugins: { id: string; version: string; sha256: string; url: string }[]
  }
  expect(catalog.formatVersion).toBe(1)
  expect(index.plugins).toEqual(catalog.plugins.map(({ bundle, ...plugin }) => ({ ...plugin, url: '/plugins/' + bundle })))
  expect(index.plugins.map(plugin => plugin.id)).toContain('context-insights')
  for (const { id, version, sha256, url } of index.plugins) {
    // Each plugin's own page offers the download.
    expect(await readFile(join(dist, 'zh/plugins', id, 'index.html'), 'utf8')).toContain(`href="${url}"`)
    const bytes = await readFile(join(dist, url))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256)
    expect(JSON.parse(bytes.toString())).toMatchObject({ manifest: { id, version }, files: expect.any(Array) })
  }
})

it.each([
  ['examples', 'directory', 'symlink'],
  ['examples/latch.catalog.json', 'file', 'symlink'],
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
    join(examples, 'latch.catalog.json'),
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

it('derives what each plugin can access from its own manifest', async () => {
  const page = await readFile(join(dist, 'plugins/index.html'), 'utf8')
  const card = (id: string) => page.match(new RegExp(`<article\\b[^>]*\\bid="${id}"[^>]*>(.*?)</article>`, 'su'))?.[1] ?? ''
  const detail = (id: string) => readFile(join(dist, 'plugins', id, 'index.html'), 'utf8')
  expect(card('shift-handoff')).toContain('data-tier="text"')
  expect(card('shift-handoff')).toContain('href="/plugins/shift-handoff/"')
  expect(await detail('shift-handoff')).not.toContain('Applying it asks for confirmation on the Mac.')
  expect(card('release-review')).toContain('data-tier="host"')
  expect(card('context-insights')).toContain('data-tier="panel"')
  const page4 = await detail('release-check')
  expect(page4).toContain('data-tier="page"')
  for (const capability of [
    'Read session summaries',
    'Start sessions in any project',
    'Read replies from sessions it started',
    'Storage: plugin, project',
  ])
    expect(page4).toContain(capability)
  // Without scripting each filter is a link to a target that the stylesheet filters on.
  for (const facet of ['skill', 'panel', 'app', 'tool']) {
    expect(page).toContain(`href="#provides-${facet}"`)
    expect(page).toContain(`id="provides-${facet}"`)
  }
})

it('keeps every film slot on its still when there is no film for it', async () => {
  for (const path of ['index.html', 'zh/index.html', 'plugins/index.html', 'zh/plugins/index.html']) {
    const page = await readFile(join(dist, path), 'utf8')
    expect(page).not.toContain('data-clip')
    expect(page).not.toMatch(/<video[^>]*class="clip__video"/u)
  }
  const home = await readFile(join(dist, 'index.html'), 'utf8')
  expect(home).toContain('data-preview="context"')
  expect([...home.matchAll(/class="chapter"/gu)]).toHaveLength(5)
  expect([...home.matchAll(/<button[^>]*class="chapter"[^>]*data-hold/gu)]).toHaveLength(1)
})

it('renders a staged film and an eight-step hero in two segments', async () => {
  expect(checkSeo(staged).problems).toEqual([])
  const en = await readFile(join(staged, 'index.html'), 'utf8')
  const zh = await readFile(join(staged, 'zh/index.html'), 'utf8')
  const clip = en.match(/<figure[^>]*data-clip="context-panel"[^>]*>(.*?)<\/figure>/su)
  expect(clip?.[0]).toContain('aspect-ratio: 1600 / 1000')
  expect(clip?.[1]).toMatch(
    /<img[^>]*src="\/img\/context-panel\.0123abcd\.webp"[^>]*width="1600"[^>]*height="1000"[^>]*alt="The Context panel/u,
  )
  expect(clip?.[1]).toMatch(/<video[^>]*preload="none"[^>]*data-src="\/video\/context-panel\.0123abcd\.mp4"/u)
  expect(clip?.[1]).not.toMatch(/<video[^>]*\ssrc=/u)
  expect(clip?.[1]).toMatch(/<button[^>]*data-clip-toggle[^>]*hidden/u)
  // No entry for Chinese: the slot keeps its live cover.
  expect(zh).not.toContain('data-clip')
  expect(zh).toContain('data-preview="context"')

  expect([...en.matchAll(/class="chapter"/gu)]).toHaveLength(8)
  expect(en).toContain('--steps: 8')
  expect(en).toContain('>Extra step<')
  expect(zh).toContain('>额外一步<')
  const segments = JSON.parse(en.match(/data-segments="([^"]+)"/u)![1]!.replaceAll('&quot;', '"')) as { from: number; to: number }[]
  expect(segments.map(s => [s.from, s.to])).toEqual([
    [0, 6],
    [6, HERO.duration],
  ])
})

it('checks the media contracts', () => {
  expect(parseFilms({ 'plugin-market': { zh: FILM } })).toEqual({ 'plugin-market': { zh: FILM } })
  expect(() => parseFilms({ 'not-a-slot': { en: FILM } })).toThrow(/films\.not-a-slot is not a film slot/u)
  expect(() => parseFilms({ 'plugin-market': { en: { ...FILM, mp4: 'film.mp4' } } })).toThrow(
    /mp4 must be a file name with a content hash/u,
  )
  expect(() => parseFilms({ 'plugin-market': { en: { ...FILM, autoplay: true } } })).toThrow(/autoplay is not part of the contract/u)
  expect(() => parseFilms({ 'plugin-market': { en: { ...FILM, alt: ' ' } } })).toThrow(/alt must be non-empty text/u)

  const today = heroTimeline(HERO)
  expect(today.steps.map(s => [s.id, s.from, s.to])).toEqual([
    ['ask', 0, HERO.marks.team],
    ['team', HERO.marks.team, HERO.marks.needs],
    ['needs', HERO.marks.needs, HERO.marks.tap],
    ['allow', HERO.marks.tap, HERO.marks.handed_back],
    ['done', HERO.marks.handed_back, HERO.duration],
  ])
  expect(today.hold).toBeCloseTo(HERO.marks.hold_start! + 0.6)
  expect(today.allowed).toBe(HERO.marks.allowed)
  expect(today.segments).toHaveLength(1)

  expect(heroTimeline(EIGHT).steps).toHaveLength(8)
  const nine = { ...EIGHT, steps: [...EIGHT.steps, { id: 'more', at: 11 }] }
  expect(() => heroTimeline(nine)).toThrow(/hero\.steps must list 2 to 8 steps/u)
  const gap = { ...EIGHT, segments: [EIGHT.segments[0], { ...EIGHT.segments[1], from: 7 }] }
  expect(() => heroTimeline(gap)).toThrow(/segments\[1\]\.from must start where the segment before it ends/u)
  const order = { ...EIGHT, steps: [EIGHT.steps[0], { id: 'late', at: 'nowhere' }] }
  expect(() => heroTimeline(order)).toThrow(/names mark "nowhere", which is missing/u)
  const twoHolds = { ...EIGHT, steps: EIGHT.steps.map(s => ({ ...s, hold: true })) }
  expect(() => heroTimeline(twoHolds)).toThrow(/may hold at one step only/u)
})
