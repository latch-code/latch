import { opendir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveRecorded, type FileRoot, type ProtectedPaths } from './resolve.ts'
import { isInsidePath } from '../paths.ts'

const IGNORED = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', '__pycache__', '.DS_Store'])
export interface FileSearchHit {
  name: string
  path: string
  root: string
}

/** A bounded filename search, without git subprocesses, symlink traversal or a directory tree response. */
export async function searchFiles(
  roots: readonly FileRoot[],
  guard: ProtectedPaths,
  query: string,
  limit: number,
  cancelled: () => boolean,
) {
  const files: FileSearchHit[] = []
  const needle = query.trim().toLocaleLowerCase()
  const canonical = await Promise.all(roots.map(async root => ({ id: root.id, path: await realpath(root.path).catch(() => undefined) })))
  const queue = canonical.flatMap(root => (root.path ? [{ root: { id: root.id, path: root.path }, relative: '', depth: 0 }] : []))
  const deadline = Date.now() + 2000
  let visited = 0
  let truncated = false
  while (queue.length && !cancelled()) {
    const entry = queue.shift()!
    const path = join(entry.root.path, entry.relative)
    const real = await realpath(path).catch(() => undefined)
    if (real === undefined || !isInsidePath(real, entry.root.path) || (await guard.contains(real))) continue
    let directory: Awaited<ReturnType<typeof opendir>>
    try {
      directory = await opendir(real)
    } catch {
      continue
    }
    for await (const item of directory) {
      if (++visited > 50_000 || Date.now() > deadline || cancelled()) {
        truncated = true
        break
      }
      if (IGNORED.has(item.name) || item.name.endsWith('.tmp') || item.isSymbolicLink()) continue
      const relative = entry.relative ? `${entry.relative}/${item.name}` : item.name
      if (item.isDirectory()) {
        if (entry.depth < 32) queue.push({ root: entry.root, relative, depth: entry.depth + 1 })
        else truncated = true
      } else if (item.isFile() && (!needle || relative.toLocaleLowerCase().includes(needle))) {
        const full = join(real, item.name)
        if (await guard.contains(full)) continue
        const resolved = await resolveRecorded(entry.root.id, relative, { roots: [entry.root], protectedPaths: guard, home: '' })
        if (resolved.status !== 'ok') continue
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
  return { files, truncated }
}
