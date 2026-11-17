import { expect, it, vi } from 'vitest'
import { ReadingPositionController, type ReadingViewport } from '../src/core/useReadingPosition.ts'

function fixture() {
  let now = 1000
  const geometry = { top: 0, height: 200, extent: 1000 }
  const rows = Array.from({ length: 10 }, (_, index) => ({ id: `message-${index}`, top: index * 100, height: 100 }))
  const write = vi.fn((top: number) => {
    geometry.top = Math.max(0, Math.min(top, geometry.extent - geometry.height))
  })
  const viewport: ReadingViewport = {
    measure: () => ({ ...geometry }),
    write,
    anchor: () => {
      const row = rows.find(row => row.top + row.height > geometry.top && row.top < geometry.top + geometry.height)
      return row ? { messageId: row.id, offset: row.top - geometry.top } : null
    },
    positionFor: anchor => {
      const row = rows.find(row => row.id === anchor.messageId)
      return row ? row.top - anchor.offset : null
    },
  }
  const changed = vi.fn()
  const controller = new ReadingPositionController(changed, () => now)
  const userScroll = (top: number) => {
    geometry.top = top
    controller.scroll(viewport)
  }
  return {
    controller,
    viewport,
    geometry,
    rows,
    write,
    changed,
    userScroll,
    settle: () => {
      now += 1500
    },
  }
}

it('waits for detail readiness before restoring or following content', () => {
  const f = fixture()
  f.controller.sync('a', false, f.viewport)
  f.controller.layout(f.viewport)
  expect(f.write).not.toHaveBeenCalled()
  f.controller.sync('a', true, f.viewport)
  expect(f.geometry.top).toBe(800)
  expect(f.controller.isFollowing).toBe(true)
  f.geometry.extent = 1150
  f.controller.layout(f.viewport)
  expect(f.geometry.top).toBe(950)
})

it('follows same-session growth after the observed layout', () => {
  const f = fixture()
  const measure = vi.spyOn(f.viewport, 'measure')
  f.controller.sync('a', true, f.viewport, true)
  expect(f.geometry.top).toBe(800)
  measure.mockClear()
  f.geometry.extent = 1150
  f.controller.sync('a', true, f.viewport, true)
  expect(measure).not.toHaveBeenCalled()
  f.controller.layout(f.viewport)
  expect(f.geometry.top).toBe(950)
  f.geometry.extent = 650
  f.controller.sync('b', true, f.viewport, true)
  expect(f.geometry.top).toBe(450)
})

it('releases follow on upward reader intent and does not follow new output while reading', () => {
  const f = fixture()
  f.controller.sync('a', true, f.viewport)
  f.controller.scroll(f.viewport) // Deliver the event from the initial programmatic write.
  f.controller.input(-1, f.viewport)
  f.userScroll(530)
  expect(f.controller.isFollowing).toBe(false)
  f.settle()
  f.geometry.extent = 1400
  f.controller.layout(f.viewport)
  expect(f.geometry.top).toBe(530)
})

it('preserves the visible message offset when rows above it grow', () => {
  const f = fixture()
  f.controller.sync('a', true, f.viewport)
  f.controller.input(-1, f.viewport)
  f.userScroll(530)
  f.settle()
  // A change above the anchor can be balanced by a change below it, with no resize notification.
  f.rows[2].height += 80
  for (const row of f.rows) if (row.top >= 300 && row.top <= 800) row.top += 80
  f.rows[8].height -= 80
  f.controller.sync('a', true, f.viewport, true)
  expect(f.geometry.top).toBe(610)
  expect(f.viewport.anchor()).toEqual({ messageId: 'message-5', offset: -30 })
  f.controller.scroll(f.viewport)
  expect(f.controller.isFollowing).toBe(false)
})

it('does not counteract an active drag with an anchor correction', () => {
  const f = fixture()
  f.controller.sync('a', true, f.viewport)
  f.controller.pointer(true)
  f.userScroll(600)
  const writes = f.write.mock.calls.length
  f.geometry.top = 550 // The browser moved before its pending scroll event.
  f.controller.layout(f.viewport)
  expect(f.write).toHaveBeenCalledTimes(writes)
  expect(f.geometry.top).toBe(550)
})

