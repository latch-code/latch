import { z } from 'zod'
import { sha256Hex } from '@latch/core/node-kit'
import type { PluginExternalEntry, PluginExternalSource, PluginPackageManifest } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { matchesFamily } from './files/sniff.ts'
import { releaseVersionSchema } from './npm-source.ts'
import {
  externalLimit,
  githubPluginFiles,
  invalidContent,
  localBundleBytes,
  localPluginFiles,
  parseGithubSource,
  resolveGithubCommit,
  resolveLocalSource,
  safeSourcePath,
  sourceJson,
  type ExternalPluginFiles,
  type ExternalReaderOptions,
} from './plugin-external-files.ts'
import { checkedPluginBundle, containsPluginSourceSecret, PLUGIN_PACKAGE_BYTES } from './plugin-package-bundle.ts'
import { pluginManifestSchema } from './plugin-packages.ts'

const CATALOG = 'latch.catalog.json'
const APP_MANIFEST = 'latch-app.json'
const PLUGIN_MANIFEST = 'latch-plugin.json'
const MANIFEST_LIMIT = 65_536
const FILE_LIMIT = 1_000_000
const MAX_FILES = 128
const MAX_CATALOG = 256 * 1024
const rootManifest = z.enum([PLUGIN_MANIFEST, APP_MANIFEST])
const sourcePath = z.string().refine(safeSourcePath)
const pluginId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u)
const sourceEntry = z.object({
  id: pluginId,
  folder: sourcePath,
  manifest: rootManifest,
  files: z.array(sourcePath).max(MAX_FILES),
})
const bundleEntry = z.object({
  id: pluginId,
  bundle: sourcePath.refine(path => path.endsWith('.latch-plugin.json')),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  version: releaseVersionSchema,
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
})
const catalogSchema = z.object({
  formatVersion: z.literal(1),
  plugins: z.array(z.record(z.string(), z.unknown())).min(1).max(64),
})
type CatalogEntry = z.infer<typeof sourceEntry> | z.infer<typeof bundleEntry>
type ManifestName = z.infer<typeof rootManifest>
type Manifest = Omit<PluginPackageManifest, 'config'> & { config?: Record<string, unknown> }
type CheckedBundle = ReturnType<typeof checkedPluginBundle>

const noPackage = () =>
  new AppError(
    404,
    'plugin-external-package-missing',
    '这里找不到 Latch 插件。请选择含 latch.catalog.json、latch-plugin.json 或 latch-app.json 的目录。',
  )
const secretFile = () => new AppError(400, 'plugin-external-secret', '来源中有可能含密钥的文本或文件名。请移除后重试。')
const unique = (paths: string[]) => new Set(paths.map(path => path.normalize('NFC').toLowerCase())).size === paths.length
const packagePath = (entry: CatalogEntry) => ('folder' in entry ? entry.folder : entry.bundle)

function textContent(text: string): string {
  if (/\p{Cs}/u.test(text) || text.includes('\0')) throw invalidContent()
  if (containsPluginSourceSecret(text)) throw secretFile()
  return text
}

function safeJson(document: unknown): void {
  const remaining = [{ value: document, depth: 0 }]
  let visited = 0
  while (remaining.length) {
    const { value, depth } = remaining.pop()!
    if (++visited > 100_000 || depth > 32) throw invalidContent()
    if (typeof value === 'string') textContent(value)
    else if (typeof value === 'number' && !Number.isFinite(value)) throw invalidContent()
    else if (value !== null && typeof value === 'object') {
      for (const [key, field] of Object.entries(value)) {
        textContent(key)
        remaining.push({ value: field, depth: depth + 1 })
      }
    }
  }
}

function encodedJson(bytes: Buffer): unknown {
  const value = sourceJson(bytes)
  safeJson(value)
  return value
}

function parseCatalog(bytes: Buffer): CatalogEntry[] {
  const parsed = catalogSchema.safeParse(encodedJson(bytes))
  if (!parsed.success) throw invalidContent()
  const entries = parsed.data.plugins.map(item => {
    if (Object.hasOwn(item, 'bundle')) {
      if (['folder', 'manifest', 'files'].some(key => Object.hasOwn(item, key))) throw invalidContent()
      const entry = bundleEntry.safeParse(item)
      if (!entry.success) throw invalidContent()
      return entry.data
    }
    const entry = sourceEntry.safeParse(item)
    if (
      !entry.success
      || Object.hasOwn(item, 'sha256')
      || !unique(entry.data.files)
      || entry.data.files.some(file => [CATALOG, PLUGIN_MANIFEST, APP_MANIFEST].includes(file.toLowerCase()))
    )
      throw invalidContent()
    return entry.data
  })
  if (!unique(entries.map(entry => entry.id)) || !unique(entries.map(packagePath))) throw invalidContent()
  return entries
}

