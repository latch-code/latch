// Read-only Git for the 未提交 and 与 main 比较 scopes. Git only resolves commits, lists a commit's tree and the index,
// and returns blobs: it never compares the work tree itself, because that runs the clean filter a repository's
// .git/config may name for any file (`git diff` does even with --no-ext-diff --no-textconv). The Host hashes the work
// tree's files the way Git does and compares them with the tree. The same runner, with more options, makes worktrees
// (`../worktrees.ts`).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GitOperation } from '@latch/protocol'
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
  // Not reached by the commands the Host runs; emptied so a later command cannot pick them up by accident.
  '-c',
  'core.alternateRefsCommand=',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'tag.gpgSign=false',
  '-c',
  'core.editor=:',
]
/**
 * Hooks Git 2.54 and later run from configuration (`hook.<name>.command` with `hook.<name>.event`), which
 * `core.hooksPath` does not turn off. Every name any configuration scope gives is switched off for each process.
 */
const CONFIG_HOOK = /^hook\.([\s\S]*)\.[a-z][a-z0-9-]*$/u
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
  /** `unsafe-config`: a hook in the configuration whose name cannot be switched off from the command line. */
  constructor(readonly reason: 'failed' | 'timeout' | 'output-limit' | 'unsafe-config') {
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
  /** Tracked paths Git marks as unmerged. */
  unmerged: Set<string>
}

export interface GitReaderOptions {
  binary: string
  timeoutMs?: number
  /** Whose global Git configuration applies; the Host user's home by default. */
  home?: string
}

interface RunOptions {
  input?: string
  maxBytes: number
  env?: Readonly<Record<string, string>>
  exitCodes?: readonly number[]
  timeoutMs?: number
  /** Recheck a write after reading its hook configuration and before starting the command. */
  authorize?: () => Promise<void>
}

/** Runs fixed Git commands in a work tree whose metadata `readGitLayout` checked, with a scrubbed environment. */
export class GitReader {
  private readonly timeoutMs: number
  constructor(private readonly options: GitReaderOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  /**
   * `env` adds variables to the fixed environment, never the Host's own; `exitCodes` lists the statuses that count as
   * success (0 alone by default).
   */
  async run(layout: GitLayout, args: readonly string[], options: RunOptions): Promise<Buffer> {
    const disabled = await this.configHooks(layout, options.env)
    if (options.authorize) await options.authorize()
    return this.spawn(layout, [...disabled, ...args], options)
  }

  /**
   * `-c hook.<name>.enabled=false` for each configured hook, read from every scope and include as the command will read
   * them. A name with `=` or a line break cannot be passed that way, so nothing runs.
   */
  private async configHooks(layout: GitLayout, env: Readonly<Record<string, string>> | undefined): Promise<string[]> {
    const listing = await this.spawn(layout, ['config', '--null', '--name-only', '--list'], {
      maxBytes: 4 * 1024 * 1024,
      ...(env ? { env } : {}),
      timeoutMs: this.timeoutMs,
    })
    const names = new Set<string>()
    for (const key of listing.toString('utf8').split('\0')) {
      if (!key.toLowerCase().startsWith('hook.')) continue
      const name = CONFIG_HOOK.exec(key)?.[1]
      // Any other shape under `hook.` is one this code does not understand, so nothing runs.
      if (name === undefined || /[=\r\n\0]/u.test(name)) throw new GitError('unsafe-config')
      // The empty name too: `-c hook..enabled=false` switches off `[hook ""]`.
      names.add(name)
    }
    return [...names].flatMap(name => ['-c', `hook.${name}.enabled=false`])
  }

  private spawn(layout: GitLayout, args: readonly string[], options: RunOptions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.binary, [...HARDENED, ...args], {
        cwd: layout.root,
        env: {
          PATH: SAFE_PATH,
          HOME: this.options.home ?? homedir(),
          GIT_OPTIONAL_LOCKS: '0',
          GIT_NO_LAZY_FETCH: '1',
          GIT_TERMINAL_PROMPT: '0',
          ...options.env,
          // The checked metadata, so neither discovery nor core.worktree can point Git elsewhere.
          GIT_DIR: layout.gitdir,
          GIT_WORK_TREE: layout.root,
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
      const timer = setTimeout(() => stop(new GitError('timeout')), options.timeoutMs ?? this.timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > options.maxBytes) stop(new GitError('output-limit'))
        else chunks.push(chunk)
      })
      child.on('error', () => settle(new GitError('failed')))
      child.on('close', code => settle(code !== null && (options.exitCodes ?? [0]).includes(code) ? undefined : new GitError('failed')))
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

  /** How many commits `to` has that `from` lacks, or undefined when either is not a commit. */
  async ahead(layout: GitLayout, from: string, to: string): Promise<number | undefined> {
    if (!OID.test(from) || !OID.test(to)) return undefined
    try {
      const out = (await this.run(layout, ['rev-list', '--count', `${from}..${to}`, '--'], { maxBytes: 64 })).toString('utf8').trim()
      return /^\d+$/u.test(out) ? Number(out) : undefined
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
    const listing: IndexListing = { tracked: new Set(), skipped: new Set(), untracked: new Set(), unmerged: new Set() }
    let count = 0
    for (const record of splitRecords(out)) {
      if (record.length < 3 || record[1] !== 0x20) continue
      const tag = String.fromCharCode(record[0]!),
        path = utf8(record.subarray(2))
      if (!path) continue
      if (++count > limit) return undefined
      if (tag === '?') listing.untracked.add(path)
      else if (tag === 'S') listing.skipped.add(path)
      else {
        listing.tracked.add(path)
        if (tag === 'M') listing.unmerged.add(path)
      }
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

/** What each marker Git leaves in its metadata means. Looked up per work tree: a linked one has its own. */
const OPERATIONS: ReadonlyArray<[marker: string, operation: GitOperation]> = [
  ['MERGE_HEAD', 'merge'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
]

/** What Git is in the middle of here. A marker that cannot be read counts as an error, never as nothing under way. */
export async function gitOperation(layout: GitLayout): Promise<GitOperation | undefined> {
  for (const [marker, operation] of OPERATIONS) {
    try {
      await lstat(join(layout.gitdir, marker))
      return operation
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new GitError('failed')
    }
  }
  return undefined
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
