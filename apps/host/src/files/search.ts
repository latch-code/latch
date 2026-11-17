import { watch, type FSWatcher } from 'node:fs'
import { lstat, opendir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@latch/sdk'
import { ignoreVerdict, matchBudget, readIgnoreRules, type IgnoreRules } from './gitignore.ts'
import { IGNORED_NAMES } from './ignore.ts'
import { resolveRecorded, type FileRoot, type ProtectedPaths } from './resolve.ts'
import { isInsidePath } from '../paths.ts'

const NEVER_LISTED = new Set(['.git', '.ds_store'])
/** The longest a walk runs before it lets the event loop turn. */
const YIELD_MS = 8
// Only in a folder without .git: in a repository these can be real source, and .gitignore says which they are.
const LIKELY_OUTPUT = new Set(['target', 'out', 'vendor', 'coverage', '.cache', '.gradle', '.nuxt', '.svelte-kit', '.turbo'])
const SOURCE_EXTENSIONS = new Set(
  'astro bash c cc cjs clj cpp cs css cts cxx dart erl ex exs go graphql h hh hpp hs html java jl js jsx kt kts less lua m mjs ml mm mts nim php proto py r rb rs scala scss sh sql svelte swift ts tsx vue zig zsh'.split(
    ' ',
  ),
)
const MAX_PATH_BYTES = 2 * 1024 * 1024
const MAX_SKIPPED_DIRECTORIES = 2000
const MAX_IGNORED_FILES = 5000
const SKIPPED_WALK_ENTRIES = 30_000
const SKIPPED_WALK_MS = 1000
const MIN_NEEDLE_FOR_SKIPPED = 2
const ENOUGH_TO_SKIP_SECOND_WALK = 8
interface IgnoredNames {
  paths: readonly string[]
  truncated: boolean
}
interface Snapshot {
  paths: readonly string[]
  /** Files .gitignore names beside the files the first walk kept. */
  ignored: readonly string[]
  /** Build output and ignored directories the first walk did not enter. */
  skipped: readonly string[]
  partial: boolean
  truncated: boolean
  /** Entries whose ignore check was cut short (budget, time or a file not kept whole): treated as ignored. */
  undecided: number
  current?(): boolean
  skippedNames?(cancelled: () => boolean, check: Check): Promise<IgnoredNames>
}
interface Entry {
  guard: ProtectedPaths
  promise: Promise<Snapshot>
  watchers: FSWatcher[]
  timer?: NodeJS.Timeout
  dirty: boolean
  fullyWatched: boolean
  skippedNames?: Promise<IgnoredNames>
}
export interface FileSearchHit {
  name: string
  path: string
  root: string
  /** Left out of the list until typed for: .gitignore or build output. */
  ignored?: true
}
type Check = () => void
class IndexChanged extends Error {}
const unavailable = () => new AppError(503, 'file-search-unavailable', '文件搜索已关闭')

const NO_MATCH = -1
const FUZZY_TIER = 3
/** Letters scattered across a long path are chance, not a match: `main` is in `module_name/…/go`. */
const MAX_FUZZY_SPREAD = 4
function subsequenceSpan(text: string, needle: string): number | undefined {
  let at = -1
  for (const character of needle) {
    at = text.indexOf(character, at + 1)
    if (at < 0) return
  }
  const end = at
  for (let index = needle.length - 1; index >= 0; index--) at = text.lastIndexOf(needle[index]!, at - (index === needle.length - 1 ? 0 : 1))
  return end - at + 1
}
function matchTier(relative: string, needle: string): number {
  if (!needle) return 0
  const path = relative.toLocaleLowerCase(),
    name = path.slice(path.lastIndexOf('/') + 1)
  if (name.startsWith(needle)) return 0
  if (name.includes(needle)) return 1
  if (path.includes(needle)) return 2
  if (subsequenceSpan(name, needle) !== undefined) return FUZZY_TIER
  const span = subsequenceSpan(path, needle)
  return span !== undefined && span <= needle.length * MAX_FUZZY_SPREAD ? FUZZY_TIER + 1 : NO_MATCH
}
const normalizedNeedle = (query: string) => query.replace(/\s+/gu, '').toLocaleLowerCase()

interface Candidate {
  root: FileRoot
  rootIndex: number
  path: string
  ignored: boolean
  tier: number
  dotted: boolean
  depth: number
  other: boolean
}
function candidate(root: FileRoot, rootIndex: number, path: string, needle: string, ignored: boolean): Candidate | undefined {
  const tier = matchTier(path, needle)
  if (tier === NO_MATCH) return
  const parts = path.split('/'),
    name = parts.at(-1)!,
    dot = name.lastIndexOf('.')
  return {
    root,
    rootIndex,
    path,
    ignored,
    tier,
    dotted: parts.some(part => part.startsWith('.')),
    depth: parts.length,
    other: dot <= 0 || !SOURCE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase()),
  }
}
/** With nothing typed a person is browsing, so source comes before depth; a typed name already says what is wanted. */
function byRank(needle: string) {
  return (a: Candidate, b: Candidate) =>
    Number(a.tier >= FUZZY_TIER) - Number(b.tier >= FUZZY_TIER)
    || Number(a.ignored) - Number(b.ignored)
    || a.tier - b.tier
    || Number(a.dotted) - Number(b.dotted)
    || (needle ? a.depth - b.depth : Number(a.other) - Number(b.other))
    || (needle ? Number(a.other) - Number(b.other) : a.depth - b.depth)
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    || a.rootIndex - b.rootIndex
}
/** A second walk costs a person a pause, so only when the first found too little of what was typed. */
function wantsSkipped(candidates: readonly Candidate[], limit: number, needle: string): boolean {
  const found = candidates.filter(item => item.tier < FUZZY_TIER).length
  return found === 0
    ? candidates.length < limit
    : needle.length >= MIN_NEEDLE_FOR_SKIPPED && found < Math.min(limit, ENOUGH_TO_SKIP_SECOND_WALK)
}

