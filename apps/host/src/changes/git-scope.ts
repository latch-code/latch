// The 未提交 and 与 main 比较 scopes: each session folder at the top of a Git work tree, compared with HEAD or with the
// commit where its branch left main. Git lists the tree and the index; the Host compares the files.
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { isFileMention } from '@latch/protocol'
import { readGitLayout, type GitLayout } from '../branch-reader.ts'
import { isIgnoredPath } from '../files/ignore.ts'
import type { FileRoot } from '../files/resolve.ts'
import { GitError, blobId, type GitReader, type IndexListing, type TreeEntry } from './git.ts'
import type { Pair, Side, WorkSide } from './sides.ts'
import type { ChangeUnavailable } from '@latch/protocol'
import { signature } from './walk.ts'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
/** Branches 与 main 比较 compares with, in order: the first that exists, locally or as origin's. */
const BASES = ['main', 'master'] as const
const PARALLEL = 16

export interface GitScope {
  pairs: Pair[]
  /** The repositories the pairs came from, by folder ID, for reading blobs. */
  repositories: Map<string, GitLayout>
  /** The Git object ID of each work-tree side hashed while comparing, for renames and discard checks. */
  workIds: Map<Side, string>
  notGit: string[]
  base?: string
  partial: boolean
  unavailable?: ChangeUnavailable
}

/** Git blob IDs of work-tree files by path and signature, so an unchanged file is hashed once. */
export class BlobIdCache {
  private readonly ids = new Map<string, { sig: string; id: string }>()
  constructor(private readonly limit = 100_000) {}

  async of(path: string, info: BigIntStats, format: 'sha1' | 'sha256', maxSize: number): Promise<string | undefined> {
    const sig = `${format}:${signature(info)}`,
      known = this.ids.get(path)
    if (known?.sig === sig) return known.id
    if (info.size > BigInt(maxSize)) return undefined
    let bytes: Buffer
    try {
      const handle = await open(path, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK)
      try {
        const opened = await handle.stat({ bigint: true })
        if (!opened.isFile() || signature(opened) !== signature(info)) return undefined
        bytes = await handle.readFile()
      } finally {
        await handle.close()
      }
    } catch {
      return undefined
    }
    const id = blobId(bytes, format)
    this.ids.delete(path)
    this.ids.set(path, { sig, id })
    if (this.ids.size > this.limit) this.ids.delete(this.ids.keys().next().value!)
    return id
  }
}

const absent = (error: unknown) => error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')

