import { EventEmitter } from 'node:events'
import { watch, type FSWatcher, type Dirent } from 'node:fs'
import { mkdir, mkdtemp, opendir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '@latch/sdk'
import { FileSearchIndex, hungFileOperations, searchFiles, trackHung } from '../src/files/search.ts'
import { ProtectedPaths } from '../src/files/resolve.ts'

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, watch: vi.fn(fs.watch) }
})
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, opendir: vi.fn(fs.opendir) }
})
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const cleanup: Array<() => Promise<unknown>> = []
beforeEach(() => {
  vi.mocked(opendir).mockReset().mockImplementation(actual.opendir)
  vi.mocked(watch).mockReset().mockImplementation(actualFs.watch)
})
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function controlledWatches(closeImmediately = true) {
  const observers: Array<{ change(): void; finishClose(): void; close: ReturnType<typeof vi.fn> }> = []
  vi.mocked(watch).mockImplementation(((...args: unknown[]) => {
    const callback = args[2] as () => void,
      emitter = new EventEmitter()
    const finishClose = () => {
      emitter.emit('close')
    }
    const close = vi.fn(() => {
      if (closeImmediately) finishClose()
    })
    observers.push({ change: callback, finishClose, close })
    return Object.assign(emitter, {
      close,
      ref() {
        return this
      },
      unref() {
        return this
      },
    }) as unknown as FSWatcher
  }) as typeof watch)
  return observers
}
async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'latch-search-index-'))),
    root = join(parent, 'project')
  await mkdir(root)
  await writeFile(join(root, 'report.txt'), 'ordinary content')
  cleanup.push(() => rm(parent, { recursive: true, force: true }))
  const index = new FileSearchIndex(),
    guard = new ProtectedPaths([])
  cleanup.push(() => index.close())
  return {
    index,
    guard,
    root,
    search: (query = '', identity = 'context-v1', check = () => {}, cancelled = () => false) =>
      index.search([{ id: 'primary', path: root }], guard, identity, query, 100, cancelled, check),
  }
}

