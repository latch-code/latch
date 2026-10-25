import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { promisify } from 'node:util'

/**
 * Time Machine's per-item ("sticky") exclusion: the extended attribute `tmutil addexclusion` writes without `-p`, which
 * needs no administrator rights and stays with the item when it moves. The value is the binary property list holding the
 * string "com.apple.backupd", byte for byte what tmutil stores. The Host writes it with /usr/bin/xattr because
 * `tmutil addexclusion` can block for many seconds while it reaches the backup daemon.
 */
export const BACKUP_EXCLUSION_ATTRIBUTE = 'com.apple.metadata:com_apple_backup_excludeItem'
export const BACKUP_EXCLUSION_VALUE =
  '62706c69737430305f1011636f6d2e6170706c652e6261636b75706408000000000000010100000000000000010000000000000000000000000000001c'
const XATTR = '/usr/bin/xattr'
const TIMEOUT_MS = 5_000

/** Runs /usr/bin/xattr with fixed arguments; rejects on a non-zero exit. */
export type XattrRunner = (args: readonly string[]) => Promise<{ stdout: string }>

const execute = promisify(execFile)
const runXattr: XattrRunner = args => execute(XATTR, [...args], { env: {}, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 })

export interface BackupExclusionOptions {
  /** Default `process.platform`; only macOS has Time Machine. */
  platform?: NodeJS.Platform
  run?: XattrRunner
  log?: (text: string) => void
}

function normalizedHex(text: string): string {
  return text.replace(/\s+/gu, '').toLowerCase()
}

async function excluded(path: string, run: XattrRunner): Promise<boolean> {
  try {
    const { stdout } = await run(['-p', '-s', '-x', BACKUP_EXCLUSION_ATTRIBUTE, path])
    return normalizedHex(stdout) === BACKUP_EXCLUSION_VALUE
  } catch {
    // Exits non-zero when the attribute is missing.
    return false
  }
}

/**
 * Keeps each existing file or directory out of Time Machine backups. Idempotent: an item that already carries the
 * exclusion is left alone. Symbolic links and missing paths are skipped, and xattr acts on the path itself (`-s`), so a
 * path swapped for a link after the check never marks what the link names. The contents are never read. A failure is
 * logged and never thrown, so it cannot stop the Host. Resolves with the paths it marked.
 */
export async function excludeFromBackup(paths: readonly string[], options: BackupExclusionOptions = {}): Promise<string[]> {
  if ((options.platform ?? process.platform) !== 'darwin') return []
  const run = options.run ?? runXattr
  const marked = await Promise.all(
    paths.map(async path => {
      const stats = await lstat(path).catch(() => undefined)
      if (!stats || !(stats.isFile() || stats.isDirectory())) return undefined
      if (await excluded(path, run)) return undefined
      try {
        await run(['-w', '-s', '-x', BACKUP_EXCLUSION_ATTRIBUTE, BACKUP_EXCLUSION_VALUE, path])
        return path
      } catch (error) {
        options.log?.(`无法把 ${path} 排除在时间机器备份之外：${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }),
  )
  return marked.filter((path): path is string => path !== undefined)
}