function checkedManifest(value: unknown, name: ManifestName): Manifest {
  const parsed = pluginManifestSchema.safeParse(value)
  if (!parsed.success || !releaseVersionSchema.safeParse(parsed.data.version).success) throw invalidContent()
  const manifest = parsed.data
  if (name === APP_MANIFEST && (manifest.formatVersion !== 2 || !manifest.apps?.length || manifest.host.length || manifest.panels.length))
    throw invalidContent()
  return manifest
}

function checkedSourceBundle(value: unknown): CheckedBundle {
  const payload = value && typeof value === 'object' && 'bundle' in value && Object.keys(value).length === 1 ? value.bundle : value
  const checked = checkedPluginBundle(payload)
  checkedManifest(checked.bundle.manifest, PLUGIN_MANIFEST)
  for (const file of checked.bundle.files) {
    if (!safeSourcePath(file.path)) throw invalidContent()
    const family = imageFamily(file.path)
    if (family) {
      const bytes = Buffer.from(file.content, 'base64')
      if (bytes.toString('base64') !== file.content || !matchesFamily(family, bytes)) throw invalidContent()
    }
  }
  return checked
}

function entryFor(manifest: Manifest, path: string): PluginExternalEntry {
  return { path, id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description }
}

type LoadedDeclaration = { manifest: Manifest; packed?: CheckedBundle }
function declaration(bytes: Buffer, name: ManifestName): LoadedDeclaration {
  const value = encodedJson(bytes)
  if (value && typeof value === 'object' && ('manifest' in value || 'bundle' in value)) {
    if (name !== PLUGIN_MANIFEST) throw invalidContent()
    const packed = checkedSourceBundle(value)
    return { manifest: packed.bundle.manifest, packed }
  }
  if (bytes.length > MANIFEST_LIMIT) throw externalLimit()
  return { manifest: checkedManifest(value, name) }
}

function imageFamily(path: string): 'png' | 'webp' | undefined {
  if (/\.png$/iu.test(path)) return 'png'
  if (/\.webp$/iu.test(path)) return 'webp'
  return undefined
}

function fileContent(path: string, bytes: Buffer): string {
  const family = imageFamily(path)
  if (family) {
    if (!matchesFamily(family, bytes)) throw invalidContent()
    return bytes.toString('base64')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw invalidContent()
  }
  return textContent(text)
}

async function requiredFile(files: ExternalPluginFiles, path: string, limit: number): Promise<Buffer> {
  if (!safeSourcePath(path)) throw invalidContent()
  const bytes = await files.read(path, limit)
  if (!bytes) throw noPackage()
  return bytes
}

async function rootDeclaration(files: ExternalPluginFiles): Promise<LoadedDeclaration & { name: ManifestName }> {
  const plugin = await files.read(PLUGIN_MANIFEST, PLUGIN_PACKAGE_BYTES)
  const app = await files.read(APP_MANIFEST, MANIFEST_LIMIT)
  if (plugin && app) throw invalidContent()
  if (plugin) return { ...declaration(plugin, PLUGIN_MANIFEST), name: PLUGIN_MANIFEST }
  if (app) return { ...declaration(app, APP_MANIFEST), name: APP_MANIFEST }
  throw noPackage()
}

async function catalogDeclaration(
  files: ExternalPluginFiles,
  entry: z.infer<typeof sourceEntry>,
  budget: number,
): Promise<LoadedDeclaration & { bytes: number }> {
  const path = `${entry.folder}/${entry.manifest}`
  const bytes = await requiredFile(
    files,
    path,
    Math.min(budget, entry.files.length || entry.manifest === APP_MANIFEST ? MANIFEST_LIMIT : PLUGIN_PACKAGE_BYTES),
  )
  const loaded = declaration(bytes, entry.manifest)
  if (loaded.manifest.id !== entry.id || (loaded.packed && entry.files.length)) throw invalidContent()
  return { ...loaded, bytes: bytes.length }
}

async function collectFiles(files: ExternalPluginFiles, manifest: Manifest, paths: string[], folder = ''): Promise<CheckedBundle> {
  if (paths.length > MAX_FILES) throw externalLimit()
  if (!unique(paths)) throw invalidContent()
  const contents: Array<{ path: string; content: string }> = []
  let bytes = 0
  for (const path of paths) {
    const content = await requiredFile(files, folder ? `${folder}/${path}` : path, Math.min(FILE_LIMIT, PLUGIN_PACKAGE_BYTES - bytes))
    bytes += content.length
    contents.push({ path, content: fileContent(path, content) })
  }
  return checkedPluginBundle({ manifest, files: contents })
}

