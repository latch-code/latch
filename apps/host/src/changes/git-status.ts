// The restricted half of 交付 (docs/GIT-DELIVERY.md): the status, staging without filters, unstaging and the commit
// checks, all through `GitReader` with hooks, fsmonitor and transports off. None of these runs a program the repository
// names: a filter driver the configuration lists is emptied for every process here, and `add` runs here only when the
// configuration lists none (`git-delivery.ts` stages with your own Git otherwise).
import { constants } from 'node:fs'
import { access, lstat, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { escapeSecurityText, type GitDeliveryFile, type GitFileStatus } from '@latch/protocol'
import { redactSecrets, sha256Hex } from '@latch/core/node-kit'
import type { GitLayout } from '../branch-reader.ts'
import { codeOf } from '../http-util.ts'
import { GitError, type GitReader } from './git.ts'

/** Hook names Git knows; only these are listed, and audit records name nothing else. */
export const KNOWN_HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'post-index-change',
] as const
export type HookName = (typeof KNOWN_HOOKS)[number]
const HOOKS: ReadonlySet<string> = new Set(KNOWN_HOOKS)

export const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
/** A remote name delivery will push to: no option, path or URL shape. */
export const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u
/** Entries a status lists before it says how many more there are. */
export const STATUS_LIMIT = 2_000
export const PATHS_LIMIT = 1_000

/** Added to every restricted write here: no automatic gc or maintenance, no submodule recursion. */
const WRITE_CONFIG = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'submodule.recurse=false']

/** What the repository's configuration says, read without running anything it names. */
export interface RepositoryConfig {
  /** Filter drivers named in any scope. */
  drivers: string[]
  hooksPath?: string
  remotes: Set<string>
  /** The current branch's upstream, when its remote is one of `remotes`. */
  upstream?: { remote: string; ref: string }
  /** `branch.<branch>.remote` and `.merge` as configured, usable or not. */
  configuredUpstream?: { remote?: string; ref?: string }
  /** Where a push goes instead of the upstream's remote: `branch.<branch>.pushRemote`, else `remote.pushDefault`. */
  pushRemote?: string
}

/** Every filter driver emptied and made optional for one Git process, through the environment's configuration. */
export function filterOverrides(drivers: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {}
  let index = 0
  for (const driver of drivers)
    for (const [key, value] of [
      ['process', ''],
      ['clean', ''],
      ['smudge', ''],
      ['required', 'false'],
    ] as const) {
      env[`GIT_CONFIG_KEY_${index}`] = `filter.${driver}.${key}`
      env[`GIT_CONFIG_VALUE_${index}`] = value
      index++
    }
  env.GIT_CONFIG_COUNT = String(index)
  return env
}

export async function readRepositoryConfig(git: GitReader, layout: GitLayout): Promise<RepositoryConfig> {
  const out = await git.run(layout, ['config', '--null', '--list', '--show-scope'], { maxBytes: 4 * 1024 * 1024 }).catch(() => {
    throw new GitError('failed')
  })
  const drivers = new Set<string>(),
    remotes = new Set<string>()
  const values = new Map<string, string>()
  const fields = out.toString('utf8').split('\0')
  // `--show-scope --null`: the scope, then `key\nvalue`. The restricted runner's own `-c` options are the command scope.
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const scope = fields[at]!,
      record = fields[at + 1]!
    if (scope === 'command') continue
    const newline = record.indexOf('\n')
    const key = newline < 0 ? record : record.slice(0, newline),
      value = newline < 0 ? 'true' : record.slice(newline + 1)
    const filter = /^filter\.([\s\S]+)\.(?:clean|smudge|process|required)$/u.exec(key)
    if (filter) drivers.add(filter[1]!)
    const remote = /^remote\.([\s\S]+)\.url$/u.exec(key)
    if (remote) remotes.add(remote[1]!)
    // Later entries win, as they do for Git.
    values.set(key, value)
  }
  const branch = 'branch' in layout.head ? layout.head.branch : undefined
  const remote = branch === undefined ? undefined : values.get(`branch.${branch}.remote`)
  const merge = branch === undefined ? undefined : values.get(`branch.${branch}.merge`)
  const hooksPath = values.get('core.hookspath')
  const pushRemote = (branch === undefined ? undefined : values.get(`branch.${branch}.pushremote`)) ?? values.get('remote.pushdefault')
  return {
    drivers: [...drivers],
    ...(hooksPath ? { hooksPath } : {}),
    remotes,
    ...(remote !== undefined || merge !== undefined
      ? { configuredUpstream: { ...(remote !== undefined ? { remote } : {}), ...(merge !== undefined ? { ref: merge } : {}) } }
      : {}),
    ...(pushRemote !== undefined ? { pushRemote } : {}),
    ...(remote && merge && remotes.has(remote) && REMOTE_NAME.test(remote) && /^refs\/heads\/\S+$/u.test(merge)
      ? { upstream: { remote, ref: merge } }
      : {}),
  }
}

