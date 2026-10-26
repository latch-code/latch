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
