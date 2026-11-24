import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { catalogPackages } from '../../examples/marketplace/build.ts'
import { defineConfig, passthroughImageService } from 'astro/config'
import { heroTimeline, parseFilms } from './src/media.ts'

// The public address: canonical links, hreflang, Open Graph URLs and the sitemap are all derived from it.
// SITE_URL overrides it, for a preview on another address.
const site = process.env.SITE_URL || 'https://latch.codes'

// Media tables written by the generator outside this repository, checked against their contract (src/media.ts).
// SITE_HERO and SITE_FILMS point at other copies, for tests and for trying a delivery before it replaces the files.
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as unknown
const hero = readJson(process.env.SITE_HERO || fileURLToPath(new URL('./src/hero.json', import.meta.url)))
const films = parseFilms(readJson(process.env.SITE_FILMS || fileURLToPath(new URL('./src/films.json', import.meta.url))))

export default defineConfig({
  site,
  vite: {
    define: {
      __LATCH_CATALOG_PACKAGES__: JSON.stringify(catalogPackages()),
      __LATCH_HERO__: JSON.stringify({ media: hero, timeline: heroTimeline(hero) }),
      __LATCH_FILMS__: JSON.stringify(films),
    },
  },
  trailingSlash: 'always',
  build: { format: 'directory', inlineStylesheets: 'always' },
  compressHTML: true,
  // Pictures arrive already encoded (AVIF and WebP), so Astro never transforms images and needs no sharp.
  image: { service: passthroughImageService() },
  devToolbar: { enabled: false },
  prefetch: { prefetchAll: false, defaultStrategy: 'hover' },
})
