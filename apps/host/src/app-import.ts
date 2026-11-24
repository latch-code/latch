// A page draft read from a session's folder: `latch-app/` under its primary folder, by the file-read rules (no link is
// followed, nothing outside the folder, nothing that looks like a secret). The result is a plugin bundle the asset store
// keeps as a draft revision; builds use only that snapshot and never read the session's folder again.
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginPackageBundle } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { isInsidePath } from './paths.ts'
import { isSecretPath } from './files/secrets.ts'
import { containsPluginSourceSecret } from './plugin-package-bundle.ts'

export const APP_DRAFT_DIRECTORY = 'latch-app'
export const APP_DRAFT_MANIFEST = 'latch-app.json'
const DRAFT_LAYOUTS = {
  app: { directory: APP_DRAFT_DIRECTORY, manifest: APP_DRAFT_MANIFEST },
  plugin: { directory: 'latch-plugin', manifest: 'latch-plugin.json' },
} as const
export type DraftKind = keyof typeof DRAFT_LAYOUTS

/** The probe checks names only. The import independently checks every file before returning any content. */
export async function sessionDraftKinds(folder: string, includePlugins: boolean): Promise<DraftKind[]> {
  const kinds: DraftKind[] = []
  for (const kind of ['app', 'plugin'] as const) {
    if (kind === 'plugin' && !includePlugins) continue
    const layout = DRAFT_LAYOUTS[kind]
    const directory = join(folder, layout.directory)
    const top = await lstat(directory).catch(() => undefined)
    if (top?.isDirectory() && (await lstat(join(directory, layout.manifest)).catch(() => undefined))?.isFile()) kinds.push(kind)
  }
  return kinds
}
/** Files, bytes per file and bytes in all that an import takes. */
export const APP_IMPORT_LIMITS = { files: 64, fileBytes: 512 * 1024, totalBytes: 2 * 1024 * 1024 } as const
/** Entries an import looks at before it gives up, so a huge folder cannot keep the Host busy. */
const ENTRY_LIMIT = 4096
const DEPTH_LIMIT = 12
const TEXT = /\.(?:tsx?|css)$/u
const IMAGE = /\.(?:png|webp)$/u
/** Written by the Host: the build uses its own copy, so the draft's is left out. */
const HOST_FILES = new Set(['sdk.d.ts', 'README.md'])
/** Folders an Agent's tools make that never belong to a page. */
const SKIPPED_FOLDERS = new Set(['node_modules', '.git', 'dist', 'build'])
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

const refuse = (code: string, message: string, details?: Record<string, unknown>) => new AppError(400, code, message, details)

export interface ImportedDraft {
  bundle: PluginPackageBundle
  /** Files left out because the import does not take their kind. */
  skipped: number
  bytes: number
}

/** PNG and WebP by their first bytes: an image that is not one is refused rather than handed to the page. */
function imageMatches(path: string, bytes: Buffer): boolean {
  if (path.endsWith('.png')) return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'
}

