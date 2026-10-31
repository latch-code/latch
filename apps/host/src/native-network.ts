import { AppError } from '@latch/sdk'
import { isIP } from 'node:net'
import { nodeCrypto } from '@latch/link-client'
import {
  equal,
  gatewayHash,
  isDiscoveryPeer,
  isPrivateDiscoveryAddress,
  mdnsDigest,
  parseIp,
  UTC_DAY,
  type NativeLanAddress,
} from '@latch/link-wire'
import { sha256Hex, canonicalJson } from '@latch/core/node-kit'
import type { AuditLog } from './audit.ts'
import { base32 } from './crypto.ts'
import type { NativeOpening } from './native.ts'
import { NativeNetworks, knownNetworkHash } from './native-networks.ts'
import {
  networkSnapshotSchema,
  type NativeNetworkBackend,
  type NativeNetworkInterface,
  type NativeNetworkSnapshot,
  type NativeNetworkService,
} from './native-network-backend.ts'
import { RelayProfiles, secretBytes, type NativeDirect } from './relay/profiles.ts'

interface NetworkOptions {
  profiles: RelayProfiles
  audit: AuditLog
  networks: NativeNetworks
  backend(): Promise<NativeNetworkBackend>
  direct(): { host: string; port: number } | null
  pairing(): boolean
  discoveryReady(): boolean
  synchronizeDiscovery?(): Promise<void>
  now?(): number
  automatic?(): boolean
  rebind?(snapshot: NativeNetworkSnapshot): Promise<void>
  /** Closes a listener nobody wants, which must not wait for the network component. */
  release?(): Promise<void>
}
function physical(row: NativeNetworkInterface): boolean {
  return row.kind !== 'tunnel' && /^en[0-9]+$/u.test(row.name) && isPrivateDiscoveryAddress(row.address)
}
function sameIp(a: string, b: string): boolean {
  try {
    const x = parseIp(a),
      y = parseIp(b)
    return x.family === y.family && equal(x.bytes, y.bytes)
  } catch {
    return false
  }
}
function linkLocal(address: string): boolean {
  const ip = parseIp(address)
  return ip.family === 4 ? ip.bytes[0] === 169 && ip.bytes[1] === 254 : ip.bytes[0] === 254 && (ip.bytes[1]! & 192) === 128
}

/** A logical auto setting remains stable while the bound address follows this snapshot. No wildcard or tunnel is chosen. */
export function selectAutoDirect(
  snapshot: NativeNetworkSnapshot,
  config: NativeDirect,
  current: NativeDirect | null,
): NativeDirect | undefined {
  if (config.host !== 'auto') return config
  const choices = snapshot.interfaces
    .filter(row => physical(row) && !linkLocal(row.address))
    .toSorted((a, b) => parseIp(a.address).family - parseIp(b.address).family || a.index - b.index || a.address.localeCompare(b.address))
  const selected = choices.find(row => current && sameIp(row.address, current.host)) ?? choices[0]
  return selected ? { host: selected.address, port: config.port || current?.port || 0 } : undefined
}

