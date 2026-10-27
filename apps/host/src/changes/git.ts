// Read-only Git for the 未提交 and 与 main 比较 scopes. Git only resolves commits, lists a commit's tree and the index,
// and returns blobs: it never compares the work tree itself, because that runs the clean filter a repository's
// .git/config may name for any file (`git diff` does even with --no-ext-diff --no-textconv). The Host hashes the work
// tree's files the way Git does and compares them with the tree.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { GitLayout } from '../branch-reader.ts'

/** Every Git process gets these and nothing it could take from the Host's environment or a repository's hooks. */
const HARDENED = [
  '--no-pager',
  '-c',
  'core.fsmonitor=',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'diff.external=',
  '-c',
  'protocol.allow=never',
  '-c',
  'core.untrackedCache=false',
]
const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
/**
 * Where the Host looks for Git, in order. Not /usr/bin/git on macOS: without the developer tools that stub opens a
 * window offering to install them.
 */
const CANDIDATES =
  process.platform === 'darwin'
    ? [
        '/opt/homebrew/bin/git',
        '/usr/local/bin/git',
        '/Library/Developer/CommandLineTools/usr/bin/git',
        '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
      ]
    : ['/usr/bin/git', '/usr/local/bin/git']
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

export class GitError extends Error {
  constructor(readonly reason: 'failed' | 'timeout' | 'output-limit') {
    super(`git-${reason}`)
  }
}

export function findGit(candidates: readonly string[] = CANDIDATES): string | undefined {
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not installed there.
    }
  }
  return undefined
}

export interface TreeEntry {
  /** `100644`, `100755` or `120000` (a symlink); trees and submodules are not listed. */
  mode: string
  oid: string
  size: number
}

export interface IndexListing {
  /** Paths in the index, without the ones marked skip-worktree. */
  tracked: Set<string>
  /** Paths marked skip-worktree (a sparse checkout): absent from the work tree on purpose. */
  skipped: Set<string>
  /** Untracked paths that no ignore rule covers. */
  untracked: Set<string>
}

export interface GitReaderOptions {
  binary: string
  timeoutMs?: number
}

