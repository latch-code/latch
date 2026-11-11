// Turns a file reference as a message wrote it (a relative path, `../`, an absolute path, a `file://` URI, with an
// optional `:line` or `#L12`) into a regular file inside one of the session's folders, or a reason it is not one.
// Every answer starts from the text again: nothing about a file is cached between requests.
import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isInsidePath } from '../paths.ts'
import { FAMILY_OF, OPEN_TYPES, PREVIEW_UNVERIFIED, QUICK_LOOK_TYPES, extensionOf } from './kinds.ts'
import { hasSecretContent, isSecretPath } from './secrets.ts'
import { SNIFF_BYTES, matchesFamily } from './sniff.ts'

/** Windows has no O_NOFOLLOW; the identity checks below still apply there. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const PATH_BYTES_LIMIT = 4096
const LINE_LIMIT = 10_000_000
const CONTROL = /[\u0000-\u001f\u007f]/u

/** One of the session's folders. The first is where relative paths start (the primary folder, today the `cwd`). */
export interface FileRoot {
  id: string
  path: string
}

export interface FileReference {
  path: string
  line?: number
  column?: number
}

export type ResolveStatus = 'ok' | 'missing' | 'outside' | 'protected' | 'folder' | 'not-file' | 'unreadable' | 'invalid'

export interface ResolvedFile {
  rootId: string
  /** Relative to the folder, `/`-separated. */
  relativePath: string
  realPath: string
  name: string
  /** Lowercased, without the dot; '' when the name has none. */
  ext: string
  size: number
  mtimeMs: number
  /** Descriptor identity and nanosecond timestamps, for content validators and cache tags. */
  identity?: string
  /** The file's first bytes (at most 64 KiB), for the content checks. */
  head: Uint8Array
  /** Its name or content suggests it holds a secret. */
  secret: boolean
}

export type Resolution =
  | { status: 'ok'; file: ResolvedFile; line?: number; column?: number }
  | { status: Exclude<ResolveStatus, 'ok'>; line?: number; column?: number }

/** Why an action is not offered for a file the Host resolved. */
export type ActionRefusal = 'file-secret' | 'file-type-refused' | 'file-preview-unverified' | 'file-content-mismatch'
export type ActionVerdict = { ok: true } | { ok: false; code: ActionRefusal }

export interface ResolveOptions {
  roots: readonly FileRoot[]
  protectedPaths: ProtectedPaths
  home: string
  /** Test seam only; the Host never sets it. Runs after the path was resolved and checked, before the file is opened. */
  hooks?: { afterResolve?(realPath: string): Promise<void> }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

/** Errors that mean "no such file here" while resolving, rather than a fault of the Host. */
const ABSENT = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG'])
const DENIED = new Set(['EACCES', 'EPERM'])

function parseLine(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 1 && number <= LINE_LIMIT ? number : undefined
}

/**
 * The path and position a reference names, or undefined when it is not one Latch accepts: empty, over 4096 bytes,
 * with control characters or backslashes, a Windows drive, a `file:` URI for another host, or `~` alone.
 */
export function parseReference(input: string, home: string): FileReference | undefined {
  let text = input.trim()
  if (!text || Buffer.byteLength(text, 'utf8') > PATH_BYTES_LIMIT || CONTROL.test(text) || text.includes('\\')) return undefined
  if (/^[A-Za-z]:/u.test(text)) return undefined
  let line: number | undefined
  let column: number | undefined
  if (/^file:/iu.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return undefined
    }
    if (url.protocol !== 'file:' || (url.hostname !== '' && url.hostname !== 'localhost') || url.search) return undefined
    try {
      text = decodeURIComponent(url.pathname)
    } catch {
      return undefined
    }
    if (!text || CONTROL.test(text) || text.includes('\\')) return undefined
    const hash = /^#L(\d+)(?:C(\d+))?$/u.exec(url.hash)
    if (hash) {
      line = parseLine(hash[1])
      column = parseLine(hash[2])
    } else if (url.hash) return undefined
  } else {
    const hash = /#L(\d+)(?:C(\d+))?$/u.exec(text)
    if (hash) {
      line = parseLine(hash[1])
      column = parseLine(hash[2])
      text = text.slice(0, hash.index)
    }
  }
  const position = line === undefined ? /:(\d+)(?::(\d+))?$/u.exec(text) : null
  if (position && position.index > 0) {
    line = parseLine(position[1])
    column = parseLine(position[2])
    text = text.slice(0, position.index)
  }
  if (text === '~' || (text.startsWith('~') && !text.startsWith('~/'))) return undefined
  if (text.startsWith('~/')) text = join(home, text.slice(2))
  if (!text) return undefined
  return { path: text, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) }
}

