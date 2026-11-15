import { describe, expect, it } from 'vitest'
import type { TaskSummary, WorkbenchDeliveryEntry } from '@latch/protocol'
import { deliveryChecks, deliveryCheckSummary, deliverySessions, hasDelivery } from '../src/shell/useWorkbenchEvidence.ts'
import { recentCodeWork, workGroups } from '../src/shell/workOverview.ts'

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

it('offers the latest idle Code sessions once, alongside their real work states', () => {
  const tasks = [
    task('older'),
    task('ready', { updatedAt: '2026-11-13T04:00:00Z' }),
    task('private', { updatedAt: '2026-11-13T02:00:00Z', agentPrivate: true }),
    task('recent', { updatedAt: '2026-11-13T03:00:00Z' }),
    task('legacy', { updatedAt: '2026-11-13T05:00:00Z', personal: { assistantId: 'legacy-agent' } }),
    task('removed', { updatedAt: '2026-11-13T06:00:00Z', worktree: { branch: 'old-branch', removed: true } }),
    task('oldest', { updatedAt: '2026-11-12T23:00:00Z' }),
    task('running', { status: 'running' }),
    task('approval', { status: 'waiting-approval' }),
    task('failed', { status: 'failed' }),
    task('unknown', { runEnd: { reason: 'host-stopped', at: '2026-11-13T01:00:00Z', unknownResultCount: 1 } }),
    task('archive', { archived: true }),
    task('agent', { agent: { customAgentId: 'a' } }),
  ]
  expect(recentCodeWork(tasks, workGroups(tasks, undefined, new Set(['ready']))).map(task => task.id)).toEqual([
    'recent',
    'private',
    'older',
  ])
})

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

  it('keeps the bound PR when another settled session in its working tree is more recent', () => {
    const tasks = [task('bound', { cwd: '/project' }), task('recent', { cwd: '/project', updatedAt: '2026-11-13T02:00:00Z' })]
    const entries = new Map([
      ['bound', entry('bound', { pr: { pr, checks: [] } })],
      ['recent', entry('recent')],
    ])
    expect([...deliverySessions(tasks, entries)]).toEqual(['bound'])
    entries.set('bound', entry('bound', { prError: { code: 'gh-unreachable', message: '暂时无法读取 PR' } }))
    expect([...deliverySessions(tasks, entries)]).toEqual(['bound'])
  })

  it('keeps a bound PR read error distinct from an absent PR', () => {
    expect(deliveryChecks(entry('none'))).toBeUndefined()
    expect(deliveryChecks(entry('failed', { prError: { code: 'gh-unreachable', message: '暂时无法读取 PR' } }))).toBe('暂时无法读取 PR')
  })
})
