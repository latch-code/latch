import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { relayFilePath, relayNames, RELAY_NAME } from '@latch/link-client/relay-files'
import { parseRelayFile, RELAY_FILE_BYTES } from '@latch/protocol'
import { relayKeyHash, relayNodeFields, type RelayProfileInput } from './profiles.ts'

export type RelayFileRead = { profile: RelayProfileInput } | { failure: 'unreadable' | 'not-relay' | 'version' }

/**
 * A relay file as the self-hosted relay CLI (version 1) or the Workers setup (version 2, edge) writes it. At most
 * 4 KiB plus one byte is read, whatever the path names (a device, a pipe, a huge file).
 */
export async function loadRelayFile(path: string): Promise<RelayFileRead> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => undefined)
  if (!handle) return { failure: 'unreadable' }
  try {
    if (!(await handle.stat()).isFile()) return { failure: 'not-relay' }
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

/** What settings shows of a relay file before it is added: never the registration token or the relay's key. */
export interface RelayFileSummary {
  name: string
  kind: 'self' | 'edge'
  urls: string[]
  keyHash: string
  hasRegistrationKey: boolean
}

const MAX_FILES = 16

/**
 * The relay files in `~/.latch/relays` that could be added now: valid ones whose node is not in `known`. A missing,
 * linked or shared directory yields none, as does anything unreadable in it.
 */
export async function listRelayFiles(known: ReadonlySet<string>, home?: string): Promise<RelayFileSummary[]> {
  const names = await relayNames(home).catch((): string[] => [])
  const files: RelayFileSummary[] = []
  for (const name of names.slice(0, MAX_FILES)) {
    const read = await loadRelayFile(relayFilePath(name, home)).catch(() => undefined)
    if (!read || !('profile' in read) || known.has(read.profile.relayId)) continue
    const node = relayNodeFields(read.profile)
    files.push({
      name,
      kind: 'kind' in node ? 'edge' : 'self',
      urls: [node.url, ...('extraUrls' in node ? (node.extraUrls ?? []) : [])],
      keyHash: relayKeyHash(node),
      hasRegistrationKey: read.profile.registrationKey != null,
    })
  }
  return files
}

/** The profile in `~/.latch/relays/<name>.json`: the name is a single path component the directory really lists. */
export async function relayFileByName(name: string, home?: string): Promise<RelayProfileInput | undefined> {
  if (!RELAY_NAME.test(name)) return undefined
  if (!(await relayNames(home).catch((): string[] => [])).includes(name)) return undefined
  const read = await loadRelayFile(relayFilePath(name, home)).catch(() => undefined)
  return read && 'profile' in read ? read.profile : undefined
}
