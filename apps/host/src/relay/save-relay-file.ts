import { randomUUID } from 'node:crypto'
import { linkSync } from 'node:fs'
import { lstat, open, opendir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { canonicalJson, syncDirectory } from '@latch/core/node-kit'
import { prepareRelaysDir, RelayFilesError, relayFilePath, RELAY_NAME } from '@latch/link-client/relay-files'
import { RELAY_FILE_BYTES } from '@latch/protocol'
import { relayNodeFields, relayProfileInput, type RelayProfileInput } from './profiles.ts'
import { loadRelayFile, privateRelaysDirectory, relayAclIsPrivate, relayFileAclIsPrivate, relayHomeIsProtected } from './relay-files.ts'

const MAX_ALIASES = 64
const MAX_SCAN_ENTRIES = 512
const archives = new Map<string, Promise<void>>()

// A pending import can drop an explicit null on retry. Both forms describe the same relay without a token.
const archiveIdentity = (profile: RelayProfileInput) => canonicalJson({ ...profile, registrationKey: profile.registrationKey ?? undefined })

/** An existing file counts as an archive only when it is private and contains the same portable profile. */
async function alreadyArchived(path: string, expected: string): Promise<boolean> {
  const owner = process.getuid?.()
  if (owner === undefined) return false
  const parsed = await loadRelayFile(path, owner)
  return 'profile' in parsed && archiveIdentity(parsed.profile) === expected
}

/** Match an equivalent file under another name without walking an unbounded directory. */
async function findArchiveAlias(directory: string, names: ReadonlySet<string>, expected: string): Promise<boolean> {
  const entries = await opendir(directory)
  try {
    for (let seen = 0, checked = 0; seen < MAX_SCAN_ENTRIES && checked < MAX_ALIASES; seen++) {
      const entry = await entries.read()
      if (!entry) break
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const name = entry.name.slice(0, -5)
      if (!RELAY_NAME.test(name) || names.has(name)) continue
      checked++
      if (await alreadyArchived(join(directory, entry.name), expected)) return true
    }
    return false
  } finally {
    await entries.close()
  }
}

/** Publish only a complete, synced file. If another writer won a name, check its contents before trying the fallback. */
async function publish(temporary: string, destinations: readonly string[], expected: string, authorize?: () => void): Promise<void> {
  for (const path of destinations) {
    authorize?.()
    try {
      // Keep the last authorization check and the irreversible publication in the same turn.
      linkSync(temporary, path)
      return
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      if (await alreadyArchived(path, expected)) {
        authorize?.()
        return
      }
    }
  }
  throw new RelayFilesError('中继配置的归档名称已被其他文件占用。')
}

/** Save a portable relay file for an already accepted profile. The optional name is a basename without `.json`. */
export async function saveRelayFile(profile: RelayProfileInput, name?: string, home = homedir(), authorize?: () => void): Promise<void> {
  const { registrationKey } = profile
  const parsed = relayProfileInput.safeParse({ ...relayNodeFields(profile), ...(registrationKey === undefined ? {} : { registrationKey }) })
  if (!parsed.success) throw new RelayFilesError('这个中继配置无法归档。')
  const portable = parsed.data
  const content = `${JSON.stringify({ version: 'kind' in portable ? 2 : 1, profile: portable })}\n`
  if (Buffer.byteLength(content) > RELAY_FILE_BYTES) throw new RelayFilesError('这个中继配置无法归档。')
  const expected = archiveIdentity(portable)
  const names = new Set([...(name && RELAY_NAME.test(name) ? [name] : []), portable.relayId])
  const destinations = [...names].map(candidate => relayFilePath(candidate, home))
  const directory = dirname(relayFilePath(portable.relayId, home))

  // Serialize the alias lookup and write in this Host. `link` protects the destination across processes as well.
  const previous = archives.get(directory)
  const archive = (async () => {
    await previous?.catch(() => {})
    authorize?.()
    const owner = process.getuid?.()
    if (owner === undefined || !(await relayHomeIsProtected(home, owner))) throw new RelayFilesError('主目录的访问权限不适合归档中继配置。')
    const latchDirectory = dirname(directory)
    const parent = await lstat(latchDirectory).catch(() => undefined)
    if (parent?.isDirectory() && !(await relayAclIsPrivate(latchDirectory)))
      throw new RelayFilesError('中继配置的归档目录带有额外的访问权限。')
    await prepareRelaysDir(home)
    if (!(await privateRelaysDirectory(home, owner))) throw new RelayFilesError('中继配置的归档目录带有额外的访问权限。')
    for (const path of destinations) {
      if (await alreadyArchived(path, expected)) {
        await syncDirectory(directory)
        authorize?.()
        return
      }
    }
    if (await findArchiveAlias(directory, names, expected)) {
      await syncDirectory(directory)
      authorize?.()
      return
    }

    const temporary = join(directory, `.relay-archive-${randomUUID()}.tmp`)
    authorize?.()
    const file = await open(temporary, 'wx', 0o600)
    try {
      try {
        await file.chmod(0o600)
        authorize?.()
        if (!(await relayFileAclIsPrivate(temporary, await file.stat())))
          throw new RelayFilesError('中继配置的归档文件带有额外的访问权限。')
        authorize?.()
        await file.writeFile(content)
        await file.sync()
      } finally {
        await file.close()
      }
      if (!(await privateRelaysDirectory(home, owner))) throw new RelayFilesError('中继配置的归档目录已变化或无法访问。')
      await publish(temporary, destinations, expected, authorize)
    } finally {
      await unlink(temporary).catch(() => {})
    }
    await syncDirectory(directory)
  })()
  archives.set(directory, archive)
  try {
    await archive
  } finally {
    if (archives.get(directory) === archive) archives.delete(directory)
  }
}
