import { describe, expect, it } from 'vitest'
import { SIMULATOR_STREAM, type SimulatorInputEvent, type SimulatorLiveDescription } from '@latch/protocol'
import {
  InputSender,
  LiveReader,
  chooseCodec,
  deviceInput,
  deviceKey,
  inputReason,
  parseControl,
  parseDescription,
  pointerToDevice,
  streamQuery,
  uprightSize,
  uprightTransform,
} from '../src/panel/device/live.ts'

const PORTRAIT: SimulatorLiveDescription = {
  codec: 'h264',
  codecString: 'avc1.4d001f',
  config: 'AU0=',
  width: 588,
  height: 1280,
  points: { width: 402, height: 874 },
  source: { width: 1206, height: 2622 },
  orientation: 1,
}

function message(type: number, timestamp: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(13 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint8(0, type)
  view.setBigUint64(1, BigInt(timestamp))
  view.setUint32(9, payload.length)
  out.set(payload, 13)
  return out
}

/** Where a framebuffer pixel lands once the transform is applied. */
function apply(matrix: [number, number, number, number, number, number], x: number, y: number) {
  const [a, b, c, d, e, f] = matrix
  return { x: a * x + c * y + e, y: b * x + d * y + f }
}

describe('the live stream on the page', () => {
  it('splits messages whatever the chunk boundaries, and refuses an unknown type', () => {
    const description = new TextEncoder().encode(JSON.stringify(PORTRAIT))
    const bytes = new Uint8Array([
      ...message(SIMULATOR_STREAM.description, 0, description),
      ...message(SIMULATOR_STREAM.key, 33_000, new Uint8Array([1, 2, 3])),
    ])
    const reader = new LiveReader()
    const got = [...reader.push(bytes.subarray(0, 5)), ...reader.push(bytes.subarray(5, 30)), ...reader.push(bytes.subarray(30))]
    expect(got.map(item => [item.type, item.timestamp, item.payload.length])).toEqual([
      [1, 0, description.length],
      [3, 33_000, 3],
    ])
    expect(parseDescription(got[0]!.payload)).toEqual(PORTRAIT)
    expect(() => new LiveReader().push(message(0x42, 0, new Uint8Array()))).toThrow()
    expect(parseDescription(new TextEncoder().encode('{"codec":"vp9"}'))).toBeUndefined()
  })

  it('asks for H.264 only where VideoDecoder exists', () => {
    expect(chooseCodec({ VideoDecoder: class {} })).toBe('h264')
    expect(chooseCodec({})).toBe('jpeg')
    expect(streamQuery('h264')).toBe('codec=h264&fps=30&size=1280')
    expect(streamQuery('jpeg')).toBe('codec=jpeg&fps=20&size=960')
  })

  it('draws turned content upright: the content’s top-left lands at the canvas’s top-left', () => {
    // 3: the content's top is at the framebuffer's left, so its top-left corner is the framebuffer's bottom-left.
    const three = { ...PORTRAIT, orientation: 3 as const }
    expect(uprightSize(three)).toEqual({
      pixels: { width: 1280, height: 588 },
      points: { width: 874, height: 402 },
      device: { width: 2622, height: 1206 },
    })
    expect(apply(uprightTransform(three), 0, 1280)).toEqual({ x: 0, y: 0 })
    expect(apply(uprightTransform(three), 588, 0)).toEqual({ x: 1280, y: 588 })
    // 4: the content's top is at the framebuffer's right, its top-left the framebuffer's top-right.
    const four = { ...PORTRAIT, orientation: 4 as const }
    expect(apply(uprightTransform(four), 588, 0)).toEqual({ x: 0, y: 0 })
    expect(apply(uprightTransform(four), 0, 1280)).toEqual({ x: 1280, y: 588 })
    expect(apply(uprightTransform({ ...PORTRAIT, orientation: 2 }), 588, 1280)).toEqual({ x: 0, y: 0 })
    expect(apply(uprightTransform(PORTRAIT), 10, 20)).toEqual({ x: 10, y: 20 })
  })
})

describe('a pointer on the picture', () => {
  const points = { width: 402, height: 874 }

  it('lands in device points at any zoom', () => {
    // Fit: the canvas is 201 × 437 CSS pixels, half a point each.
    expect(pointerToDevice({ x: 100.5 + 10, y: 80 + 20 }, { left: 10, top: 20, width: 201, height: 437 }, points)).toEqual({
      x: 201,
      y: 160,
    })
    // 200%: twice the 1:1 size at a pixel ratio of 2, so a CSS pixel is a point… times 402/804.
    expect(pointerToDevice({ x: 402, y: 320 }, { left: 0, top: 0, width: 804, height: 1748 }, points)).toEqual({ x: 201, y: 160 })
    expect(pointerToDevice({ x: 0, y: 0 }, { left: 0, top: 0, width: 402, height: 874 }, points)).toEqual({ x: 0, y: 0 })
    expect(pointerToDevice({ x: 402, y: 874 }, { left: 0, top: 0, width: 402, height: 874 }, points)).toEqual({ x: 402, y: 874 })
  })

  it('letterboxes by the picture’s own pixels, which an encoder rounds to even sizes', () => {
    // 220 × 480 pixels for 402 × 874 points: drawn 201 × 438.5 in a 201 × 440 box, 0.75 pixels of bar above and below.
    const at = pointerToDevice({ x: 100.5, y: 0.75 + 80.25 }, { left: 0, top: 0, width: 201, height: 440 }, points, {
      width: 220,
      height: 480,
    })
    expect(at).toEqual({ x: 201, y: 160 })
  })

  it('accounts for letterboxing, and is outside the picture in the bars', () => {
    // A box wider than the picture: bars left and right.
    const box = { left: 0, top: 0, width: 1000, height: 874 }
    expect(pointerToDevice({ x: 299 + 201, y: 160 }, box, points)).toEqual({ x: 201, y: 160 })
    expect(pointerToDevice({ x: 100, y: 160 }, box, points)).toBeUndefined()
    expect(pointerToDevice({ x: 10, y: 10 }, { left: 0, top: 0, width: 0, height: 0 }, points)).toBeUndefined()
  })

  it('uses the turned content’s own frame, as idb does (checked on iOS 27.2)', () => {
    const turned = uprightSize({ ...PORTRAIT, orientation: 3 }).points
    expect(turned).toEqual({ width: 874, height: 402 })
    // In landscape Safari idb's (201, 160) was the content's (201, 160): the panel shows the content upright, so a
    // pointer at that place of the picture is that point.
    expect(pointerToDevice({ x: 201 / 2, y: 160 / 2 }, { left: 0, top: 0, width: 437, height: 201 }, turned)).toEqual({ x: 201, y: 160 })
  })
})

describe('input to the Host', () => {
  it('keeps order, batches moves to one per frame, and never drops a down or an up', async () => {
    const posts: SimulatorInputEvent[][] = []
    let flush: (() => void) | undefined
    let release: (() => void) | undefined
    const sender = new InputSender(
      async events => {
        posts.push(events)
        await new Promise<void>(resolve => (release = resolve))
      },
      () => undefined,
      run => (flush = run),
    )
    sender.send({ type: 'touch', phase: 'down', x: 1, y: 1 })
    for (let index = 2; index < 10; index++) sender.send({ type: 'touch', phase: 'move', x: index, y: index })
    sender.send({ type: 'touch', phase: 'up', x: 9, y: 9 })
    sender.send({ type: 'key', key: 'return' })
    expect(posts).toEqual([[{ type: 'touch', phase: 'down', x: 1, y: 1 }]])
    release!()
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    flush?.()
    expect(posts[1]).toEqual([
      { type: 'touch', phase: 'move', x: 9, y: 9 },
      { type: 'touch', phase: 'up', x: 9, y: 9 },
      { type: 'key', key: 'return' },
    ])
    release!()
  })

  it('reports a failed request and drops what waited', async () => {
    const failures: unknown[] = []
    const sender = new InputSender(
      async () => {
        throw new Error('no')
      },
      error => failures.push(error),
      run => run(),
    )
    sender.send({ type: 'button', button: 'home' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(failures).toHaveLength(1)
    expect(sender.waiting).toBe(0)
  })

  it('sends printable ASCII as text, refuses other characters out loud, and leaves shortcuts alone', () => {
    const input = (value: string, modifiers: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
      deviceInput({ key: value, metaKey: false, ctrlKey: false, altKey: false, ...modifiers })
    expect(input('a')).toEqual({ type: 'text', text: 'a' })
    expect(input(' ')).toEqual({ type: 'text', text: ' ' })
    expect(input('@')).toEqual({ type: 'text', text: '@' })
    expect(input('Enter')).toEqual({ type: 'key', key: 'return' })
    expect(input('你')).toBe('refused')
    expect(input('é')).toBe('refused')
    expect(input('Process')).toBe('refused')
    expect(input('a', { metaKey: true })).toBeUndefined()
    expect(input('Shift')).toBeUndefined()
  })

  it('joins typed characters that wait into one text event', async () => {
    const posts: SimulatorInputEvent[][] = []
    let release: (() => void) | undefined
    const sender = new InputSender(
      async events => {
        posts.push(events.map(event => ({ ...event })))
        await new Promise<void>(resolve => (release = resolve))
      },
      () => undefined,
      run => run(),
    )
    sender.send({ type: 'text', text: 'a' })
    sender.send({ type: 'text', text: 'b' })
    sender.send({ type: 'text', text: 'c' })
    release!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(posts).toEqual([[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'bc' }]])
    release!()
  })

  it('sends only named keys, never printable characters or shortcuts', () => {
    const key = (value: string, modifiers: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
      deviceKey({ key: value, metaKey: false, ctrlKey: false, altKey: false, ...modifiers })
    expect(['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map(value => key(value))).toEqual([
      'return',
      'delete',
      'tab',
      'escape',
      'left',
      'right',
      'up',
      'down',
    ])
    expect(key('a')).toBeUndefined()
    expect(key(' ')).toBeUndefined()
    expect(key('你')).toBeUndefined()
    expect(key('Enter', { metaKey: true })).toBeUndefined()
  })

  it('reads the control answer defensively and gives the install command in the hover', () => {
    const view = parseControl({ control: { touch: { available: false, reason: 'idb-missing' }, keys: { available: true }, buttons: 'x' } })
    expect(view.touch).toEqual({ available: false, reason: 'idb-missing' })
    expect(view.keys).toEqual({ available: true })
    expect(view.buttons).toEqual({ available: false, reason: 'companion-failed' })
    expect(inputReason(view.touch)).toContain('brew install idb-companion')
    expect(inputReason({ available: true })).toBe('')
  })
})
