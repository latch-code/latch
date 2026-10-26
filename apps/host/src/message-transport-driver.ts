import type { TransportDescriptor, TransportDriver, TransportListener } from '@latch/sdk'
import { checkedTransportDescriptor, encodeTransportDescriptor, messageByteTransport, type MessageCarrier } from '@latch/link-client'

interface RoutedMessageConnection {
  carrier: MessageCarrier
  /** A new public, collision-resistant connection ID shared by the two carrier ends; never a credential. */
  connectionId: Uint8Array
}
export function createMessageTransportDriver(options: {
  descriptor: TransportDescriptor
  open(signal: AbortSignal): Promise<RoutedMessageConnection>
  listen?(signal: AbortSignal, onConnection: (connection: RoutedMessageConnection) => Promise<void>): Promise<TransportListener>
}): TransportDriver {
  const descriptor = checkedTransportDescriptor(options.descriptor),
    encoded = Buffer.from(encodeTransportDescriptor(descriptor))
  const check = (value: TransportDescriptor): void => {
    if (!Buffer.from(encodeTransportDescriptor(value)).equals(encoded)) throw new Error('Unknown message channel')
  }
  const wrap = async (opened: RoutedMessageConnection, signal: AbortSignal) => {
    try {
      return messageByteTransport(opened.carrier, opened.connectionId, signal)
    } catch {
      await opened.carrier.close()
      throw new Error('Message carrier unavailable')
    }
  }
  return {
    id: descriptor.driverId,
    profile: 'native-stream-v1',
    descriptors: options.listen ? [descriptor] : [],
    async open(input) {
      check(input.descriptor)
      input.signal.throwIfAborted()
      const opened = await options.open(input.signal)
      const transport = await wrap(opened, input.signal)
      if (input.signal.aborted) {
        await transport.close()
        throw new Error('Message setup cancelled')
      }
      return transport
    },
    ...(options.listen
      ? {
          async listen(input) {
            check(input.descriptor)
            input.signal.throwIfAborted()
            return options.listen!(input.signal, async opened => {
              const transport = await wrap(opened, input.signal)
              if (input.signal.aborted) {
                await transport.close()
                return
              }
              try {
                await input.onConnection(transport)
              } catch {
                await transport.close()
                throw new Error('Message connection failed')
              }
            })
          },
        }
      : {}),
  }
}
