import { Duplex } from 'node:stream'
import {
  attachMac,
  EDGE_RELAY,
  edgeRelayPath,
  encodeMessage,
  equal,
  verifyEdgeChallenge,
  type EdgeRole,
  makeProof,
  registrationInput,
  registrationMac,
  routeId,
  type RelayMessage,
  type RelayTransportProfile,
} from '@latch/link-wire'
import { nodeCrypto } from './crypto.ts'
import { connectRelay, type RelaySocket } from './websocket.ts'
import { solveRegistrationWork } from './registration-work.ts'

export class RelayTunnel extends Duplex {
  readonly transportClosed: Promise<void>
  private readonly peer: RelaySocket
  private reading = false
  constructor(peer: RelaySocket) {
    super({ highWaterMark: 16_384 })
    this.peer = peer
    this.transportClosed = peer.closed
    peer.markSpliced()
  }
  override _read(): void {
    if (this.reading) return
    this.reading = true
    void (async () => {
      try {
        for (;;) {
          const message = await this.peer.receive(0)
          if (message.type !== 'data') throw new Error('Unexpected tunnel message')
          if (!this.push(message.data)) {
            this.reading = false
            return
          }
        }
      } catch {
        this.destroy(new Error('Relay tunnel closed'))
      }
    })()
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void (async () => {
      try {
        for (let at = 0; at < chunk.length; at += 16_384) await this.peer.send({ type: 'data', data: chunk.subarray(at, at + 16_384) })
        callback()
      } catch {
        callback(new Error('Relay tunnel write failed'))
      }
    })()
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.peer.close()
    void this.peer.closed.then(() => callback(error))
  }
  guardWrites(valid: () => boolean): void {
    this.peer.guardWrites(valid)
  }
}
export interface RelayEndpoint {
  url: URL
  relayId: Uint8Array
  /** Self-hosted kind: the pinned TLS key. */
  spki?: Uint8Array
  /** Edge kind: the relay key that signs every challenge, and the shard all roles of a route dial. */
  edge?: { relayKey: Uint8Array; shard: number }
  ca?: string | Buffer
  profile?: RelayTransportProfile
  /** Edge kind: further origins of the same node, raced with `url` (relay-identity binds the node, not the hostname). */
  extraUrls?: URL[]
  /** The checked dial address for one role URL; on an edge node each origin is resolved on its own. */
  resolveAddress?(url: URL): Promise<string>
}
type Hello = { nonce: Uint8Array; timeMs: number; requiresToken: boolean }
/** The origin of each edge node that last passed the identity check, tried first next time. Never more than 64. */
const lastGood = new Map<string, string>()
/** Staggered start of the further origins of one edge node, as the path race staggers its relay slot. */
export const EDGE_ORIGIN_STAGGER_MS = 250
/** The URL of one role: `/v1/{h,d,c}` on a self-hosted node, `/v1/{h,d,c}/<shard>` on an edge node. */
export function relayRoleUrl(options: Pick<RelayEndpoint, 'url' | 'edge'>, role: EdgeRole): URL {
  const url = new URL(options.url)
  url.pathname = options.edge ? edgeRelayPath(role, options.edge.shard) : `/v1/${role === 'host' ? 'h' : role === 'data' ? 'd' : 'c'}`
  return url
}
/**
 * Opens one role's socket. Self-hosted: the one pinned URL, then HELLO (DATA legs have none). Edge: every origin of the
 * node races, staggered, and the first whose relay-key signature verifies wins; the rest are closed. A connection is
 * bound to the node only by that signature, so an origin that answers with another key just loses the race.
 */