/** Names are hints only; every returned candidate is resolved and classified again. */
export class FileSearchIndex {
  private readonly entries = new Map<string, Entry>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly watcherClosures = new Set<Promise<void>>()
  private activeWatchers = 0
  private closed = false
  async search(
    roots: readonly FileRoot[],
    guard: ProtectedPaths,
    identity: string,
    query: string,
    limit: number,
    cancelled: () => boolean,
    check: Check = () => {},
  ) {
    const current = () => {
      if (this.closed) throw unavailable()
      check()
    }
    current()
    const operation = (async () => {
      try {
        return await runSearch(roots, guard, query, limit, cancelled, current, (root, key) =>
          this.load(root, guard, JSON.stringify([identity, key]), cancelled, current),
        )
      } catch (cause) {
        if (!(cause instanceof IndexChanged)) throw cause
        current()
        return searchFiles(roots, guard, query, limit, cancelled, current)
      }
    })()
    this.operations.add(operation)
    try {
      return await operation
    } finally {
      this.operations.delete(operation)
    }
  }
  /**
   * The files of one folder from the cached scan the name search keeps for this identity, scanning it if needed (the
   * scan is the same bounded walk); undefined when the scan was cut short or changed meanwhile, so the caller walks.
   */
  async files(root: FileRoot, guard: ProtectedPaths, identity: string, cancelled: () => boolean, check: Check = () => {}) {
    if (this.closed) throw unavailable()
    const info = await stat(root.path, { bigint: true }).catch(() => undefined)
    check()
    if (!info?.isDirectory()) return undefined
    const key = JSON.stringify([identity, JSON.stringify([root.id, root.path, String(info.dev), String(info.ino)])])
    const operation = this.load(root, guard, key, cancelled, check).then(
      snapshot => (snapshot.current && !snapshot.current() ? undefined : snapshot),
      (cause: unknown) => {
        if (cause instanceof IndexChanged) return undefined
        throw cause
      },
    )
    this.operations.add(operation)
    try {
      return await operation
    } finally {
      this.operations.delete(operation)
    }
  }
  async close(): Promise<void> {
    this.closed = true
    for (const [key, entry] of this.entries) this.invalidate(key, entry)
    await Promise.allSettled(this.operations)
    await Promise.allSettled(this.watcherClosures)
  }
  private invalidate(key: string, entry: Entry) {
    entry.dirty = true
    clearTimeout(entry.timer)
    for (const watcher of entry.watchers.splice(0)) watcher.close()
    if (this.entries.get(key) === entry) this.entries.delete(key)
  }
  private load(root: FileRoot, guard: ProtectedPaths, key: string, cancelled: () => boolean, check: Check): Promise<Snapshot> {
    const previous = this.entries.get(key)
    if (previous && previous.guard === guard) {
      this.entries.delete(key)
      this.entries.set(key, previous)
      return previous.promise
    }
    if (previous) this.invalidate(key, previous)
    while (this.entries.size >= 8) {
      const [oldKey, old] = this.entries.entries().next().value!
      this.invalidate(oldKey, old)
    }
    const entry: Entry = {
      guard,
      promise: Promise.resolve({ paths: [], ignored: [], skipped: [], partial: false, truncated: false, undecided: 0 }),
      watchers: [],
      dirty: false,
      fullyWatched: true,
    }
    this.entries.set(key, entry)
    const observe = (path: string) => {
      if (entry.dirty) return
      if (entry.watchers.length >= 32 || this.activeWatchers >= 256) {
        entry.fullyWatched = false
        return
      }
      try {
        const watcher = watch(path, { persistent: false }, () => this.invalidate(key, entry))
        this.activeWatchers++
        let done!: () => void
        const closure = new Promise<void>(resolve => {
          done = resolve
        })
        this.watcherClosures.add(closure)
        watcher.once('close', () => {
          this.activeWatchers--
          this.watcherClosures.delete(closure)
          done()
        })
        entry.watchers.push(watcher)
        watcher.once('error', () => this.invalidate(key, entry))
      } catch {
        entry.fullyWatched = false
      }
    }
    entry.promise = scan(root, guard, cancelled, check, observe)
      .then(snapshot => {
        check()
        if (entry.dirty || snapshot.truncated) throw new IndexChanged()
        if (!cancelled()) entry.timer = setTimeout(() => this.invalidate(key, entry), entry.fullyWatched ? 30_000 : 1000).unref()
        else this.invalidate(key, entry)
        const skippedNames = (late: () => boolean, lateCheck: Check) => {
          const names = (entry.skippedNames ??= walkSkipped(
            root,
            snapshot.skipped,
            guard,
            late,
            lateCheck,
            freshBudget(SKIPPED_WALK_MS, SKIPPED_WALK_ENTRIES),
          )
            .then(walked => {
              if (late()) entry.skippedNames = undefined
              return walked
            })
            .catch(cause => {
              entry.skippedNames = undefined
              throw cause
            }))
          return names
        }
        return { ...snapshot, current: () => !entry.dirty, skippedNames }
      })
      .catch(cause => {
        this.invalidate(key, entry)
        throw cause
      })
    return entry.promise
  }
}

