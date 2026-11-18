import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { settleDataHome } from '../src/data-home.ts'
import { acquireDataDirLock } from '../src/host-state.ts'
import { resolveLatchPaths } from '../src/paths.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A home with data at the old macOS place, as a Host from before the move left it. */
async function home(options: { old?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-home-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const old = join(root, 'Library', 'Application Support', 'Latch', 'Host')
  const now = join(root, '.latch', 'host')
  if (options.old !== false) {
    await mkdir(join(old, 'auth'), { recursive: true, mode: 0o700 })
    await chmod(old, 0o700)
    await writeFile(join(old, 'auth', 'devices.json'), '{"kept":true}\n', { mode: 0o600 })
    await writeFile(join(old, 'policy.json'), '{"pinned":true}\n', { mode: 0o600 })
  }
  const settle = (dataDir: string, explicit = false) => settleDataHome({ dataDir, explicit, env: {}, home: root, platform: 'darwin' })
  return { root, old, now, settle }
}

const kind = async (path: string) => {
  const info = await lstat(path).catch(() => undefined)
  return !info ? 'absent' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'link' : 'file'
}

describe('moving the data directory to ~/.latch/host', () => {
  it('moves the old directory whole, in one step, and leaves a file where it was', async () => {
    const at = await home()
    const result = await at.settle(at.old)
    expect(result).toMatchObject({ dataDir: at.now, moved: true, from: at.old })
    // Every file is the same file at the new place: nothing was copied or left behind.
    expect(await readFile(join(at.now, 'auth', 'devices.json'), 'utf8')).toBe('{"kept":true}\n')
    expect(await readFile(join(at.now, 'policy.json'), 'utf8')).toBe('{"pinned":true}\n')
    // The lock taken for the move does not stay to refuse the start that follows.
    expect((await readdir(at.now)).toSorted()).toEqual(['auth', 'policy.json'])
    expect((await lstat(join(at.root, '.latch'))).mode & 0o777).toBe(0o700)
    expect(await kind(at.old)).toBe('file')
    expect(await readFile(at.old, 'utf8')).toContain(at.now)
    await acquireDataDirLock(at.now, 'host').then(lock => lock.release())
  })

  it('is asked for by the new location too, as the packaged app names it', async () => {
    const at = await home()
    expect(await at.settle(at.now)).toMatchObject({ dataDir: at.now, moved: true })
    expect(await kind(join(at.now, 'auth'))).toBe('directory')
  })

  it('makes an older Latch fail at the old place instead of starting empty there', async () => {
    const at = await home()
    await at.settle(at.old)
    // What every start does first (acquireDataDirLock): it cannot make a directory where the file stands.
    await expect(mkdir(at.old, { recursive: true, mode: 0o700 })).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(acquireDataDirLock(at.old, 'host')).rejects.toBeDefined()
  })

  it('does nothing the second time, and sends a start that still names the old place to the new one', async () => {
    const at = await home()
    await at.settle(at.old)
    expect(await at.settle(at.now)).toEqual({ dataDir: at.now, moved: false })
    expect(await at.settle(at.old)).toMatchObject({ dataDir: at.now, moved: false })
    // The resolver agrees once the move is done.
    expect(resolveLatchPaths({ env: {}, cwd: '/', home: at.root, platform: 'darwin', legacyRuntime: false })).toMatchObject({
      dataDir: at.now,
      dataDirSource: 'default',
    })
  })

  it('leaves a directory named by a flag or a variable alone', async () => {
    const at = await home()
    const own = join(at.root, 'elsewhere')
    expect(await at.settle(own)).toEqual({ dataDir: own, moved: false })
    expect(await kind(at.old)).toBe('directory')
    expect(await kind(at.now)).toBe('absent')
  })

  it('refuses to choose when both places hold data, and changes nothing', async () => {
    const at = await home()
    await mkdir(at.now, { recursive: true, mode: 0o700 })
    await writeFile(join(at.now, 'policy.json'), '{"new":true}\n')
    for (const asked of [at.old, at.now])
      for (const explicit of [false, true]) await expect(at.settle(asked, explicit)).rejects.toMatchObject({ code: 'data-dir-both' })
    expect(await readFile(join(at.now, 'policy.json'), 'utf8')).toBe('{"new":true}\n')
    expect(await readFile(join(at.old, 'policy.json'), 'utf8')).toBe('{"pinned":true}\n')
  })

  it('moves over a new place that is only an empty directory, never starting there empty', async () => {
    const at = await home()
    await mkdir(at.now, { recursive: true, mode: 0o700 })
    await chmod(join(at.root, '.latch'), 0o700)
    expect(await at.settle(at.now)).toMatchObject({ dataDir: at.now, moved: true })
    expect(await readFile(join(at.now, 'policy.json'), 'utf8')).toBe('{"pinned":true}\n')
  })

  it('runs where it is told when the old place is named by a flag, and finds the data once it has moved', async () => {
    const at = await home()
    // Named explicitly while the data is still there: used in place, not moved.
    expect(await at.settle(at.old, true)).toEqual({ dataDir: at.old, moved: false })
    expect(await kind(at.old)).toBe('directory')
    expect(await kind(at.now)).toBe('absent')
    await at.settle(at.old)
    // Named explicitly after the move: sent to the data, whether the file is still at the old path or not.
    expect(await at.settle(at.old, true)).toMatchObject({ dataDir: at.now, moved: false })
    await rm(at.old)
    expect(await at.settle(at.old, true)).toMatchObject({ dataDir: at.now, moved: false })
    // Commands that do not start the Host find it there too.
    expect(resolveLatchPaths({ dataDir: at.old, env: {}, cwd: '/', home: at.root, platform: 'darwin', legacyRuntime: false }).dataDir).toBe(
      at.now,
    )
    // An empty directory made at the old path in the meantime holds no data: still sent to where the data is.
    await mkdir(at.old, { mode: 0o700 })
    expect(await at.settle(at.old, true)).toMatchObject({ dataDir: at.now, moved: false })
  })

  it('does not let a stale host.json stop the move, and says which file when it cannot tell', async () => {
    const stale = await home()
    // A crashed Host's record: its process is gone.
    await writeFile(join(stale.old, 'host.json'), JSON.stringify({ pid: 2 ** 22 + 12345 }))
    expect(await stale.settle(stale.old)).toMatchObject({ moved: true })
    const unreadable = await home()
    await writeFile(join(unreadable.old, 'host.json'), 'not json')
    await expect(unreadable.settle(unreadable.old)).rejects.toThrow(join(unreadable.old, 'host.json'))
    expect(await kind(unreadable.now)).toBe('absent')
  })

  it('stays where it is with a default folder inside the data, or when the old place is a link', async () => {
    const inside = await home()
    await mkdir(join(inside.old, 'workspace'))
    expect(await inside.settle(inside.old)).toMatchObject({ dataDir: inside.old, moved: false })
    expect(await kind(inside.now)).toBe('absent')

    const linked = await home({ old: false })
    const real = join(linked.root, 'real-data')
    await mkdir(real, { mode: 0o700 })
    await mkdir(join(linked.root, 'Library', 'Application Support', 'Latch'), { recursive: true })
    await symlink(real, linked.old)
    expect(await linked.settle(linked.old)).toMatchObject({ dataDir: linked.old, moved: false })
    expect(await kind(linked.old)).toBe('link')
    expect(await kind(linked.now)).toBe('absent')
    // The resolver keeps using it there as well.
    expect(resolveLatchPaths({ env: {}, cwd: '/', home: linked.root, platform: 'darwin', legacyRuntime: false }).dataDir).toBe(linked.old)
  })

  it('refuses, moving nothing, while something still uses the old directory', async () => {
    const running = await home()
    await writeFile(join(running.old, 'host.json'), JSON.stringify({ pid: process.pid }))
    await expect(running.settle(running.old)).rejects.toMatchObject({ code: 'data-dir-move-busy' })
    expect(await kind(running.old)).toBe('directory')
    expect(await kind(running.now)).toBe('absent')

    const locked = await home()
    const lock = await acquireDataDirLock(locked.old, 'cli')
    await expect(locked.settle(locked.old)).rejects.toMatchObject({ code: 'data-dir-locked' })
    expect(await kind(locked.now)).toBe('absent')
    await lock.release()
    expect(await locked.settle(locked.old)).toMatchObject({ moved: true })
  })

  it('refuses a ~/.latch that is a link or open to others', async () => {
    const linked = await home()
    await mkdir(join(linked.root, 'somewhere'), { mode: 0o700 })
    await symlink(join(linked.root, 'somewhere'), join(linked.root, '.latch'))
    await expect(linked.settle(linked.old)).rejects.toMatchObject({ code: 'data-dir-move-refused' })
    expect(await kind(linked.old)).toBe('directory')
    expect(await readdir(join(linked.root, 'somewhere'))).toEqual([])

    const open = await home()
    await mkdir(join(open.root, '.latch'), { mode: 0o755 })
    await chmod(join(open.root, '.latch'), 0o755)
    await expect(open.settle(open.old)).rejects.toMatchObject({ code: 'data-dir-move-refused' })
    expect(await kind(open.old)).toBe('directory')
  })

  it('moves into a ~/.latch that already holds the person’s relay files', async () => {
    const at = await home()
    await mkdir(join(at.root, '.latch', 'relays'), { recursive: true, mode: 0o700 })
    await chmod(join(at.root, '.latch'), 0o700)
    await writeFile(join(at.root, '.latch', 'relays', 'ne.json'), '{}', { mode: 0o600 })
    expect(await at.settle(at.old)).toMatchObject({ moved: true })
    expect((await readdir(join(at.root, '.latch'))).toSorted()).toEqual(['host', 'relays'])
  })

  it('has nothing to move on a new install or on another platform', async () => {
    const fresh = await home({ old: false })
    expect(await fresh.settle(fresh.now)).toEqual({ dataDir: fresh.now, moved: false })
    expect(await kind(fresh.now)).toBe('absent')
    const at = await home()
    expect(await settleDataHome({ dataDir: at.old, env: {}, home: at.root, platform: 'linux' })).toEqual({ dataDir: at.old, moved: false })
    expect(await kind(at.old)).toBe('directory')
  })
})