/** The executable hooks Git would run here, by name; the directory is only listed, nothing in it runs. */
export async function listHooks(config: RepositoryConfig, layout: GitLayout, commonDir: string, home: string): Promise<HookName[]> {
  let dir = join(commonDir, 'hooks')
  if (config.hooksPath !== undefined) {
    const path = config.hooksPath
    dir = path === '~' || path.startsWith('~/') ? join(home, path.slice(1)) : isAbsolute(path) ? path : join(layout.root, path)
  }
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const found: HookName[] = []
  for (const name of names.toSorted()) {
    if (!HOOKS.has(name)) continue
    try {
      if (!(await stat(join(dir, name))).isFile()) continue
      await access(join(dir, name), constants.X_OK)
      found.push(name as HookName)
    } catch {
      // Not there, or not executable: Git skips it too.
    }
  }
  return found
}

/** The repository's shared Git directory, which every worktree of it uses. */
export async function commonDirOf(git: GitReader, layout: GitLayout): Promise<string> {
  const out = (await git.run(layout, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { maxBytes: 8192 }))
    .toString('utf8')
    .trim()
  if (!isAbsolute(out) || out.includes('\n')) throw new GitError('failed')
  return out
}

export interface StatusListing {
  head?: string
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  staged: GitDeliveryFile[]
  unstaged: GitDeliveryFile[]
  untracked: string[]
  conflicted: string[]
  more?: number
  /** Every staged entry, past the listing's limit too. */
  stagedCount: number
  conflictedCount: number
}

const SIDE: Readonly<Record<string, GitFileStatus>> = { A: 'A', M: 'M', D: 'D', T: 'T', R: 'M', C: 'A' }

/** Shown as the branch reader shows names: never a secret's shape, hidden characters made visible. */
function shownName(name: string): string | undefined {
  return name.length <= 256 && redactSecrets(name) === name ? escapeSecurityText(name) : undefined
}

function utf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * `status --porcelain=v2`: the index against HEAD, the work tree against the index, untracked and conflicted files.
 * Comparing the work tree is what would run a clean filter, so each one the configuration names is emptied: a file such
 * a filter changes may show as modified. Submodules are not looked into.
 */
