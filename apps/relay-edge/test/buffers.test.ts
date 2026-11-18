import { expect, it } from 'vitest'
import { EdgeBuffers, EDGE_BUFFER_LIMITS } from '../src/buffers.ts'
import type { EdgeWebSocket } from '../src/platform.ts'

class Socket implements EdgeWebSocket {
  bufferedAmount: number | undefined = undefined
  binaryType: EdgeWebSocket['binaryType'] = 'blob'
  sent = 0
  accept() {}
  close() {}
  addEventListener() {}
  send(data: ArrayBuffer | Uint8Array) {
    this.sent += data.byteLength
  }
}
function clocked() {
  const clock = { now: 1_800_000_000_000 }
  return { clock, buffers: new EdgeBuffers(() => clock.now) }
}
const AUTH = { queued: false, authenticated: true },
  PREAUTH = { queued: false, authenticated: false }

it('serves sockets whatever the runtime reports as bufferedAmount, and never lets it release budget', () => {
  const { buffers } = clocked()
  for (const value of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 0]) {
    const socket = new Socket()
    socket.bufferedAmount = value
    expect(buffers.accept(socket, '192.0.2.0/24')).toBe(true)
    expect(buffers.write(socket, new Uint8Array(1024), AUTH)).toBe('written')
  }
  const throwing = new Socket()
  Object.defineProperty(throwing, 'bufferedAmount', {
    get() {
      throw new Error('unavailable')
    },
  })
  expect(buffers.accept(throwing, '192.0.2.0/24')).toBe(true)
  expect(buffers.write(throwing, new Uint8Array(1024), AUTH)).toBe('written')
  // A runtime claiming nothing is queued does not refill a spent send budget.
  const socket = new Socket()
  socket.bufferedAmount = 0
  expect(buffers.accept(socket, '198.51.100.0/24')).toBe(true)
  expect(buffers.write(socket, new Uint8Array(EDGE_BUFFER_LIMITS.socketSendBytes), AUTH)).toBe('written')
  expect(buffers.write(socket, new Uint8Array(1), AUTH)).toBe('over-budget')
})

it('limits what one socket hands the runtime to its budget plus the refill rate, read or not', () => {
  const { clock, buffers } = clocked(),
    socket = new Socket()
  expect(buffers.accept(socket, '192.0.2.0/24')).toBe(true)
  const cell = new Uint8Array(16_384)
  let written = 0
  // Ten seconds of a reader that never reads: the active grid (16 KiB every 40 ms) fits, twice that does not.
  for (let tick = 0; tick < 250; tick++) {
    clock.now += 40
    expect(buffers.write(socket, cell, AUTH)).toBe('written')
    written += cell.length
  }
  expect(socket.sent).toBe(written)
  let refused = false,
    elapsed = 250 * 40
  // Four times the grid's rate runs the budget dry within seconds.
  for (let tick = 0; tick < 1000 && !refused; tick++) {
    clock.now += 10
    elapsed += 10
    refused = buffers.write(socket, cell, AUTH) !== 'written'
  }
  expect(refused).toBe(true)
  expect(socket.sent).toBeLessThanOrEqual(EDGE_BUFFER_LIMITS.socketSendBytes + (elapsed / 1000) * EDGE_BUFFER_LIMITS.socketSendRate)
})

it('makes unauthenticated output spend its prefix and the object budgets, and refuses sockets that cannot be covered', () => {
  const { clock, buffers } = clocked()
  const pad = new Uint8Array(4096)
  const sockets: Socket[] = []
  let refused = false
  // One prefix opens sockets that never authenticate, each taking its cover.
  for (let index = 0; index < 64 && !refused; index++) {
    const socket = new Socket()
    if (!buffers.accept(socket, '192.0.2.0/24')) {
      refused = true
      break
    }
    sockets.push(socket)
    for (let tick = 0; tick < 25; tick++) if (buffers.write(socket, pad, PREAUTH) !== 'written') break
  }
  expect(refused).toBe(true)
  const handed = sockets.reduce((sum, socket) => sum + socket.sent, 0)
  expect(handed).toBeLessThanOrEqual(EDGE_BUFFER_LIMITS.preauthPrefixBytes)
  expect(buffers.status().refused).toBe(1)
  // Another prefix is not affected; an authenticated socket of the first one does not spend the prefix budget.
  expect(buffers.accept(new Socket(), '198.51.100.0/24')).toBe(true)
  const authenticated = sockets[0]!
  expect(buffers.write(authenticated, pad, AUTH)).toBe('written')
  expect(buffers.write(sockets[1]!, pad, PREAUTH)).toBe('over-budget')
  // The prefix budget refills with time.
  clock.now += 1000
  expect(buffers.accept(new Socket(), '192.0.2.0/24')).toBe(true)

  // Many prefixes together stop at the object budget.
  const { buffers: shared } = clocked()
  let total = 0
  for (let prefix = 0; prefix < 64; prefix++) {
    const socket = new Socket()
    if (!shared.accept(socket, `10.0.${prefix}.0/24`)) break
    for (let tick = 0; tick < 75; tick++) if (shared.write(socket, pad, PREAUTH) !== 'written') break
    total += socket.sent
  }
  expect(total).toBeLessThanOrEqual(EDGE_BUFFER_LIMITS.preauthObjectBytes)
  expect(shared.accept(new Socket(), '10.1.0.0/24')).toBe(false)
})

