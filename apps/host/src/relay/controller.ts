import { setTimeout as delay } from 'node:timers/promises'
import type { Duplex } from 'node:stream'
import { ascii, hex, holder, issuePass, routeId, routeKey, UTC_DAY, type KnockBinding } from '@latch/link-wire'
import { nodeCrypto, RelayClosed, RelayControl, type RelayEndpoint } from '@latch/link-client'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import type { AuditLog } from '../audit.ts'
import type { DeviceStore, EnrollmentService } from '../auth.ts'
import { RelayProfiles, secretBytes, type RelayProfile } from './profiles.ts'

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
  enrollments: EnrollmentService
  audit: AuditLog
  resolve(url: URL): Promise<Lease>
  accept(stream: Duplex, binding: KnockBinding, expectedDeviceId?: string): Promise<void>
  closePaths(relayId: Uint8Array): void
  /** Additional platform trust anchors are explicit process configuration, never received from a node. */
  ca?: string | Buffer
}

/** Exactly one retry owner and control connection per configured node. No node response can erase an identity. */
export class HostRelayController {
  private readonly options: RelayControllerOptions
  private readonly nodes = new Map<string, NodeState>()
  private readonly retiring = new Set<Promise<void>>()
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
  async invitation(
    invitationId: string,
    expiresAt: string,
  ): Promise<Array<{ relayId: string; url: string; spkiHash: string; pass: string; holderSeed: string }>> {
    const now = Date.now(),
      day = Math.floor(now / 1000 / UTC_DAY),
      result = []
    for (const profile of this.options.profiles.snapshot().profiles.slice(0, 2)) {
      const relayId = Buffer.from(profile.relayId, 'hex'),
        seed = secretBytes(profile.seeds[profile.activeSlot])
      const key = await routeKey(nodeCrypto, seed, relayId, day),
        device = await holder(nodeCrypto, seed, relayId, ascii(invitationId), day)
      const pass = await issuePass(nodeCrypto, key, {
        pairing: true,
        relayId,
        day,
        notBefore: Math.floor(now / 1000),
        notAfter: Math.floor(Date.parse(expiresAt) / 1000),
        routePub: await nodeCrypto.publicKey(key),
        holderPub: await nodeCrypto.publicKey(device.seed),
        tag: device.tag,
      })
      result.push({
        relayId: profile.relayId,
        url: profile.url,
        spkiHash: profile.spkiHash,
        pass: Buffer.from(pass).toString('base64url'),
        holderSeed: Buffer.from(device.seed).toString('base64url'),
      })
    }
    return result
  }
  /** Called synchronously after policy/config updates; old sockets cannot keep an allowance that was removed. */
  reconcile(): void {
    if (this.stopped) return
    const profiles = this.options.profiles.snapshot().profiles
    for (const [id, state] of this.nodes) {
      const profile = profiles.find(item => item.relayId === id)
      if (!profile || state.fingerprint !== sha256Hex(canonicalJson(profile)) || state.leases.some(lease => !lease.permitted())) {
        state.abort.abort()
        state.control?.close()
        this.options.closePaths(Buffer.from(id, 'hex'))
        this.nodes.delete(id)
        this.retiring.add(state.done)
        void state.done.finally(() => this.retiring.delete(state.done)).catch(() => {})
      }
    }
    for (const profile of profiles) {
      if (this.nodes.has(profile.relayId) || this.retiring.size >= 16) continue
      const state: NodeState = {
        fingerprint: sha256Hex(canonicalJson(profile)),
        abort: new AbortController(),
        done: Promise.resolve(),
        leases: [],
        tokens: new Map(),
        status: 'connecting',
      }
      this.nodes.set(profile.relayId, state)
      state.done = this.run(profile, state)
    }
  }
  private async resolve(state: NodeState, url: URL): Promise<string> {
    const operation = this.options.resolve(url)
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
    if (!state.leases.some(item => item.address === lease.address)) {
      if (state.leases.length >= 16) throw new Error('Relay address churn limit')
      state.leases.push(lease)
    }
    return lease.address
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
        for (const candidate of [...this.options.devices.nativeCandidates(), ...this.options.enrollments.nativeInvitations()]) {
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
        await this.options.accept(setup.stream, { path: 'relay', relayId, routeId: setup.routeId }, expected)
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
        const endpoint: RelayEndpoint = {
          url: new URL(profile.url),
          relayId: Buffer.from(profile.relayId, 'hex'),
          spki: Buffer.from(profile.spkiHash, 'hex'),
          resolveAddress: () => this.resolve(state, new URL(profile.url)),
          ...(this.options.ca ? { ca: this.options.ca } : {}),
        }
        const control = await RelayControl.connect({
          ...endpoint,
          registrationToken: profile.registrationKey ? secretBytes(profile.registrationKey) : undefined,
          signal: state.abort.signal,
        })
        if (state.abort.signal.aborted) {
          control.close()
          return
        }
        state.control = control
        const members = await this.register(profile, state, control)
        state.status = 'connected'
        attempts = 0
        const workers = Array.from({ length: 4 }, () => this.serve(profile, state, control, members).catch(() => control.close()))
        const date = Math.floor(Date.now() / 1000 / UTC_DAY)
        const renewal = setInterval(() => {
          if (Math.floor(Date.now() / 1000 / UTC_DAY) !== date) control.close()
        }, 30_000)
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
    await Promise.allSettled([...states.map(state => state.done), ...this.retiring])
    this.nodes.clear()
  }
}
