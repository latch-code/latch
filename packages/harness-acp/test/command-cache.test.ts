import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CommandCache, commandDirectory, commandScope, type CommandCacheEntry } from '../src/command-cache.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const hash = (char: string) => char.repeat(64)
const record = (overrides: Partial<CommandCacheEntry> = {}): CommandCacheEntry => ({
  scope: hash('a'),
  launchHash: hash('b'),
  definitionHash: hash('c'),
  sourceSessionId: 'session-public',
  reportedAt: '2026-01-01T00:00:00.000Z',
  order: 1,
  commands: [{ name: 'public-plan' }],
  ...overrides,
})
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'latch-command-cache-'))
  roots.push(root)
  return root
}

it('keys actual directory identity and project identity separately, including a replaced path', async () => {
  const root = await directory()
  const folder = join(root, 'project')
  await mkdir(folder)
  const before = (await commandDirectory(folder))!
  expect(commandScope(before, 'project-a')).not.toBe(commandScope(before, 'project-b'))
  await rename(folder, join(root, 'old'))
  await mkdir(folder)
  expect(await commandDirectory(folder)).not.toBe(before)
})

it('persists a real empty report privately and refuses a different fingerprint', async () => {
  const root = await directory()
  const cache = new CommandCache(root)
  await cache.load()
  expect(cache.read(hash('a'), hash('b'), hash('c'))).toBeUndefined()
  cache.remember(record({ commands: [] }))
  await cache.close()
  const file = join(root, 'harness-commands.json')
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  const restored = new CommandCache(root)
  await restored.load()
  expect(restored.read(hash('a'), hash('b'), hash('c'))?.commands).toEqual([])
  expect(restored.read(hash('a'), hash('d'), hash('c'))).toBeUndefined()
  expect(restored.read(hash('a'), hash('b'), hash('d'))).toBeUndefined()
  expect(restored.nextOrder()).toBeGreaterThan(1)
  await restored.close()
})

it('keeps public skills under the same cache fingerprint and rejects private skill fields', async () => {
  const root = await directory()
  const cache = new CommandCache(root)
  await cache.load()
  const skills = [{ name: 'known', invocation: '$known', scope: 'project' as const }]
  cache.remember(record({ skills }))
  await cache.close()
  const restored = new CommandCache(root)
  await restored.load()
  expect(restored.read(hash('a'), hash('b'), hash('c'))?.skills).toEqual(skills)
  expect(restored.read(hash('a'), hash('d'), hash('c'))).toBeUndefined()
  await restored.close()
  const file = join(root, 'harness-commands.json')
  const saved = JSON.parse(await readFile(file, 'utf8'))
  saved.entries[0].skills[0].path = '/private/native-skill/SKILL.md'
  await writeFile(file, JSON.stringify(saved), { mode: 0o600 })
  const invalid = new CommandCache(root)
  await invalid.load()
  expect(invalid.read(hash('a'), hash('b'), hash('c'))).toBeUndefined()
  await invalid.close()
})

it('orders async reports by receipt ordinal rather than wall clock and does not restore a removed entry on write completion', async () => {
  const root = await directory()
  const cache = new CommandCache(root)
  await cache.load()
  const earlier = cache.nextOrder()
  const later = cache.nextOrder()
  cache.remember(record({ order: later, reportedAt: '2025-01-01T00:00:00.000Z', commands: [{ name: 'newer' }] }))
  cache.remember(record({ order: earlier, reportedAt: '2027-01-01T00:00:00.000Z', commands: [{ name: 'older' }] }))
  expect(cache.read(hash('a'), hash('b'), hash('c'))?.commands).toEqual([{ name: 'newer' }])
  // The first atomic write is still pending when deletion and the replacement write are queued.
  cache.forget('session-public')
  await cache.close()
  const restored = new CommandCache(root)
  await restored.load()
  expect(restored.read(hash('a'), hash('b'), hash('c'))).toBeUndefined()
  await restored.close()
})

it('drops old definitions without treating saved command text as capability evidence', async () => {
  const root = await directory()
  const cache = new CommandCache(root)
  await cache.load()
  cache.remember(record())
  cache.retainDefinition(hash('d'))
  await cache.close()
  expect(JSON.parse(await readFile(join(root, 'harness-commands.json'), 'utf8')).entries).toEqual([])
})

it('evicts whole older catalogues to bound entry count and encoded file size', async () => {
  const root = await directory()
  const cache = new CommandCache(root)
  await cache.load()
  for (let index = 1; index <= 70; index++) cache.remember(record({ scope: index.toString(16).padStart(64, '0'), order: index }))
  const large = Array.from({ length: 200 }, (_, index) => ({ name: `command-${index}`, description: '界'.repeat(1000) }))
  for (let index = 71; index <= 75; index++)
    cache.remember(record({ scope: index.toString(16).padStart(64, '0'), order: index, commands: large }))
  await cache.close()
  const bytes = await readFile(join(root, 'harness-commands.json'))
  expect(bytes.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024)
  const saved = JSON.parse(bytes.toString('utf8')) as { entries: CommandCacheEntry[] }
  expect(saved.entries.length).toBeLessThanOrEqual(64)
  expect(saved.entries.at(-1)?.commands).toHaveLength(200)
  expect(saved.entries.some(item => item.order === 1)).toBe(false)
})

it.each(['corrupt', 'oversized', 'unknown-field', 'duplicate-scope'])('treats %s stored data as a cache miss', async kind => {
  const root = await directory()
  const item = record()
  const data =
    kind === 'corrupt'
      ? '{'
      : kind === 'oversized'
        ? ' '.repeat(2 * 1024 * 1024 + 1)
        : JSON.stringify({
            version: 1,
            entries: kind === 'duplicate-scope' ? [item, item] : [{ ...item, privatePath: '/must-not-be-read' }],
          })
  await writeFile(join(root, 'harness-commands.json'), data, { mode: 0o600 })
  const cache = new CommandCache(root)
  await cache.load()
  expect(cache.read(item.scope, item.launchHash, item.definitionHash)).toBeUndefined()
  await cache.close()
})

it.skipIf(process.platform === 'win32')('does not follow a symlink or accept group-readable cache data', async () => {
  const root = await directory()
  const target = join(root, 'other.json')
  const file = join(root, 'harness-commands.json')
  await writeFile(target, JSON.stringify({ version: 1, entries: [record()] }), { mode: 0o600 })
  await symlink(target, file)
  const linked = new CommandCache(root)
  await linked.load()
  expect(linked.read(hash('a'), hash('b'), hash('c'))).toBeUndefined()
  await linked.close()
  await rm(file)
  await rename(target, file)
  await chmod(file, 0o640)
  const readable = new CommandCache(root)
  await readable.load()
  expect(readable.read(hash('a'), hash('b'), hash('c'))).toBeUndefined()
  await readable.close()
})
