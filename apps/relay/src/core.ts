import {
  attachMac,
  equal,
  hex,
  registrationInput,
  registrationMac,
  routeId,
  UTC_DAY,
  verifyProof,
  type LinkCrypto,
  type RelayMessage,
} from '@latch/link-wire'

export interface RelayPeer {
  id: number
  prefix: string
  send(message: RelayMessage): Promise<void>
  close(code: number): void
}
type Role = 'host' | 'data' | 'client'
type Connection = {
  peer: RelayPeer
  role: Role
  phase: 'new' | 'challenge' | 'registered' | 'pending' | 'spliced'
  challenge?: Uint8Array
  route?: string
  controlRoutes?: Set<string>
  tag?: string
  partner?: number
  opened: number
}
type Route = {
  control?: number
  publicKey: Uint8Array
  id: Uint8Array
  token: Uint8Array
  day: number
  departed?: 1 | 2 | 3
  since: number
  deny: Set<string>
}
type Pending = { client: number; route: string; nonce: Set<string>; opened: number }
export interface RelayCoreOptions {
  crypto: LinkCrypto
  relayId: Uint8Array
  registrationToken?: Uint8Array
  openRegistration?: boolean
  now(): number
  maxConnections?: number
  maxRoutes?: number
  maxPerPrefix?: number
  allowBytes?(prefixes: readonly string[], route: string, bytes: number): boolean
}

