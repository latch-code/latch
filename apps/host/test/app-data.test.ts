import { mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDataStore, CACHED_PLUGINS, LEASE_MS, readPrivate } from '../src/app-data.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function dataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'latch-app-data-'))
  roots.push(root)
  return root
}
const OWNER = 'A'.repeat(22)
const plugin = (id: string, owner = OWNER) => ({ id, owner })
let counter = 0
const rid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`

describe('plugin page data store', () => {
  it('keeps the previous state after a failed write, so the same request writes once on retry', async () => {
    const dir = await dataDir()
    let fail = true
    const store = await AppDataStore.open(dir, {
      atomicFs: {
        open: (path, flags, mode) => open(path, flags, mode),
        async rename(from, to) {
          if (fail) throw new Error('disk full')
          await rename(from, to)
        },
      },
    })
    const input = { scope: 'plugin', key: 'k', requestId: rid(), ifVersion: 0, value: 1 }
    await expect(store.put(plugin('p'), 1, 'dev_a', input)).rejects.toMatchObject({ status: 503, code: 'app-data-write-unknown' })
    fail = false
    expect(await store.put(plugin('p'), 1, 'dev_a', input)).toEqual({ version: 1 })
    expect(await store.put(plugin('p'), 1, 'dev_a', input)).toEqual({ version: 1, replay: true })
    // Another device's identical request ID is its own request.
    await expect(store.put(plugin('p'), 1, 'dev_b', input)).rejects.toMatchObject({ code: 'app-data-conflict' })
    const reopened = await AppDataStore.open(dir)
    expect(await reopened.get(plugin('p'), 1, 'plugin', 'k')).toMatchObject({ version: 1, value: 1 })
    expect(await reopened.put(plugin('p'), 1, 'dev_a', input)).toEqual({ version: 1, replay: true })
  })

  it('refuses a damaged generation instead of starting empty, and enforces the document limits', async () => {
    const dir = await dataDir()
    const store = await AppDataStore.open(dir)
    const base = { scope: 'plugin', requestId: rid(), ifVersion: 0 }
    await expect(store.put(plugin('p'), 1, 'dev', { ...base, key: 'big', value: 'x'.repeat(256 * 1024 + 1) })).rejects.toMatchObject({
      status: 413,
    })
    await expect(store.put(plugin('p'), 1, 'dev', { ...base, key: 'nan', value: { n: Number.NaN } })).rejects.toMatchObject({ status: 400 })
    await expect(store.put(plugin('p'), 1, 'dev', { ...base, key: 'bad\u0000key', value: 1 })).rejects.toThrow()
    await expect(store.put(plugin('p'), 1, 'dev', { ...base, scope: 'project:../x', key: 'k', value: 1 })).rejects.toThrow()
    await store.put(plugin('q'), 1, 'dev', { ...base, key: 'ok', value: 1 })
    await writeFile(join(dir, 'plugin-data', 'q', 'gen-1', 'data.json'), '{', { mode: 0o600 })
    const reopened = await AppDataStore.open(dir)
    await expect(reopened.get(plugin('q'), 1, 'plugin', 'ok')).rejects.toMatchObject({ status: 500, code: 'app-data-corrupt' })
  })

  it('lets a lease lapse after a minute, leaving the old generation in use', async () => {
    const dir = await dataDir()
    let now = Date.parse('2026-11-12T00:00:00.000Z')
    const store = await AppDataStore.open(dir, { now: () => now })
    await store.put(plugin('p'), 1, 'dev_a', { scope: 'plugin', key: 'k', requestId: rid(), ifVersion: 0, value: 1 })
    const all = () => true
    const lease = await store.lease(plugin('p'), 2, 'dev_a', all)
    await expect(store.lease(plugin('p'), 2, 'dev_b', all)).rejects.toMatchObject({ code: 'app-data-migrating' })
    now += LEASE_MS + 1
    expect((await store.status(plugin('p'), 2)).status).toBe('needs-migration')
    await expect(
      store.migrate(
        plugin('p'),
        2,
        'dev_a',
        { requestId: rid(), lease: lease.lease, fromGeneration: 1, toVersion: 2, documents: [] },
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'app-data-lease-lost' })
    expect((await store.lease(plugin('p'), 2, 'dev_b', all)).fromGeneration).toBe(1)
    expect((await store.status(plugin('p'), 1)).status).toBe('ready')
  })

  it('hands out only what the lease allows and carries the rest into the new generation unchanged', async () => {
    const store = await AppDataStore.open(await dataDir())
    for (const scope of ['plugin', 'project:default', 'session:s1'])
      await store.put(plugin('p'), 1, 'dev', { scope, key: 'k', requestId: rid(), ifVersion: 0, value: `old ${scope}` })
    const lease = await store.lease(plugin('p'), 2, 'dev', scope => scope === 'plugin')
    expect(lease.documents.map(item => item.scope)).toEqual(['plugin'])
    // The page cannot overwrite what it did not see.
    await expect(
      store.migrate(
        plugin('p'),
        2,
        'dev',
        {
          requestId: rid(),
          lease: lease.lease,
          fromGeneration: 1,
          toVersion: 2,
          documents: [{ scope: 'session:s1', key: 'k', value: 'x' }],
        },
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 400 })
    await store.migrate(
      plugin('p'),
      2,
      'dev',
      { requestId: rid(), lease: lease.lease, fromGeneration: 1, toVersion: 2, documents: [{ scope: 'plugin', key: 'k', value: 'new' }] },
      async () => {},
    )
    expect((await store.list(plugin('p'), 2, 'plugin')).map(item => item.value)).toEqual(['new'])
    expect((await store.list(plugin('p'), 2, 'project:default')).map(item => item.value)).toEqual(['old project:default'])
    expect((await store.list(plugin('p'), 2, 'session:s1')).map(item => item.value)).toEqual(['old session:s1'])
  })

  it('removes a deleted session from every other plugin when one write fails, and retries it with the next removal', async () => {
    const dir = await dataDir()
    let failing = ''
    const store = await AppDataStore.open(dir, {
      atomicFs: {
        open: (path, flags, mode) => open(path, flags, mode),
        async rename(from, to) {
          if (failing && to.includes(`/${failing}/`)) throw new Error('disk full')
          await rename(from, to)
        },
      },
    })
    for (const id of ['a', 'b'])
      await store.put(plugin(id), 1, 'dev', { scope: 'session:s1', key: 'k', requestId: rid(), ifVersion: 0, value: 1 })
    failing = 'a'
    expect((await store.removeSession('s1')).map(change => change.pluginId)).toEqual(['b'])
    expect(await store.list(plugin('a'), 1, 'session:s1')).toHaveLength(1)
    failing = ''
    expect((await store.removeSession('other')).map(change => change.pluginId)).toEqual(['a'])
    expect(await store.list(plugin('a'), 1, 'session:s1')).toHaveLength(0)
  })

  it('keeps a bounded number of plugins in memory and refuses another record its data until it adopts it', async () => {
    const store = await AppDataStore.open(await dataDir())
    for (let index = 0; index < CACHED_PLUGINS + 4; index++)
      await store.put(plugin(`p${index}`), 1, 'dev', { scope: 'plugin', key: 'k', requestId: rid(), ifVersion: 0, value: index })
    expect(store.cached().length).toBeLessThanOrEqual(CACHED_PLUGINS)
    expect((await store.get(plugin('p0'), 1, 'plugin', 'k'))?.value).toBe(0)
    store.forget('p0')
    expect(store.cached()).not.toContain('p0')

    const next = plugin('p0', 'B'.repeat(22))
    expect(await store.claim(next)).toBe('other')
    await expect(store.get(next, 1, 'plugin', 'k')).rejects.toMatchObject({ status: 409, code: 'app-data-unclaimed' })
    await store.adopt(next)
    expect(await store.claim(next)).toBe('own')
    expect((await store.get(next, 1, 'plugin', 'k'))?.value).toBe(0)
    await expect(store.get(plugin('p0'), 1, 'plugin', 'k')).rejects.toMatchObject({ code: 'app-data-unclaimed' })
  })

  it('never lets a cold read that started before a write replace the newer copy', async () => {
    const dir = await dataDir()
    let hold: (() => void) | undefined
    let holding = false
    const store = await AppDataStore.open(dir, {
      async readFile(path, limit) {
        const text = await readPrivate(path, limit)
        if (holding && path.endsWith('data.json')) {
          holding = false
          await new Promise<void>(resolve => (hold = resolve))
        }
        return text
      },
    })
    await store.put(plugin('p'), 1, 'dev', { scope: 'plugin', key: 'k', requestId: rid(), ifVersion: 0, value: 'first' })
    store.forget('p')
    holding = true
    const stale = store.status(plugin('p'), 1)
    await expect.poll(() => hold !== undefined).toBe(true)
    expect(await store.put(plugin('p'), 1, 'dev', { scope: 'plugin', key: 'k', requestId: rid(), ifVersion: 1, value: 'second' })).toEqual({
      version: 2,
    })
    hold!()
    await stale
    expect(await store.put(plugin('p'), 1, 'dev', { scope: 'plugin', key: 'k', requestId: rid(), ifVersion: 2, value: 'third' })).toEqual({
      version: 3,
    })
    const reopened = await AppDataStore.open(dir)
    expect((await reopened.get(plugin('p'), 1, 'plugin', 'k'))?.value).toBe('third')
  })
})
