import { mkdtemp, readFile, rm, chmod, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { gatewayHash } from '@latch/link-wire'
import { nodeCrypto } from '@latch/link-client'
import { AuditLog } from '../src/audit.ts'
import { NativeNetwork } from '../src/native-network.ts'
import { NativeNetworks, knownNetworkHash } from '../src/native-networks.ts'
import {
  networkSnapshotSchema,
  type NativeNetworkBackend,
  type NativeNetworkSnapshot,
  type NativeNetworkService,
} from '../src/native-network-backend.ts'
import { RelayProfiles } from '../src/relay/profiles.ts'
import type { NativeOpening } from '../src/native.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0).toReversed()) await close()
})
const row = { name: 'en0', index: 3, address: '192.168.1.4', prefixLength: 24, kind: 'wifi' as const, gateway: '192.168.1.1' }
class Backend implements NativeNetworkBackend {
  state: NativeNetworkSnapshot = { epoch: randomUUID(), interfaces: [row] }
  services: NativeNetworkService[] = []
  calls: Array<{ services: NativeNetworkService[]; epoch: string }> = []
  peerMac: string | null = '00:22:33:44:55:66'
  gatewayMac: string | null = '00:11:22:33:44:55'
  changes = new Set<(snapshot: NativeNetworkSnapshot) => void>()
  statuses = new Set<(status: 'off' | 'starting' | 'ready' | 'blocked' | 'conflict') => void>()
  closed = false
  async snapshot() {
    return structuredClone(this.state)
  }
  async publish(services: NativeNetworkService[], epoch: string) {
    if (epoch !== this.state.epoch) throw new Error('Network changed')
    this.services = structuredClone(services)
    this.calls.push({ services, epoch })
  }
  /** Each interface answers with its own router, as the helper reads it per service. */
  async neighbors(index: number = row.index, source: string = row.address) {
    const own = this.state.interfaces.find(item => item.index === index && item.gateway && isIP(item.address) === isIP(source))
    return { epoch: this.state.epoch, peerMac: this.peerMac, gatewayMac: this.gatewayMac, gateway: own?.gateway ?? null }
  }
  onChange(listener: (snapshot: NativeNetworkSnapshot) => void) {
    this.changes.add(listener)
    return () => {
      this.changes.delete(listener)
    }
  }
  onStatus(listener: Parameters<NativeNetworkBackend['onStatus']>[0]) {
    this.statuses.add(listener)
    return () => {
      this.statuses.delete(listener)
    }
  }
  change(interfaces: NativeNetworkSnapshot['interfaces'] = [row]) {
    this.services = []
    this.state = { epoch: randomUUID(), interfaces }
    for (const listener of this.changes) listener(this.state)
  }
  async close() {
    this.closed = true
  }
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'latch-network-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const profiles = await RelayProfiles.open(directory),
    networks = await NativeNetworks.open(directory),
    audit = await AuditLog.open(directory),
    backend = new Backend()
  cleanups.push(() => audit.close())
  let pairing = false,
    ready = true,
    direct: { host: string; port: number } | null = { host: row.address, port: 4319 }
  const hooks = { wake: async (_gateway: string, _local: string): Promise<void> => {} }
  const controller = new NativeNetwork({
    profiles,
    networks,
    audit,
    backend: async () => backend,
    direct: () => direct,
    pairing: () => pairing,
    discoveryReady: () => ready,
    wake: (gateway, local) => hooks.wake(gateway, local),
  })
  cleanups.push(() => controller.close())
  await vi.waitFor(() => expect(controller.lan()).toHaveLength(1))
  const opening: NativeOpening = {
    deviceId: `dev_${'A'.repeat(22)}`,
    pairing: false,
    source: '192.168.1.9',
    localAddress: row.address,
    listener: { listener: 'native-direct', origin: 'https://native.invalid' },
  }
  const hash = await gatewayHash(nodeCrypto, row.address, row.prefixLength, row.gateway)
  return {
    hooks,
    directory,
    profiles,
    networks,
    audit,
    backend,
    controller,
    opening,
    hash,
    pair(value: boolean) {
      pairing = value
      controller.reconcile()
    },
    ready(value: boolean) {
      ready = value
      controller.invalidate()
    },
    bind(value: typeof direct) {
      direct = value
      controller.invalidate()
    },
  }
}
it('advertises only in pairing or a proven known network, privately persists only the strong network hash, and emits usable LAN metadata', async () => {
  const s = await setup()
  expect(s.backend.services).toHaveLength(0)
  expect(s.controller.lan()[0]).toEqual({ address: row.address, port: 4319, kind: 'wifi', prefixLength: 24, gatewayHash: s.hash })
  s.pair(true)
  await vi.waitFor(() => expect(s.backend.services).toHaveLength(1))
  expect(s.backend.services[0]).toMatchObject({
    instance: expect.stringMatching(/^[a-z2-7]{12}$/u),
    alternate: expect.stringMatching(/^[a-z2-7]{12}$/u),
    index: row.index,
  })
  s.pair(false)
  await vi.waitFor(() => expect(s.backend.services).toHaveLength(0))
  expect(await s.controller.nearby(s.opening, s.hash, () => {})).toBe(true)
  await vi.waitFor(() => expect(s.backend.services).toHaveLength(1))
  const content = await readFile(join(s.directory, 'native/networks.json'), 'utf8')
  expect(content).toContain(knownNetworkHash(row, s.backend.gatewayMac!))
  for (const privateValue of [row.address, row.gateway, s.backend.peerMac!, s.backend.gatewayMac!])
    expect(content).not.toContain(privateValue)
  expect((await NativeNetworks.open(s.directory)).has(knownNetworkHash(row, s.backend.gatewayMac!))).toBe(true)
  expect(await readFile(join(s.directory, 'audit.jsonl'), 'utf8')).not.toContain(row.address)
})
it.each(['relay', 'tunnel', 'gateway-peer', 'unknown-peer', 'wrong-gateway', 'foreign-source', 'own-source', 'other-receiver'] as const)(
  'fails proximity closed for %s without granting a device scope',
  async reason => {
    const s = await setup()
    if (reason === 'relay') s.opening.listener = { ...s.opening.listener, listener: 'native-relay' }
    if (reason === 'tunnel') s.backend.change([{ ...row, kind: 'tunnel' }])
    if (reason === 'gateway-peer') s.backend.peerMac = s.backend.gatewayMac
    if (reason === 'unknown-peer') s.backend.peerMac = null
    if (reason === 'foreign-source') s.opening.source = '192.168.2.9'
    if (reason === 'own-source') s.opening.source = row.address
    if (reason === 'other-receiver') s.opening.localAddress = '192.168.1.6'
    expect(await s.controller.nearby(s.opening, reason === 'wrong-gateway' ? new Uint8Array(32) : s.hash, () => {})).toBe(false)
    expect(s.networks.has(knownNetworkHash(row, s.backend.gatewayMac!))).toBe(false)
  },
)
it('cancels old network proofs and advertisements on a network epoch change, even if old neighbor reads complete late', async () => {
  const s = await setup()
  s.pair(true)
  await vi.waitFor(() => expect(s.backend.services).toHaveLength(1))
  let resolve!: (value: Awaited<ReturnType<Backend['neighbors']>>) => void
  const old = await s.backend.neighbors()
  vi.spyOn(s.backend, 'neighbors').mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      }),
  )
  const proof = s.controller.nearby(s.opening, s.hash, () => {})
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  s.backend.change([{ ...row, address: '192.168.2.4' }])
  resolve(old)
  expect(await proof).toBe(false)
  expect(s.controller.lan()).toHaveLength(0)
  expect(s.backend.services).toHaveLength(0)
  expect(s.networks.has(knownNetworkHash(row, s.backend.gatewayMac!))).toBe(false)
})
it('stops discovery while revocation key rotation is pending, then uses fresh anonymous names', async () => {
  const s = await setup()
  s.pair(true)
  await vi.waitFor(() => expect(s.backend.services).toHaveLength(1))
  const old = s.backend.services[0]!.instance
  s.ready(false)
  await vi.waitFor(() => expect(s.backend.services).toHaveLength(0))
  await s.profiles.rotateDiscovery('a'.repeat(64))
  s.ready(true)
  await vi.waitFor(() => expect(s.backend.services).toHaveLength(1))
  expect(s.backend.services[0]!.instance).not.toBe(old)
})
it('requires the current device/window before remembering a network and does not proceed after audit failure', async () => {
  const s = await setup()
  const append = vi.spyOn(s.audit, 'append').mockRejectedValueOnce(new Error('fixture audit unavailable'))
  await expect(s.controller.nearby(s.opening, s.hash, () => {})).rejects.toThrow('fixture audit unavailable')
  expect(s.networks.has(knownNetworkHash(row, s.backend.gatewayMac!))).toBe(false)
  append.mockRestore()
  let count = 0
  await expect(
    s.controller.nearby(s.opening, s.hash, () => {
      if (++count > 1) throw new Error('fixture window expired')
    }),
  ).rejects.toThrow('window expired')
  expect(s.networks.has(knownNetworkHash(row, s.backend.gatewayMac!))).toBe(false)
})
it('rejects malformed platform prefixes and mismatched gateway families at the schema boundary', () => {
  expect(networkSnapshotSchema.safeParse({ epoch: randomUUID(), interfaces: [{ ...row, prefixLength: 64 }] }).success).toBe(false)
  expect(networkSnapshotSchema.safeParse({ epoch: randomUUID(), interfaces: [{ ...row, gateway: 'fd00::1' }] }).success).toBe(false)
  expect(knownNetworkHash(row, '00:11:22:33:44:55')).toHaveLength(64)
})
it('refuses permissive or malformed persisted network records without replacing them', async () => {
  const s = await setup(),
    path = join(s.directory, 'native/networks.json')
  await chmod(path, 0o644)
  await expect(NativeNetworks.open(s.directory)).rejects.toMatchObject({ code: 'native-network-invalid' })
  await chmod(path, 0o600)
  await writeFile(path, '{broken')
  await expect(NativeNetworks.open(s.directory)).rejects.toMatchObject({ code: 'native-network-invalid' })
  expect(await readFile(path, 'utf8')).toBe('{broken')
})

