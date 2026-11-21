// The history views of 交付: the session's commits, one file's history, a commit's files and
// the branch against its base. Read-only and bounded, through the restricted Git: it lists commits and trees and
// returns blobs, and the Host compares the texts itself, so no diff driver, textconv or filter of the repository runs.
import type { ChangeHunk, GitCommitDiff, GitCommitEntry, GitCommitFileDiff, GitHistory, GitHistoryFile } from '@latch/protocol'
import { redactSecrets } from '@latch/core/node-kit'
import type { GitLayout } from '../branch-reader.ts'
import { hasSecretContent, isSecretPath } from '../files/secrets.ts'
import { EMPTY_TEXT, TEXT_LIMIT, countChanges, decodeText, diffLines, splitText, toHunks } from './diff.ts'
import { GitError, type GitReader } from './git.ts'
import { LINE_LIMIT } from './git-hunks.ts'
import { OID, type RepositoryConfig } from './git-status.ts'

const COMMIT_LIMIT = 50
const FILE_LIMIT = 500
const TIMEOUT_MS = 10_000
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' }
const BASES = ['main', 'master'] as const
const EMPTY_TREE = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
}
/** Never run a diff program or a text conversion the repository names; object IDs in full. */
const PLAIN = ['--no-ext-diff', '--no-textconv', '--no-renames', '--no-abbrev']
const FORMAT = '--format=%H%x00%P%x00%ct%x00%an%x00%s%x00'

/** A person's words out of the repository: one line, no control characters, nothing shaped like a secret, bounded. */
function shown(text: string, limit: number): string {
  // eslint-disable-next-line no-control-regex
  const plain = redactSecrets(text.replace(/[\u0000-\u001f\u007f]/gu, ' ')).trim()
  return plain.length > limit ? `${plain.slice(0, limit - 1)}…` : plain
}

