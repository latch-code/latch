import { describe, expect, it } from 'vitest'
import type { AgentMissedRun } from '@latch/protocol'
import { computerView, notificationsPatch } from '../src/agents/computer.ts'

const now = new Date(2026, 10, 13, 10, 0).getTime()
const local = (hour: number, minute = 0, day = 13) => new Date(2026, 10, day, hour, minute).toISOString()
const missed: AgentMissedRun[] = [
  { automationId: 'auto_a', name: '晨报', at: local(9), cause: 'sleep' },
  { automationId: 'auto_b', name: '周报', at: local(8, 30), cause: 'off' },
  { automationId: 'auto_a', name: '晨报', at: local(9, 0, 12), cause: 'unknown' },
]

describe('「电脑」 of an Agent', () => {
  it('says online only while the Host answers, and kept awake only when the desktop app reported it', () => {
    const base = { missed: [], keepAwakeOn: false, now }
    expect(computerView({ ...base, reachable: true, sleeping: false, computer: { desktop: true } }).status).toEqual({
      label: '在线',
      tone: 'done',
    })
    const awake = computerView({ ...base, reachable: true, sleeping: false, computer: { desktop: true, keepAwake: 'schedule' } })
    expect(awake.status.label).toBe('保持唤醒中')
    expect(awake.awakeFor).toBe('定时任务快到点了')
    expect(computerView({ ...base, reachable: true, sleeping: false, computer: { desktop: true, keepAwake: 'busy' } }).awakeFor).toBe(
      '有会话在运行或等你处理',
    )
    // The Host's own sleep announcement wins over whatever was last read.
    expect(computerView({ ...base, reachable: false, sleeping: true, computer: { desktop: true, keepAwake: 'busy' } }).status).toEqual({
      label: '睡眠中',
      tone: 'neutral',
    })
    expect(computerView({ ...base, reachable: false, sleeping: false, computer: undefined }).status).toEqual({
      label: '不在线',
      tone: 'warn',
    })
    for (const view of [awake, computerView({ ...base, reachable: false, sleeping: true, computer: undefined })])
      expect(JSON.stringify(view)).not.toMatch(/永远|always/u)
  })

  it('says when it last woke, and nothing when no wake was reported', () => {
    const base = { reachable: true, sleeping: false, missed: [], keepAwakeOn: false, now }
    expect(computerView({ ...base, computer: { desktop: true, wokeAt: local(7, 45) } }).woke).toBe('今天 07:45')
    expect(computerView({ ...base, computer: { desktop: false } })).not.toHaveProperty('woke')
  })

  it('groups missed times by schedule with their cause, unknown when no record says, for one 立即运行 each', () => {
    const view = computerView({ reachable: true, sleeping: false, computer: { desktop: true }, missed, keepAwakeOn: false, now })
    expect(view.missedTotal).toBe(3)
    expect(view.missed).toEqual([
      {
        automationId: 'auto_a',
        name: '晨报',
        times: [
          { at: local(9), words: '今天 09:00：Mac 在睡眠' },
          { at: local(9, 0, 12), words: '昨天 09:00：睡眠、关机或 Latch 没有运行' },
        ],
      },
      { automationId: 'auto_b', name: '周报', times: [{ at: local(8, 30), words: '今天 08:30：Mac 关机或 Latch 没有运行' }] },
    ])
  })

  it('says the keep-awake switch has no effect while the desktop app does not run', () => {
    const base = { reachable: true, sleeping: false, missed: [], now }
    expect(computerView({ ...base, keepAwakeOn: true, computer: { desktop: false } }).keepAwakeNote).toBe(
      'Latch 应用没有运行，现在不起作用',
    )
    expect(computerView({ ...base, keepAwakeOn: true, computer: { desktop: true } })).not.toHaveProperty('keepAwakeNote')
    expect(computerView({ ...base, keepAwakeOn: false, computer: { desktop: false } })).not.toHaveProperty('keepAwakeNote')
  })
})

describe('「通知」 of an Agent', () => {
  it('sends one switch at a time and goes back to the default once all are on', () => {
    expect(notificationsPatch(undefined, 'completed', false)).toEqual({ completed: false, failed: true, waiting: true })
    expect(notificationsPatch({ completed: false, failed: true, waiting: true }, 'completed', true)).toBeNull()
    expect(notificationsPatch({ completed: false, failed: false, waiting: true }, 'waiting', false)).toEqual({
      completed: false,
      failed: false,
      waiting: false,
    })
  })
})
