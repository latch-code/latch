import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { z } from 'zod'
import { nativeRevocationInput } from '@latch/link-wire'
import type { NativeHttpClient } from './http2.ts'

export interface NativeRevocation {
  hostId: string
  deviceId: string
  revokedAt: number
  signature: string
}
const schema = z.strictObject({
  hostId: z.string(),
  deviceId: z.string(),
  revokedAt: z.int().nonnegative(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u),
})
/** Only a fixed Root signature can authorize erasing credentials; a relay close code never can. */
export function verifyNativeRevocation(
  value: unknown,
  identity: { hostId: string; deviceId: string; rootSpki: Uint8Array },
): NativeRevocation {
  try {
    const item = schema.parse(value),
      input = nativeRevocationInput(item.hostId, item.deviceId, item.revokedAt),
      signature = Buffer.from(item.signature, 'base64url')
    if (
      item.hostId !== identity.hostId
      || item.deviceId !== identity.deviceId
      || signature.toString('base64url') !== item.signature
      || !verify(
        'sha256',
        input,
        { key: createPublicKey({ key: Buffer.from(identity.rootSpki), format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363' },
        signature,
      )
    )
      throw new Error('Invalid revocation')
    return item
  } catch {
    throw new Error('Native revocation verification failed')
  }
}
export async function acknowledgeNativeRevocation(client: NativeHttpClient, item: NativeRevocation): Promise<void> {
  const input = nativeRevocationInput(item.hostId, item.deviceId, item.revokedAt),
    response = await client.request('POST', '/link/api/native/revocation/ack', {
      requestId: randomUUID(),
      tombstoneHash: createHash('sha256').update(input).digest('hex'),
    })
  if (response.status !== 200 || !z.strictObject({ acknowledged: z.literal(true) }).safeParse(response.body).success)
    throw new Error('Native revocation acknowledgement result unknown')
}
