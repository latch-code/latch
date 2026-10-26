import { afterEach, expect, it, vi } from 'vitest'
import { nodeCrypto } from '@latch/link-client/crypto'
import { encodeMessage, equal, registrationInput, registrationWorkInput, UTC_DAY, type RelayMessage } from '@latch/link-wire'
import { RegistrationWorkPool, type RegistrationWorkInput, type RegistrationWorkPolicy } from '../src/registration-work.ts'
import { RelayCore, type RelayCoreOptions, type RelayPeer } from '../src/core.ts'

const policy: RegistrationWorkPolicy = { softRoutesPerPrefix: 8, minBits: 0, maxBits: 4, maxConcurrent: 1 }
afterEach(() => vi.useRealTimers())
it('performs a real memory-hard derivation and refuses malformed or unbounded verification requests', async () => {
  const pool = new RegistrationWorkPool(policy)
  const request = { input: new Uint8Array(263), salt: new Uint8Array(32), bits: 0 }
  expect(await pool.verify(request)).toBe(true)
  expect(await pool.verify({ ...request, bits: 23 })).toBe(false)
  expect(await pool.verify({ ...request, input: new Uint8Array(513) })).toBe(false)
  expect(await pool.verify({ ...request, salt: new Uint8Array(31) })).toBe(false)
  expect(pool.status()).toMatchObject({ active: 0, accepted: 1 })
  await pool.close()
  expect(await pool.verify(request)).toBe(false)
})
it('holds the bounded job slot until actual completion after timeout, with no waiting queue', async () => {
  vi.useFakeTimers()
  let complete!: (error: Error | null, digest?: Uint8Array) => void
  const compute = vi.fn((_input: Uint8Array, _salt: Uint8Array, callback: typeof complete) => {
    complete = callback
  })
  const pool = new RegistrationWorkPool(policy, compute),
    request = { input: new Uint8Array(263), salt: new Uint8Array(32), bits: 0 },
    first = pool.verify(request)
  expect(await pool.verify(request)).toBe('overloaded')
  expect(compute).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(2000)
  expect(await first).toBe('timeout')
  expect(pool.status()).toMatchObject({ active: 1, overloaded: 1, timedOut: 1 })
  expect(await pool.verify(request)).toBe('overloaded')
  expect(compute).toHaveBeenCalledTimes(1)
  let closed = false
  const closing = pool.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(closed).toBe(false)
  complete(null, new Uint8Array(32))
  await closing
  expect(pool.status()).toMatchObject({ active: 0, accepted: 0 })
  expect(await pool.verify(request)).toBe(false)
})
function peer(id: number, prefix = '192.0.2.0/24'): RelayPeer & { messages: RelayMessage[]; closed?: number } {
  return {
    id,
    prefix,
    messages: [],
    async send(message) {
      this.messages.push(message)
    },
    close(code) {
      this.closed = code
    },
  }
}
async function fixture(verify = vi.fn(async (_request: RegistrationWorkInput) => true), denials?: RelayCoreOptions['denials']) {
  const relayId = nodeCrypto.random(16)
  let now = Date.now()
  const day = Math.floor(now / 1000 / UTC_DAY)
  const core = new RelayCore({
    crypto: nodeCrypto,
    relayId,
    openRegistration: true,
    now: () => now,
    maxRoutes: 20,
    maxRoutesPerPrefix: 12,
    registrationWork: { ...policy, verify },
    denials,
  })
  const register = async (id: number, prefix?: string) => {
    const control = peer(id, prefix),
      key = nodeCrypto.random(32),
      routePub = await nodeCrypto.publicKey(key)
    core.connect(control, 'host')
    await core.receive(id, { type: 'hello' })
    const hello = control.messages[0]
    if (hello?.type !== 'challenge') throw new Error('No registration challenge')
    const register: Extract<RelayMessage, { type: 'register' }> = {
      type: 'register',
      previous: new Uint8Array(32),
      routePub,
      day,
      signature: await nodeCrypto.sign(key, registrationInput(relayId, hello.nonce, day, routePub)),
      regMac: new Uint8Array(16),
      alternate: false,
    }
    await core.receive(id, register)
    return { control, hello, register }
  }
  for (let id = 1; id <= 8; id++) expect((await register(id)).control.messages.at(-1)?.type).toBe('registered')
  return { core, register, verify, relayId, advance: (ms: number) => (now += ms) }
}
it('admits a ninth NAT Host through one bound challenge while retaining the prefix hard resource share', async () => {
  const { core, register, verify, relayId } = await fixture(),
    ninth = await register(9),
    work = ninth.control.messages.at(-1)
  if (work?.type !== 'registration-work') throw new Error('No work challenge')
  expect(work.bits).toBe(2)
  expect(core.status().routes).toBe(8)
  const solution = new Uint8Array(8)
  await core.receive(9, { type: 'registration-proof', routeId: work.routeId, nonce: work.nonce, solution })
  expect(verify).toHaveBeenCalledTimes(1)
  const request = verify.mock.calls[0]![0]
  expect(request.bits).toBe(2)
  expect(equal(request.input, registrationWorkInput(relayId, ninth.hello.nonce, work.nonce, encodeMessage(ninth.register), solution))).toBe(
    true,
  )
  expect(ninth.control.messages.at(-1)?.type).toBe('registered')
  for (let id = 10; id <= 12; id++) {
    const next = await register(id),
      challenge = next.control.messages.at(-1)
    if (challenge?.type !== 'registration-work') throw new Error('No work challenge')
    await core.receive(id, { type: 'registration-proof', routeId: challenge.routeId, nonce: challenge.nonce, solution })
  }
  expect((await register(13)).control.closed).toBe(4302)
  expect((await register(14, '198.51.100.0/24')).control.messages.at(-1)?.type).toBe('registered')
  expect(core.status().routes).toBe(13)
})
it('rejects replayed, expired and differently bound proofs without disturbing registered Hosts', async () => {
  const first = await fixture(),
    ninth = await first.register(9),
    work = ninth.control.messages.at(-1)
  if (work?.type !== 'registration-work') throw new Error('No work challenge')
  await first.core.receive(9, { type: 'registration-proof', routeId: work.routeId, nonce: new Uint8Array(32), solution: new Uint8Array(8) })
  expect(ninth.control.closed).toBe(4100)
  expect(first.verify).not.toHaveBeenCalled()
  const tenth = await first.register(10),
    timed = tenth.control.messages.at(-1)
  if (timed?.type !== 'registration-work') throw new Error('No work challenge')
  first.advance(3001)
  await first.core.receive(10, { type: 'registration-proof', routeId: timed.routeId, nonce: timed.nonce, solution: new Uint8Array(8) })
  expect(tenth.control.closed).toBe(4100)
  expect(first.verify).not.toHaveBeenCalled()
  expect(first.core.status().routes).toBe(8)
  const eleventh = await first.register(11),
    once = eleventh.control.messages.at(-1)
  if (once?.type !== 'registration-work') throw new Error('No work challenge')
  const proof: RelayMessage = { type: 'registration-proof', routeId: once.routeId, nonce: once.nonce, solution: new Uint8Array(8) }
  await first.core.receive(11, proof)
  expect(eleventh.control.messages.at(-1)?.type).toBe('registered')
  await first.core.receive(11, proof)
  expect(eleventh.control.closed).toBe(4100)
  expect(first.verify).toHaveBeenCalledTimes(1)
})
it('discards late verification after disconnect and rechecks capacity and drain before allocation', async () => {
  let finish!: (valid: boolean) => void
  const verify = vi.fn((_request: RegistrationWorkInput) => new Promise<boolean>(resolve => (finish = resolve))),
    f = await fixture(verify),
    ninth = await f.register(9),
    work = ninth.control.messages.at(-1)
  if (work?.type !== 'registration-work') throw new Error('No work challenge')
  const pending = f.core.receive(9, { type: 'registration-proof', routeId: work.routeId, nonce: work.nonce, solution: new Uint8Array(8) })
  f.core.disconnect(9)
  const replacement = peer(9)
  f.core.connect(replacement, 'host')
  finish(true)
  await pending
  expect(f.core.status().routes).toBe(8)
  expect(replacement.messages).toHaveLength(0)
  const tenth = await f.register(10),
    next = tenth.control.messages.at(-1)
  if (next?.type !== 'registration-work') throw new Error('No work challenge')
  const draining = f.core.receive(10, { type: 'registration-proof', routeId: next.routeId, nonce: next.nonce, solution: new Uint8Array(8) })
  f.core.drain()
  finish(true)
  await draining
  expect(f.core.status().routes).toBe(8)
  expect(tenth.control.closed).toBe(4302)
})
it('cannot exceed the hard prefix capacity while a previously issued challenge is being verified', async () => {
  let finish!: (valid: boolean) => void,
    first = true
  const verify = vi.fn(async (_request: RegistrationWorkInput) => {
    if (first) {
      first = false
      return await new Promise<boolean>(resolve => (finish = resolve))
    }
    return true
  })
  const f = await fixture(verify),
    ninth = await f.register(9),
    work = ninth.control.messages.at(-1)
  if (work?.type !== 'registration-work') throw new Error('No work challenge')
  const pending = f.core.receive(9, { type: 'registration-proof', routeId: work.routeId, nonce: work.nonce, solution: new Uint8Array(8) })
  for (let id = 10; id <= 13; id++) {
    const next = await f.register(id),
      challenge = next.control.messages.at(-1)
    if (challenge?.type !== 'registration-work') throw new Error('No work challenge')
    await f.core.receive(id, {
      type: 'registration-proof',
      routeId: challenge.routeId,
      nonce: challenge.nonce,
      solution: new Uint8Array(8),
    })
  }
  expect(f.core.status().routes).toBe(12)
  finish(true)
  await pending
  expect(ninth.control.closed).toBe(4302)
  expect(f.core.status().routes).toBe(12)
})
it('retains the challenge deadline through asynchronous denial restoration before allocating the route', async () => {
  let delay = false,
    finish!: (tags: Uint8Array[]) => void
  const get = vi.fn(async () => {
    if (delay) return await new Promise<Uint8Array[]>(resolve => (finish = resolve))
    return []
  })
  const f = await fixture(undefined, { get, add: async () => 0 }),
    ninth = await f.register(9),
    work = ninth.control.messages.at(-1)
  if (work?.type !== 'registration-work') throw new Error('No work challenge')
  delay = true
  const pending = f.core.receive(9, { type: 'registration-proof', routeId: work.routeId, nonce: work.nonce, solution: new Uint8Array(8) })
  await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(9))
  f.advance(3001)
  finish([])
  await pending
  expect(ninth.control.closed).toBe(4100)
  expect(f.core.status().routes).toBe(8)
})
