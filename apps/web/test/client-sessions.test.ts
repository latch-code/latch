import { describe, expect, it } from 'vitest'
import type { TaskSummary, WorkspaceInfo } from '@latch/protocol'
import {
  emptySeen,
  filterSessions,
  groupSessions,
  projectOf,
  recentProjectSessions,
  isUnread,
  markSeen,
  markUnread,
  pruneSeen,
  sessionFact,
  sessionSlot,
} from '../src/sessions.ts'

function task(id: string, updatedAt: Date, extra: Partial<TaskSummary> = {}): TaskSummary {
  return { id, title: `会话 ${id}`, status: 'idle', updatedAt: updatedAt.toISOString(), ...extra }
}
const at = (day: number, hour = 12) => new Date(2026, 9, day, hour)

describe('session list', () => {
  const workspaces: WorkspaceInfo[] = [
    { id: 'default', name: '默认工作区', path: '/Users/me/code/latch-app' },
    { id: 'website', name: 'website', path: '/Users/me/code/website/' },
    { id: 'docs', name: '文档', path: '/Users/me/code/latch-app/docs' },
  ]

  it('groups by project with pinned sessions first, each group newest first and the groups by their latest session', () => {
    const groups = groupSessions(
      [
        task('app-old', at(1), { cwd: '/Users/me/code/latch-app' }),
        task('site', at(22), { cwd: '/Users/me/code/website' }),
        task('app-new', at(23, 14), { cwd: '/Users/me/code/latch-app/src' }),
        task('docs', at(18), { cwd: '/Users/me/code/latch-app/docs/guide' }),
        task('elsewhere', at(23, 9), { cwd: '/tmp/scratch' }),
        task('history', at(20)),
        task('pinned-old', at(2), { pinned: true, cwd: '/Users/me/code/website' }),
      ],
      workspaces,
    )
    expect(groups.map(group => [group.id, group.label, group.tasks.map(item => item.id), group.workspaceId])).toEqual([
      ['pinned', '置顶', ['pinned-old'], undefined],
      ['project:website', 'website', ['site'], 'website'],
      // The deepest saved project holds the session.
      ['project:docs', '文档', ['docs'], 'docs'],
      ['other', '对话', ['app-new', 'elsewhere', 'history', 'app-old'], undefined],
    ])
  })

  it('omits empty groups, offers no new session in a project the Host disabled, and groups by directory on a Host without projects', () => {
    expect(groupSessions([task('a', at(23), { cwd: '/Users/me/code/website' })], workspaces).map(group => group.id)).toEqual([
      'project:website',
    ])
    expect(groupSessions([], workspaces)).toEqual([])
    const disabled = groupSessions(
      [task('a', at(23), { cwd: '/srv/old' })],
      [{ id: 'old', name: 'old', path: '/srv/old', unavailable: '目录不存在' }],
    )
    expect(disabled.map(group => [group.label, group.workspaceId])).toEqual([['old', undefined]])
    const legacy = groupSessions(
      [task('a', at(23), { cwd: '/srv/app/' }), task('b', at(22)), task('c', at(21), { cwd: '/srv/app' })],
      undefined,
    )
    expect(legacy.map(group => [group.id, group.label, group.tasks.map(item => item.id)])).toEqual([
      ['dir:/srv/app', 'app', ['a', 'c']],
      ['other', '会话', ['b']],
    ])
  })

  it('keeps project identity when folders overlap and distinguishes private sessions from saved projects', () => {
    const projects: WorkspaceInfo[] = [
      ...workspaces,
      {
        id: 'shared',
        name: 'shared',
        path: '/shared',
        folders: [
          { id: 'root', path: '/shared' },
          { id: 'extra', path: '/Users/me/code/website' },
        ],
      },
      { id: 'saved', name: 'saved', path: '/Users/me/code/latch-app/20261025-abcd' },
    ]
    expect(projectOf(task('a', at(23), { workspaceId: 'website', cwd: '/shared' }), projects)?.id).toBe('website')
    expect(projectOf(task('a', at(23), { workspaceId: 'removed', cwd: '/Users/me/code/website' }), projects)).toBeUndefined()
    expect(projectOf(task('a', at(23), { workspaceId: 'default', cwd: '/Users/me/code/latch-app/20261025-abcd' }), projects)?.id).toBe(
      'saved',
    )
    expect(
      projectOf(task('a', at(23), { workspaceId: 'default', cwd: '/Users/me/code/latch-app/20261025-abcd/child' }), projects),
    ).toBeUndefined()
    expect(projectOf(task('a', at(23), { cwd: '/Users/me/code/website/subdir' }), projects)?.id).toBe('website')
    expect(projectOf(task('a', at(23), { workspaceId: 'website', mode: 'chat' }), projects)).toBeUndefined()
    const groups = groupSessions([], projects, { includeEmpty: true })
    expect(groups.map(group => group.project?.id)).toEqual(['website', 'docs', 'shared', 'saved'])
    expect(groups.every(group => group.tasks.length === 0)).toBe(true)
  })

  it('offers only the newest three accessible project sessions using recorded and legacy project membership', () => {
    const tasks = [
      task('old', at(1), { workspaceId: 'website' }),
      task('explicit', at(22), { workspaceId: 'website', cwd: '/unrelated' }),
      task('legacy', at(21), { cwd: '/Users/me/code/website/src' }),
      task('archived', at(23), { workspaceId: 'website', archived: true }),
      task('conversation', at(24), { mode: 'chat', workspaceId: 'website' }),
      task('other-project', at(24), { workspaceId: 'docs', cwd: '/Users/me/code/website' }),
      task('removed-project', at(24), { workspaceId: 'removed', cwd: '/Users/me/code/website' }),
      task('personal', at(24), { workspaceId: 'website', personal: { assistantId: 'assistant' } }),
    ]
    expect(recentProjectSessions('website', tasks, workspaces).map(task => task.id)).toEqual(['archived', 'explicit', 'legacy'])
    // A scope-filtered snapshot is authoritative; the selector never retains previously visible tasks.
    expect(
      recentProjectSessions(
        'website',
        tasks.filter(task => task.id === 'old'),
        workspaces,
      ).map(task => task.id),
    ).toEqual(['old'])
    expect(recentProjectSessions('website', [], workspaces)).toEqual([])
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

const slot = (status: TaskSummary['status'], { selected = false, unread = false, drift = false } = {}) =>
  sessionSlot(task('a', at(23), { status, ...(drift ? { permissionDrift: true as const } : {}) }), selected, unread)

/** The second line's fact of a session with this status, its slot showing what it would show in the list. */
function fact(status: TaskSummary['status'], options: { unread?: boolean; cancelling?: boolean; drift?: boolean } = {}) {
  const summary = task('a', at(20), { status, ...(options.drift ? { permissionDrift: true } : {}) })
  return sessionFact(summary, sessionSlot(summary, false, options.unread ?? false), options.cancelling ?? false, '09:15')
}

describe('session status slot', () => {
  it("shows one thing by priority and leaves the comet out of the open session's row", () => {
    expect(slot('waiting-approval', { selected: true, unread: true })).toBe('waiting')
    expect(slot('failed', { unread: true })).toBe('failed')
    expect(slot('running', { unread: true })).toBe('running')
    expect(slot('running', { selected: true })).toBe('none')
    expect(slot('idle', { unread: true })).toBe('unread')
    expect(slot('cancelled', { unread: true })).toBe('unread')
    // Cancelled and interrupted sessions show their time; the top bar names the state of the open one.
    expect([slot('cancelled'), slot('interrupted'), slot('cancelled', { selected: true })]).toEqual(['time', 'time', 'time'])
    expect([slot('idle'), slot('idle', { selected: true })]).toEqual(['time', 'time'])
  })

  it('draws a session whose permission mode changed in red, above running and unread', () => {
    expect([slot('cancelled', { drift: true }), slot('idle', { drift: true, unread: true, selected: true })]).toEqual(['failed', 'failed'])
    expect(slot('waiting-approval', { drift: true })).toBe('waiting')
  })
  it("adds on a phone's second line only what the slot does not already say, never a preview", () => {
    expect(fact('running')).toBe('正在运行')
    expect(fact('running', { cancelling: true })).toBe('正在取消')
    // The slot shows the waiting pill, the failure or the dot, so the time moves to the second line.
    expect([fact('waiting-approval'), fact('failed'), fact('idle', { unread: true }), fact('cancelled', { drift: true })]).toEqual([
      '09:15',
      '09:15',
      '09:15',
      '09:15',
    ])
    // The slot shows the time, so the second line names a state that is not the default.
    expect([fact('cancelled'), fact('interrupted'), fact('idle')]).toEqual(['已取消', '已中断', undefined])
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

describe('manual unread markers', () => {
  it('keeps manual unread on this device until opened, survives serialization, and prunes deleted sessions', () => {
    const row = task('manual', at(2)),
      empty = emptySeen(at(5))
    const marked = markUnread(empty, row.id)
    expect(isUnread(row, marked)).toBe(true)
    expect(isUnread(row, JSON.parse(JSON.stringify(marked)))).toBe(true)
    expect(isUnread(row, markSeen(marked, row.id, row.updatedAt))).toBe(false)
    expect(pruneSeen(marked, []).unread).toEqual({})
  })
})
