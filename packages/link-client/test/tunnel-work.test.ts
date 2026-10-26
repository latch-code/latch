import { expect, it, vi } from 'vitest'
import { encodeMessage, type RelayMessage, routeId } from '@latch/link-wire'
import { nodeCrypto } from '../src/crypto.ts'
import { registerRelay } from '../src/tunnel.ts'
const mock = vi.hoisted(() => ({ peer: undefined as unknown, packet: undefined as Uint8Array | undefined }))
vi.mock('../src/websocket.ts', async original => ({
  ...(await original<typeof import('../src/websocket.ts')>()),
  connectRelay: async () => mock.peer,
}))
vi.mock('../src/registration-work.ts', async original => {
  const implementation = await original<typeof import('../src/registration-work.ts')>()
  return {
    ...implementation,
    solveRegistrationWork: async (input: Parameters<typeof implementation.solveRegistrationWork>[0]) => {
      mock.packet = input.register.slice()
      return implementation.solveRegistrationWork(input)
    },
  }
})
async function fixture(mode: 'normal' | 'early' | 'stalled' | 'failed' | 'mismatched' | 'mutated') {
  mock.packet = undefined
  const relayId = nodeCrypto.random(16),
    key = nodeCrypto.random(32),
    route = await routeId(nodeCrypto, await nodeCrypto.publicKey(key)),
    nonce = nodeCrypto.random(32),
    previous = new Uint8Array(32).fill(1),
    queue: RelayMessage[] = [],
    sent: RelayMessage[] = []
  let waiter: { resolve(message: RelayMessage): void; reject(error: Error): void } | undefined,
    complete: (() => void) | undefined,
    closed = false,
    serialized: Uint8Array | undefined
  const push = (message: RelayMessage) => {
    if (waiter) {
      const current = waiter
      waiter = undefined
      current.resolve(message)
    } else queue.push(message)
  }
  const registered: RelayMessage = { type: 'registered', routeId: route, token: new Uint8Array(32), status: 0 }
  mock.peer = {
    async send(message: RelayMessage) {
      sent.push(message)
      if (message.type === 'hello')
        push({ type: 'challenge', relayId, nonce: new Uint8Array(32), timeMs: Date.now(), requiresToken: false })
      if (message.type === 'register') {
        serialized = encodeMessage(message)
        if (mode === 'mutated') previous.fill(9)
        push({ type: 'registration-work', routeId: mode === 'mismatched' ? new Uint8Array(16) : route, nonce, bits: 0 })
        if (mode === 'early') push(registered)
      }
      if (message.type === 'registration-proof') {
        push(registered)
        if (mode === 'stalled' || mode === 'failed')
          await new Promise<void>((resolve, reject) => {
            complete = mode === 'failed' ? () => reject(new Error('Fixture write failed')) : resolve
          })
      }
    },
    receive() {
      const next = queue.shift()
      return next
        ? Promise.resolve(next)
        : new Promise<RelayMessage>((resolve, reject) => {
            waiter = { resolve, reject }
          })
    },
    close() {
      closed = true
      waiter?.reject(new Error('Fixture closed'))
      waiter = undefined
    },
  }
  return {
    start: () =>
      registerRelay({
        url: new URL('https://relay.invalid/'),
        relayId,
        spki: new Uint8Array(32),
        routeKey: key,
        previous,
        day: 20000,
        alternate: false,
      }),
    sent,
    closed: () => closed,
    complete: () => complete?.(),
    serialized: () => serialized,
  }
}
it('keeps the single-route compatibility API on the same memory-work protocol', async () => {
  const f = await fixture('normal'),
    registered = await f.start()
  expect(f.sent.map(message => message.type)).toEqual(['hello', 'register', 'registration-proof'])
  registered.close()
  expect(f.closed()).toBe(true)
})
it('binds work to the original serialized REGISTER when the caller changes its previous-token buffer during the write', async () => {
  const f = await fixture('mutated'),
    registered = await f.start()
  expect(mock.packet).toEqual(f.serialized())
  registered.close()
})
it.each(['early', 'mismatched'] as const)('refuses %s registration replies before sending a bound proof', async mode => {
  const f = await fixture(mode)
  await expect(f.start()).rejects.toThrow()
  expect(f.closed()).toBe(true)
  expect(f.sent.some(message => message.type === 'registration-proof')).toBe(false)
})
it.each(['stalled', 'failed'] as const)('does not install an early server acknowledgement while the proof write is %s', async mode => {
  const f = await fixture(mode)
  let settled = false
  const result = f.start().then(
    value => {
      settled = true
      return value
    },
    error => {
      settled = true
      throw error
    },
  )
  await vi.waitFor(() => expect(f.sent.some(message => message.type === 'registration-proof')).toBe(true))
  expect(settled).toBe(false)
  f.complete()
  if (mode === 'failed') await expect(result).rejects.toThrow('Fixture write failed')
  else (await result).close()
  expect(f.closed()).toBe(true)
})
