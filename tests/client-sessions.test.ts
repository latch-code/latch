import { describe, expect, it } from 'vitest'
import { emptySeen, filterSessions, groupSessions, isUnread, markSeen, pruneSeen } from '../src/client/sessions.ts'
import type { TaskSummary } from '../src/shared/types.ts'

const now = new Date(2026, 9, 23, 15, 0)
function task(id: string, updatedAt: Date, extra: Partial<TaskSummary> = {}): TaskSummary {
  return { id, title: `会话 ${id}`, status: 'idle', updatedAt: updatedAt.toISOString(), ...extra }
}
const at = (day: number, hour = 12) => new Date(2026, 9, day, hour)

describe('session list', () => {
  it('groups by local day with pinned sessions first, newest first in each group', () => {
    const groups = groupSessions([
      task('old', at(1)), task('week', at(18)), task('yesterday', at(22, 23)), task('morning', at(23, 1)),
      task('afternoon', at(23, 14)), task('pinned-old', at(2), { pinned: true }),
    ], now)
    expect(groups.map(group => [group.label, group.tasks.map(item => item.id)])).toEqual([
      ['置顶', ['pinned-old']],
      ['今天', ['afternoon', 'morning']],
      ['昨天', ['yesterday']],
      ['过去 7 天', ['week']],
      ['更早', ['old']],
    ])
  })

  it('omits empty groups', () => {
    expect(groupSessions([task('a', at(23))], now).map(group => group.id)).toEqual(['today'])
    expect(groupSessions([], now)).toEqual([])
  })

  it('hides archived sessions except under their own filter and filters by mode and title', () => {
    const tasks = [
      task('chat', at(23), { mode: 'chat', title: '整理周报' }),
      task('agent', at(23), { mode: 'agent', title: '修复构建' }),
      task('legacy', at(23), { title: '历史任务' }),
      task('archived', at(23), { archived: true, mode: 'chat', title: '旧周报' }),
    ]
    expect(filterSessions(tasks, 'all', '').map(item => item.id)).toEqual(['chat', 'agent', 'legacy'])
    expect(filterSessions(tasks, 'agent', '').map(item => item.id)).toEqual(['agent', 'legacy'])
    expect(filterSessions(tasks, 'chat', '').map(item => item.id)).toEqual(['chat'])
    expect(filterSessions(tasks, 'archived', '').map(item => item.id)).toEqual(['archived'])
    expect(filterSessions(tasks, 'all', ' 周报 ').map(item => item.id)).toEqual(['chat'])
    expect(filterSessions(tasks, 'archived', '周报').map(item => item.id)).toEqual(['archived'])
  })
})

describe('per-device unread markers', () => {
  it('treats history before the first visit as read, and later updates as unread until opened', () => {
    let seen = emptySeen(at(23, 10))
    const before = task('a', at(23, 9))
    const after = task('b', at(23, 11))
    expect(isUnread(before, seen)).toBe(false)
    expect(isUnread(after, seen)).toBe(true)
    seen = markSeen(seen, 'b', after.updatedAt)
    expect(isUnread(after, seen)).toBe(false)
    expect(isUnread({ ...after, updatedAt: at(23, 12).toISOString() }, seen)).toBe(true)
  })

  it('never moves a marker backwards and returns the same state when nothing changes', () => {
    const seen = markSeen(emptySeen(at(1)), 'a', at(23, 12).toISOString())
    expect(markSeen(seen, 'a', at(23, 11).toISOString())).toBe(seen)
    expect(markSeen(seen, 'a', at(23, 12).toISOString())).toBe(seen)
  })

  it('prunes markers of sessions the Host no longer lists', () => {
    const seen = markSeen(markSeen(emptySeen(at(1)), 'a', at(2).toISOString()), 'gone', at(2).toISOString())
    expect(Object.keys(pruneSeen(seen, [task('a', at(2))]).seen)).toEqual(['a'])
    const kept = pruneSeen(seen, [task('a', at(2)), task('gone', at(2))])
    expect(kept).toBe(seen)
  })
})
