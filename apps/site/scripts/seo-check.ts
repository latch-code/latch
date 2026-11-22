import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** One built page as the report lists it. */
export interface PageNote {
  path: string
  lang: string
  title: number
  description: number
  h1: number
}

export interface SeoReport {
  pages: PageNote[]
  problems: string[]
}

/** Files every build ships at the site root. */
const ROOT_FILES = ['robots.txt', 'sitemap.xml', 'site.webmanifest', 'favicon.ico', 'apple-touch-icon.png']
const OG_PROPERTIES = ['og:title', 'og:description', 'og:image', 'og:url', 'og:type', 'og:image:alt']
const HREFLANGS = ['en', 'zh-CN', 'x-default']

function htmlFiles(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) found.push(...htmlFiles(path))
    else if (name.endsWith('.html')) found.push(path)
  }
  return found.toSorted()
}

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`, 'u').exec(tag)?.[1]
const meta = (html: string, key: string, value: string): string | undefined =>
  [...html.matchAll(/<meta\s[^>]*>/gu)].map(match => match[0]).find(tag => attr(tag, key) === value)
const ids = (html: string): Set<string> => new Set([...html.matchAll(/\sid="([^"]+)"/gu)].map(match => match[1]))

/**
 * Static SEO and link checks over a built site: unique titles and descriptions within length, canonical and the
 * hreflang trio, Open Graph, one h1 and no skipped heading level, image alts, duplicate ids, JSON-LD that parses, every
 * internal link and #fragment resolving, the sitemap and robots.txt, and a 404 page that is not indexed.
 */
export function checkSeo(dist: string): SeoReport {
  const problems: string[] = []
  const pages: PageNote[] = []
  const fileFor = (urlPath: string): string | undefined => {
    const path = join(dist, urlPath.split('#')[0].split('?')[0])
    if (existsSync(path) && statSync(path).isFile()) return path
    if (existsSync(join(path, 'index.html'))) return join(path, 'index.html')
    return undefined
  }
  const home = readFileSync(join(dist, 'index.html'), 'utf8')
  const homeCanonical = attr(/<link rel="canonical"[^>]*>/u.exec(home)?.[0] ?? '', 'href')
  if (!homeCanonical) return { pages, problems: ['/: no canonical, so the site origin is unknown'] }
  const origin = new URL(homeCanonical).origin
  const titles = new Map<string, string>()
  const descriptions = new Map<string, string>()

  for (const file of htmlFiles(dist)) {
    const html = readFileSync(file, 'utf8')
    const path = `/${relative(dist, file)
      .replaceAll('\\', '/')
      .replace(/index\.html$/u, '')}`
    const say = (message: string) => problems.push(`${path}: ${message}`)
    const notFound = path.startsWith('/404')
    const lang = /<html[^>]*\slang="([^"]+)"/u.exec(html)?.[1]
    if (!lang) say('no <html lang>')
    const zh = lang?.startsWith('zh') ?? false
    const title = /<title>([^<]*)<\/title>/u.exec(html)?.[1] ?? ''
    const description = attr(meta(html, 'name', 'description') ?? '', 'content') ?? ''
    const titleLength = [...title].length
    const descriptionLength = [...description].length
    if (!title) say('no title')
    else if (titleLength > (zh ? 32 : 60)) say(`title ${titleLength} chars (keep it under ${zh ? 32 : 60})`)
    if (!description) say('no meta description')
    else if (!notFound && (zh ? descriptionLength < 40 || descriptionLength > 90 : descriptionLength < 70 || descriptionLength > 160))
      say(`description ${descriptionLength} chars (${zh ? '40 to 90' : '70 to 160'})`)
    if (!notFound) {
      const sameTitle = titles.get(title)
      if (title && sameTitle) say(`title is the same as ${sameTitle}`)
      titles.set(title, path)
      const sameDescription = descriptions.get(description)
      if (description && sameDescription) say(`description is the same as ${sameDescription}`)
      descriptions.set(description, path)
    }

    const canonical = attr(/<link rel="canonical"[^>]*>/u.exec(html)?.[0] ?? '', 'href')
    if (!canonical) say('no canonical')
    else if (!notFound && new URL(canonical).pathname !== path) say(`canonical ${canonical} is not this page`)
    if (notFound) {
      if (!/name="robots" content="noindex"/u.test(html)) say('404 page is indexable')
    } else {
      const alternates = [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/gu)].map(match => [match[1], match[2]])
      for (const want of HREFLANGS) if (!alternates.some(([tag]) => tag === want)) say(`no hreflang ${want}`)
      for (const [tag, url] of alternates) if (!fileFor(new URL(url).pathname)) say(`hreflang ${tag} points to a missing page ${url}`)
      if (!alternates.some(([, url]) => url === canonical)) say('hreflang set does not include this page')
      for (const property of OG_PROPERTIES) if (!meta(html, 'property', property)) say(`no ${property}`)
      if (!meta(html, 'name', 'twitter:card')) say('no twitter:card')
      const ogImage = attr(meta(html, 'property', 'og:image') ?? '', 'content')
      if (ogImage && !fileFor(new URL(ogImage).pathname)) say(`og:image missing: ${ogImage}`)
      for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gu)) {
        try {
          JSON.parse(match[1])
        } catch {
          say('JSON-LD does not parse')
        }
      }
    }

    const h1 = html.match(/<h1[\s>]/gu)?.length ?? 0
    if (h1 !== 1) say(`${h1} h1 elements`)
    const levels = [...html.matchAll(/<h([1-6])[\s>]/gu)].map(match => Number(match[1]))
    levels.forEach((level, index) => {
      if (index > 0 && level > levels[index - 1] + 1) say(`heading jumps from h${levels[index - 1]} to h${level}`)
    })
    for (const match of html.matchAll(/<img\s[^>]*>/gu))
      if (!/\salt(=|[\s>/])/u.test(match[0])) say(`img without alt: ${match[0].slice(0, 80)}`)
    const seen = new Map<string, number>()
    for (const match of html.matchAll(/\sid="([^"]+)"/gu)) seen.set(match[1], (seen.get(match[1]) ?? 0) + 1)
    for (const [id, count] of seen) if (count > 1) say(`id "${id}" used ${count} times`)

    const own = ids(html)
    for (const match of html.matchAll(/<a\s[^>]*href="([^"]+)"/gu)) {
      const href = match[1]
      if (/^(https?:|mailto:)/u.test(href)) {
        if (href.startsWith(origin)) say(`absolute internal link ${href}`)
        continue
      }
      if (href.startsWith('#')) {
        if (href.length > 1 && !own.has(href.slice(1))) say(`fragment ${href} has no target`)
        continue
      }
      const target = fileFor(href.startsWith('/') ? href : new URL(href, `http://site${path}`).pathname)
      if (!target) {
        say(`link to missing page ${href}`)
        continue
      }
      const fragment = href.split('#')[1]
      if (fragment && !ids(readFileSync(target, 'utf8')).has(fragment)) say(`link ${href}: no #${fragment} on that page`)
    }
    pages.push({ path, lang: lang ?? '', title: titleLength, description: descriptionLength, h1 })
  }

  for (const name of ROOT_FILES) if (!existsSync(join(dist, name))) problems.push(`missing /${name}`)
  if (existsSync(join(dist, 'sitemap.xml'))) {
    const sitemap = readFileSync(join(dist, 'sitemap.xml'), 'utf8')
    const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(match => match[1])
    if (listed.length === 0) problems.push('sitemap lists no pages')
    for (const url of listed) if (!fileFor(new URL(url).pathname)) problems.push(`sitemap lists a missing page ${url}`)
  }
  if (existsSync(join(dist, 'robots.txt')) && !readFileSync(join(dist, 'robots.txt'), 'utf8').includes('Sitemap:'))
    problems.push('robots.txt names no sitemap')
  return { pages, problems }
}
