import { describe, expect, it } from 'vitest'
import { frameGate } from '../src/core/frameGate.ts'
import { CATCH_UP_CHARS, FenceTracker, REVEAL_MS, revealCut, revealRate, revealStep } from '../src/core/pacedText.ts'

describe('drawing once per animation frame', () => {
  it('draws once for any number of requests within a frame, and again only after it', () => {
    const frames: Array<() => void> = []
    let drawn = 0
    const draw = frameGate(
      () => drawn++,
      run => frames.push(run),
    )
    draw()
    draw()
    draw()
    expect([frames.length, drawn]).toEqual([1, 0])
    frames.shift()!()
    expect(drawn).toBe(1)
    draw()
    expect(frames.length).toBe(1)
    // A hidden page runs no frames: requests keep waiting on the one that is scheduled.
    draw()
    draw()
    expect([frames.length, drawn]).toEqual([1, 1])
    frames.shift()!()
    expect(drawn).toBe(2)
  })

  it('draws at once where there are no frames', () => {
    let drawn = 0
    const draw = frameGate(() => drawn++, undefined)
    draw()
    draw()
    expect(drawn).toBe(2)
  })
})

describe('paced text', () => {
  it('shows what waits within the reveal time at an even pace, and everything at once when far behind', () => {
    expect(REVEAL_MS).toBeGreaterThanOrEqual(120)
    expect(REVEAL_MS).toBeLessThanOrEqual(300)
    const rate = revealRate(100, 280)!
    let shown = 100
    const steps: number[] = []
    for (let elapsed = 0; shown < 280; elapsed += 16) {
      const next = revealStep(shown, 280, rate, 16)
      steps.push(next - shown)
      shown = next
    }
    // Even steps (the last may be shorter), done in about the reveal time.
    expect(new Set(steps.slice(0, -1)).size).toBe(1)
    expect(steps.length * 16).toBeLessThanOrEqual(REVEAL_MS + 32)
    expect(steps.length * 16).toBeGreaterThanOrEqual(120)
    expect(revealRate(0, CATCH_UP_CHARS + 1)).toBeUndefined()
    expect(revealRate(50, 50)).toBeUndefined()
    expect(revealRate(60, 50)).toBeUndefined()
    // Always forward, never past the end, and a late frame does not lurch.
    expect(revealStep(10, 12, 0.0001, 16)).toBe(11)
    expect(revealStep(10, 12, 5, 16)).toBe(12)
    expect(revealStep(0, 10_000, 1, 5_000)).toBe(50)
  })

  it('never cuts a surrogate pair, and shows unfinished code a whole line at a time', () => {
    const fence = new FenceTracker()
    const emoji = 'a😀b'
    expect(emoji.slice(0, revealCut(emoji, 2, fence))).toBe('a😀')
    const text = 'intro words\n\n```ts\nconst a = 1\nconst b = 2\n```\n\nafter the code'
    const tracker = new FenceTracker()
    const shown: string[] = []
    for (let count = 1; count <= text.length; count++) shown.push(text.slice(0, revealCut(text, count, tracker)))
    // Every cut is a prefix that only grows.
    for (const [index, part] of shown.entries()) {
      expect(text.startsWith(part)).toBe(true)
      if (index > 0) expect(part.length).toBeGreaterThanOrEqual(shown[index - 1]!.length)
    }
    // Inside the fence no line is ever shown in part.
    const inside = shown.filter(part => part.includes('```ts\n') && !part.includes('\n```\n'))
    expect(inside.length).toBeGreaterThan(0)
    for (const part of inside) expect(part.endsWith('\n')).toBe(true)
    // Prose before and after the fence is revealed by character, and the whole text at the end.
    expect(shown).toContain('intro w')
    expect(shown).toContain(`${text.slice(0, text.indexOf('after') + 3)}`)
    expect(shown.at(-1)).toBe(text)
  })

  it('reads fences again from the start when the text is not the one it followed', () => {
    const tracker = new FenceTracker()
    expect(tracker.inside('```\ncode\nmore', 10)).toBe(true)
    expect(tracker.inside('plain\ntext\nmore words', 12)).toBe(false)
    expect(tracker.inside('~~~\ncode\n~~~\nprose here', 20)).toBe(false)
  })
})
