import { describe, expect, it } from 'vitest'
import { TRAFFIC_BUCKETS, TrafficMeter } from '../src/traffic.ts'

function clock(start = Date.parse('2026-10-25T08:00:00.000Z')) {
  const state = { now: start }
  return { state, now: () => state.now }
}

describe('traffic meter', () => {
  it('sorts frames into size buckets per kind, with one more bucket for anything larger', () => {
    const meter = new TrafficMeter()
    const stream = meter.stream('loopback-tcp')
    for (const bytes of [10, 256, 257, 4096, 5_000, 4_194_304, 4_194_305]) meter.frame(stream, 'task-state', bytes, 'task-a')
    const { kinds, buckets } = meter.summary()
    expect(buckets).toEqual([...TRAFFIC_BUCKETS])
    expect(kinds['task-state']).toEqual({
      count: 7,
      bytes: 10 + 256 + 257 + 4096 + 5_000 + 4_194_304 + 4_194_305,
      histogram: [2, 1, 1, 1, 0, 0, 0, 1, 1],
    })
    expect(kinds.refresh).toEqual({ count: 0, bytes: 0, histogram: Array.from({ length: TRAFFIC_BUCKETS.length + 1 }, () => 0) })
  })

  it('counts bytes per session over all connections and per connection, heartbeats included', () => {
    const time = clock()
    const meter = new TrafficMeter(time.now)
    const phone = meter.stream('tailnet-tls')
    const desktop = meter.stream('unix')
    meter.frame(phone, 'task-state', 1000, 'task-a')
    meter.frame(desktop, 'task-state', 1000, 'task-a')
    meter.frame(desktop, 'tasks-invalidated', 80, 'task-b')
    meter.frame(phone, 'refresh', 60)
    meter.frame(phone, 'heartbeat', 13)
    meter.response('detail', 5000, 'task-a')
    meter.response('snapshot', 9000)
    time.state.now += 60_000
    meter.close(phone)
    meter.close(phone)
    const summary = meter.summary()
    expect(summary.since).toBe('2026-10-25T08:00:00.000Z')
    expect(summary.at).toBe('2026-10-25T08:01:00.000Z')
    expect(summary.sessions).toEqual([
      { sessionId: 'task-a', frames: 2, frameBytes: 2000, details: 1, detailBytes: 5000 },
      { sessionId: 'task-b', frames: 1, frameBytes: 80, details: 0, detailBytes: 0 },
    ])
    expect(summary.connections).toEqual([
      { id: 2, listener: 'unix', openedAt: '2026-10-25T08:00:00.000Z', frames: 2, bytes: 1080, heartbeats: 0 },
      {
        id: 1,
        listener: 'tailnet-tls',
        openedAt: '2026-10-25T08:00:00.000Z',
        closedAt: '2026-10-25T08:01:00.000Z',
        frames: 3,
        bytes: 1073,
        heartbeats: 1,
      },
    ])
    expect(summary.kinds.snapshot).toMatchObject({ count: 1, bytes: 9000 })
    expect(summary.kinds.heartbeat).toMatchObject({ count: 1, bytes: 13 })
  })

  it('keeps at most 1000 sessions and 100 closed connections, dropping the least recent', () => {
    const meter = new TrafficMeter()
    const stream = meter.stream('unix')
    for (let index = 0; index < 1001; index++) meter.frame(stream, 'task-state', 1, `task-${index}`)
    meter.frame(stream, 'task-state', 1, 'task-0')
    const ids = meter.summary().sessions.map(session => session.sessionId)
    expect(ids).toHaveLength(1000)
    expect(ids).toContain('task-0')
    expect(ids).not.toContain('task-1')
    for (let index = 0; index < 120; index++) meter.close(meter.stream('loopback-tcp'))
    const connections = meter.summary().connections
    expect(connections).toHaveLength(101)
    expect(connections[0]).toMatchObject({ id: 1, listener: 'unix' })
    expect(connections[0]?.closedAt).toBeUndefined()
    expect(connections[1]).toMatchObject({ id: 121 })
    expect(connections.at(-1)).toMatchObject({ id: 22 })
  })

  it('returns a copy, so a caller cannot change the counters', () => {
    const meter = new TrafficMeter()
    meter.response('snapshot', 10)
    const first = meter.summary()
    first.kinds.snapshot.count = 99
    first.kinds.snapshot.histogram[0] = 99
    expect(meter.summary().kinds.snapshot).toMatchObject({ count: 1, histogram: [1, 0, 0, 0, 0, 0, 0, 0, 0] })
  })
})
