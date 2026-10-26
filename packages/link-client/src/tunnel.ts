import { Duplex } from 'node:stream'
import {
  attachMac,
  encodeMessage,
  equal,
  makeProof,
  registrationInput,
  registrationMac,
  routeId,
  type RelayMessage,
} from '@latch/link-wire'
import { nodeCrypto } from './crypto.ts'
import { connectRelay, type RelaySocket } from './websocket.ts'
import { solveRegistrationWork } from './registration-work.ts'

export class RelayTunnel extends Duplex {
  private readonly peer: RelaySocket
  private reading = false
  constructor(peer: RelaySocket) {
    super({ highWaterMark: 16_384 })
    this.peer = peer
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
    callback(error)
  }
}
export interface RelayEndpoint {
  url: URL
  relayId: Uint8Array
  spki: Uint8Array
  ca?: string | Buffer
  resolveAddress?(): Promise<string>
}
async function endpoint(options: RelayEndpoint, path: string): Promise<Parameters<typeof connectRelay>[0]> {
  const url = new URL(options.url)
  url.pathname = path
  return { url, spki: options.spki, ca: options.ca, ...(options.resolveAddress ? { address: await options.resolveAddress() } : {}) }
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
  const peer = await connectRelay({ ...(await endpoint(options, '/v1/c')), signal: options.signal })
  const abort = () => peer.close()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  try {
    const hello = await challenge(peer, options.relayId)
    await peer.send({ type: 'admit', proof: await makeProof(nodeCrypto, options.holderKey, options.pass, hello.timeMs) })
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
  const peer = await connectRelay(await endpoint(options, '/v1/h'))
  const abort = new AbortController()
  let work: Promise<Uint8Array> | undefined
  try {
    const hello = await challenge(peer, options.relayId),
      routePub = await nodeCrypto.publicKey(options.routeKey)
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
        const data = await connectRelay(await endpoint(options, '/v1/d'))
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
