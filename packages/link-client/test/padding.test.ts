import { Duplex } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { PaddedStream } from '../src/padding.ts'
import { encodePaddingCell } from '@latch/link-wire'
afterEach(() => vi.useRealTimers())
it('holds a shallow write until its grid and real transport callback, and cancels its timer with the connection', async () => {
  vi.useFakeTimers()
  const cells: Buffer[] = [],
    callbacks: Array<(error?: Error | null) => void> = []
  const transport = new Duplex({
    read() {},
    write(bytes, _encoding, callback) {
      cells.push(Buffer.from(bytes))
      callbacks.push(callback)
    },
  })
  transport.on('error', () => {})
  const socket = new PaddedStream(transport, 'client'),
    done = vi.fn()
  socket.on('error', () => {})
  socket.write(Buffer.alloc(32768, 7), done)
  await vi.advanceTimersByTimeAsync(249)
  expect(cells).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(cells).toHaveLength(1)
  expect(done).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(500)
  expect(cells).toHaveLength(1)
  callbacks.shift()!()
  await vi.advanceTimersByTimeAsync(0)
  expect(done).toHaveBeenCalledOnce()
  socket.destroy()
  await vi.advanceTimersByTimeAsync(1000)
  expect(cells).toHaveLength(1)
  expect(transport.destroyed).toBe(true)
})
it('removes dummy cells and closes invalid cells without delivering application bytes', async () => {
  const transport = new Duplex({
      read() {},
      write(_bytes, _encoding, callback) {
        callback()
      },
    }),
    socket = new PaddedStream(transport, 'host'),
    data = vi.fn()
  socket.on('data', data)
  socket.on('error', () => {})
  transport.push(encodePaddingCell(new Uint8Array()))
  await vi.waitFor(() => expect(socket.readableLength).toBe(0))
  const bad = encodePaddingCell(Uint8Array.of(7))
  bad[1000] = 1
  transport.push(bad)
  await vi.waitFor(() => expect(socket.destroyed).toBe(true))
  expect(data).not.toHaveBeenCalled()
})
function recordingTransport(hold = false) {
  const cells: Array<{ at: number; bytes: Buffer }> = [],
    callbacks: Array<(error?: Error | null) => void> = []
  const transport = new Duplex({
    read() {},
    write(bytes, _encoding, callback) {
      cells.push({ at: performance.now(), bytes: Buffer.from(bytes) })
      if (hold) callbacks.push(callback)
      else callback()
    },
  })
  transport.on('error', () => {})
  return { transport, cells, callbacks }
}
const fakeClock: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
}
it('keeps a bulk connection on its 40ms grid for 3.5 seconds, then sends queued data unclocked without dummy cells', async () => {
  vi.useFakeTimers(fakeClock)
  const { transport, cells } = recordingTransport(),
    socket = new PaddedStream(transport, 'host')
  socket.on('error', () => {})
  socket.enableBulk()
  const start = performance.now()
  let written = 0
  const feed = () => {
    while (written < 4_194_304 && socket.write(Buffer.alloc(16_384, 1))) written += 16_384
  }
  socket.on('drain', () => {
    written += 16_384
    feed()
  })
  feed()
  await vi.advanceTimersByTimeAsync(3460)
  const early = cells.filter(cell => cell.at - start < 3500)
  // One large cell per grid slot: at most 32 KiB per 40 ms, the outer cover's own limit.
  for (const cell of early) expect(early.filter(other => Math.floor(other.at / 40) === Math.floor(cell.at / 40))).toHaveLength(1)
  expect(early.length).toBeLessThanOrEqual(Math.ceil(3500 / 40) + 1)
  await vi.advanceTimersByTimeAsync(200)
  const late = cells.filter(cell => cell.at - start >= 3500)
  expect(late.length).toBeGreaterThan(50)
  expect(late.every(cell => cell.bytes.length === 16_384 && cell.bytes[1]! * 256 + cell.bytes[2]! > 0)).toBe(true)
  expect(socket.traffic().dummyCells).toBe(early.filter(cell => cell.bytes[0] === 129).length)
  socket.destroy()
})
it('drops queued bulk bytes and closes when the guard fails before the next unclocked cell', async () => {
  vi.useFakeTimers(fakeClock)
  const { transport, cells, callbacks } = recordingTransport(true),
    socket = new PaddedStream(transport, 'host')
  socket.on('error', () => {})
  let allowed = true
  socket.guard(() => allowed)
  socket.enableBulk()
  await vi.advanceTimersByTimeAsync(3600)
  while (callbacks.length) callbacks.shift()!()
  const before = cells.length
  socket.write(Buffer.alloc(40_000, 7))
  await vi.advanceTimersByTimeAsync(0)
  expect(cells.length).toBe(before + 1)
  allowed = false
  callbacks.shift()!()
  await vi.advanceTimersByTimeAsync(10)
  expect(socket.destroyed).toBe(true)
  expect(transport.destroyed).toBe(true)
  expect(cells.length).toBe(before + 1)
})
