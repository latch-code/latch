import catalog from '../../../examples/latch.catalog.json'
import { loadCatalogBundle } from '../../../examples/marketplace/bundles.ts'

export type Facet = 'skill' | 'panel' | 'app' | 'tool'
export const FACETS: Facet[] = ['skill', 'panel', 'app', 'tool']

// What a plugin's code can reach, read from its own manifest: an isolated page wins over nothing, trusted Host code
// over a trusted panel, and a package with only skills or data panels runs no code at all (docs/PLUGIN-DEVELOPMENT.md).
export type Tier = 'text' | 'host' | 'panel' | 'page'
export type Capability =
  | { kind: 'read' | 'continue' | 'readOwn' }
  | { kind: 'start'; projects: 'any' | number }
  | { kind: 'storage'; scopes: string[] }

interface Manifest {
  id: string
  version: string
  host?: unknown[]
  panels?: unknown[]
  apps?: { capabilities?: Record<string, unknown> }[]
}

function access(manifest: Manifest): { tier: Tier; confirm: boolean; capabilities: Capability[] } {
  const host = (manifest.host?.length ?? 0) > 0
  const panels = (manifest.panels?.length ?? 0) > 0
  const apps = manifest.apps ?? []
  const capabilities: Capability[] = []
  for (const app of apps) {
    for (const [name, value] of Object.entries(app.capabilities ?? {})) {
      if (name === 'tasks.read' && value) capabilities.push({ kind: 'read' })
      else if (name === 'tasks.continue' && value) capabilities.push({ kind: 'continue' })
      else if (name === 'tasks.readOwn' && value) capabilities.push({ kind: 'readOwn' })
      else if (name === 'tasks.start' && value) {
        const projects = (value as { projects?: unknown }).projects
        capabilities.push({ kind: 'start', projects: Array.isArray(projects) ? projects.length : 'any' })
      } else if (name === 'storage' && Array.isArray(value)) capabilities.push({ kind: 'storage', scopes: value.map(String) })
      else if (value) throw new Error(`Unlisted page capability ${name} in ${manifest.id}: add its label to the site`)
    }
  }
  const tier: Tier = host ? 'host' : panels ? 'panel' : apps.length ? 'page' : 'text'
  return { tier, confirm: host || panels || apps.length > 0, capabilities }
}

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
      const facets = entry.facets.filter((facet): facet is Facet => (FACETS as string[]).includes(facet))
      return {
        entry,
        version: bundle.manifest.version,
        name,
        body,
        sha256,
        artifact,
        file,
        href: '/plugins/' + file,
        facets,
        access: access(bundle.manifest as Manifest),
      }
    }),
  )
}