/** I/O, timers, certificate management and persistence belong to the adapter. */
export class RelayCore {
  private readonly options: RelayCoreOptions
  private readonly connections = new Map<number, Connection>()
  private readonly routes = new Map<string, Route>()
  private readonly pending = new Map<string, Pending>()
  private readonly replay = new Map<string, number>()
  private readonly holders = new Map<string, { day: number; count: number }>()
  private draining = false
  constructor(options: RelayCoreOptions) {
    if (options.relayId.length !== 16 || (!options.openRegistration && options.registrationToken?.length !== 32))
      throw new RangeError('A private relay requires a registration token')
    this.options = options
  }
  connect(peer: RelayPeer, role: Role): boolean {
    this.sweep()
    const group = [...this.connections.values()].filter(value => value.peer.prefix === peer.prefix)
    if (
      this.draining
      || this.connections.size >= (this.options.maxConnections ?? 1024)
      || group.length >= (this.options.maxPerPrefix ?? 64)
      || this.connections.has(peer.id)
    ) {
      peer.close(4302)
      return false
    }
    this.connections.set(peer.id, { peer, role, phase: 'new', opened: this.options.now() })
    return true
  }
  async receive(id: number, message: RelayMessage): Promise<void> {
    const connection = this.connections.get(id)
    if (!connection) return
    try {
      if (connection.phase === 'spliced') {
        if (message.type !== 'data') throw new RangeError('Expected DATA')
        const partner = this.connections.get(connection.partner!)
        if (
          !partner
          || (!this.options.allowBytes?.([connection.peer.prefix, partner.peer.prefix], connection.route!, message.data.length * 2)
            && this.options.allowBytes)
        ) {
          this.close(id, 4304)
          return
        }
        await partner.peer.send(message)
        return
      }
      if (connection.role === 'host') {
        await this.host(connection, message)
        return
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
      this.close(id, 4400)
    }
  }
  private async host(connection: Connection, message: RelayMessage): Promise<void> {
    const { crypto } = this.options
    if (connection.phase === 'new' && message.type === 'hello') {
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
    if ((connection.phase === 'challenge' || connection.phase === 'registered') && message.type === 'register') {
      const input = registrationInput(this.options.relayId, connection.challenge!, message.day, message.routePub)
      const signature = await crypto.verify(message.routePub, input, message.signature)
      const mac =
        this.options.openRegistration || equal(await registrationMac(crypto, this.options.registrationToken!, input), message.regMac)
      if (!signature || !mac || Math.abs(message.day - Math.floor(this.options.now() / 1000 / UTC_DAY)) > 1) {
        this.close(connection.peer.id, 4100)
        return
      }
      const route = await routeId(crypto, message.routePub),
        key = hex(route),
        previous = this.routes.get(key)
      if (!this.connections.has(connection.peer.id)) return
      let status: 0 | 1 | 4 | 5 | 6 = 0
      const owned = (connection.controlRoutes ??= new Set())
      if (!owned.has(key) && owned.size >= 8) {
        this.close(connection.peer.id, 4302)
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
      const token = crypto.random(32)
      this.routes.set(key, {
        control: connection.peer.id,
        publicKey: message.routePub.slice(),
        id: route,
        token,
        day: message.day,
        since: this.options.now(),
        deny: previous?.deny ?? new Set(),
      })
      owned.add(key)
      connection.phase = 'registered'
      await connection.peer.send({ type: 'registered', token, routeId: route, status })
      return
    }
    if (connection.phase === 'registered' && message.type === 'deny') {
      const routeKey = hex(message.routeId),
        route = this.routes.get(routeKey)
      if (!route || route.control !== connection.peer.id || !connection.controlRoutes?.has(routeKey)) throw new RangeError('Invalid DENY')
      if (new Set([...route.deny, ...message.tags.map(hex)]).size > 8192) throw new RangeError('DENY limit')
      for (const tag of message.tags) {
        const key = hex(tag)
        route.deny.add(key)
        for (const active of this.connections.values())
          if (active.route === routeKey && active.tag === key) this.close(active.peer.id, 4100)
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
  private async admit(connection: Connection, proof: Extract<RelayMessage, { type: 'admit' }>['proof']): Promise<void> {
    const pass = await verifyProof(this.options.crypto, this.options.relayId, proof, this.options.now())
    if (!pass || !this.connections.has(connection.peer.id)) {
      this.close(connection.peer.id, 4100)
      return
    }
    const key = hex(await routeId(this.options.crypto, pass.routePub)),
      tag = hex(pass.tag),
      route = this.routes.get(key)
    const nonce = `${hex(pass.holderPub)}:${hex(proof.nonce)}`,
      holderKey = hex(pass.holderPub)
    const holder = this.holders.get(holderKey),
      day = Math.floor(this.options.now() / 1000 / UTC_DAY)
    const related = [...this.connections.values()].filter(value => value.role === 'client' && value.tag === tag && value.route === key)
    const active = related.length,
      unspliced = related.filter(value => value.phase === 'pending').length
    if (
      this.replay.has(nonce)
      || this.replay.size >= 16_384
      || this.holders.size >= 16_384
      || (holder?.day === day && holder.count >= 32)
      || active >= 4
      || unspliced >= 2
      || !route
      || route.deny.has(tag)
    ) {
      this.close(connection.peer.id, 4100)
      return
    }
    this.replay.set(nonce, this.options.now() + 300_000)
    this.holders.set(holderKey, { day, count: holder?.day === day ? holder.count + 1 : 1 })
    if (route.control === undefined || route.departed) {
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
    connection.phase = 'pending'
    connection.route = key
    connection.tag = tag
    this.pending.set(requestKey, { client: connection.peer.id, route: key, nonce: new Set(), opened: this.options.now() })
    await connection.peer.send({ type: 'admitted' })
    const control = this.connections.get(route.control)
    if (!control) {
      this.close(connection.peer.id, 4101)
      return
    }
    await control.peer.send({ type: 'open', connection: request, routeId: route.id })
  }
  private async attach(connection: Connection, message: Extract<RelayMessage, { type: 'attach' }>): Promise<void> {
    const key = hex(message.routeId),
      route = this.routes.get(key),
      requestKey = hex(message.connection),
      pending = this.pending.get(requestKey)
    if (
      !route
      || !pending
      || pending.route !== key
      || !equal(await attachMac(this.options.crypto, route.token, message.routeId, message.connection, message.nonce), message.mac)
      || this.routes.get(key) !== route
      || this.pending.get(requestKey) !== pending
    ) {
      this.close(connection.peer.id, 4100)
      return
    }
    const client = this.connections.get(pending.client)
    if (!client || client.phase !== 'pending' || !this.connections.has(connection.peer.id)) {
      this.close(connection.peer.id, 4100)
      return
    }
    this.pending.delete(requestKey)
    connection.phase = 'spliced'
    connection.route = key
    connection.tag = client.tag
    connection.partner = client.peer.id
    client.phase = 'spliced'
    client.partner = connection.peer.id
    await connection.peer.send({ type: 'attached' })
    const tag = Uint8Array.from(client.tag!.match(/../gu)!, byte => Number.parseInt(byte, 16))
    await connection.peer.send({ type: 'spliced', connection: message.connection, passTag: tag })
    await client.peer.send({ type: 'spliced', connection: message.connection, passTag: tag })
  }
  disconnect(id: number): void {
    const connection = this.connections.get(id)
    if (!connection) return
    this.connections.delete(id)
    if (connection.partner !== undefined) this.close(connection.partner, 1000)
    for (const key of connection.controlRoutes ?? []) {
      const route = this.routes.get(key)
      if (route?.control !== id) continue
      route.control = undefined
      route.since = this.options.now()
    }
    for (const [key, pending] of this.pending) if (pending.client === id) this.pending.delete(key)
  }
  private close(id: number, code: number): void {
    const peer = this.connections.get(id)?.peer
    this.disconnect(id)
    peer?.close(code)
  }
  sweep(): void {
    const now = this.options.now()
    for (const [id, value] of this.connections)
      if ((value.phase === 'new' || value.phase === 'challenge') && now - value.opened > 3000) this.close(id, 4100)
    for (const [key, value] of this.pending)
      if (now - value.opened > 10_000) {
        this.pending.delete(key)
        this.close(value.client, 4101)
      }
    for (const [key, expires] of this.replay) if (expires < now) this.replay.delete(key)
    for (const [key, value] of this.holders) if (value.day < Math.floor(now / 1000 / UTC_DAY)) this.holders.delete(key)
    for (const [key, route] of this.routes) if (route.control === undefined && now - route.since > 86_400_000) this.routes.delete(key)
  }
  drain(): void {
    this.draining = true
  }
  status(): { connections: number; routes: number; pending: number; draining: boolean } {
    return { connections: this.connections.size, routes: this.routes.size, pending: this.pending.size, draining: this.draining }
  }
}
