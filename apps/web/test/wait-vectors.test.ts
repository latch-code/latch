import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import type { Approval, TaskSummary } from '@latch/protocol'
import { waitingCount, waitsOnYou } from '../src/sessions.ts'

interface Vector {
  name: string
  task: TaskSummary
  approval: boolean
  wait: string | null
}

it('counts a session as waiting on the person exactly where the Host’s board rule does (board-v1)', async () => {
  const { waits } = JSON.parse(await readFile('packages/testkit/vectors/board-v1.json', 'utf8')) as { waits: Vector[] }
  for (const vector of waits) {
    const approvals: Approval[] = vector.approval
      ? [{ id: 'a-1', sessionId: vector.task.id, toolName: 'write', reason: 'vector', requestedAt: vector.task.updatedAt }]
      : []
    expect(waitingCount({ tasks: [vector.task], approvals }), vector.name).toBe(vector.wait === null ? 0 : 1)
    if (!vector.approval) expect(waitsOnYou(vector.task), vector.name).toBe(vector.wait !== null)
  }
})
