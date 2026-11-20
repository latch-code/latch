import { expect, it } from 'vitest'
import { EdgeBuffers, EDGE_BUFFER_LIMITS, type EdgeBufferLimits } from '../src/buffers.ts'
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
function clocked(limits: Partial<EdgeBufferLimits> = {}) {
  const clock = { now: 1_800_000_000_000 }
  return { clock, buffers: new EdgeBuffers(() => clock.now, limits) }
}
const WRITE = { queued: false }
/** An accepted socket, authenticated unless `pending`. */
function open(buffers: EdgeBuffers, prefix: string, options: { covered?: boolean; pending?: boolean } = {}) {
  const socket = new Socket()
  const result = buffers.accept(socket, prefix, options.covered ?? true)
  if (result.accepted && !options.pending) buffers.authenticate(socket)
  return { socket, ...result }
}

it('serves sockets whatever the runtime reports as bufferedAmount, and never lets it release budget', () => {
  const { buffers } = clocked()
  for (const value of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 0]) {
    const { socket, accepted } = open(buffers, '192.0.2.0/24')
    socket.bufferedAmount = value
    expect(accepted).toBe(true)
    expect(buffers.write(socket, new Uint8Array(1024), WRITE)).toBe('written')
  }
  const throwing = new Socket()
  Object.defineProperty(throwing, 'bufferedAmount', {
    get() {
      throw new Error('unavailable')
    },
  })
  expect(buffers.accept(throwing, '192.0.2.0/24', true).accepted).toBe(true)
  buffers.authenticate(throwing)
  expect(buffers.write(throwing, new Uint8Array(1024), WRITE)).toBe('written')
  // A runtime claiming nothing is queued does not refill a spent send budget.
  const { socket } = open(buffers, '198.51.100.0/24')
  socket.bufferedAmount = 0
  expect(buffers.write(socket, new Uint8Array(EDGE_BUFFER_LIMITS.socketSendBytes), WRITE)).toBe('written')
  expect(buffers.write(socket, new Uint8Array(1), WRITE)).toBe('over-budget')
})

it('limits what one socket hands the runtime to its budget plus the refill rate, read or not', () => {
  const { clock, buffers } = clocked()
  const { socket } = open(buffers, '192.0.2.0/24')
  const cell = new Uint8Array(16_384)
  let written = 0
  // Ten seconds of a reader that never reads: the active grid (16 KiB every 40 ms) fits, four times that does not.
  for (let tick = 0; tick < 250; tick++) {
    clock.now += 40
    expect(buffers.write(socket, cell, WRITE)).toBe('written')
    written += cell.length
  }
  expect(socket.sent).toBe(written)
  let refused = false,
    elapsed = 250 * 40
  for (let tick = 0; tick < 1000 && !refused; tick++) {
    clock.now += 10
    elapsed += 10
    refused = buffers.write(socket, cell, WRITE) !== 'written'
  }
  expect(refused).toBe(true)
  expect(socket.sent).toBeLessThanOrEqual(EDGE_BUFFER_LIMITS.socketSendBytes + (elapsed / 1000) * EDGE_BUFFER_LIMITS.socketSendRate)
})

it('caps what an unauthenticated socket may hand the runtime before it authenticates', () => {
  const { buffers } = clocked()
  const { socket } = open(buffers, '192.0.2.0/24', { pending: true })
  const pad = new Uint8Array(4096)
  let writes = 0
  while (buffers.write(socket, pad, WRITE) === 'written') writes++
  expect(writes * pad.length).toBeLessThanOrEqual(EDGE_BUFFER_LIMITS.preauthSocketBytes)
  // Authenticated, only the send budget applies.
  const { socket: done } = open(buffers, '192.0.2.0/24')
  for (let index = 0; index < EDGE_BUFFER_LIMITS.preauthSocketBytes / pad.length + 10; index++)
    expect(buffers.write(done, pad, WRITE)).toBe('written')
})