/**
 * Latch's private paths (the data directory, runtime directory, agent installs, TLS key, the home directory's
 * credential folders): a target is protected when it or any ancestor is one of them, by spelling or by file-system
 * identity, so another spelling of the same directory is caught too.
 */
export class ProtectedPaths {
  constructor(private readonly paths: readonly string[]) {}

  async contains(target: string): Promise<boolean> {
    if (this.paths.length === 0) return false
    const ids = new Set<string>()
    const spelled = new Set<string>()
    for (const path of this.paths) {
      spelled.add(await realpath(path).catch(() => resolve(path)))
      try {
        const info = await stat(path, { bigint: true })
        ids.add(`${info.dev}:${info.ino}`)
      } catch (error) {
        if (!ABSENT.has(errorCode(error) as string) && !DENIED.has(errorCode(error) as string)) throw error
      }
    }
    for (let current = target; ; current = dirname(current)) {
      if ([...spelled].some(path => isInsidePath(current, path) && isInsidePath(path, current))) return true
      try {
        const info = await lstat(current, { bigint: true })
        if (ids.has(`${info.dev}:${info.ino}`)) return true
      } catch (error) {
        if (!ABSENT.has(errorCode(error) as string) && !DENIED.has(errorCode(error) as string)) throw error
      }
      if (dirname(current) === current) return false
    }
  }
}

/** The real path of `path`, or of its nearest existing ancestor with the rest appended when it does not exist. */
async function locate(path: string): Promise<{ real: string; exists: boolean }> {
  try {
    return { real: await realpath(path), exists: true }
  } catch (error) {
    if (!ABSENT.has(errorCode(error) as string) && !DENIED.has(errorCode(error) as string)) throw error
  }
  const rest: string[] = []
  for (let current = path; ;) {
    const parent = dirname(current)
    if (parent === current) return { real: path, exists: false }
    rest.unshift(basename(current))
    current = parent
    try {
      return { real: join(await realpath(current), ...rest), exists: false }
    } catch (error) {
      if (!ABSENT.has(errorCode(error) as string) && !DENIED.has(errorCode(error) as string)) throw error
    }
  }
}

/** The session's folders that still exist, by their real paths, in order. */
export async function realRoots(roots: readonly FileRoot[]): Promise<FileRoot[]> {
  const found: FileRoot[] = []
  for (const root of roots) {
    const real = await realpath(root.path).catch(() => undefined)
    if (real !== undefined && (await stat(real).catch(() => undefined))?.isDirectory()) found.push({ id: root.id, path: real })
  }
  return found
}

/** Resolves a reference as written in a message; relative paths start in the first (primary) folder. */
export async function resolveReference(input: string, options: ResolveOptions): Promise<Resolution> {
  const reference = parseReference(input, options.home)
  if (!reference) return { status: 'invalid' }
  const position = {
    ...(reference.line === undefined ? {} : { line: reference.line }),
    ...(reference.column === undefined ? {} : { column: reference.column }),
  }
  const roots = await realRoots(options.roots)
  const primary = roots[0]
  if (!primary) return { status: 'missing', ...position }
  const candidate = isAbsolute(reference.path) ? resolve(reference.path) : resolve(primary.path, reference.path)
  const result = await resolveCandidate(candidate, roots, options)
  return { ...result, ...position }
}