/** Owns system observations and discovery; a confirmed logical setting owns binding. Proximity never grants a scope. */
export class NativeNetwork {
  private backend: NativeNetworkBackend | undefined
  private opening: Promise<void> | undefined
  private snapshot: NativeNetworkSnapshot | undefined
  private book: NativeLanAddress[] = []
  private generation = 0
  private published = ''
  private readonly remove: Array<() => void> = []
  private readonly timer: ReturnType<typeof setInterval>
  private operation: Promise<void> | undefined
  private dirty = false
  private stopping = false
  private retryAt = 0
  private readonly proofs = new Set<NativeOpening>()
  private readonly pairingProofs = new Set<NativeOpening>()
  private pairingQueue: Promise<unknown> = Promise.resolve()
  private readonly routers = new Map<string, { epoch: string; hash: string; at: number }>()
  constructor(private readonly options: NetworkOptions) {
    this.timer = setInterval(() => this.reconcile(), 1000)
    this.timer.unref()
    this.reconcile()
  }
  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
  lan(): NativeLanAddress[] {
    return this.book.map(row => ({ ...row, gatewayHash: new Uint8Array(row.gatewayHash) }))
  }
  invalidate(): void {
    this.generation++
    if (this.backend && this.snapshot) void this.backend.publish([], this.snapshot.epoch).catch(() => {})
    this.book = []
    this.published = ''
    this.routers.clear()
    this.reconcile()
  }
  reconcile(): void {
    if (this.stopping) return
    if (this.operation) {
      this.dirty = true
      return
    }
    this.dirty = false
    this.operation = this.refresh()
      .catch(async () => {
        this.book = []
        this.published = ''
        this.retryAt = this.now() + 30_000
        await this.disconnect()
      })
      .finally(() => {
        this.operation = undefined
        if (this.dirty) this.reconcile()
      })
  }
  private async disconnect(): Promise<void> {
    const backend = this.backend
    this.backend = undefined
    this.snapshot = undefined
    for (const remove of this.remove.splice(0)) remove()
    await backend?.close()
  }
  private rows(): NativeNetworkInterface[] {
    const direct = this.options.direct()
    return direct ? (this.snapshot?.interfaces ?? []).filter(row => physical(row) && sameIp(row.address, direct.host)) : []
  }
  currentEpoch(): string | undefined {
    return this.snapshot?.epoch
  }
  async resolveDirect(config: NativeDirect | null, current: NativeDirect | null): Promise<NativeDirect | undefined> {
    if (!config) return undefined
    if (config.host !== 'auto') return config
    try {
      await this.connect()
      if (!this.snapshot || this.stopping) throw new Error('Network unavailable')
      return selectAutoDirect(this.snapshot, config, current)
    } catch {
      throw new AppError(503, 'native-network-unavailable', '手机连接组件不可用，请更新并重新构建 Latch 后重试')
    }
  }
  private connect(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('Network stopped'))
    if (this.opening) return this.opening
    if (this.backend && this.snapshot) return Promise.resolve()
    this.opening = (async () => {
      const backend = await this.options.backend()
      if (this.stopping) {
        await backend.close()
        return
      }
      this.backend = backend
      this.remove.push(
        backend.onChange(snapshot => {
          this.snapshot = networkSnapshotSchema.parse(snapshot)
          this.retryAt = 0
          this.invalidate()
        }),
        backend.onStatus(status => {
          if (status === 'blocked' || status === 'conflict') {
            this.retryAt = this.now() + 30_000
            this.invalidate()
          }
        }),
      )
      const generation = this.generation,
        snapshot = await backend.snapshot()
      if (generation === this.generation) this.snapshot = snapshot
    })()
      .catch(async error => {
        await this.disconnect()
        throw error
      })
      .finally(() => {
        this.opening = undefined
      })
    return this.opening
  }
  private async refresh(): Promise<void> {
    let direct = this.options.direct()
    const automatic = this.options.automatic?.() === true
    if (!automatic && (!direct || !isIP(direct.host) || !isPrivateDiscoveryAddress(direct.host))) {
      this.book = []
      this.published = ''
      await this.disconnect()
      return
    }
    if (automatic) await this.options.release?.()
    if (this.now() < this.retryAt) return
    await this.connect()
    const before = this.snapshot
    if (automatic && before) await this.options.rebind?.(before)
    if (before !== this.snapshot || this.stopping) return
    direct = this.options.direct()
    if (!direct || !isIP(direct.host) || !isPrivateDiscoveryAddress(direct.host)) {
      this.book = []
      this.published = ''
      if (this.backend && this.snapshot) await this.backend.publish([], this.snapshot.epoch)
      return
    }
    const backend = this.backend,
      snapshot = this.snapshot,
      generation = this.generation
    if (!backend) return
    if (!snapshot) return
    if (!this.options.discoveryReady()) {
      this.book = []
      this.published = ''
      await backend.publish([], snapshot.epoch)
      await this.options.synchronizeDiscovery?.()
      if (this.options.discoveryReady()) this.dirty = true
      return
    }
    const state = this.options.profiles.snapshot(),
      key = secretBytes(state.discoveryKey),
      day = Math.floor(this.now() / 1000 / UTC_DAY)
    const instance = base32(await mdnsDigest(nodeCrypto, key, day)).slice(0, 12),
      alternate = base32(await mdnsDigest(nodeCrypto, key, day, true)).slice(0, 12)
    const services: NativeNetworkService[] = [],
      book: NativeLanAddress[] = []
    for (const row of this.rows()) {
      if (!row.gateway) {
        if (this.options.pairing()) services.push({ index: row.index, port: direct.port, instance, alternate, addresses: [row.address] })
        continue
      }
      let cached = this.routers.get(`${row.index}:${row.address}`)
      if (!cached || cached.epoch !== snapshot.epoch || this.now() - cached.at >= 30_000) {
        const neighbor = await backend.neighbors(row.index, row.address)
        if (neighbor.epoch !== snapshot.epoch) return
        cached =
          neighbor.gatewayMac && neighbor.gateway && sameIp(neighbor.gateway, row.gateway)
            ? { epoch: snapshot.epoch, at: this.now(), hash: knownNetworkHash(row, neighbor.gatewayMac) }
            : undefined
        if (cached) this.routers.set(`${row.index}:${row.address}`, cached)
        else this.routers.delete(`${row.index}:${row.address}`)
      }
      if (this.options.pairing() || (cached && this.options.networks.has(cached.hash)))
        services.push({ index: row.index, port: direct.port, instance, alternate, addresses: [row.address] })
      if (!linkLocal(row.address))
        book.push({
          address: row.address,
          kind: row.kind,
          port: direct.port,
          prefixLength: row.prefixLength,
          gatewayHash: await gatewayHash(nodeCrypto, row.address, row.prefixLength, row.gateway),
        })
    }
    if (
      this.stopping
      || generation !== this.generation
      || !this.options.discoveryReady()
      || this.options.profiles.snapshot().discoveryKey !== state.discoveryKey
    )
      return
    const fingerprint = sha256Hex(canonicalJson({ epoch: snapshot.epoch, services }))
    if (fingerprint !== this.published) {
      await backend.publish(services, snapshot.epoch)
      if (generation !== this.generation || this.stopping) return
      this.published = fingerprint
    }
    this.book = book.slice(0, 8)
  }
  async nearby(opening: NativeOpening, phoneGatewayHash: Uint8Array, recheck: () => void): Promise<boolean> {
    recheck()
    if (this.proofs.has(opening) || this.proofs.size >= 2) return false
    this.proofs.add(opening)
    try {
      return await this.proveNearby(opening, phoneGatewayHash, recheck)
    } finally {
      this.proofs.delete(opening)
    }
  }
  /**
   * The pairing gate: `proveNearby` on the pairing socket. A phone sharing its own connection as a Personal Hotspot is
   * the gateway, so here a peer may have the gateway's MAC when it also has the gateway's IP. Fails closed.
   */
  async pairingNearby(opening: NativeOpening, phoneGatewayHash: Uint8Array): Promise<string | false> {
    if (this.pairingProofs.has(opening) || this.pairingProofs.size >= 16) return false
    this.pairingProofs.add(opening)
    // One at a time: the holder of a QR cannot use up the helper's request slots before the real phone's proof.
    const proof = this.pairingQueue.then(() => this.proveNeighbour(opening, phoneGatewayHash, true))
    this.pairingQueue = proof.then(
      () => {},
      () => {},
    )
    try {
      const network = await proof
      return network ?? false
    } catch {
      return false
    } finally {
      this.pairingProofs.delete(opening)
    }
  }
  /** Marks a network known, once a phone proven on it has actually paired. Never blocks that pairing. */
  async remember(networkHash: string): Promise<void> {
    if (this.options.networks.has(networkHash)) return
    await this.options.audit.append({
      action: 'native.network.remembered',
      actor: { listener: 'native-direct', via: 'http' },
      detail: { networkHash },
    })
    await this.options.networks.remember(networkHash)
    this.reconcile()
  }
  private async proveNearby(opening: NativeOpening, phoneGatewayHash: Uint8Array, recheck: () => void): Promise<boolean> {
    const networkHash = await this.proveNeighbour(opening, phoneGatewayHash, false, recheck)
    if (!networkHash) return false
    const generation = this.generation,
      epoch = this.snapshot?.epoch
    if (!this.options.networks.has(networkHash)) {
      await this.options.audit.append({
        action: 'native.network.remembered',
        actor: { deviceId: opening.deviceId, listener: opening.listener.listener, via: 'http' },
        detail: { networkHash },
      })
      recheck()
      if (generation !== this.generation || this.stopping) return false
      await this.options.networks.remember(networkHash)
    }
    recheck()
    if (this.stopping || generation !== this.generation || this.snapshot?.epoch !== epoch) return false
    this.reconcile()
    return true
  }
  /** The neighbour evidence for this socket: the known-network hash it proves, or undefined. */
  private async proveNeighbour(
    opening: NativeOpening,
    phoneGatewayHash: Uint8Array,
    pairing: boolean,
    recheck: () => void = () => {},
  ): Promise<string | undefined> {
    recheck()
    if (opening.listener.listener !== 'native-direct' || !opening.localAddress) return undefined
    if (pairing) await this.connect()
    if (!this.backend || !this.snapshot) return undefined
    const backend = this.backend,
      snapshot = this.snapshot,
      generation = this.generation
    const own = snapshot.interfaces.map(row => row.address),
      row = this.rows().find(
        item => sameIp(item.address, opening.localAddress!) && isDiscoveryPeer(opening.source, item.address, item.prefixLength, own),
      )
    if (!row?.gateway || phoneGatewayHash.byteLength !== 32) return undefined
    const expected = await gatewayHash(nodeCrypto, row.address, row.prefixLength, row.gateway)
    if (!equal(expected, phoneGatewayHash)) return undefined
    const observed = await backend.neighbors(row.index, opening.source)
    recheck()
    if (
      this.stopping
      || generation !== this.generation
      || observed.epoch !== snapshot.epoch
      || this.snapshot?.epoch !== snapshot.epoch
      || !observed.peerMac
      || !observed.gatewayMac
      || !observed.gateway
      || !sameIp(observed.gateway, row.gateway)
    )
      return undefined
    // A router forwarding traffic shows up with its own MAC. Only pairing lets that through, and only for its own IP.
    if (observed.peerMac === observed.gatewayMac && !(pairing && sameIp(opening.source, observed.gateway))) return undefined
    this.routers.delete(`${row.index}:${row.address}`)
    return knownNetworkHash(row, observed.gatewayMac)
  }
  async close(): Promise<void> {
    this.stopping = true
    this.generation++
    clearInterval(this.timer)
    this.book = []
    for (const remove of this.remove.splice(0)) remove()
    await this.backend?.close()
    await this.opening?.catch(() => {})
    await this.operation
    this.backend = undefined
  }
}
