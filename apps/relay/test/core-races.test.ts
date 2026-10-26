import { expect, it } from 'vitest'
import { nodeCrypto } from '@latch/link-client/crypto'
import { issuePass, makeProof, registrationInput, UTC_DAY, type LinkCrypto, type RelayMessage } from '@latch/link-wire'
import { RelayCore, type RelayCoreOptions, type RelayPeer } from '../src/core.ts'
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
async function route(relayId: Uint8Array, day: number) {
  const key = nodeCrypto.random(32),
    publicKey = await nodeCrypto.publicKey(key)
  return { key, publicKey, day }
}
async function register(
  core: RelayCore,
  control: ReturnType<typeof peer>,
  data: Awaited<ReturnType<typeof route>>,
  relayId: Uint8Array,
  previous: Uint8Array = new Uint8Array(32),
) {
  if (!control.messages.length) {
    core.connect(control, 'host')
    await core.receive(control.id, { type: 'hello' })
  }
  const challenge = control.messages.find(message => message.type === 'challenge')
  if (challenge?.type !== 'challenge') throw new Error('No challenge')
  const input = registrationInput(relayId, challenge.nonce, data.day, data.publicKey)
  await core.receive(control.id, {
    type: 'register',
    day: data.day,
    routePub: data.publicKey,
    previous,
    signature: await nodeCrypto.sign(data.key, input),
    regMac: new Uint8Array(16),
    alternate: false,
  })
  return control.messages.findLast(message => message.type === 'registered')
}
async function pass(data: Awaited<ReturnType<typeof route>>, relayId: Uint8Array, holderKey: Uint8Array, day = data.day) {
  return issuePass(nodeCrypto, data.key, {
    pairing: false,
    relayId,
    day,
    notBefore: day * UTC_DAY,
    notAfter: (day + 1) * UTC_DAY,
    routePub: data.publicKey,
    holderPub: await nodeCrypto.publicKey(holderKey),
    tag: nodeCrypto.random(16),
  })
}
it('counts the current day even when the same route and holders cross the previous-day retention window', async () => {
  const day = Math.floor(Date.now() / 1000 / UTC_DAY),
    relayId = nodeCrypto.random(16),
    data = await route(relayId, day),
    control = peer(1)
  let now = ((day + 1) * UTC_DAY - 60) * 1000
  const core = new RelayCore({ crypto: nodeCrypto, relayId, openRegistration: true, now: () => now })
  const registered = await register(core, control, data, relayId)
  if (registered?.type !== 'registered') throw new Error('No registration')
  const holders = Array.from({ length: 32 }, () => nodeCrypto.random(32))
  const admit = async (id: number, key: Uint8Array, atDay: number) => {
    const client = peer(id)
    core.connect(client, 'client')
    await core.receive(id, { type: 'admit', proof: await makeProof(nodeCrypto, key, await pass(data, relayId, key, atDay), now) })
    return client
  }
  for (let i = 0; i < 32; i++) {
    expect((await admit(10 + i, holders[i]!, day)).messages[0]?.type).toBe('admitted')
    core.disconnect(10 + i)
  }
  now = ((day + 1) * UTC_DAY + 60) * 1000
  await register(core, control, { ...data, day: day + 1 }, relayId, registered.token)
  for (let i = 0; i < 32; i++) {
    expect((await admit(100 + i, holders[i]!, day + 1)).messages[0]?.type).toBe('admitted')
    core.disconnect(100 + i)
  }
  now = ((day + 1) * UTC_DAY + 901) * 1000
  core.sweep()
  expect((await admit(200, nodeCrypto.random(32), day + 1)).closed).toBe(4102)
  expect((await admit(201, holders[0]!, day + 1)).messages[0]?.type).toBe('admitted')
})
it('discards a completed route hash after disconnect instead of allocating ghost pending/holder activity', async () => {
  const now = Date.now(),
    day = Math.floor(now / 1000 / UTC_DAY),
    relayId = nodeCrypto.random(16),
    data = await route(relayId, day),
    control = peer(1),
    holderKey = nodeCrypto.random(32)
  let enabled = false,
    calls = 0,
    release!: () => void,
    entered!: () => void
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    blocked = new Promise<void>(resolve => {
      entered = resolve
    })
  const crypto: LinkCrypto = {
    ...nodeCrypto,
    async hash(input) {
      if (enabled && ++calls === 2) {
        entered()
        await gate
      }
      return nodeCrypto.hash(input)
    },
  }
  const core = new RelayCore({ crypto, relayId, openRegistration: true, now: () => now })
  await register(core, control, data, relayId)
  const original = peer(2)
  core.connect(original, 'client')
  const proof = await makeProof(nodeCrypto, holderKey, await pass(data, relayId, holderKey), now)
  enabled = true
  const receiving = core.receive(2, { type: 'admit', proof })
  await blocked
  core.disconnect(2)
  const replacement = peer(2)
  core.connect(replacement, 'client')
  enabled = false
  release()
  await receiving
  expect(original.messages).toEqual([])
  expect(replacement.closed).toBeUndefined()
  expect(core.status().pending).toBe(0)
  for (const client of [replacement, peer(3)]) {
    if (client.id !== 2) core.connect(client, 'client')
    await core.receive(client.id, {
      type: 'admit',
      proof: await makeProof(nodeCrypto, holderKey, await pass(data, relayId, holderKey), now),
    })
    expect(client.messages[0]?.type).toBe('admitted')
  }
})
it('rechecks global route capacity after asynchronous denial restoration completes', async () => {
  const now = Date.now(),
    day = Math.floor(now / 1000 / UTC_DAY),
    relayId = nodeCrypto.random(16)
  let release!: () => void,
    entered!: () => void,
    restorations = 0
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    both = new Promise<void>(resolve => {
      entered = resolve
    })
  const denials: NonNullable<RelayCoreOptions['denials']> = {
    async get() {
      if (++restorations === 2) entered()
      await gate
      return []
    },
    async add() {
      return 0
    },
  }
  const core = new RelayCore({ crypto: nodeCrypto, relayId, openRegistration: true, now: () => now, maxRoutes: 1, denials })
  const first = peer(1),
    second = peer(2, '198.51.100.0/24'),
    a = await route(relayId, day),
    b = await route(relayId, day)
  const pending = [register(core, first, a, relayId), register(core, second, b, relayId)]
  await both
  release()
  await Promise.all(pending)
  expect(core.status().routes).toBe(1)
  expect([first, second].filter(value => value.messages.some(message => message.type === 'registered'))).toHaveLength(1)
  expect([first, second].filter(value => value.closed === 4302)).toHaveLength(1)
})
