import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '@latch/core/node-kit'
import { AppError } from '@latch/sdk'
import { canonicalPath } from '../src/paths.ts'
import { SESSION_FOLDER_NAME, SessionFolders, helperIdentitySchema, sessionFolderName } from '../src/session-folders.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A start directory under a fresh temp root, and the helper over it with the given suffixes in turn. */
async function folders(input: { suffixes?: string[]; at?: number; create?: boolean } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'latch-own-')))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'workspace')
  await mkdir(root, { mode: 0o700 })
  const suffixes = [...(input.suffixes ?? [])]
  let clock = input.at ?? new Date(2026, 9, 25, 23, 59).getTime()
  let now = 1_000_000
  const logs: string[] = []
  const helper = new SessionFolders({
    root,
    canonicalRoot: await canonicalPath(root),
    clock: () => clock,
    now: () => now,
    ...(input.suffixes ? { suffix: () => suffixes.shift() ?? 'ffff' } : {}),
    log: text => logs.push(text),
  })
  return {
    base,
    root,
    helper,
    logs,
    tick: (ms: number) => {
      now += ms
    },
    setClock: (value: number) => {
      clock = value
    },
  }
}

async function generalMigration() {
  const { base, root } = await folders()
  const dataDir = join(base, 'data')
  const managedRoot = join(base, '.latch')
  const target = join(managedRoot, 'agent-homes', 'general')
  for (const path of [dataDir, managedRoot]) await mkdir(path, { mode: 0o700 })
  const shared = { dataDir, clock: Date.now, now: Date.now, log() {} }
  const previousOptions = { ...shared, root, canonicalRoot: await canonicalPath(root) }
  const managedOptions = { ...shared, root: managedRoot, canonicalRoot: await canonicalPath(managedRoot), managedGeneral: true as const }
  const previous = new SessionFolders(previousOptions)
  const managed = new SessionFolders(managedOptions)
  const from = join(root, 'helpers', 'general')
  type Migration = Parameters<SessionFolders['migrateGeneral']>[0]
  const beforeMove = vi.fn<Migration['beforeMove']>(async () => {})
  const moveSessions = vi.fn<Migration['moveSessions']>(async () => {})
  const moveDirectory = vi.fn<Migration['moveDirectory']>((source, destination) =>
    rename(source.path, join(destination.root, 'agent-homes', destination.name)),
  )
  const options = {
    previous,
    previousRoots: [root],
    paths: (name: string) => (name === 'helpers/general' ? [from] : []),
    beforeMove,
    moveSessions,
    moveDirectory,
  }
  return { base, previousOptions, managedOptions, previous, managed, from, target, options }
}

