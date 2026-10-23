/**
 * Project configuration a harness loads when it starts, looked up in the session directory and every directory above
 * it, along both the path the agent is given and its real path. Its digest is part of the launch fingerprint, so the
 * local confirmation covers it and a later change stops the session.
 */
import { constants, type Stats } from 'node:fs'
import { lstat, open, readdir, readlink, realpath, stat, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { canonicalJson, sha256Hex } from '../../host/crypto.ts'
import type { ProjectConfigManaged } from './profiles/index.ts'

/** Per fingerprint: entries visited, bytes read, and directory levels below a configuration directory. */
export const PROJECT_CONFIG_LIMITS = { entries: 2_000, bytes: 8 * 1024 * 1024, depth: 16 } as const

/** Opening never waits on a FIFO or takes a terminal; the flags do not exist on Windows. */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0)

interface Entry {
  path: string
  kind: 'file' | 'symlink' | 'other' | 'unreadable'
  size?: number
  /** Of the content, or of what `reduce` left of it. */
  sha256?: string
  /** In place of `sha256` once the byte budget is spent. */
  mtimeMs?: number
  /** A symbolic link's own text; it is never followed into a directory. */
  target?: string
  /** What a symbolic link points at when that is not a file. */
  resolved?: 'directory' | 'other' | 'missing'
  /** Why the entry could not be read; it still counts, so becoming readable is a change too. */
  code?: string
}

export interface ProjectConfig {
  /** Absent when nothing was found. */
  digest?: string
  /** Absolute paths as found, sorted. */
  entries: Array<{ path: string; unreadable: boolean }>
  /** A limit stopped the walk; what lies beyond it is not compared. */
  truncated: boolean
}

function codeOf(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown'
}

async function readAll(handle: FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset)
    if (!bytesRead) break
    offset += bytesRead
  }
  return buffer.subarray(0, offset)
}

/**
 * Fingerprints `paths` (files, or directories with everything below them) wherever they appear from `cwd` up to the
 * root. Directories are walked without following symbolic links; a linked file is read, a linked directory is not.
 * The user's home directory is skipped: harnesses keep their own user-level data there (`~/.codex`, `~/.opencode`).
 */
export async function fingerprintProjectConfig(
  cwd: string, paths: readonly string[], managed: ProjectConfigManaged = {}, home: string = process.env.HOME || homedir(),
): Promise<ProjectConfig> {
  const entries: Entry[] = []
  const skip = new Set(managed.skip ?? [])
  let visited = 0
  let bytes = 0
  let truncated = false

  /** A file's content; `follow` reads through a symbolic link. Only regular files are read. */
  async function content(path: string, rel: string, follow: boolean): Promise<Partial<Entry> | 'omit'> {
    if (follow) {
      let target: Stats
      try { target = await stat(path) } catch (error) {
        const code = codeOf(error)
        return code === 'ENOENT' ? { resolved: 'missing' } : { code }
      }
      if (!target.isFile()) return { resolved: target.isDirectory() ? 'directory' : 'other' }
    }
    let handle: FileHandle
    try {
      handle = await open(path, READ_FLAGS | (follow ? 0 : constants.O_NOFOLLOW ?? 0))
    } catch (error) {
      return { code: codeOf(error) }
    }
    try {
      const info = await handle.stat()
      if (!info.isFile()) return { resolved: info.isDirectory() ? 'directory' : 'other' }
      if (info.size > PROJECT_CONFIG_LIMITS.bytes - bytes) return { size: info.size, mtimeMs: info.mtimeMs }
      const data = await readAll(handle, info.size)
      bytes += data.length
      const whole = { size: data.length, sha256: sha256Hex(data) }
      const reduce = managed.reduce?.[rel]
      if (!reduce) return whole
      try {
        const reduced = reduce(data.toString('utf8'))
        return reduced === undefined ? 'omit' : { sha256: sha256Hex(canonicalJson(reduced)) }
      } catch { return whole }
    } catch (error) {
      return { code: codeOf(error) }
    } finally { await handle.close().catch(() => {}) }
  }

  async function visit(path: string, rel: string, depth: number): Promise<void> {
    if (truncated || skip.has(rel)) return
    let info: Stats
    try { info = await lstat(path) } catch (error) {
      const code = codeOf(error)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') entries.push({ path, kind: 'unreadable', code })
      return
    }
    if (++visited > PROJECT_CONFIG_LIMITS.entries) { truncated = true; return }
    if (info.isDirectory()) {
      if (depth >= PROJECT_CONFIG_LIMITS.depth) { truncated = true; return }
      let names: string[]
      try { names = await readdir(path) } catch (error) {
        entries.push({ path, kind: 'unreadable', code: codeOf(error) })
        return
      }
      for (const name of names.sort()) await visit(join(path, name), `${rel}/${name}`, depth + 1)
      return
    }
    if (info.isSymbolicLink()) {
      let target: string
      try { target = await readlink(path) } catch (error) {
        entries.push({ path, kind: 'unreadable', code: codeOf(error) })
        return
      }
      const found = await content(path, rel, true)
      if (found !== 'omit') entries.push({ ...found, path, kind: 'symlink', target })
      return
    }
    if (info.isFile()) {
      const found = await content(path, rel, false)
      if (found !== 'omit') entries.push({ ...found, path, kind: 'file' })
      return
    }
    entries.push({ path, kind: 'other' })
  }

  const homes = new Set([resolve(home), await realpath(home).catch(() => resolve(home))])
  const seen = new Set<string>()
  const literal = resolve(cwd)
  for (const start of new Set([literal, await realpath(literal).catch(() => literal)])) {
    for (let directory = start; ; directory = dirname(directory)) {
      const identity = await realpath(directory).catch(() => directory)
      if (!seen.has(identity) && !homes.has(directory) && !homes.has(identity)) {
        for (const name of paths) await visit(join(directory, name), name, 0)
      }
      seen.add(identity)
      if (dirname(directory) === directory) break
    }
  }

  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return {
    ...(entries.length || truncated ? { digest: sha256Hex(canonicalJson({ v: 1, entries, truncated })) } : {}),
    entries: entries.map(entry => ({ path: entry.path, unreadable: entry.kind === 'unreadable' || entry.code !== undefined })),
    truncated,
  }
}
