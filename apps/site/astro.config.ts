import { catalogPackages } from '../../examples/marketplace/build.ts'
import { defineConfig, passthroughImageService } from 'astro/config'

// The public address: canonical links, hreflang, Open Graph URLs and the sitemap are all derived from it.
// SITE_URL overrides it, for a preview on another address.
const site = process.env.SITE_URL || 'https://latch.codes'

export default defineConfig({
  site,
  vite: { define: { __LATCH_CATALOG_PACKAGES__: JSON.stringify(catalogPackages()) } },
  trailingSlash: 'always',
  build: { format: 'directory', inlineStylesheets: 'always' },
  compressHTML: true,
  // Pictures arrive already encoded (AVIF and WebP), so Astro never transforms images and needs no sharp.
  image: { service: passthroughImageService() },
  devToolbar: { enabled: false },
  prefetch: { prefetchAll: false, defaultStrategy: 'hover' },
})
