import { watch, constants, type Stats } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isFileMention, type FileChange } from '@latch/protocol'
import type { FileTrackingHandle, FileTrackingInput, FileTrackingResult } from '@latch/sdk'
import { hashHandle } from '../changes/objects.ts'
import { isInsidePath } from '../paths.ts'
import { openRootGitIgnore } from './git-ignore-scope.ts'
import { isIgnoredPath, isSecretLookingPath } from './ignore.ts'
import { fileFormat } from './metadata.ts'
import { ProtectedPaths, resolveRecorded, type FileRoot, type ManagedHomeAccess } from './resolve.ts'
type Stamp = { signature: string; birth: number }
type WatchFiles = (root: string, changed: (path: string | null) => void, failed: () => void) => () => void
interface TrackerOptions {
  protectedPaths: readonly string[]
  managedHome?: ManagedHomeAccess
  allowedRoot?(root: FileRoot): Promise<boolean>
  platform?: string
  settleMs?: number
  scanMs?: number
  entryLimit?: number
  pathLimit?: number
  watch?: WatchFiles
}
const stamp = (info: Stats): Stamp => ({
  signature: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
  birth: info.birthtimeMs,
})
const keyOf = (root: string, path: string) => `${root}\n${path}`
const splitKey = (key: string): { root: string; path: string } => {
  const at = key.indexOf('\n')
  return { root: key.slice(0, at), path: key.slice(at + 1) }
}
const ignored = (path: string): boolean => isIgnoredPath(path) || isSecretLookingPath(path)
const DOCUMENT_KINDS: ReadonlySet<string> = new Set(['pptx', 'pdf', 'docx', 'xlsx', 'csv', 'html', 'image', 'svg', 'audio', 'video'])
const watchFiles: WatchFiles = (root, changed, failed) => {
  const watcher = watch(root, { recursive: true, persistent: false, encoding: 'utf8' }, (_event, filename) => changed(filename))
  watcher.on('error', failed)
  return () => watcher.close()
}
/** One Host owns all watchers. No shell or Git command is involved in discovery. */
export function createFileTrackingService(options: TrackerOptions) {
  const active = new Set<FileTrackingHandle>(),
    baseGuard = new ProtectedPaths(options.protectedPaths)
  const managedHome = options.managedHome
  const managedProtectedPaths = managedHome ? options.protectedPaths.filter(path => path !== managedHome.protectedAncestor) : undefined
  const entryLimit = Math.min(options.entryLimit ?? 50_000, 50_000),
    pathLimit = Math.min(options.pathLimit ?? 1000, 1000)
  const scanMs = Math.min(options.scanMs ?? 2000, 2000),
    settleMs = Math.min(options.settleMs ?? 2000, 2000)
  const platform = options.platform ?? process.platform
  const unavailable = (): FileTrackingHandle => ({ finish: async () => ({ files: [], unavailable: true }), dispose: () => {} })
  let closed = false,
    starting = 0
  const setups = new Set<Promise<FileTrackingHandle>>()
  const service = {
    start(input: FileTrackingInput): Promise<FileTrackingHandle> {
      if (closed || active.size + starting >= 32) return Promise.resolve(unavailable())
      starting++
      const setup = service.begin(input).finally(() => {
        starting--
        setups.delete(setup)
      })
      setups.add(setup)
      return setup
    },
    async begin(input: FileTrackingInput): Promise<FileTrackingHandle> {
      if (
        closed
        || !input.runId
        || !input.sessionId
        || !input.folders.length
        || input.folders.length > 8
        || input.runId.length > 128
        || input.sessionId.length > 256
      )
        return unavailable()
      const roots: FileRoot[] = []
      let guard = baseGuard
      let managedRoot: string | undefined
      for (const folder of input.folders) {
        if (!isAbsolute(folder.path) || !isFileMention({ root: folder.id, path: 'file' })) return unavailable()
        const path = await realpath(folder.path).catch(() => undefined)
        if (!path || (options.allowedRoot && !(await options.allowedRoot({ id: folder.id, path })))) return unavailable()
        if (input.folders.length === 1 && managedProtectedPaths && (await managedHome?.permits(input.sessionId, path))) {
          managedRoot = path
          guard = new ProtectedPaths(options.protectedPaths, { root: path, protectedPaths: managedProtectedPaths })
        }
        if (await guard.contains(path)) return unavailable()
        if (roots.some(root => root.id === folder.id || isInsidePath(root.path, path) || isInsidePath(path, root.path)))
          return unavailable()
        roots.push({ id: folder.id, path })
      }
      const gitScopes = new Map(await Promise.all(roots.map(async root => [root.id, await openRootGitIgnore(root)] as const)))
      const startedAt = Date.now(),
        baseline = new Map<string, Stamp>(),
        pending = new Set<string>(),
        observed = new Set<string>(),
        changes = new Map<string, FileChange>()
      const stops: Array<() => void> = []
      let truncated = false,
        failedScan = false,
        baselineComplete = true,
        fallback = platform !== 'darwin' && platform !== 'win32',
        pathBytes = 0
      let disposed = false,
        finishing = false,
        finished = false,
        ready = false,
        debounceTimer: ReturnType<typeof setTimeout> | undefined,
        settleTimer: ReturnType<typeof setTimeout> | undefined
      let refreshWork: Promise<void> = Promise.resolve(),
        completion: Promise<FileTrackingResult> | undefined,
        endWait: (() => void) | undefined
      const result = (): FileTrackingResult => ({
        files: [...changes.values()].toSorted((a, b) => a.root.localeCompare(b.root) || a.path.localeCompare(b.path)),
        ...(truncated ? { truncated: true } : {}),
        ...(failedScan ? { unavailable: true } : {}),
      })
      const emit = () => {
        if (!finished && !disposed) {
          try {
            input.onChange(structuredClone(result()))
          } catch {
            /* Projection failures do not affect execution. */
          }
        }
      }
      const remember = (key: string): boolean => {
        if (observed.has(key)) return true
        if (observed.size >= pathLimit || pathBytes + Buffer.byteLength(key) > 256 * 1024) {
          truncated = true
          return false
        }
        observed.add(key)
        pathBytes += Buffer.byteLength(key)
        return true
      }
      const homeStillUsable = async () => {
        if (!managedRoot || (await managedHome?.permits(input.sessionId, managedRoot))) return true
        changes.clear()
        failedScan = true
        return false
      }
      const scan = async (): Promise<{ entries: Map<string, Stamp>; complete: boolean }> => {
        const entries = new Map<string, Stamp>(),
          queue = roots.map(root => ({ root, path: '', depth: 0 })),
          deadline = Date.now() + scanMs
        if (!(await homeStillUsable())) return { entries, complete: false }
        let count = 0,
          complete = true
        while (queue.length && !disposed) {
          if (Date.now() > deadline || count >= entryLimit) {
            complete = false
            break
          }
          const next = queue.shift()!,
            full = join(next.root.path, next.path)
          const canonical = await realpath(full).catch(() => undefined)
          if (!canonical) {
            complete = false
            continue
          }
          if (!isInsidePath(canonical, next.root.path) || (await guard.contains(canonical))) continue
          const directory = await opendir(canonical).catch(() => undefined)
          if (!directory) {
            complete = false
            continue
          }
          for await (const item of directory) {
            if (++count > entryLimit || Date.now() > deadline || disposed) {
              complete = false
              break
            }
            const path = next.path ? `${next.path}/${item.name}` : item.name
            if (ignored(path) || item.isSymbolicLink() || !isFileMention({ root: next.root.id, path })) continue
            if (item.isDirectory()) {
              if (next.depth < 32) queue.push({ root: next.root, path, depth: next.depth + 1 })
              else complete = false
              continue
            }
            if (!item.isFile() || (await guard.contains(join(canonical, item.name)))) continue
            const info = await lstat(join(canonical, item.name)).catch(() => undefined)
            if (!info) complete = false
            if (info?.isFile() && !info.isSymbolicLink()) entries.set(keyOf(next.root.id, path), stamp(info))
          }
        }
        if (disposed) complete = false
        return { entries, complete }
      }
      const inspect = async (key: string) => {
        const { root: id, path } = splitKey(key),
          root = roots.find(root => root.id === id)
        if (!root || ignored(path) || !remember(key)) return
        const file = join(root.path, path),
          info = await lstat(file).catch((error: unknown) => {
            if (error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))
              return undefined
            truncated = true
            failedScan = true
            return null
          })
        if (info === null) return
        if (!info) {
          if (baseline.has(key)) changes.set(key, { root: id, path, change: 'deleted' })
          return
        }
        if (info.isDirectory()) {
          fallback = true
          // The end scan now decides what changed under it, against a baseline that did not reach everything.
          if (!baselineComplete) truncated = true
          return
        }
        if (!info.isFile() || info.isSymbolicLink()) return
        const previous = baseline.get(key)
        if (previous?.signature === stamp(info).signature) {
          changes.delete(key)
          return
        }
        // Outside an unfinished baseline there is no earlier state to compare with, but a file whose content and
        // metadata were both last written before the run began was not changed by it.
        if (!previous && !baselineComplete && info.mtimeMs < startedAt && info.ctimeMs < startedAt) {
          changes.delete(key)
          return
        }
        const resolved = await resolveRecorded(id, path, { roots: [root], protectedPaths: guard, home: '' })
        if (resolved.status === 'unreadable') {
          truncated = true
          failedScan = true
        }
        if (resolved.status !== 'ok' || resolved.file.secret) {
          changes.delete(key)
          return
        }
        const { kind } = fileFormat(resolved.file),
          born = info.birthtimeMs > 0 && info.birthtimeMs >= startedAt,
          created = !previous && born && platform === 'darwin',
          fresh = !created && !previous && baselineComplete,
          gitIgnored = await gitScopes.get(id)?.isIgnored(resolved.file.relativePath)
        changes.set(key, {
          root: id,
          path: resolved.file.relativePath,
          change: created ? 'created' : 'modified',
          size: resolved.file.size,
          kind,
          ...(fresh ? { fresh: true as const } : {}),
          ...(gitIgnored ? { gitIgnored: true as const } : {}),
        })
      }
      const refresh = () => {
        const work = refreshWork
          .catch(() => {})
          .then(async () => {
            const keys = [...pending]
            pending.clear()
            if (!(await homeStillUsable())) {
              emit()
              return
            }
            const deadline = Date.now() + scanMs
            for (const key of keys) {
              if (Date.now() > deadline) {
                truncated = true
                break
              }
              await inspect(key)
            }
            await homeStillUsable()
            emit()
          })
        refreshWork = work
        return work
      }
      const changed = (root: FileRoot, filename: string | null) => {
        if (disposed || finished) return
        if (!filename) {
          fallback = true
          truncated = true
          return
        }
        const absolute = isAbsolute(filename) ? filename : join(root.path, filename),
          path = relative(root.path, absolute).split(sep).join('/')
        if (!isFileMention({ root: root.id, path }) || ignored(path)) return
        const key = keyOf(root.id, path)
        if (!remember(key)) return
        pending.add(key)
        if (!ready) return
        clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          void refresh().catch(() => {
            truncated = true
            failedScan = true
            emit()
          })
        }, 180)
      }
      if (!fallback)
        for (const root of roots) {
          try {
            stops.push(
              (options.watch ?? watchFiles)(
                root.path,
                path => changed(root, path),
                () => {
                  fallback = true
                  truncated = true
                  emit()
                },
              ),
            )
          } catch {
            fallback = true
            truncated = true
          }
        }
      const first = await scan().catch(() => {
        failedScan = true
        return { entries: new Map<string, Stamp>(), complete: false }
      })
      for (const [key, value] of first.entries) baseline.set(key, value)
      // With a watcher running, every change arrives as an event whether or not the folder was scanned to the end: a
      // large repository's unfinished baseline costs only the telling apart of a file that was touched from one that
      // changed, and of a deletion from a file that never was. Without one, the end scan compares against this
      // baseline, so what it did not reach is not known.
      if (!first.complete && fallback) truncated = true
      baselineComplete = first.complete
      ready = true
      const handle: FileTrackingHandle = {
        finish() {
          return (completion ??= (async () => {
            finishing = true
            if (!disposed && settleMs > 0)
              await new Promise<void>(resolve => {
                endWait = resolve
                settleTimer = setTimeout(resolve, settleMs)
              })
            clearTimeout(debounceTimer)
            clearTimeout(settleTimer)
            for (const stop of stops.splice(0)) stop()
            await refreshWork.catch(() => {
              truncated = true
              failedScan = true
            })
            if (!(await homeStillUsable())) return structuredClone(result())
            if (fallback) {
              // Shutdown can end observation early, but still gets one bounded final scan.
              const wasDisposed = disposed
              disposed = false
              const last = await scan().catch(() => {
                failedScan = true
                return { entries: new Map<string, Stamp>(), complete: false }
              })
              disposed = wasDisposed
              if (!last.complete) truncated = true
              const keys = new Set([...last.entries.keys(), ...baseline.keys()]),
                deadline = Date.now() + scanMs
              for (const key of keys) {
                if (Date.now() > deadline) {
                  truncated = true
                  break
                }
                if (last.entries.get(key)?.signature === baseline.get(key)?.signature) continue
                await inspect(key)
              }
            }
            await refresh().catch(() => {
              truncated = true
              failedScan = true
            })
            if (!disposed) {
              const hashLimit = 128 * 1024 * 1024
              for (const entry of changes.values()) {
                if (entry.change === 'deleted' || (entry.size !== undefined && entry.size > hashLimit)) continue
                const isNew = entry.change === 'created' || entry.fresh === true
                if (!isNew && !entry.gitIgnored && !(entry.kind !== undefined && DOCUMENT_KINDS.has(entry.kind))) continue
                const root = roots.find(item => item.id === entry.root)
                if (!root) continue
                const target = join(root.path, ...entry.path.split('/'))
                const fd = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK).catch(
                  () => undefined,
                )
                if (!fd) continue
                try {
                  const stat = await fd.stat({ bigint: true })
                  if (stat.isFile() && Number(stat.size) <= hashLimit) entry.sha256 = await hashHandle(fd)
                } catch {
                  /* Best-effort settlement digest. */
                } finally {
                  await fd.close().catch(() => {})
                }
              }
            }
            finished = true
            active.delete(handle)
            return structuredClone(result())
          })().finally(() => {
            finished = true
            active.delete(handle)
            for (const stop of stops.splice(0)) stop()
            clearTimeout(debounceTimer)
            clearTimeout(settleTimer)
          }))
        },
        dispose() {
          if (finished || disposed) return
          disposed = true
          truncated = true
          for (const stop of stops.splice(0)) stop()
          clearTimeout(debounceTimer)
          clearTimeout(settleTimer)
          endWait?.()
          if (!finishing) void handle.finish().catch(() => {})
        },
      }
      active.add(handle)
      if (closed) handle.dispose()
      if (pending.size) await refresh()
      else if (truncated) emit()
      return handle
    },
    async close(): Promise<void> {
      closed = true
      await Promise.allSettled([...setups])
      const handles = [...active]
      for (const handle of handles) handle.dispose()
      await Promise.allSettled(handles.map(handle => handle.finish()))
    },
  }
  return { start: service.start, close: service.close }
}
