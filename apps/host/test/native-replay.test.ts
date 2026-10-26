import { expect, it } from 'vitest'
import type { TaskStateEvent } from '@latch/protocol'
import { NativeReplay } from '../src/native-replay.ts'

function event(revision = 1, liveText = ''): TaskStateEvent {
  return {
    type: 'task-state',
    instanceId: 'boot-a',
    revision,
    sessionId: 'selected',
    detail: {
      summary: { id: 'selected', title: 'Fixture', status: 'running', updatedAt: '2026-10-25' },
      liveText,
      cursor: revision,
      messages: [],
      approvals: [],
    },
  }
}
it('replays the actual immutable event projection and filters each selected stream', () => {
  const log = new NativeReplay('boot-a'),
    source = event(1, 'retained'),
    retained = log.publish(source)
  source.detail.liveText = 'mutated after publication'
  log.publish({ type: 'tasks-invalidated', instanceId: 'boot-a', revision: 1, sessionId: 'selected' })
  expect(log.resume('boot-a', 0, 'selected')).toEqual({ kind: 'events', events: [retained] })
  expect(log.frame(retained)).toContain('retained')
  expect(log.frame(retained)).not.toContain('mutated')
  expect(log.resume('boot-a', 0, undefined)).toMatchObject({ kind: 'events', events: [{ type: 'tasks-invalidated' }] })
  expect(log.resume('old-boot', 0, 'selected')).toEqual({ kind: 'checkpoint' })
})
it('requires a checkpoint after count or byte compaction and records an explicit refresh for oversized body events', () => {
  const log = new NativeReplay('boot-a')
  for (let revision = 1; revision <= 257; revision++) log.publish({ type: 'refresh', instanceId: 'boot-a', revision })
  expect(log.resume('boot-a', 0, undefined)).toEqual({ kind: 'checkpoint' })
  const bytes = new NativeReplay('boot-a')
  for (let revision = 1; revision <= 3; revision++) bytes.publish(event(revision, 'x'.repeat(900000)))
  expect(bytes.resume('boot-a', 0, 'selected')).toEqual({ kind: 'checkpoint' })
  const refresh = bytes.publish(event(4, 'x'.repeat(1100000)))
  expect(refresh).toEqual({ type: 'refresh', instanceId: 'boot-a', revision: 4 })
  expect(bytes.cursor()).toBe('boot-a:4')
})