describe('managed General home', () => {
  it('allocates the first home under agent-homes while keeping its logical marker', async () => {
    const { managed, managedOptions, target, options } = await generalMigration()
    await expect(managed.needsGeneralMigration(options.previous)).resolves.toBe(false)
    await managed.migrateGeneral(options)
    expect(options.beforeMove).not.toHaveBeenCalled()
    expect(await managed.helperState('general')).toBe('absent')
    expect(await managed.helperHome('general', async () => {})).toEqual({ name: 'helpers/general', path: target })
    expect((await stat(target)).mode & 0o777).toBe(0o700)
    const restarted = new SessionFolders(managedOptions)
    await expect(restarted.needsGeneralMigration(options.previous)).resolves.toBe(false)
    expect(await restarted.verify(target)).toBe(true)
  })

  it('moves the recorded directory and its saved session paths after authorizing the move', async () => {
    const { previous, previousOptions, managed, managedOptions, from, target, options } = await generalMigration()
    await previous.helperHome('general', async () => {})
    await writeFile(join(from, 'notes.md'), 'keep these files')
    const original = await stat(from, { bigint: true })
    options.beforeMove.mockImplementation(async () => {
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(options.moveDirectory).not.toHaveBeenCalled()
    })
    options.moveSessions.mockImplementation(async () => {
      expect(await readFile(join(target, 'notes.md'), 'utf8')).toBe('keep these files')
      await expect(stat(from)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    await managed.migrateGeneral(options)
    expect(options.beforeMove).toHaveBeenCalledOnce()
    expect(options.moveDirectory).toHaveBeenCalledOnce()
    expect(options.moveSessions).toHaveBeenCalledExactlyOnceWith('helpers/general', from, target)
    expect((await stat(target, { bigint: true })).ino).toBe(original.ino)
    expect(await new SessionFolders(previousOptions).recordedHomes()).toEqual([])
    const restarted = new SessionFolders(managedOptions)
    await restarted.migrateGeneral(options)
    expect(await restarted.verify(target)).toBe(true)
    expect(options.moveSessions).toHaveBeenCalledOnce()
  })

  it('moves only the home used by the saved session when the legacy roots share a logical name', async () => {
    const { base, previous, previousOptions, managed, from, target, options } = await generalMigration()
    await previous.helperHome('general', async () => {})
    await writeFile(join(from, 'notes.md'), 'active home')
    const otherRoot = join(base, 'other-workspace')
    await mkdir(otherRoot, { mode: 0o700 })
    const other = new SessionFolders({ ...previousOptions, root: otherRoot, canonicalRoot: await canonicalPath(otherRoot) })
    const otherHome = await other.helperHome('general', async () => {})
    await writeFile(join(otherHome.path, 'notes.md'), 'other home')

    await managed.migrateGeneral({
      ...options,
      previous: new SessionFolders(previousOptions),
      previousRoots: [...options.previousRoots, otherRoot],
    })
    expect(await readFile(join(target, 'notes.md'), 'utf8')).toBe('active home')
    expect(await readFile(join(otherHome.path, 'notes.md'), 'utf8')).toBe('other home')
    expect(options.moveSessions).toHaveBeenCalledExactlyOnceWith('helpers/general', from, target)
  })

  it('resumes the saved session rewrite after an interruption just after the directory move', async () => {
    const { previous, previousOptions, managed, managedOptions, from, target, options } = await generalMigration()
    await previous.helperHome('general', async () => {})
    await writeFile(join(from, 'notes.md'), 'keep these files')
    options.moveSessions.mockRejectedValueOnce(new Error('interrupted'))
    await expect(managed.migrateGeneral(options)).rejects.toThrow('interrupted')
    expect(await readFile(join(target, 'notes.md'), 'utf8')).toBe('keep these files')
    await expect(stat(from)).rejects.toMatchObject({ code: 'ENOENT' })

    const restarted = new SessionFolders(managedOptions)
    await restarted.migrateGeneral({ ...options, previous: new SessionFolders(previousOptions) })
    expect(await restarted.verify(target)).toBe(true)
    expect(options.beforeMove).toHaveBeenCalledOnce()
    expect(options.moveDirectory).toHaveBeenCalledOnce()
    expect(options.moveSessions.mock.calls).toEqual([
      ['helpers/general', from, target],
      ['helpers/general', from, target],
    ])
  })

  it.each(['home', 'parent'] as const)('recreates a verified missing legacy %s and resumes its saved session rewrite', async missing => {
    const { previous, previousOptions, managed, managedOptions, from, target, options } = await generalMigration()
    await previous.helperHome('general', async () => {})
    await rm(missing === 'home' ? from : join(previousOptions.root, 'helpers'), { recursive: true })
    await expect(managed.needsGeneralMigration(previous)).resolves.toBe(true)
    options.moveSessions.mockRejectedValueOnce(new Error('interrupted'))
    await expect(managed.migrateGeneral(options)).rejects.toThrow('interrupted')
    const allocated = await stat(target, { bigint: true })
    expect(allocated.mode & 0o777n).toBe(0o700n)
    expect(await readdir(target)).toEqual([])

    const restarted = new SessionFolders(managedOptions)
    await restarted.migrateGeneral({ ...options, previous: new SessionFolders(previousOptions) })
    expect(await restarted.verify(target)).toBe(true)
    expect((await stat(target, { bigint: true })).ino).toBe(allocated.ino)
    expect(options.beforeMove).toHaveBeenCalledExactlyOnceWith(false)
    expect(options.moveDirectory).not.toHaveBeenCalled()
    expect(options.moveSessions.mock.calls).toEqual([
      ['helpers/general', from, target],
      ['helpers/general', from, target],
    ])
    await expect(stat(from)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a replacement at the previous home without touching either directory', async () => {
    const { base, previous, managed, from, target, options } = await generalMigration()
    await previous.helperHome('general', async () => {})
    await writeFile(join(from, 'original.md'), 'original files')
    const retained = join(base, 'retained')
    await rename(from, retained)
    await mkdir(from, { mode: 0o700 })
    await writeFile(join(from, 'replacement.md'), 'replacement files')
    await expect(managed.migrateGeneral(options)).rejects.toMatchObject({ code: 'helper-home-unavailable' })
    expect(options.beforeMove).not.toHaveBeenCalled()
    expect(options.moveDirectory).not.toHaveBeenCalled()
    expect(options.moveSessions).not.toHaveBeenCalled()
    expect(await readFile(join(retained, 'original.md'), 'utf8')).toBe('original files')
    expect(await readFile(join(from, 'replacement.md'), 'utf8')).toBe('replacement files')
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a directory that appeared at the journaled destination', async () => {
    const { previous, previousOptions, managed, managedOptions, from, target, options } = await generalMigration()
    await previous.helperHome('general', async () => {})
    await writeFile(join(from, 'original.md'), 'original files')
    options.moveDirectory.mockImplementationOnce(async () => {
      await mkdir(target, { mode: 0o700 })
      await writeFile(join(target, 'other.md'), 'unrelated files')
      throw new Error('destination changed')
    })
    await expect(managed.migrateGeneral(options)).rejects.toThrow('destination changed')
    const restarted = new SessionFolders(managedOptions)
    await expect(restarted.migrateGeneral({ ...options, previous: new SessionFolders(previousOptions) })).rejects.toMatchObject({
      code: 'helper-home-unavailable',
    })
    expect(options.moveDirectory).toHaveBeenCalledOnce()
    expect(options.moveSessions).not.toHaveBeenCalled()
    expect(await readFile(join(from, 'original.md'), 'utf8')).toBe('original files')
    expect(await readFile(join(target, 'other.md'), 'utf8')).toBe('unrelated files')
  })
})

describe('folders of their own for sessions outside a project', () => {
  it('keeps one private helper home across requests and restarts, bound to the original start root', async () => {
    const { base, root } = await folders()
    const dataDir = join(base, 'data')
    await mkdir(dataDir)
    const options = { dataDir, root, canonicalRoot: await canonicalPath(root), clock: Date.now, now: Date.now, log: () => {} }
    const owner = 'agt_11111111-1111-4111-8111-111111111111'
    const guard = async () => {}
    const first = new SessionFolders(options)
    const [a, b] = await Promise.all([first.helperHome(owner, guard), first.helperHome(owner, guard)])
    expect(a).toEqual(b)
    expect(a).toEqual({ name: `helpers/${owner}`, path: join(root, 'helpers', owner) })
    expect((await stat(a.path)).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, 'helpers'))).mode & 0o777).toBe(0o700)
    await writeFile(join(a.path, 'notes.md'), 'kept between topics')
    await first.allocate('ordinary-session')
    await first.starting('ordinary-session')
    first.created('ordinary-session')
    const restarted = new SessionFolders(options)
    expect(await restarted.helperHome(owner, guard)).toEqual(a)
    expect(await readFile(join(a.path, 'notes.md'), 'utf8')).toBe('kept between topics')
    expect(restarted.paths([])).toContain(a.path)
    expect(await restarted.verify(a.path)).toBe(true)
    const otherRoot = join(base, 'other-workspace')
    await mkdir(otherRoot)
    // Another start directory gets a home of its own there; the first one's record and files stay as they are.
    const moved = new SessionFolders({ ...options, root: otherRoot, canonicalRoot: await canonicalPath(otherRoot) })
    expect(await moved.helperHome(owner, guard)).toEqual({ name: `helpers/${owner}`, path: join(otherRoot, 'helpers', owner) })
    expect(await new SessionFolders(options).helperHome(owner, guard)).toEqual(a)
    const movedHome = join(base, 'moved-home')
    await rename(a.path, movedHome)
    await symlink(movedHome, a.path)
    expect(await restarted.verify(a.path)).toBe(false)
    await expect(restarted.helperHome(owner, guard)).rejects.toMatchObject({ code: 'helper-home-unavailable' })
    expect(await readFile(join(movedHome, 'notes.md'), 'utf8')).toBe('kept between topics')
  })

  it('makes helper homes exactly 0700 even under a restrictive umask', async () => {
    const { root, helper } = await folders()
    const previous = process.umask(0o277)
    try {
      const home = await helper.helperHome('general', async () => {})
      expect((await stat(home.path)).mode & 0o777).toBe(0o700)
      expect((await stat(join(root, 'helpers'))).mode & 0o777).toBe(0o700)
    } finally {
      process.umask(previous)
    }
  })

  it.each(['root', 'parent', 'home'])(
    'refuses a replacement helper %s directory at the same path, including after restart',
    async target => {
      const { base, root } = await folders()
      const dataDir = join(base, 'data')
      await mkdir(dataDir)
      const options = { dataDir, root, canonicalRoot: await canonicalPath(root), clock: Date.now, now: Date.now, log: () => {} }
      const allocator = new SessionFolders(options)
      const home = await allocator.helperHome('general', async () => {})
      await writeFile(join(home.path, 'mine.txt'), 'keep the original')
      const original = target === 'root' ? root : target === 'parent' ? join(root, 'helpers') : home.path
      const moved = join(base, 'original')
      await rename(original, moved)
      await mkdir(home.path, { recursive: true, mode: 0o700 })
      expect(await allocator.verify(home.path)).toBe(false)
      const restarted = new SessionFolders(options)
      await expect(restarted.helperHome('general', async () => {})).rejects.toMatchObject({ code: 'helper-home-unavailable' })
      expect(await readdir(home.path)).toEqual([])
      const retained = target === 'root' ? join(moved, 'helpers', 'general') : target === 'parent' ? join(moved, 'general') : moved
      expect(await readFile(join(retained, 'mine.txt'), 'utf8')).toBe('keep the original')
    },
  )

  it('never adopts unowned helper entries or links, and refuses a fresh policy denial without touching anything', async () => {
    const { base, root, helper } = await folders()
    const guard = async () => {}
    await expect(helper.helperHome('../escape', guard)).rejects.toMatchObject({ code: 'helper-home-unavailable' })
    await symlink(base, join(root, 'helpers'))
    await expect(helper.helperHome('general', guard)).rejects.toMatchObject({ code: 'helper-home-unavailable' })
    await rm(join(root, 'helpers'))
    await mkdir(join(root, 'helpers'), { mode: 0o700 })
    await mkdir(join(root, 'helpers', 'general'))
    await writeFile(join(root, 'helpers', 'general', 'mine.txt'), 'not allocated by Host')
    // The plain name is someone else's: this allocator's first home goes beside it, under its own tag.
    const tagged = await helper.helperHome('general', guard)
    expect(tagged.name).toMatch(/^helpers\/general-[0-9a-f]{8}$/u)
    expect(await readdir(tagged.path)).toEqual([])
    expect(await readFile(join(root, 'helpers', 'general', 'mine.txt'), 'utf8')).toBe('not allocated by Host')
    const owner = 'agt_22222222-2222-4222-8222-222222222222'
    await expect(
      helper.helperHome(owner, async () => {
        throw new AppError(409, 'helper-home-overlap', '这里已经是项目')
      }),
    ).rejects.toMatchObject({ code: 'helper-home-overlap' })
    expect((await readdir(join(root, 'helpers'))).toSorted()).toEqual(['general', basename(tagged.path)].toSorted())
  })

  it('refuses a start root replaced before the first helper allocation', async () => {
    const { base, root, helper } = await folders()
    await helper.start()
    await rename(root, join(base, 'original'))
    await mkdir(root, { mode: 0o700 })
    await expect(helper.helperHome('general', async () => {})).rejects.toMatchObject({ code: 'helper-home-unavailable' })
    expect(await readdir(root)).toEqual([])
  })

  it('makes an absent recorded home again only for a caller that opts in, recording first', async () => {
    const { base, root } = await folders()
    const dataDir = join(base, 'data')
    await mkdir(dataDir)
    const options = { dataDir, root, canonicalRoot: await canonicalPath(root), clock: Date.now, now: Date.now, log: () => {} }
    const allocator = new SessionFolders(options)
    const home = await allocator.helperHome('general', async () => {})
    await rm(home.path, { recursive: true })
    expect(await allocator.helperState('general')).toBe('absent')
    await expect(allocator.helperHome('general', async () => {})).rejects.toMatchObject({ code: 'helper-home-unavailable' })
    await expect(stat(home.path)).rejects.toMatchObject({ code: 'ENOENT' })
    const refused = vi.fn(async () => {
      throw new AppError(500, 'audit-failed', 'no record')
    })
    await expect(allocator.helperHome('general', async () => {}, { recreate: true, beforeCreate: refused })).rejects.toMatchObject({
      code: 'audit-failed',
    })
    expect(refused).toHaveBeenCalledOnce()
    await expect(stat(home.path)).rejects.toMatchObject({ code: 'ENOENT' })
    const order: string[] = []
    const recreate = vi.fn(async (made: { name: string; recreated: boolean }) => {
      expect(made).toEqual({ name: 'helpers/general', recreated: true })
      order.push(
        (await stat(home.path)
          .then(() => 'exists')
          .catch(() => 'absent')) as string,
      )
    })
    expect(await allocator.helperHome('general', async () => {}, { recreate: true, beforeCreate: recreate })).toEqual(home)
    expect(order).toEqual(['absent'])
    expect((await stat(home.path)).mode & 0o777).toBe(0o700)
    // Recorded: a restart verifies it without being asked to make anything.
    const restarted = new SessionFolders(options)
    expect(await restarted.helperHome('general', async () => {})).toEqual(home)
    expect(await restarted.helperState('general')).toBe('ready')
    // An entry that is there is never made again, even when asked. The other directory is made while the home still
    // exists, so it cannot take over the home's inode as one made after the removal may on Linux.
    const replacement = join(base, 'replacement')
    await mkdir(replacement, { mode: 0o700 })
    await rm(home.path, { recursive: true })
    await rename(replacement, home.path)
    expect(await restarted.helperState('general')).toBe('refused')
    await expect(restarted.helperHome('general', async () => {}, { recreate: true, beforeCreate: recreate })).rejects.toMatchObject({
      code: 'helper-home-unavailable',
    })
    expect(recreate).toHaveBeenCalledOnce()
  })

  it('keeps each start directory’s homes, so returning to one finds its home as it was', async () => {
    const { base, root } = await folders()
    const dataDir = join(base, 'data')
    await mkdir(dataDir)
    const otherRoot = join(base, 'other')
    await mkdir(otherRoot, { mode: 0o700 })
    const at = async (path: string) =>
      new SessionFolders({ dataDir, root: path, canonicalRoot: await canonicalPath(path), clock: Date.now, now: Date.now, log: () => {} })
    const home = await (await at(root)).helperHome('general', async () => {})
    await writeFile(join(home.path, 'kept.txt'), 'first')
    const other = await (await at(otherRoot)).helperHome('general', async () => {})
    expect(other.path).toBe(join(otherRoot, 'helpers', 'general'))
    expect(await (await at(root)).helperHome('general', async () => {})).toEqual(home)
    expect(await readFile(join(home.path, 'kept.txt'), 'utf8')).toBe('first')
    expect(await (await at(otherRoot)).helperHome('general', async () => {})).toEqual(other)
  })

  it('reads homes recorded in the earlier one-per-owner layout', async () => {
    const { base, root } = await folders()
    const dataDir = join(base, 'data')
    await mkdir(dataDir)
    const options = { dataDir, root, canonicalRoot: await canonicalPath(root), clock: Date.now, now: Date.now, log: () => {} }
    const home = await new SessionFolders(options).helperHome('general', async () => {})
    const file = join(dataDir, 'session-folders.json')
    const current = JSON.parse(await readFile(file, 'utf8')) as { homes: Record<string, Record<string, object>> }
    const [[rootHash, owners]] = Object.entries(current.homes)
    await writeFile(file, JSON.stringify({ version: 1, folders: {}, helpers: { general: { rootHash, ...owners.general } } }))
    expect(await new SessionFolders(options).helperHome('general', async () => {})).toEqual(home)
  })

  it('pins a start directory that was not there at startup when it is first used', async () => {
    const { base } = await folders()
    const root = join(base, 'later')
    const helper = new SessionFolders({
      root,
      canonicalRoot: join(await canonicalPath(base), 'later'),
      clock: Date.now,
      now: Date.now,
      log: () => {},
    })
    await helper.start()
    const home = await helper.helperHome('general', async () => {})
    expect((await stat(home.path)).mode & 0o777).toBe(0o700)
  })

  it('keeps the home record strict, also after dropping the start directory hash', () => {
    const identity = { dev: '1', ino: '2' }
    const home = { root: identity, parent: identity, directory: identity }
    expect(helperIdentitySchema.safeParse(home).success).toBe(true)
    expect(helperIdentitySchema.safeParse({ ...home, rootHash: 'a'.repeat(64) }).success).toBe(false)
    expect(helperIdentitySchema.safeParse({ ...home, extra: true }).success).toBe(false)
    expect(helperIdentitySchema.safeParse({ ...home, name: '../escape' }).success).toBe(false)
  })

  it('never makes a home again inside a replaced helpers folder that still holds one of its home names', async () => {
    const { base, root } = await folders()
    const dataDir = join(base, 'data')
    await mkdir(dataDir)
    const options = { dataDir, root, canonicalRoot: await canonicalPath(root), clock: Date.now, now: Date.now, log: () => {} }
    const allocator = new SessionFolders(options)
    const home = await allocator.helperHome('general', async () => {})
    const agent = 'agt_33333333-3333-4333-8333-333333333333'
    await allocator.helperHome(agent, async () => {})
    await rename(join(root, 'helpers'), join(base, 'old-helpers'))
    await mkdir(join(root, 'helpers'), { mode: 0o700 })
    // Something under one of this Host's recorded names is in the new folder: it could have been swapped in.
    await mkdir(join(root, 'helpers', agent), { mode: 0o700 })
    for (const current of [allocator, new SessionFolders(options)]) {
      expect(await current.helperState('general')).toBe('refused')
      await expect(current.helperHome('general', async () => {}, { recreate: true })).rejects.toMatchObject({
        code: 'helper-home-unavailable',
      })
    }
    expect(await readdir(join(root, 'helpers'))).toEqual([agent])
    // None of its homes is there any more (another Host made helpers again): each one is set up new in it.
    await rm(join(root, 'helpers', agent), { recursive: true })
    expect(await allocator.helperState('general')).toBe('absent')
    expect(await allocator.helperHome('general', async () => {}, { recreate: true })).toEqual(home)
    // A helpers folder that is simply gone is made again with the home.
    await rm(join(root, 'helpers'), { recursive: true })
    expect(await new SessionFolders(options).helperHome('general', async () => {}, { recreate: true })).toEqual(home)
  })

  it('leaves the home unrecorded when helpers is swapped for a link just before the home is made', async () => {
    const { base, root, helper } = await folders()
    const elsewhere = join(base, 'elsewhere')
    await mkdir(elsewhere, { mode: 0o700 })
    let calls = 0
    const swap = async () => {
      // The last check before the home's mkdir: the helpers folder made a moment ago becomes a link.
      if (++calls === 3) {
        await rename(join(root, 'helpers'), join(base, 'made-helpers'))
        await symlink(elsewhere, join(root, 'helpers'))
      }
    }
    await expect(helper.helperHome('general', swap)).rejects.toMatchObject({ code: 'helper-home-unavailable' })
    expect(calls).toBeGreaterThanOrEqual(3)
    expect(await helper.helperState('general')).toBe('refused')
    expect(helper.helperNames()).toEqual([])
  })

  it('reads the record file only as a private regular file, and refuses a crafted one', async () => {
    const { base, root } = await folders()
    const dataDir = join(base, 'data')
    await mkdir(dataDir)
    const file = join(dataDir, 'session-folders.json')
    const options = { dataDir, root, canonicalRoot: await canonicalPath(root), clock: Date.now, now: Date.now, log: () => {} }
    const identity = { dev: '1', ino: '2' }
    const legacy = { rootHash: 'a'.repeat(64), root: identity, parent: identity, directory: identity }
    for (const [text, mode] of [
      [JSON.stringify({ version: 1, folders: {}, helpers: { general: { ...legacy, extra: 1 } } }), 0o600],
      [JSON.stringify({ version: 1, folders: {}, helpers: { '../x': legacy } }), 0o600],
      [JSON.stringify({ version: 1, folders: {}, homes: { ['a'.repeat(64)]: { general: { ...legacy } } } }), 0o600],
      [JSON.stringify({ version: 1, folders: {}, tag: 'XYZ' }), 0o600],
      [JSON.stringify({ version: 1, folders: {} }), 0o644],
    ] as const) {
      await rm(file, { force: true })
      await writeFile(file, text, { mode })
      await chmod(file, mode)
      await expect(new SessionFolders(options).start()).rejects.toMatchObject({ code: 'config-corrupt' })
    }
    await rm(file)
    await writeFile(join(base, 'real.json'), JSON.stringify({ version: 1, folders: {} }), { mode: 0o600 })
    await symlink(join(base, 'real.json'), file)
    await expect(new SessionFolders(options).start()).rejects.toMatchObject({ code: 'config-corrupt' })
  })

  it('prefers the newer layout when both name a home for the same owner and start directory', async () => {
    const { base, root } = await folders()
    const dataDir = join(base, 'data')
    await mkdir(dataDir)
    const options = { dataDir, root, canonicalRoot: await canonicalPath(root), clock: Date.now, now: Date.now, log: () => {} }
    const home = await new SessionFolders(options).helperHome('general', async () => {})
    const file = join(dataDir, 'session-folders.json')
    const current = JSON.parse(await readFile(file, 'utf8')) as { homes: Record<string, Record<string, object>> }
    const [[rootHash, owners]] = Object.entries(current.homes)
    const stale = { rootHash, root: { dev: '9', ino: '9' }, parent: { dev: '9', ino: '9' }, directory: { dev: '9', ino: '9' } }
    await writeFile(file, JSON.stringify({ ...current, helpers: { general: stale } }), { mode: 0o600 })
    void owners
    expect(await new SessionFolders(options).helperHome('general', async () => {})).toEqual(home)
  })

  it('persists started request mappings, restores them before listing roots, and binds them to the original start directory', async () => {
    const { base, root } = await folders()
    const dataDir = join(base, 'data')
    await mkdir(dataDir)
    const options = { dataDir, root, canonicalRoot: await canonicalPath(root), clock: Date.now, now: Date.now, log: () => {} }
    const first = new SessionFolders(options)
    const created = await first.allocate('private-request-id', folder => writeFile(join(folder.path, 'draft.md'), 'keep this draft'))
    await first.starting('private-request-id')
    first.created('private-request-id')
    const record = await readFile(join(dataDir, 'session-folders.json'), 'utf8')
    expect(record).not.toContain('private-request-id')
    const restarted = new SessionFolders(options)
    await restarted.start()
    expect(restarted.paths([])).toContain(created.path)
    expect(await restarted.allocate('private-request-id')).toEqual(created)
    const other = join(base, 'other-start')
    await mkdir(other)
    const moved = new SessionFolders({ ...options, root: other, canonicalRoot: await canonicalPath(other) })
    await expect(moved.allocate('private-request-id')).rejects.toMatchObject({ code: 'session-folder-unavailable' })
    expect(moved.paths([])).not.toContain(join(other, created.name))

    const legacy = new SessionFolders({
      ...options,
      root: other,
      canonicalRoot: await canonicalPath(other),
      legacyOrdinary: { root, canonicalRoot: options.canonicalRoot },
    })
    await legacy.start()
    expect(legacy.paths([])).toContain(created.path)
    expect(await legacy.verify(created.path)).toBe(true)
    expect(await legacy.allocate('private-request-id')).toEqual(created)
    expect(await legacy.authoringFolder(sha256Hex('private-request-id'))).toBe(created.path)
    const unrecorded = join(root, '20260101-c0de')
    await mkdir(unrecorded, { mode: 0o700 })
    expect(await legacy.verify(unrecorded)).toBe(false)
    const fresh = await legacy.allocate('new-request-id')
    expect(fresh.path).toBe(join(other, fresh.name))
  })

  it('names a folder after the local date and four hex characters', () => {
    expect(sessionFolderName(new Date(2026, 0, 5, 0, 1), '0a9f')).toBe('20260105-0a9f')
    expect(SESSION_FOLDER_NAME.test('20261025-ab12')).toBe(true)
    for (const name of ['20261025-AB12', '2026102-ab12', '20261025-ab123', '../20261025-ab12', '20261025_ab12'])
      expect(SESSION_FOLDER_NAME.test(name)).toBe(false)
  })

  it('makes a 0700 folder directly inside the start directory, and a new one for each request', async () => {
    const { root, helper } = await folders()
    const previous = process.umask(0o022)
    try {
      const first = await helper.allocate('request-1')
      const second = await helper.allocate('request-2')
      expect(first.name).toMatch(/^20261025-[0-9a-f]{4}$/u)
      expect(first.path).toBe(join(root, first.name))
      expect(second.path).not.toBe(first.path)
      for (const folder of [first, second]) {
        const info = await stat(folder.path)
        expect(info.isDirectory()).toBe(true)
        expect(info.mode & 0o777).toBe(0o700)
      }
      // Even a umask that would leave the owner without write access gives exactly 0700.
      process.umask(0o277)
      const third = await helper.allocate('request-3')
      expect((await stat(third.path)).mode & 0o777).toBe(0o700)
    } finally {
      process.umask(previous)
    }
  })

  it('never reuses an entry that already exists, whatever it is, and gives up after repeated collisions', async () => {
    const { base, root, helper, logs } = await folders({ suffixes: ['aaaa', 'aaaa', 'bbbb', 'cccc', 'dddd'] })
    await mkdir(join(root, '20261025-aaaa'))
    await writeFile(join(root, '20261025-bbbb'), 'a file of the owner')
    await symlink(base, join(root, '20261025-cccc'))
    const made = await helper.allocate('request')
    expect(made.name).toBe('20261025-dddd')
    expect(await readdir(join(root, '20261025-aaaa'))).toEqual([])

    const always = await folders({ suffixes: Array.from({ length: 16 }, () => 'eeee') })
    await mkdir(join(always.root, '20261025-eeee'))
    await expect(always.helper.allocate('request')).rejects.toMatchObject({ status: 409, code: 'session-folder-unavailable' })
    expect(always.logs.join('\n')).toContain('连续重复')
    expect(logs).toEqual([])
  })

  it('gives a retried request the same folder until a session is created in it, and keeps it afterwards', async () => {
    const { root, helper, tick } = await folders()
    const [first, again] = await Promise.all([helper.allocate('request'), helper.allocate('request')])
    expect(again).toEqual(first)
    expect(await helper.allocate('request')).toEqual(first)
    expect(helper.paths([])).toEqual([first.path])

    // A start that created no session removes its folder while it is empty, and only then.
    await helper.release('request')
    await expect(stat(first.path)).rejects.toMatchObject({ code: 'ENOENT' })
    const kept = await helper.allocate('kept')
    await writeFile(join(kept.path, 'notes.md'), 'x')
    await helper.release('kept')
    expect(await readdir(kept.path)).toEqual(['notes.md'])

    const created = await helper.allocate('created')
    await helper.starting('created')
    helper.created('created')
    await helper.release('created')
    expect((await stat(created.path)).isDirectory()).toBe(true)
    // A retry after the in-memory TTL reuses the recorded folder.
    tick(61 * 60_000)
    const later = await helper.allocate('created')
    expect(later.path).toBe(created.path)
    expect(helper.paths([])).toContain(created.path)
    expect(await readdir(root)).toEqual(expect.arrayContaining([created.name, later.name, kept.name]))
  })

  it('removes the empty folder of a start that never created its session, after ten minutes', async () => {
    const { helper, tick } = await folders()
    const waiting = await helper.allocate('waiting')
    // A start whose driver is still creating the session keeps its folder however long that takes.
    const slow = await helper.allocate('slow')
    await helper.starting('slow')
    tick(9 * 60_000)
    await helper.allocate('other')
    expect((await stat(waiting.path)).isDirectory()).toBe(true)
    tick(2 * 60_000)
    await helper.allocate('third')
    await expect(stat(waiting.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(helper.paths([])).not.toContain(waiting.path)
    expect((await stat(slow.path)).isDirectory()).toBe(true)
    expect(await helper.allocate('slow')).toEqual(slow)
  })

  it('keeps a started folder after an unknown result even when its memory entry expires', async () => {
    const { helper, tick } = await folders()
    const unknown = await helper.allocate('unknown')
    await helper.starting('unknown')
    await helper.release('unknown')
    tick(61 * 60_000)
    await helper.allocate('another')
    expect((await stat(unknown.path)).isDirectory()).toBe(true)
    expect(await helper.allocate('unknown')).toEqual(unknown)
  })

  it('lists recorded folders by name only and counts a folder only while it is a real directory in the start directory', async () => {
    const { base, root, helper } = await folders()
    expect(helper.paths(['20261024-0001', '../escape', '20261024-0001/..'])).toEqual([join(root, '20261024-0001')])
    const made = await helper.allocate('request')
    expect(await helper.verify(made.path)).toBe(true)
    expect(await helper.verify(undefined)).toBe(false)
    expect(await helper.verify(root)).toBe(false)
    // Named like one, but elsewhere.
    const elsewhere = join(base, '20261025-0000')
    await mkdir(elsewhere)
    expect(await helper.verify(elsewhere)).toBe(false)
    // A folder replaced by a link to somewhere else, or gone.
    await rename(made.path, join(base, 'moved'))
    await symlink(join(base, 'moved'), made.path)
    expect(await helper.verify(made.path)).toBe(false)
    await rm(made.path)
    expect(await helper.verify(made.path)).toBe(false)
  })

  it('recreates a missing start directory and refuses one that now resolves elsewhere', async () => {
    const { base, root, helper } = await folders()
    await rm(root, { recursive: true })
    const made = await helper.allocate('request')
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect(made.path.startsWith(root)).toBe(true)
    await rm(root, { recursive: true })
    await mkdir(join(base, 'other'))
    await symlink(join(base, 'other'), root)
    await expect(helper.allocate('next')).rejects.toMatchObject({ status: 409, code: 'session-folder-unavailable' })
    expect(await readdir(join(base, 'other'))).toEqual([])
  })
})
