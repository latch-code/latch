import { describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, RunLive, TaskSummary, WorkspaceInfo } from '@latch/protocol'
import {
  emptySeen,
  filterSessions,
  groupSessions,
  isOneLine,
  projectOf,
  readFolded,
  recentProjectSessions,
  isUnread,
  markSeen,
  markUnread,
  pruneSeen,
  rowMeta,
  rowStatus,
  runningWords,
  silentWords,
  waitingCount,
  waitsOnYou,
  listedSessions,
  steppedSession,
  type SessionFilter,
  writeFolded,
} from '../src/sessions.ts'
import { steadyHold } from '../src/hooks/useSteady.ts'

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

  it('groups by project with pinned sessions leading their shelf, each group newest first and the groups by their latest session', () => {
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
      ['project:website', 'website', ['pinned-old', 'site'], 'website'],
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
  it('hides archived sessions except under their own filter and searches titles', () => {
    const tasks = [
      task('chat', at(23), { mode: 'chat', title: '整理周报' }),
      task('agent', at(23), { mode: 'agent', title: '修复构建' }),
      task('legacy', at(23), { title: '历史任务' }),
      task('archived', at(23), { archived: true, mode: 'chat', title: '旧周报' }),
    ]
    expect(filterSessions(tasks, 'all', '').map(item => item.id)).toEqual(['chat', 'agent', 'legacy'])
    expect(filterSessions(tasks, 'archived', '').map(item => item.id)).toEqual(['archived'])
    expect(filterSessions(tasks, 'all', ' 周报 ').map(item => item.id)).toEqual(['chat'])
    expect(filterSessions(tasks, 'archived', '周报').map(item => item.id)).toEqual(['archived'])
  })
})

