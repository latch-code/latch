import type { PluginCatalogUpdateStatus } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { catalogPackages } from '../../../examples/marketplace/build.ts'
import type { PluginAssetDescriptor } from './plugin-assets.ts'
import { checkedPluginBundle } from './plugin-package-bundle.ts'
import { compareReleaseVersions, releaseVersionSchema } from './npm-source.ts'

declare const LATCH_HOST_CATALOG: Record<string, unknown>
type CatalogBundle = ReturnType<typeof checkedPluginBundle>

/** Bundled Hosts use immutable build input. Source-mode Hosts use the same repository catalog as Vite. */
function catalog(): Map<string, CatalogBundle> {
  const entries = typeof LATCH_HOST_CATALOG === 'undefined' ? catalogPackages() : LATCH_HOST_CATALOG
  return new Map(
    Object.entries(entries).map(([id, bundle]) => {
      const entry = checkedPluginBundle(bundle)
      if (entry.bundle.manifest.id !== id || !releaseVersionSchema.safeParse(entry.bundle.manifest.version).success)
        throw new Error('Invalid bundled plugin release')
      return [id, entry]
    }),
  )
}
let releases: Map<string, CatalogBundle> | undefined

export function requireBundledPlugin(id: string): CatalogBundle {
  const release = (releases ??= catalog()).get(id)
  if (!release) throw new AppError(404, 'plugin-catalog-not-found', '随附目录没有这个插件。')
  return release
}

export function catalogUpdate(candidate: CatalogBundle, record: PluginAssetDescriptor): PluginCatalogUpdateStatus {
  const { revision, bundle } = candidate,
    version = bundle.manifest.version
  if (!record.catalog || record.npm || record.source) return 'different-source'
  if (record.revision !== record.catalog.revision) return 'local-changes'
  if (record.revision === revision) return 'current'
  const precedence = compareReleaseVersions(version, record.catalog.version)
  if (precedence !== 1) return precedence === 0 ? 'same-version-changed' : 'older'
  if (record.appliedVersion !== undefined) {
    const applied = compareReleaseVersions(version, record.appliedVersion)
    if (applied !== 1) return applied === 0 ? 'same-version-changed' : 'older'
  }
  return 'available'
}

export function catalogUpdateError(status: Exclude<PluginCatalogUpdateStatus, 'available'>): AppError {
  switch (status) {
    case 'current':
      return new AppError(409, 'plugin-catalog-current', '这个随附版本已暂存。')
    case 'older':
      return new AppError(409, 'plugin-catalog-older', '这个随附版本没有比草稿和已应用版本更新。')
    case 'local-changes':
      return new AppError(409, 'plugin-catalog-local-changes', '草稿有本机改动，已保留。')
    case 'different-source':
      return new AppError(409, 'plugin-catalog-different-source', '这个标识已被其他来源的插件使用，已保留其草稿。')
    default:
      return new AppError(409, 'plugin-catalog-same-version-changed', '随附版本号相同但内容不同，请等待带有新版本号的发行。')
  }
}
