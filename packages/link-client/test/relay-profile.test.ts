import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { ascii, bindingBytes, hex, knock, routeId, serverBinding, unhex, verifyKnock } from '@latch/link-wire'
import { nodeCrypto } from '../src/crypto.ts'

it('authenticates the exact outer-padding profile with the shared Node/Swift vector', async () => {
  const vector = JSON.parse(await readFile(new URL('../../testkit/vectors/link-v1.json', import.meta.url), 'utf8')) as {
    relayId: string
    routePub: string
    knockKey: string
    nonce: string
    timeMs: number
    certificate: string
    outerRelayV2: { binding: string; knock: string; serverBinding: string }
  }
  const binding = {
    path: 'relay' as const,
    profile: 'outer-pad-v2' as const,
    relayId: unhex(vector.relayId),
    routeId: await routeId(nodeCrypto, unhex(vector.routePub)),
  }
  expect(hex(bindingBytes(binding))).toBe(vector.outerRelayV2.binding)
  expect(hex(await knock(nodeCrypto, unhex(vector.knockKey), binding, vector.timeMs, unhex(vector.nonce)))).toBe(vector.outerRelayV2.knock)
  expect(hex(await serverBinding(nodeCrypto, unhex(vector.knockKey), binding, unhex(vector.nonce), ascii(vector.certificate)))).toBe(
    vector.outerRelayV2.serverBinding,
  )
  expect(
    await verifyKnock(
      nodeCrypto,
      unhex(vector.knockKey),
      { ...binding, profile: undefined },
      vector.timeMs,
      unhex(vector.outerRelayV2.knock),
    ),
  ).toBe(false)
})