function declaredFiles(manifest: Manifest): string[] {
  return [
    ...(manifest.host ?? []),
    ...(manifest.skills ?? []).map(skill => skill.file),
    ...(manifest.panels ?? []).map(panel => panel.entry),
    ...(manifest.apps ?? []).map(app => app.entry),
  ].map(path => path.replace(/^\.\//u, ''))
}

async function sourceFiles(source: Exclude<PluginExternalSource, { kind: 'local-bundle' }>, options: ExternalReaderOptions) {
  return source.kind === 'github' ? githubPluginFiles(source, options) : localPluginFiles(source.directory, options)
}

export async function refreshExternalPluginSource(
  source: PluginExternalSource,
  options: ExternalReaderOptions,
): Promise<PluginExternalSource> {
  if (source.kind === 'github') return { ...source, commit: await resolveGithubCommit(source, options) }
  const path = source.kind === 'local-folder' ? source.directory : source.file
  const current = await resolveLocalSource(path, options)
  if (current.kind !== source.kind) throw noPackage()
  return current
}

export async function findExternalPluginSource(
  input: string,
  options: ExternalReaderOptions,
): Promise<{ source: PluginExternalSource; packages: PluginExternalEntry[] }> {
  const text = input.trim()
  const github = parseGithubSource(text)
  const source: PluginExternalSource = github
    ? { kind: 'github', ...github, commit: await resolveGithubCommit(github, options) }
    : await resolveLocalSource(text, options)
  return { source, packages: await listExternalPlugins(source, options) }
}

export async function listExternalPlugins(source: PluginExternalSource, options: ExternalReaderOptions): Promise<PluginExternalEntry[]> {
  if (source.kind === 'local-bundle') {
    const loaded = checkedSourceBundle(encodedJson(await localBundleBytes(source.file, PLUGIN_PACKAGE_BYTES, options)))
    return [entryFor(loaded.bundle.manifest, '')]
  }
  const files = await sourceFiles(source, options)
  const catalog = await files.read(CATALOG, MAX_CATALOG)
  if (!catalog) return [entryFor((await rootDeclaration(files)).manifest, '')]
  const packages: PluginExternalEntry[] = []
  let budget = PLUGIN_PACKAGE_BYTES * 2
  for (const entry of parseCatalog(catalog)) {
    if ('bundle' in entry) {
      packages.push({
        path: entry.bundle,
        id: entry.id,
        name: entry.name ?? entry.id,
        version: entry.version,
        description: entry.description ?? '',
      })
    } else {
      const loaded = await catalogDeclaration(files, entry, budget)
      budget -= loaded.bytes
      packages.push(entryFor(loaded.manifest, entry.folder))
    }
  }
  return packages
}

export async function readExternalPlugin(
  source: PluginExternalSource,
  path: string,
  options: ExternalReaderOptions,
): Promise<CheckedBundle> {
  if (source.kind === 'local-bundle') {
    if (path !== '') throw noPackage()
    return checkedSourceBundle(encodedJson(await localBundleBytes(source.file, PLUGIN_PACKAGE_BYTES, options)))
  }
  const files = await sourceFiles(source, options)
  const catalog = await files.read(CATALOG, MAX_CATALOG)
  if (catalog) {
    const entry = parseCatalog(catalog).find(candidate => packagePath(candidate) === path)
    if (!entry) throw noPackage()
    if ('bundle' in entry) {
      const bytes = await requiredFile(files, entry.bundle, PLUGIN_PACKAGE_BYTES)
      if (sha256Hex(bytes) !== entry.sha256)
        throw new AppError(409, 'plugin-external-integrity', '目录里的插件下载内容与 SHA-256 摘要不符。')
      const loaded = checkedSourceBundle(encodedJson(bytes))
      if (loaded.bundle.manifest.id !== entry.id || loaded.bundle.manifest.version !== entry.version) throw invalidContent()
      return loaded
    }
    const loaded = await catalogDeclaration(files, entry, PLUGIN_PACKAGE_BYTES)
    return loaded.packed ?? collectFiles(files, loaded.manifest, entry.files, entry.folder)
  }
  if (path !== '') throw noPackage()
  const loaded = await rootDeclaration(files)
  if (loaded.packed) return loaded.packed
  const paths = new Set(declaredFiles(loaded.manifest))
  if (loaded.name === APP_MANIFEST) for (const pageFile of await files.pageFiles()) paths.add(pageFile)
  return collectFiles(files, loaded.manifest, [...paths])
}
