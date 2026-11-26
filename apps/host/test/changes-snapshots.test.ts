import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { capture, compare, type CaptureContext } from '../src/changes/capture.ts'
import { ObjectStore, type CloneFile } from '../src/changes/objects.ts'
import { SessionFiles, privateDirectory, type Manifest } from '../src/changes/records.ts'
import { ProtectedIndex, fileKey, walkFolders } from '../src/changes/walk.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function fixture(options: { clone?: CloneFile } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'latch-changes-snap-')))
  cleanup.push(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'project'),
    store = join(base, 'store'),
    privateDir = join(root, 'private')
  await mkdir(privateDir, { recursive: true })
  await privateDirectory(store)
  const objects = new ObjectStore(store, options.clone ?? (async (source, target) => copyFile(source, target)))
  const guard = await ProtectedIndex.of([privateDir])
  const roots = [{ id: 'main', path: root }]
  const storeDev = (await lstat(store, { bigint: true })).dev
  const context = (extra: Partial<CaptureContext> = {}): CaptureContext => ({
    objects,
    storeDev,
    copyLimit: 16,
    cloneLimit: 1024,
    deadline: Date.now() + 10_000,
    room: { bytes: 1_000_000 },
    now: () => Date.parse('2026-10-27T00:00:00.000Z'),
    ...extra,
  })
  const walk = (limits: Partial<{ entries: number; depth: number }> = {}) =>
    walkFolders(roots, guard, { entries: 1000, depth: 32, deadline: Date.now() + 10_000, ...limits })
  return { base, root, store, privateDir, objects, guard, roots, walk, context }
}

describe('walking session folders', () => {
  it('lists regular files in name order and leaves out ignored names, symlinks and protected paths', async () => {
    const f = await fixture()
    for (const directory of ['node_modules', '.git', 'dist', 'src/nested']) await mkdir(join(f.root, directory), { recursive: true })
    await writeFile(join(f.root, 'node_modules', 'x.js'), 'dependency')
    await writeFile(join(f.root, '.git', 'config'), '[core]')
    await writeFile(join(f.root, 'dist', 'out.js'), 'built')
    await writeFile(join(f.root, 'src', 'nested', 'b.ts'), 'b')
    await writeFile(join(f.root, 'src', 'a.ts'), 'a')
    await writeFile(join(f.root, 'note.tmp'), 'temporary')
    await writeFile(join(f.root, '.env'), 'TOKEN=1')
    await writeFile(join(f.privateDir, 'hidden.txt'), 'private')
    await writeFile(join(f.base, 'outside.txt'), 'outside')
    await symlink(join(f.base, 'outside.txt'), join(f.root, 'link.txt'))
    const walk = await f.walk()
    expect([...walk.files.values()].map(file => file.path).toSorted()).toEqual(['.env', 'src/a.ts', 'src/nested/b.ts'])
    expect(walk.files.get(fileKey('main', '.env'))?.secret).toBe(true)
    expect(walk.files.get(fileKey('main', 'src/a.ts'))?.secret).toBe(false)
    expect(walk.complete.has('main')).toBe(true)
  })

  it('stops at its entry limit and says the folder was not walked to the end', async () => {
    const f = await fixture()
    for (const name of ['a', 'b', 'c', 'd']) await writeFile(join(f.root, `${name}.txt`), name)
    const walk = await f.walk({ entries: 2 })
    expect(walk.complete.has('main')).toBe(false)
  })

  it('prunes dependency stores and build checkouts before they can consume the walk budget', async () => {
    const f = await fixture()
    const caches = ['.pnpm-store/v11', 'native/ios/.build/xcode-packages/checkouts/MermaidKit', 'native/ios/.derived-data', 'DerivedData']
    for (const directory of caches) {
      await mkdir(join(f.root, directory), { recursive: true })
      await Promise.all(Array.from({ length: 20 }, (_, i) => writeFile(join(f.root, directory, `file-${i}`), 'generated')))
    }
    await mkdir(join(f.root, 'checkouts/MermaidKit'), { recursive: true })
    await writeFile(join(f.root, 'checkouts/MermaidKit/Diagram.swift'), 'source')
    const walk = await f.walk({ entries: 15 })
    expect([...walk.files.values()].map(file => file.path)).toEqual(['checkouts/MermaidKit/Diagram.swift'])
    expect(walk.complete.has('main')).toBe(true)
  })

  it('honours .gitignore inside Git repositories while keeping plain non-Git folders untouched', async () => {
    const f = await fixture()
    await writeFile(join(f.root, '.gitignore'), '/test-results/\n*.snap\n')
    await mkdir(join(f.root, 'test-results/shots'), { recursive: true })
    await writeFile(join(f.root, 'test-results/shots/a.png'), 'png')
    await writeFile(join(f.root, 'a.snap'), 'snap')
    await writeFile(join(f.root, 'keep.ts'), 'export {}\n')

    // Without .git, .gitignore does not hide files in a plain folder.
    const plain = await walkFolders(
      f.roots,
      f.guard,
      { entries: 1000, depth: 32, deadline: Date.now() + 10_000 },
      { honourGitignore: true },
    )
    expect([...plain.files.values()].map(file => file.path).toSorted()).toEqual([
      '.gitignore',
      'a.snap',
      'keep.ts',
      'test-results/shots/a.png',
    ])

    // Once .git exists, .gitignore prunes `/test-results/` and `*.snap`.
    await mkdir(join(f.root, '.git'))
    const repo = await walkFolders(f.roots, f.guard, { entries: 1000, depth: 32, deadline: Date.now() + 10_000 }, { honourGitignore: true })
    expect([...repo.files.values()].map(file => file.path).toSorted()).toEqual(['.gitignore', 'keep.ts'])
    expect(await repo.isGitIgnored('main', 'test-results/shots/a.png')).toBe(true)
    expect(await repo.isGitIgnored('main', 'keep.ts')).toBe(false)
  })
})

