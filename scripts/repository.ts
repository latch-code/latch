import { execFile } from 'node:child_process'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Read-only git calls. External diff drivers and textconv filters are commands taken from git configuration, so they
 * are turned off; nothing here writes to the repository or runs a hook.
 */
async function git(root: string, args: readonly string[], input?: string): Promise<string> {
  const child = run('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...args], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  })
  if (input !== undefined) {
    child.child.stdin?.end(input)
  }
  return (await child).stdout
}

function nulList(output: string): string[] {
  return output.split('\0').filter(item => item !== '')
}

/** A repository as the agent-facing checks see it: paths use `/` and are relative to `root`. */
export interface Repository {
  root: string
  /** Tracked files and untracked files that git does not ignore; a symbolic link is listed as a file. */
  files: ReadonlySet<string>
  /** Every directory that contains one of `files`. */
  dirs: ReadonlySet<string>
  read(path: string): Promise<string>
  /** The target of a symbolic link, or undefined when the path is not one. */
  link(path: string): Promise<string | undefined>
  /** The paths among `paths` that git ignores: build output, installed packages and user data. */
  ignored(paths: readonly string[]): Promise<ReadonlySet<string>>
}

export function directoriesOf(files: Iterable<string>): Set<string> {
  const dirs = new Set<string>()
  for (const file of files) {
    for (let dir = posix.dirname(file); dir !== '.' && !dirs.has(dir); dir = posix.dirname(dir)) dirs.add(dir)
  }
  return dirs
}

/** The working tree of the git repository at `root`, without the files git ignores. */
export async function openRepository(root: string): Promise<Repository> {
  const listed = nulList(await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
  const files = new Set<string>()
  for (const file of listed) {
    // A tracked file deleted from the working tree is still listed by --cached.
    if (
      await lstat(join(root, file)).then(
        () => true,
        () => false,
      )
    )
      files.add(file)
  }
  return {
    root,
    files,
    dirs: directoriesOf(files),
    read: path => readFile(join(root, path), 'utf8'),
    link: async path => {
      const stats = await lstat(join(root, path)).catch(() => undefined)
      return stats?.isSymbolicLink() ? readlink(join(root, path)) : undefined
    },
    ignored: async paths => {
      if (paths.length === 0) return new Set()
      // Exit status 1 means that none of the paths is ignored.
      const output = await git(root, ['check-ignore', '--no-index', '-z', '--stdin'], paths.map(path => `${path}\0`).join('')).catch(
        (error: { code?: number; stdout?: string }) => {
          if (error.code === 1) return ''
          throw error
        },
      )
      return new Set(nulList(output))
    },
  }
}

export interface Change {
  /** `A` added (untracked files included), `M` modified, `D` deleted, `R` renamed, `C` copied, `T` type changed. */
  status: string
  path: string
  /** The previous path of a renamed or copied file. */
  from?: string
}

/**
 * Files that differ between `base` and the working tree (staged or not), plus untracked files git does not ignore.
 * `base` defaults to HEAD, which leaves only the uncommitted changes.
 */
export async function changedFiles(root: string, base = 'HEAD'): Promise<Change[]> {
  const fields = nulList(await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', base, '--']))
  const changes: Change[] = []
  const next = (): string => fields.shift() ?? ''
  while (fields.length > 0) {
    const status = next().charAt(0)
    if (status === 'R' || status === 'C') {
      const from = next()
      changes.push({ status, path: next(), from })
    } else {
      changes.push({ status, path: next() })
    }
  }
  for (const path of nulList(await git(root, ['ls-files', '-z', '--others', '--exclude-standard']))) changes.push({ status: 'A', path })
  return changes
}

/** Lines that `base` does not have, by file: the added side of the diff, or every line of an untracked file. */
export async function addedLines(root: string, changes: readonly Change[], base = 'HEAD'): Promise<Map<string, string[]>> {
  const added = new Map<string, string[]>()
  const tracked = changes.filter(change => change.status !== 'D')
  // Explicit prefixes: diff.noprefix or diff.mnemonicPrefix in the user's configuration would change the `+++` lines.
  const diff = await git(root, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--unified=0',
    '-M',
    base,
    '--',
  ])
  let current: string | undefined
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      current = line === '+++ /dev/null' ? undefined : line.slice(6)
      continue
    }
    if (current !== undefined && line.startsWith('+')) {
      const lines = added.get(current) ?? []
      lines.push(line.slice(1))
      added.set(current, lines)
    }
  }
  for (const change of tracked) {
    if (added.has(change.path) || change.status !== 'A') continue
    const text = await readFile(join(root, change.path), 'utf8').catch(() => undefined)
    if (text !== undefined && !text.includes('\0')) added.set(change.path, text.split('\n'))
  }
  return added
}

/** Directories of the commit `base`, with `/` separators. */
export async function treeDirectories(root: string, base = 'HEAD'): Promise<Set<string>> {
  return new Set(nulList(await git(root, ['ls-tree', '-r', '-d', '-z', '--name-only', base])))
}

/** The outermost of `dirs`: those whose parent directory is not in the list as well. */
export function outermost(dirs: Iterable<string>): string[] {
  const set = new Set(dirs)
  return [...set].filter(dir => !set.has(posix.dirname(dir))).toSorted()
}