export async function readStatus(git: GitReader, layout: GitLayout, drivers: readonly string[]): Promise<StatusListing> {
  const out = await git.run(
    layout,
    ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--no-renames', '--ignore-submodules=all'],
    { maxBytes: 64 * 1024 * 1024, env: filterOverrides(drivers) },
  )
  const listing: StatusListing = {
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    stagedCount: 0,
    conflictedCount: 0,
  }
  let listed = 0,
    more = 0
  const add = <T>(list: T[], item: T) => {
    if (listed < STATUS_LIMIT) {
      list.push(item)
      listed++
    } else more++
  }
  for (let at = 0; at < out.length;) {
    const end = out.indexOf(0, at)
    const record = out.subarray(at, end < 0 ? out.length : end)
    at = end < 0 ? out.length : end + 1
    const kind = String.fromCharCode(record[0] ?? 0)
    if (kind === '#') {
      const [key, ...rest] = record.toString('utf8').slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid' && OID.test(value)) listing.head = value
      else if (key === 'branch.head' && value !== '(detached)') {
        const shown = shownName(value)
        if (shown) listing.branch = shown
      } else if (key === 'branch.upstream') {
        const shown = shownName(value)
        if (shown) listing.upstream = shown
      } else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/u.exec(value)
        if (match) {
          listing.ahead = Number(match[1])
          listing.behind = Number(match[2])
        }
      }
      continue
    }
    if (kind === '?') {
      const path = utf8(record.subarray(2))
      if (path) add(listing.untracked, path)
      continue
    }
    if (kind !== '1' && kind !== 'u') continue
    // `1 XY sub mH mI mW hH hI path`, `u XY sub m1 m2 m3 mW h1 h2 h3 path`: the path is everything after that many spaces.
    let spaces = kind === '1' ? 8 : 10,
      start = 0
    while (spaces > 0 && start < record.length) if (record[start++] === 0x20) spaces--
    const path = utf8(record.subarray(start))
    if (!path) continue
    const x = String.fromCharCode(record[2] ?? 0),
      y = String.fromCharCode(record[3] ?? 0)
    if (kind === 'u') {
      listing.conflictedCount++
      add(listing.conflicted, path)
      continue
    }
    const staged = SIDE[x],
      unstaged = SIDE[y]
    if (staged) {
      listing.stagedCount++
      add(listing.staged, { path, status: staged })
    }
    if (unstaged) add(listing.unstaged, { path, status: unstaged })
  }
  if (more) listing.more = more
  return listing
}

/**
 * Paths as a request gives them: relative to the top level, `/`-separated, no `.`/`..`/empty part, nothing inside a
 * `.git`, and no folder along the way a symbolic link (the file itself may be one: Git stores the link). Refused as a
 * whole when any one is not.
 */
export async function checkPaths(root: string, paths: readonly string[]): Promise<string[]> {
  const unique = [...new Set(paths)]
  for (const path of unique) {
    const parts = path.split('/')
    if (
      !path
      || Buffer.byteLength(path) > 4096
      || /[\u0000-\u001f\u007f\\]/u.test(path)
      || parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
    )
      throw new GitPathError()
    for (let depth = 1; depth < parts.length; depth++) {
      try {
        const info = await lstat(join(root, ...parts.slice(0, depth)))
        if (!info.isDirectory()) throw new GitPathError()
      } catch (error) {
        if (error instanceof GitPathError) throw error
        // A folder that is gone: a deletion to stage or unstage.
        if (codeOf(error) === 'ENOENT') break
        throw new GitPathError()
      }
    }
  }
  return unique
}

export class GitPathError extends Error {
  constructor() {
    super('git-paths-invalid')
  }
}

/** The paths, NUL-separated, read literally (`GIT_LITERAL_PATHSPECS`) from standard input. */
function pathspecs(paths: readonly string[]) {
  return { input: `${paths.join('\0')}\0`, env: { GIT_LITERAL_PATHSPECS: '1' } }
}

/** `add` in the restricted Git: only for a repository whose configuration names no filter driver. */
export async function stageRestricted(git: GitReader, layout: GitLayout, paths: readonly string[], timeoutMs: number): Promise<void> {
  const { input, env } = pathspecs(paths)
  await git.run(layout, [...WRITE_CONFIG, 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], {
    input,
    env,
    maxBytes: 1024 * 1024,
    timeoutMs,
  })
}

