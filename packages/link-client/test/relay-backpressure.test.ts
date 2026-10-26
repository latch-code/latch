import { Duplex } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { RelaySocket, RelayClosed } from '../src/websocket.ts'
import { RelayTunnel } from '../src/tunnel.ts'
const close: Array<() => void> = []
afterEach(() => {
  for (const cleanup of close.splice(0)) cleanup()
  vi.useRealTimers()
})
function fixture(limit = 16384) {
  const writes: Array<(error?: Error | null) => void> = []
  const stream = new Duplex({
    read() {},
    write(_bytes, _encoding, callback) {
      writes.push(callback)
    },
  })
  stream.on('error', () => {})
  const peer = new RelaySocket(stream, false, undefined, {
    sendHighWaterMark: () => limit,
    sendTimeoutMs: 100,
    pingIntervalMs: 25000,
    deadAfterMs: 75000,
  })
  close.push(() => {
    for (const cb of writes.splice(0)) cb()
    peer.close()
    stream.destroy()
  })
  return { peer, writes, stream }
}
it('keeps physical relay closure pending after protocol close until the underlying stream really exits', async () => {
  let release: (error?: Error | null) => void = () => {}
  const stream = new Duplex({
      read() {},
      write(_bytes, _encoding, callback) {
        callback()
      },
      destroy(_error, callback) {
        release = callback
      },
    }),
    peer = new RelaySocket(stream, false),
    settled = vi.fn()
  void peer.closed.then(settled)
  peer.close()
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  stream.destroy()
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  release()
  await peer.closed
  expect(settled).toHaveBeenCalledTimes(1)
})
it('bounds server queued frames at the adaptive limit and fails only that peer', async () => {
  const slow = fixture(),
    healthy = fixture(65536)
  const first = slow.peer.send({ type: 'data', data: new Uint8Array(16384) }).catch(error => error)
  await Promise.resolve()
  expect(slow.peer.metrics().pendingWriteBytes).toBeGreaterThan(16384)
  await expect(slow.peer.send({ type: 'data', data: new Uint8Array(16384) })).rejects.toThrow('send limit')
  expect(await slow.peer.receive().catch(error => error)).toBeInstanceOf(RelayClosed)
  slow.writes.shift()?.()
  await first
  const next = healthy.peer.send({ type: 'data', data: new Uint8Array([1]) })
  await Promise.resolve()
  healthy.writes.shift()?.()
  await next
  expect(healthy.peer.metrics()).toMatchObject({ pendingWriteBytes: 0, writtenBytes: 4 })
})
it('fails a blocked send by its deadline while retaining actual bytes until its entered callback settles', async () => {
  const f = fixture()
  await expect(f.peer.send({ type: 'data', data: new Uint8Array([1]) })).rejects.toThrow('stalled')
  expect(f.peer.metrics().pendingWriteBytes).toBe(4)
  f.writes.shift()?.()
  await Promise.resolve()
  expect(f.peer.metrics().pendingWriteBytes).toBe(0)
})
it('relinquishes relay heartbeats only when a verified splice becomes a tunnel, while control remains timed', async () => {
  vi.useFakeTimers()
  function ready() {
    const writes: Buffer[] = []
    const stream = new Duplex({
      read() {},
      write(bytes, _encoding, callback) {
        writes.push(Buffer.from(bytes))
        callback()
      },
    })
    const peer = new RelaySocket(stream, false, undefined, { pingIntervalMs: 25000, deadAfterMs: 75000 })
    close.push(() => {
      peer.close()
      stream.destroy()
    })
    return { stream, peer, writes }
  }
  const data = ready(),
    control = ready()
  await vi.advanceTimersByTimeAsync(50000)
  expect(data.writes).toHaveLength(2)
  const tunnel = new RelayTunnel(data.peer)
  data.writes.length = 0
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(data.writes).toHaveLength(0)
  expect(data.stream.destroyed).toBe(false)
  await expect(control.peer.receive()).rejects.toBeInstanceOf(RelayClosed)
  await new Promise<void>((resolve, reject) => tunnel.write(Buffer.from([1]), error => (error ? reject(error) : resolve())))
  expect(data.writes).toHaveLength(1)
  tunnel.destroy()
})