it('lets a newcomer in while other prefixes squat on unauthenticated cover, closing the largest prefix’s oldest', () => {
  const { buffers } = clocked()
  const squatters: Socket[] = []
  // Five prefixes keep the object's covered sockets full and never authenticate.
  for (let round = 0; squatters.length < 40; round++)
    for (let prefix = 0; prefix < 5; prefix++) {
      const opened = open(buffers, `10.0.${prefix}.0/24`, { pending: true })
      expect(opened.accepted).toBe(true)
      squatters.push(opened.socket)
    }
  expect(buffers.status().covered).toBe(EDGE_BUFFER_LIMITS.maxCovered)
  // A sixth prefix's phone is admitted; one squatter of the largest prefix makes room.
  const phone = open(buffers, '198.51.100.0/24', { pending: true })
  expect(phone.accepted).toBe(true)
  expect(phone.evict).toHaveLength(1)
  expect(squatters).toContain(phone.evict[0])
  // More squatting closes squatters, never the newcomer from the smallest prefix.
  for (let index = 0; index < 20; index++) {
    const more = open(buffers, `10.0.${index % 5}.0/24`, { pending: true })
    expect(more.evict).not.toContain(phone.socket)
  }
  // A Host's control socket has no cover and is never held back by it.
  expect(open(buffers, '203.0.113.0/24', { covered: false, pending: true }).evict).toEqual([])
  expect(buffers.status().refused).toBe(0)
})

it('lets a newcomer have a slot while other prefixes hold the rest, the largest giving up held slots first', () => {
  const { buffers } = clocked({ maxConnections: 20, maxPerPrefix: 8 })
  // Four prefixes fill every slot, half of them closed and held.
  for (let index = 0; index < 20; index++) {
    const { socket } = open(buffers, `10.0.${index % 4}.0/24`, { covered: false, pending: true })
    if (index >= 12) buffers.close(socket)
  }
  expect(buffers.size).toBe(20)
  const phone = open(buffers, '198.51.100.0/24', { pending: true })
  expect(phone.accepted).toBe(true)
  // A held slot was dropped: no live socket had to close.
  expect(phone.evict).toEqual([])
  expect(buffers.size).toBe(20)
  // Once no prefix has held slots left, the largest gives up its oldest unauthenticated socket.
  const crowd = clocked({ maxConnections: 4, maxPerPrefix: 8 })
  const sockets = [0, 1, 2, 3].map(() => open(crowd.buffers, '10.0.0.0/24', { covered: false, pending: true }).socket)
  const newcomer = open(crowd.buffers, '198.51.100.0/24', { covered: false, pending: true })
  expect(newcomer.accepted).toBe(true)
  expect(newcomer.evict).toEqual([sockets[0]])
})

it('bounds the slots one prefix holds while it opens and closes sockets faster than they are released', () => {
  const { clock, buffers } = clocked()
  for (let index = 0; index < 1024; index++) {
    const { socket, accepted } = open(buffers, '192.0.2.0/24', { covered: false, pending: true })
    expect(accepted).toBe(true)
    buffers.close(socket)
    clock.now += 4
  }
  // Each newcomer of the churning prefix replaced one of its own held slots.
  expect(buffers.size).toBe(EDGE_BUFFER_LIMITS.maxPerPrefix)
  expect(open(buffers, '198.51.100.0/24').accepted).toBe(true)
  clock.now += EDGE_BUFFER_LIMITS.closeHoldMs
  expect(buffers.size).toBe(1)
})

it('bounds received work and cover reservations exactly, per socket and per object', () => {
  const { buffers } = clocked(),
    payload = 65_536
  const sockets: Socket[] = []
  for (let index = 0; index < EDGE_BUFFER_LIMITS.objectBytes / EDGE_BUFFER_LIMITS.socketBytes; index++) {
    const { socket } = open(buffers, `10.0.${index}.0/24`)
    sockets.push(socket)
    for (let used = 0; used < EDGE_BUFFER_LIMITS.socketBytes; used += payload)
      expect(used % (2 * payload) ? buffers.queue(socket, payload) : buffers.receive(socket, payload)).toBe(true)
    expect(buffers.receive(socket, 1)).toBe(false)
  }
  expect(buffers.status().bytes).toBe(EDGE_BUFFER_LIMITS.objectBytes)
  const { socket: extra } = open(buffers, '10.1.0.0/24')
  expect(buffers.receive(extra, 1)).toBe(false)
  expect(buffers.queue(extra, 1)).toBe(false)
  buffers.received(sockets[0]!, payload)
  expect(buffers.receive(extra, payload)).toBe(true)
  // Sending a queued message releases its reservation.
  expect(buffers.write(sockets[1]!, new Uint8Array(payload), { queued: true })).toBe('written')
  expect(buffers.queue(extra, payload)).toBe(true)
  expect(buffers.status().bytes).toBe(EDGE_BUFFER_LIMITS.objectBytes)
})

