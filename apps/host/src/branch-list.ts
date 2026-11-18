// 切换分支's list (docs/BRANCHES.md#切换分支): a project folder's local branches, read from Git's metadata files the way
// branch-reader.ts reads HEAD. Nothing here runs Git or anything a repository names; every file is opened without
// following links, bounded in size and count, and checked to be the same file before and after it is read.
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { escapeSecurityText, type BranchChoice, type BranchListing } from '@latch/protocol'
import { redactSecrets } from '@latch/core/node-kit'
import type { GitLayout } from './branch-reader.ts'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
/** Branches listed at most; the rest are counted in `more`. */
const BRANCH_LIST_LIMIT = 2_000
/** Entries looked at under `refs/heads` at most (folders and files), and how deep. */
const SCAN_LIMIT = 20_000
const DEPTH_LIMIT = 16
/** `packed-refs` read at most. */
const PACKED_LIMIT = 32 * 1024 * 1024
/** Other worktrees' HEADs read at most. */
const WORKTREE_LIMIT = 256
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

/** The repository's metadata could not be read as this module reads it (a reftable repository, a link, a race). */
export class BranchListError extends Error {
  constructor(reason: string) {
    super(`branch-list-${reason}`)
  }
}

const unchanged = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

/**
 * A name a person can read and send back exactly, that Git would take as a branch: at most 256 characters, no hidden
 * characters, nothing that looks like a secret, and Git's own rules for a ref (`git check-ref-format`) plus no
 * leading `-` (an option's shape), `HEAD` or `@`.
 */
export function listableBranch(name: string): boolean {
  if (name.length === 0 || name.length > 256) return false
  if (name.startsWith('-') || name === 'HEAD' || name === '@') return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f~^:?*[\\]/u.test(name)) return false
  if (name.includes('..') || name.includes('@{') || name.includes('//') || name.endsWith('/') || name.endsWith('.')) return false
  for (const part of name.split('/')) if (part.startsWith('.') || part.endsWith('.lock')) return false
  return escapeSecurityText(name) === name && redactSecrets(name) === name
}

/** The repository's shared metadata: `<root>/.git`, the common directory of a linked worktree, or the gitdir itself. */
async function commonOf(layout: GitLayout): Promise<string> {
  if (layout.gitdir === join(layout.root, '.git')) return layout.gitdir
  const worktrees = dirname(layout.gitdir)
  // readGitLayout checked this shape's `commondir` (`../..`) and its ownership.
  if (basename(worktrees) === 'worktrees' && basename(dirname(worktrees)) === '.git') return dirname(worktrees)
  // Any other gitdir that names a common directory is one this module does not follow.
  if (await exists(join(layout.gitdir, 'commondir'))) throw new BranchListError('layout')
  return layout.gitdir
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw new BranchListError('read')
  }
}

/** A regular file with one link, opened without following links, at most `limit` bytes; undefined when it is not there. */
async function readChecked(path: string, limit: number): Promise<Buffer | undefined> {
  let before: BigIntStats
  try {
    before = await lstat(path, { bigint: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw new BranchListError('read')
  }
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) throw new BranchListError('file')
  const fd = await open(path, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw new BranchListError('file')
  })
  try {
    const opened = await fd.stat({ bigint: true })
    if (!unchanged(before, opened)) throw new BranchListError('changed')
    const buffer = Buffer.alloc(Number(opened.size) + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > limit || !unchanged(opened, await fd.stat({ bigint: true }))) throw new BranchListError('changed')
    return buffer.subarray(0, offset)
  } finally {
    await fd.close()
  }
}

function utf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * Loose refs under `refs/heads`: real folders only, a file holding one object ID per branch. A link, a hard link, a
 * symbolic ref or anything else is left out (counted), never followed.
 */