export async function openRelay(
  options: RelayEndpoint,
  role: EdgeRole,
  signal?: AbortSignal,
  guardWrites?: () => boolean,
): Promise<{ peer: RelaySocket; hello?: Hello }> {
  const open = async (origin: URL) => {
    const url = relayRoleUrl({ url: origin, edge: options.edge }, role)
    const address = options.resolveAddress ? await options.resolveAddress(url) : undefined
    if (signal?.aborted) throw new Error('Relay setup cancelled')
    const peer = await connectRelay({
      url,
      ...(options.edge ? { edge: options.edge } : { spki: options.spki }),
      ca: options.ca,
      profile: options.profile,
      ...(address === undefined ? {} : { address }),
      ...(signal ? { signal } : {}),
    })
    if (guardWrites) peer.guardWrites(guardWrites)
    return peer
  }
  if (!options.edge) {
    const peer = await open(options.url)
    if (role === 'data') return { peer }
    try {
      return { peer, hello: await challenge(peer, options.relayId) }
    } catch (error) {
      peer.close()
      throw error
    }
  }
  const key = Buffer.from(options.relayId).toString('hex'),
    origins = [options.url, ...(options.extraUrls ?? [])].slice(0, 4)
  const remembered = origins.findIndex(origin => origin.origin === lastGood.get(key))
  if (remembered > 0) origins.unshift(...origins.splice(remembered, 1))
  return new Promise((resolve, reject) => {
    let settled = false,
      failed = 0,
      mismatched = false
    const timers: Array<ReturnType<typeof setTimeout>> = []
    origins.forEach((origin, index) => {
      const attempt = async () => {
        if (settled || signal?.aborted) throw new Error('Relay setup cancelled')
        const peer = await open(origin)
        try {
          if (settled) throw new Error('Relay race settled')
          const hello = await edgeHandshake(peer, options, role)
          if (settled) throw new Error('Relay race settled')
          settled = true
          for (const timer of timers) clearTimeout(timer)
          if (lastGood.size >= 64 && !lastGood.has(key)) lastGood.delete(lastGood.keys().next().value!)
          lastGood.set(key, origin.origin)
          resolve({ peer, hello })
        } catch (error) {
          peer.close()
          if (error instanceof Error && error.message === 'Relay identity rejected') mismatched = true
          throw error
        }
      }
      const run = () =>
        void attempt().catch(() => {
          if (++failed === origins.length && !settled) {
            settled = true
            // An origin that answered with another key is reported as such: the person's file and the node disagree.
            reject(new Error(mismatched ? 'Relay identity rejected' : 'Relay unavailable'))
          }
        })
      if (index === 0) run()
      else {
        const timer = setTimeout(run, index * EDGE_ORIGIN_STAGGER_MS)
        timer.unref()
        timers.push(timer)
      }
    })
  })
}
/**
 * The edge kind's first exchange on every role: a fresh client nonce out, the node's nonce and its relay-key signature
 * over both back. Nothing that depends on the relay (REGISTER, ATTACH, ADMIT) is sent before the signature verifies.
 */
