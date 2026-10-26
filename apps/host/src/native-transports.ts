import {
  connectNative,
  NativeHttpClient,
  ByteTransportStream,
  checkedTransportDescriptor,
  transportDescriptorHash,
} from '@latch/link-client'
import type { Duplex } from 'node:stream'
import type { KnockBinding } from '@latch/link-wire'
import type {
  TransportDescriptor,
  TransportLease,
  TransportRegistry,
  TransportDriver,
  TransportListener,
  TransportConnection,
} from '@latch/sdk'
import { AppError } from '@latch/sdk'

export function carrierBinding(descriptor: TransportDescriptor): KnockBinding {
  const checked = checkedTransportDescriptor(descriptor)
  return { path: 'carrier', driverId: checked.driverId, descriptorHash: transportDescriptorHash(checked) }
}

/** Driver code receives only public routing and cancellation. Identity is consumed by the shared native handshake. */
export async function connectPluginTransport(
  registry: TransportRegistry,
  descriptor: TransportDescriptor,
  identity: Parameters<typeof connectNative>[2],
  options: { signal?: AbortSignal; relayBinding?: KnockBinding } = {},
): Promise<{ client: NativeHttpClient; closed: Promise<void>; close(): Promise<void> }> {
  const checked = checkedTransportDescriptor(descriptor),
    lease = registry.acquireTransport(checked.driverId),
    stop = new AbortController(),
    signal = options.signal ? AbortSignal.any([stop.signal, options.signal]) : stop.signal,
    timer = setTimeout(() => stop.abort(), 3000)
  timer.unref()
  let raw: ByteTransportStream | undefined,
    secure: Awaited<ReturnType<typeof connectNative>> | undefined,
    secureClosed: Promise<void> | undefined
  const abort = () => {
    secure?.destroy()
    raw?.destroy()
  }
  signal.addEventListener('abort', abort, { once: true })
  void lease.invalidated.then(() => stop.abort())
  try {
    const original = options.relayBinding
    const binding =
      lease.driver.profile === 'native-stream-v1'
        ? carrierBinding(checked)
        : original
          ? { ...original, relayId: original.relayId?.slice(), routeId: original.routeId?.slice() }
          : undefined
    if (
      !binding
      || (lease.driver.profile !== 'native-stream-v1'
        && (binding.path !== 'relay' || (binding.profile === 'outer-pad-v2') !== (lease.driver.profile === 'latch-relay-v2')))
    )
      throw new Error('Missing official relay profile binding')
    const connection = await lease.driver.open({ descriptor: checked, signal })
    raw = new ByteTransportStream(connection)
    if (signal.aborted || !lease.isCurrent()) throw new AppError(409, 'transport-changed', '连接插件已改变，请重新连接。')
    secure = await connectNative(raw, binding, identity)
    const authenticated = secure
    secureClosed = new Promise<void>(resolve => {
      if (authenticated.closed) resolve()
      else authenticated.once('close', resolve)
    })
    secure.once('close', () => raw?.destroy())
    if (signal.aborted || !lease.isCurrent()) {
      secure.destroy()
      throw new Error('Transport changed')
    }
    clearTimeout(timer)
    const client = new NativeHttpClient(secure),
      stream = raw,
      httpClosed = new Promise<void>(resolve => {
        client.onClose(resolve)
      }),
      closed = Promise.all([stream.settled, secureClosed, httpClosed])
        .then(() => {})
        .finally(() => {
          signal.removeEventListener('abort', abort)
          lease.release()
        })
    return {
      client,
      closed,
      async close() {
        client.close()
        stream.destroy()
        await closed
      },
    }
  } catch {
    signal.removeEventListener('abort', abort)
    raw?.destroy()
    if (raw) await raw.settled
    secure?.destroy()
    await secureClosed
    lease.release()
    throw new AppError(503, 'transport-unavailable', '连接插件未能建立已验证的连接。')
  } finally {
    clearTimeout(timer)
  }
}

interface Listening {
  key: string
  lease: TransportLease
  stop: AbortController
  listener?: TransportListener
  connections: Set<ByteTransportStream>
  pending: Promise<void>
}
interface Registry extends TransportRegistry {
  transports(): Array<{ id: string; profile: TransportDriver['profile']; descriptors: ReadonlyArray<TransportDescriptor> }>
}

