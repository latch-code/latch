import { expect, it } from 'vitest'
import { PADDING, PaddingClock, PaddingDecoder, encodePaddingCell, paddingBucket } from '../src/index.ts'
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
  clock.enableBulk(0)
  expect(clock.next(40, 0).size).toBe(16384)
  expect(clock.next(80, 0).size).toBe(16384)
  expect(clock.next(80, 60000).size).toBe(0)
  expect(() => new PaddingClock('client', 0).enableBulk(0)).toThrow()
})
it('keeps the 40ms bulk grid for 3.5 seconds after the connection opened, then sends queued cells at once', () => {
  const clock = new PaddingClock('host', 1000)
  clock.enableBulk(1200)
  for (let time = 1200; time < 4500; time += 40) {
    expect(clock.unclocked(time)).toBe(false)
    expect(clock.next(time, 60000)).toMatchObject({ size: 16384 })
    expect(clock.next(time + 1, 60000).size).toBe(0)
  }
  expect(clock.unclocked(4499)).toBe(false)
  expect(clock.unclocked(4500)).toBe(true)
  for (let index = 0; index < 4; index++) expect(clock.next(4500, 60000)).toEqual({ size: 16384, wait: 0 })
  // Unclocked and busy: nothing to send means no dummy cell.
  expect(clock.next(4500, 0, true).size).toBe(0)
  expect(clock.next(5400, 0).size).toBe(0)
  expect(() => new PaddingClock('host', 0).unclocked(5000)).not.toThrow()
  expect(new PaddingClock('host', 0).unclocked(5000)).toBe(false)
})
it('caps unclocked bulk cells at the sender rate after spending its burst', () => {
  const clock = new PaddingClock('host', 0)
  clock.enableBulk(0)
  let time = PADDING.bulkDelayMs,
    sent = 0
  for (; time < PADDING.bulkDelayMs + 10_000;) {
    const next = clock.next(time, 60000)
    if (next.size) {
      clock.record(next.size, time)
      sent += next.size
    } else time += next.wait
  }
  const seconds = (time - PADDING.bulkDelayMs) / 1000
  expect(sent).toBeLessThanOrEqual(PADDING.bulkBurst + PADDING.bulkRate * seconds + PADDING.large)
  expect(sent).toBeGreaterThan(PADDING.bulkRate * seconds)
})
it('pads the bulk total to its size bucket once quiet, and never pads a control connection', () => {
  expect([0, 1, 262_144, 262_145, 327_680, 327_681].map(paddingBucket)).toEqual([262_144, 262_144, 262_144, 327_680, 327_680, 409_600])
  for (let bytes = 1; bytes < 64 * 1024 * 1024; bytes = Math.ceil(bytes * 1.7)) {
    const bucket = paddingBucket(bytes)
    expect(bucket % PADDING.large).toBe(0)
    expect(bucket).toBeGreaterThanOrEqual(bytes)
    expect(bucket).toBeLessThanOrEqual(Math.max(PADDING.bulkBucketBase, bytes * 1.25 + PADDING.large))
  }
  const clock = new PaddingClock('host', 0)
  clock.enableBulk(0)
  let time = PADDING.bulkDelayMs
  for (let index = 0; index < 70; index++) {
    const next = clock.next(time, 60000)
    expect(next.size).toBe(16384)
    clock.record(next.size, time)
  }
  expect(clock.bulkTotal()).toBe(70 * 16384)
  expect(clock.next(time + PADDING.bulkQuietMs - 1, 0).size).toBe(0)
  time += PADDING.bulkQuietMs
  let polls = 0
  for (let next = clock.next(time, 0); next.size; next = clock.next(time, 0), polls++) {
    clock.record(next.size, time)
    time += next.wait
  }
  expect(polls).toBe(paddingBucket(70 * 16384) / 16384 - 70)
  expect(clock.next(time, 0)).toEqual({ size: 0, wait: PADDING.idleMs })
  expect(clock.bulkTotal()).toBe(paddingBucket(70 * 16384))
  expect(clock.next(time + 10_000, 0).size).toBe(0)
  const control = new PaddingClock('host', 0)
  control.record(16384, 100)
  expect(control.bulkTotal()).toBe(0)
  expect(control.unclocked(10_000)).toBe(false)
})
