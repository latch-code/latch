import { lstat, opendir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@latch/sdk'
import { syncDirectory } from '@latch/core/node-kit'

const UUID_PART = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const GENERATION = new RegExp('^(?:\\.' + UUID_PART + '|[A-Za-z0-9_-]{1,64}-[a-f0-9]{64}-' + UUID_PART + ')$', 'u')

/** Call only after acquiring the data-directory lock and refusing any live legacy Host. No old process then owns these sources. */
export async function cleanupPluginGenerations(dataDir: string): Promise<number> {
  const root = join(dataDir, 'plugin-packages'),
    directory = join(root, 'generations'),
    uid = process.getuid?.()
  for (const path of [root, directory]) {
    let info
    try {
      info = await lstat(path)
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return 0
      throw cause
    }
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || (uid !== undefined && info.uid !== uid))
      throw new AppError(500, 'plugin-package-private', '插件源码目录必须是本人私有的真实目录。')
  }
  let removed = 0
  for await (const entry of await opendir(directory)) {
    if (GENERATION.exec(entry.name)?.[0] !== entry.name) continue
    await rm(join(directory, entry.name), { recursive: true, force: true })
    removed++
  }
  if (removed) await syncDirectory(directory)
  return removed
}