/** The native service remains the authorization and connection-budget owner. Plugin publication is never enrollment. */
export class NativePluginTransports {
  private readonly listening = new Map<string, Listening>()
  private readonly retry = new Map<string, number>()
  private tail: Promise<void> = Promise.resolve()
  private syncing?: Promise<void>
  private closed = false
  private readonly timer: ReturnType<typeof setInterval>
  constructor(
    private readonly options: {
      registry: Registry
      enabled(): boolean
      accept(stream: Duplex, binding: KnockBinding): Promise<void>
    },
  ) {
    this.timer = setInterval(() => void this.sync().catch(() => {}), 250)
    this.timer.unref()
  }
  sync(): Promise<void> {
    if (this.syncing) return this.syncing
    const task = this.tail.catch(() => {}).then(() => this.reconcile())
    this.tail = task.catch(() => {})
    this.syncing = task.finally(() => {
      this.syncing = undefined
    })
    return this.syncing
  }
  private async reconcile(): Promise<void> {
    const desired = new Map<string, TransportDescriptor>()
    if (!this.closed && this.options.enabled()) {
      for (const driver of this.options.registry.transports()) {
        if (driver.profile !== 'native-stream-v1') continue
        for (const input of driver.descriptors) {
          if (desired.size >= 8) break
          try {
            const descriptor = checkedTransportDescriptor(input),
              key = Buffer.from(transportDescriptorHash(descriptor)).toString('hex')
            desired.set(key, descriptor)
          } catch {
            /* Invalid public routes never become listening endpoints. */
          }
        }
      }
    }
    for (const [key, item] of this.listening) {
      if (desired.has(key) && item.lease.isCurrent() && !item.stop.signal.aborted) continue
      this.listening.delete(key)
      await this.stop(item)
    }
    for (const [key, descriptor] of desired) {
      if (this.closed || !this.options.enabled()) break
      if (this.listening.has(key) || (this.retry.get(key) ?? 0) > performance.now()) continue
      let lease: TransportLease
      try {
        lease = this.options.registry.acquireTransport(descriptor.driverId)
      } catch {
        continue
      }
      if (!lease.driver.listen) {
        lease.release()
        continue
      }
      const item: Listening = { key, lease, stop: new AbortController(), connections: new Set(), pending: Promise.resolve() }
      void lease.invalidated.then(() => {
        item.stop.abort()
        void this.sync().catch(() => {})
      })
      item.stop.signal.addEventListener(
        'abort',
        () => {
          for (const raw of item.connections) raw.destroy()
        },
        { once: true },
      )
      this.listening.set(key, item)
      item.pending = (async () => {
        try {
          item.listener = await lease.driver.listen!({
            descriptor,
            signal: item.stop.signal,
            onConnection: connection => this.accept(item, descriptor, connection),
          })
          void item.listener.closed.then(
            () => item.stop.abort(),
            () => item.stop.abort(),
          )
          if (item.stop.signal.aborted || !lease.isCurrent() || !this.options.enabled()) item.stop.abort()
        } catch {
          item.stop.abort()
          this.retry.set(key, performance.now() + 5000)
        }
      })()
    }
    for (const key of this.retry.keys()) if (!desired.has(key)) this.retry.delete(key)
  }
  private async accept(item: Listening, descriptor: TransportDescriptor, connection: TransportConnection): Promise<void> {
    const raw = new ByteTransportStream(connection)
    item.connections.add(raw)
    try {
      if (
        this.closed
        || item.stop.signal.aborted
        || !item.lease.isCurrent()
        || !this.options.enabled()
        || item.connections.size > 4
        || [...this.listening.values()].reduce((sum, entry) => sum + entry.connections.size, 0) > 32
      )
        throw new Error('Transport unavailable')
      await this.options.accept(raw, carrierBinding(descriptor))
      await raw.settled
    } catch {
      raw.destroy()
      await raw.settled
    } finally {
      item.connections.delete(raw)
    }
  }
  private async stop(item: Listening): Promise<void> {
    item.stop.abort()
    for (const raw of item.connections) raw.destroy()
    await item.pending
    await Promise.allSettled([item.listener?.close(), ...[...item.connections].map(raw => raw.settled)])
    await item.listener?.closed.catch(() => {})
    item.lease.release()
  }
  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    for (const item of this.listening.values()) item.stop.abort()
    await this.tail
    for (const item of this.listening.values()) {
      await item.pending
      await this.stop(item)
    }
    this.listening.clear()
  }
}
