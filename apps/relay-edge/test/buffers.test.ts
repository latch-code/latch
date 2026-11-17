import { expect, it } from 'vitest'
import { EdgeBuffers, EDGE_BUFFER_LIMITS } from '../src/buffers.ts'
import type { EdgeWebSocket } from '../src/platform.ts'

class Socket implements EdgeWebSocket {
  bufferedAmount: number | undefined = 0
  binaryType: EdgeWebSocket['binaryType'] = 'blob'
  accept() {}
  close() {}
  addEventListener() {}
  send(data: ArrayBuffer | Uint8Array) {
    this.bufferedAmount! += data.byteLength
  }
}

it('refuses missing, invalid and throwing runtime counters before admitting a socket', () => {
  const buffers = new EdgeBuffers()
  for (const value of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 1]) {
    const socket = new Socket()
    socket.bufferedAmount = value
    expect(buffers.accept(socket)).toBe(false)
  }
  const throwing = new Socket()
  Object.defineProperty(throwing, 'bufferedAmount', {
    get() {
      throw new Error('unavailable')
    },
  })
  expect(buffers.accept(throwing)).toBe(false)
  expect(buffers.size).toBe(0)
})

it('bounds undrained payload and message count, and frees capacity only when the runtime reports progress', () => {
  const buffers = new EdgeBuffers(),
    socket = new Socket()
  expect(buffers.accept(socket)).toBe(true)
  const payload = new Uint8Array(32_768)
  for (let index = 0; index < EDGE_BUFFER_LIMITS.socketBytes / payload.length; index++) {
    expect(buffers.queue(socket, payload.length)).toBe(true)
    buffers.write(socket, payload)
  }
  expect(buffers.queue(socket, payload.length)).toBe(false)
  expect(buffers.status().bytes).toBe(EDGE_BUFFER_LIMITS.socketBytes)
  socket.bufferedAmount! -= payload.length
  expect(buffers.queue(socket, payload.length)).toBe(true)
  buffers.write(socket, payload)
  expect(buffers.status().bytes).toBe(EDGE_BUFFER_LIMITS.socketBytes)

  socket.bufferedAmount = 0
  expect(buffers.current(socket)).toBe(true)
  const tiny = Uint8Array.of(0)
  for (let index = 0; index < EDGE_BUFFER_LIMITS.socketMessages; index++) {
    expect(buffers.queue(socket, 1)).toBe(true)
    buffers.write(socket, tiny)
  }
  expect(buffers.queue(socket, 1)).toBe(false)
  expect(buffers.status()).toEqual({ bytes: EDGE_BUFFER_LIMITS.socketMessages, messages: EDGE_BUFFER_LIMITS.socketMessages })
  socket.bufferedAmount = Number.NaN
  expect(buffers.current(socket)).toBe(false)
  expect(buffers.queue(socket, 1)).toBe(false)
})

it('counts receive work and outer-cover reservations with runtime output against the object bound', () => {
  const buffers = new EdgeBuffers(),
    payload = new Uint8Array(65_536)
  const sockets: Socket[] = []
  for (let index = 0; index < EDGE_BUFFER_LIMITS.objectBytes / EDGE_BUFFER_LIMITS.socketBytes; index++) {
    const socket = new Socket()
    sockets.push(socket)
    expect(buffers.accept(socket)).toBe(true)
    expect(buffers.receive(socket, payload.length)).toBe(true)
    expect(buffers.queue(socket, payload.length)).toBe(true)
    for (let written = 2; written < EDGE_BUFFER_LIMITS.socketBytes / payload.length; written++) {
      expect(buffers.queue(socket, payload.length)).toBe(true)
      buffers.write(socket, payload)
    }
  }
  expect(buffers.status().bytes).toBe(EDGE_BUFFER_LIMITS.objectBytes)
  const extra = new Socket()
  expect(buffers.accept(extra)).toBe(true)
  expect(buffers.receive(extra, 1)).toBe(false)
  expect(buffers.queue(extra, 1)).toBe(false)
  buffers.received(sockets[0]!, payload.length)
  expect(buffers.queue(extra, payload.length)).toBe(true)
})

it('retains queued writes through the close event and received work until it settles', () => {
  const buffers = new EdgeBuffers(),
    socket = new Socket(),
    payload = new Uint8Array(1024)
  expect(buffers.accept(socket)).toBe(true)
  expect(buffers.receive(socket, 100)).toBe(true)
  expect(buffers.queue(socket, payload.length)).toBe(true)
  buffers.write(socket, payload)
  expect(buffers.queue(socket, 200)).toBe(true)
  buffers.close(socket)
  expect(buffers.status()).toEqual({ bytes: 1124, messages: 2 })
  expect(buffers.size).toBe(1)
  expect(buffers.queue(socket, 1)).toBe(false)
  buffers.closed(socket)
  expect(buffers.status()).toEqual({ bytes: 1124, messages: 2 })
  expect(buffers.size).toBe(1)
  socket.bufferedAmount = 0
  expect(buffers.status()).toEqual({ bytes: 100, messages: 1 })
  expect(buffers.size).toBe(1)
  buffers.received(socket, 100)
  expect(buffers.status()).toEqual({ bytes: 0, messages: 0 })
  expect(buffers.size).toBe(0)
})

it('bounds the object’s message metadata even when every payload is one byte', () => {
  const buffers = new EdgeBuffers(),
    payload = Uint8Array.of(0)
  for (let index = 0; index < EDGE_BUFFER_LIMITS.objectMessages / EDGE_BUFFER_LIMITS.socketMessages; index++) {
    const socket = new Socket()
    expect(buffers.accept(socket)).toBe(true)
    for (let message = 0; message < EDGE_BUFFER_LIMITS.socketMessages; message++) {
      expect(buffers.queue(socket, 1)).toBe(true)
      buffers.write(socket, payload)
    }
  }
  const extra = new Socket()
  expect(buffers.accept(extra)).toBe(true)
  expect(buffers.queue(extra, 1)).toBe(false)
  expect(buffers.receive(extra, 1)).toBe(false)
  expect(buffers.status()).toEqual({ bytes: EDGE_BUFFER_LIMITS.objectMessages, messages: EDGE_BUFFER_LIMITS.objectMessages })
})
