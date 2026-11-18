import { posix, win32 } from 'node:path'
import { isHarnessPluginName, MAX_HARNESS_PLUGINS, type HarnessPluginReport } from '@latch/protocol'
import { isRecord } from './process.ts'

function localPath(value: unknown, paths: typeof posix): value is string {
  return (
    typeof value === 'string'
    && value.length <= 16_384
    && paths.isAbsolute(value)
    && !/[\p{C}\u2028\u2029]/u.test(value)
    && !value.split(paths === win32 ? /[\\/]/u : '/').includes('..')
    && (paths === win32 ? /^(?:[a-z]:[\\/]|\\\\[^?./\\])/iu.test(value) : !value.includes('\\'))
  )
}

function piPluginLocation(info: unknown): { name: string; location: string } | undefined {
  if (!isRecord(info) || typeof info.path !== 'string') return undefined
  const paths = info.path.startsWith('/') ? posix : win32
  if (!localPath(info.path, paths) || /[\\/]$/u.test(info.path)) return undefined
  const entry = paths.normalize(info.path)
  const file = paths.basename(entry)
  if (!file) return undefined
  if (info.origin === 'package') {
    if (!localPath(info.baseDir, paths)) return undefined
    const location = paths.normalize(info.baseDir)
    const relative = paths.relative(location, entry)
    if (
      paths.parse(location).root === location
      || !relative
      || relative === '..'
      || relative.startsWith(`..${paths.sep}`)
      || paths.isAbsolute(relative)
    )
      return undefined
    return { name: paths.basename(location), location }
  }
  if (info.origin !== 'top-level') return undefined
  if ((info.source === 'auto' || info.source === 'local') && localPath(info.baseDir, paths)) {
    // pi can report either the settings base or the extensions directory itself for an auto-discovered resource.
    const container = paths.basename(info.baseDir) === 'extensions' ? info.baseDir : paths.join(info.baseDir, 'extensions')
    const relative = paths.relative(container, entry)
    const [folder, child] = relative.split(paths.sep)
    if (folder && folder !== '..' && child && !paths.isAbsolute(relative)) return { name: folder, location: paths.join(container, folder) }
  }
  const stem = file.replace(/\.[cm]?[jt]sx?$/iu, '')
  if (stem === 'index') {
    const location = paths.dirname(entry)
    return { name: paths.basename(location), location }
  }
  return { name: stem, location: entry }
}

/** pi reports extensions with commands, not an inventory of extensions that register no command. */
export function piPlugins(
  commands: readonly unknown[],
  gatePath: string | undefined,
  redact: (text: string) => string,
): HarnessPluginReport {
  const locations = new Map<string, string | undefined>()
  let truncated = false
  for (const row of commands) {
    if (!isRecord(row) || row.source !== 'extension') continue
    const info = row.sourceInfo
    if (isRecord(info) && (info.source === 'builtin' || (gatePath !== undefined && info.path === gatePath))) continue
    const plugin = piPluginLocation(info)
    if (!plugin || !isHarnessPluginName(plugin.name) || redact(plugin.name) !== plugin.name) {
      truncated = true
      continue
    }
    const { name, location } = plugin
    if (locations.has(name)) {
      if (locations.get(name) !== location) {
        locations.set(name, undefined)
        truncated = true
      }
    } else if (locations.size < MAX_HARNESS_PLUGINS) locations.set(name, location)
    else truncated = true
  }
  return {
    names: [...locations.keys()].filter(name => locations.get(name) !== undefined),
    ...(truncated ? { truncated: true } : {}),
  }
}