async function looseBranches(common: string, found: Set<string>, left: { out: number }): Promise<void> {
  const heads = join(common, 'refs', 'heads')
  let scanned = 0
  const walk = async (folder: string, prefix: string, depth: number): Promise<void> => {
    let entries: Buffer[]
    try {
      entries = await readdir(folder, { encoding: 'buffer' })
    } catch {
      throw new BranchListError('read')
    }
    for (const raw of entries) {
      if (++scanned > SCAN_LIMIT) throw new BranchListError('too-many')
      const part = utf8(raw)
      if (part === undefined) {
        left.out++
        continue
      }
      const path = join(folder, part),
        name = prefix + part
      const info = await lstat(path, { bigint: true }).catch(() => undefined)
      if (!info) continue
      if (info.isDirectory()) {
        if (depth >= DEPTH_LIMIT) {
          left.out++
          continue
        }
        await walk(path, `${name}/`, depth + 1)
        continue
      }
      if (!info.isFile() || info.nlink !== 1n || info.size > 4096n) {
        left.out++
        continue
      }
      const content = await readChecked(path, 4096).catch(() => undefined)
      const text = content && utf8(content)?.trimEnd()
      if (!text || !OID.test(text)) {
        // A symbolic ref (`ref: …`) or a file that is not a ref.
        left.out++
        continue
      }
      if (listableBranch(name)) found.add(name)
      else left.out++
    }
  }
  const info = await lstat(heads).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw new BranchListError('read')
  })
  if (!info) return
  // A reftable repository keeps a file here for older Gits: its refs are not files this module reads.
  if (!info.isDirectory() || info.isSymbolicLink()) throw new BranchListError('layout')
  await walk(heads, '', 0)
}

/** `packed-refs`: `<oid> refs/heads/<name>` lines; peeled (`^`) lines and the header are skipped. */
async function packedBranches(common: string, found: Set<string>, left: { out: number }): Promise<void> {
  const bytes = await readChecked(join(common, 'packed-refs'), PACKED_LIMIT)
  if (!bytes) return
  const text = utf8(bytes)
  if (text === undefined) throw new BranchListError('file')
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue
    const space = line.indexOf(' ')
    const oid = line.slice(0, space),
      ref = line.slice(space + 1).replace(/\r$/u, '')
    if (space < 0 || !OID.test(oid) || !ref.startsWith('refs/heads/')) continue
    const name = ref.slice('refs/heads/'.length)
    if (listableBranch(name)) found.add(name)
    else if (!found.has(name)) left.out++
  }
}

/** The branch a HEAD file names, if it names one. */
async function headBranch(path: string): Promise<string | undefined> {
  const bytes = await readChecked(path, 4096).catch(() => undefined)
  // eslint-disable-next-line no-control-regex
  const match = bytes && /^ref: refs\/heads\/([^\u0000- \u007f]+)\r?\n?$/u.exec(utf8(bytes) ?? '')
  return match?.[1]
}

/** Branches HEAD names in the repository's other worktrees: the main one and each linked one but this folder's own. */
export async function branchesElsewhere(layout: GitLayout): Promise<Set<string>> {
  const common = await commonOf(layout)
  const held = new Set<string>()
  const heads = [join(common, 'HEAD')]
  let names: string[] = []
  try {
    names = await readdir(join(common, 'worktrees'))
  } catch {
    // No linked worktrees.
  }
  for (const name of names.slice(0, WORKTREE_LIMIT)) heads.push(join(common, 'worktrees', name, 'HEAD'))
  for (const head of heads) {
    if (dirname(head) === layout.gitdir) continue
    const branch = await headBranch(head)
    if (branch) held.add(branch)
  }
  return held
}

/**
 * The local branches of the work tree `layout` checked: loose refs over `packed-refs`, the current branch first, then
 * by name (commit times would need Git's objects). Throws `BranchListError` when the metadata cannot be read this way.
 */
export async function listBranches(layout: GitLayout): Promise<BranchListing> {
  const common = await commonOf(layout)
  if (await exists(join(common, 'reftable'))) throw new BranchListError('layout')
  const found = new Set<string>(),
    left = { out: 0 }
  await looseBranches(common, found, left)
  await packedBranches(common, found, left)
  const elsewhere = await branchesElsewhere(layout)
  const current = 'branch' in layout.head && listableBranch(layout.head.branch) ? layout.head.branch : undefined
  const names = [...found].filter(name => name !== current).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (current) names.unshift(current)
  const listed = names.slice(0, BRANCH_LIST_LIMIT)
  const more = names.length - listed.length + left.out
  return {
    ...(current ? { current } : {}),
    ...('detached' in layout.head ? { detached: layout.head.detached.slice(0, 7) } : {}),
    branches: listed.map((name): BranchChoice => ({
      name,
      ...(name !== current && elsewhere.has(name) ? { checkedOut: true as const } : {}),
    })),
    ...(more > 0 ? { more } : {}),
  }
}