/** Back to HEAD's version in the index (out of it before the first commit); the work tree is not touched or compared. */
export async function unstageRestricted(
  git: GitReader,
  layout: GitLayout,
  paths: readonly string[],
  drivers: readonly string[],
  head: string | undefined,
  timeoutMs: number,
): Promise<void> {
  const { input, env } = pathspecs(paths)
  const args = head
    ? ['reset', '--quiet', '--no-refresh', '--pathspec-from-file=-', '--pathspec-file-nul', head]
    : ['rm', '--quiet', '--cached', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul']
  await git.run(layout, [...WRITE_CONFIG, ...args], {
    input,
    env: { ...env, ...filterOverrides(drivers) },
    maxBytes: 1024 * 1024,
    timeoutMs,
  })
}

/** The tree the index would commit; Git writes the tree objects it needs, which changes nothing a person sees. */
export async function indexTree(git: GitReader, layout: GitLayout): Promise<string> {
  const out = (await git.run(layout, ['write-tree'], { maxBytes: 256 })).toString('utf8').trim()
  if (!OID.test(out)) throw new GitError('failed')
  return out
}

/** Whether Git knows who commits here (`user.name` and `user.email`, or what it derives); never runs anything. */
export async function hasIdentity(git: GitReader, layout: GitLayout): Promise<boolean> {
  try {
    await git.run(layout, ['var', 'GIT_COMMITTER_IDENT'], { maxBytes: 4096 })
    await git.run(layout, ['var', 'GIT_AUTHOR_IDENT'], { maxBytes: 4096 })
    return true
  } catch (error) {
    if (error instanceof GitError && error.reason === 'failed') return false
    throw error
  }
}

/** The first line with text, as `--cleanup=whitespace` keeps it; what identifies a commit after hooks edited the rest. */
export function subjectOf(message: string): string {
  return (
    message
      .split('\n')
      .find(line => line.trim())
      ?.trimEnd() ?? ''
  )
}

export interface CommitIdentity {
  preHead?: string
  indexTree?: string
  subjectHash: string
  /** Hooks did not run, so nothing could restage: the tree must be the index's. */
  skipHooks?: true
}

/**
 * The commit an attempt made, looked for in the last 64 commits on HEAD's first-parent line: its first parent is the
 * HEAD before (none before the first commit) and its subject is the one sent. Undefined when none is.
 */
export async function findCommit(git: GitReader, layout: GitLayout, identity: CommitIdentity): Promise<string | undefined> {
  let out: Buffer
  try {
    out = await git.run(layout, ['rev-list', '--first-parent', '--max-count=64', '--parents', 'HEAD', '--'], { maxBytes: 64 * 200 })
  } catch (error) {
    if (error instanceof GitError && error.reason === 'failed') return undefined
    throw error
  }
  const candidates = out
    .toString('utf8')
    .split('\n')
    .map(line => line.trim().split(' '))
    .filter(([commit, parent]) => commit && OID.test(commit) && (identity.preHead ? parent === identity.preHead : parent === undefined))
    .map(([commit]) => commit!)
  for (const commit of candidates) {
    const body = (await git.run(layout, ['cat-file', 'commit', commit], { maxBytes: 1024 * 1024 })).toString('utf8')
    const split = body.indexOf('\n\n')
    if (split < 0) continue
    const tree = /^tree ([0-9a-f]+)$/mu.exec(body.slice(0, split))?.[1]
    if (identity.skipHooks && identity.indexTree && tree !== identity.indexTree) continue
    if (sha256Hex(subjectOf(body.slice(split + 2))) === identity.subjectHash) return commit
  }
  return undefined
}

/** HEAD, when it is a new commit whose first parent is `preHead` (a root commit when there was none before). */
export async function committedOnTop(git: GitReader, layout: GitLayout, preHead: string | undefined): Promise<string | undefined> {
  try {
    const [commit, parent] = (await git.run(layout, ['rev-list', '--parents', '--max-count=1', 'HEAD', '--'], { maxBytes: 1024 }))
      .toString('utf8')
      .trim()
      .split(' ')
    if (!commit || !OID.test(commit) || commit === preHead) return undefined
    return parent === preHead ? commit : undefined
  } catch {
    return undefined
  }
}
