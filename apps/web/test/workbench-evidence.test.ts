import { describe, expect, it } from 'vitest'
import type { TaskSummary, WorkbenchDeliveryEntry } from '@latch/protocol'
import { deliveryChecks, deliverySessions, hasDelivery } from '../src/shell/useWorkbenchEvidence.ts'

const task = (id: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  id,
  title: id,
  harnessId: 'standard',
  status: 'idle',
  updatedAt: '2026-11-13T01:00:00Z',
  ...extra,
})
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

  it('shows a shared working tree once, keeps different or unidentified trees distinct, and excludes hidden sessions', () => {
    const tasks = [
      task('first', { cwd: '/project', updatedAt: '2026-11-13T02:00:00Z' }),
      task('same', { cwd: '/project' }),
      task('other', { cwd: '/worktree' }),
      task('unknown-a'),
      task('unknown-b'),
      task('archive', { archived: true }),
      task('agent', { agent: { customAgentId: 'a' } }),
    ]
    const entries = new Map(tasks.map(task => [task.id, entry(task.id)]))
    expect([...deliverySessions(tasks, entries)]).toEqual(['first', 'other', 'unknown-a', 'unknown-b'])
  })

  it('keeps delivery reachable through a settled session while another session is changing the same working tree', () => {
    const tasks = [
      task('live', { cwd: '/project', status: 'running', updatedAt: '2026-11-13T02:00:00Z' }),
      task('settled', { cwd: '/project' }),
    ]
    expect([...deliverySessions(tasks, new Map(tasks.map(task => [task.id, entry(task.id)])))]).toEqual(['settled'])
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

  it('keeps a bound PR read error distinct from an absent PR', () => {
    expect(deliveryChecks(entry('none'))).toBeUndefined()
    expect(deliveryChecks(entry('failed', { prError: { code: 'gh-unreachable', message: '暂时无法读取 PR' } }))).toBe('暂时无法读取 PR')
  })
})