export async function edgeHandshake(
  peer: RelaySocket,
  options: Pick<RelayEndpoint, 'relayId' | 'edge'>,
  role: EdgeRole,
): Promise<{ nonce: Uint8Array; timeMs: number; requiresToken: boolean }> {
  const clientNonce = nodeCrypto.random(32)
  await peer.send({ type: 'edge-hello', clientNonce })
  const response = await peer.receive(5000)
  if (
    response.type !== 'edge-challenge'
    || !options.edge
    || !equal(response.relayId, options.relayId)
    || Math.abs(response.timeMs - Date.now()) > EDGE_RELAY.clockSkewMs
    || (role !== 'host' && response.requiresToken)
    || !(await verifyEdgeChallenge(
      nodeCrypto,
      options.edge.relayKey,
      {
        relayId: options.relayId,
        role,
        clientNonce,
        relayNonce: response.nonce,
        timeMs: response.timeMs,
        requiresToken: response.requiresToken,
      },
      response.signature,
    ))
  )
    throw new Error('Relay identity rejected')
  return { nonce: response.nonce, timeMs: response.timeMs, requiresToken: response.requiresToken }
}
async function challenge(peer: RelaySocket, relayId: Uint8Array): Promise<Extract<RelayMessage, { type: 'challenge' }>> {
  await peer.send({ type: 'hello' })
  const response = await peer.receive(5000)
  if (response.type !== 'challenge' || !equal(response.relayId, relayId) || Math.abs(response.timeMs - Date.now()) > 86_400_000)
    throw new Error('Invalid relay challenge')
  return response
}
export async function connectRelayTunnel(
  options: RelayEndpoint & { pass: Uint8Array; holderKey: Uint8Array; signal?: AbortSignal },
): Promise<RelayTunnel> {
  const { peer, hello } = await openRelay(options, 'client', options.signal)
  const abort = () => peer.close()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  try {
    if (!hello) throw new Error('Relay challenge missing')
    await peer.send(
      options.edge
        ? { type: 'bound-admit', proof: await makeProof(nodeCrypto, options.holderKey, options.pass, hello.timeMs, hello.nonce) }
        : { type: 'admit', proof: await makeProof(nodeCrypto, options.holderKey, options.pass, hello.timeMs) },
    )
    if ((await peer.receive(5000)).type !== 'admitted' || (await peer.receive(10_000)).type !== 'spliced')
      throw new Error('Relay connection unavailable')
    return new RelayTunnel(peer)
  } catch (error) {
    peer.close()
    throw error
  } finally {
    options.signal?.removeEventListener('abort', abort)
  }
}
export async function registerRelay(
  options: RelayEndpoint & { routeKey: Uint8Array; day: number; registrationToken?: Uint8Array; previous?: Uint8Array; alternate: boolean },
): Promise<{
  token: Uint8Array
  routeId: Uint8Array
  status: number
  accept(): Promise<{ stream: RelayTunnel; passTag: Uint8Array }>
  close(): void
}> {
  const { peer, hello } = await openRelay(options, 'host')
  const abort = new AbortController()
  let work: Promise<Uint8Array> | undefined
  try {
    if (!hello) throw new Error('Relay challenge missing')
    const routePub = await nodeCrypto.publicKey(options.routeKey)
    if (hello.requiresToken && !options.registrationToken) throw new Error('Relay registration token required')
    const input = registrationInput(options.relayId, hello.nonce, options.day, routePub)
    const packet: Extract<RelayMessage, { type: 'register' }> = {
      type: 'register',
      day: options.day,
      routePub,
      previous: options.previous?.slice() ?? new Uint8Array(32),
      signature: await nodeCrypto.sign(options.routeKey, input),
      regMac: options.registrationToken ? await registrationMac(nodeCrypto, options.registrationToken, input) : new Uint8Array(16),
      alternate: options.alternate,
    }
    const encodedRegister = encodeMessage(packet)
    await peer.send(packet)
    const expected = await routeId(nodeCrypto, routePub)
    let response = await peer.receive(5000)
    if (response.type === 'registration-work') {
      if (!equal(response.routeId, expected)) throw new Error('Relay registration challenge mismatch')
      const nonce = response.nonce.slice()
      work = solveRegistrationWork({
        relayId: options.relayId,
        helloNonce: hello.nonce,
        workNonce: nonce,
        register: encodedRegister,
        bits: response.bits,
        signal: abort.signal,
      })
      let proofSending = false
      const reply = peer.receive(5000).then(message => {
        if (!proofSending) throw new Error('Unexpected relay registration response')
        return message
      })
      const solution = await Promise.race([
        work,
        reply.then(() => {
          throw new Error('Unexpected relay registration response')
        }),
      ])
      proofSending = true
      await peer.send({ type: 'registration-proof', routeId: expected, nonce, solution })
      response = await reply
    }
    if (response.type !== 'registered' || !equal(response.routeId, expected)) throw new Error('Relay registration rejected')
    return {
      token: response.token,
      routeId: response.routeId,
      status: response.status,
      close: () => peer.close(),
      async accept() {
        const request = await peer.receive(0)
        if (request.type !== 'open' || !equal(request.routeId, response.routeId)) throw new Error('Unexpected relay control message')
        const { peer: data } = await openRelay({ ...options, profile: request.profile }, 'data')
        try {
          const nonce = nodeCrypto.random(16)
          await data.send({
            type: 'attach',
            routeId: response.routeId,
            connection: request.connection,
            nonce,
            mac: await attachMac(nodeCrypto, response.token, response.routeId, request.connection, nonce),
          })
          const attached = await data.receive(5000),
            spliced = await data.receive(5000)
          if (attached.type !== 'attached' || spliced.type !== 'spliced' || !equal(spliced.connection, request.connection))
            throw new Error('Relay attach rejected')
          return { stream: new RelayTunnel(data), passTag: spliced.passTag }
        } catch (error) {
          data.close()
          throw error
        }
      },
    }
  } catch (error) {
    peer.close()
    throw error
  } finally {
    abort.abort()
    await work?.catch(() => {})
  }
}
