import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath } from '../src/paths.ts'
import { SESSION_FOLDER_NAME, SessionFolders, sessionFolderName } from '../src/session-folders.ts'

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

describe('folders of their own for sessions outside a project', () => {
  it('persists started request mappings, restores them before listing roots, and binds them to the original start directory', async () => {
    const { base, root } = await folders()
    const dataDir = join(base, 'data')
    await mkdir(dataDir)
    const options = { dataDir, root, canonicalRoot: await canonicalPath(root), clock: Date.now, now: Date.now, log: () => {} }
    const first = new SessionFolders(options)
    const created = await first.allocate('private-request-id')
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
