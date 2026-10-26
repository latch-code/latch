import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkedTransportDescriptor,
  encodeTransportDescriptor,
  decodeTransportDescriptor,
  transportDescriptorHash,
} from '../src/transport-descriptor.ts'
import { ByteTransportStream, streamByteTransport } from '../src/byte-transport.ts'
import { messageByteTransport, type MessageCarrier } from '../src/message-transport.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
function messagePair(
  options: { transform?: (bytes: Uint8Array, deliver: (bytes: Uint8Array) => void) => void; stop?: () => Promise<void> } = {},
) {
  type Side = { message?: (bytes: Uint8Array) => void; closed?: () => void; ended: boolean; done: Promise<void>; finish(): void }
  const sides: Side[] = [0, 1].map(() => {
    let finish = () => {}
    const done = new Promise<void>(resolve => {
      finish = resolve
    })
    return { ended: false, done, finish }
  })
  let writes = 0
  const carriers: MessageCarrier[] = sides.map((side, index) => ({
    maximumMessageBytes: 1024,
    closed: side.done,
    async send(bytes, signal) {
      signal.throwIfAborted()
      if (side.ended) throw new Error('Carrier closed')
      writes++
      const deliver = (part: Uint8Array) => queueMicrotask(() => sides[1 - index]!.message?.(Uint8Array.from(part)))
      if (index === 0 && options.transform) options.transform(bytes, deliver)
      else deliver(bytes)
    },
    subscribe(message, closed) {
      side.message = message
      side.closed = closed
      return () => {
        delete side.message
        delete side.closed
      }
    },
    async close() {
      if (side.ended) return
      side.ended = true
      await options.stop?.()
      for (const target of sides) target.closed?.()
      side.finish()
    },
  }))
  const id = new Uint8Array(16).fill(7),
    a = messageByteTransport(carriers[0]!, id),
    b = messageByteTransport(carriers[1]!, id)
  cleanup.push(async () => {
    await Promise.all([a.close(), b.close()])
  })
  return { a, b, carriers, writes: () => writes }
}
describe('public transport descriptors', () => {
  it('has stable finite encoding and rejects webhook paths, credentials and unknown configuration', () => {
    const value = { version: 1, driverId: 'my-message', channelId: 'public-channel', endpoint: 'message://fixture/' }
    expect(decodeTransportDescriptor(encodeTransportDescriptor(value))).toEqual(value)
    expect(transportDescriptorHash(value)).toHaveLength(32)
    expect(transportDescriptorHash({ ...value, channelId: 'other' })).not.toEqual(transportDescriptorHash(value))
    for (const endpoint of [
      'https://user:password@example.invalid/',
      'https://example.invalid/webhook/secret',
      'https://example.invalid/?token=x',
      'https://example.invalid/#x',
      'file:///private',
      'data:text/plain,x',
    ])
      expect(() => checkedTransportDescriptor({ ...value, endpoint })).toThrow('Invalid public')
    expect(() => checkedTransportDescriptor({ ...value, token: 'never accepted' })).toThrow('Invalid public')
    expect(() => decodeTransportDescriptor(new Uint8Array(2049))).toThrow('Invalid public')
  })
})
describe('bounded interactive message transport', () => {
  it('retains Node ownership until writes and reads really settle even when a generic carrier reports closed early', async () => {
    let end = () => {},
      write = () => {},
      read: (value: IteratorResult<Uint8Array>) => void = () => {}
    const closed = new Promise<void>(resolve => {
        end = resolve
      }),
      next = vi.fn(
        () =>
          new Promise<IteratorResult<Uint8Array>>(resolve => {
            read = resolve
          }),
      ),
      pendingWrite = vi.fn(
        () =>
          new Promise<void>(resolve => {
            write = resolve
          }),
      ),
      stream = new ByteTransportStream({
        incoming: {
          [Symbol.asyncIterator]() {
            return {
              next,
              async return() {
                return { done: true, value: undefined }
              },
            }
          },
        },
        write: pendingWrite,
        closed,
        async close() {
          end()
        },
      }),
      settled = vi.fn()
    const written = new Promise<Error | null | undefined>(resolve => {
      stream.write(Buffer.from([1]), resolve)
    })
    stream.resume()
    await vi.waitFor(() => {
      expect(next).toHaveBeenCalledTimes(1)
      expect(pendingWrite).toHaveBeenCalledTimes(1)
    })
    void stream.settled.then(settled)
    stream.destroy()
    await closed
    expect(settled).not.toHaveBeenCalled()
    write()
    expect(await written).toBeInstanceOf(Error)
    expect(settled).not.toHaveBeenCalled()
    read({ done: true, value: undefined })
    await stream.settled
    expect(settled).toHaveBeenCalledTimes(1)
  })
  it('does not treat a rejected close request as observed physical closure', async () => {
    let finish = () => {}
    const closed = new Promise<void>(resolve => {
        finish = resolve
      }),
      ended = vi.fn(),
      transport = messageByteTransport(
        {
          maximumMessageBytes: 1024,
          closed,
          send: async () => {},
          subscribe: () => () => {},
          close: async () => {
            throw new Error('close result unknown')
          },
        },
        new Uint8Array(16),
      )
    const pending = transport.close().then(ended)
    await Promise.resolve()
    await Promise.resolve()
    expect(ended).not.toHaveBeenCalled()
    finish()
    await pending
    expect(ended).toHaveBeenCalledTimes(1)
  })
  it('reassembles fragments exactly once despite loss, duplicate messages and reversed delivery', async () => {
    const held: Array<() => void> = []
    let lost = false,
      reversed = false
    const pair = messagePair({
      transform(bytes, deliver) {
        const seq = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(18)
        if (bytes[1] === 1 && seq === 1 && !lost) {
          lost = true
          return
        }
        if (bytes[1] === 1 && seq < 4 && !reversed) {
          held.push(() => deliver(bytes))
          if (held.length === 3) {
            reversed = true
            for (const send of held.reverse()) send()
          }
          return
        }
        deliver(bytes)
        if (bytes[1] === 1 && seq === 2) deliver(bytes)
      },
    })
    const expected = Uint8Array.from({ length: 16_384 }, (_, index) => index % 251),
      chunks: Uint8Array[] = []
    const reading = (async () => {
      let length = 0
      for await (const bytes of pair.b.incoming) {
        chunks.push(bytes)
        length += bytes.length
        if (length === expected.length) break
      }
    })()
    await pair.a.write(expected, new AbortController().signal)
    await reading
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(expected))
    expect(lost).toBe(true)
    expect(reversed).toBe(true)
    expect(pair.writes()).toBeLessThan(64)
  })
  it('cancels a stalled acknowledgement and retains its close budget until the carrier really settles', async () => {
    let release: () => void = () => {}
    const stopped = new Promise<void>(done => {
        release = done
      }),
      pair = messagePair({ transform() {}, stop: () => stopped }),
      abort = new AbortController()
    const write = pair.a.write(new Uint8Array([1, 2, 3]), abort.signal).catch(error => error),
      ended = vi.fn()
    void pair.a.closed.then(ended)
    await vi.waitFor(() => expect(pair.writes()).toBe(1))
    abort.abort()
    expect(await write).toBeInstanceOf(Error)
    await Promise.resolve()
    expect(ended).not.toHaveBeenCalled()
    release()
    await pair.a.closed
    expect(ended).toHaveBeenCalledTimes(1)
  })
  it('rejects out-of-window and oversized packets without growing an incoming queue', async () => {
    const pair = messagePair(),
      signal = new AbortController().signal
    const bad = new Uint8Array(23)
    bad[0] = 1
    bad[1] = 1
    bad.set(new Uint8Array(16).fill(7), 2)
    new DataView(bad.buffer).setUint32(18, 99)
    await pair.carriers[0]!.send(bad, signal)
    await pair.b.closed
    await expect(pair.b.write(new Uint8Array(16_385), signal)).rejects.toThrow('write limit')
  })
  it('adapts to Node streams with real write/read backpressure and waits for destruction', async () => {
    const pair = messagePair(),
      a = new ByteTransportStream(pair.a),
      b = new ByteTransportStream(pair.b)
    cleanup.push(async () => {
      a.destroy()
      b.destroy()
      await Promise.all([a.settled, b.settled])
    })
    const wrapper = streamByteTransport(a),
      reading = b[Symbol.asyncIterator]()
    const next = reading.next()
    await wrapper.write(new Uint8Array([1, 2, 3]), new AbortController().signal)
    expect((await next).value).toEqual(Buffer.from([1, 2, 3]))
    await wrapper.close()
    await a.settled
    expect(a.destroyed).toBe(true)
  })
})
