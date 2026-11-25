import type { AppSnapshot, PluginInfo, PluginPackageBundle, PluginPackageManifest } from '@latch/protocol'
import type { DeviceAccess } from '../core/permissions.ts'
import { PLUGIN_REACH_COPY } from '../core/securityCopy.ts'
import { MessageError } from '../core/api.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    badBundle: '请选择有效的 .latch-plugin.json 文件，文件总大小不超过 8 MiB。',
    badPath: '使用未被占用的包内相对路径，例如 helpers/format.mjs。最多 128 个文件。',
    activeSessions: (count: number) => `${formatNumber(count)} 个会话在用，结束后才能停用`,
  },
  {
    badBundle: 'Choose a valid .latch-plugin.json file, 8 MiB or less in total.',
    badPath: 'Use a free relative path inside the package, such as helpers/format.mjs. Up to 128 files.',
    activeSessions: (count: number) =>
      plural(count, {
        one: 'End the {n} session using this plugin to turn it off',
        other: 'End the {n} sessions using this plugin to turn it off',
      }),
  },
)

const fail = () => new MessageError(COPY.badBundle)

export function pluginInUseReason(plugin?: PluginInfo): string | undefined {
  return plugin?.enabled && plugin.activeRuns > 0 && plugin.managed === undefined ? COPY.activeSessions(plugin.activeRuns) : undefined
}

export function canEditPluginPackages(snapshot: AppSnapshot, access: DeviceAccess): boolean {
  return snapshot.catalog?.features?.pluginPackages === true && access.local && access.admin && access.device?.dataScope === 'all'
}

export function downloadPluginBundle(id: string, bundle: PluginPackageBundle): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = id + '.latch-plugin.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Bounded renderable import. The Host validates the full contract before saving or importing code. */
export function readPluginBundle(text: string): PluginPackageBundle {
  if (new TextEncoder().encode(text).length > 8 * 1024 * 1024) throw fail()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw fail()
  }
  if (typeof value !== 'object' || value === null) throw fail()
  const bundle = value as Partial<PluginPackageBundle>,
    manifest = bundle.manifest
  if (
    !manifest
    || (manifest.formatVersion !== 1 && manifest.formatVersion !== 2)
    || typeof manifest.id !== 'string'
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(manifest.id)
    || typeof manifest.name !== 'string'
    || manifest.name.length > 80
    || typeof manifest.description !== 'string'
    || typeof manifest.version !== 'string'
    || !Array.isArray(bundle.files)
    || bundle.files.length > 128
    || !bundle.files.every(
      file =>
        file
        && typeof file.path === 'string'
        && file.path.length <= 256
        && typeof file.content === 'string'
        && new TextEncoder().encode(file.content).length <= 1000000,
    )
  )
    throw fail()
  if (
    manifest.skills !== undefined
    && (!Array.isArray(manifest.skills)
      || manifest.skills.length > 128
      || !manifest.skills.every(
        skill =>
          skill
          && typeof skill.id === 'string'
          && typeof skill.name === 'string'
          && typeof skill.description === 'string'
          && typeof skill.file === 'string',
      ))
  )
    throw fail()
  if (
    manifest.apps !== undefined
    && (manifest.formatVersion !== 2
      || !Array.isArray(manifest.apps)
      || manifest.apps.length > 4
      || !manifest.apps.every(
        page => page && typeof page.id === 'string' && typeof page.title === 'string' && typeof page.entry === 'string',
      ))
  )
    throw fail()
  return bundle as PluginPackageBundle
}

/** A TS/TSX entry must go through the Host builder before it can be applied. */
export function needsPageBuild(manifest?: PluginPackageManifest): boolean {
  return Array.isArray(manifest?.apps) && manifest.apps.some(page => typeof page?.entry === 'string' && /\.tsx?$/iu.test(page.entry))
}

/** Preserve contributions the simple form does not know about. */
export function editPluginSource(bundle: PluginPackageBundle, path: string, content: string): PluginPackageBundle {
  return { ...bundle, files: bundle.files.map(file => (file.path === path ? { ...file, content } : file)) }
}

