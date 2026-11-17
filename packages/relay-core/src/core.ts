import {
  attachMac,
  denyBatchDigest,
  encodeMessage,
  equal,
  hex,
  registrationInput,
  registrationMac,
  registrationWorkInput,
  routeId,
  signEdgeChallenge,
  UTC_DAY,
  verifyProof,
  type EdgeRole,
  type LinkCrypto,
  type RelayMessage,
  type RelayTransportProfile,
} from '@latch/link-wire'

/** The scrypt challenge's admission policy; the adapter owns the verifier and its bounded concurrency. */
export interface RegistrationWorkPolicy {
  softRoutesPerPrefix: number
  minBits: number
  maxBits: number
  maxConcurrent: number
}
export interface RegistrationWorkInput {
  input: Uint8Array
  salt: Uint8Array
  bits: number
}
export type RegistrationWorkResult = boolean | 'overloaded' | 'timeout'

export interface RelayPeer {
  id: number
  prefix: string
  profile?: RelayTransportProfile
  send(message: RelayMessage): Promise<void>
  close(code: number): void
  markSpliced?(): void
  metrics?(): { bufferedBytes: number; pendingWriteBytes: number; writtenBytes: number }
}
type Role = 'host' | 'data' | 'client'
type WorkChallenge = {
  register: Extract<RelayMessage, { type: 'register' }>
  route: Uint8Array
  nonce: Uint8Array
  bits: number
  expires: number
  verifying: boolean
}
type Connection = {
  peer: RelayPeer
  role: Role
  phase: 'new' | 'challenge' | 'registered' | 'pending' | 'spliced'
  challenge?: Uint8Array
  route?: string
  controlRoutes?: Set<string>
  tag?: string
  holder?: string
  pendingKey?: string
  partner?: number
  opened: number
  work?: WorkChallenge
}
type Route = {
  control?: number
  publicKey: Uint8Array
  prefix: string
  alternate: boolean
  id: Uint8Array
  token: Uint8Array
  day: number
  departed?: 1 | 2 | 3
  since: number
  deny: Set<string>
  denialBlocked?: boolean
}
type Pending = { client: number; route: string; nonce: Set<string>; opened: number }
export interface RelayCoreOptions {
  crypto: LinkCrypto
  relayId: Uint8Array
  registrationToken?: Uint8Array
  openRegistration?: boolean
  now(): number
  serviceReady?(): boolean
  maxConnections?: number
  maxRoutes?: number
  maxPrefixFraction?: number
  maxRoutesPerPrefix?: number
  maxPreauthConnections?: number
  maxPerPrefix?: number
  maxDenialTags?: number
  denials?: {
    get(route: Uint8Array, day: number, limit: number): Uint8Array[] | Promise<Uint8Array[]>
    add(route: Uint8Array, day: number, tags: readonly Uint8Array[]): Promise<number>
  }
  canAdmit?(): boolean
  waitBytes?(id: number, prefixes: readonly string[], route: string, bytes: number): Promise<boolean>
  waitWire?(id: number, prefixes: readonly string[], route: string, bytes: number, direction: 'in' | 'out'): Promise<boolean>
  cancelWait?(id: number): void
  registrationWork?: RegistrationWorkPolicy & { verify(request: RegistrationWorkInput): Promise<RegistrationWorkResult> }
  allowBytes?(prefixes: readonly string[], route: string, bytes: number): boolean
  /**
   * Edge kind (link-wire relay-identity.ts). Every role must open with EDGE-HELLO and receives a challenge signed with this
   * relay seed; DATA legs attach only after it; clients are admitted only with the bound v2 proof over this connection's
   * challenge nonce. Absent, the node behaves exactly as the self-hosted kind always has.
   */
  edgeIdentity?: { seed: Uint8Array }
}

