import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { ProjectionGuard, type ProjectionTicket } from '../src/core/projection.ts'
import { TaskStreamProjection } from '../src/core/taskStream.ts'

interface Action {
  frame?: Record<string, unknown>
  event?: string
  raw?: string
  http?: TaskDetail
  reset?: boolean
  capture?: string
  ticket?: string
  saveCandidate?: string
  publishCandidate?: string
  bind?: { instanceId: string; sessionId: string }
  expect: Record<string, unknown>
}
interface Vector {
  name: string
  instanceId: string
  sessionId: string
  actions: Action[]
}

it('uses the cross-language full/delta event vectors without changing HTTP/source/selection ordering', async () => {
  const vectors = JSON.parse(await readFile('packages/testkit/vectors/task-delta-v1.json', 'utf8')) as { streams: Vector[] }
  for (const vector of vectors.streams) {
    let stream = new TaskStreamProjection(vector.instanceId, vector.sessionId)
    const guard = new ProjectionGuard()
    guard.bind(vector.instanceId)
    guard.select(vector.sessionId)
    const tickets = new Map<string, ProjectionTicket>(),
      candidates = new Map<string, TaskDetail>()
    let displayed: TaskDetail | null = null,
      first: TaskDetail | undefined,
      frozen = ''
    for (const [index, action] of vector.actions.entries()) {
      const ticket = action.ticket ? tickets.get(action.ticket)! : guard.capture()
      let result: Record<string, unknown>
      if (action.capture) {
        tickets.set(action.capture, guard.capture())
        result = { kind: 'capture' }
      } else if (action.bind) {
        guard.bind(action.bind.instanceId)
        guard.select(action.bind.sessionId)
        stream = new TaskStreamProjection(action.bind.instanceId, action.bind.sessionId)
        displayed = null
        result = { kind: 'bind' }
      } else if (action.reset) {
        stream.reset()
        result = { kind: 'reset' }
      } else if (action.http) {
        const accepted = guard.accept(ticket, action.http, 'http')
        if (accepted) displayed = action.http
        result = { kind: 'http', published: accepted }
      } else if (action.publishCandidate) {
        const candidate = candidates.get(action.publishCandidate)!
        const accepted = guard.accept(ticket, candidate, 'stream')
        if (accepted) displayed = candidate
        result = { kind: 'publish', published: accepted }
      } else {
        const next = stream.receive({ event: action.event ?? String(action.frame?.type), data: action.raw ?? JSON.stringify(action.frame) })
        result = { ...next }
        if (next.kind === 'detail') {
          const value = next.detail
          if (!first) {
            first = value
            frozen = JSON.stringify(value)
            Object.freeze(value)
            Object.freeze(value.messages)
          }
          if (action.saveCandidate) candidates.set(action.saveCandidate, value)
          const accepted = guard.accept(ticket, value, 'stream')
          if (accepted) displayed = value
          Object.assign(result, {
            published: accepted,
            reasoningPresent: Object.hasOwn(value, 'liveReasoning'),
            outputPresent: Object.hasOwn(value, 'lastOutputAt'),
            livePresent: Object.hasOwn(value.summary, 'live'),
            liveOutputPresent: value.summary.live !== undefined && Object.hasOwn(value.summary.live, 'lastOutputAt'),
          })
        }
      }
      result.displayedText = displayed?.liveText ?? null
      expect(result, `${vector.name}: ${index}`).toMatchObject(action.expect)
      if (first) expect(JSON.stringify(first), `${vector.name}: immutable prior detail`).toBe(frozen)
    }
  }
})
