import { compareReleaseVersions } from './npm-source.ts'
import { catalogUpdateError, requireBundledPlugin } from './plugin-catalog.ts'
import type { ExternalReaderOptions } from './plugin-external-files.ts'
import { readCatalogFolders } from './plugin-external-reader.ts'
import { officialArchiveFiles } from './plugin-official-archive.ts'
import { getOfficialArchive, resolveOfficialMain } from './plugin-official-source.ts'

const folders = new Map(['shift-handoff', 'release-review', 'release-check', 'context-insights'].map(id => [id, `plugins/${id}`]))
const freshFor = 5 * 60 * 1000

interface Release {
  checked: ReturnType<typeof requireBundledPlugin>
  commit?: string
}

/** Each Host keeps one complete, verified snapshot. Existing assets and their approvals live in PluginAssets. */
export function createOfficialCatalog(reader: Omit<ExternalReaderOptions, 'check'>) {
  let releases = new Map<string, Release>()
  let head: string | undefined
  let checkedAt = -Infinity
  let pending: Promise<void> | undefined

  function get(id: string): Release | undefined {
    if (!folders.has(id)) return undefined
    return releases.get(id) ?? { checked: requireBundledPlugin(id) }
  }

  async function refresh(authorize: () => void) {
    const options = { ...reader, check: authorize, signal: AbortSignal.timeout(25_000) }
    const commit = await resolveOfficialMain(options)
    if (head !== commit) {
      const files = await officialArchiveFiles(commit, await getOfficialArchive(commit, options), options)
      const next = new Map<string, Release>()
      for (const checked of await readCatalogFolders(files, folders)) {
        const { id, version } = checked.bundle.manifest
        const bundled = requireBundledPlugin(id)
        const precedence = compareReleaseVersions(version, bundled.bundle.manifest.version)
        if (precedence === 0 && checked.revision !== bundled.revision) throw catalogUpdateError('same-version-changed')
        const previous = releases.get(id)
        if (previous?.commit) {
          const change = compareReleaseVersions(version, previous.checked.bundle.manifest.version)
          if (change === -1) throw catalogUpdateError('older')
          if (change === 0 && checked.revision !== previous.checked.revision) throw catalogUpdateError('same-version-changed')
        }
        next.set(id, precedence === -1 ? { checked: bundled } : { checked, commit })
      }
      authorize()
      releases = next
      head = commit
    }
    authorize()
    checkedAt = performance.now()
  }

  return {
    get,
    at(id: string, revision: string): Release | undefined {
      const release = get(id)
      return release?.checked.revision === revision ? release : undefined
    },
    async checkAll(authorize: () => void, force = false): Promise<Release[]> {
      authorize()
      if (force || performance.now() - checkedAt >= freshFor) {
        pending ??= refresh(authorize).finally(() => {
          pending = undefined
        })
        await pending
      }
      authorize()
      return Array.from(releases.values())
    },
  }
}
