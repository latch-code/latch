import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LaunchTrust, launchTrustKey } from '../src/launch-trust.ts'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'latch-trust-'))
  roots.push(root)
  return root
}
describe('OS launch approval trust', () => {
  it('persists only tuple hashes privately and keeps every device, launch, project, root and root order distinct', async () => {
    const root = await temporary()
    const input = { deviceId: 'device', harnessId: 'agent', launchHash: 'a'.repeat(64), projectId: 'project', roots: ['/a', '/b'] }
    const key = launchTrustKey(input)
    const trust = await LaunchTrust.open(root)
    await Promise.all([trust.remember(key), trust.remember(key)])
    const restored = await LaunchTrust.open(root)
    expect(restored.has(key)).toBe(true)
    for (const patch of [
      { deviceId: 'other' },
      { harnessId: 'other' },
      { launchHash: 'b'.repeat(64) },
      { projectId: 'other' },
      { roots: ['/a', '/c'] },
      { roots: ['/b', '/a'] },
    ])
      expect(restored.has(launchTrustKey({ ...input, ...patch }))).toBe(false)
    expect((await stat(join(root, 'launch-trust.json'))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(root, 'launch-trust.json'), 'utf8')).not.toContain('project')
  })
  it('preserves malformed state and does not publish a write that failed', async () => {
    const root = await temporary()
    const file = join(root, 'launch-trust.json')
    await writeFile(file, 'broken')
    await expect(LaunchTrust.open(root)).rejects.toMatchObject({ code: 'config-corrupt' })
    expect(await readFile(file, 'utf8')).toBe('broken')
    await rm(file)
    const trust = await LaunchTrust.open(root)
    await mkdir(file)
    await expect(trust.remember('a'.repeat(64))).rejects.toBeDefined()
    expect(trust.has('a'.repeat(64))).toBe(false)
  })
})