it('holds a closed socket’s slot for the hold time by the clock, and its received work until it settles', () => {
  const { clock, buffers } = clocked()
  const { socket } = open(buffers, '192.0.2.0/24')
  expect(buffers.receive(socket, 100)).toBe(true)
  expect(buffers.queue(socket, 200)).toBe(true)
  buffers.close(socket)
  expect(buffers.status()).toMatchObject({ bytes: 100, messages: 1, slots: 1 })
  expect(buffers.queue(socket, 1)).toBe(false)
  expect(buffers.write(socket, new Uint8Array(1), WRITE)).toBe('failed')
  clock.now += EDGE_BUFFER_LIMITS.closeHoldMs
  expect(buffers.size).toBe(1)
  buffers.received(socket, 100)
  expect(buffers.size).toBe(0)
  expect(buffers.status()).toMatchObject({ bytes: 0, messages: 0 })
  const { socket: other } = open(buffers, '192.0.2.0/24')
  buffers.close(other)
  clock.now += EDGE_BUFFER_LIMITS.closeHoldMs - 1
  expect(buffers.size).toBe(1)
  clock.now += 1
  expect(buffers.size).toBe(0)
})

it('closes on a reported backlog, one socket above its bound and the largest above the object bound', () => {
  const { buffers } = clocked()
  const { socket: slow } = open(buffers, '192.0.2.0/24')
  slow.bufferedAmount = EDGE_BUFFER_LIMITS.maxBacklogBytes + 1
  expect(buffers.write(slow, new Uint8Array(1), WRITE)).toBe('backlog')
  expect(buffers.overloaded()).toEqual([slow])
  buffers.close(slow)
  const sockets = Array.from({ length: 40 }, (_, index) => open(buffers, `10.0.${index}.0/24`).socket)
  sockets.forEach((socket, index) => (socket.bufferedAmount = EDGE_BUFFER_LIMITS.maxBacklogBytes - index))
  // Forty sockets just under their own bound are above the object's: the largest go first until the sum fits.
  const closing = buffers.overloaded()
  expect(closing[0]).toBe(sockets[0])
  expect(closing.length).toBe(40 - EDGE_BUFFER_LIMITS.objectBacklogBytes / EDGE_BUFFER_LIMITS.maxBacklogBytes)
  const failing = open(buffers, '203.0.113.0/24').socket
  failing.send = () => {
    throw new Error('send failed')
  }
  expect(buffers.write(failing, new Uint8Array(1), WRITE)).toBe('failed')
})

/** An accepted socket joined to its partner: authenticated and joined, in either order. */
function joined(buffers: EdgeBuffers, prefix: string, order: 'admit' | 'attach' = 'admit') {
  const socket = new Socket()
  expect(buffers.accept(socket, prefix, true).accepted).toBe(true)
  if (order === 'admit') {
    buffers.authenticate(socket)
    buffers.join(socket)
  } else {
    // The DATA leg: the core joins it just before the node sends ATTACHED.
    buffers.join(socket)
    buffers.authenticate(socket)
  }
  return socket
}
const MiB = 1024 * 1024

