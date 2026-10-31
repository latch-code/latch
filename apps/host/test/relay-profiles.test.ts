import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { RelayProfiles } from '../src/relay/profiles.ts'

const folders: string[] = []
afterEach(async () => {
  for (const directory of folders.splice(0)) await rm(directory, { recursive: true, force: true })
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'latch-relay-profiles-'))
  folders.push(directory)
  return { directory, profiles: await RelayProfiles.open(directory) }
}
function input() {
  return {
    relayId: randomBytes(16).toString('hex'),
    url: 'https://relay.example/',
    spkiHash: randomBytes(32).toString('hex'),
    registrationKey: `lrt1.${randomBytes(32).toString('base64url')}`,
  }
}
it('persists private state, preserves an omitted registration secret, and serializes monotonic generations', async () => {
  const { directory, profiles } = await fixture(),
    node = input()
  await profiles.replace([node])
  const key = profiles.snapshot().profiles[0]!.registrationKey
  await profiles.replace([{ relayId: node.relayId, url: node.url, spkiHash: node.spkiHash }])
  expect(profiles.snapshot().profiles[0]!.registrationKey === key).toBe(true)
  const generations = await Promise.all(Array.from({ length: 12 }, () => profiles.nextGeneration()))
  expect(new Set(generations).size).toBe(12)
  const reopened = await RelayProfiles.open(directory)
  expect(reopened.snapshot().generation).toBe(generations.at(-1))
  await profiles.rotateDiscovery('a'.repeat(64))
  const discovery = profiles.snapshot().discoveryKey
  await (await RelayProfiles.open(directory)).rotateDiscovery('a'.repeat(64))
  expect((await RelayProfiles.open(directory)).snapshot().discoveryKey).toBe(discovery)
  await profiles.rotateDiscovery('b'.repeat(64))
  expect(profiles.snapshot().discoveryKey === discovery).toBe(false)
  const receipt = { requestId: randomUUID(), requestHash: 'a'.repeat(64) }
  await profiles.configure(null, [node], profiles.configHash(), receipt)
  expect((await RelayProfiles.open(directory)).configReceipt(receipt.requestId)).toBe(receipt.requestHash)
  const original = profiles.configHash()
  await profiles.configure({ host: '127.0.0.1', port: 0 }, [node])
  await profiles.configure(null, [node])
  expect(profiles.configHash() === original).toBe(false)
  await expect(profiles.configure(null, [], original)).rejects.toMatchObject({ code: 'native-config-changed' })
  expect((await stat(join(directory, 'native/relays.json'))).mode & 0o077).toBe(0)
  await profiles.replace([{ ...node, registrationKey: null }])
  expect(profiles.snapshot().profiles[0]!.registrationKey).toBeUndefined()
})
it('rotates to the preissued seed once, replaces both seeds twice, and refuses a third same-day conflict', async () => {
  const { profiles } = await fixture(),
    node = input()
  await profiles.replace([node])
  const before = profiles.snapshot().profiles[0]!
  await profiles.rotate(node.relayId, 20000)
  const first = profiles.snapshot().profiles[0]!
  expect(first.activeSlot).toBe(1)
  expect(first.seeds[0] === before.seeds[0] && first.seeds[1] === before.seeds[1]).toBe(true)
  await profiles.rotate(node.relayId, 20000)
  const second = profiles.snapshot().profiles[0]!
  expect(second.activeSlot).toBe(0)
  expect(second.seeds[0] !== first.seeds[0] && second.seeds[1] !== first.seeds[1]).toBe(true)
  await expect(profiles.rotate(node.relayId, 20000)).rejects.toMatchObject({ code: 'native-relay-rotation-limit' })
  expect(profiles.snapshot().profiles[0]!.rotations).toBe(2)
  await profiles.rotate(node.relayId, 20001)
  expect(profiles.snapshot().profiles[0]!.rotations).toBe(1)
})
it('refuses symlink or overly readable configuration while preserving invalid bytes', async () => {
  const { directory } = await fixture(),
    path = join(directory, 'native/relays.json')
  await chmod(path, 0o644)
  await expect(RelayProfiles.open(directory)).rejects.toMatchObject({ code: 'native-relay-invalid' })
  await chmod(path, 0o600)
  await writeFile(path, '{broken')
  await expect(RelayProfiles.open(directory)).rejects.toMatchObject({ code: 'native-relay-invalid' })
  expect(await readFile(path, 'utf8')).toBe('{broken')
  await rm(path)
  await symlink(join(directory, 'outside'), path)
  await expect(RelayProfiles.open(directory)).rejects.toMatchObject({ code: 'native-relay-invalid' })
})
it('keeps compiled-in relays as built-in profiles with lasting seeds, apart from configured ones', async () => {
  const { directory, profiles } = await fixture()
  const tokyo = { relayId: 'a'.repeat(32), url: 'https://tokyo.relay.example/', spkiHash: 'b'.repeat(64) }
  const custom = { relayId: 'c'.repeat(32), url: 'https://home.example/', spkiHash: 'd'.repeat(64) }
  await profiles.syncOfficial([])
  expect(profiles.snapshot().profiles).toEqual([])
  await profiles.replace([custom])
  await profiles.syncOfficial([tokyo])
  const seeded = profiles.snapshot().profiles.find(item => item.relayId === tokyo.relayId)!
  expect(seeded.builtIn).toBe(true)
  expect(profiles.snapshot().profiles.find(item => item.relayId === custom.relayId)?.builtIn).toBeUndefined()
  // A restart with the same list changes nothing; the seeds outlive a moved address.
  const generation = profiles.snapshot().generation
  await profiles.syncOfficial([tokyo])
  expect(profiles.snapshot().generation).toBe(generation)
  await profiles.syncOfficial([{ ...tokyo, url: 'https://tokyo2.relay.example/' }])
  expect(profiles.snapshot().profiles.find(item => item.relayId === tokyo.relayId)?.seeds).toEqual(seeded.seeds)
  // Editing configured relays leaves them alone, and dropping one from the list removes it.
  await profiles.replace([])
  expect(profiles.snapshot().profiles.map(item => item.relayId)).toEqual([tokyo.relayId])
  await profiles.syncOfficial([])
  expect(profiles.snapshot().profiles).toEqual([])
  expect((await RelayProfiles.open(directory)).snapshot().profiles).toEqual([])
})