/** I/O, timers, certificate management and persistence belong to the adapter. */
export class RelayCore {
  private readonly options: RelayCoreOptions
  private readonly connections = new Map<number, Connection>()
  private readonly routes = new Map<string, Route>()
  private readonly pending = new Map<string, Pending>()
  private readonly replay = new Map<string, { expires: number; prefixes: string[] }>()
  private readonly replayPrefixes = new Map<string, number>()
  private readonly holderPrefixes = new Map<string, number>()
  private readonly routeHolders = new Map<string, number>()
  private readonly holders = new Map<string, { day: number; route: string; prefixes: string[] }>()
  private readonly prefixConnections = new Map<string, number>()
  private readonly preauth = new Map<number, Connection>()
  private readonly preauthPrefixes = new Map<string, Set<number>>()
  private readonly holderActivity = new Map<string, { active: number; pending: number }>()
  private lastSweepAt = Number.NEGATIVE_INFINITY
  private draining = false
  private readonly registering = new Map<string, Connection>()
  private denialTags = 0
  constructor(options: RelayCoreOptions) {
    if (options.relayId.length !== 16 || (!options.openRegistration && options.registrationToken?.length !== 32))
      throw new RangeError('A private relay requires a registration token')
    const work = options.registrationWork
    if (
      work
      && (!Number.isInteger(work.softRoutesPerPrefix)
        || work.softRoutesPerPrefix < 1
        || work.softRoutesPerPrefix >= (options.maxRoutesPerPrefix ?? options.maxRoutes ?? 512)
        || !Number.isInteger(work.minBits)
        || !Number.isInteger(work.maxBits)
        || work.minBits < 0
        || work.minBits > work.maxBits
        || work.maxBits > 22)
    )
      throw new RangeError('Invalid registration work policy')
    this.options = options
  }
  private authenticated(connection: Connection): void {
    if (!this.preauth.delete(connection.peer.id)) return
    const group = this.preauthPrefixes.get(connection.peer.prefix)
    group?.delete(connection.peer.id)
    if (!group?.size) this.preauthPrefixes.delete(connection.peer.prefix)
  }
  connect(peer: RelayPeer, role: Role): boolean {
    if (this.options.now() - this.lastSweepAt >= 1000) this.sweep()
    if (role !== 'host' && this.options.canAdmit?.() === false) {
      peer.close(4304)
      return false
    }
    if (this.draining || this.options.serviceReady?.() === false || this.connections.has(peer.id)) {
      peer.close(4302)
      return false
    }
    if ((this.prefixConnections.get(peer.prefix) ?? 0) >= (this.options.maxPerPrefix ?? 64)) {
      const oldest = this.preauthPrefixes.get(peer.prefix)?.values().next().value
      if (oldest === undefined) {
        peer.close(4302)
        return false
      }
      this.close(oldest, 4302)
    }
    if (
      this.connections.size >= (this.options.maxConnections ?? 1024)
      || this.preauth.size >= Math.min(this.options.maxConnections ?? 1024, this.options.maxPreauthConnections ?? 4096)
    ) {
      let largest: Set<number> | undefined
      for (const group of this.preauthPrefixes.values()) if (!largest || group.size > largest.size) largest = group
      const oldest = largest?.values().next().value
      if (oldest === undefined) {
        peer.close(4302)
        return false
      }
      this.close(oldest, 4302)
    }
    const connection: Connection = { peer, role, phase: 'new', opened: this.options.now() }
    this.connections.set(peer.id, connection)
    this.prefixConnections.set(peer.prefix, (this.prefixConnections.get(peer.prefix) ?? 0) + 1)
    this.preauth.set(peer.id, connection)
    const group = this.preauthPrefixes.get(peer.prefix) ?? new Set<number>()
    group.add(peer.id)
    this.preauthPrefixes.set(peer.prefix, group)
    return true
  }
  async receive(id: number, message: RelayMessage): Promise<void> {
    const connection = this.connections.get(id)
    if (!connection) return
    try {
      if (message.type === 'pad' && connection.peer.profile === 'outer-pad-v2' && connection.role !== 'host') return
      if (connection.phase === 'spliced') {
        if (message.type !== 'data') throw new RangeError('Expected DATA')
        const partner = this.connections.get(connection.partner!)
        if (
          !partner
          || (!connection.peer.profile
            && this.options.allowBytes
            && !this.options.allowBytes([connection.peer.prefix, partner.peer.prefix], connection.route!, message.data.length * 2))
        ) {
          this.close(id, 4304)
          return
        }
        if (
          !connection.peer.profile
          && this.options.waitBytes
          && !(await this.options.waitBytes(id, [connection.peer.prefix, partner.peer.prefix], connection.route!, message.data.length))
        ) {
          this.close(id, 4302)
          return
        }
        if (this.connections.get(id) !== connection || this.connections.get(partner.peer.id) !== partner) return
        await partner.peer.send(message)
        return
      }
      const edge = this.options.edgeIdentity !== undefined
      if (connection.role === 'host') {
        await this.host(connection, message)
        return
      }
      if (edge) {
        if (connection.phase === 'new' && message.type === 'edge-hello') {
          await this.edgeChallenge(connection, message.clientNonce)
          return
        }
        if (connection.role === 'client' && connection.phase === 'challenge' && message.type === 'bound-admit') {
          await this.admit(connection, message.proof, connection.challenge!)
          return
        }
        if (connection.role === 'data' && connection.phase === 'challenge' && message.type === 'attach') {
          await this.attach(connection, message)
          return
        }
        throw new RangeError('Unexpected relay message')
      }
      if (connection.role === 'client' && connection.phase === 'new' && message.type === 'hello') {
        connection.phase = 'challenge'
        await connection.peer.send({
          type: 'challenge',
          relayId: this.options.relayId,
          nonce: this.options.crypto.random(32),
          timeMs: this.options.now(),
          requiresToken: false,
        })
        return
      }
      if (connection.role === 'client' && (connection.phase === 'new' || connection.phase === 'challenge') && message.type === 'admit') {
        await this.admit(connection, message.proof)
        return
      }
      if (connection.role === 'data' && connection.phase === 'new' && message.type === 'attach') {
        await this.attach(connection, message)
        return
      }
      throw new RangeError('Unexpected relay message')
    } catch {
      if (this.connections.get(id) === connection) this.close(id, 4400)
    }
  }
  /** v2 reserves actual WebSocket frame bytes independently in both directions, including discarded PAD. */
  async reserveWire(id: number, bytes: number, direction: 'in' | 'out'): Promise<boolean> {
    const connection = this.connections.get(id)
    if (!connection || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 65_550) return false
    if (!connection.peer.profile) return true
    const partner = connection.partner === undefined ? undefined : this.connections.get(connection.partner)
    const prefixes = partner ? [connection.peer.prefix, partner.peer.prefix] : [connection.peer.prefix]
    const route = connection.route ?? `setup:${id}`
    if (this.options.allowBytes && !this.options.allowBytes(prefixes, route, bytes)) {
      this.close(id, 4304)
      return false
    }
    for (let at = 0; at < bytes; at += 16_384) {
      if (this.options.waitWire && !(await this.options.waitWire(id, prefixes, route, Math.min(16_384, bytes - at), direction)))
        return false
      if (this.connections.get(id) !== connection || (partner && this.connections.get(partner.peer.id) !== partner)) return false
    }
    return true
  }
  private async host(connection: Connection, message: RelayMessage, acceptedWork?: WorkChallenge): Promise<void> {
    const { crypto } = this.options
    if (this.options.edgeIdentity && connection.phase === 'new' && message.type === 'edge-hello') {
      await this.edgeChallenge(connection, message.clientNonce)
      return
    }
    if (!this.options.edgeIdentity && connection.phase === 'new' && message.type === 'hello') {
      connection.phase = 'challenge'
      connection.challenge = crypto.random(32)
      await connection.peer.send({
        type: 'challenge',
        relayId: this.options.relayId,
        nonce: connection.challenge,
        timeMs: this.options.now(),
        requiresToken: !this.options.openRegistration,
      })
      return
    }
    if ((connection.phase === 'challenge' || connection.phase === 'registered') && message.type === 'registration-proof') {
      const work = connection.work,
        policy = this.options.registrationWork
      if (
        !work
        || !policy
        || work.verifying
        || this.options.now() > work.expires
        || !equal(work.route, message.routeId)
        || !equal(work.nonce, message.nonce)
      ) {
        this.close(connection.peer.id, 4100)
        return
      }
      work.verifying = true
      const valid = await policy.verify({
        input: registrationWorkInput(
          this.options.relayId,
          connection.challenge!,
          work.nonce,
          encodeMessage(work.register),
          message.solution,
        ),
        salt: work.nonce,
        bits: work.bits,
      })
      if (
        this.connections.get(connection.peer.id) !== connection
        || connection.work !== work
        || (connection.phase !== 'challenge' && connection.phase !== 'registered')
      )
        return
      if (valid !== true || this.options.now() > work.expires) {
        this.close(connection.peer.id, valid === 'overloaded' || valid === 'timeout' ? 4302 : 4100)
        return
      }
      await this.host(connection, work.register, work)
      return
    }
    if ((connection.phase === 'challenge' || connection.phase === 'registered') && message.type === 'register') {
      if (connection.work && connection.work !== acceptedWork) {
        this.close(connection.peer.id, 4100)
        return
      }
      const input = registrationInput(this.options.relayId, connection.challenge!, message.day, message.routePub)
      const signature = await crypto.verify(message.routePub, input, message.signature)
      if (
        this.connections.get(connection.peer.id) !== connection
        || (connection.phase !== 'challenge' && connection.phase !== 'registered')
      )
        return
      const mac =
        this.options.openRegistration || equal(await registrationMac(crypto, this.options.registrationToken!, input), message.regMac)
      if (
        this.connections.get(connection.peer.id) !== connection
        || (connection.phase !== 'challenge' && connection.phase !== 'registered')
      )
        return
      if (!signature || !mac || Math.abs(message.day - Math.floor(this.options.now() / 1000 / UTC_DAY)) > 1) {
        this.close(connection.peer.id, 4100)
        return
      }
      const route = await routeId(crypto, message.routePub),
        key = hex(route),
        previous = this.routes.get(key)
      if (
        this.connections.get(connection.peer.id) !== connection
        || (connection.phase !== 'challenge' && connection.phase !== 'registered')
      )
        return
      if (this.registering.has(key)) {
        this.close(connection.peer.id, 4200)
        return
      }
      let status: 0 | 1 | 4 | 5 | 6 = 0
      const owned = (connection.controlRoutes ??= new Set())
      if (!owned.has(key) && owned.size >= 8) {
        this.close(connection.peer.id, 4302)
        return
      }
      const prefixRoutes = [...this.routes.values()].filter(value => value.prefix === connection.peer.prefix && value !== previous).length
      if (prefixRoutes >= (this.options.maxRoutesPerPrefix ?? this.options.maxRoutes ?? 512)) {
        this.close(connection.peer.id, 4302)
        return
      }
      if (this.draining || this.options.serviceReady?.() === false || (!previous && this.routes.size >= (this.options.maxRoutes ?? 512))) {
        this.close(connection.peer.id, 4302)
        return
      }
      const policy = this.options.registrationWork
      if (!previous && policy && prefixRoutes >= policy.softRoutesPerPrefix && !acceptedWork) {
        const share = Math.min(
          1,
          Math.max(
            this.routes.size / (this.options.maxRoutes ?? 512),
            prefixRoutes / (this.options.maxRoutesPerPrefix ?? this.options.maxRoutes ?? 512),
          ),
        )
        const nonce = crypto.random(32),
          bits = policy.minBits + Math.floor((policy.maxBits - policy.minBits) * share)
        connection.work = {
          register: {
            ...message,
            previous: message.previous.slice(),
            routePub: message.routePub.slice(),
            signature: message.signature.slice(),
            regMac: message.regMac.slice(),
          },
          route,
          nonce,
          bits,
          expires: this.options.now() + 3000,
          verifying: false,
        }
        if (connection.phase === 'challenge') connection.opened = this.options.now()
        await connection.peer.send({ type: 'registration-work', routeId: route, nonce, bits })
        return
      }
      if (previous) {
        if (equal(previous.token, message.previous)) status = previous.control === undefined ? 1 : 4
        else if (previous.departed) status = 6
        else if (previous.control === undefined && this.options.now() - previous.since >= 20_000) status = 5
        else {
          this.close(connection.peer.id, 4200)
          return
        }
        if (previous.control !== undefined && previous.control !== connection.peer.id) this.close(previous.control, 4201)
      } else if (this.routes.size >= (this.options.maxRoutes ?? 512)) {
        this.close(connection.peer.id, 4302)
        return
      }
      this.registering.set(key, connection)
      try {
        // SQLite restores within this turn. Do not allocate a full route's tags if their reservation cannot fit.
        const limit = Math.min(8192, this.denialCapacity() + (previous?.deny.size ?? 0))
        const stored = this.options.denials?.get(route, message.day, limit)
        const restored = Array.isArray(stored) ? stored : ((await stored) ?? [])
        if (restored.length > 8192 || restored.some(tag => tag.length !== 16)) throw new Error('Invalid denial state')
        if (
          this.connections.get(connection.peer.id) !== connection
          || (connection.phase !== 'challenge' && connection.phase !== 'registered')
        )
          return
        const latest = this.routes.get(key)
        if (acceptedWork && this.options.now() > acceptedWork.expires) {
          this.close(connection.peer.id, 4100)
          return
        }
        if (
          this.draining
          || this.options.serviceReady?.() === false
          || (!latest && this.routes.size >= (this.options.maxRoutes ?? 512))
          || (!owned.has(key) && owned.size >= 8)
          || [...this.routes.values()].filter(value => value.prefix === connection.peer.prefix && value !== latest).length
            >= (this.options.maxRoutesPerPrefix ?? this.options.maxRoutes ?? 512)
        ) {
          this.close(connection.peer.id, 4302)
          return
        }
        const deny = new Set(latest?.deny)
        for (const tag of restored) deny.add(hex(tag))
        if (deny.size > Math.min(8192, this.denialCapacity() + (latest?.deny.size ?? 0))) {
          this.close(connection.peer.id, 4302)
          return
        }
        const token = crypto.random(32)
        this.denialTags += deny.size - (latest?.deny.size ?? 0)
        this.routes.set(key, {
          control: connection.peer.id,
          publicKey: message.routePub.slice(),
          prefix: connection.peer.prefix,
          alternate: message.alternate,
          id: route,
          token,
          day: message.day,
          since: this.options.now(),
          deny,
          ...(latest?.denialBlocked ? { denialBlocked: true } : {}),
        })
        owned.add(key)
        connection.work = undefined
        this.authenticated(connection)
        connection.phase = 'registered'
        await connection.peer.send({ type: 'registered', token, routeId: route, status })
      } finally {
        if (this.registering.get(key) === connection) this.registering.delete(key)
      }
      return
    }
    if (connection.phase === 'registered' && message.type === 'deny') {
      const routeKey = hex(message.routeId),
        route = this.routes.get(routeKey)
      if (!route || route.control !== connection.peer.id || !connection.controlRoutes?.has(routeKey)) throw new RangeError('Invalid DENY')
      const tags = new Set(message.tags.map(hex))
      const added = [...tags].filter(tag => !route.deny.has(tag))
      if (added.length + route.deny.size > 8192 || added.length > this.denialCapacity()) {
        if (this.options.maxDenialTags !== undefined) {
          route.denialBlocked = true
          for (const active of this.connections.values()) if (active.route === routeKey) this.close(active.peer.id, 4100)
        }
        throw new RangeError('DENY limit')
      }
      for (const tag of added) route.deny.add(tag)
      this.denialTags += added.length
      for (const active of this.connections.values())
        if (active.route === routeKey && active.tag !== undefined && tags.has(active.tag)) this.close(active.peer.id, 4100)
      if (this.options.denials) {
        const count = await this.options.denials.add(message.routeId, route.day, message.tags)
        const digest = await denyBatchDigest(crypto, message.routeId, message.tags)
        await connection.peer.send({ type: 'deny-ack', routeId: message.routeId, digest, count })
      }
      return
    }
    if (connection.phase === 'registered' && message.type === 'depart') {
      for (const key of connection.controlRoutes ?? []) {
        const route = this.routes.get(key)
        if (!route || route.control !== connection.peer.id) continue
        route.departed = message.state
        route.since = this.options.now()
        route.control = undefined
      }
      this.close(connection.peer.id, 1000)
      return
    }
    if (connection.phase === 'registered' && message.type === 'drop') {
      const key = hex(message.routeId),
        route = this.routes.get(key)
      if (!route || route.control !== connection.peer.id || !connection.controlRoutes?.has(key)) throw new RangeError('Invalid DROP')
      connection.controlRoutes.delete(key)
      route.control = undefined
      route.since = this.options.now()
      return
    }
    throw new RangeError('Unexpected control message')
  }
  private denialCapacity(): number {
    return (this.options.maxDenialTags ?? Infinity) - this.denialTags
  }
  /** The nonce is kept on the connection: a host signs REGISTER over it and a client's admission proof is bound to it. */
  private async edgeChallenge(connection: Connection, clientNonce: Uint8Array): Promise<void> {
    const nonce = this.options.crypto.random(32),
      timeMs = this.options.now(),
      requiresToken = connection.role === 'host' && !this.options.openRegistration
    connection.phase = 'challenge'
    connection.challenge = nonce
    const signature = await signEdgeChallenge(this.options.crypto, this.options.edgeIdentity!.seed, {
      relayId: this.options.relayId,
      role: connection.role satisfies EdgeRole,
      clientNonce,
      relayNonce: nonce,
      timeMs,
      requiresToken,
    })
    if (this.connections.get(connection.peer.id) !== connection || connection.phase !== 'challenge') return
    await connection.peer.send({ type: 'edge-challenge', relayId: this.options.relayId, nonce, timeMs, requiresToken, signature })
  }
  private async admit(
    connection: Connection,
    proof: Extract<RelayMessage, { type: 'admit' }>['proof'],
    relayNonce?: Uint8Array,
  ): Promise<void> {
    const pass = await verifyProof(this.options.crypto, this.options.relayId, proof, this.options.now(), relayNonce)
    if (this.connections.get(connection.peer.id) !== connection || (connection.phase !== 'new' && connection.phase !== 'challenge')) return
    if (!pass) {
      this.close(connection.peer.id, 4100)
      return
    }
    const key = hex(await routeId(this.options.crypto, pass.routePub)),
      tag = hex(pass.tag),
      route = this.routes.get(key)
    if (this.connections.get(connection.peer.id) !== connection || (connection.phase !== 'new' && connection.phase !== 'challenge')) return
    const holderPublic = hex(pass.holderPub)
    const nonce = `${holderPublic}:${hex(proof.nonce)}`,
      holderKey = `${key}:${pass.day}:${holderPublic}`
    const routeDay = `${key}:${pass.day}`
    const holder = this.holders.get(holderKey)
    const prefixes = [...new Set([route?.prefix ?? connection.peer.prefix, connection.peer.prefix])]
    const prefixLimit = Math.max(1, Math.floor(16_384 * (this.options.maxPrefixFraction ?? 1)))
    const activity = this.holderActivity.get(holderPublic) ?? { active: 0, pending: 0 }
    const active = activity.active,
      unspliced = activity.pending
    if (
      this.replay.has(nonce)
      || this.replay.size >= 16_384
      || (!holder && this.holders.size >= 16_384)
      || prefixes.some(
        prefix =>
          (this.replayPrefixes.get(prefix) ?? 0) >= prefixLimit || (!holder && (this.holderPrefixes.get(prefix) ?? 0) >= prefixLimit),
      )
      || !route
      || route.denialBlocked
      || route.deny.has(tag)
    ) {
      this.close(connection.peer.id, 4100)
      return
    }
    if (active >= 4 || unspliced >= 2 || (!holder && (this.routeHolders.get(routeDay) ?? 0) >= 32)) {
      this.close(connection.peer.id, 4102)
      return
    }
    this.replay.set(nonce, { expires: this.options.now() + 300_000, prefixes })
    for (const prefix of prefixes) this.replayPrefixes.set(prefix, (this.replayPrefixes.get(prefix) ?? 0) + 1)
    if (!holder) {
      this.holders.set(holderKey, { day: pass.day, route: routeDay, prefixes })
      this.routeHolders.set(routeDay, (this.routeHolders.get(routeDay) ?? 0) + 1)
      for (const prefix of prefixes) this.holderPrefixes.set(prefix, (this.holderPrefixes.get(prefix) ?? 0) + 1)
    }
    if (
      route.control === undefined
      || route.departed
      || (connection.peer.profile === 'outer-pad-v2' && this.connections.get(route.control)?.peer.profile !== 'outer-pad-v2')
    ) {
      await connection.peer.send({ type: 'unavailable', state: route.departed ?? 0, since: Math.floor(route.since / 1000) })
      this.close(connection.peer.id, 4101)
      return
    }
    if (this.draining) {
      this.close(connection.peer.id, 4300)
      return
    }
    const request = this.options.crypto.random(8),
      requestKey = hex(request)
    if (this.pending.has(requestKey)) {
      this.close(connection.peer.id, 4302)
      return
    }
    this.authenticated(connection)
    connection.phase = 'pending'
    connection.route = key
    connection.tag = tag
    connection.holder = holderPublic
    connection.pendingKey = requestKey
    this.holderActivity.set(holderPublic, { active: activity.active + 1, pending: activity.pending + 1 })
    this.pending.set(requestKey, { client: connection.peer.id, route: key, nonce: new Set(), opened: this.options.now() })
    await connection.peer.send({ type: 'admitted' })
    if (
      this.connections.get(connection.peer.id) !== connection
      || connection.phase !== 'pending'
      || this.pending.get(requestKey)?.client !== connection.peer.id
    )
      return
    const control = this.connections.get(route.control)
    if (!control) {
      this.close(connection.peer.id, 4101)
      return
    }
    await control.peer.send({
      type: 'open',
      connection: request,
      routeId: route.id,
      ...(connection.peer.profile ? { profile: connection.peer.profile } : {}),
    })
  }
  private async attach(connection: Connection, message: Extract<RelayMessage, { type: 'attach' }>): Promise<void> {
    const key = hex(message.routeId),
      route = this.routes.get(key),
      requestKey = hex(message.connection),
      pending = this.pending.get(requestKey)
    if (!route || !pending || pending.route !== key) {
      this.close(connection.peer.id, 4100)
      return
    }
    const valid = equal(await attachMac(this.options.crypto, route.token, message.routeId, message.connection, message.nonce), message.mac)
    const expected = this.options.edgeIdentity ? 'challenge' : 'new'
    if (this.connections.get(connection.peer.id) !== connection || connection.phase !== expected) return
    if (!valid || this.routes.get(key) !== route || this.pending.get(requestKey) !== pending) {
      this.close(connection.peer.id, 4100)
      return
    }
    const client = this.connections.get(pending.client)
    if (
      !client
      || client.phase !== 'pending'
      || client.peer.profile !== connection.peer.profile
      || this.connections.get(connection.peer.id) !== connection
    ) {
      this.close(connection.peer.id, 4100)
      return
    }
    this.pending.delete(requestKey)
    this.authenticated(connection)
    connection.phase = 'spliced'
    connection.route = key
    connection.tag = client.tag
    connection.partner = client.peer.id
    client.pendingKey = undefined
    if (client.holder) {
      const activity = this.holderActivity.get(client.holder)
      if (activity) activity.pending--
    }
    client.phase = 'spliced'
    client.partner = connection.peer.id
    connection.peer.markSpliced?.()
    client.peer.markSpliced?.()
    await connection.peer.send({ type: 'attached' })
    const tag = Uint8Array.from(client.tag!.match(/../gu)!, byte => Number.parseInt(byte, 16))
    await connection.peer.send({ type: 'spliced', connection: message.connection, passTag: tag })
    await client.peer.send({ type: 'spliced', connection: message.connection, passTag: tag })
  }
  disconnect(id: number): void {
    const connection = this.connections.get(id)
    if (!connection) return
    this.connections.delete(id)
    for (const [key, owner] of this.registering) if (owner === connection) this.registering.delete(key)
    this.authenticated(connection)
    const prefixCount = (this.prefixConnections.get(connection.peer.prefix) ?? 1) - 1
    if (prefixCount <= 0) this.prefixConnections.delete(connection.peer.prefix)
    else this.prefixConnections.set(connection.peer.prefix, prefixCount)
    if (connection.role === 'client' && connection.holder) {
      const activity = this.holderActivity.get(connection.holder)
      if (activity) {
        activity.active--
        if (connection.phase === 'pending') activity.pending--
        if (activity.active <= 0) this.holderActivity.delete(connection.holder)
      }
    }
    this.options.cancelWait?.(id)
    if (connection.partner !== undefined) this.close(connection.partner, 1000)
    for (const key of connection.controlRoutes ?? []) {
      const route = this.routes.get(key)
      if (route?.control !== id) continue
      route.control = undefined
      route.since = this.options.now()
    }
    if (connection.pendingKey && this.pending.get(connection.pendingKey)?.client === id) this.pending.delete(connection.pendingKey)
  }
  private close(id: number, code: number): void {
    const peer = this.connections.get(id)?.peer
    this.disconnect(id)
    peer?.close(code)
  }
  sweep(): void {
    const now = this.options.now()
    this.lastSweepAt = now
    for (const [id, value] of this.connections)
      if (((value.phase === 'new' || value.phase === 'challenge') && now - value.opened > 3000) || (value.work && now > value.work.expires))
        this.close(id, 4100)
    for (const [key, value] of this.pending)
      if (now - value.opened > 6000) {
        this.pending.delete(key)
        this.close(value.client, 4101)
      }
    const decrement = (map: Map<string, number>, key: string) => {
      const next = (map.get(key) ?? 1) - 1
      if (next <= 0) map.delete(key)
      else map.set(key, next)
    }
    for (const [key, value] of this.replay)
      if (value.expires < now) {
        this.replay.delete(key)
        for (const prefix of value.prefixes) decrement(this.replayPrefixes, prefix)
      }
    for (const [key, value] of this.holders)
      if (now > ((value.day + 1) * UTC_DAY + 900) * 1000) {
        this.holders.delete(key)
        decrement(this.routeHolders, value.route)
        for (const prefix of value.prefixes) decrement(this.holderPrefixes, prefix)
      }
    for (const [key, route] of this.routes) {
      if (route.control === undefined && now - route.since > 86_400_000) {
        this.denialTags -= route.deny.size
        this.routes.delete(key)
      }
    }
  }
  drain(): void {
    if (this.draining) return
    this.draining = true
    this.notify(1, 30_000)
  }
  notify(reason: 1 | 2 | 3, retryAfterMs: number): void {
    for (const value of this.connections.values())
      if (value.phase === 'registered')
        void value.peer.send({ type: 'goaway', reason, retryAfterMs }).catch(() => this.close(value.peer.id, 4400))
  }
  resources(): Array<{
    id: number
    prefix: string
    spliced: boolean
    bufferedBytes: number
    pendingWriteBytes: number
    writtenBytes: number
  }> {
    return [...this.connections.values()].map(value => ({
      id: value.peer.id,
      prefix: value.peer.prefix,
      spliced: value.phase === 'spliced',
      ...(value.peer.metrics?.() ?? { bufferedBytes: 0, pendingWriteBytes: 0, writtenBytes: 0 }),
    }))
  }
  evict(id: number, reason: 2 | 3): void {
    const value = this.connections.get(id)
    if (!value) return
    const route = value.route ? this.routes.get(value.route) : undefined
    const control = route?.control === undefined ? undefined : this.connections.get(route.control)
    if (control) void control.peer.send({ type: 'goaway', reason, retryAfterMs: 30_000 }).catch(() => {})
    this.close(id, reason === 3 ? 4304 : 4302)
  }

  status(): { connections: number; routes: number; pending: number; draining: boolean; controls: number; withoutAlternate: number } {
    const controls = new Map<number, boolean>()
    for (const route of this.routes.values())
      if (route.control !== undefined) controls.set(route.control, (controls.get(route.control) ?? true) && route.alternate)
    return {
      connections: this.connections.size,
      routes: this.routes.size,
      pending: this.pending.size,
      draining: this.draining,
      controls: controls.size,
      withoutAlternate: [...controls.values()].filter(value => !value).length,
    }
  }
}