it('bounds received work and cover reservations exactly, per socket and per object', () => {
  const { buffers } = clocked(),
    payload = 65_536
  const sockets: Socket[] = []
  for (let index = 0; index < EDGE_BUFFER_LIMITS.objectBytes / EDGE_BUFFER_LIMITS.socketBytes; index++) {
    const socket = new Socket()
    sockets.push(socket)
    expect(buffers.accept(socket, `10.0.${index}.0/24`)).toBe(true)
    for (let used = 0; used < EDGE_BUFFER_LIMITS.socketBytes; used += payload)
      expect(used % (2 * payload) ? buffers.queue(socket, payload) : buffers.receive(socket, payload)).toBe(true)
    expect(buffers.receive(socket, 1)).toBe(false)
  }
  expect(buffers.status().bytes).toBe(EDGE_BUFFER_LIMITS.objectBytes)
  const extra = new Socket()
  expect(buffers.accept(extra, '10.1.0.0/24')).toBe(true)
  expect(buffers.receive(extra, 1)).toBe(false)
  expect(buffers.queue(extra, 1)).toBe(false)
  buffers.received(sockets[0]!, payload)
  expect(buffers.receive(extra, payload)).toBe(true)
  // Sending a queued message releases its reservation.
  expect(buffers.write(sockets[1]!, new Uint8Array(payload), { queued: true, authenticated: true })).toBe('written')
  expect(buffers.queue(extra, payload)).toBe(true)
})

it('holds a closed socket’s slot for the hold time by the clock, and its received work until it settles', () => {
  const { clock, buffers } = clocked(),
    socket = new Socket()
  expect(buffers.accept(socket, '192.0.2.0/24')).toBe(true)
  expect(buffers.receive(socket, 100)).toBe(true)
  expect(buffers.queue(socket, 200)).toBe(true)
  buffers.close(socket)
  expect(buffers.status()).toMatchObject({ bytes: 100, messages: 1, slots: 1 })
  expect(buffers.queue(socket, 1)).toBe(false)
  expect(buffers.write(socket, new Uint8Array(1), AUTH)).toBe('failed')
  clock.now += EDGE_BUFFER_LIMITS.closeHoldMs
  expect(buffers.size).toBe(1)
  buffers.received(socket, 100)
  expect(buffers.size).toBe(0)
  const other = new Socket()
  expect(buffers.accept(other, '192.0.2.0/24')).toBe(true)
  buffers.close(other)
  expect(buffers.size).toBe(1)
  clock.now += EDGE_BUFFER_LIMITS.closeHoldMs - 1
  expect(buffers.size).toBe(1)
  clock.now += 1
  expect(buffers.size).toBe(0)
})

it('closes on a reported backlog, one socket above its bound and the largest above the object bound', () => {
  const { buffers } = clocked()
  const slow = new Socket()
  expect(buffers.accept(slow, '192.0.2.0/24')).toBe(true)
  slow.bufferedAmount = EDGE_BUFFER_LIMITS.maxBacklogBytes + 1
  expect(buffers.write(slow, new Uint8Array(1), AUTH)).toBe('backlog')
  expect(buffers.overloaded()).toEqual([slow])
  buffers.close(slow)
  const sockets = Array.from({ length: 20 }, () => new Socket())
  for (const [index, socket] of sockets.entries()) {
    expect(buffers.accept(socket, `10.0.${index}.0/24`)).toBe(true)
    socket.bufferedAmount = EDGE_BUFFER_LIMITS.maxBacklogBytes - index
  }
  // Twenty sockets just under their own bound are above the object's: the largest go first until the sum fits.
  const closing = buffers.overloaded()
  expect(closing[0]).toBe(sockets[0])
  expect(closing.length).toBe(20 - EDGE_BUFFER_LIMITS.objectBacklogBytes / EDGE_BUFFER_LIMITS.maxBacklogBytes)
  // A runtime that fails send() fails the write.
  const failing = new Socket()
  failing.send = () => {
    throw new Error('send failed')
  }
  expect(buffers.accept(failing, '203.0.113.0/24')).toBe(true)
  expect(buffers.write(failing, new Uint8Array(1), AUTH)).toBe('failed')
})

it('bounds the slots one prefix holds while it opens and closes sockets faster than they are released', () => {
  const { clock, buffers } = clocked()
  let accepted = 0
  // Open and close within one tick, never spending cover: only the slot count stops it.
  for (let index = 0; index < 1024; index++) {
    const socket = new Socket()
    if (!buffers.accept(socket, '192.0.2.0/24')) break
    buffers.close(socket)
    accepted++
    clock.now += 4
  }
  expect(accepted).toBe(EDGE_BUFFER_LIMITS.maxPerPrefix)
  expect(buffers.accept(new Socket(), '198.51.100.0/24')).toBe(true)
  clock.now += EDGE_BUFFER_LIMITS.closeHoldMs
  expect(buffers.accept(new Socket(), '192.0.2.0/24')).toBe(true)
})
