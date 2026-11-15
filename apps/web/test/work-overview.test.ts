import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, RunLive, TaskSummary } from '@latch/protocol'
import { observeHostTime, resetHostClock } from '../src/core/hostClock.ts'
import { WorkOverview } from '../src/shell/WorkOverview.tsx'
import { workGroups, workStatus } from '../src/shell/workOverview.ts'

const task = (id: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  id,
  title: id,
  harnessId: 'standard',
  status: 'idle',
  updatedAt: '2026-11-13T01:00:00Z',
  ...extra,
})
const live: RunLive = {
  runId: 'run',
  activity: 'command',
  since: '2026-11-13T01:00:00Z',
  lastEventAt: '2026-11-13T01:00:00Z',
  runStartedAt: '2026-11-13T01:00:00Z',
}
const now = Date.parse('2026-11-13T01:01:00Z')
const ids = (tasks: TaskSummary[], cancelling?: ReadonlySet<string>) =>
  workGroups(tasks, cancelling).map(group => [group.id, group.tasks.map(item => item.id)])

afterEach(() => {
  resetHostClock()
  vi.useRealTimers()
})

describe('work overview', () => {
  it('renders elapsed work and silence on the Host clock when this device is two hours ahead', () => {
    const deviceNow = now + 2 * 60 * 60_000
    vi.useFakeTimers()
    vi.setSystemTime(deviceNow)
    observeHostTime(new Date(now).toISOString(), deviceNow)
    const snapshot: AppSnapshot = {
      instanceId: 'host',
      device: {
        id: 'd',
        name: 'Phone',
        status: 'active',
        listener: 'loopback-tcp',
        scopes: ['view'],
        dataScope: 'work',
        fingerprint: 'ABCD EFGH IJKL MNOP QRST',
        createdAt: '',
        lastSeenAt: '',
        credentialExpiresAt: '',
        pairedBy: { method: 'lpc' },
        current: true,
        renewAfter: '',
      },
      host: { hostId: 'h', devMode: true, presence: { status: 'available' }, tls: null },
      tasks: [
        task('running', { status: 'running', live }),
        task('silent', { status: 'running', live: { ...live, silent: true } }),
        task('waiting', { status: 'waiting-approval' }),
      ],
      approvals: [],
      demo: false,
      hostName: 'Host',
    }
    const render = (connection: 'connected' | 'offline', cancelling?: ReadonlySet<string>) =>
      renderToStaticMarkup(
        createElement(WorkOverview, {
          snapshot,
          layout: 'overview',
          connection,
          cancelling,
          now: deviceNow,
          onSelect: () => {},
          onNew: () => {},
          onSearch: () => {},
        }),
      )
    expect(render('connected')).toContain('在跑命令 1:00')
    expect(render('connected')).toContain('没有动静 1 分钟')
    expect(render('connected')).not.toContain('没有动静 2 小时')
    expect(render('connected').match(/class="ui-running-edge"/gu)).toHaveLength(1)
    expect(render('connected', new Set(['running']))).not.toContain('class="ui-running-edge"')
    expect(render('offline')).toContain('上次状态：在跑命令')
    expect(render('offline')).not.toContain('在跑命令 1:00')
    expect(render('offline')).not.toContain('class="ui-running-edge"')
  })

  it('shows only unarchived Code sessions, sorted within each group without claiming delivery readiness', () => {
    expect(
      ids([
        task('old'),
        task('new', { updatedAt: '2026-11-13T02:00:00Z', runOutcome: 'completed' }),
        task('archive', { archived: true, status: 'waiting-approval' }),
        task('agent', { agent: { customAgentId: 'a' } }),
        task('general', { generalChat: true }),
      ]),
    ).toEqual([
      ['attention', []],
      ['running', []],
      ['delivery', []],
    ])
    expect(workStatus(task('old'), { connected: true, now }).words).toBe('会话记录')
    expect(workStatus(task('new', { runOutcome: 'completed' }), { connected: true, now }).words).toBe('本轮已结束')
  })

  it('puts questions, silence, failure and unknown results where they can be found, with no duplicated session', () => {
    const tasks = [
      task('approval', { status: 'waiting-approval' }),
      task('question', { status: 'running', pendingQuestions: 2 }),
      task('silent', { status: 'running', live: { ...live, silent: true } }),
      task('failed', { runOutcome: 'failed' }),
      task('unknown', {
        status: 'interrupted',
        runEnd: { reason: 'host-stopped', at: '2026-11-13T01:00:00Z', unknownResultCount: 1 },
      }),
      task('running', { status: 'running', live }),
      task('cancelled', { status: 'cancelled' }),
    ]
    expect(ids(tasks)).toEqual([
      ['attention', ['approval', 'question', 'silent', 'failed', 'unknown']],
      ['running', ['running']],
      ['delivery', []],
    ])
    expect(workStatus(tasks[1], { connected: true, now })).toEqual({ tone: 'waiting', words: '2 个问题' })
    expect(workStatus(tasks[4], { connected: true, now })).toEqual({ tone: 'warn', words: '1 条结果未知' })
  })

  it('keeps a cancellation in progress until Host settlement, including a question it supersedes', () => {
    const pending = task('pending', { status: 'running', pendingQuestions: 1 })
    const stopping = task('stopping', { status: 'waiting-approval', live: { ...live, activity: 'cancelling' } })
    expect(ids([pending, stopping], new Set(['pending']))).toEqual([
      ['attention', []],
      ['running', ['pending', 'stopping']],
      ['delivery', []],
    ])
    expect(workStatus(stopping, { connected: true, now })).toEqual({ tone: 'running', words: '正在停止' })
    expect(workStatus(pending, { connected: true, now, stopping: true }).words).toBe('正在停止')
  })

  it('freezes live wording offline and never turns the passing time into a completion or failure', () => {
    const running = task('running', { status: 'running', live })
    expect(workStatus(running, { connected: true, now })).toEqual({ tone: 'running', words: '在跑命令 1:00' })
    expect(workStatus(running, { connected: false, now })).toEqual({ tone: 'neutral', words: '上次状态：在跑命令' })
    expect(workStatus(running, { connected: false, now: now + 86_400_000 })).toEqual(workStatus(running, { connected: false, now }))
    expect(workStatus(task('ask', { status: 'waiting-approval' }), { connected: false, now })).toEqual({
      tone: 'neutral',
      words: '上次状态：等你处理',
    })
  })
})
