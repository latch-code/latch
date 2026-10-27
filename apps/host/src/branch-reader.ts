import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { escapeSecurityText, type TaskSummary } from '@latch/protocol'
import { redactSecrets } from '@latch/core/node-kit'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
const unchanged = (a: BigIntStats, b: BigIntStats) => same(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const inside = (root: string, path: string) => {
  const child = relative(root, path)
  return child === '' || (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child))
}
type Identity = { path: string; info: BigIntStats; owned: boolean }

/** A work tree whose Git metadata passed the checks below. */
export interface GitLayout {
  /** The work tree's real path: the folder that was asked about. */
  root: string
  /** Its Git directory: `<root>/.git`, a gitdir inside the root, or the admin directory of a trusted linked worktree. */
  gitdir: string
  /** What HEAD names: a branch (`main`, `feature/x`) or a detached commit's full digest. */
  head: { branch: string } | { detached: string }
}

/**
 * Locates the Git metadata of a work tree rooted at `cwd`, by reading files only. It never invokes Git, follows refs or
 * reads the index/config/hooks. Undefined for anything but the layouts BRANCHES.md lists.
 */
export async function readGitLayout(cwd: string): Promise<GitLayout | undefined> {
  if (constants.O_NOFOLLOW === undefined) return
  if (!isAbsolute(cwd) || Buffer.byteLength(cwd) > 4096 || /[\u0000-\u001f\u007f]/u.test(cwd)) return
  const checks: Identity[] = []
  const directory = async (path: string, owned = false) => {
    const info = await lstat(path, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('git-directory-refused')
    if (owned && ((info.mode & 0o022n) !== 0n || (process.getuid && info.uid !== BigInt(process.getuid()))))
      throw new Error('git-owner-refused')
    checks.push({ path, info, owned })
  }
  const text = async (path: string, owned = false) => {
    const before = await lstat(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4096n) throw new Error('git-file-refused')
    if (owned && ((before.mode & 0o022n) !== 0n || (process.getuid && before.uid !== BigInt(process.getuid()))))
      throw new Error('git-owner-refused')
    const fd = await open(path, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await fd.stat({ bigint: true })
      if (!unchanged(before, opened)) throw new Error('git-file-changed')
      const buffer = Buffer.alloc(4097)
      let offset = 0
      while (offset < buffer.length) {
        const result = await fd.read(buffer, offset, buffer.length - offset, offset)
        if (!result.bytesRead) break
        offset += result.bytesRead
      }
      if (offset > 4096 || !unchanged(opened, await fd.stat({ bigint: true }))) throw new Error('git-file-changed')
      checks.push({ path, info: opened, owned })
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))
    } finally {
      await fd.close()
    }
  }
  try {
    const root = await realpath(cwd)
    await directory(root)
    const pointer = join(root, '.git'),
      info = await lstat(pointer, { bigint: true })
    let gitdir: string,
      external = false
    if (info.isDirectory() && !info.isSymbolicLink()) {
      await directory(pointer)
      gitdir = pointer
    } else {
      const match = /^gitdir: ([^\u0000\r\n]+)\r?\n?$/u.exec(await text(pointer))
      if (!match) return
      gitdir = resolve(root, match[1]!)
      if (inside(root, gitdir)) {
        let parent = root
        for (const part of relative(root, gitdir).split(sep).filter(Boolean)) {
          parent = join(parent, part)
          await directory(parent)
        }
      } else {
        external = true
        // External worktrees require the conventional trusted admin directory and its exact reverse binding.
        const worktrees = dirname(gitdir),
          common = dirname(worktrees)
        if (basename(worktrees) !== 'worktrees' || basename(common) !== '.git') return
        for (const path of [common, worktrees, gitdir, join(common, 'objects'), join(common, 'refs')]) await directory(path, true)
        const reverse = await text(join(gitdir, 'gitdir'), true),
          shared = await text(join(gitdir, 'commondir'), true)
        if (!/^[^\u0000\r\n]+\r?\n?$/u.test(reverse) || !/^\.\.\/\.\.\r?\n?$/u.test(shared)) return
        const back = resolve(gitdir, reverse.trimEnd())
        if ((await realpath(back)) !== pointer || !same(await lstat(back, { bigint: true }), info)) return
      }
    }
    const head = await text(join(gitdir, 'HEAD'), external)
    const symbolic = /^ref: refs\/heads\/([^\u0000-\u0020\u007f]+)\r?\n?$/u.exec(head)
    const detached = /^([a-f0-9]{40}|[a-f0-9]{64})\r?\n?$/iu.exec(head)
    if (!symbolic && !detached) return
    for (const check of checks) {
      const current = await lstat(check.path, { bigint: true })
      if (current.isSymbolicLink() || !(check.info.isDirectory() ? same(check.info, current) : unchanged(check.info, current))) return
      if (check.owned && ((current.mode & 0o022n) !== 0n || current.uid !== check.info.uid)) return
    }
    if (!same(checks[0]!.info, await stat(cwd, { bigint: true }))) return
    return { root, gitdir, head: symbolic ? { branch: symbolic[1]! } : { detached: detached![1]!.toLowerCase() } }
  } catch {
    return undefined
  }
}