async function baseCommit(reader: GitReader, layout: GitLayout, head: string): Promise<{ name: string; commit: string } | undefined> {
  if (!('branch' in layout.head)) return undefined
  for (const name of BASES) {
    if (layout.head.branch === name) return undefined
    for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`] as const) {
      const commit = await reader.commit(layout, ref)
      if (!commit) continue
      const base = await reader.mergeBase(layout, head, commit)
      return base ? { name, commit: base } : undefined
    }
  }
  return undefined
}

export interface GitScopeOptions {
  reader: GitReader
  ids: BlobIdCache
  /** Tree entries and index paths per folder. */
  entryLimit: number
  /** Files larger than this are compared by size only. */
  hashLimit: number
}

/** The scope's pairs for every folder at the top of a Git work tree; `before` is a blob, `after` the file now. */
export async function gitPairs(folders: readonly FileRoot[], scope: 'uncommitted' | 'base', options: GitScopeOptions): Promise<GitScope> {
  const result: GitScope = { pairs: [], repositories: new Map(), workIds: new Map(), notGit: [], partial: false }
  let compared = 0,
    noBase = false,
    noHead = false
  for (const folder of folders) {
    const layout = await readGitLayout(folder.path)
    if (!layout || layout.root !== folder.path) {
      result.notGit.push(folder.id)
      continue
    }
    try {
      const head = await options.reader.commit(layout, 'HEAD')
      let commit: string | undefined
      if (scope === 'base') {
        const base = head ? await baseCommit(options.reader, layout, head) : undefined
        if (!base) {
          noBase = true
          continue
        }
        result.base ??= base.name
        commit = base.commit
      } else if (head) commit = head
      else noHead = true
      const tree = commit ? await options.reader.tree(layout, commit, options.entryLimit) : new Map<string, TreeEntry>()
      const index = await options.reader.index(layout, options.entryLimit)
      if (!tree || !index) {
        result.partial = true
        continue
      }
      result.repositories.set(folder.id, layout)
      compared++
      await compareFolder(folder, tree, index, commit?.length === 64 ? 'sha256' : 'sha1', options, result)
    } catch (error) {
      if (!(error instanceof GitError)) throw error
      result.partial = true
    }
  }
  if (!compared)
    result.unavailable = result.notGit.length === folders.length ? 'not-git' : noBase ? 'no-base' : noHead ? 'no-head' : 'git-failed'
  return result
}

async function compareFolder(
  folder: FileRoot,
  tree: Map<string, TreeEntry>,
  index: IndexListing,
  format: 'sha1' | 'sha256',
  options: GitScopeOptions,
  result: GitScope,
): Promise<void> {
  const absolute = (path: string) => join(folder.path, ...path.split('/'))
  const work = (path: string, info: BigIntStats): WorkSide => ({
    from: 'work',
    root: folder,
    path,
    size: Number(info.size),
    mode: Number(info.mode & 0o777n),
    dev: info.dev,
    ino: info.ino,
  })
  const deleted: Pair[] = [],
    added: Pair[] = []
  // Symlinks are left out as in the snapshots, and so are paths the Host cannot name and sparse-checkout gaps.
  const tracked = [...tree].filter(
    ([path, entry]) => entry.mode !== '120000' && !index.skipped.has(path) && isFileMention({ root: folder.id, path }),
  )
  const compared: Array<Pair | undefined> = Array.from({ length: tracked.length })
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, tracked.length) }, async () => {
      while (next < tracked.length) {
        const at = next++
        const [path, entry] = tracked[at]!
        const before: Side = { from: 'blob', oid: entry.oid, mode: entry.mode, size: entry.size }
        const info = await lstat(absolute(path), { bigint: true }).catch((error: unknown) => {
          if (absent(error)) return undefined
          throw error
        })
        if (!info || info.isDirectory()) {
          compared[at] = { root: folder.id, path, before }
          continue
        }
        if (!info.isFile()) continue
        const after = work(path, info)
        const id = await options.ids.of(absolute(path), info, format, options.hashLimit)
        if (id) result.workIds.set(after, id)
        const executable = (info.mode & 0o111n) !== 0n
        if (executable === (entry.mode === '100755') && (id ? id === entry.oid : BigInt(entry.size) === info.size)) continue
        compared[at] = { root: folder.id, path, before, after }
      }
    }),
  )
  for (const pair of compared) {
    if (!pair) continue
    if (!pair.after) deleted.push(pair)
    result.pairs.push(pair)
  }
  for (const path of [...index.tracked, ...index.untracked].toSorted()) {
    if (tree.has(path) || !isFileMention({ root: folder.id, path })) continue
    if (index.untracked.has(path) && isIgnoredPath(path)) continue
    const info = await lstat(absolute(path), { bigint: true }).catch(() => undefined)
    if (!info?.isFile()) continue
    const after = work(path, info)
    const id = await options.ids.of(absolute(path), info, format, options.hashLimit)
    if (id) result.workIds.set(after, id)
    const pair: Pair = { root: folder.id, path, after }
    added.push(pair)
    result.pairs.push(pair)
  }
  // A deleted file whose exact content reappears at a new path was renamed.
  const byId = new Map<string, Pair>()
  for (const pair of added) {
    const id = result.workIds.get(pair.after!)
    if (id && !byId.has(id)) byId.set(id, pair)
  }
  for (const pair of deleted) {
    const oid = (pair.before as Extract<Side, { from: 'blob' }>).oid,
      match = byId.get(oid)
    if (!match) continue
    byId.delete(oid)
    match.oldPath = pair.path
    match.before = pair.before
    result.pairs.splice(result.pairs.indexOf(pair), 1)
  }
}
