import catalog from '../../../examples/latch.catelog.json'
import { loadCatalogBundle } from '../../../examples/marketplace/bundles.ts'

// The URL pins the actual bytes of the package. The index can change without changing existing download URLs.
export function marketplaceDownloads() {
  return Promise.all(
    catalog.plugins.map(async entry => {
      const bundle = loadCatalogBundle(entry)
      const body = JSON.stringify(bundle)
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
      const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      const name = entry.id + '-' + bundle.manifest.version
      const artifact = name + '-' + sha256 + '.latch-plugin'
      const file = 'files/' + artifact + '.json'
      return { entry, version: bundle.manifest.version, name, body, sha256, artifact, file, href: '/plugins/' + file }
    }),
  )
}
