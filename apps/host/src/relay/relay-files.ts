import { execFile } from 'node:child_process'
import { constants, type Stats } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { ownedDirectory } from '@latch/link-client/private-directory'
import { existingRelaysDir, RELAY_NAME } from '@latch/link-client/relay-files'
import { parseRelayFile, RELAY_FILE_BYTES, type NativeRelayFile } from '@latch/protocol'
import { relayKeyHash, relayNodeFields, type RelayProfileInput } from './profiles.ts'

export type RelayFileRead = { profile: RelayProfileInput } | { failure: 'unreadable' | 'not-relay' | 'version' }

const run = promisify(execFile)
const HOME_ACL_READ = new Set(['list', 'search', 'readattr', 'readextattr', 'readsecurity', 'synchronize'])

/** macOS ACL grants can override mode bits. HOME may grant traversal and metadata reads without granting writes. */
export async function relayAclIsPrivate(path: string, ancestor = false): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  // Like the CLI's secret writer, inspect ACL entries, not the '+' marker, which can be hidden by extended attributes.
  // `-b` escapes filenames so a path with a newline cannot add an entry to the listing.
  const listing = await run('/bin/ls', ['-bled', '--', path], { env: { LC_ALL: 'C' }, timeout: 2000, maxBuffer: 32 * 1024 }).catch(
    () => undefined,
  )
  if (!listing?.stdout.trim()) return false
  return listing.stdout
    .split('\n')
    .slice(1)
    .filter(line => line.trim())
    .every(line => {
      const entry = /^\s*\d+: .+ (allow|deny) ([a-z_,]+)$/u.exec(line)
      return entry?.[1] === 'deny' || (ancestor && entry?.[2] !== undefined && entry[2].split(',').every(right => HOME_ACL_READ.has(right)))
    })
}

/** The ACL listing must describe the ordinary file we opened, not a replacement at its pathname. */
export async function relayFileAclIsPrivate(path: string, opened: Pick<Stats, 'dev' | 'ino'>): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  if (!(await relayAclIsPrivate(path))) return false
  const current = await lstat(path).catch(() => undefined)
  return current?.isFile() === true && current.dev === opened.dev && current.ino === opened.ino
}

/** Bind a listed file to the public node fields without hashing its registration credential. */
export function relayFileIdentity(profile: RelayProfileInput): string {
  return sha256Hex(canonicalJson(relayNodeFields(profile)))
}

/**
 * A relay file as the self-hosted relay CLI (version 1) or the Workers setup (version 2, edge) writes it. At most
 * 4 KiB plus one byte is read, whatever the path names (a device, a pipe, a huge file).
 */
export async function loadRelayFile(path: string, privateOwner?: number): Promise<RelayFileRead> {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (privateOwner === undefined ? 0 : constants.O_NOFOLLOW)
  const handle = await open(path, flags).catch(() => undefined)
  if (!handle) return { failure: 'unreadable' }
  try {
    const info = await handle.stat()
    if (!info.isFile()) return { failure: 'not-relay' }
    if (
      privateOwner !== undefined
      && (info.uid !== privateOwner
        || (info.mode & 0o077) !== 0
        || info.size > RELAY_FILE_BYTES
        || !(await relayFileAclIsPrivate(path, info)))
    )
      return { failure: 'unreadable' }
    const buffer = Buffer.alloc(RELAY_FILE_BYTES + 1)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used)
      if (bytesRead === 0) break
      used += bytesRead
    }
    if (used > RELAY_FILE_BYTES) return { failure: 'not-relay' }
    return parseRelayFile(new TextDecoder().decode(buffer.subarray(0, used)), URL)
  } catch {
    return { failure: 'unreadable' }
  } finally {
    await handle.close().catch(() => {})
  }
}

type RelayFileSource = NativeRelayFile['source']
const MAX_FILES = 16
const MAX_SCAN_ENTRIES = 512
const MAX_CANDIDATES = 32
const LEGACY_PREFIX = 'latch-relay-'

export async function relayHomeIsProtected(home: string, owner: number): Promise<boolean> {
  return isAbsolute(home) && (await ownedDirectory(home, owner, 0o022)) && (await relayAclIsPrivate(home, true))
}

export async function privateRelaysDirectory(home: string, owner: number): Promise<string | undefined> {
  if (!(await relayHomeIsProtected(home, owner))) return undefined
  const directory = await existingRelaysDir(home)
  return directory && (await relayAclIsPrivate(dirname(directory))) && (await relayAclIsPrivate(directory)) ? directory : undefined
}

async function sourceDirectory(home: string, source: RelayFileSource, owner: number): Promise<string | undefined> {
  if (source === 'legacy') return (await relayHomeIsProtected(home, owner)) ? home : undefined
  return privateRelaysDirectory(home, owner)
}

async function candidateNames(directory: string, prefix: string): Promise<string[]> {
  const handle = await opendir(directory).catch(() => undefined)
  if (!handle) return []
  try {
    const names: string[] = []
    for (let checked = 0; checked < MAX_SCAN_ENTRIES; checked++) {
      const entry = await handle.read()
      if (!entry) break
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.json')) continue
      const name = entry.name.slice(prefix.length, -5)
      if (RELAY_NAME.test(name)) names.push(name)
    }
    return names.toSorted().slice(0, MAX_CANDIDATES)
  } catch {
    return []
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Inspect the standard directory first so a legacy copy of the same node is omitted. A scan creates no state and does
 * not contact any node.
 */
export async function listRelayFiles(known: ReadonlySet<string>, home = homedir()): Promise<NativeRelayFile[]> {
  const owner = process.getuid?.()
  if (owner === undefined) return []
  const seen = new Set(known)
  const files: NativeRelayFile[] = []
  for (const source of [undefined, 'legacy'] as const) {
    const directory = await sourceDirectory(home, source, owner).catch(() => undefined)
    if (!directory) continue
    const prefix = source === 'legacy' ? LEGACY_PREFIX : ''
    for (const name of await candidateNames(directory, prefix)) {
      const read = await loadRelayFile(join(directory, `${prefix}${name}.json`), owner)
      if (!('profile' in read) || seen.has(read.profile.relayId)) continue
      const node = relayNodeFields(read.profile)
      seen.add(node.relayId)
      files.push({
        name,
        relayId: node.relayId,
        fileIdentity: relayFileIdentity(node),
        ...(source === undefined ? {} : { source }),
        kind: 'kind' in node ? 'edge' : 'self',
        urls: [node.url, ...('extraUrls' in node ? (node.extraUrls ?? []) : [])],
        keyHash: relayKeyHash(node),
        hasRegistrationKey: read.profile.registrationKey != null,
      })
      if (files.length === MAX_FILES) return files
    }
  }
  return files
}

/** A single named file, rechecked on its open handle even if it was safe when listed. */
export async function relayFileByName(name: string, home = homedir(), source?: RelayFileSource): Promise<RelayProfileInput | undefined> {
  const owner = process.getuid?.()
  if (owner === undefined || !RELAY_NAME.test(name)) return undefined
  const directory = await sourceDirectory(home, source, owner).catch(() => undefined)
  if (!directory) return undefined
  const file = source === 'legacy' ? `${LEGACY_PREFIX}${name}.json` : `${name}.json`
  const read = await loadRelayFile(join(directory, file), owner)
  return 'profile' in read ? read.profile : undefined
}