it('chooses only current physical private addresses for auto binding and preserves the actual ephemeral port', async () => {
  const { selectAutoDirect } = await import('../src/native-network.ts')
  const snapshot: NativeNetworkSnapshot = {
    epoch: randomUUID(),
    interfaces: [
      { ...row, name: 'utun4', kind: 'tunnel', address: '10.0.0.4' },
      { ...row, address: '169.254.1.4' },
      { ...row, address: '8.8.8.8' },
      { ...row, address: 'fd01::4', prefixLength: 64, gateway: 'fd01::1' },
      row,
    ],
  }
  expect(selectAutoDirect(snapshot, { host: 'auto', port: 0 }, null)).toEqual({ host: row.address, port: 0 })
  expect(selectAutoDirect(snapshot, { host: 'auto', port: 0 }, { host: row.address, port: 54321 })).toEqual({
    host: row.address,
    port: 54321,
  })
  expect(
    selectAutoDirect({ ...snapshot, interfaces: [] }, { host: 'auto', port: 4319 }, { host: row.address, port: 54321 }),
  ).toBeUndefined()
  expect(selectAutoDirect(snapshot, { host: 'auto', port: 4319 }, { host: row.address, port: 54321 })).toEqual({
    host: row.address,
    port: 4319,
  })
})

