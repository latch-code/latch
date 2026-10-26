import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { bindingBytes, hex, unhex, knock, serverBinding, verifyKnock } from '@latch/link-wire'
import { nodeCrypto } from '../src/crypto.ts'
import { encodeTransportDescriptor, transportDescriptorHash } from '../src/transport-descriptor.ts'

it('binds custom carrier authentication to the driver and canonical public descriptor independently of direct and relay', async () => {
  const { carrier: vector } = JSON.parse(await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8')) as {
    carrier: {
      descriptor: unknown
      encoded: string
      descriptorHash: string
      driverId: string
      key: string
      nonce: string
      time: number
      binding: string
      knock: string
      certificate: string
      serverBinding: string
    }
  }
  const binding = { path: 'carrier' as const, driverId: vector.driverId, descriptorHash: unhex(vector.descriptorHash) }
  expect(hex(encodeTransportDescriptor(vector.descriptor))).toBe(vector.encoded)
  expect(hex(transportDescriptorHash(vector.descriptor))).toBe(vector.descriptorHash)
  expect(hex(bindingBytes(binding))).toBe(vector.binding)
  expect(hex(await knock(nodeCrypto, unhex(vector.key), binding, vector.time, unhex(vector.nonce)))).toBe(vector.knock)
  expect(hex(await serverBinding(nodeCrypto, unhex(vector.key), binding, unhex(vector.nonce), unhex(vector.certificate)))).toBe(
    vector.serverBinding,
  )
  for (const other of [
    { path: 'direct' as const },
    { path: 'relay' as const, relayId: new Uint8Array(16), routeId: new Uint8Array(16) },
    { ...binding, driverId: 'another' },
    { ...binding, descriptorHash: new Uint8Array(32) },
  ])
    expect(await verifyKnock(nodeCrypto, unhex(vector.key), other, vector.time, unhex(vector.knock))).toBe(false)
})