describe('bounded filename index', () => {
  it('drops a scan stuck in a call that never settles, answers its waiters, and closes without waiting forever', async () => {
    const { index, search } = await fixture()
    const stuck: Array<() => void> = []
    vi.mocked(opendir).mockImplementation(
      (() => new Promise((_, reject) => stuck.push(() => reject(new Error('released'))))) as typeof opendir,
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const failed = expect(search('report')).rejects.toMatchObject({ code: 'file-search-timeout' })
      await vi.waitFor(() => expect(opendir).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(5000)
      await failed
      expect(hungFileOperations.count).toBe(1)
      const closing = index.close()
      await vi.advanceTimersByTimeAsync(2000)
      await closing
    } finally {
      for (const release of stuck.splice(0)) release()
      vi.useRealTimers()
    }
    await vi.waitFor(() => expect(hungFileOperations.count).toBe(0))
  }, 15_000)

  it('does not start a scan while two file operations still hang', async () => {
    const { search } = await fixture()
    const hold: Array<() => void> = []
    trackHung(new Promise<void>(resolve => hold.push(resolve)))
    trackHung(new Promise<void>(resolve => hold.push(resolve)))
    try {
      await expect(search('report')).rejects.toMatchObject({ code: 'file-list-busy' })
    } finally {
      for (const resolve of hold.splice(0)) resolve()
    }
    await vi.waitFor(() => expect(hungFileOperations.count).toBe(0))
    expect((await search('report')).files.length).toBeGreaterThan(0)
  })

  it('reuses only names while freshly rejecting changed secret content, symlinks and revoked callers', async () => {
    controlledWatches()
    const f = await fixture()
    expect((await f.search('report')).files).toHaveLength(1)
    const scans = vi.mocked(opendir).mock.calls.length
    expect((await f.search('report')).files).toHaveLength(1)
    expect(opendir).toHaveBeenCalledTimes(scans)
    await writeFile(join(f.root, 'report.txt'), ['-----BEGIN', 'PRIVATE KEY-----'].join(' '))
    expect((await f.search('report')).files).toEqual([])
    expect(opendir).toHaveBeenCalledTimes(scans)
    await expect(
      f.search('report', 'context-v1', () => {
        throw new AppError(403, 'window-expired', 'Fixture expired')
      }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('binds the configuration identity and actual root inode before reusing names', async () => {
    const watches = controlledWatches(),
      f = await fixture()
    await f.search()
    expect(opendir).toHaveBeenCalledTimes(1)
    await f.search('', 'context-v2')
    expect(opendir).toHaveBeenCalledTimes(2)
    await rename(f.root, f.root + '-old')
    await mkdir(f.root)
    await writeFile(join(f.root, 'replacement.txt'), 'new root')
    expect((await f.search('', 'context-v2')).files.map(file => file.path)).toEqual(['replacement.txt'])
    expect(opendir).toHaveBeenCalledTimes(3)
    for (let generation = 3; generation < 11; generation++) await f.search('', `context-v${generation}`)
    expect(watches[0]!.close).toHaveBeenCalledOnce()
    await f.index.close()
    expect(watches.every(watch => watch.close.mock.calls.length === 1)).toBe(true)
  })

  it('invalidates a real directory watch on creation and rename', async () => {
    const f = await fixture()
    await f.search('new')
    await writeFile(join(f.root, 'new.txt'), 'new')
    await vi.waitFor(async () => expect((await f.search('new')).files.map(file => file.path)).toEqual(['new.txt']))
    await rename(join(f.root, 'new.txt'), join(f.root, 'renamed.txt'))
    await vi.waitFor(async () => {
      expect((await f.search('renamed')).files.map(file => file.path)).toEqual(['renamed.txt'])
      expect((await f.search('new')).files).toEqual([])
    })
  })

  it('discards the build epoch if a directory event arrives while opendir is pending', async () => {
    const watches = controlledWatches(),
      f = await fixture(),
      entered = deferred(),
      release = deferred()
    vi.mocked(opendir).mockImplementationOnce(async (...args) => {
      const directory = await actual.opendir(...args)
      entered.resolve()
      await release.promise
      return directory
    })
    const first = f.search('report')
    await entered.promise
    watches[0]!.change()
    release.resolve()
    expect((await first).files).toHaveLength(1)
    expect(watches[0]!.close).toHaveBeenCalledOnce()
    expect(opendir).toHaveBeenCalledTimes(2)
    await f.search('report')
    expect(opendir).toHaveBeenCalledTimes(3)
    await f.search('report')
    expect(opendir).toHaveBeenCalledTimes(3)
  })

  it('keeps the original fifty-thousand-item live visibility when twenty-thousand cached names do not fit', async () => {
    controlledWatches()
    const f = await fixture()
    await writeFile(join(f.root, 'target.txt'), 'target')
    vi.mocked(opendir).mockImplementation(
      async () =>
        ({
          async *[Symbol.asyncIterator]() {
            for (let i = 0; i < 20_100; i++)
              yield {
                name: i === 20_099 ? 'target.txt' : `unmatched-${i}.txt`,
                isFile: () => true,
                isDirectory: () => false,
                isSymbolicLink: () => false,
              } as Dirent
          },
          async close() {},
        }) as Awaited<ReturnType<typeof opendir>>,
    )
    expect(await f.search('target')).toEqual({ files: [{ name: 'target.txt', path: 'target.txt', root: 'primary' }], truncated: false })
    expect(opendir).toHaveBeenCalledTimes(2)
  })

  it('bounds watches and expires partial watch coverage after one second', async () => {
    const watches = controlledWatches(),
      f = await fixture()
    for (let i = 0; i < 40; i++) await mkdir(join(f.root, `child-${i}`))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await f.search('report')
    expect(watches).toHaveLength(32)
    const scans = vi.mocked(opendir).mock.calls.length
    await f.search('report')
    expect(opendir).toHaveBeenCalledTimes(scans)
    await vi.advanceTimersByTimeAsync(1000)
    // Closed a few per turn, all within a few turns.
    await vi.advanceTimersByTimeAsync(20)
    expect(watches.every(watch => watch.close.mock.calls.length === 1)).toBe(true)
    await f.search('report')
    expect(vi.mocked(opendir).mock.calls.length).toBeGreaterThan(scans)
  })

  it('rechecks a warm result after awaited file classification', async () => {
    controlledWatches()
    const f = await fixture()
    await f.search('report')
    let expired = false
    vi.spyOn(f.guard, 'contains').mockImplementation(async () => {
      await Promise.resolve()
      expired = true
      return false
    })
    await expect(
      f.search('report', 'context-v1', () => {
        if (expired) throw new AppError(403, 'window-expired', 'Fixture expired')
      }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('does not cache an enumeration cancelled while waiting for its directory', async () => {
    const watches = controlledWatches(),
      f = await fixture(),
      entered = deferred(),
      release = deferred()
    let cancelled = false
    vi.mocked(opendir).mockImplementationOnce(async (...args) => {
      const directory = await actual.opendir(...args)
      entered.resolve()
      await release.promise
      return directory
    })
    const result = f.search(
      '',
      'context-v1',
      () => {},
      () => cancelled,
    )
    await entered.promise
    cancelled = true
    release.resolve()
    expect(await result).toEqual({ files: [], truncated: true })
    expect(watches[0]!.close).toHaveBeenCalledOnce()
    cancelled = false
    expect((await f.search('report')).files).toHaveLength(1)
    expect(opendir).toHaveBeenCalledTimes(2)
  })

  it('keeps watcher ownership until its actual close event', async () => {
    const watches = controlledWatches(false),
      f = await fixture()
    await f.search()
    let closed = false
    const closing = f.index.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(watches[0]!.close).toHaveBeenCalledOnce()
    expect(closed).toBe(false)
    watches[0]!.finishClose()
    await closing
    expect(closed).toBe(true)
  })

  it('waits for its pending directory descriptor on shutdown and refuses late publication', async () => {
    const watches = controlledWatches(),
      f = await fixture(),
      entered = deferred(),
      release = deferred()
    vi.mocked(opendir).mockImplementationOnce(async (...args) => {
      const directory = await actual.opendir(...args)
      entered.resolve()
      await release.promise
      return directory
    })
    const result = f.search().then(
      () => 'unexpected',
      (cause: unknown) => cause,
    )
    await entered.promise
    let closed = false
    const closing = f.index.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(watches[0]!.close).toHaveBeenCalledOnce()
    release.resolve()
    expect(await result).toMatchObject({ status: 503 })
    await closing
    expect(closed).toBe(true)
    await expect(f.search()).rejects.toMatchObject({ status: 503 })
  })
})

async function project(files: Record<string, string>) {
  const f = await fixture()
  await rm(join(f.root, 'report.txt'))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(f.root, path, '..'), { recursive: true })
    await writeFile(join(f.root, path), content)
  }
  const roots = [{ id: 'primary', path: f.root }]
  return {
    ...f,
    page: (query = '', cursor?: string) =>
      f.index.search(roots, f.guard, 'context-v1', query, 1, () => false, undefined, { device: 'reader', cursor }),
    listed: async (query = '') => (await f.search(query)).files.map(file => file.path),
    uncached: async (query = '') => (await searchFiles(roots, f.guard, query, 100, () => false)).files.map(file => file.path),
  }
}

describe('paged mention search', () => {
  it('returns a shallow file before opening any descendant, ranks once on demand and rechecks each subsequent file', async () => {
    const f = await project({ 'root.ts': '', 'src/a.ts': '', 'src/b.ts': '', 'src/c.ts': '', 'src/d.ts': '' })
    const first = await f.page()
    expect(first.files.map(item => item.path)).toEqual(['root.ts'])
    expect(opendir).toHaveBeenCalledTimes(1)
    expect(first.nextCursor).toBeTypeOf('string')
    const second = await f.page('', first.nextCursor)
    expect(second.files.map(item => item.path)).toEqual(['src/a.ts'])
    expect(second.nextCursor).toBeTypeOf('string')
    const opened = vi.mocked(opendir).mock.calls.length
    await writeFile(join(f.root, 'src/b.ts'), ['-----BEGIN', 'PRIVATE KEY-----'].join(' '))
    await rm(join(f.root, 'src/c.ts'))
    await symlink('d.ts', join(f.root, 'src/c.ts'))
    const last = await f.page('', second.nextCursor)
    expect(last).toEqual({ files: [{ root: 'primary', name: 'd.ts', path: 'src/d.ts' }], truncated: false })
    expect(opendir).toHaveBeenCalledTimes(opened)
  })

  it('finds deep exact names ahead of weak shallow matches and still finds explicitly requested ignored files', async () => {
    const f = await project({ 'm-a-i-n.ts': '', 'a/b/main.ts': '', 'node_modules/build/artifact.ts': '' })
    const main = await f.page('main')
    expect(main.files.map(item => item.path)).toEqual(['a/b/main.ts'])
    expect((await f.page('artifact')).files).toEqual([
      { root: 'primary', name: 'artifact.ts', path: 'node_modules/build/artifact.ts', ignored: true },
    ])
    expect(await f.page('absent-name')).toEqual({ files: [], truncated: false })
  })

  it('uses a warm index directly on the first page of a new query', async () => {
    controlledWatches()
    const f = await project({ 'readme.txt': '', 'src/main.ts': '' })
    await f.search('readme')
    const opened = vi.mocked(opendir).mock.calls.length
    expect((await f.page('main')).files.map(item => item.path)).toEqual(['src/main.ts'])
    expect(opendir).toHaveBeenCalledTimes(opened)
  })

  it('expires abandoned cursors and refuses to use them for another query', async () => {
    const f = await project({ 'a.ts': '', 'b.ts': '', 'c.ts': '' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    const first = await f.page()
    expect(first.nextCursor).toBeTypeOf('string')
    await expect(f.page('b', first.nextCursor)).rejects.toMatchObject({ code: 'file-search-expired' })
    // Date.now stays at real time: the expiry callback must actually release the saved names.
    await vi.advanceTimersByTimeAsync(60_001)
    await expect(f.page('', first.nextCursor)).rejects.toMatchObject({ code: 'file-search-expired' })
    expect(vi.getTimerCount()).toBe(0)
    const oldest = await f.page()
    for (let index = 0; index < 16; index++) await f.page()
    expect(vi.getTimerCount()).toBe(16)
    await expect(f.page('', oldest.nextCursor)).rejects.toMatchObject({ code: 'file-search-expired' })
    await f.index.close()
    expect(vi.getTimerCount()).toBe(0)
  })
})

const RUST = {
  '.git/HEAD': 'ref',
  '.gitignore': 'target/\n',
  '.vscode/launch.json': '{}',
  'Cargo.toml': '[package]',
  'src/main.rs': 'fn main() {}',
  'src/deep/er/lib.rs': '',
  'target/.rustc_info.json': '{}',
  'target/CACHEDIR.TAG': 'tag',
  'target/debug/main.d': '',
}

describe('the order a person sees', () => {
  it('lists source first and leaves ignored build output out until it is typed for', async () => {
    controlledWatches()
    const f = await project(RUST)
    const browsing = ['src/main.rs', 'src/deep/er/lib.rs', 'Cargo.toml', '.gitignore', '.vscode/launch.json']
    expect(await f.listed()).toEqual(browsing)
    expect(await f.uncached()).toEqual(browsing)
    for (const search of [f.search, (query: string) => searchFiles([{ id: 'primary', path: f.root }], f.guard, query, 100, () => false)]) {
      expect((await search('cachedir')).files).toEqual([
        { name: 'CACHEDIR.TAG', path: 'target/CACHEDIR.TAG', root: 'primary', ignored: true },
      ])
      expect((await search('main')).files.map(file => [file.path, file.ignored])).toEqual([
        ['src/main.rs', undefined],
        ['target/debug/main.d', true],
      ])
    }
  })

  it('ranks name prefix, name, path, then subsequence, ahead of the limit', async () => {
    controlledWatches()
    const f = await project({
      'zz/mention.md': '',
      'file-mention.ts': '',
      'mention/other.ts': '',
      'm-e-n-t-i-o-n.ts': '',
      ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`a/noise-${i}.ts`, ''])),
    })
    const order = ['zz/mention.md', 'file-mention.ts', 'mention/other.ts', 'm-e-n-t-i-o-n.ts']
    expect(await f.listed('mention')).toEqual(order)
    expect(await f.uncached('mention')).toEqual(order)
    const limited = await f.index.search([{ id: 'primary', path: f.root }], f.guard, 'context-v1', 'noise', 5, () => false)
    expect(limited.files).toHaveLength(5)
    expect(limited.truncated).toBe(true)
    expect((await f.index.search([{ id: 'primary', path: f.root }], f.guard, 'context-v1', 'mention', 4, () => false)).truncated).toBe(
      false,
    )
  })

  it('keeps target as source in a repository that does not ignore it, and as low-ranked output without git', async () => {
    controlledWatches()
    const repository = await project({ '.git/HEAD': 'ref', 'target/real.rs': '', 'a/b/c/deeper.rs': '' })
    expect(await repository.listed()).toEqual(['target/real.rs', 'a/b/c/deeper.rs'])
    const plain = await project({ 'target/out.rs': '', 'src/a.rs': '' })
    expect(await plain.listed()).toEqual(['src/a.rs'])
    expect((await plain.search('out')).files).toEqual([{ name: 'out.rs', path: 'target/out.rs', root: 'primary', ignored: true }])
    const onlyOutput = await project({ 'target/out.rs': '' })
    expect(await onlyOutput.listed()).toEqual(['target/out.rs'])
  })

  it('follows nested .gitignore files, negation and ignored files beside kept ones', async () => {
    controlledWatches()
    const f = await project({
      '.git/HEAD': 'ref',
      '.gitignore': '*.log\n!keep.log\ngen/\n',
      'app/.gitignore': '/local.ts\n!gen/\n',
      'app/local.ts': '',
      'app/deep/local.ts': '',
      'app/gen/made.ts': '',
      'gen/made2.ts': '',
      'keep.log': '',
      'drop.log': '',
    })
    expect(await f.listed()).toEqual(['app/deep/local.ts', 'app/gen/made.ts', 'keep.log', '.gitignore', 'app/.gitignore'])
    expect((await f.search('drop')).files).toEqual([{ name: 'drop.log', path: 'drop.log', root: 'primary', ignored: true }])
    expect((await f.search('made2')).files[0]).toMatchObject({ path: 'gen/made2.ts', ignored: true })
  })

  it('never lists .git, and typed search does not get past symlinks, protected paths or secret files', async () => {
    controlledWatches()
    const f = await project({ '.git/config': '', 'node_modules/pkg/index.js': '', 'node_modules/pkg/.env': 'A=1', 'src/a.ts': '' })
    const parent = join(f.root, '..')
    await mkdir(join(parent, 'private'))
    await writeFile(join(parent, 'private', 'hidden-escape.txt'), 'private')
    await symlink(join(parent, 'private'), join(f.root, 'node_modules', 'escape'))
    await symlink(join(parent, 'private'), join(f.root, 'dist'))
    await writeFile(join(f.root, 'node_modules', 'pkg', 'key.txt'), ['-----BEGIN', 'PRIVATE KEY-----'].join(' '))
    await mkdir(join(f.root, 'build'))
    await writeFile(join(f.root, 'build', 'guarded-file.txt'), 'x')
    const guard = new ProtectedPaths([join(f.root, 'build')])
    const roots = [{ id: 'primary', path: f.root }]
    const search = async (q: string) => (await f.index.search(roots, guard, 'guarded', q, 100, () => false)).files
    const uncached = async (q: string) => (await searchFiles(roots, guard, q, 100, () => false)).files
    for (const find of [search, uncached]) {
      expect(await find('config')).toEqual([])
      expect(await find('hidden-escape')).toEqual([])
      expect(await find('guarded-file')).toEqual([])
      expect(await find('key.txt')).toEqual([])
      expect(await find('pkg/.env')).toEqual([])
      expect(await find('index')).toEqual([{ name: 'index.js', path: 'node_modules/pkg/index.js', root: 'primary', ignored: true }])
    }
  })

  it('makes no second walk while browsing or when the first has plenty', async () => {
    controlledWatches()
    const f = await project({ 'src/a.ts': '', 'src/ab.ts': '', 'node_modules/ab.js': '' })
    await f.search('')
    const directories = vi.mocked(opendir).mock.calls.length
    await f.search('')
    await f.index.search([{ id: 'primary', path: f.root }], f.guard, 'context-v1', 'ab', 1, () => false)
    expect(vi.mocked(opendir).mock.calls.length).toBe(directories)
    expect(await f.listed('a')).toEqual(['src/a.ts', 'src/ab.ts'])
    expect(vi.mocked(opendir).mock.calls.length).toBe(directories)
    expect(await f.listed('ab')).toEqual(['src/ab.ts', 'node_modules/ab.js'])
    expect(vi.mocked(opendir).mock.calls.length).toBeGreaterThan(directories)
  })
})