it('keeps follow across a composer/viewport clamp even while a pointer is held', () => {
  const f = fixture()
  f.controller.sync('a', true, f.viewport)
  f.controller.pointer(true)
  f.geometry.height = 300
  f.userScroll(700)
  expect(f.controller.isFollowing).toBe(true)
  f.geometry.extent = 1100
  f.controller.layout(f.viewport)
  expect(f.geometry.top).toBe(800)
})

it('restores each session independently after its content becomes ready', () => {
  const f = fixture()
  f.controller.sync('a', true, f.viewport)
  f.controller.input(-1, f.viewport)
  f.userScroll(430)
  f.controller.sync('b', true, f.viewport)
  expect(f.geometry.top).toBe(800)
  expect(f.controller.isFollowing).toBe(true)
  f.controller.sync('a', false, f.viewport)
  expect(f.geometry.top).toBe(800)
  expect(f.controller.isFollowing).toBe(false)
  f.controller.sync('a', true, f.viewport)
  expect(f.geometry.top).toBe(430)
})

it('restores independent offsets when switching directly between three cached transcripts', () => {
  const f = fixture()
  for (const [session, offset] of [
    ['a', 230],
    ['b', 414],
    ['c', 573],
  ] as const) {
    f.controller.sync(session, true, f.viewport)
    f.controller.input(-1, f.viewport)
    f.userScroll(offset)
  }
  for (const [session, expected] of [
    ['a', 230],
    ['c', 573],
    ['b', 414],
    ['a', 230],
  ] as const) {
    f.controller.sync(session, true, f.viewport)
    expect(f.geometry.top).toBe(expected)
  }
  f.rows[0]!.height += 60
  for (const row of f.rows.slice(1)) row.top += 60
  f.geometry.extent += 60
  f.controller.sync('a', true, f.viewport, true)
  expect(f.viewport.anchor()).toEqual({ messageId: 'message-2', offset: -30 })
})

it('publishes the selected message identity only when reading reaches a different anchor', () => {
  const f = fixture()
  const observed: Array<string | null> = []
  const stop = f.controller.subscribeToReadingAnchor(() => observed.push(f.controller.getReadingMessageId()))
  f.controller.sync('a', true, f.viewport)
  expect(observed).toEqual([])
  f.controller.reveal('message-3', f.viewport)
  f.geometry.extent += 100
  f.controller.layout(f.viewport)
  expect(observed).toEqual(['message-3'])
  f.controller.input(1, f.viewport)
  f.userScroll(415)
  f.userScroll(445)
  expect(observed).toEqual(['message-3', 'message-4'])
  f.controller.sync('b', true, f.viewport)
  f.controller.sync('a', true, f.viewport)
  f.controller.jumpToLatest(f.viewport)
  expect(observed).toEqual(['message-3', 'message-4', null, 'message-4', null])
  stop()
  f.controller.reveal('message-3', f.viewport)
  expect(observed).toHaveLength(5)
})

it('records an explicit latest/send command while content is not ready', () => {
  const f = fixture()
  f.controller.sync('a', true, f.viewport)
  f.controller.input(-1, f.viewport)
  f.userScroll(300)
  f.controller.sync('a', false, f.viewport)
  f.controller.jumpToLatest(f.viewport)
  expect(f.geometry.top).toBe(300)
  expect(f.controller.isFollowing).toBe(true)
  f.controller.sync('a', true, f.viewport)
  expect(f.geometry.top).toBe(800)
})

it('re-arms follow only when a reader scrolls down to the bottom', () => {
  const f = fixture()
  f.controller.sync('a', true, f.viewport)
  f.controller.input(-1, f.viewport)
  f.userScroll(600)
  f.settle()
  f.geometry.top = 800
  f.controller.scroll(f.viewport) // A non-input browser/programmatic movement is not intent.
  expect(f.controller.isFollowing).toBe(false)
  f.geometry.top = 700
  f.controller.input(1, f.viewport)
  f.controller.scroll(f.viewport)
  f.userScroll(800)
  expect(f.controller.isFollowing).toBe(true)
})

