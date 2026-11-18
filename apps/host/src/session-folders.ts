import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { AppError } from '@latch/sdk'
import { sha256Hex, writeFileAtomic } from '@latch/core/node-kit'
import { z } from 'zod'
import { codeOf } from './http-util.ts'
import { canonicalPath } from './paths.ts'

/**
 * Folders of their own for Agent sessions outside a saved project, while the Host uses its default start directory:
 * `<start directory>/<yyyymmdd>-<4 hex>`, made 0700 when the session starts and never an entry that already exists.
 * Each is a directory directly inside the start directory, which every session there could already use, so listing it
 * for the drivers grants nothing new. Latch never removes one that a session was created in; deleting the session
 * keeps its folder and the files in it.
 */

export const SESSION_FOLDER_NAME = /^\d{8}-[0-9a-f]{4}$/u
const OWNER = 'general|agt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const HELPER_OWNER = new RegExp(`^(?:${OWNER})$`, 'u')
/**
 * A home's directory: the owner's ID, or the ID with this data directory's tag (`-<8 hex>`) when, at the home's first
 * allocation under a start directory, an entry this Host never recorded already has the plain name (another Latch data
 * directory using the same start directory). Two Hosts never share a home.
 */
const HELPER_DIRECTORY = new RegExp(`^(?:${OWNER})(?:-[0-9a-f]{8})?$`, 'u')
export const HELPER_HOME_NAME = new RegExp(`^helpers/(?:${OWNER})(?:-[0-9a-f]{8})?$`, 'u')
/** Whether `home` (`helpers/<directory>`) can be `owner`'s: its ID, alone or with a data directory's tag. */
export function homeBelongsTo(home: string, owner: string): boolean {
  const plain = `helpers/${owner}`
  return HELPER_HOME_NAME.test(home) && (home === plain || (home.startsWith(plain) && /^-[0-9a-f]{8}$/u.test(home.slice(plain.length))))
}
const TAG = /^[0-9a-f]{8}$/u
const directoryIdentitySchema = z.strictObject({ dev: z.string().regex(/^\d+$/u), ino: z.string().regex(/^\d+$/u) })
const rootHashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
/** The earlier layout's record: one home per owner, under the start directory `rootHash` names, at the plain name. */
const legacyHelperSchema = z.strictObject({
  rootHash: rootHashSchema,
  root: directoryIdentitySchema,
  parent: directoryIdentitySchema,
  directory: directoryIdentitySchema,
})
export const helperIdentitySchema = z.strictObject({
  root: directoryIdentitySchema,
  parent: directoryIdentitySchema,
  directory: directoryIdentitySchema,
  /** The directory's name when it is not the owner's ID (a tagged home). */
  name: z.string().regex(HELPER_DIRECTORY).optional(),
})
type Identity = z.infer<typeof directoryIdentitySchema>
type HelperIdentity = z.infer<typeof helperIdentitySchema>
type HelperFolder = HelperIdentity & { rootHash: string }

async function directoryIdentity(path: string): Promise<Identity> {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) throw helperUnavailable()
  return { dev: String(info.dev), ino: String(info.ino) }
}

/**
 * The start directory's identity. It may be a link the owner chose (`--workspace`); the canonical path is checked
 * separately, so following it here only lets such a start directory be pinned at all.
 */
async function rootIdentityOf(path: string): Promise<Identity> {
  const info = await stat(path, { bigint: true })
  if (!info.isDirectory()) throw helperUnavailable()
  return { dev: String(info.dev), ino: String(info.ino) }
}

/** Whether something is at `path` (without following a link), nothing is, or it cannot be told. */
async function entryState(path: string): Promise<'absent' | 'present' | 'error'> {
  try {
    await lstat(path)
    return 'present'
  } catch (error) {
    return codeOf(error) === 'ENOENT' ? 'absent' : 'error'
  }
}

const sameDirectory = (left: Identity, right: Identity) => left.dev === right.dev && left.ino === right.ino

/**
 * A new private directory at `path`, made by this call: `mkdir` without `recursive` (an entry that is there, whatever it
 * is, is refused), then everything else through the directory it opened without following a link. The opened directory
 * must be the entry at the path before and after, a directory owned by this user and empty; its mode is set on the
 * handle, never by path. On any mismatch it is refused and nothing is removed: the entry may not be the one made here.
 */