it('starts one system observer for automatic mode, follows new epochs, and releases it on disable', async () => {
  const s = await setup()
  await s.controller.close()
  const { selectAutoDirect } = await import('../src/native-network.ts'),
    backend = new Backend(),
    factory = vi.fn(async () => backend)
  let bound: { host: string; port: number } | null = null,
    automatic = true
  const controller = new NativeNetwork({
    profiles: s.profiles,
    audit: s.audit,
    networks: s.networks,
    backend: factory,
    direct: () => bound,
    automatic: () => automatic,
    pairing: () => true,
    discoveryReady: () => true,
    async rebind(snapshot) {
      const next = selectAutoDirect(snapshot, { host: 'auto', port: 4319 }, bound)
      bound = next ?? null
    },
  })
  cleanups.push(() => controller.close())
  await Promise.all([
    controller.resolveDirect({ host: 'auto', port: 4319 }, null),
    controller.resolveDirect({ host: 'auto', port: 4319 }, null),
  ])
  await vi.waitFor(() => expect(bound).toEqual({ host: row.address, port: 4319 }))
  expect(factory).toHaveBeenCalledTimes(1)
  backend.change([{ ...row, address: '192.168.2.4' }])
  await vi.waitFor(() => expect(bound).toEqual({ host: '192.168.2.4', port: 4319 }))
  automatic = false
  bound = null
  controller.invalidate()
  await vi.waitFor(() => expect(backend.closed).toBe(true))
})