describe('capturing a record', () => {
  it('copies small files into private objects and reuses entries whose metadata is unchanged', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'a.txt'), 'alpha')
    const first = await capture(f.roots, await f.walk(), undefined, f.context())
    const entry = first.files[fileKey('main', 'a.txt')]!
    expect(entry).toMatchObject({ size: 5, kept: 'stored' })
    expect(await f.objects.read(entry.hash!, 1024).then(bytes => Buffer.from(bytes!).toString())).toBe('alpha')
    const objectInfo = await stat(f.objects.pathOf(entry.hash!))
    expect(objectInfo.mode & 0o777).toBe(0o600)
    // An unchanged file is not read again: removing its object does not change the reused entry.
    await f.objects.remove(entry.hash!)
    const second = await capture(f.roots, await f.walk(), first, f.context())
    expect(second.files[fileKey('main', 'a.txt')]).toBe(entry)
  })

  it('never reads a secret-looking name, keeps a secret by content out of the objects, and records why', async () => {
    const f = await fixture()
    await writeFile(join(f.root, '.env.local'), 'API_TOKEN=value')
    await writeFile(join(f.root, 'key.txt'), ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' '))
    const record = await capture(f.roots, await f.walk(), undefined, f.context())
    expect(record.files[fileKey('main', '.env.local')]).toMatchObject({ kept: 'secret' })
    expect(record.files[fileKey('main', '.env.local')]!.hash).toBeUndefined()
    expect(record.files[fileKey('main', 'key.txt')]).toMatchObject({ kept: 'secret' })
    expect((await f.objects.list()).objects.size).toBe(0)
  })

  it('clones larger files on the same volume, refuses a clone whose bytes differ, and keeps no leftovers', async () => {
    const big = 'x'.repeat(100)
    const honest = await fixture()
    await writeFile(join(honest.root, 'big.txt'), big)
    expect((await capture(honest.roots, await honest.walk(), undefined, honest.context())).files[fileKey('main', 'big.txt')]).toMatchObject(
      {
        kept: 'stored',
      },
    )
    const swapped = await fixture({ clone: async (_source, target) => writeFile(target, 'y'.repeat(100)) })
    await writeFile(join(swapped.root, 'big.txt'), big)
    const record = await capture(swapped.roots, await swapped.walk(), undefined, swapped.context())
    expect(record.files[fileKey('main', 'big.txt')]).toMatchObject({ kept: 'large' })
    const listed = await swapped.objects.list()
    expect([listed.objects.size, listed.leftovers.length]).toEqual([0, 0])
  })

  it('marks larger files on another volume, past the clone limit or past the project cap as not kept', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'big.txt'), 'x'.repeat(100))
    await writeFile(join(f.root, 'huge.txt'), 'x'.repeat(2000))
    await writeFile(join(f.root, 'small.txt'), 'small')
    const elsewhere = await capture(f.roots, await f.walk(), undefined, f.context({ storeDev: -1n, room: { bytes: 0 } }))
    expect(elsewhere.files[fileKey('main', 'big.txt')]).toMatchObject({ kept: 'large' })
    expect(elsewhere.files[fileKey('main', 'huge.txt')]).toMatchObject({ kept: 'large' })
    expect(elsewhere.files[fileKey('main', 'small.txt')]).toMatchObject({ kept: 'cap' })
  })

  it('removes a damaged object when it is read, so a later capture stores it again', async () => {
    const f = await fixture()
    const { hash } = await f.objects.putBytes(Buffer.from('content'))
    await writeFile(f.objects.pathOf(hash), 'tampered')
    expect(await f.objects.read(hash, 1024)).toBeUndefined()
    expect((await f.objects.list()).objects.has(hash)).toBe(false)
  })
})

