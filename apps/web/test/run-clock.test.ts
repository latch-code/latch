// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { TaskStatus, TaskSummary } from '@latch/protocol'
import { useRunClock } from '../src/hooks/useRunClock.ts'

it('only starts a fallback clock for an observed run, and idle snapshots need one commit', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ now: 1000 })
  const root = createRoot(document.createElement('div'))
  const commits: Array<number | undefined> = []
  const task = (id: string, status: TaskStatus): TaskSummary => ({ id, title: id, status, harnessId: 'standard', updatedAt: '' })
  function Clock({ tasks, selected }: { tasks: TaskSummary[]; selected: string | null }) {
    const elapsed = useRunClock(tasks, selected)
    useLayoutEffect(() => {
      commits.push(elapsed)
    })
    return null
  }
  const show = async (status: TaskStatus, selected: string | null) => {
    await act(() => root.render(createElement(Clock, { tasks: [task('seen', status), task('already', 'running')], selected })))
  }
  try {
    await show('idle', 'already')
    expect(commits.at(-1)).toBeUndefined()
    commits.length = 0
    await show('idle', 'seen')
    expect(commits).toEqual([undefined])
    await show('running', 'seen')
    await act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(commits.at(-1)).toBe(2000)
    await show('waiting-approval', null)
    expect(commits.at(-1)).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    await act(() => {
      vi.advanceTimersByTime(1000)
    })
    await show('waiting-approval', 'seen')
    expect(commits.at(-1)).toBe(3000)
    await show('idle', 'seen')
    expect(commits.at(-1)).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    await act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
