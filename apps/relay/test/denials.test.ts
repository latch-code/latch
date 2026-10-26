import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DenialStore } from '../src/denials.ts'
const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'relay-deny-'))
  directories.push(root)
  return root
}
describe('durable opaque relay denials', () => {
  it('atomically deduplicates batches, restores after process loss, hides route IDs and collects only after the signed day window', async () => {
    const dataDir = await directory(),
      route = new Uint8Array(16).fill(1),
      tag = new Uint8Array(16).fill(2)
    let now = 20_000 * 86_400_000
    const input = { dataDir, maxRoutes: 4, maxBytes: 2_000_000, now: () => now }
    let store = await DenialStore.open(input)
    expect(await store.add(route, 20_000, [tag, tag])).toBe(1)
    expect(await store.add(route, 20_000, [tag])).toBe(1)
    await store.close()
    store = await DenialStore.open(input)
    expect(await store.get(route, 20_000)).toEqual([tag])
    const [name] = await readdir(join(dataDir, 'denials')),
      path = join(dataDir, 'denials', name!)
    expect(name).not.toContain(Buffer.from(route).toString('hex'))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf8')).not.toContain(Buffer.from(route).toString('hex'))
    now += 86_400_000 + 900_000
    await store.sweep()
    expect(await store.get(route, 20_000)).toEqual([tag])
    now++
    await store.sweep()
    expect(await store.get(route, 20_000)).toEqual([])
  })
  it('preserves committed rows on permission or capacity failure and cleans owned incomplete atomic-write files on startup', async () => {
    const dataDir = await directory(),
      route = new Uint8Array(16).fill(3),
      tag = new Uint8Array(16).fill(4),
      day = Math.floor(Date.now() / 86_400_000)
    const input = { dataDir, maxRoutes: 1, maxBytes: 500_000 }
    let store = await DenialStore.open(input)
    await store.add(route, day, [tag])
    await expect(store.add(new Uint8Array(16).fill(8), day, [tag])).rejects.toThrow('capacity')
    await store.close()
    const [name] = await readdir(join(dataDir, 'denials')),
      path = join(dataDir, 'denials', name!)
    const before = await readFile(path, 'utf8')
    await writeFile(`${path}.${'a'.repeat(16)}.tmp`, 'incomplete', { mode: 0o600 })
    store = await DenialStore.open(input)
    expect(await readdir(join(dataDir, 'denials'))).toEqual([name])
    expect(await readFile(path, 'utf8')).toBe(before)
    await store.close()
    await chmod(path, 0o644)
    await expect(DenialStore.open(input)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(before)
  })
  it('rejects overlong cumulative sets and never acknowledges a write that could not persist', async () => {
    const dataDir = await directory(),
      route = new Uint8Array(16).fill(5),
      day = Math.floor(Date.now() / 86_400_000)
    const store = await DenialStore.open({ dataDir, maxRoutes: 1, maxBytes: 500_000 })
    for (let batch = 0; batch < 8; batch++) {
      const tags = Array.from({ length: 1024 }, (_, i) =>
        createHash('sha256')
          .update(String(batch * 1024 + i))
          .digest()
          .subarray(0, 16),
      )
      expect(await store.add(route, day, tags)).toBe((batch + 1) * 1024)
    }
    await expect(store.add(route, day, [new Uint8Array(16)])).rejects.toThrow('capacity')
    expect((await store.get(route, day)).length).toBe(8192)
    const [name] = await readdir(join(dataDir, 'denials'))
    await chmod(join(dataDir, 'denials', name!), 0o644)
    await expect(store.add(route, day, [])).rejects.toThrow('persistence')
    expect(store.status().healthy).toBe(false)
    await store.close()
  })
})