it('repairs a changed durable revocation set before advertising again, including record pruning without an onRevoked callback', async () => {
  const s = await setup()
  await s.controller.close()
  const backend = new Backend()
  let revocationsHash = '1'.repeat(64)
  const synchronize = vi.fn(() => s.profiles.rotateDiscovery(revocationsHash))
  const controller = new NativeNetwork({
    profiles: s.profiles,
    audit: s.audit,
    networks: s.networks,
    backend: async () => backend,
    direct: () => ({ host: row.address, port: 4319 }),
    pairing: () => true,
    discoveryReady: () => s.profiles.snapshot().discoveryRevocationsHash === revocationsHash,
    synchronizeDiscovery: synchronize,
  })
  cleanups.push(() => controller.close())
  await vi.waitFor(() => expect(backend.services).toHaveLength(1))
  const old = backend.services[0]!.instance
  revocationsHash = '2'.repeat(64)
  controller.reconcile()
  await vi.waitFor(() => expect(backend.services[0]?.instance).not.toBe(old))
  await vi.waitFor(() => expect(backend.services).toHaveLength(1))
  expect(synchronize).toHaveBeenCalledTimes(2)
  expect(s.profiles.snapshot().discoveryRevocationsHash).toBe(revocationsHash)
})
const pairingOpening = (source: string): NativeOpening => ({
  deviceId: `inv_${'A'.repeat(22)}`,
  pairing: true,
  source,
  localAddress: row.address,
  listener: { listener: 'native-direct', origin: 'https://native.invalid' },
})
it('proves a pairing socket only for a neighbour on this interface, and remembers the network only when told', async () => {
  const s = await setup()
  const network = knownNetworkHash(row, s.backend.gatewayMac!)
  expect(await s.controller.pairingNearby(pairingOpening('192.168.1.9'), s.hash)).toBe(network)
  expect((await NativeNetworks.open(s.directory)).has(network)).toBe(false)
  await s.controller.remember(network)
  expect((await NativeNetworks.open(s.directory)).has(network)).toBe(true)
  // Another subnet, a phone on another network, and a routed peer the neighbour table does not show.
  expect(await s.controller.pairingNearby(pairingOpening('10.0.0.9'), s.hash)).toBe(false)
  expect(await s.controller.pairingNearby(pairingOpening('192.168.1.9'), new Uint8Array(32))).toBe(false)
  s.backend.peerMac = null
  expect(await s.controller.pairingNearby(pairingOpening('192.168.1.9'), s.hash)).toBe(false)
  s.backend.peerMac = '00:22:33:44:55:66'
  s.backend.gatewayMac = null
  expect(await s.controller.pairingNearby(pairingOpening('192.168.1.9'), s.hash)).toBe(false)
})
it('asks the router to show itself when the system has not met it, as on a Mac whose default route is a cable', async () => {
  const s = await setup()
  const known = s.backend.gatewayMac!
  s.backend.gatewayMac = null
  const asked: string[] = []
  s.hooks.wake = async (gateway, local) => {
    asked.push(`${local}>${gateway}`)
    s.backend.gatewayMac = known
  }
  expect(await s.controller.pairingNearby(pairingOpening('192.168.1.9'), s.hash)).toBe(knownNetworkHash(row, known))
  expect(asked).toEqual([`${row.address}>${row.gateway}`])
  // A router that never answers still fails closed, after two tries.
  s.backend.gatewayMac = null
  asked.length = 0
  s.hooks.wake = async gateway => void asked.push(gateway)
  expect(await s.controller.pairingNearby(pairingOpening('192.168.1.8'), s.hash)).toBe(false)
  expect(asked).toEqual([row.gateway, row.gateway])
})
it('accepts the gateway as the peer only when the peer really is the gateway, and only for pairing', async () => {
  const s = await setup()
  const hotspot = () => s.controller.pairingNearby(pairingOpening(row.gateway), s.hash)
  s.backend.peerMac = s.backend.gatewayMac
  expect(await hotspot()).toBeTypeOf('string')
  // Something else behind the router's MAC: forwarded traffic, not a neighbour.
  expect(await s.controller.pairingNearby(pairingOpening('192.168.1.9'), s.hash)).toBe(false)
  // Daily proximity keeps the strict rule.
  expect(await s.controller.nearby({ ...s.opening, source: row.gateway }, s.hash, () => {})).toBe(false)
  // A gateway whose MAC differs from the peer's at the gateway's own address is not this case, and stays a plain neighbour.
  s.backend.peerMac = '00:22:33:44:55:66'
  expect(await hotspot()).toBeTypeOf('string')
})
it('fails closed for relay paths, without a local address, and when the neighbour lookup breaks', async () => {
  const s = await setup()
  const relay = pairingOpening('192.168.1.9')
  relay.listener = { listener: 'native-relay', origin: 'https://native.invalid' }
  expect(await s.controller.pairingNearby(relay, s.hash)).toBe(false)
  const { localAddress: _none, ...unbound } = pairingOpening('192.168.1.9')
  expect(await s.controller.pairingNearby(unbound, s.hash)).toBe(false)
  vi.spyOn(s.backend, 'neighbors').mockRejectedValueOnce(new Error('helper gone'))
  expect(await s.controller.pairingNearby(pairingOpening('192.168.1.9'), s.hash)).toBe(false)
  // A changed network between lookup and answer proves nothing.
  vi.spyOn(s.backend, 'neighbors').mockResolvedValueOnce({
    epoch: randomUUID(),
    peerMac: s.backend.peerMac,
    gatewayMac: s.backend.gatewayMac,
    gateway: row.gateway,
  })
  expect(await s.controller.pairingNearby(pairingOpening('192.168.1.9'), s.hash)).toBe(false)
})

