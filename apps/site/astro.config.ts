import { defineConfig, passthroughImageService } from 'astro/config'

// The public address: canonical links, hreflang, Open Graph URLs and the sitemap are all derived from it.
// SITE_URL overrides it, for a preview on another address.
const site = process.env.SITE_URL || 'https://latch.codes'

export default defineConfig({
  site,
  trailingSlash: 'always',
  build: { format: 'directory', inlineStylesheets: 'always' },
  compressHTML: true,
  // Pictures arrive already encoded (AVIF and WebP), so Astro never transforms images and needs no sharp.
  image: { service: passthroughImageService() },
  devToolbar: { enabled: false },
  prefetch: { prefetchAll: false, defaultStrategy: 'hover' },
})
