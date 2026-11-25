// Lists the regular files of a session's folders by their metadata, without following a symlink or reading content.
import type { BigIntStats, Dirent } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isFileMention } from '@latch/protocol'
import { isIgnoredPath, isSecretLookingPath } from '../files/ignore.ts'
import { ProtectedPaths, type FileRoot } from '../files/resolve.ts'

export interface WalkedFile {
  root: string
  /** Relative to the folder, `/`-separated. */
  path: string
  /** `dev:ino:size:mtime:ctime`; any write, replacement or rename of the file changes it. */
  sig: string
  dev: bigint
  ino: bigint
  size: number
  /** Permission bits. */
  mode: number
  /** Its name says it may hold a secret, so its content is never read. */
  secret: boolean
}

export interface Walk {
  /** By `fileKey(root, path)`. */
  files: Map<string, WalkedFile>
  /** Folders walked to the end. In any other, a file missing from `files` may still exist. */
  complete: Set<string>
}

export interface WalkLimits {
  /** Directory entries in all folders together. */
  entries: number
  depth: number
  /** `Date.now()` after which the walk stops where it is. */
  deadline: number
}

export const fileKey = (root: string, path: string) => `${root}\n${path}`
export function splitKey(key: string): { root: string; path: string } {
  const at = key.indexOf('\n')
  return { root: key.slice(0, at), path: key.slice(at + 1) }
}

export const signature = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`

const fold = (path: string) => (process.platform === 'darwin' || process.platform === 'win32' ? path.normalize('NFC').toLowerCase() : path)
const ABSENT = new Set(['ENOENT', 'ENOTDIR'])
const codeOf = (error: unknown) => (error instanceof Error && 'code' in error ? error.code : undefined)

/**
 * Latch's private paths, by spelling and by file-system identity, read once per walk: checking each directory with
 * `ProtectedPaths.contains` would resolve every protected path again for each of them.
 */
export class ProtectedIndex {
  private constructor(
    readonly paths: ProtectedPaths,
    private readonly spelled: ReadonlySet<string>,
    private readonly ids: ReadonlySet<string>,
  ) {}

  static async of(paths: readonly string[], managedHome?: { root: string; protectedAncestor: string }): Promise<ProtectedIndex> {
    const spelled = new Set<string>(),
      ids = new Set<string>()
    for (const path of paths) {
      spelled.add(fold(await realpath(path).catch(() => path)))
      const info = await stat(path, { bigint: true }).catch(() => undefined)
      if (info) ids.add(`${info.dev}:${info.ino}`)
    }
    const guard = new ProtectedPaths(
      paths,
      managedHome && { root: managedHome.root, protectedPaths: paths.filter(path => path !== managedHome.protectedAncestor) },
    )
    return new ProtectedIndex(guard, spelled, ids)
  }

  /** An entry found by walking down from a real folder path, so its path is its real path. */
  has(path: string, info: BigIntStats): boolean {
    return this.ids.has(`${info.dev}:${info.ino}`) || this.spelled.has(fold(path))
  }
}

/** The folders' real paths, in order; a folder that no longer exists, is not a directory or is protected is left out. */
export async function realRoots(folders: readonly FileRoot[], guard: ProtectedIndex): Promise<FileRoot[]> {
  const roots: FileRoot[] = []
  for (const folder of folders) {
    const path = await realpath(folder.path).catch(() => undefined)
    if (!path || !(await stat(path).catch(() => undefined))?.isDirectory()) continue
    if (await guard.paths.contains(path).catch(() => true)) continue
    roots.push({ id: folder.id, path })
  }
  return roots
}

/**
 * Walks each folder depth-first in name order, skipping ignored names, symlinks, other non-regular files and protected
 * paths. Stops at the limits and leaves that folder out of `complete`; so does a directory it cannot read.
 */
export async function walkFolders(roots: readonly FileRoot[], guard: ProtectedIndex, limits: WalkLimits): Promise<Walk> {
  const files = new Map<string, WalkedFile>(),
    complete = new Set<string>()
  let entries = 0
  for (const root of roots) {
    let finished = true
    const stack: Array<{ relative: string; depth: number }> = [{ relative: '', depth: 0 }]
    while (stack.length) {
      if (Date.now() > limits.deadline) {
        finished = false
        break
      }
      const { relative, depth } = stack.pop()!
      const directory = relative ? join(root.path, ...relative.split('/')) : root.path
      let names: Dirent[]
      try {
        names = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if (!ABSENT.has(codeOf(error) as string)) finished = false
        continue
      }
      entries += names.length
      if (entries > limits.entries) {
        finished = false
        break
      }
      const children = names
        .map(entry => ({ entry, path: relative ? `${relative}/${entry.name}` : entry.name }))
        .filter(
          ({ entry, path }) => (entry.isFile() || entry.isDirectory()) && !isIgnoredPath(path) && isFileMention({ root: root.id, path }),
        )
        .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      const infos = await Promise.all(
        children.map(({ entry }) =>
          lstat(join(directory, entry.name), { bigint: true }).catch((error: unknown) => {
            if (!ABSENT.has(codeOf(error) as string)) finished = false
            return undefined
          }),
        ),
      )
      // Pushed in reverse, so the stack pops them in name order.
      for (let index = children.length - 1; index >= 0; index--) {
        const info = infos[index],
          { entry, path } = children[index]!
        if (!info || info.isSymbolicLink() || guard.has(join(directory, entry.name), info)) continue
        if (info.isDirectory()) {
          if (depth + 1 <= limits.depth) stack.push({ relative: path, depth: depth + 1 })
          else finished = false
        } else if (info.isFile()) {
          files.set(fileKey(root.id, path), {
            root: root.id,
            path,
            sig: signature(info),
            dev: info.dev,
            ino: info.ino,
            size: Number(info.size),
            mode: Number(info.mode & 0o777n),
            secret: isSecretLookingPath(path),
          })
        }
      }
    }
    if (finished) complete.add(root.id)
  }
  return { files, complete }
}
