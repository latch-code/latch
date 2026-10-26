import type { PluginPackageBundle } from '@latch/protocol'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'

/** Display metadata is excluded; skill instructions and every supplied source/config byte remain execution inputs. */
export function personalPluginRevision(bundle: PluginPackageBundle): string {
  const manifest = bundle.manifest
  return sha256Hex(
    canonicalJson({
      id: manifest.id,
      host: manifest.host,
      config: manifest.config,
      skills: manifest.skills,
      panels: (manifest.panels ?? []).map(panel => ({ id: panel.id, entry: panel.entry, harnessIds: panel.harnessIds ?? [] })),
      files: bundle.files,
    }),
  )
}