// This Mac's shape: traffic goes over the USB adapter (primary), and the phone is on the Wi‑Fi beside it.
const wired = { name: 'en13', index: 33, address: '10.40.12.20', prefixLength: 22, kind: 'ethernet' as const, gateway: '10.40.12.1' }
const wifi = { name: 'en0', index: 14, address: '10.60.40.8', prefixLength: 19, kind: 'wifi' as const, gateway: '10.60.32.1' }
const onWifi = (source: string): NativeOpening => ({ ...pairingOpening(source), localAddress: wifi.address })
it('matches a phone on the Wi‑Fi by the Wi‑Fi router when the cable is the primary interface, never by the cable’s router', async () => {
  const s = await setup()
  const { gateway: _primaryOnly, ...unrouted } = wifi
  // Before: the helper gave only the primary interface a gateway, so the Wi‑Fi row had none and pairing was refused.
  s.backend.change([unrouted, wired])
  s.bind({ host: wifi.address, port: 4319 })
  const phone = await gatewayHash(nodeCrypto, '10.60.40.77', wifi.prefixLength, wifi.gateway)
  expect(await s.controller.pairingNearby(onWifi('10.60.40.77'), phone)).toBe(false)
  // The owner's check: the same phone passes once the Wi‑Fi row carries its own router.
  s.backend.change([wifi, wired])
  expect(await s.controller.pairingNearby(onWifi('10.60.40.77'), phone)).toBe(knownNetworkHash(wifi, s.backend.gatewayMac!))
  // The primary interface's router says nothing about the Wi‑Fi.
  const cable = await gatewayHash(nodeCrypto, '10.60.40.77', wifi.prefixLength, wired.gateway)
  expect(await s.controller.pairingNearby(onWifi('10.60.40.77'), cable)).toBe(false)
  expect(await s.controller.pairingNearby(onWifi('10.60.40.77'), new Uint8Array(32))).toBe(false)
  // A phone on the cable's network cannot use the Wi‑Fi socket, whatever it claims.
  expect(await s.controller.pairingNearby(onWifi('10.40.12.80'), phone)).toBe(false)
})