/** Resolves a file again by the folder and relative path recorded for it (a handle). */
export async function resolveRecorded(rootId: string, relativePath: string, options: ResolveOptions): Promise<Resolution> {
  const roots = await realRoots(options.roots)
  const root = roots.find(item => item.id === rootId)
  if (!root || relativePath.split('/').some(part => part === '..' || part === '')) return { status: 'missing' }
  return resolveCandidate(resolve(root.path, ...relativePath.split('/')), [root], options)
}

async function resolveCandidate(candidate: string, roots: readonly FileRoot[], options: ResolveOptions): Promise<Resolution> {
  const located = await locate(candidate)
  // A symlink may stay inside the folder it is in; its target must be inside it too.
  const root = roots.find(item => isInsidePath(located.real, item.path))
  if (!root) return { status: 'outside' }
  if (await options.protectedPaths.contains(located.real)) return { status: 'protected' }
  if (!located.exists) return { status: 'missing' }
  const real = located.real
  if (real === root.path) return { status: 'folder' }
  await options.hooks?.afterResolve?.(real)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    // O_NONBLOCK: a FIFO does not wait for a writer before the type check refuses it.
    handle = await open(real, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = errorCode(error) as string
    if (ABSENT.has(code)) return { status: 'missing' }
    if (DENIED.has(code)) return { status: 'unreadable' }
    // A socket or another file that cannot be opened for reading.
    if (code === 'ENXIO' || code === 'EOPNOTSUPP' || code === 'ENODEV') return { status: 'not-file' }
    throw error
  }
  try {
    const info = await handle.stat({ bigint: true })
    if (info.isDirectory()) return { status: 'folder' }
    if (!info.isFile()) return { status: 'not-file' }
    const buffer = Buffer.alloc(Number(info.size < BigInt(SNIFF_BYTES) ? info.size : BigInt(SNIFF_BYTES)))
    const { bytesRead } = buffer.length === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, buffer.length, 0)
    // The open and the walk are separate calls: the path must still name the opened file, through no new symlink.
    const now = await lstat(real, { bigint: true }).catch(() => undefined)
    const again = await realpath(real).catch(() => undefined)
    if (!now || now.dev !== info.dev || now.ino !== info.ino || again !== real) return { status: 'missing' }
    const head = new Uint8Array(buffer.subarray(0, bytesRead))
    const relativePath = relative(root.path, real).split(sep).join('/')
    const name = basename(real)
    return {
      status: 'ok',
      file: {
        rootId: root.id,
        relativePath,
        realPath: real,
        name,
        ext: extensionOf(name),
        size: Number(info.size),
        mtimeMs: Number(info.mtimeMs),
        identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
        head,
        secret: isSecretPath(relativePath, head) || hasSecretContent(head),
      },
    }
  } finally {
    await handle.close()
  }
}

function verdict(allowed: ReadonlySet<string>, file: ResolvedFile, unverified?: ReadonlySet<string>): ActionVerdict {
  if (file.secret) return { ok: false, code: 'file-secret' }
  if (unverified?.has(file.ext)) return { ok: false, code: 'file-preview-unverified' }
  const family = FAMILY_OF[file.ext]
  if (!allowed.has(file.ext) || family === undefined) return { ok: false, code: 'file-type-refused' }
  if (!matchesFamily(family, file.head)) return { ok: false, code: 'file-content-mismatch' }
  return { ok: true }
}

/** What the desktop app may do with a resolved file. Showing it in Finder reads and starts nothing, so it is always offered. */
export function fileVerdicts(file: ResolvedFile): { reveal: ActionVerdict; quicklook: ActionVerdict; open: ActionVerdict } {
  return { reveal: { ok: true }, quicklook: verdict(QUICK_LOOK_TYPES, file, PREVIEW_UNVERIFIED), open: verdict(OPEN_TYPES, file) }
}