/** The branch a session's commits are told from: main or master, local or origin's, unless HEAD is on it. */
export async function baseOfBranch(
  git: GitReader,
  layout: GitLayout,
  head: string,
): Promise<{ name: string; tip: string; fork: string } | undefined> {
  if (!('branch' in layout.head)) return undefined
  for (const name of BASES) {
    if (layout.head.branch === name) return undefined
    for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`] as const) {
      const tip = await git.commit(layout, ref)
      if (!tip) continue
      const fork = await git.mergeBase(layout, head, tip)
      return fork ? { name, tip, fork } : undefined
    }
  }
  return undefined
}

/**
 * The branch a pull request from HEAD would go into (main or master, the remote's first) and the commits HEAD has that it
 * lacks, from local refs: on that branch itself, none.
 */
export async function aheadOfBase(
  git: GitReader,
  layout: GitLayout,
  head: string,
  remote: string | undefined,
): Promise<{ name: string; ahead: number } | undefined> {
  if (!('branch' in layout.head)) return undefined
  for (const name of BASES) {
    if (layout.head.branch === name) return { name, ahead: 0 }
    const refs = [...(remote ? [`refs/remotes/${remote}/${name}` as const] : []), `refs/heads/${name}` as const]
    for (const ref of refs) {
      const tip = await git.commit(layout, ref)
      if (!tip) continue
      const ahead = await git.ahead(layout, tip, head)
      return ahead === undefined ? undefined : { name, ahead }
    }
  }
  return undefined
}

async function listCommits(
  git: GitReader,
  layout: GitLayout,
  revisions: readonly string[],
  path: string | undefined,
): Promise<{ commits: GitCommitEntry[]; more: boolean }> {
  const out = await git.run(
    layout,
    [
      'rev-list',
      `--max-count=${COMMIT_LIMIT + 1}`,
      ...(path === undefined ? ['--first-parent'] : []),
      FORMAT,
      ...revisions,
      '--',
      ...(path === undefined ? [] : [path]),
    ],
    { maxBytes: (COMMIT_LIMIT + 1) * 16 * 1024, timeoutMs: TIMEOUT_MS, env: LITERAL },
  )
  const fields = out.toString('utf8').split('\0')
  const commits: GitCommitEntry[] = []
  for (let at = 0; at + 4 < fields.length; at += 5) {
    // `rev-list --format` writes a `commit <id>` line before each record.
    const sha = fields[at]!.slice(fields[at]!.lastIndexOf('\n') + 1)
    const seconds = Number(fields[at + 2])
    if (!OID.test(sha) || !Number.isSafeInteger(seconds)) continue
    const subject = shown(fields[at + 4]!, 200),
      author = shown(fields[at + 3]!, 100)
    commits.push({
      sha,
      at: new Date(seconds * 1000).toISOString(),
      ...(subject ? { subject } : {}),
      ...(author ? { author } : {}),
      ...(fields[at + 1]!.trim().includes(' ') ? { merge: true as const } : {}),
    })
  }
  return { commits: commits.slice(0, COMMIT_LIMIT), more: commits.length > COMMIT_LIMIT }
}

/**
 * The session's commits, newest first: the branch's own since it left main, else the ones its upstream lacks, else
 * HEAD's latest. With `path`: the commits on HEAD's line that changed that file.
 */
export async function readHistory(
  git: GitReader,
  layout: GitLayout,
  config: RepositoryConfig,
  options: { path?: string },
): Promise<GitHistory> {
  const head = await git.commit(layout, 'HEAD')
  if (!head) return { range: options.path === undefined ? 'recent' : 'file', commits: [] }
  let range: GitHistory['range'] = 'recent',
    revisions = [head],
    baseName: string | undefined
  if (options.path !== undefined) range = 'file'
  else {
    const base = await baseOfBranch(git, layout, head)
    const upstream =
      !base && config.upstream
        ? await git.commit(layout, `refs/remotes/${config.upstream.remote}/${config.upstream.ref.slice('refs/heads/'.length)}`)
        : undefined
    if (base) {
      range = 'base'
      baseName = base.name
      revisions = [head, `^${base.tip}`]
    } else if (upstream) {
      range = 'upstream'
      revisions = [head, `^${upstream}`]
    }
  }
  const { commits, more } = await listCommits(git, layout, revisions, options.path)
  return { range, ...(baseName ? { base: baseName } : {}), head, commits, ...(more ? { more: true as const } : {}) }
}

/** A commit HEAD reaches, with its first parent; undefined for anything else, so no other object can be asked for. */
export async function reachableCommit(
  git: GitReader,
  layout: GitLayout,
  sha: string,
): Promise<{ sha: string; parent?: string } | undefined> {
  if (!OID.test(sha)) return undefined
  const head = await git.commit(layout, 'HEAD')
  if (!head) return undefined
  try {
    await git.run(layout, ['merge-base', '--is-ancestor', sha, head], { maxBytes: 256, timeoutMs: TIMEOUT_MS })
    const [commit, parent] = (await git.run(layout, ['rev-list', '--parents', '--max-count=1', sha, '--'], { maxBytes: 4096 }))
      .toString('utf8')
      .trim()
      .split(' ')
    if (commit !== sha) return undefined
    return { sha, ...(parent && OID.test(parent) ? { parent } : {}) }
  } catch (error) {
    if (error instanceof GitError && error.reason === 'failed') return undefined
    throw error
  }
}

interface RawEntry {
  path: string
  status: GitHistoryFile['status']
  oldMode: string
  newMode: string
  oldOid: string
  newOid: string
}

const emptyTree = (sha: string) => (sha.length === 64 ? EMPTY_TREE.sha256 : EMPTY_TREE.sha1)

/** The files that differ between two commits' trees (`from` absent: against nothing), by Git's raw listing. */
async function rawEntries(git: GitReader, layout: GitLayout, from: string | undefined, to: string, path?: string): Promise<RawEntry[]> {
  const out = await git.run(
    layout,
    ['diff-tree', '-r', '-z', '--raw', ...PLAIN, from ?? emptyTree(to), to, '--', ...(path === undefined ? [] : [path])],
    { maxBytes: 16 * 1024 * 1024, timeoutMs: TIMEOUT_MS, env: LITERAL },
  )
  const fields = out.toString('utf8').split('\0')
  const entries: RawEntry[] = []
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMDT])/u.exec(fields[at]!)
    const entryPath = fields[at + 1]!
    // A path that is not valid UTF-8 decodes with a replacement character: the Host could not name that file.
    if (!match || !entryPath || entryPath.includes('�')) continue
    if (path !== undefined && entryPath !== path) continue
    entries.push({
      path: entryPath,
      status: match[5] as RawEntry['status'],
      oldMode: match[1]!,
      newMode: match[2]!,
      oldOid: match[3]!,
      newOid: match[4]!,
    })
  }
  return entries
}

async function numstat(
  git: GitReader,
  layout: GitLayout,
  from: string | undefined,
  to: string,
): Promise<Map<string, { add: number; del: number } | 'binary'>> {
  const out = await git.run(layout, ['diff-tree', '-r', '-z', '--numstat', ...PLAIN, from ?? emptyTree(to), to, '--'], {
    maxBytes: 16 * 1024 * 1024,
    timeoutMs: TIMEOUT_MS,
  })
  const counts = new Map<string, { add: number; del: number } | 'binary'>()
  for (const record of out.toString('utf8').split('\0')) {
    const [add, del, ...rest] = record.split('\t')
    const path = rest.join('\t')
    if (!path || add === undefined || del === undefined) continue
    counts.set(path, add === '-' || del === '-' ? 'binary' : { add: Number(add), del: Number(del) })
  }
  return counts
}

/** The files a commit changed against `from`, at most `FILE_LIMIT`. */
export async function readTreeDiff(
  git: GitReader,
  layout: GitLayout,
  from: string | undefined,
  to: string,
): Promise<Pick<GitCommitDiff, 'files' | 'totals' | 'more'>> {
  const entries = await rawEntries(git, layout, from, to)
  // Line counts only for a list that is shown whole: counting a huge commit is the costly part.
  const counts = entries.length <= FILE_LIMIT ? await numstat(git, layout, from, to) : new Map<string, never>()
  const totals = { files: entries.length, add: 0, del: 0 }
  const files: GitHistoryFile[] = []
  for (const entry of entries) {
    const count = counts.get(entry.path)
    if (count && count !== 'binary') {
      totals.add += count.add
      totals.del += count.del
    }
    if (files.length >= FILE_LIMIT) continue
    // A file that may hold a secret is listed by its path only, like everywhere else.
    const counted = count && count !== 'binary' && !isSecretPath(entry.path, new Uint8Array()) ? count : undefined
    files.push({ path: entry.path, status: entry.status, ...counted, ...(count === 'binary' ? { binary: true as const } : {}) })
  }
  return {
    totals,
    files,
    ...(entries.length > FILE_LIMIT ? { more: entries.length - FILE_LIMIT } : {}),
  }
}

const REGULAR = new Set(['100644', '100755'])
const HEAD_BYTES = 8192

/** One file between two commits: its lines with the whole file as context, or why its content is not shown. */
export async function readTreeFile(
  git: GitReader,
  layout: GitLayout,
  from: string | undefined,
  to: string,
  path: string,
): Promise<Pick<GitCommitFileDiff, 'file' | 'hunks' | 'hidden'> | undefined> {
  const entry = (await rawEntries(git, layout, from, to, path))[0]
  if (!entry) return undefined
  const file: GitHistoryFile = { path, status: entry.status }
  const sides = [
    { mode: entry.oldMode, oid: entry.oldOid, present: entry.status !== 'A' },
    { mode: entry.newMode, oid: entry.newOid, present: entry.status !== 'D' },
  ] as const
  if (sides.some(side => side.present && !REGULAR.has(side.mode))) return { file, hidden: 'link' }
  const blobs = await git.blobs(
    layout,
    sides.flatMap(side => (side.present ? [side.oid] : [])),
    TEXT_LIMIT,
  )
  const bytes = sides.map(side => (side.present ? blobs.get(side.oid) : Buffer.alloc(0)))
  if (bytes.some(side => side === undefined)) return { file, hidden: 'large' }
  for (const side of bytes) {
    const head = side!.subarray(0, HEAD_BYTES)
    if (isSecretPath(path, head) || hasSecretContent(head)) return { file, hidden: 'secret' }
  }
  const texts = bytes.map(side => decodeText(side!))
  if (texts.some(text => text === undefined)) return { file: { ...file, binary: true }, hidden: 'binary' }
  const before = sides[0].present ? splitText(texts[0]!) : EMPTY_TEXT,
    after = sides[1].present ? splitText(texts[1]!) : EMPTY_TEXT
  // The whole file is the context: one with more lines than a page should hold is not shown, like one over the size limit.
  if (before.lines.length > LINE_LIMIT || after.lines.length > LINE_LIMIT) return { file, hidden: 'large' }
  const ops = diffLines(before, after)
  const hunks: ChangeHunk[] = toHunks(ops, Infinity)
  return { file: { ...file, ...countChanges(ops) }, hunks }
}
