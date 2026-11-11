import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { AppError, type HarnessPlugin, type PluginContext } from '@latch/sdk'
import { isUiPanelDocument, type UiPanelDocument } from '@latch/protocol'
import { appPluginNameSchema, appRequiresSchema, appsSchema } from './app-capabilities.ts'

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u)
const manifestFields = {
  id,
  name: z.string().trim().min(1).max(80),
  version: z.string().min(1).max(64),
  description: z.string().max(500),
  host: z.array(z.string().min(1)).max(32).default([]),
  config: z.record(z.string(), z.unknown()).default({}),
  skills: z
    .array(
      z
        .object({
          id,
          name: z.string().trim().min(1).max(80),
          description: z.string().max(500),
          file: z.string().min(1),
        })
        .strict(),
    )
    .max(32)
    .default([]),
  panels: z
    .array(
      z
        .object({
          id,
          title: z.string().trim().min(1).max(48),
          description: z.string().max(240).optional(),
          harnessIds: z.array(id).max(32).optional(),
          entry: z.string().min(1),
        })
        .strict(),
    )
    .max(32)
    .default([]),
  dataPanels: z
    .array(
      z.strictObject({
        id,
        title: z.string().trim().min(1).max(48),
        description: z.string().max(240).optional(),
        harnessIds: z.array(id).max(32).optional(),
        document: z.custom<UiPanelDocument>(isUiPanelDocument),
      }),
    )
    .max(32)
    .default([]),
}
/** Format 1 loads unchanged; format 2 adds pages (`apps`) and the SDK range they need. Both are strict. */
export const pluginManifestSchema = z.discriminatedUnion('formatVersion', [
  z.strictObject({ formatVersion: z.literal(1), ...manifestFields }),
  z.strictObject({
    formatVersion: z.literal(2),
    ...manifestFields,
    name: appPluginNameSchema,
    requires: appRequiresSchema.optional(),
    apps: appsSchema.optional(),
  }),
])

interface HostModule {
  activate(context: PluginContext, config: Readonly<Record<string, unknown>>): void | Promise<void>
}

function hostModule(value: unknown): value is HostModule {
  return typeof value === 'object' && value !== null && 'activate' in value && typeof value.activate === 'function'
}
function legacyPlugin(value: unknown): value is HarnessPlugin {
  return (
    hostModule(value)
    && ['id', 'name', 'version', 'description'].every(key => key in value && typeof value[key as keyof typeof value] === 'string')
  )
}
function invalid(message: string): AppError {
  return new AppError(400, 'plugin-package-invalid', message)
}

/** Only explicitly supplied local files are loaded. Nothing installs dependencies or downloads code. */
export async function loadPluginPackage(path: string): Promise<HarnessPlugin> {
  const root = await realpath(resolve(path))
  if (!(await stat(root)).isDirectory()) {
    const module: { default?: unknown } = await import(pathToFileURL(root).href)
    if (!legacyPlugin(module.default)) throw invalid('插件模块无效：必须默认导出有效的插件对象。')
    return module.default
  }
  async function local(file: string): Promise<string> {
    if (isAbsolute(file)) throw invalid('插件包中的文件路径必须相对于包目录。')
    const candidate = await realpath(resolve(root, file))
    const child = relative(root, candidate)
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw invalid('插件包不能引用包目录以外的文件。')
    }
    return candidate
  }
  async function contents(file: string, max: number): Promise<string> {
    const location = await local(file)
    const info = await stat(location)
    if (!info.isFile() || info.size > max) throw invalid('插件包文件类型或大小不受支持。')
    const content = await readFile(location, 'utf8')
    if (Buffer.byteLength(content) > max) throw invalid('插件包文件过大。')
    return content
  }
  const text = await contents('latch-plugin.json', 65_536)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw invalid('latch-plugin.json 必须是有效的 JSON。')
  }
  const parsed = pluginManifestSchema.safeParse(value)
  if (!parsed.success) throw invalid('latch-plugin.json 格式无效，请检查插件包文档。')
  const manifest = parsed.data
  const skills = await Promise.all(manifest.skills.map(async ({ file, ...skill }) => ({ ...skill, content: await contents(file, 32_000) })))
  const panels = await Promise.all(
    manifest.panels.map(async ({ entry, ...panel }) => ({ ...panel, source: await contents(entry, 1_000_000) })),
  )
  const modules: HostModule[] = []
  for (const file of manifest.host) {
    const entry = await local(file)
    const module: { default?: unknown } = await import(pathToFileURL(entry).href)
    if (!hostModule(module.default)) throw invalid('插件包的 Host 模块必须默认导出含 activate 的对象。')
    modules.push(module.default)
  }
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    package: { formatVersion: manifest.formatVersion },
    async activate(context) {
      for (const skill of skills) context.registerSkill(skill)
      for (const panel of panels) context.registerClientPanel(panel)
      for (const { document, ...panel } of manifest.dataPanels)
        context.registerUiPanel({ ...panel, render: () => structuredClone(document) })
      for (const module of modules) await module.activate(context, structuredClone(manifest.config))
    },
  }
}