export interface Budget {
  visited: number
  maxVisited: number
  deadline: number
}
export const freshBudget = (milliseconds: number, maxVisited: number): Budget => ({
  visited: 0,
  maxVisited,
  deadline: performance.now() + milliseconds,
})
interface QueuedDirectory {
  relative: string
  depth: number
  rules?: IgnoreRules
}
const repositoryAt = (root: FileRoot) =>
  lstat(join(root.path, '.git')).then(
    () => true,
    () => false,
  )

/**
 * A bounded BFS, with at most two MiB each of queued directory paths and cached file paths. With `honourIgnores`
 * it leaves build output and ignored files for `walkSkipped`, so they cannot spend the budget that source needs.
 */
export async function walk(
  root: FileRoot,
  guard: ProtectedPaths,
  cancelled: () => boolean,
  check: Check,
  observe: (path: string) => void,
  budget: Budget,
  start: Array<QueuedDirectory | undefined>,
  honourIgnores: boolean,
  accept: (relative: string) => boolean = () => true,
): Promise<Omit<Snapshot, 'current' | 'skippedNames'>> {
  const paths: string[] = [],
    ignored: string[] = [],
    skipped: string[] = []
  const queue = start
  let bytes = 0,
    queueBytes = 0,
    truncated = false,
    partial = false,
    undecided = 0,
    at = 0
  const checked = async <T>(operation: Promise<T>) => {
    const result = await operation
    check()
    return result
  }
  const matching = matchBudget(budget.deadline)
  /** Ignored, kept, or undecided (counted, and then treated as ignored: never brought forward on a cut-short check). */
  const ignoredHere = (rules: IgnoreRules | undefined, relative: string, isDirectory: boolean) => {
    const verdict = ignoreVerdict(rules, relative, isDirectory, matching)
    if (verdict === 'undecided') undecided++
    return verdict !== 'kept'
  }
  // The event loop gets a turn every few milliseconds of walking, however the entries come in.
  let turned = performance.now()
  const turn = async () => {
    if (performance.now() - turned < YIELD_MS) return
    await new Promise(resolve => setImmediate(resolve))
    turned = performance.now()
    check()
  }
  const inRepository = honourIgnores && (await checked(repositoryAt(root)))
  while (at < queue.length && !cancelled()) {
    check()
    const entry = queue[at]!
    queue[at++] = undefined
    const path = join(root.path, entry.relative)
    queueBytes -= Buffer.byteLength(entry.relative)
    const real = await checked(realpath(path).catch(() => undefined))
    if (real === undefined || !isInsidePath(real, root.path) || (await checked(guard.contains(real)))) continue
    observe(real)
    const rules = honourIgnores ? await checked(readIgnoreRules(real, entry.relative, entry.rules)) : undefined
    let directory: Awaited<ReturnType<typeof opendir>>
    try {
      directory = await opendir(real)
    } catch {
      check()
      continue
    }
    try {
      check()
    } catch (cause) {
      await directory.close()
      throw cause
    }
    for await (const item of directory) {
      await turn()
      check()
      if (++budget.visited > budget.maxVisited || performance.now() > budget.deadline || cancelled()) {
        truncated = true
        break
      }
      const lower = item.name.toLowerCase()
      if (NEVER_LISTED.has(lower) || lower.endsWith('.tmp') || item.isSymbolicLink()) continue
      const relative = entry.relative ? `${entry.relative}/${item.name}` : item.name
      const size = Buffer.byteLength(relative)
      if (size > 4096) {
        truncated = true
        continue
      }
      if (item.isDirectory()) {
        if (
          honourIgnores
          && (IGNORED_NAMES.has(lower) || (!inRepository && LIKELY_OUTPUT.has(lower)) || ignoredHere(rules, relative, true))
        ) {
          if (skipped.length < MAX_SKIPPED_DIRECTORIES) skipped.push(relative)
          else partial = true
        } else if (entry.depth < 32 && queue.length < 10_000 && queueBytes + size <= MAX_PATH_BYTES) {
          queue.push({ relative, depth: entry.depth + 1, ...(rules ? { rules } : {}) })
          queueBytes += size
        } else truncated = true
      } else if (item.isFile() && accept(relative)) {
        if (honourIgnores && ignoredHere(rules, relative, false)) {
          if (ignored.length < MAX_IGNORED_FILES) ignored.push(relative)
          else partial = true
          continue
        }
        if (paths.length >= 20_000 || bytes + size > MAX_PATH_BYTES) {
          truncated = true
          break
        }
        paths.push(relative)
        bytes += size
      }
    }
    if (budget.visited > budget.maxVisited || performance.now() > budget.deadline || paths.length >= 20_000 || bytes >= MAX_PATH_BYTES) {
      truncated = true
      break
    }
  }
  if (cancelled()) truncated = true
  return { paths, ignored, skipped, partial, truncated, undecided }
}

