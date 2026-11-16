import { describe, expect, it } from 'vitest'
import type { WorkbenchDeliveryEntry } from '@latch/protocol'
import { deliveryChecks, deliveryCheckSummary, hasDelivery } from '../src/shell/useWorkbenchEvidence.ts'

const entry = (id: string, extra: Partial<WorkbenchDeliveryEntry> = {}): WorkbenchDeliveryEntry => ({
  sessionId: id,
  observedAt: '2026-11-13T01:00:00Z',
  state: { ahead: 0, behind: 0, staged: 1, unstaged: 1, untracked: 0, conflicted: 0, files: 1, head: 'head' },
  ...extra,
})
const pr = {
  number: 12,
  url: 'https://github.com/example/project/pull/12',
  title: 'Change',
  base: 'main',
  head: 'work',
  state: 'open' as const,
  draft: false,
  headSha: 'head',
}

describe('workbench delivery evidence', () => {
  it('requires actual changes, unpublished commits or an open PR, never a completed task or closed PR alone', () => {
    expect(hasDelivery(undefined)).toBe(false)
    expect(hasDelivery(entry('none', { state: undefined }))).toBe(false)
    expect(hasDelivery(entry('changed'))).toBe(true)
    expect(hasDelivery(entry('merged', { state: undefined, pr: { pr: { ...pr, state: 'merged' }, checks: [] } }))).toBe(false)
    expect(hasDelivery(entry('closed', { state: undefined, pr: { pr: { ...pr, state: 'closed' }, checks: [] } }))).toBe(false)
    expect(hasDelivery(entry('open', { state: undefined, pr: { pr, checks: [] } }))).toBe(true)
  })

  it('does not describe missing, skipped or stale checks as passed', () => {
    const withChecks = (checks: NonNullable<WorkbenchDeliveryEntry['pr']>['checks']) => entry('s', { pr: { pr, checks } })
    expect(deliveryChecks(withChecks([]))).toBe('没有检查结果')
    expect(deliveryChecks(withChecks([{ name: 'test', state: 'skipped' }]))).toBe('0 项通过 · 1 项跳过')
    const stale = withChecks([{ name: 'test', state: 'pass' }])
    stale.state!.head = 'new-head'
    expect(deliveryChecks(stale)).toBe('检查对应旧提交')
    expect(deliveryChecks(withChecks([{ name: 'test', state: 'pass' }]))).toBe('检查通过 1/1')
    expect(deliveryChecks(withChecks([{ name: 'test', state: 'pending' }]))).toBe('1 项检查中')
    expect(deliveryChecks(withChecks([{ name: 'test', state: 'fail' }]))).toBe('1 项检查失败')
  })

  it('only shows check counts for an observed repository head matching the PR', () => {
    const checks: NonNullable<WorkbenchDeliveryEntry['pr']>['checks'] = [
      { name: 'test', state: 'pass' },
      { name: 'types', state: 'fail' },
      { name: 'lint', state: 'pending' },
      { name: 'desktop', state: 'skipped' },
    ]
    const current = entry('s', { pr: { pr, checks } })
    expect(deliveryCheckSummary(current)).toEqual({
      text: '1 项检查失败',
      segments: { passed: 1, failed: 1, total: 4 },
    })
    expect(deliveryCheckSummary({ ...current, state: undefined })).toEqual({ text: '1 项检查失败' })
    expect(deliveryCheckSummary({ ...current, state: { ...current.state!, head: 'new-head' } })).toEqual({ text: '检查对应旧提交' })
    expect(deliveryCheckSummary({ ...current, pr: { pr: { ...pr, headSha: undefined }, checks } })).toEqual({ text: '1 项检查失败' })
    expect(deliveryCheckSummary({ ...current, pr: { pr: { ...pr, draft: true }, checks } })).toEqual({ text: '草稿 PR' })
    expect(deliveryCheckSummary({ ...current, pr: { pr, checks: [] } })).toEqual({ text: '没有检查结果' })
    const problem = { code: 'gh-unreachable', message: '暂时无法读取 PR' }
    expect(deliveryCheckSummary({ ...current, error: problem })).toEqual({ text: '1 项检查失败' })
    expect(deliveryCheckSummary({ ...current, prError: problem })).toEqual({ text: problem.message })
  })

  it('keeps a bound PR read error distinct from an absent PR', () => {
    expect(deliveryChecks(entry('none'))).toBeUndefined()
    expect(deliveryChecks(entry('failed', { prError: { code: 'gh-unreachable', message: '暂时无法读取 PR' } }))).toBe('暂时无法读取 PR')
  })
})