it.each(['admit', 'attach'] as const)('lets a joined socket (%s) stream at 16 MiB/s without closing it', order => {
  const { clock, buffers } = clocked()
  const socket = joined(buffers, '192.0.2.0/24', order)
  const cell = new Uint8Array(16_384)
  // Ten seconds of 16 KiB every millisecond: just under 16 MiB/s.
  for (let tick = 0; tick < 10_000; tick++) {
    clock.now += 1
    expect(buffers.write(socket, cell, WRITE)).toBe('written')
  }
  expect(socket.sent).toBe(10_000 * cell.length)
  expect(socket.sent / 10).toBeGreaterThan(20 * EDGE_BUFFER_LIMITS.socketSendRate)
  // The joined budget is still a rate: past its burst plus the refill, the socket is closed.
  let refused = false,
    elapsed = 10_000
  for (let tick = 0; tick < 10_000 && !refused; tick++) {
    clock.now += 1
    elapsed += 1
    refused = buffers.write(socket, new Uint8Array(65_536), WRITE) !== 'written'
  }
  expect(refused).toBe(true)
  expect(socket.sent).toBeLessThanOrEqual(EDGE_BUFFER_LIMITS.joinedSendBytes + (elapsed / 1000) * EDGE_BUFFER_LIMITS.joinedSendRate)
})

it('keeps the old budget for every socket that is not both authenticated and joined', () => {
  const { clock, buffers } = clocked()
  const cell = new Uint8Array(16_384)
  const unauthenticated = open(buffers, '192.0.2.0/24', { pending: true }).socket
  const joinedOnly = new Socket()
  buffers.accept(joinedOnly, '192.0.2.0/24', true)
  buffers.join(joinedOnly)
  const control = open(buffers, '198.51.100.0/24', { covered: false }).socket
  const results = new Map<Socket, number>()
  for (const socket of [unauthenticated, joinedOnly, control]) {
    let written = 0
    for (let tick = 0; tick < 2000; tick++) {
      clock.now += 1
      if (buffers.write(socket, cell, WRITE) !== 'written') break
      written += cell.length
    }
    results.set(socket, written)
  }
  // Unauthenticated, joined or not: the 512 KiB pre-auth allowance.
  expect(results.get(unauthenticated)).toBeLessThanOrEqual(EDGE_BUFFER_LIMITS.preauthSocketBytes)
  expect(results.get(joinedOnly)).toBeLessThanOrEqual(EDGE_BUFFER_LIMITS.preauthSocketBytes)
  // Authenticated but never joined (the Host's control socket): 1 MiB at 768 KiB/s, closed within two seconds.
  expect(results.get(control)).toBeLessThanOrEqual(EDGE_BUFFER_LIMITS.socketSendBytes + 2 * EDGE_BUFFER_LIMITS.socketSendRate)
  expect(results.get(control)).toBeLessThan(2000 * cell.length)
})

it('closes a joined socket above its own 6 MiB backlog, and an unjoined one above 1 MiB', () => {
  const { buffers } = clocked()
  const phone = joined(buffers, '192.0.2.0/24')
  const control = open(buffers, '198.51.100.0/24', { covered: false }).socket
  phone.bufferedAmount = 3 * MiB
  control.bufferedAmount = 2 * MiB
  expect(buffers.write(phone, new Uint8Array(1), WRITE)).toBe('written')
  // The joined socket sorts first but is within its bound; the smaller unjoined one above its own is still found.
  expect(buffers.overloaded()).toEqual([control])
  buffers.close(control)
  phone.bufferedAmount = EDGE_BUFFER_LIMITS.joinedBacklogBytes + 1
  expect(buffers.write(phone, new Uint8Array(1), WRITE)).toBe('backlog')
  expect(buffers.overloaded()).toEqual([phone])
})

it('closes the largest joined sockets while their sum stays above the 32 MiB object backlog', () => {
  const { buffers } = clocked()
  const phones = Array.from({ length: 7 }, (_, index) => joined(buffers, `10.0.${index}.0/24`))
  phones.forEach((socket, index) => (socket.bufferedAmount = EDGE_BUFFER_LIMITS.joinedBacklogBytes - index))
  // About 42 MiB, each under its own bound: the two largest go.
  expect(buffers.overloaded()).toEqual([phones[0], phones[1]])
  expect(EDGE_BUFFER_LIMITS.objectBacklogBytes).toBe(32 * MiB)
})
