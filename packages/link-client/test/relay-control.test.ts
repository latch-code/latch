import { afterEach, expect, it, vi } from 'vitest'
import { denyBatchDigest, routeId, type RelayMessage } from '@latch/link-wire'
import { RelayControl } from '../src/relay-control.ts'
import { nodeCrypto } from '../src/crypto.ts'

const mocked = vi.hoisted(() => ({ peer: undefined as unknown }))
vi.mock('../src/websocket.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../src/websocket.ts')>()
  return { ...original, connectRelay: async () => mocked.peer }
})
let control: RelayControl | undefined
afterEach(() => {
  control?.close()
  control = undefined
  vi.useRealTimers()
})
async function fixture() {
  const relayId = new Uint8Array(16).fill(1),
    key = new Uint8Array(32).fill(2),
    id = await routeId(nodeCrypto, await nodeCrypto.publicKey(key)),
    sent: RelayMessage[] = [],
    queue: RelayMessage[] = []
  let waiter: { resolve(value: RelayMessage): void; reject(error: Error): void } | undefined
  const push = (message: RelayMessage) => {
    if (waiter) {
      const pending = waiter
      waiter = undefined
      pending.resolve(message)
    } else queue.push(message)
  }
  mocked.peer = {
    async send(message: RelayMessage) {
      sent.push(message)
      if (message.type === 'hello')
        push({ type: 'challenge', relayId, nonce: new Uint8Array(32), timeMs: Date.now(), requiresToken: false })
      if (message.type === 'register') push({ type: 'registered', token: new Uint8Array(32), routeId: id, status: 0 })
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
  control = await RelayControl.connect({ relayId, url: new URL('https://relay.invalid/'), spki: new Uint8Array(32) })
  await control.register({ routeKey: key, day: 20000, alternate: false })
  return { control, id, push, sent }
}
it('settles DENY only for a durable acknowledgement bound to the same route and normalized batch', async () => {
  const { control, id, push, sent } = await fixture(),
    tags = [new Uint8Array(16).fill(2), new Uint8Array(16).fill(1)]
  let settled = false
  const first = control.deny(id, tags).then(value => {
      settled = true
      return value
    }),
    second = control.deny(id, [...tags].reverse())
  await vi.waitFor(() => expect(sent.filter(message => message.type === 'deny')).toHaveLength(1))
  expect(settled).toBe(false)
  const digest = await denyBatchDigest(nodeCrypto, id, tags)
  push({ type: 'deny-ack', routeId: id, digest, count: 4 })
  expect((await first).count).toBe(4)
  expect(await second).toEqual(await first)
})
it('keeps lost or mismatched acknowledgements unknown and closes the control channel', async () => {
  const { control, id, push, sent } = await fixture(),
    pending = control.deny(id, [new Uint8Array(16)])
  const rejection = expect(pending).rejects.toThrow('unavailable')
  await vi.waitFor(() => expect(sent.some(message => message.type === 'deny')).toBe(true))
  push({ type: 'deny-ack', routeId: id, digest: new Uint8Array(32), count: 1 })
  await rejection
  expect(control.isClosed()).toBe(true)
})
it('times out an unacknowledged batch without marking delivery complete', async () => {
  const { control, id, sent } = await fixture()
  vi.useFakeTimers()
  const pending = control.deny(id, [new Uint8Array(16)]),
    rejection = expect(pending).rejects.toThrow('result unknown')
  await vi.waitFor(() => expect(sent.some(message => message.type === 'deny')).toBe(true))
  await vi.advanceTimersByTimeAsync(5000)
  await rejection
})