it('does not lose a user scroll when a token layout runs before its native event', () => {
  const f = fixture()
  f.controller.sync('a', true, f.viewport)
  f.controller.input(-1, f.viewport)
  f.userScroll(500)
  f.controller.input(1, f.viewport)
  f.geometry.top = 800
  f.controller.layout(f.viewport)
  f.controller.scroll(f.viewport)
  expect(f.controller.isFollowing).toBe(true)
})

it('falls back to a bounded saved offset if the anchored message no longer exists', () => {
  const f = fixture()
  f.controller.sync('a', true, f.viewport)
  f.controller.input(-1, f.viewport)
  f.userScroll(530)
  f.settle()
  f.rows.splice(0)
  f.geometry.extent = 500
  f.controller.layout(f.viewport)
  expect(f.geometry.top).toBe(300)
  expect(f.controller.isFollowing).toBe(false)
})

it('reveals a row below the reader with a top margin and keeps it anchored while content grows', () => {
  const f = fixture()
  f.controller.sync('a', true, f.viewport)
  f.controller.input(-1, f.viewport)
  f.userScroll(100)
  f.settle()
  f.controller.reveal('message-4', f.viewport)
  expect(f.geometry.top).toBe(376)
  expect(f.controller.isFollowing).toBe(false)
  f.controller.scroll(f.viewport) // The programmatic write's own scroll event is not reader intent.
  expect(f.controller.isFollowing).toBe(false)
  for (const row of f.rows) row.top += 50
  f.geometry.extent += 50
  f.controller.layout(f.viewport)
  expect(f.geometry.top).toBe(426)
})

it('places a revealed row at the offset asked for, above the viewport for a place inside a tall row', () => {
  const f = fixture()
  f.controller.sync('a', true, f.viewport)
  f.controller.input(-1, f.viewport)
  f.userScroll(100)
  f.settle()
  f.controller.reveal('message-4', f.viewport, -100)
  expect(f.geometry.top).toBe(500)
  f.controller.reveal('message-4', f.viewport, 60)
  expect(f.geometry.top).toBe(340)
})

it('treats revealing a row at the bottom as returning to the latest content', () => {
  const f = fixture()
  f.controller.sync('a', true, f.viewport)
  f.controller.input(-1, f.viewport)
  f.userScroll(200)
  f.settle()
  f.controller.reveal('message-9', f.viewport)
  expect(f.geometry.top).toBe(800)
  expect(f.controller.isFollowing).toBe(true)
  f.geometry.extent = 1200
  f.controller.layout(f.viewport)
  expect(f.geometry.top).toBe(1000)
})

it('applies a reveal requested before the session content is ready once it loads', () => {
  const f = fixture()
  f.controller.sync('a', false, f.viewport)
  f.controller.reveal('message-3', f.viewport)
  expect(f.write).not.toHaveBeenCalled()
  f.controller.sync('a', true, f.viewport)
  expect(f.geometry.top).toBe(276)
  expect(f.controller.isFollowing).toBe(false)
})

it('ignores a reveal for a row that is not rendered', () => {
  const f = fixture()
  f.controller.sync('a', true, f.viewport)
  const writes = f.write.mock.calls.length
  f.controller.reveal('missing', f.viewport)
  expect(f.write).toHaveBeenCalledTimes(writes)
  expect(f.controller.isFollowing).toBe(true)
})

it('keeps following when upward input arrives on a transcript that cannot scroll', () => {
  const f = fixture()
  f.geometry.extent = 200
  f.controller.sync('a', true, f.viewport)
  f.controller.input(-1, f.viewport)
  expect(f.controller.isFollowing).toBe(true)
  expect(f.changed).not.toHaveBeenCalled()
  f.settle()
  f.geometry.extent = 700 // The streamed reply outgrows the pane and is still followed.
  f.controller.layout(f.viewport)
  expect(f.geometry.top).toBe(500)
})