// The iPhone shares its connection over USB: the Mac gets an Ethernet interface and the phone is its router.
const tether = {
  name: 'en8',
  index: 41,
  address: '172.20.10.2',
  prefixLength: 28,
  kind: 'ethernet' as const,
  gateway: '172.20.10.1',
  tether: true as const,
}
it('binds to the iPhone on the cable before the Wi‑Fi, and labels only that address as the cable', async () => {
  const { selectAutoDirect } = await import('../src/native-network.ts')
  const snapshot: NativeNetworkSnapshot = { epoch: randomUUID(), interfaces: [wifi, wired, tether] }
  expect(selectAutoDirect(snapshot, { host: 'auto', port: 0 }, { host: wifi.address, port: 4319 })).toEqual({
    host: tether.address,
    port: 4319,
  })
  expect(
    selectAutoDirect({ ...snapshot, interfaces: [wifi, wired] }, { host: 'auto', port: 0 }, { host: tether.address, port: 4319 }),
  ).toEqual({
    host: wifi.address,
    port: 4319,
  })
  // A link-local or tunnel address on the cable is never bound.
  expect(
    selectAutoDirect(
      { ...snapshot, interfaces: [{ ...tether, address: 'fe80::2', prefixLength: 64, gateway: 'fe80::1' }, wired] },
      { host: 'auto', port: 0 },
      null,
    ),
  ).toEqual({ host: wired.address, port: 0 })
  expect(selectAutoDirect({ ...snapshot, interfaces: [{ ...tether, kind: 'tunnel' }, wired] }, { host: 'auto', port: 0 }, null)).toEqual({
    host: wired.address,
    port: 0,
  })
  expect(networkSnapshotSchema.safeParse(snapshot).success).toBe(true)
  expect(networkSnapshotSchema.safeParse({ ...snapshot, interfaces: [{ ...tether, tether: false }] }).success).toBe(false)
  expect(networkSnapshotSchema.safeParse({ ...snapshot, interfaces: [{ ...tether, kind: 'usb' }] }).success).toBe(false)
  const s = await setup()
  s.backend.change([wifi, tether])
  s.bind({ host: wifi.address, port: 4319 })
  await vi.waitFor(() => expect(s.controller.currentEpoch()).toBe(s.backend.state.epoch))
  expect(s.controller.cable()).toBe(false)
  s.bind({ host: tether.address, port: 4319 })
  expect(s.controller.cable()).toBe(true)
})
it('pairs the iPhone that is the hotspot on the cable, and nothing it forwards', async () => {
  const s = await setup()
  s.backend.change([wifi, tether])
  s.bind({ host: tether.address, port: 4319 })
  const onCable = (source: string): NativeOpening => ({ ...pairingOpening(source), localAddress: tether.address })
  // The phone hashes its own hotspot subnet with itself as the router; the Mac hashes the same network.
  const phone = await gatewayHash(nodeCrypto, tether.gateway, tether.prefixLength, tether.gateway)
  s.backend.peerMac = s.backend.gatewayMac
  expect(await s.controller.pairingNearby(onCable(tether.gateway), phone)).toBe(knownNetworkHash(tether, s.backend.gatewayMac!))
  // The Wi‑Fi's router, another device behind the phone, and daily proximity all stay refused.
  expect(
    await s.controller.pairingNearby(onCable(tether.gateway), await gatewayHash(nodeCrypto, wifi.address, wifi.prefixLength, wifi.gateway)),
  ).toBe(false)
  expect(await s.controller.pairingNearby(onCable('172.20.10.4'), phone)).toBe(false)
  expect(await s.controller.nearby({ ...s.opening, source: tether.gateway, localAddress: tether.address }, phone, () => {})).toBe(false)
})
