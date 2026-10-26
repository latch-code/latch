import { watch, type FSWatcher } from 'node:fs'
import { opendir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@latch/sdk'
import { resolveRecorded, type FileRoot, type ProtectedPaths } from './resolve.ts'
import { isInsidePath } from '../paths.ts'

const IGNORED = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', '__pycache__', '.DS_Store'])
const MAX_PATH_BYTES = 2 * 1024 * 1024
interface Snapshot {
  paths: readonly string[]
  truncated: boolean
  current?(): boolean
}
interface Entry {
  guard: ProtectedPaths
  promise: Promise<Snapshot>
  watchers: FSWatcher[]
  timer?: NodeJS.Timeout
  dirty: boolean
  fullyWatched: boolean
}
export interface FileSearchHit {
  name: string
  path: string
  root: string
}
type Check = () => void
class IndexChanged extends Error {}
const unavailable = () => new AppError(503, 'file-search-unavailable', '文件搜索已关闭')

function matches(path: string, query: string): boolean {
  let at = 0
  for (const character of query.replace(/\s+/gu, '')) {
    const found = path.indexOf(character, at)
    if (found < 0) return false
    at = found + character.length
  }
  return true
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
      promise: Promise.resolve({ paths: [], truncated: false }),
      watchers: [],
      dirty: false,
      fullyWatched: true,
    }
    this.entries.set(key, entry)
    entry.promise = scan(root, guard, cancelled, check, path => {
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
    })
      .then(snapshot => {
        check()
        if (entry.dirty || snapshot.truncated) throw new IndexChanged()
        if (!cancelled()) entry.timer = setTimeout(() => this.invalidate(key, entry), entry.fullyWatched ? 30_000 : 1000).unref()
        else this.invalidate(key, entry)
        return { ...snapshot, current: () => !entry.dirty }
      })
      .catch(cause => {
        this.invalidate(key, entry)
        throw cause
      })
    return entry.promise
  }
}

/** A bounded BFS, with at most two MiB each of queued directory paths and cached file paths. */
async function scan(
  root: FileRoot,
  guard: ProtectedPaths,
  cancelled: () => boolean,
  check: Check,
  observe: (path: string) => void,
): Promise<Snapshot> {
  const paths: string[] = []
  const queue: Array<{ relative: string; depth: number } | undefined> = [{ relative: '', depth: 0 }]
  let visited = 0,
    bytes = 0,
    queueBytes = 0,
    truncated = false,
    at = 0
  const deadline = performance.now() + 2000
  const checked = async <T>(operation: Promise<T>) => {
    const result = await operation
    check()
    return result
  }
  while (at < queue.length && !cancelled()) {
    check()
    const entry = queue[at]!
    queue[at++] = undefined
    const path = join(root.path, entry.relative)
    queueBytes -= Buffer.byteLength(entry.relative)
    const real = await checked(realpath(path).catch(() => undefined))
    if (real === undefined || !isInsidePath(real, root.path) || (await checked(guard.contains(real)))) continue
    observe(real)
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
      check()
      if (++visited > 50_000 || performance.now() > deadline || cancelled()) {
        truncated = true
        break
      }
      if (IGNORED.has(item.name) || item.name.endsWith('.tmp') || item.isSymbolicLink()) continue
      const relative = entry.relative ? `${entry.relative}/${item.name}` : item.name
      const size = Buffer.byteLength(relative)
      if (size > 4096) {
        truncated = true
        continue
      }
      if (item.isDirectory()) {
        if (entry.depth < 32 && queue.length < 10_000 && queueBytes + size <= MAX_PATH_BYTES) {
          queue.push({ relative, depth: entry.depth + 1 })
          queueBytes += size
        } else truncated = true
      } else if (item.isFile()) {
        if (paths.length >= 20_000 || bytes + size > MAX_PATH_BYTES) {
          truncated = true
          break
        }
        paths.push(relative)
        bytes += size
      }
    }
    if (visited > 50_000 || performance.now() > deadline || paths.length >= 20_000 || bytes >= MAX_PATH_BYTES) {
      truncated = true
      break
    }
  }
  if (cancelled()) truncated = true
  return { paths, truncated }
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
  const files: FileSearchHit[] = [],
    needle = query.trim().toLocaleLowerCase()
  let truncated = false
  const deadline = performance.now() + 2000
  const checked = async <T>(operation: Promise<T>) => {
    const result = await operation
    check()
    return result
  }
  check()
  for (const source of roots) {
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
    for (const relative of snapshot.paths) {
      check()
      if (snapshot.current && !snapshot.current()) throw new IndexChanged()
      if (cancelled() || performance.now() > deadline) {
        truncated = true
        break
      }
      if (needle && !matches(relative.toLocaleLowerCase(), needle)) continue
      const resolved = await checked(resolveRecorded(root.id, relative, { roots: [root], protectedPaths: guard, home: '' }))
      if (snapshot.current && !snapshot.current()) throw new IndexChanged()
      if (resolved.status !== 'ok' || resolved.file.secret) continue
      files.push({ name: resolved.file.name, path: resolved.file.relativePath, root: root.id })
      if (files.length >= limit) {
        truncated = true
        break
      }
    }
    if (snapshot.current && !snapshot.current()) throw new IndexChanged()
    if (files.length >= limit) break
  }
  return { files, truncated }
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
  const files: FileSearchHit[] = []
  const needle = query.trim().toLocaleLowerCase()
  const canonical = await Promise.all(
    roots.map(async root => ({ id: root.id, path: await checked(realpath(root.path).catch(() => undefined)) })),
  )
  const queue = canonical.flatMap(root => (root.path ? [{ root: { id: root.id, path: root.path }, relative: '', depth: 0 }] : []))
  const deadline = Date.now() + 2000
  let visited = 0
  let truncated = false
  while (queue.length && !cancelled()) {
    const entry = queue.shift()!
    const path = join(entry.root.path, entry.relative)
    const real = await checked(realpath(path).catch(() => undefined))
    if (real === undefined || !isInsidePath(real, entry.root.path) || (await checked(guard.contains(real)))) continue
    let directory: Awaited<ReturnType<typeof opendir>>
    try {
      directory = await opendir(real)
    } catch {
      continue
    }
    try {
      check()
    } catch (cause) {
      await directory.close()
      throw cause
    }
    for await (const item of directory) {
      check()
      if (++visited > 50_000 || Date.now() > deadline || cancelled()) {
        truncated = true
        break
      }
      if (IGNORED.has(item.name) || item.name.endsWith('.tmp') || item.isSymbolicLink()) continue
      const relative = entry.relative ? `${entry.relative}/${item.name}` : item.name
      if (item.isDirectory()) {
        if (entry.depth < 32) queue.push({ root: entry.root, relative, depth: entry.depth + 1 })
        else truncated = true
      } else if (item.isFile() && (!needle || matches(relative.toLocaleLowerCase(), needle))) {
        const full = join(real, item.name)
        if (await checked(guard.contains(full))) continue
        const resolved = await checked(resolveRecorded(entry.root.id, relative, { roots: [entry.root], protectedPaths: guard, home: '' }))
        if (resolved.status !== 'ok' || resolved.file.secret) continue
        files.push({ name: resolved.file.name, path: resolved.file.relativePath, root: entry.root.id })
        if (files.length >= limit) {
          truncated = true
          break
        }
      }
    }
    if (files.length >= limit || visited > 50_000 || Date.now() > deadline) {
      truncated = true
      break
    }
  }
  if (cancelled()) truncated = true
  return { files, truncated }
}