it('applies a send to its own session and leaves the reader of the open session in place', () => {
  const f = fixture()
  f.controller.sync('x', true, f.viewport)
  f.controller.input(-1, f.viewport)
  f.userScroll(200)
  f.settle()
  f.controller.sync('y', true, f.viewport)
  f.controller.input(-1, f.viewport)
  f.userScroll(400)
  f.settle()
  // A send in X completes while Y is open.
  f.controller.show('x', undefined, f.viewport)
  expect(f.geometry.top).toBe(400)
  expect(f.controller.isFollowing).toBe(false)
  f.controller.sync('x', false, f.viewport)
  f.controller.sync('x', true, f.viewport)
  expect(f.geometry.top).toBe(800)
  expect(f.controller.isFollowing).toBe(true)
  f.controller.sync('y', true, f.viewport)
  expect(f.geometry.top).toBe(400)
  expect(f.controller.isFollowing).toBe(false)
})

it('drops a reveal request once another session is displayed before it loads', () => {
  const f = fixture()
  f.controller.sync('b', true, f.viewport)
  f.controller.show('a', 'message-3', f.viewport)
  f.controller.sync('a', false, f.viewport)
  f.controller.sync('b', true, f.viewport)
  // A later visit to A restores its own position (follow) instead of the abandoned row.
  f.controller.sync('a', true, f.viewport)
  expect(f.geometry.top).toBe(800)
  expect(f.controller.isFollowing).toBe(true)
})

it('reveals the requested row when its session becomes ready, or the latest output when the row is absent', () => {
  const f = fixture()
  f.controller.sync('b', true, f.viewport)
  f.controller.show('a', 'message-3', f.viewport)
  f.controller.sync('a', false, f.viewport)
  expect(f.geometry.top).toBe(800)
  f.controller.sync('a', true, f.viewport)
  expect(f.geometry.top).toBe(276)
  expect(f.controller.isFollowing).toBe(false)
  f.controller.show('a', 'missing', f.viewport)
  expect(f.geometry.top).toBe(800)
  expect(f.controller.isFollowing).toBe(true)
})

it('keeps the anchor when reasoning folds above it', () => {
  const f = fixture()
  f.controller.sync('a', true, f.viewport)
  f.controller.input(-1, f.viewport)
  f.userScroll(530)
  f.settle()
  // A thinking row above the anchor folds as the answer starts: every frame of the fold shrinks the rows above.
  for (const step of [40, 40, 40]) {
    for (const row of f.rows) if (row.top >= 300) row.top -= step
    f.geometry.extent -= step
    f.controller.layout(f.viewport)
  }
  expect(f.geometry.top).toBe(410)
  expect(f.viewport.anchor()).toEqual({ messageId: 'message-5', offset: -30 })
  expect(f.controller.isFollowing).toBe(false)
})

it('keeps a revealed row as its anchor whatever row a later measure takes for the top', () => {
  const f = fixture()
  f.controller.sync('a', true, f.viewport)
  f.controller.input(-1, f.viewport)
  f.userScroll(100)
  f.settle()
  // A turn not drawn yet overflows its placeholder, so a row far from the view can measure as the first one in it.
  const anchor = vi.spyOn(f.viewport, 'anchor').mockReturnValue({ messageId: 'message-1', offset: 0 })
  f.controller.reveal('message-4', f.viewport)
  expect(f.geometry.top).toBe(376)
  for (const row of f.rows) row.top += 50
  f.geometry.extent += 50
  f.controller.layout(f.viewport)
  expect(f.geometry.top).toBe(426)
  expect(anchor).not.toHaveBeenCalled()
})

it('measures the extent after finding the anchor, which can draw the turns around it', () => {
  const f = fixture()
  f.controller.sync('a', true, f.viewport)
  f.controller.input(-1, f.viewport)
  f.userScroll(530)
  f.settle()
  f.geometry.extent = 600
  f.geometry.top = 400
  const positionFor = f.viewport.positionFor
  f.viewport.positionFor = anchor => {
    f.geometry.extent = 1000
    return positionFor(anchor)
  }
  f.controller.layout(f.viewport)
  expect(f.geometry.top).toBe(530)
})
