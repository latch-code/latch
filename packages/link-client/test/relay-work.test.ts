import { scryptSync } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { encodeMessage, registrationWorkInput, routeId, workDigestMeetsBits, type RelayMessage } from '@latch/link-wire'
import { RelayControl } from '../src/relay-control.ts'
import { nodeCrypto } from '../src/crypto.ts'
import * as registrationWork from '../src/registration-work.ts'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
const mocked = vi.hoisted(() => ({ peer: undefined as unknown }))
vi.mock('../src/websocket.ts', async original => ({ ...(await original<object>()), connectRelay: async () => mocked.peer }))
let control: RelayControl | undefined
afterEach(async () => {
  control?.close()
  await control?.closed
  control = undefined
  vi.restoreAllMocks()
})
async function fixture(
  mode: 'valid' | 'repeat' | 'wrong-route' | 'premature' | 'cancel' | 'over-budget' | 'stalled-write' | 'failed-write',
  guardWrites?: () => boolean,
) {
  const relayId = new Uint8Array(16).fill(1),
    key = new Uint8Array(32).fill(2),
    helloNonce = new Uint8Array(32).fill(3),
    workNonce = new Uint8Array(32).fill(4),
    id = await routeId(nodeCrypto, await nodeCrypto.publicKey(key))
  const queue: RelayMessage[] = [],
    sent: RelayMessage[] = []
  let waiter: { resolve(value: RelayMessage): void; reject(error: Error): void } | undefined, original: Uint8Array | undefined
  let releaseWrite: (() => void) | undefined, rejectWrite: ((error: Error) => void) | undefined
  let permitted = () => true
  const push = (value: RelayMessage) => {
    if (waiter) {
      const pending = waiter
      waiter = undefined
      pending.resolve(value)
    } else queue.push(value)
  }
  mocked.peer = {
    async send(message: RelayMessage) {
      if (!permitted()) throw new Error('Write authority expired')
      sent.push(message)
      if (message.type === 'hello') push({ type: 'challenge', relayId, nonce: helloNonce, timeMs: Date.now(), requiresToken: false })
      if (message.type === 'register') {
        original = encodeMessage(message)
        const challenge: RelayMessage = {
          type: 'registration-work',
          routeId: mode === 'wrong-route' ? new Uint8Array(16) : id,
          nonce: workNonce,
          bits: mode === 'over-budget' ? 23 : mode === 'cancel' || mode === 'premature' ? 22 : 0,
        }
        push(challenge)
        if (mode === 'repeat') push(challenge)
        if (mode === 'premature') push({ type: 'registered', token: new Uint8Array(32), routeId: id, status: 0 })
      }
      if (message.type === 'registration-proof') {
        expect(message.routeId).toEqual(id)
        expect(message.nonce).toEqual(workNonce)
        const digest = scryptSync(registrationWorkInput(relayId, helloNonce, workNonce, original!, message.solution), workNonce, 32, {
          N: 16384,
          r: 8,
          p: 1,
          maxmem: 33554432,
        })
        expect(workDigestMeetsBits(digest, 0)).toBe(true)
        push({ type: 'registered', token: new Uint8Array(32), routeId: id, status: 0 })
        if (mode === 'stalled-write' || mode === 'failed-write')
          await new Promise<void>((resolve, reject) => {
            releaseWrite = resolve
            rejectWrite = reject
          })
      }
    },
    guardWrites(next: () => boolean) {
      permitted = next
    },
    receive() {
      const value = queue.shift()
      return value
        ? Promise.resolve(value)
        : new Promise<RelayMessage>((resolve, reject) => {
            waiter = { resolve, reject }
          })
    },
    close() {
      waiter?.reject(new Error('closed'))
      waiter = undefined
    },
  }
  control = await RelayControl.connect({ relayId, url: new URL('https://relay.invalid/'), spki: new Uint8Array(32), guardWrites })
  return {
    control,
    key,
    id,
    sent,
    push,
    releaseWrite: () => releaseWrite?.(),
    rejectWrite: () => rejectWrite?.(new Error('fixture write failed')),
  }
}
it('closes without sending REGISTER if authority expires while signing', async () => {
  let permitted = true
  const f = await fixture('valid', () => permitted)
  const { promise: signing, resolve: started } = deferred()
  const { promise: blocked, resolve: release } = deferred()
  const sign = nodeCrypto.sign
  vi.spyOn(nodeCrypto, 'sign').mockImplementationOnce(async (...args) => {
    started()
    await blocked
    return sign(...args)
  })
  const rejected = expect(f.control.register({ routeKey: f.key, day: 20000, alternate: false })).rejects.toThrow()
  await signing
  permitted = false
  release()
  await rejected
  expect(f.sent.map(message => message.type)).toEqual(['hello'])
  expect(f.control.isClosed()).toBe(true)
})
it('closes without sending the challenge proof if authority expires during work', async () => {
  let permitted = true
  const f = await fixture('valid', () => permitted)
  const { promise: solving, resolve: started } = deferred()
  const { promise: blocked, resolve: release } = deferred()
  vi.spyOn(registrationWork, 'solveRegistrationWork').mockImplementationOnce(async () => {
    started()
    await blocked
    return new Uint8Array(8)
  })
  const rejected = expect(f.control.register({ routeKey: f.key, day: 20000, alternate: false })).rejects.toThrow()
  await solving
  permitted = false
  release()
  await rejected
  expect(f.sent.map(message => message.type)).toEqual(['hello', 'register'])
  expect(f.control.isClosed()).toBe(true)
})
it('solves one bound challenge asynchronously and continues the existing registration', async () => {
  const f = await fixture('valid'),
    result = await f.control.register({ routeKey: f.key, day: 20000, alternate: false })
  expect(result.routeId).toEqual(f.id)
  expect(f.sent.map(message => message.type)).toEqual(['hello', 'register', 'registration-proof'])
  expect(f.control.isClosed()).toBe(false)
})
it.each(['repeat', 'wrong-route', 'premature', 'over-budget'] as const)('closes a %s challenge without installing a route', async mode => {
  const f = await fixture(mode)
  await expect(f.control.register({ routeKey: f.key, day: 20000, alternate: false })).rejects.toThrow()
  expect(f.control.isClosed()).toBe(true)
  expect(f.sent.some(message => message.type === 'registration-proof')).toBe(false)
})
it('cancels a pending worker before registration settles and cannot resurrect a closed control with a late reply', async () => {
  const f = await fixture('cancel'),
    pending = f.control.register({ routeKey: f.key, day: 20000, alternate: false })
  const rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(f.sent.some(message => message.type === 'register')).toBe(true))
  f.control.close()
  await rejected
  await f.control.closed
  f.push({ type: 'registered', token: new Uint8Array(32), routeId: f.id, status: 0 })
  await expect(f.control.register({ routeKey: f.key, day: 20000, alternate: false })).rejects.toThrow()
  expect(f.sent.some(message => message.type === 'registration-proof')).toBe(false)
})

it('does not install or settle an early matching response until the proof write actually succeeds', async () => {
  const f = await fixture('stalled-write')
  let settled = false
  const result = f.control.register({ routeKey: f.key, day: 20000, alternate: false }).then(value => {
    settled = true
    return value
  })
  await vi.waitFor(() => expect(f.sent.some(message => message.type === 'registration-proof')).toBe(true))
  expect(settled).toBe(false)
  await expect(f.control.deny(f.id, [new Uint8Array(16)])).rejects.toThrow('not registered')
  f.releaseWrite()
  expect((await result).routeId).toEqual(f.id)
})
it('never installs an early response when the proof write subsequently fails', async () => {
  const f = await fixture('failed-write'),
    result = f.control.register({ routeKey: f.key, day: 20000, alternate: false })
  const rejected = expect(result).rejects.toThrow()
  await vi.waitFor(() => expect(f.sent.some(message => message.type === 'registration-proof')).toBe(true))
  f.rejectWrite()
  await rejected
  expect(f.control.isClosed()).toBe(true)
})
