import type { TransportDescriptor, TransportDriver } from '@latch/sdk'
import {
  connectRelayTunnel,
  checkedTransportDescriptor,
  encodeTransportDescriptor,
  streamByteTransport,
  type RelayEndpoint,
} from '@latch/link-client'

/** Adapt the existing authenticated official relay implementation; credentials remain a private local callback. */
export function createRelayTransportDriver(options: {
  descriptor: TransportDescriptor
  endpoint: RelayEndpoint
  credentials(): Promise<{ pass: Uint8Array; holderKey: Uint8Array }>
}): TransportDriver {
  const descriptor = checkedTransportDescriptor(options.descriptor),
    encoded = Buffer.from(encodeTransportDescriptor(descriptor))
  if (new URL(descriptor.endpoint).origin !== options.endpoint.url.origin) throw new Error('Relay descriptor origin mismatch')
  const endpoint = {
    ...options.endpoint,
    url: new URL(options.endpoint.url),
    relayId: options.endpoint.relayId.slice(),
    ...(options.endpoint.spki ? { spki: options.endpoint.spki.slice() } : {}),
    ...(options.endpoint.edge ? { edge: { relayKey: options.endpoint.edge.relayKey.slice(), shard: options.endpoint.edge.shard } } : {}),
  }
  return {
    id: descriptor.driverId,
    profile: endpoint.profile === 'outer-pad-v2' ? 'latch-relay-v2' : 'latch-relay-v1',
    async open(input) {
      if (!Buffer.from(encodeTransportDescriptor(input.descriptor)).equals(encoded)) throw new Error('Unknown relay channel')
      input.signal.throwIfAborted()
      const credentials = await options.credentials()
      input.signal.throwIfAborted()
      const stream = await connectRelayTunnel({ ...endpoint, ...credentials, signal: input.signal })
      if (input.signal.aborted) {
        stream.destroy()
        await streamByteTransport(stream).closed
        throw new Error('Relay setup cancelled')
      }
      const bridge = streamByteTransport(stream),
        closed = Promise.all([bridge.closed, stream.transportClosed]).then(() => {})
      return {
        ...bridge,
        closed,
        async close() {
          await bridge.close()
          await closed
        },
      }
    },
  }
}
