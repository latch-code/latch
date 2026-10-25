import { attachMac, equal, hex, registrationInput, registrationMac, routeId, type RelayMessage } from '@latch/link-wire'
import { nodeCrypto } from './crypto.ts'
import { RelayTunnel, type RelayEndpoint } from './tunnel.ts'
import { connectRelay, RelayClosed, type RelaySocket } from './websocket.ts'

type Registered = Extract<RelayMessage, { type: 'registered' }>
type Open = Extract<RelayMessage, { type: 'open' }>
export interface RelaySetup {
  stream: RelayTunnel
  passTag: Uint8Array
  routeId: Uint8Array
  /** Called after native authentication settles; close also releases the bounded setup slot. */
  finishSetup(): void
}
async function dial(options: RelayEndpoint, path: string, signal?: AbortSignal): Promise<RelaySocket> {
  const url = new URL(options.url)
  url.pathname = path
  const address = options.resolveAddress ? await options.resolveAddress() : undefined
  if (signal?.aborted) throw new Error('Relay setup cancelled')
  return connectRelay({ url, spki: options.spki, ca: options.ca, address, signal })
}

/** One control socket, one receive pump, at most eight route memberships and eight queued/authenticating opens. */
export class RelayControl {
  readonly closed: Promise<Error>
  private resolveClosed!: (error: Error) => void
  private readonly peer: RelaySocket
  private readonly options: RelayEndpoint & { registrationToken?: Uint8Array }
  private readonly nonce: Uint8Array
  private readonly routes = new Map<string, Registered>()
  private readonly opens: Open[] = []
  private readonly waiters: Array<{ resolve(value: Open): void; reject(error: Error): void }> = []
  private readonly attaching = new Set<RelaySocket>()
  private registration?: {
    routeId: Uint8Array
    resolve(value: Registered): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
  }
  private queue = Promise.resolve()
  private queuedRegistrations = 0
  private setups = 0
  private failure?: Error
  private openWindow = Date.now()
  private openCount = 0
  private constructor(peer: RelaySocket, options: RelayEndpoint & { registrationToken?: Uint8Array }, nonce: Uint8Array) {
    this.peer = peer
    this.options = options
    this.nonce = nonce
    this.closed = new Promise(resolve => {
      this.resolveClosed = resolve
    })
    void this.receive()
  }
  static async connect(options: RelayEndpoint & { registrationToken?: Uint8Array; signal?: AbortSignal }): Promise<RelayControl> {
    const peer = await dial(options, '/v1/h', options.signal)
    try {
      await peer.send({ type: 'hello' })
      const hello = await peer.receive(5000)
      if (
        hello.type !== 'challenge'
        || !equal(hello.relayId, options.relayId)
        || Math.abs(hello.timeMs - Date.now()) > 86_400_000
        || (hello.requiresToken && options.registrationToken?.length !== 32)
      )
        throw new Error('Relay challenge rejected')
      return new RelayControl(peer, options, hello.nonce)
    } catch (error) {
      peer.close()
      throw error
    }
  }
  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    this.resolveClosed(error)
    if (this.registration) {
      clearTimeout(this.registration.timer)
      this.registration.reject(error)
      this.registration = undefined
    }
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
    this.opens.length = 0
    for (const peer of this.attaching) peer.close()
    this.attaching.clear()
    this.peer.close()
  }
  close(): void {
    this.fail(new RelayClosed(1000))
  }
  isClosed(): boolean {
    return this.failure !== undefined
  }
  private async receive(): Promise<void> {
    try {
      for (;;) {
        const message = await this.peer.receive(0)
        if (message.type === 'registered') {
          const pending = this.registration
          if (!pending || !equal(pending.routeId, message.routeId)) throw new Error('Unexpected relay registration response')
          this.registration = undefined
          clearTimeout(pending.timer)
          this.routes.set(hex(message.routeId), message)
          pending.resolve(message)
        } else if (message.type === 'open') {
          const now = Date.now()
          if (now - this.openWindow >= 1000) {
            this.openWindow = now
            this.openCount = 0
          }
          if (++this.openCount > 16) throw new Error('Relay OPEN rate limit')
          if (!this.routes.has(hex(message.routeId))) continue
          if (this.opens.length + this.setups >= 8) continue
          const waiter = this.waiters.shift()
          if (waiter) {
            this.setups++
            waiter.resolve(message)
          } else this.opens.push(message)
        } else if (message.type === 'goaway') {
          // Only this node's retry owner sees this hint; it cannot affect identities or other candidates.
          throw new RelayClosed(4300)
        } else throw new Error('Unexpected relay control message')
      }
    } catch (error) {
      this.fail(error instanceof RelayClosed ? error : new Error('Relay control unavailable'))
    }
  }
  register(input: { routeKey: Uint8Array; day: number; previous?: Uint8Array; alternate: boolean }): Promise<Registered> {
    if (this.queuedRegistrations >= 8) return Promise.reject(new Error('Relay registration queue limit'))
    this.queuedRegistrations++
    const result = this.queue.then(async () => {
      if (this.failure) throw this.failure
      const routePub = await nodeCrypto.publicKey(input.routeKey),
        id = await routeId(nodeCrypto, routePub)
      if (this.routes.size >= 8 && !this.routes.has(hex(id))) throw new Error('Relay route membership limit')
      const signed = registrationInput(this.options.relayId, this.nonce, input.day, routePub)
      const signature = await nodeCrypto.sign(input.routeKey, signed),
        regMac = this.options.registrationToken
          ? await registrationMac(nodeCrypto, this.options.registrationToken, signed)
          : new Uint8Array(16)
      if (this.failure) throw this.failure
      const pending = new Promise<Registered>((resolve, reject) => {
        const timer = setTimeout(() => this.fail(new Error('Relay registration timed out')), 5000)
        timer.unref()
        this.registration = { routeId: id, resolve, reject, timer }
      })
      try {
        await this.peer.send({
          type: 'register',
          routePub,
          day: input.day,
          previous: input.previous ?? new Uint8Array(32),
          signature,
          regMac,
          alternate: input.alternate,
        })
      } catch {
        this.fail(new Error('Relay registration write failed'))
      }
      return pending
    })
    this.queue = result.then(
      () => {},
      () => {},
    )
    return result.finally(() => {
      this.queuedRegistrations--
    })
  }
  async deny(routeId: Uint8Array, tags: Uint8Array[]): Promise<void> {
    if (this.failure) throw this.failure
    if (!this.routes.has(hex(routeId))) throw new Error('Relay route not registered')
    await this.peer.send({ type: 'deny', routeId, tags })
  }
  async drop(routeId: Uint8Array): Promise<void> {
    if (this.failure) throw this.failure
    if (!this.routes.has(hex(routeId))) return
    await this.peer.send({ type: 'drop', routeId })
    this.routes.delete(hex(routeId))
    for (let index = this.opens.length - 1; index >= 0; index--) if (equal(this.opens[index]!.routeId, routeId)) this.opens.splice(index, 1)
  }
  async depart(state: 1 | 2 | 3): Promise<void> {
    if (this.failure) return
    try {
      await this.peer.send({ type: 'depart', state })
    } finally {
      this.close()
    }
  }
  async accept(): Promise<RelaySetup> {
    if (this.failure) throw this.failure
    let request = this.opens.shift()
    if (request) this.setups++
    else {
      if (this.waiters.length >= 8) throw new Error('Relay accept queue limit')
      request = await new Promise<Open>((resolve, reject) => this.waiters.push({ resolve, reject }))
    }
    let stream: RelayTunnel | undefined,
      finished = false
    const finishSetup = () => {
      if (finished) return
      finished = true
      this.setups--
      stream?.off('close', finishSetup)
    }
    let data: RelaySocket | undefined
    try {
      const route = this.routes.get(hex(request.routeId))
      if (!route || this.failure) throw new Error('Relay route unavailable')
      data = await dial(this.options, '/v1/d')
      this.attaching.add(data)
      if (this.failure) throw this.failure
      const nonce = nodeCrypto.random(16)
      await data.send({
        type: 'attach',
        routeId: route.routeId,
        connection: request.connection,
        nonce,
        mac: await attachMac(nodeCrypto, route.token, route.routeId, request.connection, nonce),
      })
      const attached = await data.receive(5000),
        spliced = await data.receive(5000)
      if (attached.type !== 'attached' || spliced.type !== 'spliced' || !equal(spliced.connection, request.connection))
        throw new Error('Relay attach refused')
      this.attaching.delete(data)
      stream = new RelayTunnel(data)
      stream.once('close', finishSetup)
      return { stream, passTag: spliced.passTag, routeId: route.routeId, finishSetup }
    } catch (error) {
      data?.close()
      if (data) this.attaching.delete(data)
      finishSetup()
      throw error
    }
  }
}
