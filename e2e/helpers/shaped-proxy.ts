import { createServer, type AddressInfo, Socket } from 'node:net'
import { once } from 'node:events'

export interface ShapedLink {
  /** Round trip added across the proxy: half on each direction. */
  rttMs: number
  /** Extra delay before opening the upstream socket, charged once per connection. */
  connectMs?: number
  /** Bottleneck rate of each direction. */
  mbps: number
}

const SLICE = 16_384,
  // The bottleneck buffer: beyond it the proxy stops reading, so TCP backpressure reaches the sender.
  BUFFER = 262_144

/** One direction: serialize at the link rate, deliver after the one-way delay, in order. */
class ShapedPipe {
  private free = 0
  private readonly line: Array<{ at: number; bytes: Buffer | undefined }> = []
  private timer: ReturnType<typeof setTimeout> | undefined
  bytes = 0
  constructor(
    private readonly from: Socket,
    private readonly to: Socket,
    private readonly link: ShapedLink,
  ) {
    from.on('data', (chunk: Buffer) => {
      for (let at = 0; at < chunk.length; at += SLICE) this.enqueue(chunk.subarray(at, at + SLICE))
      if (this.backlog() > BUFFER) from.pause()
    })
    from.once('end', () => this.enqueue(undefined))
  }
  private enqueue(bytes: Buffer | undefined): void {
    const now = performance.now(),
      serial = bytes ? (bytes.length * 8) / (this.link.mbps * 1000) : 0
    this.free = Math.max(now, this.free) + serial
    this.line.push({ at: this.free + this.link.rttMs / 2, bytes })
    this.pump()
  }
  private pump(): void {
    clearTimeout(this.timer)
    const now = performance.now()
    while (this.line.length && this.line[0]!.at <= now) {
      const item = this.line.shift()!
      if (!item.bytes) {
        this.to.end()
        continue
      }
      this.bytes += item.bytes.length
      if (!this.to.destroyed) this.to.write(item.bytes)
    }
    if (this.backlog() <= BUFFER / 2 && this.from.isPaused()) this.from.resume()
    if (this.line.length) this.timer = setTimeout(() => this.pump(), Math.max(0, this.line[0]!.at - now))
  }
  /** Bytes queued at the bottleneck, not yet serialized; bytes on the wire are the delay line's. */
  private backlog(): number {
    return (Math.max(0, this.free - performance.now()) * this.link.mbps * 1000) / 8
  }
  close(): void {
    clearTimeout(this.timer)
  }
}

/** A TCP proxy with an injected round trip and bandwidth, for the phone's leg to a local relay. */
export async function startShapedProxy(target: { host: string; port: number }, link: ShapedLink) {
  const pipes = new Set<{ up: ShapedPipe; down: ShapedPipe; sockets: Socket[] }>()
  let up = 0,
    down = 0
  const server = createServer(client => {
    const upstream = new Socket()
    client.pause()
    client.setNoDelay(true)
    upstream.setNoDelay(true)
    const entry = { up: new ShapedPipe(client, upstream, link), down: new ShapedPipe(upstream, client, link), sockets: [client, upstream] }
    pipes.add(entry)
    const open = () => {
      upstream.connect(target.port, target.host)
      client.resume()
    }
    const timer = link.connectMs ? setTimeout(open, link.connectMs) : undefined
    if (!timer) open()
    const close = () => {
      if (!pipes.delete(entry)) return
      clearTimeout(timer)
      up += entry.up.bytes
      down += entry.down.bytes
      entry.up.close()
      entry.down.close()
      client.destroy()
      upstream.destroy()
    }
    for (const socket of entry.sockets) {
      socket.on('error', close)
      socket.once('close', close)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: (server.address() as AddressInfo).port,
    /** Bytes delivered, phone to relay and relay to phone, over closed and open connections. */
    stats(): { up: number; down: number } {
      let liveUp = 0,
        liveDown = 0
      for (const entry of pipes) {
        liveUp += entry.up.bytes
        liveDown += entry.down.bytes
      }
      return { up: up + liveUp, down: down + liveDown }
    },
    async close(): Promise<void> {
      for (const entry of pipes) for (const socket of entry.sockets) socket.destroy()
      await new Promise<void>(done => server.close(() => done()))
    },
  }
}
