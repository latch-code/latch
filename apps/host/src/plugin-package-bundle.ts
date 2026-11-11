import { z } from 'zod'
import type { PluginPackageBundle } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { pluginManifestSchema } from './plugin-packages.ts'

export const PLUGIN_PACKAGE_BYTES = 8 * 1024 * 1024
const inputSchema = z.strictObject({
  manifest: pluginManifestSchema,
  files: z.array(z.strictObject({ path: z.string(), content: z.string() })).max(128),
})
function packagePath(value: string): string {
  const path = value.startsWith('./') ? value.slice(2) : value
  if (
    !path
    || Buffer.byteLength(path) > 256
    || /[\\\u0000-\u001f\u007f]/u.test(path)
    || /^[A-Za-z]:/u.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')
    || path.split('/').length > 16
  )
    throw new AppError(400, 'plugin-package-path', '插件文件必须使用包内的相对路径。')
  return path
}
function finiteJson(value: unknown): void {
  const stack = [{ value, depth: 0 }]
  let visited = 0
  while (stack.length) {
    const item = stack.pop()!
    if (++visited > 100000 || item.depth > 32) throw new AppError(400, 'plugin-package-invalid', '插件声明过于复杂。')
    if (item.value === null || typeof item.value === 'string' || typeof item.value === 'boolean') continue
    if (typeof item.value === 'number' && Number.isFinite(item.value)) continue
    if (typeof item.value !== 'object' || !item.value)
      throw new AppError(400, 'plugin-package-invalid', '插件声明只能包含有限的 JSON 数据。')
    for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 })
  }
}
/** Validate the complete asset before any import, then hash one canonical snapshot for preview, trust and publication. */
export function checkedPluginBundle(input: unknown): { bundle: PluginPackageBundle; revision: string; executionHash?: string } {
  try {
    finiteJson(input)
    const data = inputSchema.parse(input),
      files = new Map<string, string>(),
      spellings = new Set<string>()
    for (const file of data.files) {
      const path = packagePath(file.path),
        spelling = path.normalize('NFC').toLocaleLowerCase('en-US')
      if (spelling === 'latch-plugin.json' || spellings.has(spelling) || Buffer.byteLength(file.content) > 1000000)
        throw new AppError(400, 'plugin-package-files', '插件文件重复、使用保留名称或超过 1 MB。')
      spellings.add(spelling)
      files.set(path, file.content)
    }
    for (const path of spellings) {
      const parts = path.split('/')
      for (let length = 1; length < parts.length; length++)
        if (spellings.has(parts.slice(0, length).join('/')))
          throw new AppError(400, 'plugin-package-files', '文件与文件夹不能使用同一路径。')
    }
    const required = (path: string, max: number) => {
      const key = packagePath(path),
        source = files.get(key)
      if (source === undefined || Buffer.byteLength(source) > max)
        throw new AppError(400, 'plugin-package-files', '声明的入口或技能不存在，或超过允许大小。')
      return key
    }
    const manifest = {
      ...data.manifest,
      host: data.manifest.host.map(path => required(path, 1000000)),
      skills: data.manifest.skills.map(skill => ({ ...skill, file: required(skill.file, 32000) })),
      panels: data.manifest.panels.map(panel => ({ ...panel, entry: required(panel.entry, 1000000) })),
      ...(data.manifest.formatVersion === 2 && data.manifest.apps
        ? { apps: data.manifest.apps.map(app => ({ ...app, entry: required(app.entry, 1000000) })) }
        : {}),
    }
    // A `.js` entry is a page module built beforehand: it runs only in the page frame, never on the Host.
    if (manifest.apps?.some(app => !/\.(?:tsx?|js)$/iu.test(app.entry)))
      throw new AppError(400, 'plugin-package-app-entry', '页面入口必须是包内的 .ts、.tsx 源文件或预先构建的 .js 模块。')
    if (manifest.skills.some(skill => !/\.(?:md|txt)$/iu.test(skill.file)))
      throw new AppError(400, 'plugin-package-skill-file', '应用内技能文件只接受 .md 或 .txt 文本，执行模块必须单独保存。')
    if (Buffer.byteLength(JSON.stringify(manifest)) > 65536) throw new AppError(413, 'plugin-package-large', '插件声明超过 64 KiB。')
    const unique = (values: string[]) => new Set(values).size === values.length
    if (
      !unique(manifest.host)
      || !unique(manifest.skills.map(skill => skill.id))
      || !unique([...manifest.panels, ...manifest.dataPanels].map(panel => panel.id))
    )
      throw new AppError(400, 'plugin-package-duplicate', '插件贡献或入口标识不能重复。')
    if (manifest.host.some(path => !path.endsWith('.mjs')) || manifest.panels.some(panel => !panel.entry.endsWith('.mjs')))
      throw new AppError(400, 'plugin-package-module', '可执行入口必须是预先构建的 .mjs 模块。')
    const bundle = {
      manifest,
      files: [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, content]) => ({ path, content })),
    } as PluginPackageBundle
    if (Buffer.byteLength(JSON.stringify(bundle)) > PLUGIN_PACKAGE_BYTES)
      throw new AppError(413, 'plugin-package-large', '插件资产超过 8 MiB。')
    const revision = sha256Hex(canonicalJson(bundle))
    if (!manifest.host.length && !manifest.panels.length) return { bundle, revision }
    const code = new Set([...manifest.host, ...manifest.panels.map(panel => panel.entry)]),
      skills = new Set(manifest.skills.map(skill => skill.file))
    const executionHash = sha256Hex(
      canonicalJson({
        id: manifest.id,
        host: manifest.host,
        panels: manifest.panels.map(panel => ({
          id: panel.id,
          entry: panel.entry,
          ...(panel.harnessIds ? { harnessIds: panel.harnessIds } : {}),
        })),
        config: manifest.host.length ? manifest.config : {},
        files: bundle.files.filter(file => code.has(file.path) || /\.mjs$/iu.test(file.path) || !skills.has(file.path)),
      }),
    )
    return { bundle, revision, executionHash }
  } catch (cause) {
    if (cause instanceof AppError) throw cause
    throw new AppError(400, 'plugin-package-invalid', '插件声明或文件格式无效，请检查插件内容。')
  }
}
