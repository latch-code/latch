import { setTimeout as delay } from 'node:timers/promises'
import type { Duplex } from 'node:stream'
import { ascii, hex, holder, routeId, routeKey, UTC_DAY, type KnockBinding } from '@latch/link-wire'
import { nodeCrypto, RelayClosed, RelayControl } from '@latch/link-client'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import type { AuditLog } from '../audit.ts'
import type { DeviceStore } from '../auth.ts'
import { RelayProfiles, secretBytes, type RelayProfile } from './profiles.ts'
import type { HostRelayDirectory } from './directory.ts'

type Lease = { address: string; permitted(): boolean }
interface NodeState {
  fingerprint: string
  abort: AbortController
  done: Promise<void>
  control?: RelayControl
  leases: Lease[]
  tokens: Map<string, Uint8Array>
  status: 'connecting' | 'connected' | 'waiting' | 'attention'
  retryAt?: number
}
export interface RelayControllerOptions {
  profiles: RelayProfiles
  devices: DeviceStore
  audit: AuditLog
  resolve(url: URL): Promise<Lease>
  directory?: HostRelayDirectory
  resolvePublic?(url: URL, address: string): Promise<Lease>
  accept(stream: Duplex, binding: KnockBinding, expectedDeviceId?: string): Promise<void>
  closePaths(relayId: Uint8Array): void
  /** Additional platform trust anchors are explicit process configuration, never received from a node. */
  ca?: string | Buffer
}