export function addPluginSource(bundle: PluginPackageBundle, path: string): PluginPackageBundle {
  const spelling = path.normalize('NFC').toLocaleLowerCase('en-US')
  if (
    !path
    || path.length > 256
    || /[\\\u0000-\u001f\u007f]/u.test(path)
    || /^[A-Za-z]:/u.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')
    || path.split('/').length > 16
    || spelling === 'latch-plugin.json'
    || bundle.files.length >= 128
    || bundle.files.some(file => {
      const existing = file.path.normalize('NFC').toLocaleLowerCase('en-US')
      return existing === spelling || existing.startsWith(spelling + '/') || spelling.startsWith(existing + '/')
    })
  )
    throw new MessageError(COPY.badPath)
  return { ...bundle, files: [...bundle.files, { path, content: '' }] }
}

export interface PluginReach {
  id: 'page' | 'host' | 'text'
  title: string
  /** Where it runs and that nothing isolates it, in a few words; `body` is the rest, behind ⓘ. */
  label: string
  body: string
}

type ReachParts = Record<PluginReach['id'] | 'context', boolean>

function reach(parts: ReachParts): PluginReach[] {
  return (['page', 'host', 'text'] as const)
    .filter(part => parts[part])
    .map(part => {
      const copy = PLUGIN_REACH_COPY[part]
      return part === 'page' && parts.context
        ? { id: part, ...copy, body: copy.body + ' ' + PLUGIN_REACH_COPY.context }
        : { id: part, ...copy }
    })
}

const manifestParts = (manifest: PluginPackageManifest): ReachParts => ({
  page: (manifest.panels?.length ?? 0) > 0,
  context: Array.isArray(manifest.panels) && manifest.panels.some(panel => panel?.context === true),
  host: (manifest.host?.length ?? 0) > 0,
  text: (manifest.skills?.length ?? 0) > 0 || (manifest.dataPanels?.length ?? 0) > 0,
})

function capabilityParts(capabilities: readonly string[]): ReachParts {
  const kinds = new Set(capabilities.map(capability => capability.split(':')[0]))
  return {
    page: kinds.has('ui'),
    context: kinds.has('ui-context'),
    host: ['tool', 'harness', 'provider', 'transport'].some(kind => kinds.has(kind)),
    text: kinds.has('skill') || kinds.has('data'),
  }
}

/** What the form says about a plugin being edited: it follows the manifest as typed, so a panel added now is named now. */
export function manifestReach(manifest: PluginPackageManifest): PluginReach[] {
  return reach(manifestParts(manifest))
}

/**
 * The manifest the form describes while 高级声明 is open: the text as typed once it parses, because 保存并应用 applies that
 * text without leaving the tab. Until it parses, nothing can be applied, so the last good manifest stands.
 */
export function typedManifest(text: string, last: PluginPackageManifest): PluginPackageManifest {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as PluginPackageManifest) : last
  } catch {
    return last
  }
}

/** The same for a plugin the Host already loaded, from the capabilities it reports. */
export function pluginReach(plugin: Pick<PluginInfo, 'capabilities'>): PluginReach[] {
  return reach(capabilityParts(plugin.capabilities))
}

/**
 * What a package's page says: what its saved manifest declares and what the Host runs now. Neither alone is true: a Host
 * module can register a panel its manifest never names, and the saved draft can drop a panel the applied revision still
 * delivers.
 */
export function packageReach(manifest: PluginPackageManifest | undefined, running: Pick<PluginInfo, 'capabilities'>): PluginReach[] {
  const declared = manifest ? manifestParts(manifest) : { page: false, host: false, text: false, context: false }
  const loaded = capabilityParts(running.capabilities)
  return reach({
    page: declared.page || loaded.page,
    host: declared.host || loaded.host,
    text: declared.text || loaded.text,
    context: declared.context || loaded.context,
  })
}
