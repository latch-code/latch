import { describe, expect, it } from 'vitest'
import { FRAME_PAYLOAD_LIMIT, FROM_HELPER, FrameReader, TO_HELPER, encodeFrame, encodeSize } from '../src/terminal/frames.ts'

describe('terminal frames', () => {
  it('encodes a type byte, a big-endian length and the payload', () => {
    expect([...encodeFrame(TO_HELPER.input, Buffer.from('ls\r'))]).toEqual([2, 0, 0, 0, 3, 0x6c, 0x73, 0x0d])
    expect([...encodeFrame(TO_HELPER.resize, encodeSize(300, 40))]).toEqual([3, 0, 0, 0, 4, 0x01, 0x2c, 0x00, 0x28])
    expect([...encodeFrame(FROM_HELPER.started)]).toEqual([1, 0, 0, 0, 0])
  })

  it('reads frames whatever the chunk boundaries, one byte at a time or many frames at once', () => {
    const stream = Buffer.concat([
      encodeFrame(FROM_HELPER.started, Buffer.from('{"pid":42}')),
      encodeFrame(FROM_HELPER.output, Buffer.from('你好\r\n')),
      encodeFrame(FROM_HELPER.output),
      encodeFrame(FROM_HELPER.exit, Buffer.from('{"code":0}')),
    ])
    const expected = [
      [1, '{"pid":42}'],
      [2, '你好\r\n'],
      [2, ''],
      [4, '{"code":0}'],
    ]
    const whole = new FrameReader().push(stream)
    expect(whole.map(frame => [frame.type, frame.payload.toString()])).toEqual(expected)
    const reader = new FrameReader()
    const bytewise = [...stream].flatMap(byte => reader.push(Buffer.of(byte)).map(frame => [frame.type, frame.payload.toString()]))
    expect(bytewise).toEqual(expected)
    expect(reader.buffered).toBe(0)
  })

  it('refuses payloads over the limit in both directions', () => {
    expect(() => encodeFrame(TO_HELPER.input, Buffer.alloc(FRAME_PAYLOAD_LIMIT + 1))).toThrow(RangeError)
    expect(encodeFrame(TO_HELPER.input, Buffer.alloc(FRAME_PAYLOAD_LIMIT))).toHaveLength(FRAME_PAYLOAD_LIMIT + 5)
    const header = Buffer.alloc(5)
    header.writeUInt8(FROM_HELPER.output, 0)
    header.writeUInt32BE(FRAME_PAYLOAD_LIMIT + 1, 1)
    expect(() => new FrameReader().push(header)).toThrow(RangeError)
  })
})
