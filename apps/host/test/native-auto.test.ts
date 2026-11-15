import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import * as files from '@latch/core/node-kit'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeSettings } from '../src/native-settings.ts'
import { selectAutoDirect } from '../src/native-network.ts'
import type { AuditLog } from '../src/audit.ts'
import { RelayProfiles, type NativeDirect } from '../src/relay/profiles.ts'
import type { HostRelayController } from '../src/relay/controller.ts'
import type { NativeNetworkSnapshot } from '../src/native-network-backend.ts'
import type { startNativeHost } from '../src/native.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).toReversed()) await close()
})
const snapshot: NativeNetworkSnapshot = {
  epoch: randomUUID(),
  interfaces: [{ name: 'en0', index: 3, address: '192.168.1.4', prefixLength: 24, kind: 'wifi', gateway: '192.168.1.1' }],
}
async function setup(options: { managedDirect?: { host: string; port: number } } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'latch-auto-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const profiles = await RelayProfiles.open(directory)
  let bound: NativeDirect | null = null,
    pairing = false,
    reachable = false
  const canceled = vi.fn(),
    committed = vi.fn(),
    prepare = vi.fn(),
    changed = vi.fn()
  const native: Awaited<ReturnType<typeof startNativeHost>> = {
    origin: 'https://native.invalid',
    get enabled() {
      return Boolean(bound)
    },
    get port() {
      return bound?.port
    },
    get direct() {
      return bound && { ...bound }
    },
    async prepareBind(next) {
      prepare(next)
      if (next?.host === 'auto') throw new Error('Logical auto reached socket')
      return {
        commit() {
          committed(next)
          bound = next ? { host: next.host, port: next.port || 54321 } : null
        },
        async cancel() {
          canceled(next)
        },
      }
    },
    async ensureTransport() {},
    async invite() {
      throw new Error('unused')
    },
    async acceptRelay(stream: Duplex) {
      stream.destroy()
    },
    async acceptCarrier(stream: Duplex) {
      stream.destroy()
    },
    closeRelay() {},
    async close() {},
  }
  const resolve = vi.fn(async (direct: NativeDirect, current: NativeDirect | null) => selectAutoDirect(snapshot, direct, current))
  const settings = new NativeSettings({
    profiles,
    native,
    audit: { append: async () => ({ seq: 1 }) } as unknown as AuditLog,
    controller: { status: () => [], reconcile() {} } as unknown as HostRelayController,
    pairing: () => pairing,
    reachable: () => reachable,
    changed,
    resolveDirect: resolve,
    ...options,
  })
  return {
    directory,
    profiles,
    native,
    settings,
    prepare,
    canceled,
    resolve,
    changed,
    phones(value: boolean) {
      reachable = value
    },
    sheet(value: boolean) {
      pairing = value
    },
  }
}
it.each(['relay', 'directory'] as const)('keeps an installed relay when a concurrent %s removal joins the write queue', async target => {
  const { settings, profiles, directory } = await setup()
  const old = { relayId: 'a'.repeat(32), url: 'https://old.example/', spkiHash: 'b'.repeat(64) }
  const added = { relayId: 'c'.repeat(32), url: 'https://new.example/', spkiHash: 'd'.repeat(64) }
  await profiles.replace([old])
  const request = { requestId: randomUUID(), requestHash: 'e'.repeat(64), deviceId: 'fixture' }
  const base = profiles.configHash()
  const pending = await profiles.reserveRelay(added, request, base, () => {})
  const { promise: writing, resolve: start } = Promise.withResolvers<void>()
  const { promise: paused, resolve: continueWriting } = Promise.withResolvers<void>()
  const save = files.writeFileAtomic
  const atomic = vi.spyOn(files, 'writeFileAtomic').mockImplementationOnce(async (...args) => {
    start()
    await paused
    return save(...args)
  })
  const install = profiles.installRelay(pending, base, () => {})
  await writing
  const actor = { listener: 'unix' } as const
  const removal = target === 'relay' ? settings.removeRelay(old.relayId, actor) : settings.removeDirectory(actor)
  await Promise.resolve()
  continueWriting()
  await Promise.all([install, removal])
  atomic.mockRestore()
  const saved = await RelayProfiles.open(directory)
  expect(saved.snapshot().profiles.map(profile => profile.relayId)).toEqual(
    target === 'relay' ? [added.relayId] : [old.relayId, added.relayId],
  )
  const installed = saved.snapshot().profiles.find(profile => profile.relayId === added.relayId)
  expect(installed?.seeds.every((seed, slot) => seed === pending.profile.seeds[slot])).toBe(true)
  expect(saved.relayReceipt(request.requestId)?.requestHash).toBe(request.requestHash)
})
it('opens the listener for the sheet, keeps it while a phone exists, and closes it after the last one', async () => {
  const s = await setup()
  expect(s.settings.wanted()).toBe(false)
  expect(s.settings.following()).toBe(false)
  await expect(s.settings.whileOpen(async () => s.native.direct)).resolves.toEqual({ host: '192.168.1.4', port: 54321 })
  // The QR is out: the listener stays through the watcher's turns.
  s.sheet(true)
  await s.settings.syncNetwork(snapshot, () => true)
  expect(s.native.direct).toEqual({ host: '192.168.1.4', port: 54321 })
  // The sheet closes with nobody paired.
  s.sheet(false)
  expect(s.settings.following()).toBe(true)
  await s.settings.syncNetwork(snapshot, () => true)
  expect(s.native.direct).toBeNull()
  expect(s.settings.following()).toBe(false)
  // A paired phone reopens it, on the same port, and only losing the last phone closes it.
  s.phones(true)
  expect(s.settings.following()).toBe(true)
  await s.settings.syncNetwork(snapshot, () => true)
  expect(s.native.direct).toEqual({ host: '192.168.1.4', port: 54321 })
  s.phones(false)
  await s.settings.syncNetwork(snapshot, () => true)
  expect(s.native.direct).toBeNull()
  expect(s.changed).toHaveBeenCalled()
})
it('follows a new physical network and never reopens to a tunnel', async () => {
  const s = await setup()
  s.phones(true)
  await s.settings.syncNetwork(snapshot, () => true)
  await s.settings.syncNetwork(
    { ...snapshot, epoch: randomUUID(), interfaces: [{ ...snapshot.interfaces[0]!, address: '192.168.2.4' }] },
    () => true,
  )
  expect(s.native.direct).toEqual({ host: '192.168.2.4', port: 54321 })
  await s.settings.syncNetwork({ ...snapshot, interfaces: [{ ...snapshot.interfaces[0]!, name: 'utun5', kind: 'tunnel' }] }, () => true)
  expect(s.native.direct).toBeNull()
})
it('refuses a QR with the reason when the Mac has no network, and never binds a wildcard', async () => {
  const s = await setup()
  s.resolve.mockResolvedValueOnce(undefined)
  await expect(s.settings.whileOpen(async () => 'issued')).rejects.toMatchObject({ code: 'native-no-lan' })
  expect(s.prepare).not.toHaveBeenCalled()
})
it('closes an unwanted listener without the network component, and takes another port when the remembered one is gone', async () => {
  const s = await setup()
  s.phones(true)
  await s.settings.syncNetwork(snapshot, () => true)
  s.phones(false)
  await s.settings.release()
  expect(s.native.direct).toBeNull()
  s.phones(true)
  const prepare = s.native.prepareBind.bind(s.native)
  vi.spyOn(s.native, 'prepareBind').mockImplementationOnce(() =>
    Promise.reject(Object.assign(new Error('taken'), { code: 'native-listener-unavailable' })),
  )
  await s.settings.syncNetwork(snapshot, () => true)
  expect(s.native.direct).toEqual({ host: '192.168.1.4', port: 54321 })
  expect(prepare).toBeDefined()
})
it('cancels a late prepared listener after a network epoch changes', async () => {
  const s = await setup()
  s.phones(true)
  await s.settings.syncNetwork(snapshot, () => true)
  await s.settings.syncNetwork({ ...snapshot, interfaces: [{ ...snapshot.interfaces[0]!, address: '192.168.2.4' }] }, () => false)
  expect(s.native.direct).toEqual({ host: '192.168.1.4', port: 54321 })
})
it('leaves a listener fixed by the start options alone', async () => {
  const s = await setup({ managedDirect: { host: '127.0.0.1', port: 4319 } })
  expect(s.settings.following()).toBe(false)
  await s.settings.syncNetwork(snapshot, () => true)
  await expect(s.settings.whileOpen(async () => 'issued')).resolves.toBe('issued')
  expect(s.prepare).not.toHaveBeenCalled()
})