/** Reads one file the walk found, proving the open descriptor is the regular file it saw, inside the folder. */
async function readFile(path: string, seen: { dev: bigint; ino: bigint }, root: string): Promise<Buffer> {
  let fd: Awaited<ReturnType<typeof open>>
  try {
    fd = await open(path, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    throw refuse('app-import-changed', '草稿里的文件在读取时变了，请重试。')
  }
  try {
    const info = await fd.stat({ bigint: true })
    if (!info.isFile() || info.dev !== seen.dev || info.ino !== seen.ino)
      throw refuse('app-import-changed', '草稿里的文件在读取时变了，请重试。')
    // A hard link is a name for a file elsewhere, as a symbolic one is.
    if (info.nlink !== 1n) throw refuse('app-import-link', '草稿不能是链接或包含链接。')
    if (info.size > BigInt(APP_IMPORT_LIMITS.fileBytes))
      throw refuse('app-import-limit', '草稿里有超过 512 KiB 的文件。', { limit: 'file' })
    const real = await realpath(path).catch(() => undefined)
    if (!real || !isInsidePath(real, root)) throw refuse('app-import-outside', '草稿的文件不在会话文件夹里。')
    // A writer can grow the file after stat; bound the read itself and reject a revision that changed under the reader.
    const bytes = Buffer.alloc(Number(info.size) + 1)
    let length = 0
    while (length < bytes.length) {
      const chunk = await fd.read(bytes, length, bytes.length - length, length)
      if (!chunk.bytesRead) break
      length += chunk.bytesRead
    }
    const after = await lstat(path, { bigint: true }).catch(() => undefined)
    if (
      length !== Number(info.size)
      || !after?.isFile()
      || after.dev !== info.dev
      || after.ino !== info.ino
      || after.ctimeNs !== info.ctimeNs
    )
      throw refuse('app-import-changed', '草稿里的文件在读取时变了，请重试。')
    return bytes.subarray(0, length)
  } finally {
    await fd.close()
  }
}

/**
 * Reads `latch-app/` under `folder` (the session's primary folder). Takes `latch-app.json` and `.ts`, `.tsx`, `.css`,
 * `.png`, `.webp`; leaves out other files and the Host's own `sdk.d.ts` and `README.md`. Refuses a link anywhere in the
 * page draft, a `.mjs` file or a manifest with Host modules or panels. An explicitly selected plugin draft instead reads
 * its own directory and accepts Markdown, text and ESM as inert sources. Both refuse more than 64 files, over 512 KiB per file or 2 MiB in all,
 * and a file that looks like it holds a secret. Images are kept as base64 text.
 */
export async function readSessionDraft(folder: string, kind: DraftKind = 'app', fixedRoot?: string): Promise<ImportedDraft> {
  const root = await realpath(folder).catch(() => {
    throw new AppError(409, 'app-draft-missing', '这个会话的文件夹找不到了。')
  })
  if (fixedRoot !== undefined && fixedRoot !== root) throw refuse('app-import-outside', '创作会话的专用文件夹已变化。')
  const layout = DRAFT_LAYOUTS[kind]
  const base = join(root, layout.directory)
  const top = await lstat(base).catch(() => undefined)
  if (!top) throw new AppError(404, 'app-draft-missing', `这个会话里没有 ${layout.directory} 文件夹。`)
  if (top.isSymbolicLink()) throw refuse('app-import-link', '草稿不能是链接或包含链接。')
  if (!top.isDirectory()) throw new AppError(404, 'app-draft-missing', `这个会话里没有 ${layout.directory} 文件夹。`)

  const files: Array<{ path: string; content: string }> = []
  let manifestText: string | undefined
  let skipped = 0
  let bytes = 0
  let visited = 0
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > DEPTH_LIMIT) throw refuse('app-import-limit', '草稿的文件夹层级太深。', { limit: 'depth' })
    const real = await realpath(directory)
    if (!isInsidePath(real, base)) throw refuse('app-import-outside', '草稿的文件不在会话文件夹里。')
    const names: string[] = []
    const handle = await opendir(directory)
    for await (const entry of handle) {
      if (++visited > ENTRY_LIMIT) throw refuse('app-import-limit', '草稿里的文件太多。', { limit: 'files' })
      names.push(entry.name)
    }
    for (const name of names.sort()) {
      const path = join(directory, name)
      const relative = prefix ? `${prefix}/${name}` : name
      if (containsPluginSourceSecret(relative)) throw refuse('app-import-secret', '草稿包含可能带有密钥的文件名。')
      const info = await lstat(path, { bigint: true })
      if (info.isSymbolicLink()) throw refuse('app-import-link', '草稿不能是链接或包含链接。', { path: relative })
      if (info.isDirectory()) {
        if (name.startsWith('.') || SKIPPED_FOLDERS.has(name)) continue
        await walk(path, relative, depth + 1)
        continue
      }
      if (!info.isFile()) {
        skipped++
        continue
      }
      const lower = name.toLowerCase()
      if (lower.endsWith('.cjs')) throw refuse('app-import-module', '插件草稿只接受 ESM 模块，不支持 CommonJS。', { path: relative })
      if (kind === 'app' && lower.endsWith('.mjs'))
        throw refuse('app-import-module', '应用页面不能加载本机模块。工具模块请放入单独的 latch-plugin 草稿。', { path: relative })
      const isManifest = relative === layout.manifest
      if (kind === 'app' && !prefix && HOST_FILES.has(name)) continue
      const supported = kind === 'app' ? TEXT.test(lower) || IMAGE.test(lower) : /\.(?:mjs|md|txt)$/u.test(lower)
      if (!isManifest && (name.startsWith('.') || !supported)) {
        skipped++
        continue
      }
      if (files.length + (isManifest ? 0 : 1) > APP_IMPORT_LIMITS.files)
        throw refuse('app-import-limit', '草稿最多 64 个文件。', { limit: 'files' })
      const content = await readFile(path, { dev: info.dev, ino: info.ino }, base)
      bytes += content.length
      if (bytes > APP_IMPORT_LIMITS.totalBytes) throw refuse('app-import-limit', '草稿合计超过 2 MiB。', { limit: 'total' })
      if (IMAGE.test(lower) && !isManifest) {
        if (!imageMatches(lower, content)) throw refuse('app-import-image', '草稿里的图片不是有效的 PNG 或 WebP。', { path: relative })
        files.push({ path: relative, content: content.toString('base64') })
        continue
      }
      if (isSecretPath(relative, content)) throw refuse('app-import-secret', '草稿里有文件看起来含密钥，没有导入。', { path: relative })
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(content)
      } catch {
        throw refuse('app-import-text', '草稿的源码必须是 UTF-8 文本。', { path: relative })
      }
      if (containsPluginSourceSecret(text)) throw refuse('app-import-secret', '草稿内容可能含密钥，没有导入。')
      if (text.includes('\u0000')) throw refuse('app-import-text', '草稿源码不能包含空字符。')
      if (isManifest) manifestText = text
      else files.push({ path: relative, content: text })
    }
  }
  await walk(base, '', 0)
  if (manifestText === undefined) throw new AppError(404, 'app-draft-missing', `草稿里没有 ${layout.manifest}。`)
  let manifest: unknown
  let normalizedManifest: string
  try {
    manifest = JSON.parse(manifestText)
    normalizedManifest = JSON.stringify(manifest)
  } catch {
    throw refuse('app-import-manifest', `${layout.manifest} 不是有效的 JSON。`)
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest))
    throw refuse('app-import-manifest', `${layout.manifest} 不是有效的插件声明。`)
  if (containsPluginSourceSecret(normalizedManifest)) throw refuse('app-import-secret', '草稿声明可能含密钥，没有导入。')
  const declared = manifest as Record<string, unknown>
  if (kind === 'plugin') {
    if (declared.formatVersion !== 1 || 'apps' in declared)
      throw refuse('app-import-manifest', '技能和工具草稿使用格式 1 的 latch-plugin.json；隔离页面请放在 latch-app 文件夹。')
    if (!['skills', 'host', 'panels', 'dataPanels'].some(key => Array.isArray(declared[key]) && declared[key].length > 0))
      throw refuse('app-import-manifest', '插件草稿至少需要声明一项技能、工具模块或面板。')
    return { bundle: { manifest: manifest as PluginPackageBundle['manifest'], files }, skipped, bytes }
  }
  // Code that runs on the Host or in the shell's own page needs the advanced import and its per-digest confirmation.
  if ('host' in declared || 'panels' in declared) throw refuse('app-import-code', '应用草稿只能有页面；Host 模块与面板请用插件的高级导入。')
  if (declared.formatVersion !== 2 || !Array.isArray(declared.apps) || declared.apps.length === 0)
    throw refuse('app-import-manifest', 'latch-app.json 要是 formatVersion 2，并至少有一个页面。')
  if (
    declared.apps.some(
      app =>
        typeof app !== 'object'
        || app === null
        || typeof (app as { entry?: unknown }).entry !== 'string'
        || !/\.tsx?$/u.test((app as { entry: string }).entry),
    )
  )
    throw refuse('app-import-manifest', '页面入口要是草稿里的 .ts 或 .tsx 文件。')
  return { bundle: { manifest: manifest as PluginPackageBundle['manifest'], files }, skipped, bytes }
}