async function makePrivateDirectory(path: string): Promise<Identity> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch {
    throw helperUnavailable()
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(() => {
    throw helperUnavailable()
  })
  try {
    const opened = await handle.stat({ bigint: true })
    const identity = { dev: String(opened.dev), ino: String(opened.ino) }
    const atPath = async () => sameDirectory(identity, await directoryIdentity(path).catch(() => ({ dev: '-', ino: '-' })))
    if (!opened.isDirectory() || (process.getuid !== undefined && opened.uid !== BigInt(process.getuid())) || !(await atPath()))
      throw helperUnavailable()
    if ((await readdir(path).catch(() => ['?'])).length || !(await atPath())) throw helperUnavailable()
    await handle.chmod(0o700)
    const set = await handle.stat({ bigint: true })
    if ((Number(set.mode) & 0o777) !== 0o700 || !(await atPath())) throw helperUnavailable()
    return identity
  } finally {
    await handle.close()
  }
}

/** The largest record file read: far beyond any real one, so a huge file is refused rather than read. */
const RECORD_MAXIMUM = 4 * 1024 * 1024

/** The record file as `agent-journal.ts` reads its own: not through a link, a single-link regular 0600 file of this user. */
async function readPrivateRecord(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (
      !info.isFile()
      || info.nlink !== 1
      || info.mode & 0o077
      || info.size > RECORD_MAXIMUM
      || (process.getuid !== undefined && info.uid !== process.getuid())
    )
      throw new Error('Private record')
    // Read no more than the cap, whatever the file grew to after the check.
    const buffer = Buffer.alloc(RECORD_MAXIMUM + 1)
    let count = 0
    while (count < buffer.length) {
      const read = await file.read(buffer, count, buffer.length - count, null)
      if (!read.bytesRead) break
      count += read.bytesRead
    }
    if (count > RECORD_MAXIMUM) throw new Error('Private record budget')
    return buffer.subarray(0, count).toString('utf8')
  } finally {
    await file.close()
  }
}

