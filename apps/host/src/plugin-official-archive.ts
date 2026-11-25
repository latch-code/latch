import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { AppError } from '@latch/sdk'
import { externalLimit, gitBlobId, safeSourcePath, type ExternalPluginFiles, type ExternalReaderOptions } from './plugin-external-files.ts'
import { readOfficialRaw } from './plugin-official-source.ts'
import { PLUGIN_PACKAGE_BYTES } from './plugin-package-bundle.ts'
import { tarEntries, tarPath } from './plugin-tar.ts'

const inflate = promisify(gunzip)
const invalid = () => new AppError(502, 'plugin-external-github-invalid', '官方插件归档与所选 Git 提交或文件内容不一致。')

/** Git uses a per-entry PAX path record when the full name does not fit in a USTAR header. */
function extendedPath(bytes: Buffer): string {
  if (bytes.length > 2048) throw invalid()
  const prefix = Buffer.from(`${bytes.length} path=`)
  if (!bytes.subarray(0, prefix.length).equals(prefix) || bytes.at(-1) !== 10) throw invalid()
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(prefix.length, -1))
  } catch {
    throw invalid()
  }
}

function archiveIndex(tar: Buffer, commit: string) {
  const root = `plugin-market-${commit}`
  const files = new Map<string, { size: number; hash: string }>()
  const dirs = new Set<string>()
  const paths = new Set<string>()
  let pinned = false
  let nextPath: string | undefined
  for (const { name, type, bytes } of tarEntries(tar, 20_000, invalid)) {
    if (!pinned) {
      if (type !== 'g' || name !== 'pax_global_header' || !bytes.equals(Buffer.from(`52 comment=${commit}\n`))) throw invalid()
      pinned = true
      continue
    }
    if (type === 'x') {
      if (nextPath !== undefined) throw invalid()
      nextPath = extendedPath(bytes)
      continue
    }
    const directory = type === '5'
    if (directory ? bytes.length !== 0 : type !== '0' && type !== '\0') throw invalid()
    const path = tarPath(nextPath ?? name, directory, invalid)
    nextPath = undefined
    if (path !== root && !path.startsWith(root + '/')) throw invalid()
    const key = path.normalize('NFC').toLowerCase()
    if (paths.has(key)) throw invalid()
    paths.add(key)
    if (directory) dirs.add(path)
    else files.set(path, { size: bytes.length, hash: gitBlobId(bytes) })
  }
  if (!pinned || nextPath !== undefined || !dirs.has(root)) throw invalid()
  for (const path of [...dirs, ...files.keys()]) {
    if (path !== root && !dirs.has(path.slice(0, path.lastIndexOf('/')))) throw invalid()
  }
  return { root, files }
}

/** No extraction to disk. Use the archive as an index, then verify each raw file against its pinned entry. */
export async function officialArchiveFiles(
  commit: string,
  archive: Buffer,
  options: ExternalReaderOptions,
): Promise<Pick<ExternalPluginFiles, 'read'>> {
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw invalid()
  options.check?.()
  const tar = await inflate(archive, { maxOutputLength: 5 * PLUGIN_PACKAGE_BYTES }).catch(() => {
    throw invalid()
  })
  options.check?.()
  const { root, files } = archiveIndex(tar, commit)
  return {
    async read(path, limit) {
      options.check?.()
      if (!safeSourcePath(path)) throw invalid()
      const file = files.get(`${root}/${path}`)
      if (!file) return undefined
      if (file.size > limit) throw externalLimit()
      const bytes = await readOfficialRaw(commit, path, file.size, options)
      if (bytes.length !== file.size || gitBlobId(bytes) !== file.hash) throw invalid()
      return bytes
    },
  }
}
