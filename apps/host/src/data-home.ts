import { lstat, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { makePrivateDirectory, ownedDirectory } from '@latch/link-client/private-directory'
import { AppError } from '@latch/sdk'
import { acquireDataDirLock, processAlive, readHostState, readRecordedPid, verifyHostState } from './host-state.ts'
import { defaultDataDir, legacyDataDir } from './paths.ts'

/** What a start found and did about the data directory's location. */
export type DataHome = { dataDir: string; moved: false; note?: string } | { dataDir: string; moved: true; from: string; note: string }

const MARKER = (to: string) =>
  `Latch 的数据已移到 ${to}。\n这个文件留在原位置，让旧版本的 Latch 在这里启动失败，而不是新建一份空数据。\n`
  + `Latch's data moved to ${to}.\nThis file stays here so that an older Latch fails to start instead of creating empty data.\n`

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

type Kind = 'absent' | 'directory' | 'empty' | 'link' | 'other'

/** `empty` is a real directory with nothing in it: no data to protect, and a rename may replace it. */
async function kind(path: string): Promise<Kind> {
  try {
    const info = await lstat(path)
    if (info.isDirectory()) return (await readdir(path)).length === 0 ? 'empty' : 'directory'
    // A link to a directory is somebody's own arrangement: used where it is, never moved.
    const linked =
      info.isSymbolicLink()
      && (await stat(path)
        .then(to => to.isDirectory())
        .catch(() => false))
    return linked ? 'link' : 'other'
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return 'absent'
    throw error
  }
}

const hasData = (state: Kind) => state === 'directory' || state === 'link'

function refused(code: string, message: string): AppError {
  return new AppError(409, code, message)
}

/** Nothing may still be running from `dataDir`: a Host that answers, or a host.json whose process cannot be ruled out. */
async function refuseWhileUsed(dataDir: string): Promise<void> {
  const file = join(dataDir, 'host.json')
  const state = await readHostState(dataDir).catch(() => undefined)
  if (state) {
    if (await verifyHostState(state))
      throw refused(
        'data-dir-move-busy',
        `旧数据目录 ${dataDir} 里还有 Latch 在运行（进程 ${state.pid}），数据没有移动。请先停止它再启动。`,
      )
    return
  }
  const recorded = await readRecordedPid(dataDir)
  if (!recorded.present) return
  if (recorded.pid === undefined)
    throw refused(
      'data-dir-move-busy',
      `无法识别 ${file}，不能确认没有 Latch 在运行，数据没有移动。确认没有 Latch 在运行后删除该文件再启动。`,
    )
  if (processAlive(recorded.pid))
    throw refused(
      'data-dir-move-busy',
      `${file} 记录的进程 ${recorded.pid} 仍在运行，数据没有移动。请先停止它；如果确认没有 Latch 在运行，删除该文件后再启动。`,
    )
}

/**
 * The one-time move of the macOS data directory from `~/Library/Application Support/Latch/Host` to `~/.latch/host`.
 *
 * Only a start of the Host calls this, before it creates anything. It acts only when `dataDir` is one of those two
 * default locations; any other directory is the person's choice and is returned untouched.
 *
 * - **Moved**: the old place holds data and the new place is absent or an empty directory. A start that names the old
 *   place itself (`explicit`: `--data-dir` or `LATCH_DATA_DIR`) is the exception: it runs there, where it was told.
 * - **Refused, nothing changed**: both places hold data (nobody guesses which is the real one); the old directory is
 *   still in use; the two are on different volumes; `~/.latch` is a link or open to others.
 * - **Left where it is**: the old place is a link to a directory; or the data holds a legacy `workspace`, which would
 *   otherwise end up inside `~/.latch` where the Host refuses a project.
 * - **Sent to the new place**: the old place was named but holds no data any more and the new place does.
 *
 * The move is one rename on one volume, made while this process holds the old directory's lock: nothing is copied and
 * there is no half-moved state. Afterwards a small file stands at the old path, so that an older Latch that still
 * defaults to it cannot make a directory there and fails to start instead of creating a second, empty Host.
 */
export async function settleDataHome(input: {
  dataDir: string
  /** The directory was named by a flag or a variable, not found as the default. */
  explicit?: boolean
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
  uid?: number
}): Promise<DataHome> {
  const platform = input.platform ?? process.platform
  const home = input.home ?? homedir()
  const dataDir = resolve(input.dataDir)
  const legacy = legacyDataDir(platform, home)
  if (legacy === undefined) return { dataDir, moved: false }
  const target = defaultDataDir(platform, home, input.env ?? process.env)
  if (dataDir !== legacy && dataDir !== target) return { dataDir, moved: false }

  const [old, now] = await Promise.all([kind(legacy), kind(target)])
  if (!hasData(old)) {
    // Nothing at the old place to move. A start that still names it goes to where the data is.
    if (dataDir === legacy && hasData(now))
      return { dataDir: target, moved: false, note: `数据目录在 ${target}，没有使用旧位置 ${legacy}。` }
    // A new install found through the default starts at the new place, not in an empty directory left at the old one.
    if (dataDir === legacy && !input.explicit) return { dataDir: target, moved: false }
    return { dataDir, moved: false }
  }
  if (hasData(now))
    throw refused(
      'data-dir-both',
      `${legacy} 与 ${target} 都有数据，Latch 不替你选，没有启动也没有移动任何东西。确认哪一份是你的之后把另一份移走，或用 --data-dir 指定数据目录。`,
    )
  if (old === 'link') return { dataDir: legacy, moved: false, note: `旧数据目录 ${legacy} 是一个链接，数据留在原处，没有移到 ${target}。` }
  if (input.explicit && dataDir === legacy) return { dataDir: legacy, moved: false }
  if ((await kind(join(legacy, 'workspace'))) !== 'absent')
    return { dataDir: legacy, moved: false, note: `数据目录内有旧的默认文件夹，数据留在 ${legacy}，没有移到 ${target}。` }

  const uid = input.uid ?? process.getuid?.()
  if (uid === undefined) return { dataDir: legacy, moved: false }
  if (!(await ownedDirectory(legacy, uid, 0)))
    throw refused('data-dir-move-refused', `旧数据目录 ${legacy} 不是你自己的普通目录，没有移动。请检查后重试。`)

  const parent = dirname(target)
  if (!(await makePrivateDirectory(parent)) || !(await ownedDirectory(parent, uid, 0o077)))
    throw refused(
      'data-dir-move-refused',
      `${parent} 不是只属于你的普通目录（是链接、属主不同或对他人开放），数据没有移动。请修正后重试（例如 chmod 700 ${parent}）。`,
    )
  const otherVolume = () =>
    refused(
      'data-dir-move-volume',
      `旧数据目录 ${legacy} 与 ${parent} 不在同一个磁盘上，没有移动（Latch 不复制数据目录）。请停止 Latch 后自行把它移到 ${target}。`,
    )
  if ((await stat(legacy)).dev !== (await stat(parent)).dev) throw otherVolume()

  await refuseWhileUsed(legacy)
  // Held across the rename: another start or an offline command sees this directory as taken until it is gone.
  const lock = await acquireDataDirLock(legacy, 'host')
  try {
    // An empty directory at the new place is replaced by the rename; one with anything in it makes the rename fail.
    if (hasData(await kind(target))) throw refused('data-dir-both', `${target} 已经有数据，没有移动。`)
    await rename(legacy, target)
  } catch (error) {
    await lock.release()
    if (codeOf(error) === 'EXDEV') throw otherVolume()
    if (codeOf(error) === 'ENOTEMPTY' || codeOf(error) === 'EEXIST') throw refused('data-dir-both', `${target} 已经有数据，没有移动。`)
    throw error
  }
  // The lock file travelled with the directory; this process wrote it, so it removes it for the start that follows.
  const carried = join(target, 'host.lock')
  if ((await readFile(carried, 'utf8').catch(() => '')).includes(lock.instanceId)) await unlink(carried).catch(() => {})

  const note = `数据目录已从 ${legacy} 移到 ${target}。`
  return {
    dataDir: target,
    moved: true,
    from: legacy,
    note: (await mark(legacy, target))
      ? note
      : `${note}\n没能在旧位置留下说明文件：不要再用旧版本的 Latch 启动，它会在 ${legacy} 新建一份空数据。`,
  }
}

/** The file at the old path. A directory that appeared there in the meantime (another command's mkdir) is removed if empty. */
async function mark(legacy: string, target: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(legacy, MARKER(target), { flag: 'wx', mode: 0o600 })
      return true
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') return false
      // Only an empty directory is removed; anything else at the path is left as it is.
      const removed = await rmdir(legacy).then(
        () => true,
        () => false,
      )
      if (!removed) return (await kind(legacy)) === 'other'
    }
  }
  return false
}