/** How long a folder made for a start that has not created its session yet (one that may be retried under its request ID) is kept. */
const PENDING_TTL_MS = 10 * 60_000
/** The in-memory cache lifetime; started requests retain their durable mapping. */
const CREATED_TTL_MS = 60 * 60_000
const REQUEST_LIMIT = 512
const ATTEMPTS = 16
const RECORD_FILE = 'session-folders.json'
const storedFolderSchema = z.object({ name: z.string().regex(SESSION_FOLDER_NAME), rootHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
const recordsSchema = z
  .object({
    version: z.literal(1),
    folders: z.record(z.string().regex(/^[a-f0-9]{64}$/u), storedFolderSchema),
    /** Before homes were kept per start directory: one per owner, under the start directory its `rootHash` names. */
    helpers: z.record(z.string().regex(HELPER_OWNER), legacyHelperSchema).optional(),
    /**
     * Each home by the start directory it was made under (its canonical path's hash), then by owner: a Host started with
     * another start directory makes its own homes there and still knows the ones it made before.
     */
    homes: z.record(rootHashSchema, z.record(z.string().regex(HELPER_OWNER), helperIdentitySchema)).optional(),
    /** This data directory's tag for a home whose plain name another Host already has: random, made once, kept. */
    tag: z.string().regex(TAG).optional(),
  })
  .strict()

/** The folder's name: the Host's local date and four hex characters. */
export function sessionFolderName(at: Date, suffix: string): string {
  const pad = (value: number, width: number) => String(value).padStart(width, '0')
  return `${pad(at.getFullYear(), 4)}${pad(at.getMonth() + 1, 2)}${pad(at.getDate(), 2)}-${suffix}`
}

function unavailable(): AppError {
  return new AppError(409, 'session-folder-unavailable', '没能在默认文件夹中为这个会话新建文件夹，会话没有开始。请重试。')
}
const helperUnavailable = () =>
  new AppError(409, 'helper-home-unavailable', 'Agent 的家无法确认，原文件已保留；请在这台 Mac 上检查工作文件夹。')

/** What the allocator would do with an Agent's home now, without touching the disk beyond reading it. */
export type HelperHomeState = 'ready' | 'absent' | 'refused'

/** What a home request may make, and what it records first. */
export interface HelperHomeOptions {
  /**
   * Opt-in: a home recorded under this start directory with nothing at its path now may be made again, new and empty,
   * at the same path. Without it such a home is refused.
   */
  recreate?: boolean
  /**
   * Called after every check and immediately before anything is created (the `helpers` folder or the home); when it
   * throws (its audit could not be written), nothing is created. `recreated`: a home recorded under this start directory
   * is made again; otherwise this is its first allocation here. Never called for an entry that exists.
   */
  beforeCreate?: (made: { name: string; recreated: boolean }) => Promise<void>
}

interface RequestFolder {
  at: number
  /** Settles once the folder exists; a failed make leaves the map. */
  made: Promise<{ name: string; path: string }>
  path?: string
  created: boolean
  /** A driver is creating the session in it now; it never expires meanwhile. */
  starting?: boolean
}

export interface SessionFolderOptions {
  /** Private data directory for durable request-to-folder mappings. */
  dataDir?: string
  /** The start directory as the Host was given it. */
  root: string
  /** Its `canonicalPath` at startup: a folder is made only while the start directory is still there. */
  canonicalRoot: string
  /** The date in the name. */
  clock: () => number
  /** Expiry of requests' folders. */
  now: () => number
  /** Tests: the four hex characters; default random. */
  suffix?: () => string
  log: (text: string) => void
}

export class SessionFolders {
  /** By request ID: a retried request gets the same folder. */
  private readonly requests = new Map<string, RequestFolder>()
  /** Folders sessions were created in during this run, listed even when the session metadata could not be written. */
  private readonly made = new Set<string>()
  private recorded = new Map<string, z.infer<typeof storedFolderSchema>>()
  /** Homes by `rootHash`, then owner. Only the current start directory's are ever used; the others are kept as they are. */
  private homes = new Map<string, Map<string, HelperIdentity>>()
  private tag?: string
  private readonly makingHelpers = new Map<string, Promise<{ name: string; path: string }>>()
  /** A failed durable write can retry the directory this process made, without adopting an unrelated existing entry. */
  private readonly unrecordedHelpers = new Map<string, HelperFolder>()
  /** The `helpers` folder this process made under the current start directory, before any home in it is recorded. */
  private madeParent?: Identity
  private loading?: Promise<void>
  /**
   * The start directory homes are made in: pinned when first seen, so a start directory replaced by another at the same
   * path is refused. Seen at startup, or (when it was not there then) when an allocation finds or creates it.
   */
  private rootIdentity?: Identity
  private writes = Promise.resolve()

  private get rootHash(): string {
    return sha256Hex(this.options.canonicalRoot)
  }

  /** The home this allocator recorded for `owner` under the current start directory, the newest made first. */
  private savedHelper(owner: string): HelperFolder | undefined {
    const unrecorded = this.unrecordedHelpers.get(owner)
    if (unrecorded) return unrecorded
    const saved = this.homes.get(this.rootHash)?.get(owner)
    return saved ? { rootHash: this.rootHash, ...saved } : undefined
  }

  /** Under the current start directory: owner → its home's directory name, recorded or being recorded. */
  private currentHomes(): Map<string, string> {
    const homes = new Map<string, string>()
    for (const [owner, home] of this.homes.get(this.rootHash) ?? []) homes.set(owner, home.name ?? owner)
    for (const [owner, home] of this.unrecordedHelpers) homes.set(owner, home.name ?? owner)
    return homes
  }

  /** Relative homes reserved by this allocator, including an allocation whose durable write is still pending. */
  helperNames(): string[] {
    return [...this.currentHomes().values()].map(name => `helpers/${name}`)
  }

  /**
   * Where `owner`'s home is or will be under the current start directory, reading only: its recorded home; before the
   * first allocation the plain name when nothing has it, else this data directory's tagged name once its tag exists.
   * Undefined when the plain name is taken and no tag was made yet (it is made with the home).
   */
  async plannedHome(owner: string): Promise<{ name: string; path: string } | undefined> {
    await this.start()
    if (this.currentHomes().has(owner)) return this.homeOf(owner)
    const plain = this.homeOf(owner)
    if ((await entryState(plain.path)) === 'absent') return plain
    if (!this.tag) return undefined
    const directory = `${owner}-${this.tag}`
    return { name: `helpers/${directory}`, path: join(this.options.root, 'helpers', directory) }
  }

  /** `owner`'s home under the current start directory, as recorded; the plain name before its first allocation. */
  homeOf(owner: string): { name: string; path: string } {
    const directory = this.currentHomes().get(owner) ?? owner
    return { name: `helpers/${directory}`, path: join(this.options.root, 'helpers', directory) }
  }

  private recordText(folders: Map<string, z.infer<typeof storedFolderSchema>>, homes: SessionFolders['homes'], tag = this.tag): string {
    const stored = Object.fromEntries([...homes].map(([hash, owners]) => [hash, Object.fromEntries(owners)]))
    return `${JSON.stringify({ version: 1, folders: Object.fromEntries(folders), homes: stored, ...(tag ? { tag } : {}) })}\n`
  }

  constructor(private readonly options: SessionFolderOptions) {}

  start(): Promise<void> {
    return (this.loading ??= (async () => {
      this.rootIdentity = await rootIdentityOf(this.options.root).catch(() => undefined)
      if (!this.options.dataDir) return
      let text: string
      try {
        text = await readPrivateRecord(join(this.options.dataDir, RECORD_FILE))
      } catch (error) {
        if (codeOf(error) === 'ENOENT') return
        throw new AppError(500, 'config-corrupt', '会话文件夹的请求记录无法读取，原文件已保留。')
      }
      try {
        const record = recordsSchema.parse(JSON.parse(text))
        this.recorded = new Map(Object.entries(record.folders))
        this.homes = new Map(Object.entries(record.homes ?? {}).map(([hash, owners]) => [hash, new Map(Object.entries(owners))]))
        this.tag = record.tag
        // The earlier layout: each owner's one home, at its plain name, filed under the start directory it names (a
        // record in the newer layout wins).
        for (const [owner, { rootHash, ...identity }] of Object.entries(record.helpers ?? {})) {
          const owners = this.homes.get(rootHash) ?? new Map<string, HelperIdentity>()
          if (!owners.has(owner)) owners.set(owner, identity)
          this.homes.set(rootHash, owners)
        }
      } catch {
        throw new AppError(500, 'config-corrupt', '会话文件夹的请求记录无法读取，原文件已保留。')
      }
    })())
  }

  /**
   * The start directory as it may be used now. As for a session's own folder (`make`), a missing start directory is
   * created (0700) and must resolve to the canonical path the Host started with. Homes also pin its identity: the one
   * seen at startup, or, when there was none then or this allocator just created it, the one there now. A start
   * directory replaced by another at the same path while pinned is refused.
   */
  private async prepareRoot(): Promise<'ok' | 'moved' | 'failed'> {
    const { root, canonicalRoot } = this.options
    let made: string | undefined
    try {
      made = await mkdir(root, { recursive: true, mode: 0o700 })
    } catch (error) {
      this.options.log(`默认文件夹无法创建（${codeOf(error) ?? 'error'}）。`)
      return 'failed'
    }
    if ((await canonicalPath(root).catch(() => undefined)) !== canonicalRoot) return 'moved'
    if (made !== undefined || this.rootIdentity === undefined) this.rootIdentity = await rootIdentityOf(root).catch(() => undefined)
    return 'ok'
  }

  /** Whether the start directory is there, at its canonical path, and the pinned one. Reads only. */
  private async rootPinned(): Promise<boolean> {
    if (!this.rootIdentity) return false
    if ((await canonicalPath(this.options.root).catch(() => undefined)) !== this.options.canonicalRoot) return false
    const current = await rootIdentityOf(this.options.root).catch(() => undefined)
    return current !== undefined && sameDirectory(this.rootIdentity, current)
  }

  /**
   * The `helpers` folders this allocator knows under the current start directory: the ones its recorded homes are in,
   * and one it made in this run. Once any is known, an existing `helpers` must be one of them: a replaced folder is never
   * adopted. Before any is known (a start directory's first home) an existing private `helpers` of this user is used,
   * since another Latch data directory on the same start directory makes it too; the home in it is still new. The same
   * holds when none of the homes this data directory recorded under this start directory is there any more (another
   * Host deleted and made `helpers` again): nothing of this Host's can have been swapped in, and each home is new.
   */
  private knownParents(): Identity[] {
    const parents = [...(this.homes.get(this.rootHash)?.values() ?? []), ...this.unrecordedHelpers.values()].map(home => home.parent)
    return this.madeParent ? [...parents, this.madeParent] : parents
  }

  private async parentUsable(): Promise<boolean> {
    if (!(await this.helperParent())) return false
    const known = this.knownParents()
    if (!known.length) return true
    const current = await directoryIdentity(join(this.options.root, 'helpers')).catch(() => undefined)
    if (current !== undefined && known.some(parent => sameDirectory(parent, current))) return true
    if (this.unrecordedHelpers.size) return false
    for (const name of this.currentHomes().values())
      if ((await entryState(join(this.options.root, 'helpers', name))) !== 'absent') return false
    return true
  }

  /**
   * A fixed home for an Agent, independent of the requests and topics that use it. The Host supplies the current policy.
   * Under each start directory the home is made once and then only verified (`verifyHelper`). The one exception, opted
   * into by `options.recreate`: a home recorded under this start directory with nothing at its path now is made again,
   * new and empty, at the same path. An entry that is there is never adopted, whatever it is: a replaced directory, a
   * link, a wider mode or an unknown directory stays as it is. At a first allocation an unknown entry with the plain name
   * gets this data directory's tagged home beside it; a recorded home that was replaced is refused.
   */
  async helperHome(
    owner: string,
    guard: (path: string) => Promise<void>,
    options: HelperHomeOptions = {},
  ): Promise<{ name: string; path: string }> {
    if (!HELPER_OWNER.test(owner)) throw helperUnavailable()
    await this.start()
    if ((await this.prepareRoot()) !== 'ok' || !(await this.rootPinned())) throw helperUnavailable()
    let making = this.makingHelpers.get(owner)
    if (!making) {
      making = this.allocateHelper(owner, guard, options)
      this.makingHelpers.set(owner, making)
    }
    try {
      const made = await making
      await guard(made.path)
      if (!(await this.verifyHelper(made.path))) throw helperUnavailable()
      return made
    } finally {
      if (this.makingHelpers.get(owner) === making) this.makingHelpers.delete(owner)
    }
  }

  private async allocateHelper(
    owner: string,
    guard: (path: string) => Promise<void>,
    options: HelperHomeOptions,
  ): Promise<{ name: string; path: string }> {
    if (this.unrecordedHelpers.has(owner)) {
      const folder = this.homeOf(owner)
      await guard(folder.path)
      return this.makeHelper(owner, folder.name.slice('helpers/'.length), guard, false, undefined)
    }
    const recorded = this.homes.get(this.rootHash)?.get(owner)
    if (recorded) {
      const folder = this.homeOf(owner)
      await guard(folder.path)
      if (await this.verifyHelper(folder.path)) return folder
      if (!options.recreate || (await entryState(folder.path)) !== 'absent') throw helperUnavailable()
      return this.makeHelper(owner, recorded.name ?? owner, guard, true, options.beforeCreate)
    }
    // A first allocation under this start directory: the plain name, unless something this Host never recorded has it.
    const plain = join(this.options.root, 'helpers', owner)
    await guard(plain)
    const taken = await entryState(plain)
    if (taken === 'error') throw helperUnavailable()
    const directory = taken === 'absent' ? owner : `${owner}-${await this.dataTag()}`
    return this.makeHelper(owner, directory, guard, false, options.beforeCreate)
  }

  /** This data directory's tag, made once (random) and recorded before any directory is named after it. */
  private async dataTag(): Promise<string> {
    if (this.tag) return this.tag
    const write = this.writes.then(async () => {
      if (this.tag) return
      const tag = randomBytes(4).toString('hex')
      if (this.options.dataDir)
        await writeFileAtomic(join(this.options.dataDir, RECORD_FILE), this.recordText(this.recorded, this.homes, tag))
      this.tag = tag
    })
    this.writes = write.catch(() => {})
    await write
    return this.tag!
  }

  /**
   * What a home request would find for `owner` now, reading only: its recorded home (`ready`), nothing at its path in a
   * usable start directory (`absent`: the next allocation makes it), or an entry or start directory it refuses.
   */
  async helperState(owner: string): Promise<HelperHomeState> {
    if (!HELPER_OWNER.test(owner)) return 'refused'
    await this.start()
    const folder = this.homeOf(owner)
    if (await this.verifyHelper(folder.path)) return 'ready'
    if (this.unrecordedHelpers.has(owner)) return 'refused'
    const root = await entryState(this.options.root)
    if (root === 'absent') return 'absent'
    if (!(await this.rootPinned()) && this.rootIdentity !== undefined) return 'refused'
    if ((await canonicalPath(this.options.root).catch(() => undefined)) !== this.options.canonicalRoot) return 'refused'
    const parent = await entryState(join(this.options.root, 'helpers'))
    if (parent === 'absent') return 'absent'
    if (parent !== 'present' || !(await this.parentUsable())) return 'refused'
    const entry = await entryState(folder.path)
    if (entry === 'absent') return 'absent'
    if (entry === 'error' || this.homes.get(this.rootHash)?.has(owner)) return 'refused'
    // The plain name is someone else's: a first allocation uses this data directory's tagged name.
    const tagged = this.tag ? await entryState(join(this.options.root, 'helpers', `${owner}-${this.tag}`)) : 'absent'
    return tagged === 'absent' ? 'absent' : 'refused'
  }

  private async makeHelper(
    owner: string,
    directory: string,
    guard: (path: string) => Promise<void>,
    recreated: boolean,
    beforeCreate: HelperHomeOptions['beforeCreate'],
  ) {
    const { root, canonicalRoot } = this.options
    const folder = { name: `helpers/${directory}`, path: join(root, 'helpers', directory) }
    if (!HELPER_DIRECTORY.test(directory)) throw helperUnavailable()
    if ((await canonicalPath(root).catch(() => undefined)) !== canonicalRoot) throw helperUnavailable()
    if (!(await this.rootPinned())) throw helperUnavailable()
    if (!this.unrecordedHelpers.has(owner)) {
      const parent = join(root, 'helpers')
      const parentState = await entryState(parent)
      if (parentState === 'error' || (parentState === 'present' && !(await this.parentUsable()))) throw helperUnavailable()
      // An unknown entry is never adopted, even if it is empty and named after this Agent.
      if ((await entryState(folder.path)) !== 'absent') throw helperUnavailable()
      await guard(folder.path)
      // Recorded before anything is created: if it cannot be, nothing is.
      await beforeCreate?.({ name: folder.name, recreated })
      let parentIdentity: Identity
      if (parentState === 'absent') {
        try {
          parentIdentity = await makePrivateDirectory(parent)
          this.madeParent = parentIdentity
        } catch {
          // Another allocation in this run may have made it meanwhile: only a known one is used.
          if (!(await this.parentUsable())) throw helperUnavailable()
          parentIdentity = await directoryIdentity(parent)
        }
      } else parentIdentity = await directoryIdentity(parent)
      if (!(await this.helperParent())) throw helperUnavailable()
      await guard(folder.path)
      const made = await makePrivateDirectory(folder.path)
      if (!sameDirectory(parentIdentity, await directoryIdentity(parent))) throw helperUnavailable()
      this.unrecordedHelpers.set(owner, {
        rootHash: sha256Hex(canonicalRoot),
        root: await rootIdentityOf(root),
        parent: parentIdentity,
        directory: made,
        ...(directory === owner ? {} : { name: directory }),
      })
    }
    if (!(await this.verifyHelper(folder.path))) throw helperUnavailable()
    await guard(folder.path)
    const write = this.writes.then(async () => {
      const made = this.unrecordedHelpers.get(owner)
      if (!made || !(await this.verifyHelper(folder.path))) throw helperUnavailable()
      const { rootHash, ...identity } = made
      const next = new Map([...this.homes].map(([hash, owners]) => [hash, new Map(owners)]))
      next.set(rootHash, (next.get(rootHash) ?? new Map<string, HelperIdentity>()).set(owner, identity))
      if (this.options.dataDir) await writeFileAtomic(join(this.options.dataDir, RECORD_FILE), this.recordText(this.recorded, next))
      this.homes = next
      this.unrecordedHelpers.delete(owner)
    })
    this.writes = write.catch(() => {})
    await write
    return folder
  }

  private async helperParent(): Promise<boolean> {
    try {
      const parent = join(this.options.root, 'helpers')
      const info = await lstat(parent)
      return (
        info.isDirectory()
        && !info.isSymbolicLink()
        && !(info.mode & 0o077)
        && (process.getuid === undefined || info.uid === process.getuid())
        && (await canonicalPath(parent)) === join(this.options.canonicalRoot, 'helpers')
      )
    } catch {
      return false
    }
  }

  /** Whether `path` is, now, the home this allocator recorded under the current start directory, by its directory name. */
  private async verifyHelper(path: string): Promise<boolean> {
    const directory = basename(path)
    if (!HELPER_DIRECTORY.test(directory)) return false
    const owner = [...this.currentHomes()].find(([, name]) => name === directory)?.[0]
    const saved = owner === undefined ? undefined : this.savedHelper(owner)
    if (!saved || saved.rootHash !== this.rootHash) return false
    try {
      const info = await lstat(path)
      return (
        info.isDirectory()
        && !info.isSymbolicLink()
        && !(info.mode & 0o077)
        && (process.getuid === undefined || info.uid === process.getuid())
        && (await this.rootPinned())
        && sameDirectory(saved.root, await rootIdentityOf(this.options.root))
        && sameDirectory(saved.parent, await directoryIdentity(join(this.options.root, 'helpers')))
        && sameDirectory(saved.directory, await directoryIdentity(path))
        && (await this.helperParent())
        && (await canonicalPath(path)) === join(this.options.canonicalRoot, 'helpers', directory)
      )
    } catch {
      return false
    }
  }

  /** The folder for a start request: made on the first ask, the same one for a retry with the same request ID. */
  async allocate(requestId: string): Promise<{ name: string; path: string }> {
    await this.start()
    // Expired requests leave the map before the lookup, which no await separates from the insertion below.
    const stale = this.expire()
    const removing = Promise.all(stale.map(path => rmdir(path).catch(() => {})))
    const known = this.requests.get(requestId)
    if (known) {
      await removing
      return known.made
    }
    const recorded = this.recorded.get(sha256Hex(requestId))
    if (recorded) {
      if (recorded.rootHash !== sha256Hex(this.options.canonicalRoot)) throw unavailable()
      const folder = { name: recorded.name, path: join(this.options.root, recorded.name) }
      await removing
      if (!(await this.verify(folder.path))) throw unavailable()
      this.made.add(folder.path)
      this.requests.set(requestId, { at: this.options.now(), made: Promise.resolve(folder), path: folder.path, created: true })
      return folder
    }
    const entry: RequestFolder = { at: this.options.now(), made: removing.then(() => this.make()), created: false }
    this.requests.set(requestId, entry)
    try {
      const folder = await entry.made
      entry.path = folder.path
      return folder
    } catch (error) {
      if (this.requests.get(requestId) === entry) this.requests.delete(requestId)
      throw error
    }
  }

  /** A driver is about to create the session in the request's folder. */
  async starting(requestId: string): Promise<void> {
    await this.start()
    const entry = this.requests.get(requestId)
    if (!entry?.path) throw unavailable()
    entry.starting = true
    const hash = sha256Hex(requestId)
    const name = basename(entry.path)
    const write = this.writes.then(async () => {
      if (this.recorded.has(hash)) return
      const next = new Map(this.recorded)
      next.set(hash, { name, rootHash: sha256Hex(this.options.canonicalRoot) })
      if (this.options.dataDir) await writeFileAtomic(join(this.options.dataDir, RECORD_FILE), this.recordText(next, this.homes))
      this.recorded = next
    })
    this.writes = write.catch(() => {})
    try {
      await write
    } catch (error) {
      entry.starting = false
      throw error
    }
  }

  /** The session was created in the request's folder: it stays, whatever happens to the request later. */
  created(requestId: string): void {
    const entry = this.requests.get(requestId)
    if (!entry?.path) return
    entry.starting = false
    entry.created = true
    entry.at = this.options.now()
    this.made.add(entry.path)
  }

  /** The start failed before any session was created in the request's folder: the folder goes if it is still empty. */
  async release(requestId: string, definitive = false): Promise<void> {
    const entry = this.requests.get(requestId)
    if (!entry || entry.created) return
    const hash = sha256Hex(requestId)
    if (this.recorded.has(hash)) {
      if (!definitive) {
        entry.starting = false
        entry.at = this.options.now()
        return
      }
      const write = this.writes.then(async () => {
        const next = new Map(this.recorded)
        next.delete(hash)
        if (this.options.dataDir) await writeFileAtomic(join(this.options.dataDir, RECORD_FILE), this.recordText(next, this.homes))
        this.recorded = next
      })
      this.writes = write.catch(() => {})
      await write
    }
    this.requests.delete(requestId)
    if (entry.path) await rmdir(entry.path).catch(() => {})
  }

  /** Directories a driver may accept as a new or existing session's `cwd`: the ones made here and those `recorded`. */
  paths(recorded: Iterable<string>): string[] {
    const paths = new Set<string>(this.made)
    for (const name of this.helperNames()) paths.add(join(this.options.root, name))
    for (const folder of this.recorded.values())
      if (folder.rootHash === sha256Hex(this.options.canonicalRoot)) paths.add(join(this.options.root, folder.name))
    for (const entry of this.requests.values()) if (entry.path) paths.add(entry.path)
    for (const name of recorded) if (SESSION_FOLDER_NAME.test(name)) paths.add(join(this.options.root, name))
    return [...paths]
  }

  /**
   * Whether `path` is, now, a session folder: named like one, a real directory (not a link) and directly inside the
   * start directory. A folder replaced by a link to somewhere else no longer counts.
   */
  async verify(path: string | undefined): Promise<boolean> {
    if (typeof path === 'string' && basename(dirname(path)) === 'helpers') return this.verifyHelper(path)
    if (typeof path !== 'string' || !SESSION_FOLDER_NAME.test(basename(path))) return false
    try {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) return false
      return (await canonicalPath(dirname(await realpath(path)))) === this.options.canonicalRoot
    } catch {
      return false
    }
  }

  private async make(): Promise<{ name: string; path: string }> {
    const { root } = this.options
    // The default start directory is created on demand, as at startup.
    const prepared = await this.prepareRoot()
    if (prepared === 'failed') throw unavailable()
    if (prepared === 'moved')
      throw new AppError(409, 'session-folder-unavailable', '默认文件夹已不在 Host 启动时的位置，没有为会话新建文件夹。请重启 Host。')
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const suffix = this.options.suffix?.() ?? randomBytes(2).toString('hex')
      const name = sessionFolderName(new Date(this.options.clock()), suffix)
      if (!SESSION_FOLDER_NAME.test(name)) throw unavailable()
      const path = join(root, name)
      try {
        // Without `recursive`: an entry of that name, whatever it is, is never reused.
        await mkdir(path, { mode: 0o700 })
      } catch (error) {
        if (codeOf(error) === 'EEXIST') continue
        this.options.log(`会话文件夹无法创建（${codeOf(error) ?? 'error'}）。`)
        throw unavailable()
      }
      // Exactly 0700 whatever the umask, on the directory just made: opened without following a link.
      const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        await handle.chmod(0o700)
      } finally {
        await handle.close()
      }
      return { name, path }
    }
    this.options.log('默认文件夹中的会话文件夹名称连续重复，没有为会话新建文件夹。')
    throw unavailable()
  }

  /**
   * Drops expired requests, oldest first while there are too many. Returns the folders of those no session was
   * created in, for the caller to remove if they are still empty.
   */
  private expire(): string[] {
    const now = this.options.now()
    const stale: string[] = []
    for (const [id, entry] of this.requests) {
      if (!entry.path || entry.starting) continue
      const expired = now - entry.at > (entry.created ? CREATED_TTL_MS : PENDING_TTL_MS)
      if (expired || this.requests.size > REQUEST_LIMIT) {
        this.requests.delete(id)
        if (!entry.created && !this.recorded.has(sha256Hex(id))) stale.push(entry.path)
      }
    }
    return stale
  }
}
