import { expect, it } from 'vitest'
import { PaddingClock, PaddingDecoder, encodePaddingCell } from '../src/index.ts'
it('decodes authenticated cells across every split and rejects unknown kinds, oversized lengths and nonzero tails', () => {
  const encoded = encodePaddingCell(Uint8Array.of(1, 2, 3))
  for (let split = 0; split <= encoded.length; split++) {
    const decoder = new PaddingDecoder()
    expect([...decoder.feed(encoded.slice(0, split)), ...decoder.feed(encoded.slice(split))]).toEqual([Uint8Array.of(1, 2, 3)])
  }
  expect(new PaddingDecoder().feed(encodePaddingCell(new Uint8Array(), true))).toEqual([])
  for (const [index, value] of [
    [0, 2],
    [1, 255],
    [1023, 1],
  ] as const) {
    const bad = encoded.slice()
    bad[index] = value
    expect(() => new PaddingDecoder().feed(bad)).toThrow()
  }
})
it('absorbs upstream ACKs in a 250ms grid and downstream active bytes in a 40ms grid without catch-up bursts', () => {
  const up = new PaddingClock('client', 0),
    down = new PaddingClock('host', 0)
  expect(up.next(40, 400).size).toBe(0)
  expect(down.next(40, 400).size).toBe(1024)
  expect(up.next(250, 400).size).toBe(1024)
  expect(up.next(250, 400).size).toBe(0)
  expect(down.next(1000, 400).size).toBe(1024)
  expect(down.next(1000, 400).size).toBe(0)
})
it('keeps both approval outcomes on small cells for 15 seconds and switches large sizes only on five-second boundaries', () => {
  for (const bytes of [0, 60000]) {
    const clock = new PaddingClock('host', 0)
    clock.protect(0)
    for (let time = 40; time < 15000; time += 40) expect(clock.next(time, bytes, true).size).toBe(1024)
  }
  const clock = new PaddingClock('host', 0)
  expect(clock.next(4960, 50000).size).toBe(1024)
  expect(clock.next(5000, 50000).size).toBe(16384)
  expect(clock.next(5040, 0).size).toBe(16384)
  expect(clock.next(9960, 0, true).size).toBe(16384)
  expect(clock.next(10000, 0, true).size).toBe(1024)
})
it.each([9999, 10001])('keeps an existing large shape through its boundary after control at %i and merges cooldowns', controlAt => {
  const clock = new PaddingClock('host', 0)
  expect(clock.next(5000, 50000).size).toBe(16384)
  if (controlAt > 10000) expect(clock.next(10000, 50000).size).toBe(16384)
  else expect(clock.next(9960, 0).size).toBe(16384)
  clock.protect(controlAt)
  const end = controlAt < 10000 ? 10000 : 15000
  if (controlAt > 10000) expect(clock.next(10040, 0).size).toBe(16384)
  expect(clock.next(end, 50000).size).toBe(1024)
  clock.protect(20000)
  expect(clock.next(30000, 50000).size).toBe(1024)
  expect(clock.next(35000, 50000).size).toBe(16384)
})
it('uses a fixed explicit bulk downlink independent of control cooldown, with no client-side bulk mode', () => {
  const clock = new PaddingClock('host', 0)
  clock.protect(0)
  clock.enableBulk()
  expect(clock.next(40, 0).size).toBe(16384)
  expect(clock.next(80, 0).size).toBe(16384)
  expect(clock.next(80, 60000).size).toBe(0)
  expect(() => new PaddingClock('client', 0).enableBulk()).toThrow()
})