/** Exactly one retry owner and control connection per configured node. No node response can erase an identity. */
export class HostRelayController {
  private readonly options: RelayControllerOptions
  private readonly nodes = new Map<string, NodeState>()
  private readonly retiring = new Map<string, Promise<void>>()
  private readonly resumeTokens = new Map<string, { fingerprint: string; tokens: Map<string, Uint8Array> }>()
  private readonly timer: ReturnType<typeof setInterval>
  private stopped = false
  constructor(options: RelayControllerOptions) {
    this.options = options
    this.timer = setInterval(() => this.reconcile(), 1000)
    this.timer.unref()
    this.reconcile()
  }
  status(): Array<{ relayId: string; status: NodeState['status']; retryAt?: number }> {
    return [...this.nodes].map(([relayId, state]) => ({
      relayId,
      status: state.status,
      ...(state.retryAt === undefined ? {} : { retryAt: state.retryAt }),
    }))
  }
  /** Called synchronously after policy/config updates; old sockets cannot keep an allowance that was removed. */
  reconcile(): void {
    if (this.stopped) return
    // The built-in relays run while a phone can use them, and only a phone paired on the LAN can get here.
    const reachable = this.options.devices.nativeReachable()
    const profiles = this.options.profiles.snapshot().profiles.filter(profile => !profile.builtIn || reachable)
    for (const [id, retained] of this.resumeTokens) {
      const profile = profiles.find(item => item.relayId === id)
      if (!profile || retained.fingerprint !== sha256Hex(canonicalJson(profile))) this.resumeTokens.delete(id)
    }
    for (const [id, state] of this.nodes) {
      const profile = profiles.find(item => item.relayId === id)
      if (!profile || state.fingerprint !== sha256Hex(canonicalJson(profile)) || state.leases.some(lease => !lease.permitted())) {
        state.abort.abort()
        state.control?.close()
        this.options.closePaths(Buffer.from(id, 'hex'))
        this.nodes.delete(id)
        this.retiring.set(id, state.done)
        void state.done
          .finally(() => {
            if (this.retiring.get(id) === state.done) this.retiring.delete(id)
            this.reconcile()
          })
          .catch(() => {})
      }
    }
    for (const profile of profiles) {
      if (this.nodes.has(profile.relayId) || this.retiring.has(profile.relayId) || this.retiring.size >= 16) continue
      const fingerprint = sha256Hex(canonicalJson(profile)),
        retained = this.resumeTokens.get(profile.relayId) ?? { fingerprint, tokens: new Map<string, Uint8Array>() }
      // A temporary egress removal closes every path, but must not make the same configured node look like a hostile takeover.
      this.resumeTokens.set(profile.relayId, retained)
      const state: NodeState = {
        fingerprint,
        abort: new AbortController(),
        done: Promise.resolve(),
        leases: [],
        tokens: retained.tokens,
        status: 'connecting',
      }
      this.nodes.set(profile.relayId, state)
      state.done = this.run(profile, state)
    }
  }
  private async resolve(state: NodeState, url: URL, fixed?: { address: string; permitted(): boolean }): Promise<string> {
    const operation = fixed
      ? (this.options
          .resolvePublic?.(url, fixed.address)
          .then(lease => ({ address: lease.address, permitted: () => fixed.permitted() && lease.permitted() }))
        ?? Promise.reject(new Error('Directory transport unavailable')))
      : this.options.resolve(url)
    const timeout = new AbortController()
    let lease: Lease
    try {
      lease = await Promise.race([
        operation,
        delay(5000, undefined, { signal: AbortSignal.any([state.abort.signal, timeout.signal]), ref: false }).then(() => {
          throw new Error('Relay address deadline')
        }),
      ])
    } finally {
      timeout.abort()
    }
    if (state.abort.signal.aborted || !lease.permitted()) throw new Error('Relay egress unavailable')
    // Only distinct checked addresses matter; this set is bounded even under a hostile DNS answer sequence.
    if (!state.leases.some(item => item.address === lease.address && item.permitted())) {
      if (state.leases.length >= 16) throw new Error('Relay address churn limit')
      state.leases.push(lease)
    }
    return lease.address
  }
  private async connect(profile: RelayProfile, state: NodeState): Promise<RelayControl> {
    const create = (url: string, fixed?: { address: string; permitted(): boolean }) =>
      RelayControl.connect({
        url: new URL(url),
        relayId: Buffer.from(profile.relayId, 'hex'),
        spki: Buffer.from(profile.spkiHash, 'hex'),
        profile: 'outer-pad-v2',
        resolveAddress: () => this.resolve(state, new URL(url), fixed),
        ...(this.options.ca ? { ca: this.options.ca } : {}),
        registrationToken: profile.registrationKey ? secretBytes(profile.registrationKey) : undefined,
        signal: state.abort.signal,
      })
    try {
      return await create(profile.url)
    } catch (original) {
      if (state.abort.signal.aborted || !this.options.directory) throw original
      await this.options.directory.refresh()
      for (const candidate of this.options.directory.candidates(profile.relayId, profile.spkiHash)) {
        if (state.abort.signal.aborted) throw original
        const permitted = () =>
          this.options
            .directory!.candidates(profile.relayId, profile.spkiHash)
            .some(item => item.url === candidate.url && item.address === candidate.address)
        try {
          return await create(candidate.url, { address: candidate.address, permitted })
        } catch {
          /* Another address of the same approved identity may still be reachable. */
        }
      }
      throw original
    }
  }
  private async register(
    profile: RelayProfile,
    state: NodeState,
    control: RelayControl,
  ): Promise<Map<string, { day: number; seed: Buffer }>> {
    const relayId = Buffer.from(profile.relayId, 'hex'),
      day = Math.floor(Date.now() / 1000 / UTC_DAY)
    const seed = secretBytes(profile.seeds[profile.activeSlot]),
      members = new Map<string, { day: number; seed: Buffer }>()
    for (const date of [day, day + 1, day - 1]) {
      const key = await routeKey(nodeCrypto, seed, relayId, date),
        id = hex(await routeId(nodeCrypto, await nodeCrypto.publicKey(key)))
      const result = await control.register({ routeKey: key, day: date, previous: state.tokens.get(id), alternate: false })
      state.tokens.set(id, result.token)
      members.set(id, { day: date, seed })
    }
    for (const id of state.tokens.keys()) if (!members.has(id)) state.tokens.delete(id)
    return members
  }
  private async synchronizeDenials(
    profile: RelayProfile,
    control: RelayControl,
    members: Map<string, { day: number; seed: Buffer }>,
    delivered: Set<string>,
  ): Promise<void> {
    const revoked = this.options.devices
        .nativeRevocations()
        .filter(item => item.acknowledged || Date.now() - item.revokedAt >= 7 * 86400_000),
      relayId = Buffer.from(profile.relayId, 'hex')
    for (const [id, member] of members) {
      const batch: Array<{ deviceId: string; tag: Uint8Array }> = []
      for (const device of revoked) {
        if (delivered.has(`${id}:${device.id}`)) continue
        const tag = (await holder(nodeCrypto, member.seed, relayId, ascii(device.id), member.day)).tag
        batch.push({ deviceId: device.id, tag })
      }
      for (let at = 0; at < batch.length; at += 1024) {
        const part = batch.slice(at, at + 1024)
        await control.deny(
          Buffer.from(id, 'hex'),
          part.map(item => item.tag),
        )
        for (const item of part) delivered.add(`${id}:${item.deviceId}`)
      }
    }
  }
  private async serve(
    profile: RelayProfile,
    state: NodeState,
    control: RelayControl,
    members: Map<string, { day: number; seed: Buffer }>,
  ): Promise<void> {
    const relayId = Buffer.from(profile.relayId, 'hex')
    while (!state.abort.signal.aborted && !control.isClosed()) {
      const setup = await control.accept()
      try {
        const member = members.get(hex(setup.routeId))
        if (!member) {
          setup.stream.destroy()
          continue
        }
        let expected: string | undefined
        for (const candidate of this.options.devices.nativeTransportCandidates()) {
          const value = await holder(nodeCrypto, member.seed, relayId, ascii(candidate.id), member.day)
          if (hex(value.tag) === hex(setup.passTag)) {
            expected = candidate.id
            break
          }
        }
        if (!expected) {
          setup.stream.destroy()
          continue
        }
        await this.options.accept(setup.stream, { path: 'relay', relayId, routeId: setup.routeId, profile: setup.profile }, expected)
      } finally {
        setup.finishSetup()
      }
    }
  }
  private async run(profile: RelayProfile, state: NodeState): Promise<void> {
    let attempts = 0
    while (!state.abort.signal.aborted) {
      try {
        state.status = 'connecting'
        delete state.retryAt
        const control = await this.connect(profile, state)
        if (state.abort.signal.aborted) {
          control.close()
          return
        }
        state.control = control
        const members = await this.register(profile, state, control)
        const delivered = new Set<string>()
        await this.synchronizeDenials(profile, control, members, delivered)
        state.status = 'connected'
        attempts = 0
        const workers = Array.from({ length: 4 }, () => this.serve(profile, state, control, members).catch(() => control.close()))
        const date = Math.floor(Date.now() / 1000 / UTC_DAY)
        let syncing = false
        const renewal = setInterval(() => {
          if (Math.floor(Date.now() / 1000 / UTC_DAY) !== date) control.close()
          if (!syncing && !control.isClosed()) {
            syncing = true
            void this.synchronizeDenials(profile, control, members, delivered)
              .catch(() => control.close())
              .finally(() => {
                syncing = false
              })
          }
        }, 1000)
        renewal.unref()
        try {
          const error = await control.closed
          if (!state.abort.signal.aborted) throw error
        } finally {
          clearInterval(renewal)
          control.close()
          await Promise.allSettled(workers)
        }
      } catch (error) {
        state.control?.close()
        state.control = undefined
        if (state.abort.signal.aborted) return
        if (error instanceof RelayClosed && (error.closeCode === 4200 || error.closeCode === 4201)) {
          try {
            await this.options.audit.append({
              action: 'native.relay.conflict',
              actor: { listener: 'host' },
              detail: { relayHash: sha256Hex(profile.relayId) },
            })
            await this.options.profiles.rotate(profile.relayId, Math.floor(Date.now() / 1000 / UTC_DAY))
            this.reconcile()
            return
          } catch {
            state.status = 'attention'
          }
        }
        if (state.status !== 'attention') state.status = 'waiting'
        const wait = Math.min(300_000, 1000 * 2 ** Math.min(attempts++, 9))
        state.retryAt = Date.now() + wait
        try {
          await delay(wait, undefined, { signal: state.abort.signal })
        } catch {
          return
        }
      }
    }
  }
  async close(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    const states = [...this.nodes.values()]
    for (const state of states) {
      state.abort.abort()
      state.control?.close()
    }
    await Promise.allSettled([...states.map(state => state.done), ...this.retiring.values()])
    this.nodes.clear()
    this.resumeTokens.clear()
  }
}