describe('session row status', () => {
  const live = (over: Partial<RunLive> = {}): RunLive => ({
    runId: 'r',
    activity: 'model',
    since: at(23).toISOString(),
    lastEventAt: at(23).toISOString(),
    ...over,
  })
  const of = (over: Partial<TaskSummary>, options?: Parameters<typeof rowStatus>[1]) => rowStatus(task('a', at(23), over), options)

  it('says what the Host says, by priority', () => {
    expect(of({ status: 'waiting-approval' }, { unread: true })).toEqual({ kind: 'waiting' })
    expect(of({ status: 'running', live: live() })).toEqual({ kind: 'running' })
    expect(of({ status: 'running' })).toEqual({ kind: 'running' })
    expect(of({ status: 'failed' }, { unread: true })).toEqual({ kind: 'failed' })
    expect(of({ status: 'idle' }, { unread: true })).toEqual({ kind: 'unread' })
    expect(of({ status: 'idle' })).toEqual({ kind: 'read' })
    expect(of({ status: 'idle', runOutcome: 'failed' })).toEqual({ kind: 'failed' })
  })

  it('calls a run silent only when the Host does, never from elapsed time alone', () => {
    const old = live({ lastEventAt: at(10).toISOString() })
    expect(of({ status: 'running', live: old })).toEqual({ kind: 'running' })
    expect(of({ status: 'running', live: { ...old, silent: true } })).toEqual({ kind: 'silent' })
  })

  it('waits on the person after a request Latch did not recognise, until the engine goes on', () => {
    const unrecognized = { count: 1, at: at(10).toISOString() }
    const stuck = live({ lastEventAt: at(10).toISOString(), unrecognized })
    const wentOn = live({ lastEventAt: at(11).toISOString(), unrecognized })
    expect(of({ status: 'running', live: stuck })).toEqual({ kind: 'waiting' })
    expect(waitsOnYou(task('a', at(21), { status: 'running', live: stuck }))).toBe(true)
    expect(of({ status: 'running', live: wentOn })).toEqual({ kind: 'running' })
    expect(waitsOnYou(task('a', at(21), { status: 'running', live: wentOn }))).toBe(false)
    // It went on and then went quiet: that is the silence, not the request.
    expect(of({ status: 'running', live: { ...wentOn, silent: true } })).toEqual({ kind: 'silent' })
  })

  it('waits on the person while a question is open, ahead of silence and behind a stop', () => {
    const quiet = live({ silent: true })
    expect(of({ status: 'running', live: quiet, pendingQuestions: 1 })).toEqual({ kind: 'waiting' })
    expect(waitsOnYou(task('a', at(21), { status: 'running', pendingQuestions: 2 }))).toBe(true)
    expect(of({ status: 'running', pendingQuestions: 0 })).toEqual({ kind: 'running' })
    expect(waitsOnYou(task('a', at(21), { status: 'running', pendingQuestions: 0 }))).toBe(false)
    const stopping = { status: 'running', pendingQuestions: 1, live: live({ activity: 'cancelling' }) } as const
    expect(of(stopping)).toEqual({ kind: 'stopping' })
    expect(waitsOnYou(task('a', at(21), stopping))).toBe(false)
  })

  it('says 正在停止 until the run settles and 已停止 only after', () => {
    expect(of({ status: 'running', live: live() }, { stopping: true })).toEqual({ kind: 'stopping' })
    expect(of({ status: 'waiting-approval' }, { stopping: true })).toEqual({ kind: 'stopping' })
    expect(of({ status: 'running', live: live({ activity: 'cancelling' }) })).toEqual({ kind: 'stopping' })
    // A stop already settled is over, whatever this page still remembers of it.
    expect(of({ status: 'cancelled' }, { stopping: true })).toEqual({ kind: 'ended', word: '已停止', unknown: 0 })
    expect(of({ status: 'idle', runOutcome: 'cancelled' })).toEqual({ kind: 'ended', word: '已停止', unknown: 0 })
    expect(of({ status: 'interrupted' })).toEqual({ kind: 'ended', word: '已中断', unknown: 0 })
    expect(of({ status: 'interrupted', runEnd: { reason: 'forced-stop', at: at(23).toISOString(), unknownResultCount: 2 } })).toEqual({
      kind: 'ended',
      word: '已强制停止',
      unknown: 2,
    })
  })

  it('draws nothing live while the connection is down, and keeps what has already ended', () => {
    expect(of({ status: 'running', live: live() }, { frozen: true })).toEqual({ kind: 'frozen' })
    expect(of({ status: 'waiting-approval' }, { frozen: true })).toEqual({ kind: 'frozen' })
    expect(of({ status: 'failed' }, { frozen: true })).toEqual({ kind: 'failed' })
    expect(of({ status: 'idle' }, { frozen: true, unread: true })).toEqual({ kind: 'unread' })
  })

  it('leaves the time alone on a session whose permission mode changed; the session itself says so', () => {
    expect(of({ status: 'idle', permissionDrift: true })).toEqual({ kind: 'read' })
  })

  it('keeps a read session to one line and gives attention a second', () => {
    expect(isOneLine({ kind: 'read' })).toBe(true)
    expect(isOneLine({ kind: 'ended', word: '已停止', unknown: 0 })).toBe(true)
    expect(isOneLine({ kind: 'ended', word: '已强制停止', unknown: 2 })).toBe(false)
    for (const kind of ['waiting', 'silent', 'stopping', 'running', 'failed', 'unread', 'frozen'] as const)
      expect(isOneLine({ kind })).toBe(false)
  })

  it('reads the whole run on the Host clock, without the time spent waiting on a person', () => {
    const start = at(23).getTime()
    const started = { runStartedAt: new Date(start).toISOString() }
    expect(runningWords(live(), start + 5000)).toBe('运行中')
    expect(runningWords(live(started), start + 72_000)).toBe('运行中 1:12')
    expect(runningWords(live({ ...started, runWaitMs: 60_000 }), start + 72_000)).toBe('运行中 0:12')
    expect(runningWords(live({ ...started, runWaitingSince: new Date(start + 10_000).toISOString() }), start + 72_000)).toBe('运行中 0:10')
    // A phone's clock behind the Host's never shows a negative time.
    expect(runningWords(live(started), start - 5000)).toBe('运行中 0:00')
  })

  it('counts silence from the last sign of life', () => {
    const last = at(23).getTime()
    const quiet = live({ lastEventAt: new Date(last).toISOString() })
    expect(silentWords(quiet, last + 3 * 60_000 + 30_000)).toBe('没有动静 3 分钟')
    expect(silentWords(quiet, last + 90 * 60_000)).toBe('没有动静 1 小时')
    expect(silentWords(undefined, last)).toBe('没有动静')
  })

  it('names the project in 等你处理, the branch elsewhere, and results nobody can vouch for first', () => {
    const summary = task('a', at(23), { branch: 'main' })
    expect(rowMeta(summary, { kind: 'running' }, undefined)).toBe('main')
    expect(rowMeta(summary, { kind: 'waiting' }, 'latch')).toBe('latch')
    expect(rowMeta(summary, { kind: 'ended', word: '已强制停止', unknown: 2 }, undefined)).toBe('2 条结果未知')
    const died = task('a', at(23), {
      status: 'failed',
      branch: 'main',
      runEnd: { reason: 'process-exited', at: at(23).toISOString(), unknownResultCount: 1 },
    })
    expect(rowMeta(died, { kind: 'failed' }, undefined)).toBe('1 条结果未知')
    expect(rowMeta(task('a', at(23)), { kind: 'running' }, undefined)).toBeUndefined()
  })
})

