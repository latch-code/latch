import type { APIRoute } from 'astro'
import { href, LANGS, type Lang } from '../i18n'
import catalog from '../../../../examples/latch.catalog.json'

const PAGES = ['/', '/download/', '/plugins/', ...catalog.plugins.map(plugin => `/plugins/${plugin.id}/`)]
const LANG_LIST: Lang[] = ['en', 'zh']

export const GET: APIRoute = ({ site }) => {
  const abs = (lang: Lang, path: string) => new URL(href(lang, path), site).href
  const today = new Date().toISOString().slice(0, 10)
  const urls = PAGES.flatMap(path =>
    LANG_LIST.map(lang => {
      const alternates = LANG_LIST.map(l => `    <xhtml:link rel="alternate" hreflang="${LANGS[l].tag}" href="${abs(l, path)}"/>`).join(
        '\n',
      )
      return `  <url>\n    <loc>${abs(lang, path)}</loc>\n    <lastmod>${today}</lastmod>\n${alternates}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${abs('en', path)}"/>\n  </url>`
    }),
  )
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
}
