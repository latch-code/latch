import type { PluginPackageBundle } from '@latch/protocol'

const fail = () => new Error('请选择有效的 .latch-plugin.json 文件，文件总大小不超过 8 MiB。')

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
    || manifest.formatVersion !== 1
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
  return bundle as PluginPackageBundle
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
    throw new Error('使用未被占用的包内相对路径，例如 helpers/format.mjs。最多 128 个文件。')
  return { ...bundle, files: [...bundle.files, { path, content: '' }] }
}