/** The branch label of a work tree rooted at `cwd`, or 「分离于 3f2a1c9」 for a detached HEAD; see `readGitLayout`. */
export async function readGitBranch(cwd: string): Promise<string | undefined> {
  const layout = await readGitLayout(cwd)
  if (!layout) return
  const branch = 'branch' in layout.head ? layout.head.branch : `分离于 ${layout.head.detached.slice(0, 7)}`
  if (branch.length > 256 || redactSecrets(branch) !== branch) return
  return escapeSecurityText(branch)
}

interface Cached {
  cwd: string
  checkedAt: number
  branch?: string
  generation: number
  pending?: Promise<void>
  again: boolean
}
interface Seen {
  cwd: string
  active: boolean
  runId?: string
  updatedAt: string
}
export interface BranchReaderOptions {
  now?: () => number
  changed?(): void
  /** A pure test seam; production always uses the bounded Git metadata reader. */
  read?: (cwd: string) => Promise<string | undefined>
}
/** Snapshot decoration never waits on disk. A bounded cache refreshes on demand and after a settled run. */
export class BranchReader {
  private readonly cache = new Map<string, Cached>()
  private readonly seen = new Map<string, Seen>()
  private readonly active = new Set<Promise<void>>()
  private closed = false
  constructor(private readonly options: BranchReaderOptions = {}) {}
  decorate(summary: TaskSummary): TaskSummary {
    const { branch: _untrusted, ...result } = summary
    if (this.closed || !summary.cwd || !isAbsolute(summary.cwd)) return result
    const now = (this.options.now ?? Date.now)(),
      old = this.seen.get(summary.id),
      active = ['running', 'waiting-approval'].includes(summary.status)
    const force = old && !active && (old.active || old.runId !== summary.runId || old.updatedAt !== summary.updatedAt)
    this.seen.delete(summary.id)
    this.seen.set(summary.id, { cwd: summary.cwd, active, runId: summary.runId, updatedAt: summary.updatedAt })
    while (this.seen.size > 1024) this.seen.delete(this.seen.keys().next().value!)
    let entry = this.cache.get(summary.cwd)
    if (!entry) entry = { cwd: summary.cwd, checkedAt: -Infinity, generation: 0, again: false }
    this.cache.delete(summary.cwd)
    this.cache.set(summary.cwd, entry)
    while (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!)
    if (force || (old && old.cwd !== summary.cwd)) {
      entry.generation++
      entry.checkedAt = -Infinity
      entry.again = true
    }
    if (now - entry.checkedAt >= 30_000) this.refresh(entry)
    return { ...result, ...(entry.branch ? { branch: entry.branch } : {}) }
  }
  private refresh(entry: Cached): void {
    if (this.closed || entry.pending || this.active.size >= 4) return
    const generation = entry.generation
    entry.again = false
    const read = Promise.resolve().then(() => (this.options.read ?? readGitBranch)(entry.cwd))
    const pending = read
      .then(
        branch => {
          if (this.closed || this.cache.get(entry.cwd) !== entry || generation !== entry.generation) return
          const changed = entry.branch !== branch
          entry.branch = branch
          entry.checkedAt = (this.options.now ?? Date.now)()
          if (changed) this.options.changed?.()
        },
        () => {
          if (!this.closed && this.cache.get(entry.cwd) === entry && generation === entry.generation) {
            const changed = entry.branch !== undefined
            entry.branch = undefined
            entry.checkedAt = (this.options.now ?? Date.now)()
            if (changed) this.options.changed?.()
          }
        },
      )
      .finally(() => {
        this.active.delete(pending)
        entry.pending = undefined
        if (entry.again && this.cache.get(entry.cwd) === entry) this.refresh(entry)
      })
    entry.pending = pending
    this.active.add(pending)
  }
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.active)
    this.cache.clear()
    this.seen.clear()
  }
}
