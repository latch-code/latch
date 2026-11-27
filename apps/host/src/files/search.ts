import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { lstat, opendir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@latch/sdk'
import { ignoreVerdict, matchBudget, readIgnoreRules, type IgnoreRules } from './gitignore.ts'
import { beginLoopWork, turnIfDue, yieldTurn } from './loop-turn.ts'
import { IGNORED_NAMES } from './ignore.ts'
import { resolveRecorded, type FileRoot, type ProtectedPaths } from './resolve.ts'
import { isInsidePath } from '../paths.ts'

const NEVER_LISTED = new Set(['.git', '.ds_store'])
/** Watchers closed per turn of the event loop. */
const WATCHER_CLOSES_PER_TURN = 4
/** Candidates ranked per turn of the event loop. */
const RANK_CHUNK = 2048
/** How long one scan may run before it is dropped as hung. */
const SCAN_HARD_MS = 5000
/** File searches and scans that timed out and have not settled, in the whole process; past MAX_HUNG nothing new starts. */
export const hungFileOperations = { count: 0 }
const MAX_HUNG = 2
/** Counts `operation` as hung until it settles. */
export function trackHung(operation: Promise<unknown>): void {
  hungFileOperations.count++
  void operation
    .catch(() => {})
    .finally(() => {
      hungFileOperations.count--
    })
}
/** The refusal while too many file operations hang: the normal busy answer, so the client retries later. */
export const busyWithHung = () => new AppError(429, 'file-list-busy', '文件读取繁忙，请稍后再试')
export const tooManyHung = () => hungFileOperations.count >= MAX_HUNG
/** How long closing the index waits for operations still running. */
const CLOSE_WAIT_MS = 2000
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
// A cold mention samples shallow names before starting the full bounded search.
const PREVIEW_MS = 80
const PREVIEW_ENTRIES = 256
const PAGE_CANDIDATES = 1024
const PAGE_CURSORS = 16
const PAGE_TTL_MS = 60_000
const MIN_NEEDLE_FOR_SKIPPED = 2
const ENOUGH_TO_SKIP_SECOND_WALK = 8
interface IgnoredNames {
  paths: readonly string[]
  truncated: boolean
}
/** Files and folders whose ignore check was cut short: treated as ignored, and said so to the person. */
export interface Unchecked {
  files: number
  directories: number
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
  undecided: Unchecked
  current?(): boolean
  skippedNames?(cancelled: () => boolean, check: Check): Promise<IgnoredNames>
}
interface Entry {
  identity: string
  rootId: string
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
  private readonly closing: FSWatcher[] = []
  private draining = false
  private readonly watcherClosures = new Set<Promise<void>>()
  private activeWatchers = 0
  private closed = false
  private readonly pages = new Map<
    string,
    { owner: string; guard: ProtectedPaths; until: number; timer: NodeJS.Timeout; continuation: PageContinuation }
  >()

  async search(
    roots: readonly FileRoot[],
    guard: ProtectedPaths,
    identity: string,
    query: string,
    limit: number,
    cancelled: () => boolean,
    check: Check = () => {},
    page?: { device: string; cursor?: string },
  ): Promise<SearchResult> {
    const current = () => {
      if (this.closed) throw unavailable()
      check()
    }
    current()
    const operation = (async () => {
      const end = beginLoopWork()
      const indexed = (stopped = cancelled) =>
        indexedCandidates(roots, query, limit, stopped, current, (root, key) => this.load(root, guard, identity, key, stopped, current))
      try {
        if (page) {
          const owner = JSON.stringify([page.device, identity, query, limit])
          const ready = new Set(
            [...this.entries.values()]
              .filter(entry => entry.guard === guard && entry.identity === identity && entry.timer)
              .map(entry => entry.rootId),
          )
          const cold = roots.some(root => !ready.has(root.id))
          return await this.page(owner, page.cursor, guard, cancelled, current, (stopped, saved) =>
            searchPage(roots, guard, query, limit, stopped, current, cold, saved, () => indexed(stopped)),
          )
        }
        try {
          return await settleSearch(await indexed(), query, guard, limit, cancelled, current)
        } catch (cause) {
          if (!(cause instanceof IndexChanged)) throw cause
          current()
          return await searchFolders(roots, guard, query, limit, cancelled, current)
        }
      } finally {
        end()
      }
    })()
    this.operations.add(operation)
    try {
      return await operation
    } finally {
      this.operations.delete(operation)
    }
  }
  private async page(
    owner: string,
    cursor: string | undefined,
    guard: ProtectedPaths,
    cancelled: () => boolean,
    check: Check,
    run: (stopped: () => boolean, saved?: PageContinuation) => Promise<SearchPage>,
  ): Promise<SearchResult> {
    const saved = cursor ? this.pages.get(cursor) : undefined
    if (cursor && (!saved || saved.owner !== owner || saved.guard !== guard || saved.until <= Date.now()))
      throw new AppError(409, 'file-search-expired', '文件搜索已过期，请重新搜索')
    if (tooManyHung()) throw busyWithHung()
    let timedOut = false
    const stopped = () => timedOut || cancelled()
    const work = run(stopped, saved?.continuation)
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        trackHung(work)
        reject(new AppError(503, 'file-search-timeout', '文件搜索没有及时结束，请稍后再试'))
      }, SCAN_HARD_MS * 2).unref()
    })
    try {
      const { continuation, ...result } = await Promise.race([work, timeout])
      check()
      if (!continuation || stopped()) return result
      if (this.pages.size >= PAGE_CURSORS) {
        const [oldest, entry] = this.pages.entries().next().value!
        clearTimeout(entry.timer)
        this.pages.delete(oldest)
      }
      const nextCursor = randomUUID()
      const expiry = setTimeout(() => this.pages.delete(nextCursor), PAGE_TTL_MS).unref()
      this.pages.set(nextCursor, { owner, guard, until: Date.now() + PAGE_TTL_MS, timer: expiry, continuation })
      return { ...result, nextCursor }
    } finally {
      clearTimeout(timer)
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
    if (this.closed) throw unavailable()
    if (!info?.isDirectory()) return undefined
    const key = JSON.stringify([root.id, root.path, String(info.dev), String(info.ino)])
    const operation = this.load(root, guard, identity, key, cancelled, check).then(
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
  /**
   * Stops the index. Operations still running end at their next check; one stuck in a file system call that never
   * settles (a hung mount) is not waited for past CLOSE_WAIT_MS, so shutting the Host down never hangs on it.
   */
  async close(): Promise<void> {
    this.closed = true
    for (const page of this.pages.values()) clearTimeout(page.timer)
    this.pages.clear()
    for (const [key, entry] of this.entries) this.invalidate(key, entry)
    let timer: NodeJS.Timeout | undefined
    const waited = new Promise<void>(resolve => {
      timer = setTimeout(resolve, CLOSE_WAIT_MS)
      timer.unref()
    })
    await Promise.race([Promise.allSettled([...this.operations]).then(() => Promise.allSettled([...this.watcherClosures])), waited])
    clearTimeout(timer)
  }
  private invalidate(key: string, entry: Entry) {
    entry.dirty = true
    clearTimeout(entry.timer)
    this.closing.push(...entry.watchers.splice(0))
    this.drainWatchers()
    if (this.entries.get(key) === entry) this.entries.delete(key)
  }
  /**
   * Closes watchers a few at a time, a timer turn apart: on macOS each close costs in proportion to how many are open,
   * so closing hundreds at once would hold the event loop for a tenth of a second or more.
   */
  private drainWatchers() {
    if (this.draining) return
    this.draining = true
    const step = () => {
      for (const watcher of this.closing.splice(0, WATCHER_CLOSES_PER_TURN)) watcher.close()
      if (this.closing.length) setTimeout(step, 0)
      else this.draining = false
    }
    step()
  }
  private load(
    root: FileRoot,
    guard: ProtectedPaths,
    identity: string,
    rootKey: string,
    cancelled: () => boolean,
    check: Check,
  ): Promise<Snapshot> {
    const key = JSON.stringify([identity, rootKey])
    const previous = this.entries.get(key)
    if (previous && previous.guard === guard) {
      this.entries.delete(key)
      this.entries.set(key, previous)
      return previous.promise
    }
    // A new scan is not started while file operations that timed out still hang (a hung mount).
    if (tooManyHung()) throw busyWithHung()
    if (previous) this.invalidate(key, previous)
    while (this.entries.size >= 8) {
      const [oldKey, old] = this.entries.entries().next().value!
      this.invalidate(oldKey, old)
    }
    const entry: Entry = {
      identity,
      rootId: root.id,
      guard,
      promise: Promise.resolve({
        paths: [],
        ignored: [],
        skipped: [],
        partial: false,
        truncated: false,
        undecided: { files: 0, directories: 0 },
      }),
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
    const scanning = scan(root, guard, cancelled, check, observe)
    // A scan stuck in a file system call that never settles (a hung mount) is not left as the shared in-flight entry:
    // past SCAN_HARD_MS it is dropped, its waiters get an answer, and it counts as hung until it settles.
    let hardTimer: NodeJS.Timeout | undefined
    const hard = new Promise<never>((_, reject) => {
      hardTimer = setTimeout(() => {
        trackHung(scanning)
        this.invalidate(key, entry)
        reject(new AppError(503, 'file-search-timeout', '文件搜索没有及时结束，请稍后再试'))
      }, SCAN_HARD_MS)
      hardTimer.unref()
    })
    void scanning.finally(() => clearTimeout(hardTimer)).catch(() => {})
    entry.promise = Promise.race([scanning, hard])
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
/** The walk below, with the shared loop clock's heartbeat running while it works (loop-turn.ts). */
export async function walk(...args: Parameters<typeof walkFolders>): ReturnType<typeof walkFolders> {
  const end = beginLoopWork()
  try {
    return await walkFolders(...args)
  } finally {
    end()
  }
}

async function walkFolders(
  root: FileRoot,
  guard: ProtectedPaths,
  cancelled: () => boolean,
  check: Check,
  observe: (path: string) => void,
  budget: Budget,
  start: Array<QueuedDirectory | undefined>,
  honourIgnores: boolean,
  accept: (relative: string) => boolean = () => true,
  shallow = false,
): Promise<Omit<Snapshot, 'current' | 'skippedNames'>> {
  const paths: string[] = [],
    ignored: string[] = [],
    skipped: string[] = []
  const queue = start
  let bytes = 0,
    ignoredBytes = 0,
    queueBytes = 0,
    truncated = false,
    partial = false,
    at = 0
  const undecided: Unchecked = { files: 0, directories: 0 }
  const checked = async <T>(operation: Promise<T>) => {
    const result = await operation
    check()
    return result
  }
  const matching = matchBudget(budget.deadline)
  /**
   * Ignored, kept, or undecided (counted, and then treated as ignored: never brought forward on a cut-short check). A
   * check cut short only because the loop had been held long enough is tried once more after a turn, with a fresh
   * window, so an ordinary repository is never left with undecided entries.
   */
  const ignoredHere = async (rules: IgnoreRules | undefined, relative: string, isDirectory: boolean) => {
    let verdict = ignoreVerdict(rules, relative, isDirectory, matching)
    if (verdict === 'undecided' && matching.cut === 'time') {
      await yieldTurn()
      check()
      verdict = ignoreVerdict(rules, relative, isDirectory, matching)
    }
    if (verdict === 'undecided') undecided[isDirectory ? 'directories' : 'files']++
    return verdict !== 'kept'
  }
  // The event loop gets a turn every few milliseconds of walking, however the entries come in.
  const turn = async () => {
    await turnIfDue()
    check()
  }
  const inRepository = honourIgnores && (await checked(repositoryAt(root)))
  while (at < queue.length && !cancelled()) {
    check()
    if (shallow && performance.now() >= budget.deadline) {
      truncated = true
      break
    }
    const entry = queue[at]!
    queue[at++] = undefined
    const path = join(root.path, entry.relative)
    queueBytes -= Buffer.byteLength(entry.relative)
    const real = await checked(realpath(path).catch(() => undefined))
    if (real === undefined || !isInsidePath(real, root.path) || (await checked(guard.contains(real)))) continue
    observe(real)
    const rules = honourIgnores ? await checked(readIgnoreRules(real, entry.relative, entry.rules, matching)) : undefined
    // Awaited operations above let the loop turn; the parse after the read is charged and linear.
    await turn()
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
          && (IGNORED_NAMES.has(lower) || (!inRepository && LIKELY_OUTPUT.has(lower)) || (await ignoredHere(rules, relative, true)))
        ) {
          if (skipped.length < MAX_SKIPPED_DIRECTORIES) skipped.push(relative)
          else partial = true
        } else if (entry.depth < 32 && queue.length < 10_000 && queueBytes + size <= MAX_PATH_BYTES) {
          queue.push({ relative, depth: entry.depth + 1, ...(rules ? { rules } : {}) })
          queueBytes += size
        } else truncated = true
      } else if (item.isFile() && accept(relative)) {
        if (honourIgnores && (await ignoredHere(rules, relative, false))) {
          if (ignored.length < MAX_IGNORED_FILES && ignoredBytes + size <= MAX_PATH_BYTES) {
            ignored.push(relative)
            ignoredBytes += size
          } else partial = true
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
    if (
      (shallow && paths.length && at < queue.length)
      || budget.visited > budget.maxVisited
      || performance.now() > budget.deadline
      || paths.length >= 20_000
      || bytes >= MAX_PATH_BYTES
    ) {
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

interface Candidates {
  candidates: Candidate[]
  truncated: boolean
  unchecked?: Unchecked
  stale?: Check
}

interface RankedPage {
  ranked: Candidate[]
  offset: number
  partial: boolean
  unchecked?: Unchecked
}
type PageContinuation = { preview: FileSearchHit[] } | RankedPage
interface SearchResult {
  files: FileSearchHit[]
  truncated: boolean
  unchecked?: Unchecked
  nextCursor?: string
}
interface SearchPage extends SearchResult {
  continuation?: PageContinuation
}

/** Names alone are retained between pages. Classification and authorization always belong to the current request. */
async function classify(
  ranked: readonly Candidate[],
  offset: number,
  guard: ProtectedPaths,
  limit: number,
  cancelled: () => boolean,
  check: Check,
  stale?: Check,
  keepRankedPath = false,
) {
  const files: FileSearchHit[] = []
  const deadline = performance.now() + 2000
  while (offset < ranked.length && files.length < limit) {
    check()
    stale?.()
    if (cancelled() || performance.now() > deadline) break
    const item = ranked[offset++]!
    const resolved = await resolveRecorded(item.root.id, item.path, { roots: [item.root], protectedPaths: guard, home: '' })
    check()
    stale?.()
    if (resolved.status !== 'ok' || resolved.file.secret || (keepRankedPath && resolved.file.relativePath !== item.path)) continue
    files.push({
      name: resolved.file.name,
      path: resolved.file.relativePath,
      root: item.root.id,
      ...(item.ignored ? { ignored: true as const } : {}),
    })
  }
  return { files, offset }
}

async function settleSearch(
  found: Candidates,
  query: string,
  guard: ProtectedPaths,
  limit: number,
  cancelled: () => boolean,
  check: Check,
) {
  const ranked = await topRanked(found.candidates, byRank(normalizedNeedle(query)), Math.max(limit * 4, 64))
  const { files, offset } = await classify(ranked, 0, guard, limit, cancelled, check, found.stale)
  return { files, truncated: found.truncated || offset < found.candidates.length, ...(found.unchecked && { unchecked: found.unchecked }) }
}

async function searchPage(
  roots: readonly FileRoot[],
  guard: ProtectedPaths,
  query: string,
  limit: number,
  cancelled: () => boolean,
  check: Check,
  cold: boolean,
  saved: PageContinuation | undefined,
  indexed: () => Promise<Candidates>,
): Promise<SearchPage> {
  const needle = normalizedNeedle(query)
  const fromRanked = async (state: RankedPage, stale?: Check) => {
    const { files, offset } = await classify(state.ranked, state.offset, guard, limit, cancelled, check, stale, true)
    const more = offset < state.ranked.length
    return {
      files,
      truncated: more || state.partial,
      ...(state.unchecked && { unchecked: state.unchecked }),
      ...(more && { continuation: { ...state, offset } }),
    }
  }
  if (saved && 'ranked' in saved) return fromRanked(saved)
  const shown = new Set(saved?.preview.map(item => JSON.stringify([item.root, item.path])))
  const rank = async (found: Candidates) => {
    const head = await topRanked(found.candidates, byRank(needle), PAGE_CANDIDATES + shown.size)
    const unseen = shown.size ? head.filter(item => !shown.has(JSON.stringify([item.root.id, item.path]))) : head
    const partial = found.truncated || head.length < found.candidates.length || unseen.length > PAGE_CANDIDATES
    return fromRanked({ ranked: unseen.slice(0, PAGE_CANDIDATES), offset: 0, partial, unchecked: found.unchecked }, found.stale)
  }
  if (cold && !saved) {
    const sample = await freshCandidates(roots, guard, query, limit, cancelled, check, true)
    if (!sample.truncated || cancelled()) return rank(sample)
    // While deeper folders remain unknown, avoid putting incidental path or fuzzy matches ahead of exact names.
    sample.candidates = sample.candidates.filter(item => item.tier === 0)
    const first = await rank(sample)
    if (first.files.length) return { files: first.files, truncated: true, continuation: { preview: first.files } }
  }
  try {
    return await rank(await indexed())
  } catch (cause) {
    if (!(cause instanceof IndexChanged)) throw cause
    check()
    return rank(await freshCandidates(roots, guard, query, limit, cancelled, check))
  }
}

/**
 * The best `keep` candidates in order, ranked in chunks with a turn of the event loop between them, so ranking tens of
 * thousands of paths never runs as one stretch: each chunk is sorted and merged into the head kept so far.
 */
async function topRanked(candidates: readonly Candidate[], compare: (a: Candidate, b: Candidate) => number, keep: number) {
  let head: Candidate[] = []
  for (let start = 0; start < candidates.length; start += RANK_CHUNK) {
    await turnIfDue()
    const chunk = candidates.slice(start, start + RANK_CHUNK).sort(compare)
    const merged: Candidate[] = []
    let a = 0,
      b = 0
    while (merged.length < keep && (a < head.length || b < chunk.length))
      merged.push(b >= chunk.length || (a < head.length && compare(head[a]!, chunk[b]!) <= 0) ? head[a++]! : chunk[b++]!)
    head = merged
  }
  return head
}

async function indexedCandidates(
  roots: readonly FileRoot[],
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
    for (const [index, relative] of snapshot.paths.entries()) {
      if ((index & 1023) === 0) await turnIfDue()
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
      for (const [index, relative] of [...snapshot.ignored, ...names.paths].entries()) {
        if ((index & 1023) === 0) await turnIfDue()
        const found = candidate(root, rootIndex, relative, needle, true)
        if (found) candidates.push(found)
      }
    }
  stale()
  return { candidates, truncated, stale, ...uncheckedOf(loaded.map(item => item.snapshot.undecided)) }
}

/** What the answer says of entries whose ignore check was cut short, when there were any. */
function uncheckedOf(counts: readonly Unchecked[]): { unchecked?: Unchecked } {
  const total = { files: 0, directories: 0 }
  for (const count of counts) {
    total.files += count.files
    total.directories += count.directories
  }
  return total.files || total.directories ? { unchecked: total } : {}
}

/** A bounded filename search, without git subprocesses, symlink traversal or a directory tree response. */
export async function searchFiles(...args: Parameters<typeof searchFolders>): ReturnType<typeof searchFolders> {
  const end = beginLoopWork()
  try {
    return await searchFolders(...args)
  } finally {
    end()
  }
}

async function searchFolders(
  roots: readonly FileRoot[],
  guard: ProtectedPaths,
  query: string,
  limit: number,
  cancelled: () => boolean,
  check: () => void = () => {},
) {
  return settleSearch(await freshCandidates(roots, guard, query, limit, cancelled, check), query, guard, limit, cancelled, check)
}

async function freshCandidates(
  roots: readonly FileRoot[],
  guard: ProtectedPaths,
  query: string,
  limit: number,
  cancelled: () => boolean,
  check: Check,
  preview = false,
) {
  const checked = async <T>(operation: Promise<T>): Promise<T> => {
    const result = await operation
    check()
    return result
  }
  check()
  const needle = normalizedNeedle(query),
    accept = (relative: string) => matchTier(relative, needle) !== NO_MATCH,
    budget = preview ? freshBudget(PREVIEW_MS, PREVIEW_ENTRIES) : freshBudget(2000, 50_000),
    candidates: Candidate[] = [],
    walked: Array<{ root: FileRoot; rootIndex: number; ignored: readonly string[]; skipped: readonly string[]; partial: boolean }> = [],
    undecided: Unchecked[] = []
  let truncated = false
  for (const [rootIndex, source] of roots.entries()) {
    const path = await checked(realpath(source.path).catch(() => undefined))
    if (!path) continue
    const root = { id: source.id, path }
    const result = await walk(root, guard, cancelled, check, () => {}, budget, [{ relative: '', depth: 0 }], true, accept, preview)
    truncated ||= result.truncated
    undecided.push(result.undecided)
    walked.push({ root, rootIndex, ignored: result.ignored, skipped: result.skipped, partial: result.partial })
    for (const [index, relative] of result.paths.entries()) {
      if ((index & 1023) === 0) await turnIfDue()
      candidates.push(candidate(root, rootIndex, relative, needle, false)!)
    }
    if (cancelled()) break
    if (preview && (result.truncated || candidates.length) && rootIndex < roots.length - 1) {
      truncated = true
      break
    }
  }
  if (wantsSkipped(candidates, limit, needle)) {
    if (preview) {
      truncated ||= walked.some(root => root.partial || root.ignored.length || root.skipped.length)
    } else {
      const later = freshBudget(SKIPPED_WALK_MS, SKIPPED_WALK_ENTRIES)
      for (const { root, rootIndex, ignored, skipped, partial } of walked) {
        const names = await walkSkipped(root, skipped, guard, cancelled, check, later, accept)
        truncated ||= names.truncated || partial
        for (const [index, relative] of [...ignored, ...names.paths].entries()) {
          if ((index & 1023) === 0) await turnIfDue()
          candidates.push(candidate(root, rootIndex, relative, needle, true)!)
        }
      }
    }
  }
  return { candidates, truncated: truncated || cancelled(), ...uncheckedOf(undecided) }
}
