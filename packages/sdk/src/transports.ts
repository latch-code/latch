/** Public routing data only. Credentials belong to the locally trusted driver, never this descriptor. */
export interface TransportDescriptor {
  version: 1
  driverId: string
  channelId: string
  endpoint: string
}

/** The close promise settles only after the underlying carrier has actually stopped. */
export interface TransportConnection {
  incoming: AsyncIterable<Uint8Array>
  write(bytes: Uint8Array, signal: AbortSignal): Promise<void>
  closed: Promise<void>
  close(): Promise<void>
}
export interface TransportListener {
  closed: Promise<void>
  close(): Promise<void>
}
export interface TransportDriver {
  id: string
  /** Custom carriers do not inherit the official relay's admission or traffic-padding claims. */
  profile: 'native-stream-v1' | 'latch-relay-v1' | 'latch-relay-v2'
  /** Host listeners are explicitly configured public channels; an empty list provides outbound connections only. */
  descriptors?: ReadonlyArray<TransportDescriptor>
  open(input: { descriptor: Readonly<TransportDescriptor>; signal: AbortSignal }): Promise<TransportConnection>
  listen?(input: {
    descriptor: Readonly<TransportDescriptor>
    signal: AbortSignal
    onConnection(connection: TransportConnection): Promise<void>
  }): Promise<TransportListener>
}
export interface TransportLease {
  driver: TransportDriver
  isCurrent(): boolean
  invalidated: Promise<void>
  release(): void
}
export interface TransportRegistry {
  acquireTransport(id: string): TransportLease
}