const scan = (root: FileRoot, guard: ProtectedPaths, cancelled: () => boolean, check: Check, observe: (path: string) => void) =>
  walk(root, guard, cancelled, check, observe, freshBudget(2000, 50_000), [{ relative: '', depth: 0 }], true)

/** Breadth first across every skipped directory, so a huge node_modules cannot starve a shallow target/. */
async function walkSkipped(
  root: FileRoot,
  directories: readonly string[],
  guard: ProtectedPaths,
  cancelled: () => boolean,
  check: Check,
  budget: Budget,
  accept?: (relative: string) => boolean,
): Promise<IgnoredNames> {
  if (!directories.length) return { paths: [], truncated: false }
  const start = directories.map(relative => ({ relative, depth: relative.split('/').length }))
  const { paths, truncated } = await walk(root, guard, cancelled, check, () => {}, budget, start, false, accept)
  return { paths, truncated }
}

/** Ranks the whole bounded set before the limit, and classifies only what could be shown. */
async function settle(
  candidates: Candidate[],
  needle: string,
  guard: ProtectedPaths,
  limit: number,
  cancelled: () => boolean,
  check: Check,
  stale: () => void = () => {},
) {
  const files: FileSearchHit[] = []
  let truncated = false
  const deadline = performance.now() + 2000
  candidates.sort(byRank(needle))
  for (const [index, item] of candidates.entries()) {
    check()
    stale()
    if (cancelled() || performance.now() > deadline) {
      truncated = true
      break
    }
    const resolved = await resolveRecorded(item.root.id, item.path, { roots: [item.root], protectedPaths: guard, home: '' })
    check()
    stale()
    if (resolved.status !== 'ok' || resolved.file.secret) continue
    files.push({
      name: resolved.file.name,
      path: resolved.file.relativePath,
      root: item.root.id,
      ...(item.ignored ? { ignored: true as const } : {}),
    })
    if (files.length >= limit) {
      truncated = index < candidates.length - 1
      break
    }
  }
  return { files, truncated }
}

