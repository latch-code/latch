import { defineConfig, passthroughImageService } from 'astro/config'

// The public address. Set SITE_URL when building for the real domain; canonical links, hreflang,
// Open Graph URLs and the sitemap are all derived from it. latch.example is a reserved placeholder.
const site = process.env.SITE_URL || 'https://latch.example'

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
