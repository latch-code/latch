import { Duplex } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { decodeMessage, encodeFrame, WebSocketParser } from '@latch/link-wire'
import { RelayOuterPadding } from '../src/relay-outer-padding.ts'
import { RelaySocket } from '../src/websocket.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('does not emit twice in one grid when the platform timer wakes just before a fractional deadline', async () => {
  vi.useFakeTimers()
  let clock = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  const times: number[] = []
  const writer = new RelayOuterPadding({
    client: false,
    write: async () => {
      times.push(clock)
    },
    valid: () => true,
    fail: () => writer.close(),
  })
  clock = 39.6
  await vi.advanceTimersByTimeAsync(40)
  expect(times).toEqual([])
  clock = 40.1
  await vi.advanceTimersByTimeAsync(1)
  expect(times).toEqual([40.1])
  clock = 79.7
  await vi.advanceTimersByTimeAsync(40)
  expect(times).toEqual([40.1])
  clock = 80.2
  await vi.advanceTimersByTimeAsync(1)
  expect(times).toEqual([40.1, 80.2])
  writer.close()
  await writer.settled()
})

it('ends cover on its monotonic three-second budget even when the wall clock moves backwards', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const writes: Uint8Array[] = []
  const writer = new RelayOuterPadding({
    client: false,
    write: async bytes => {
      writes.push(bytes)
    },
    valid: () => true,
    fail: () => writer.close(),
  })
  await vi.advanceTimersByTimeAsync(80)
  vi.setSystemTime(-3_600_000)
  await vi.advanceTimersByTimeAsync(4000)
  expect(writes).toHaveLength(75)
  expect(writer.statistics()).toEqual({ paddingBytes: 307_200, batches: 75 })
  writer.close()
  await writer.settled()
})

it('coalesces only arrived frames on 40ms ticks and emits whole 4KiB buckets, including empty ticks', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const writes: Array<{ time: number; bytes: Uint8Array }> = []
  const writer = new RelayOuterPadding({
    client: true,
    write: async bytes => {
      writes.push({ time: Date.now(), bytes })
    },
    valid: () => true,
    fail: () => {
      throw new Error('Unexpected failure')
    },
  })
  const frame = (value: number) => encodeFrame({ opcode: 2, payload: new Uint8Array([0, value]) }, new Uint8Array([1, 2, 3, 4]))
  const first = writer.write(frame(5))
  await vi.advanceTimersByTimeAsync(39)
  const second = writer.write(frame(6))
  expect(writes).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1)
  await Promise.all([first, second])
  expect(writes[0]?.time).toBe(40)
  expect(writes[0]?.bytes.length).toBe(4096)
  const parser = new WebSocketParser(true)
  expect(parser.feed(writes[0]!.bytes).map(value => decodeMessage(value.payload, 2).type)).toEqual(['data', 'data', 'pad'])
  await vi.advanceTimersByTimeAsync(80)
  expect(writes.map(value => [value.time, value.bytes.length])).toEqual([
    [40, 4096],
    [80, 4096],
    [120, 4096],
  ])
  writer.close()
  await writer.settled()
  await vi.advanceTimersByTimeAsync(5000)
  expect(writes).toHaveLength(3)
})

it('keeps blocked writes owned, skips missed ticks without catchup bursts, and rejects a bounded full queue', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  let release: () => void = () => {}
  const write = vi.fn(
    () =>
      new Promise<void>(resolve => {
        release = resolve
      }),
  )
  let writer: RelayOuterPadding
  writer = new RelayOuterPadding({ client: false, write, valid: () => true, fail: () => writer.close() })
  const frame = encodeFrame({ opcode: 2, payload: new Uint8Array(16_385) })
  const first = writer.write(frame).catch(error => error)
  await vi.advanceTimersByTimeAsync(40)
  const second = writer.write(frame).catch(error => error)
  const third = writer.write(frame).catch(error => error)
  await vi.advanceTimersByTimeAsync(400)
  expect(write).toHaveBeenCalledTimes(1)
  let done = false
  const settled = writer.settled().then(() => {
    done = true
  })
  await expect(writer.write(frame)).rejects.toThrow('limit')
  await Promise.resolve()
  expect(done).toBe(false)
  expect(await second).toBeInstanceOf(Error)
  expect(await third).toBeInstanceOf(Error)
  release()
  await first
  await settled
  expect(done).toBe(true)
})

it('rechecks the original opening before an already queued body leaves the outer grid', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  let valid = true,
    writer: RelayOuterPadding
  const write = vi.fn(async () => {})
  writer = new RelayOuterPadding({ client: false, write, valid: () => valid, fail: () => writer.close() })
  const body = writer.write(encodeFrame({ opcode: 2, payload: new Uint8Array([0, 42]) })).catch(error => error)
  valid = false
  await vi.advanceTimersByTimeAsync(40)
  expect(await body).toBeInstanceOf(Error)
  expect(write).not.toHaveBeenCalled()
  await writer.settled()
})

