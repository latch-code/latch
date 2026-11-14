import { randomBytes } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { hex, routeId, routeKey, UTC_DAY } from '@latch/link-wire'
import { nodeCrypto, RelayControl } from '@latch/link-client'
import { HostRelayController, type RelayControllerOptions } from '../src/relay/controller.ts'
import type { RelayProfile } from '../src/relay/profiles.ts'

const DAY = 20_800
let controller: HostRelayController | undefined
afterEach(async () => {
  await controller?.close()
  controller = undefined
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** The controller against a node that records what it is sent, with one phone whose removal the phone acknowledged. */
async function denialsAt(seconds: number) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(seconds * 1000)
  const seed = randomBytes(32),
    relayId = randomBytes(16)
  const profile: RelayProfile = {
    relayId: relayId.toString('hex'),
    url: 'https://relay.example/',
    spkiHash: randomBytes(32).toString('hex'),
    seeds: [`lrs1.${seed.toString('base64url')}`, `lrs1.${randomBytes(32).toString('base64url')}`],
    activeSlot: 0,
    rotationDay: 0,
    rotations: 0,
  }
  const denied: string[] = []
  let closed = false,
    stop!: (error: Error) => void
  const ended = new Promise<Error>(resolve => {
    stop = resolve
  })
  const control = {
    closed: ended,
    isClosed: () => closed,
    close() {
      closed = true
      stop(new Error('closed'))
    },
    register: async () => ({ token: randomBytes(32) }),
    deny: async (id: Uint8Array, tags: Uint8Array[]) => {
      denied.push(hex(id))
      return { count: tags.length }
    },
    accept: () => ended.then(error => Promise.reject(error)),
  }
  vi.spyOn(RelayControl, 'connect').mockResolvedValue(control as unknown as RelayControl)
  controller = new HostRelayController({
    profiles: { snapshot: () => ({ profiles: [profile] }), rotate: async () => {} },
    devices: {
      nativeReachable: () => true,
      nativeRevocations: () => [{ id: 'dev_removed', revokedAt: seconds * 1000, acknowledged: true }],
      nativeTransportCandidates: () => [],
    },
    audit: { append: async () => {} },
    resolve: async () => ({ address: '127.0.0.1', permitted: () => true }),
    accept: async () => {},
    closePaths() {},
  } as unknown as RelayControllerOptions)
  const route = async (day: number) =>
    hex(await routeId(nodeCrypto, await nodeCrypto.publicKey(await routeKey(nodeCrypto, seed, relayId, day))))
  return { denied, route, status: () => controller!.status()[0]?.status, closed: () => closed }
}

it('sends a removed phone to the routes whose passes are still good, and stays connected', async () => {
  // Midday: yesterday's passes ended at 00:15, so the node would refuse a denial for that route and close the connection.
  const node = await denialsAt(DAY * UTC_DAY + UTC_DAY / 2)
  await vi.waitFor(() => expect(node.status()).toBe('connected'))
  expect(new Set(node.denied)).toEqual(new Set([await node.route(DAY), await node.route(DAY + 1)]))
  expect(node.denied).not.toContain(await node.route(DAY - 1))
  expect(node.closed()).toBe(false)
})

it("still sends it to yesterday's route during the fifteen minutes its passes outlive the day", async () => {
  const node = await denialsAt(DAY * UTC_DAY + 600)
  await vi.waitFor(() => expect(node.status()).toBe('connected'))
  expect(new Set(node.denied)).toEqual(new Set([await node.route(DAY), await node.route(DAY + 1), await node.route(DAY - 1)]))
})
