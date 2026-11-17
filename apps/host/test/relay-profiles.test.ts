import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as files from '@latch/core/node-kit'
import { RelayProfiles } from '../src/relay/profiles.ts'

const folders: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
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
it('reserves one unpublished route across restart and atomically installs it with the original receipt', async () => {
  const { directory, profiles } = await fixture()
  const node = input()
  const request = { requestId: randomUUID(), requestHash: 'b'.repeat(64), deviceId: 'local-fixture' }
  const base = profiles.configHash()
  const pending = await profiles.reserveRelay(node, request, base, () => {})
  expect(profiles.snapshot().profiles).toEqual([])
  expect(profiles.configHash()).toBe(base)
  const restarted = await RelayProfiles.open(directory)
  expect(restarted.snapshot().profiles).toEqual([])
  expect(restarted.snapshot().pendingRelay?.requestId).toBe(request.requestId)
  const retried = await restarted.reserveRelay(node, request, base, () => {})
  expect(retried.profile.seeds.every((seed, index) => seed === pending.profile.seeds[index])).toBe(true)
  await expect(restarted.reserveRelay(node, { ...request, requestHash: 'c'.repeat(64) }, base, () => {})).rejects.toMatchObject({
    code: 'native-relay-pending',
  })
  await expect(
    restarted.installRelay(retried, base, () => {
      throw new Error('Scope revoked')
    }),
  ).rejects.toThrow('Scope revoked')
  await restarted.installRelay(retried, base, () => {})
  const saved = await RelayProfiles.open(directory)
  expect(saved.snapshot().pendingRelay).toBeUndefined()
  expect(saved.snapshot().profiles[0]?.relayId).toBe(node.relayId)
  expect(saved.snapshot().profiles[0]?.seeds.every((seed, index) => seed === pending.profile.seeds[index])).toBe(true)
  expect(saved.relayReceipt(request.requestId)?.requestHash).toBe(request.requestHash)
  await expect(saved.reserveRelay(node, request, base, () => {})).rejects.toMatchObject({ code: 'native-config-changed' })
})
it('abandoning a reserved relay keeps its receipt and blocks a late install', async () => {
  const { directory, profiles } = await fixture()
  const request = { requestId: randomUUID(), requestHash: 'c'.repeat(64), deviceId: 'local-fixture' }
  const node = input()
  const base = profiles.configHash()
  const pending = await profiles.reserveRelay(node, request, base, () => {})
  expect(
    await profiles.cancelRelay(
      request.requestId,
      () => {},
      async () => true,
    ),
  ).toEqual({ cancelled: true, audited: true })
  await expect(profiles.installRelay(pending, base, () => {})).rejects.toMatchObject({ code: 'native-relay-cancelled' })
  const saved = await RelayProfiles.open(directory)
  expect(saved.snapshot().pendingRelay).toBeUndefined()
  expect(saved.snapshot().profiles).toEqual([])
  expect(saved.relayReceipt(request.requestId)?.cancelled).toBe(true)
})
it.each(['admin', 'egress'])('checks %s again after flushing the temporary profile and before replacing it', async guard => {
  const { directory, profiles } = await fixture()
  const node = input()
  const request = { requestId: randomUUID(), requestHash: 'd'.repeat(64), deviceId: 'fixture' }
  const base = profiles.configHash()
  const pending = await profiles.reserveRelay(node, request, base, () => {})
  let authorized = true
  const write = files.writeFileAtomic
  vi.spyOn(files, 'writeFileAtomic').mockImplementationOnce((path, contents, options) => {
    const commit = options?.fs
    if (!commit) {
      authorized = false
      return write(path, contents, options)
    }
    return write(path, contents, {
      ...options,
      fs: {
        ...commit,
        rename(from, to) {
          authorized = false
          return commit.rename(from, to)
        },
      },
    })
  })
  await expect(
    profiles.installRelay(pending, base, () => {
      if (!authorized) throw new Error(`Lost ${guard} permission`)
    }),
  ).rejects.toThrow(`Lost ${guard} permission`)
  const saved = await RelayProfiles.open(directory)
  expect(saved.snapshot().profiles).toEqual([])
  expect(saved.snapshot().pendingRelay?.requestId).toBe(request.requestId)
  expect(saved.relayReceipt(request.requestId)).toBeUndefined()
})
it('keeps an unconfirmed replacement from being overwritten and settles its original receipt', async () => {
  const { directory, profiles } = await fixture()
  const node = input()
  const request = { requestId: randomUUID(), requestHash: 'f'.repeat(64), deviceId: 'fixture' }
  const base = profiles.configHash()
  const pending = await profiles.reserveRelay(node, request, base, () => {})
  const write = files.writeFileAtomic
  const atomic = vi.spyOn(files, 'writeFileAtomic').mockImplementationOnce(async (...args) => {
    await write(...args)
    throw new Error('Directory sync outcome unavailable')
  })
  await expect(profiles.installRelay(pending, base, () => {})).rejects.toMatchObject({ code: 'native-relay-write-unknown' })
  expect(profiles.snapshot().profiles).toEqual([])
  expect(profiles.relayReceipt(request.requestId)).toBeUndefined()
  vi.spyOn(files, 'syncDirectory').mockRejectedValueOnce(new Error('Directory still unavailable'))
  await expect(profiles.nextGeneration()).rejects.toMatchObject({ code: 'native-relay-write-unknown' })
  expect(atomic).toHaveBeenCalledTimes(1)
  expect(await profiles.settleWrite()).toBe(true)
  expect(profiles.relayReceipt(request.requestId)?.requestHash).toBe(request.requestHash)
  expect(profiles.snapshot().profiles[0]?.relayId).toBe(node.relayId)
  expect((await RelayProfiles.open(directory)).relayReceipt(request.requestId)?.requestHash).toBe(request.requestHash)
  expect(await profiles.settleWrite()).toBe(false)
  expect(atomic).toHaveBeenCalledTimes(1)
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
  const tokyo = { relayId: 'a'.repeat(32), kind: 'self' as const, url: 'https://tokyo.relay.example/', spkiHash: 'b'.repeat(64) }
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
