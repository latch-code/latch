// A file outside every folder of a session that the session's own messages named by an absolute path (Codex's
// generated pictures, a log in /tmp). Each one is its own single-file root: bound to the path as written, its real path
// and its identity, never a folder that could be listed, searched or walked. Nothing beside it becomes readable.
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, normalize } from 'node:path'
import { sha256Hex } from '@latch/core/node-kit'
import { isSecretLookingPath } from './ignore.ts'
import type { ProtectedPaths, ResolvedFile, ResolveOptions, ResolveStatus } from './resolve.ts'
import { extensionOf } from './kinds.ts'
import { hasSecretContent, isSecretPath } from './secrets.ts'
import { SNIFF_BYTES } from './sniff.ts'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const ABSENT = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG'])
const DENIED = new Set(['EACCES', 'EPERM'])
/**
 * In an agent CLI's own folder everything a conversation names may be read (plans, logs, pictures), except where the
 * CLI keeps its login: these names, and its databases, which may hold tokens (OpenCode 2.x keeps its logins in SQLite).
 */
const CLI_LOGIN_NAMES = new Set([
  'auth.json',
  'credentials.json',
  '.credentials.json',
  'credentials.yaml',
  '.credentials.yaml',
  'oauth_creds.json',
  'google_accounts.json',
  'mcp-oauth-tokens.json',
  'secrets.yaml',
  'secrets.json',
])
const CLI_DATABASE = /\.(?:db|sqlite3?|db-wal|db-shm|sqlite-wal|sqlite-shm)$/iu
const isCliLogin = (name: string) => CLI_LOGIN_NAMES.has(name.toLowerCase()) || CLI_DATABASE.test(name)
/** Root IDs of session folders are short words; this prefix and length keep a synthetic one apart from all of them. */
const PREFIX = 'outside-'

/** The reference key for a path a message named outside every folder: no folder ID contains `@`. */
export const outsideKey = (path: string) => `@\n${path}`
/** A synthetic root ID for one named file (`^[A-Za-z0-9_-]{32}$`). */
export const outsideRootId = (path: string) => `${PREFIX}${sha256Hex(path).slice(0, 32 - PREFIX.length)}`
export const isOutsideRootId = (id: string) => id.startsWith(PREFIX)

/** What a handle for an outside file remembers: the path as named, and the file it named when it was issued. */
export interface OutsideBinding {
  path: string
  real: string
  dev: string
  ino: string
}

export interface OutsideGuard {
  /** Latch's private data, runtime and program folders, credential stores: never opened, whatever was named. */
  excluded: ProtectedPaths
  /** Agent CLIs' own folders: readable except their login files and databases. */
  cliHomes: ProtectedPaths
}

export type OutsideResolution = { status: 'ok'; file: ResolvedFile; binding: OutsideBinding } | { status: Exclude<ResolveStatus, 'ok'> }

function code(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

/** The absolute path a reference names, normalized, or undefined when it was written relative to a folder. */
export function namedOutsidePath(path: string): string | undefined {
  return isAbsolute(path) ? normalize(path) : undefined
}

/**
 * Resolves one named outside file, or says why not. `expect` is a handle's binding: the same real path and the same
 * file (device and inode), or the handle no longer names anything.
 */
export async function resolveOutside(
  named: string,
  guard: OutsideGuard,
  options: Pick<ResolveOptions, 'hooks'> & { expect?: OutsideBinding } = {},
): Promise<OutsideResolution> {
  if (!isAbsolute(named) || normalize(named) !== named) return { status: 'invalid' }
  let link: Awaited<ReturnType<typeof lstat>>
  let real: string
  try {
    // The last component is never a link: what was named must be the file itself.
    link = await lstat(named)
    if (link.isSymbolicLink()) return { status: 'not-file' }
    real = await realpath(named)
  } catch (error) {
    if (ABSENT.has(code(error) ?? '')) return { status: 'missing' }
    if (DENIED.has(code(error) ?? '')) return { status: 'unreadable' }
    throw error
  }
  if ((await guard.excluded.contains(named)) || (await guard.excluded.contains(real))) return { status: 'protected' }
  if (link.isDirectory()) return { status: 'folder' }
  if (!link.isFile()) return { status: 'not-file' }
  if (options.expect && options.expect.real !== real) return { status: 'missing' }
  await options.hooks?.afterResolve?.(real)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(real, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const reason = code(error) ?? ''
    if (ABSENT.has(reason)) return { status: 'missing' }
    if (DENIED.has(reason)) return { status: 'unreadable' }
    if (reason === 'ENXIO' || reason === 'EOPNOTSUPP' || reason === 'ENODEV') return { status: 'not-file' }
    throw error
  }
  try {
    const info = await handle.stat({ bigint: true })
    if (info.isDirectory()) return { status: 'folder' }
    if (!info.isFile()) return { status: 'not-file' }
    if (options.expect && (options.expect.dev !== String(info.dev) || options.expect.ino !== String(info.ino))) return { status: 'missing' }
    const buffer = Buffer.alloc(Number(info.size < BigInt(SNIFF_BYTES) ? info.size : BigInt(SNIFF_BYTES)))
    const { bytesRead } = buffer.length === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, buffer.length, 0)
    // The open and the walk are separate calls: both spellings must still name the opened file, through no new link.
    const now = await lstat(real, { bigint: true }).catch(() => undefined)
    const again = await realpath(named).catch(() => undefined)
    if (!now || now.dev !== info.dev || now.ino !== info.ino || again !== real) return { status: 'missing' }
    const head = new Uint8Array(buffer.subarray(0, bytesRead))
    // The secret rules see every folder on the way (`.ssh/`, `.aws/`, `.kube/config`), in both spellings.
    const relativePath = real.slice(1)
    if (
      isSecretPath(relativePath, head)
      || isSecretPath(named.slice(1), head)
      || isSecretLookingPath(relativePath)
      || isSecretLookingPath(named.slice(1))
      || hasSecretContent(head)
    )
      return { status: 'protected' }
    const name = basename(real)
    const file: ResolvedFile = {
      rootId: outsideRootId(named),
      relativePath,
      realPath: real,
      name,
      ext: extensionOf(name),
      size: Number(info.size),
      mtimeMs: Number(info.mtimeMs),
      identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
      head,
      secret: false,
    }
    if (
      ((await guard.cliHomes.contains(named)) || (await guard.cliHomes.contains(real)))
      && (isCliLogin(name) || isCliLogin(basename(named)))
    )
      return { status: 'protected' }
    return { status: 'ok', file, binding: { path: named, real, dev: String(info.dev), ino: String(info.ino) } }
  } finally {
    await handle.close()
  }
}