describe('comparing records', () => {
  const manifest = (files: Manifest['files'], complete = ['main']): Manifest => ({
    capturedAt: '2026-10-27T00:00:00.000Z',
    folders: [{ id: 'main', path: '/p' }],
    complete,
    files,
  })
  const entry = (hash: string, sig = '1:1:1:1:1') => ({ size: 1, mode: 0o644, hash: hash.repeat(64), kept: 'stored' as const, sig })

  it('finds additions, modifications and deletions, ignoring a touch that kept the content', () => {
    const before = manifest({
      [fileKey('main', 'same')]: entry('a'),
      [fileKey('main', 'touched')]: entry('b'),
      [fileKey('main', 'gone')]: entry('c'),
      [fileKey('main', 'edited')]: entry('d'),
    })
    const after = manifest({
      [fileKey('main', 'same')]: entry('a'),
      [fileKey('main', 'touched')]: entry('b', '2:2:2:2:2'),
      [fileKey('main', 'edited')]: entry('e'),
      [fileKey('main', 'new')]: entry('f'),
    })
    const { changes, partial } = compare(before, after)
    expect(partial).toBe(false)
    expect(changes.map(change => [change.path, Boolean(change.before), Boolean(change.after)])).toEqual([
      ['edited', true, true],
      ['gone', true, false],
      ['new', false, true],
    ])
  })

  it('does not call a file deleted or added when that side was not walked to the end', () => {
    const before = manifest({ [fileKey('main', 'kept')]: entry('a') })
    const after = manifest({ [fileKey('main', 'new')]: entry('b') }, [])
    expect(compare(before, after)).toEqual({ changes: [{ root: 'main', path: 'new', after: expect.any(Object) }], partial: true })
    expect(compare(manifest({}, []), manifest({ [fileKey('main', 'new')]: entry('b') })).changes).toEqual([])
  })
})

describe('session records on disk', () => {
  it('round-trips, ignores damaged or foreign files, and refuses a store directory that is a symlink', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'latch-changes-records-')))
    cleanup.push(() => rm(base, { recursive: true, force: true }))
    const directory = join(base, 'session')
    await privateDirectory(directory)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    const files = new SessionFiles(directory, 'session-1', 'project-1')
    const head: Manifest = { capturedAt: '2026-10-27T00:00:00.000Z', folders: [{ id: 'main', path: '/p' }], complete: ['main'], files: {} }
    await files.writeHead(head)
    await files.writeTurns([
      {
        turnId: 'run-1',
        startedAt: '2026-10-27T00:00:00.000Z',
        state: 'running',
        attributed: false,
        between: [],
        changes: [],
        receipts: [],
      },
    ])
    expect(await files.readHead()).toEqual(head)
    expect((await files.readTurns()).map(turn => turn.turnId)).toEqual(['run-1'])
    expect((await stat(join(directory, 'turns.json'))).mode & 0o777).toBe(0o600)
    expect(await new SessionFiles(directory, 'session-2', 'project-1').readTurns()).toEqual([])
    expect(await SessionFiles.scan(directory)).toMatchObject({ sessionId: 'session-1', projectId: 'project-1' })
    await writeFile(join(directory, 'turns.json'), '{"v":1,')
    expect(await files.readTurns()).toEqual([])
    await mkdir(join(base, 'real'))
    await symlink(join(base, 'real'), join(base, 'linked'))
    await expect(privateDirectory(join(base, 'linked'))).rejects.toMatchObject({ code: 'changes-store-insecure' })
    expect(await readdir(join(base, 'real'))).toEqual([])
    expect(await readFile(join(directory, 'head.json'), 'utf8')).toContain('"session-1"')
  })
})