describe('等你处理', () => {
  const quiet: RunLive = { runId: 'r', activity: 'model', since: at(20).toISOString(), lastEventAt: at(20).toISOString(), silent: true }
  it('gathers what waits on the person ahead of the projects, and leaves it there when nothing else asks', () => {
    const tasks = [
      task('approval', at(21), { status: 'waiting-approval' }),
      task('silent', at(22), { status: 'running', live: quiet }),
      task('running', at(23), { status: 'running' }),
      task('done', at(19), {}),
    ]
    const groups = groupSessions(tasks, [], { waitingFrom: tasks })
    expect(groups.map(group => [group.id, group.tasks.map(item => item.id)])).toEqual([
      ['waiting', ['silent', 'approval']],
      ['other', ['running', 'done']],
    ])
    // A search shows every match where it belongs.
    expect(groupSessions(tasks, []).map(group => group.id)).toEqual(['other'])
  })

  it('keeps an archived session that still waits, since nobody else would show it', () => {
    const archived = task('archived', at(21), { status: 'waiting-approval', archived: true })
    expect(groupSessions(filterSessions([archived], 'all', ''), [], { waitingFrom: [archived] }).map(group => group.id)).toEqual([
      'waiting',
    ])
  })

  it('counts sessions, not requests, and only what waits', () => {
    const approval = (sessionId: string) => ({ sessionId }) as AppSnapshot['approvals'][number]
    const tasks = [
      task('a', at(21), { status: 'waiting-approval' }),
      task('b', at(21), { status: 'running', live: quiet }),
      task('c', at(21), { status: 'running' }),
      task('d', at(21), { status: 'idle' }),
      task('e', at(21), { status: 'running', pendingQuestions: 2 }),
    ]
    expect(waitingCount({ tasks, approvals: [approval('a'), approval('a')] })).toBe(3)
    expect(waitingCount({ tasks: [], approvals: [approval('outside')] })).toBe(1)
    expect(waitingCount({ tasks: tasks.slice(2, 4), approvals: [] })).toBe(0)
    // A stop already asked for answers it: the row says 正在停止 and has left the shelf.
    const stopping = task('s', at(21), { status: 'waiting-approval', live: { ...quiet, activity: 'cancelling' } })
    expect(waitsOnYou(stopping)).toBe(false)
    expect(waitingCount({ tasks: [stopping], approvals: [approval('s')] })).toBe(0)
  })
})

describe('stepping through the list', () => {
  const workspaces = [{ id: 'site', name: 'site', path: '/code/site' }]
  const site = task('site', at(23), { cwd: '/code/site' })
  const chat = task('chat', at(22))
  const asks = task('asks', at(20), { status: 'waiting-approval', cwd: '/code/site' })
  const asksArchived = task('asks-archived', at(19), { status: 'waiting-approval', archived: true })
  const tasks = [site, chat, asks, asksArchived]
  const ids = (folded: string[] = [], filter: SessionFilter = 'all', search = '') =>
    listedSessions(tasks, workspaces, { filter, search, folded: new Set(folded) }).map(item => item.id)

  it('follows the rows as drawn: 等你处理 first, including an archived session that waits', () => {
    expect(ids()).toEqual(['asks', 'asks-archived', 'site', 'chat'])
  })

  it('skips folded shelves', () => {
    expect(ids(['waiting'])).toEqual(['site', 'chat'])
    expect(ids(['project:site'])).toEqual(['asks', 'asks-archived', 'chat'])
  })

  it('keeps sessions in place under the archive and a search, where nothing moves to 等你处理', () => {
    expect(ids([], 'archived')).toEqual(['asks-archived'])
    expect(ids([], 'all', 'site')).toEqual(['site'])
  })

  it('wraps, and enters from the matching end when the open session is not listed', () => {
    const rows = [site, chat]
    expect(steppedSession(rows, 'chat', 1)?.id).toBe('site')
    expect(steppedSession(rows, 'site', -1)?.id).toBe('chat')
    expect(steppedSession(rows, 'gone', 1)?.id).toBe('site')
    expect(steppedSession(rows, null, -1)?.id).toBe('chat')
    expect(steppedSession([], 'gone', 1)).toBeUndefined()
  })
})

describe('folded shelves', () => {
  it('reads back what was stored and ignores what it cannot read', () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    })
    try {
      expect([...readFolded('latch.test.folded')]).toEqual([])
      writeFolded('latch.test.folded', new Set(['project:a']))
      expect([...readFolded('latch.test.folded')]).toEqual(['project:a'])
      stored.set('latch.test.folded', '{not json')
      expect([...readFolded('latch.test.folded')]).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
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

describe('status changes at most once a second', () => {
  it('holds what is shown only while the last change is under the gap old', () => {
    expect(steadyHold(0, 5000, 1000)).toBe(0)
    expect(steadyHold(5000, 5000, 1000)).toBe(1000)
    expect(steadyHold(5000, 5600, 1000)).toBe(400)
    expect(steadyHold(5000, 6000, 1000)).toBe(0)
  })
})
