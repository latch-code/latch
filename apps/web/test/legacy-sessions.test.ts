import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/core/api.ts'
import { isMissingTask, missingMeansDeleted } from '../src/core/useHarness.ts'

describe('selection that the Host no longer has', () => {
  it('is recognized from the task-not-found answer, not from connection failures', () => {
    expect(isMissingTask(new ApiError(404, 'task-not-found', '找不到该任务'))).toBe(true)
    expect(isMissingTask(new ApiError(404, 'not-found', '接口不存在'))).toBe(false)
    expect(isMissingTask(new ApiError(503, 'unavailable', '暂不可用'))).toBe(false)
    expect(isMissingTask(new TypeError('Failed to fetch'))).toBe(false)
  })
  it('counts as deleted only when the same listing was whole, never while a Harness is off or remounting', () => {
    expect(missingMeansDeleted({ tasksComplete: true })).toBe(true)
    expect(missingMeansDeleted({})).toBe(false)
  })
})
