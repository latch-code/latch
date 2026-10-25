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
  const receipt = { requestId: randomUUID(), requestHash: 'a'.repeat(64) }
  await profiles.configure(null, [node], profiles.configHash(), receipt)
  expect((await RelayProfiles.open(directory)).configReceipt(receipt.requestId)).toBe(receipt.requestHash)
  const original = profiles.configHash()
  await profiles.configure(null, [])
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