/** Runs fixed Git commands in a work tree whose metadata `readGitLayout` checked, with a scrubbed environment. */
export class GitReader {
  private readonly timeoutMs: number
  constructor(private readonly options: GitReaderOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  run(layout: GitLayout, args: readonly string[], options: { input?: string; maxBytes: number }): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.binary, [...HARDENED, ...args], {
        cwd: layout.root,
        env: {
          PATH: SAFE_PATH,
          HOME: homedir(),
          // The checked metadata, so neither discovery nor core.worktree can point Git elsewhere.
          GIT_DIR: layout.gitdir,
          GIT_WORK_TREE: layout.root,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_NO_LAZY_FETCH: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
        stdio: ['pipe', 'pipe', 'ignore'],
        // Its own process group, so a stop also ends any process Git started.
        detached: true,
      })
      const chunks: Buffer[] = []
      let bytes = 0,
        settled = false
      const settle = (error: GitError | undefined) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(Buffer.concat(chunks))
      }
      const stop = (reason: GitError) => {
        settle(reason)
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
        child.stdout.destroy()
      }
      const timer = setTimeout(() => stop(new GitError('timeout')), this.timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > options.maxBytes) stop(new GitError('output-limit'))
        else chunks.push(chunk)
      })
      child.on('error', () => settle(new GitError('failed')))
      child.on('close', code => settle(code === 0 ? undefined : new GitError('failed')))
      child.stdin.on('error', () => {})
      child.stdin.end(options.input ?? '')
    })
  }

  /** The commit a revision names, or undefined when there is none (an unborn branch, a missing ref). */
  async commit(layout: GitLayout, revision: 'HEAD' | `refs/${string}`): Promise<string | undefined> {
    try {
      const out = (
        await this.run(layout, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`], { maxBytes: 256 })
      )
        .toString('utf8')
        .trim()
      return OID.test(out) ? out : undefined
    } catch (error) {
      if (error instanceof GitError && error.reason === 'failed') return undefined
      throw error
    }
  }

  async mergeBase(layout: GitLayout, a: string, b: string): Promise<string | undefined> {
    if (!OID.test(a) || !OID.test(b)) return undefined
    try {
      const out = (await this.run(layout, ['merge-base', a, b], { maxBytes: 256 })).toString('utf8').trim()
      return OID.test(out) ? out : undefined
    } catch (error) {
      if (error instanceof GitError && error.reason === 'failed') return undefined
      throw error
    }
  }

  /** The files of a commit's tree, by path relative to the work tree. Undefined past `limit` entries. */
  async tree(layout: GitLayout, commit: string, limit: number): Promise<Map<string, TreeEntry> | undefined> {
    if (!OID.test(commit)) return new Map()
    const out = await this.run(layout, ['ls-tree', '-r', '-z', '-l', '--full-tree', commit], { maxBytes: limit * 400 })
    const entries = new Map<string, TreeEntry>()
    for (const record of splitRecords(out)) {
      const tab = record.indexOf(0x09)
      if (tab < 0) continue
      const [mode, type, oid, size] = record.subarray(0, tab).toString('latin1').split(/ +/u)
      const path = utf8(record.subarray(tab + 1))
      if (type !== 'blob' || !path || !oid || !OID.test(oid) || !['100644', '100755', '120000'].includes(mode!)) continue
      if (entries.size >= limit) return undefined
      entries.set(path, { mode: mode!, oid, size: Number(size) })
    }
    return entries
  }

  /** The index and the untracked files, in one listing. Undefined past `limit` paths. */
  async index(layout: GitLayout, limit: number): Promise<IndexListing | undefined> {
    const out = await this.run(layout, ['ls-files', '-z', '-t', '--cached', '--others', '--exclude-standard'], { maxBytes: limit * 300 })
    const listing: IndexListing = { tracked: new Set(), skipped: new Set(), untracked: new Set() }
    let count = 0
    for (const record of splitRecords(out)) {
      if (record.length < 3 || record[1] !== 0x20) continue
      const tag = String.fromCharCode(record[0]!),
        path = utf8(record.subarray(2))
      if (!path) continue
      if (++count > limit) return undefined
      if (tag === '?') listing.untracked.add(path)
      else if (tag === 'S') listing.skipped.add(path)
      else listing.tracked.add(path)
    }
    return listing
  }

  /** Blob contents by object ID; one over `maxSize`, missing or not a blob is left out. */
  async blobs(layout: GitLayout, oids: readonly string[], maxSize: number): Promise<Map<string, Buffer>> {
    const wanted = [...new Set(oids.filter(oid => OID.test(oid)))]
    const blobs = new Map<string, Buffer>()
    if (!wanted.length) return blobs
    const out = await this.run(layout, ['cat-file', '--batch'], {
      input: `${wanted.join('\n')}\n`,
      maxBytes: wanted.length * (maxSize + 200),
    })
    let at = 0
    while (at < out.length) {
      const end = out.indexOf(0x0a, at)
      if (end < 0) break
      const [oid, type, size] = out.subarray(at, end).toString('latin1').split(' ')
      at = end + 1
      if (type === 'missing' || size === undefined) continue
      const length = Number(size)
      if (!Number.isSafeInteger(length) || at + length > out.length) break
      if (type === 'blob' && length <= maxSize && oid) blobs.set(oid, out.subarray(at, at + length))
      at += length + 1
    }
    return blobs
  }
}

function splitRecords(out: Buffer): Buffer[] {
  const records: Buffer[] = []
  for (let at = 0; at < out.length;) {
    const end = out.indexOf(0, at)
    records.push(out.subarray(at, end < 0 ? out.length : end))
    at = end < 0 ? out.length : end + 1
  }
  return records
}

/** A path as Git printed it, or undefined when it is not UTF-8 (the Host could not name that file). */
function utf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/** The object ID Git gives these bytes as a blob, in the repository's hash (SHA-1, or SHA-256 for 64-digit IDs). */
export function blobId(bytes: Uint8Array, format: 'sha1' | 'sha256'): string {
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}
