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

it('says a live session waits on the person exactly where the Host’s board rule does (board-v1)', async () => {
  const { waits } = JSON.parse(await readFile('packages/testkit/vectors/board-v1.json', 'utf8')) as { waits: Vector[] }
  for (const vector of waits) {
    if (!vector.approval) {
      expect(waitsOnYou(vector.task), vector.name).toBe(vector.wait !== null)
      continue
    }
    // 等你处理 counts the Host's group; a listed approval counts on its own until the summary carries it.
    const approvals: Approval[] = [
      { id: 'a-1', sessionId: vector.task.id, toolName: 'write', reason: 'vector', requestedAt: vector.task.updatedAt },
    ]
    expect(waitingCount({ tasks: [vector.task], approvals }), vector.name).toBe(vector.wait === null ? 0 : 1)
  }
})