it('does not let received PAD extend a fixed authentication receive deadline', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const stream = new Duplex({
    read() {},
    write(_bytes, _encoding, callback) {
      callback()
    },
  })
  stream.on('error', () => {})
  const peer = new RelaySocket(stream, true, undefined, { version: 2 })
  const received = peer.receive(100).catch(error => error)
  stream.push(encodeFrame({ opcode: 2, payload: new Uint8Array([1, 3]) }))
  await vi.advanceTimersByTimeAsync(90)
  stream.push(encodeFrame({ opcode: 2, payload: new Uint8Array([1, 4]) }))
  await vi.advanceTimersByTimeAsync(10)
  expect(await received).toBeInstanceOf(Error)
  stream.destroy()
  await peer.closed
})

it.each(['expiry', 'replacement'])('drops ciphertext after a fairness wait when its original opening changes: %s', async reason => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  let generation = 1,
    release: (value: boolean) => void = () => {}
  const writes: Buffer[] = []
  const stream = new Duplex({
    read() {},
    write(bytes, _encoding, callback) {
      writes.push(Buffer.from(bytes))
      callback()
    },
  })
  stream.on('error', () => {})
  const reserve = vi.fn(
    () =>
      new Promise<boolean>(resolve => {
        release = resolve
      }),
  )
  const peer = new RelaySocket(stream, false, undefined, { version: 2, outerPadding: true, beforeWrite: reserve })
  peer.guardWrites(() => Date.now() < 200 && generation === 1)
  const body = peer.send({ type: 'data', data: new Uint8Array([42]) }).catch(error => error)
  await vi.advanceTimersByTimeAsync(40)
  expect(reserve).toHaveBeenCalledTimes(1)
  if (reason === 'expiry') vi.setSystemTime(200)
  else generation = 2
  release(true)
  expect(await body).toBeInstanceOf(Error)
  expect(writes.filter(bytes => (bytes[0]! & 15) === 2)).toEqual([])
  stream.destroy()
  await peer.closed
})

it('fits stream fragments into the adaptive 16KiB shape while retaining real write completion', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const writes: Buffer[] = []
  const stream = new Duplex({
    read() {},
    write(bytes, _encoding, callback) {
      writes.push(Buffer.from(bytes))
      callback()
    },
  })
  stream.on('error', () => {})
  const peer = new RelaySocket(stream, false, undefined, { version: 2, outerPadding: true, sendHighWaterMark: () => 16_384 })
  const sending = peer.send({ type: 'data', data: new Uint8Array(16_384).fill(42) })
  await vi.advanceTimersByTimeAsync(80)
  await sending
  expect(writes.map(bytes => bytes.length)).toEqual([12_288, 8192])
  const frames = new WebSocketParser(false).feed(Buffer.concat(writes)).map(value => decodeMessage(value.payload, 2))
  expect(frames.filter(value => value.type === 'data').flatMap(value => Array.from(value.type === 'data' ? value.data : []))).toEqual(
    Array.from(new Uint8Array(16_384).fill(42)),
  )
  peer.close()
  stream.destroy()
  await peer.closed
})

it('keeps a client write pending until its actual underlying write callback completes', async () => {
  let release: (error?: Error | null) => void = () => {}
  const stream = new Duplex({
    read() {},
    write(_bytes, _encoding, callback) {
      release = callback
    },
  })
  stream.on('error', () => {})
  const peer = new RelaySocket(stream, true)
  let done = false
  const writing = peer.send({ type: 'hello' }).then(() => {
    done = true
  })
  await Promise.resolve()
  expect(done).toBe(false)
  release()
  await writing
  expect(done).toBe(true)
  peer.close()
  stream.destroy()
  await peer.closed
})

it('retains a timed-out write after raw close until the actual entered callback finishes', async () => {
  vi.useFakeTimers()
  let release: (error?: Error | null) => void = () => {}
  const stream = new Duplex({
    read() {},
    write(_bytes, _encoding, callback) {
      release = callback
    },
  })
  stream.on('error', () => {})
  const peer = new RelaySocket(stream, true, undefined, { sendTimeoutMs: 100 })
  const result = peer.send({ type: 'hello' }).catch(error => error)
  await vi.advanceTimersByTimeAsync(100)
  expect(await result).toBeInstanceOf(Error)
  const rawClosed = new Promise<void>(resolve => stream.once('close', resolve))
  stream.destroy()
  await rawClosed
  let settled = false
  void peer.closed.then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(peer.metrics().pendingWriteBytes).toBeGreaterThan(0)
  release()
  await peer.closed
  expect(settled).toBe(true)
  expect(peer.metrics().pendingWriteBytes).toBe(0)
})