async function runSearch(
  roots: readonly FileRoot[],
  guard: ProtectedPaths,
  query: string,
  limit: number,
  cancelled: () => boolean,
  check: Check,
  load: (root: FileRoot, identity: string) => Promise<Snapshot>,
) {
  const candidates: Candidate[] = [],
    needle = normalizedNeedle(query),
    loaded: Array<{ root: FileRoot; rootIndex: number; snapshot: Snapshot }> = []
  let truncated = false
  const deadline = performance.now() + 2000
  const checked = async <T>(operation: Promise<T>) => {
    const result = await operation
    check()
    return result
  }
  const stale = () => {
    if (loaded.some(({ snapshot }) => snapshot.current && !snapshot.current())) throw new IndexChanged()
  }
  check()
  for (const [rootIndex, source] of roots.entries()) {
    if (cancelled() || performance.now() > deadline) {
      truncated = true
      break
    }
    const path = await checked(realpath(source.path).catch(() => undefined))
    if (!path) continue
    const info = await checked(stat(path, { bigint: true }).catch(() => undefined))
    if (!info?.isDirectory()) continue
    const root = { id: source.id, path }
    const snapshot = await checked(load(root, JSON.stringify([root.id, path, String(info.dev), String(info.ino)])))
    if (snapshot.current && (!snapshot.current() || performance.now() > deadline)) throw new IndexChanged()
    truncated ||= snapshot.truncated
    loaded.push({ root, rootIndex, snapshot })
    for (const relative of snapshot.paths) {
      const found = candidate(root, rootIndex, relative, needle, false)
      if (found) candidates.push(found)
    }
  }
  if (wantsSkipped(candidates, limit, needle))
    for (const { root, rootIndex, snapshot } of loaded) {
      const names = snapshot.skippedNames
        ? await checked(snapshot.skippedNames(cancelled, check))
        : { paths: [] as readonly string[], truncated: false }
      truncated ||= names.truncated || snapshot.partial
      for (const relative of [...snapshot.ignored, ...names.paths]) {
        const found = candidate(root, rootIndex, relative, needle, true)
        if (found) candidates.push(found)
      }
    }
  stale()
  const settled = await settle(candidates, needle, guard, limit, cancelled, check, stale)
  return { files: settled.files, truncated: truncated || settled.truncated }
}

/** A bounded filename search, without git subprocesses, symlink traversal or a directory tree response. */
export async function searchFiles(
  roots: readonly FileRoot[],
  guard: ProtectedPaths,
  query: string,
  limit: number,
  cancelled: () => boolean,
  check: () => void = () => {},
) {
  const checked = async <T>(operation: Promise<T>): Promise<T> => {
    const result = await operation
    check()
    return result
  }
  check()
  const needle = normalizedNeedle(query),
    accept = (relative: string) => matchTier(relative, needle) !== NO_MATCH,
    budget = freshBudget(2000, 50_000),
    candidates: Candidate[] = [],
    walked: Array<{ root: FileRoot; rootIndex: number; ignored: readonly string[]; skipped: readonly string[]; partial: boolean }> = []
  let truncated = false
  for (const [rootIndex, source] of roots.entries()) {
    const path = await checked(realpath(source.path).catch(() => undefined))
    if (!path) continue
    const root = { id: source.id, path }
    const result = await walk(root, guard, cancelled, check, () => {}, budget, [{ relative: '', depth: 0 }], true, accept)
    truncated ||= result.truncated
    walked.push({ root, rootIndex, ignored: result.ignored, skipped: result.skipped, partial: result.partial })
    for (const relative of result.paths) candidates.push(candidate(root, rootIndex, relative, needle, false)!)
    if (cancelled()) break
  }
  if (wantsSkipped(candidates, limit, needle)) {
    const later = freshBudget(SKIPPED_WALK_MS, SKIPPED_WALK_ENTRIES)
    for (const { root, rootIndex, ignored, skipped, partial } of walked) {
      const names = await walkSkipped(root, skipped, guard, cancelled, check, later, accept)
      truncated ||= names.truncated || partial
      for (const relative of [...ignored, ...names.paths]) candidates.push(candidate(root, rootIndex, relative, needle, true)!)
    }
  }
  const settled = await settle(candidates, needle, guard, limit, cancelled, check)
  return { files: settled.files, truncated: truncated || settled.truncated || cancelled() }
}
