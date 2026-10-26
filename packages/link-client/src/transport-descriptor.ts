import { createHash } from 'node:crypto'
import { z } from 'zod'

const schema = z.strictObject({
  version: z.literal(1),
  driverId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  channelId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
  endpoint: z.string().min(1).max(1024),
})
export type PublicTransportDescriptor = z.infer<typeof schema>

/** Endpoints are origins, never webhook paths, credential-bearing URLs or arbitrary plugin configuration. */
export function checkedTransportDescriptor(input: unknown): Readonly<PublicTransportDescriptor> {
  const result = schema.safeParse(input)
  if (!result.success) throw new Error('Invalid public transport descriptor')
  const value = result.data
  try {
    const endpoint = new URL(value.endpoint)
    if (
      !/^[a-z][a-z0-9+.-]*:$/u.test(endpoint.protocol)
      || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s]+\/?$/u.test(value.endpoint)
      || ['file:', 'data:', 'javascript:', 'blob:'].includes(endpoint.protocol)
      || !endpoint.hostname
      || endpoint.username
      || endpoint.password
      || (endpoint.pathname !== '/' && endpoint.pathname !== '')
      || endpoint.search
      || endpoint.hash
      || /[\\?#\s\p{Cc}\p{Cf}]/u.test(value.endpoint)
    )
      throw new Error('Invalid endpoint')
    value.endpoint = endpoint.origin === 'null' ? `${endpoint.protocol}//${endpoint.host}/` : endpoint.origin + '/'
  } catch {
    throw new Error('Invalid public transport descriptor')
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 2048) throw new Error('Public transport descriptor too large')
  return Object.freeze(value)
}
export function encodeTransportDescriptor(input: unknown): Uint8Array {
  const value = checkedTransportDescriptor(input)
  return Buffer.from(JSON.stringify({ version: 1, driverId: value.driverId, channelId: value.channelId, endpoint: value.endpoint }))
}
export function decodeTransportDescriptor(input: Uint8Array): Readonly<PublicTransportDescriptor> {
  if (!(input instanceof Uint8Array) || input.byteLength > 2048) throw new Error('Invalid public transport descriptor')
  try {
    return checkedTransportDescriptor(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)))
  } catch {
    throw new Error('Invalid public transport descriptor')
  }
}
export function transportDescriptorHash(input: unknown): Uint8Array {
  return createHash('sha256').update('latch-transport-descriptor-v1\0').update(encodeTransportDescriptor(input)).digest()
}
