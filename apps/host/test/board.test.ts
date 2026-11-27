import { randomUUID } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeBoardTags,
  waitKindOf,
  type Approval,
  type BoardPlace,
  type GitDeliveryState,
  type GitPrState,
  type TaskSummary,
} from '@latch/protocol'
import { AppError, type Bridge, type HarnessDriver } from '@latch/sdk'
import { BoardDelivery, boardPlace, workItemPlace, type BoardFacts, type DeliveryTarget, type WorkItemMember } from '../src/board.ts'
import { HarnessHub, type HarnessMount } from '../src/hub.ts'
import { WorkbenchDeliveryReader } from '../src/workbench-delivery.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const T0 = '2026-11-16T08:00:00.000Z'
const T1 = '2026-11-16T08:00:05.000Z'
const T2 = '2026-11-16T08:00:09.000Z'

function task(status: TaskSummary['status'], extra: Partial<TaskSummary> = {}): TaskSummary {
  return { id: 's-1', title: 't', status, updatedAt: T0, harnessId: 'fake', runId: 'run-1', ...extra }
}
const live = (extra: Partial<NonNullable<TaskSummary['live']>> = {}): NonNullable<TaskSummary['live']> => ({
  runId: 'run-1',
  activity: 'model',
  since: T0,
  lastEventAt: T0,
  ...extra,
})
const none: BoardFacts = { questions: 0, approval: false, delivery: false }
const place = (summary: TaskSummary, facts: Partial<BoardFacts> = {}) => boardPlace(summary, { ...none, ...facts })

describe('the board rule table', () => {
  it('puts each session in the first group whose rule holds, with the reason', () => {
    const cases: Array<[string, TaskSummary, Partial<BoardFacts>, Pick<BoardPlace, 'group' | 'reason'>]> = [
      ['1 an approval', task('waiting-approval', { live: live({ activity: 'approval' }) }), {}, { group: 'attention', reason: 'approval' }],
      ['1 an approval the Host lists', task('running', { live: live() }), { approval: true }, { group: 'attention', reason: 'approval' }],
      ['2 a question', task('running', { live: live() }), { questions: 1 }, { group: 'attention', reason: 'question' }],
      [
        '3 a request Latch did not recognise and nothing since',
        task('running', { live: live({ unrecognized: { count: 1, at: T0 } }) }),
        {},
        { group: 'attention', reason: 'unrecognized' },
      ],
      [
        '5 results nobody can vouch for',
        task('interrupted', { runEnd: { reason: 'forced-stop', at: T1, unknownResultCount: 2 } }),
        {},
        { group: 'attention', reason: 'unknown' },
      ],
      ['6 failed', task('failed'), {}, { group: 'attention', reason: 'failed' }],
      ['6 idle after a failed run', task('idle', { runOutcome: 'failed' }), {}, { group: 'attention', reason: 'failed' }],
      ['7 running', task('running', { live: live() }), {}, { group: 'running' }],
      ['7 running quietly', task('running', { live: live({ silent: true }) }), {}, { group: 'running' }],
      ['7 stopping', task('running', { live: live({ activity: 'cancelling' }) }), { approval: true }, { group: 'running' }],
      ['8 pull request merged', task('idle'), { pr: { state: 'merged' }, delivery: true }, { group: 'done' }],
      ['8 pull request closed', task('idle'), { pr: { state: 'closed' } }, { group: 'done' }],
      ['9 local work', task('idle'), { delivery: true }, { group: 'deliver' }],
      ['9 a bound pull request not read yet', task('idle'), { pr: {} }, { group: 'deliver' }],
      ['9 an open pull request', task('cancelled'), { pr: { state: 'open' } }, { group: 'deliver' }],
      ['10 the rest', task('idle'), {}, { group: 'done' }],
      ['10 cancelled', task('cancelled'), {}, { group: 'done' }],
    ]
    for (const [name, summary, facts, expected] of cases) {
      const found = place(summary, facts)
      expect({ group: found.group, reason: found.reason }, name).toEqual({ group: expected.group, reason: expected.reason })
    }
  })

  it('does not count a stopping run as waiting, even with an approval listed', () => {
    const stopping = task('waiting-approval', { live: live({ activity: 'cancelling' }) })
    expect(place(stopping, { approval: true, questions: 1 }).group).toBe('running')
  })

  it('counts the detail form of unknown results the same as the list outline', () => {
    const detail = task('interrupted', {
      runEnd: { reason: 'host-stopped', at: T1, unknownResults: [{ messageId: 'm-1', name: 'Bash' }] },
    })
    expect(place(detail).reason).toBe('unknown')
  })

  it('leaves attention once a failed run is opened, and takes the next failure back in', () => {
    const failed = task('failed', { runId: 'run-1' })
    expect(place(failed).settle).toBe('run-1')
    expect(place(failed, { attended: { settle: 'run-1', opened: true } }).group).toBe('done')
    // The marker names the run: a new failure comes back.
    expect(place(task('failed', { runId: 'run-2' }), { attended: { settle: 'run-1', opened: true } })).toMatchObject({
      group: 'attention',
      reason: 'failed',
    })
    // Opened, with work in its folder: it moves on to 可交付.
    expect(place(failed, { attended: { settle: 'run-1', opened: true }, delivery: true }).group).toBe('deliver')
  })

  it('leaves attention once unknown results are checked, and still shows a failure not opened', () => {
    const unknown = task('failed', { runEnd: { reason: 'process-exited', at: T1, unknownResultCount: 1 } })
    expect(place(unknown).reason).toBe('unknown')
    expect(place(unknown, { attended: { settle: 'run-1', checked: true } })).toMatchObject({ group: 'attention', reason: 'failed' })
    expect(place(unknown, { attended: { settle: 'run-1', checked: true, opened: true } }).group).toBe('done')
    // Checking an earlier run says nothing about this one.
    expect(place(unknown, { attended: { settle: 'run-0', checked: true } }).reason).toBe('unknown')
  })

  it('names the settlement by the run, else by when it ended, else by the last change', () => {
    expect(place(task('failed')).settle).toBe('run-1')
    expect(place(task('failed', { runId: undefined, runEnd: { reason: 'process-exited', at: T1 } })).settle).toBe(T1)
    expect(place(task('failed', { runId: undefined })).settle).toBe(T0)
  })

  it('makes a card of every session but archived ones, old assistants and 我的 Agent conversations other than scheduled runs', () => {
    expect(place(task('idle')).card).toBe(true)
    expect(place(task('idle', { archived: true })).card).toBeUndefined()
    expect(place(task('idle', { personal: { assistantId: 'a' } })).card).toBeUndefined()
    expect(place(task('idle', { agent: { customAgentId: 'agt_1' } })).card).toBeUndefined()
    expect(place(task('idle', { generalChat: true })).card).toBeUndefined()
    expect(place(task('idle', { agent: { customAgentId: 'agt_1' }, automationId: 'auto-1' })).card).toBe(true)
    expect(place(task('idle', { generalChat: true, automationId: 'auto-1' })).card).toBe(true)
    // An Agent's conversation still has a group: it waits on the person like any other.
    expect(place(task('waiting-approval', { agent: { customAgentId: 'agt_1' }, live: live() }))).toEqual({
      group: 'attention',
      reason: 'approval',
      settle: 'run-1',
    })
  })
})

describe('the 待办 rule table', () => {
  const member = (place: BoardPlace, prMerged = false): WorkItemMember => ({ place, prMerged })
  const open = {}

  it('puts each 待办 in the first group whose rule holds', () => {
    const rows: Array<[string, { closedAt?: string }, number, WorkItemMember[], ReturnType<typeof workItemPlace>]> = [
      ['1 closed', { closedAt: T0 }, 2, [member({ group: 'attention', reason: 'approval' })], { group: 'done' }],
      ['2 no session', open, 0, [], { group: 'todo' }],
      [
        '3 attention, the first reason in rule order',
        open,
        3,
        [
          member({ group: 'running' }),
          member({ group: 'attention', reason: 'failed' }),
          member({ group: 'attention', reason: 'question' }),
        ],
        { group: 'attention', reason: 'question' },
      ],
      ['4 running', open, 2, [member({ group: 'running' }), member({ group: 'deliver' })], { group: 'running' }],
      ['5 deliver', open, 2, [member({ group: 'deliver' }), member({ group: 'done' }, true)], { group: 'deliver' }],
      ['6 every pull request merged', open, 2, [member({ group: 'done' }, true), member({ group: 'done' }, true)], { group: 'done' }],
      [
        '7 all ended, not marked done',
        open,
        2,
        [member({ group: 'done' }, true), member({ group: 'done' })],
        { group: 'deliver', reason: 'settled' },
      ],
    ]
    for (const [name, item, count, members, expected] of rows) expect(workItemPlace(item, count, members), name).toEqual(expected)
  })

  it('never puts a 待办 with sessions in 未开始, nor in 已结束 by rule 6 while one of them could not be read', () => {
    // Its Harness is not listing: the session counts for nothing.
    expect(workItemPlace(open, 1, [])).toEqual({ group: 'deliver', reason: 'settled' })
    expect(workItemPlace(open, 2, [member({ group: 'done' }, true)])).toEqual({ group: 'deliver', reason: 'settled' })
    // Archived sessions are read like the rest (their place has no card).
    expect(workItemPlace(open, 1, [member({ group: 'running' })])).toEqual({ group: 'running' })
  })
})

describe('the shared wait vectors', () => {
  it('give the Host the same wait kinds the web and the desktop read', async () => {
    const vectors = JSON.parse(await readFile('packages/testkit/vectors/board-v1.json', 'utf8')) as {
      waits: Array<{ name: string; task: TaskSummary; approval: boolean; wait: string | null }>
    }
    expect(vectors.waits.length).toBeGreaterThan(10)
    for (const vector of vectors.waits)
      expect(waitKindOf(vector.task, { approval: vector.approval }) ?? null, vector.name).toBe(vector.wait)
  })
})

describe('board tags', () => {
  it('trims, folds to NFKC, drops invisible characters and duplicates', () => {
    expect(normalizeBoardTags(['  前端 ', 'ＡＢＣ', 'a​b', '前端'])).toEqual({ tags: ['前端', 'ABC', 'ab'] })
    expect(normalizeBoardTags([])).toEqual({ tags: [] })
  })

  it('refuses control characters, line breaks, empty or long tags, credential shapes and a ninth tag', () => {
    expect(normalizeBoardTags(['a\nb'])).toEqual({ problem: 'tag-invalid' })
    expect(normalizeBoardTags(['a\u0007'])).toEqual({ problem: 'tag-invalid' })
    expect(normalizeBoardTags(['   '])).toEqual({ problem: 'tag-invalid' })
    expect(normalizeBoardTags(['x'.repeat(25)])).toEqual({ problem: 'tag-invalid' })
    expect(normalizeBoardTags(['字'.repeat(24)])).toEqual({ tags: ['字'.repeat(24)] })
    expect(normalizeBoardTags(['AKIAABCDEFGHIJKLMNOP'])).toEqual({ problem: 'tag-secret' })
    expect(normalizeBoardTags(Array.from({ length: 9 }, (_, index) => `t${index}`))).toEqual({ problem: 'tag-limit' })
    expect(normalizeBoardTags(Array.from({ length: 8 }, (_, index) => `t${index}`))).toMatchObject({ tags: expect.any(Array) })
  })
})

function state(files: number, ahead = 0): GitDeliveryState {
  return {
    ahead,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: Array.from({ length: files }, (_, index) => `f${index}.txt`),
    conflicted: [],
    hooks: [],
    filters: false,
  }
}

function delivery(targets: Record<string, DeliveryTarget | undefined>, states: Record<string, GitDeliveryState>) {
  const pr = vi.fn(async (): Promise<GitPrState> => ({ checks: [] }))
  const read = vi.fn(async (folder: string) => {
    const found = states[folder]
    if (!found) throw new AppError(409, 'git-failed', 'no')
    return structuredClone(found)
  })
  const reader = new WorkbenchDeliveryReader({ now: () => Date.parse(T2), state: read, pr })
  const changed = vi.fn()
  const board = new BoardDelivery({ log: vi.fn(), changed, target: async id => targets[id] })
  cleanups.push(() => board.close())
  board.connect(reader)
  return { board, pr, read, changed }
}

describe('the Host reading local Git for 可交付', () => {
  it('reads after a settle with local Git only, and never asks for a pull request', async () => {
    const { board, pr, read, changed } = delivery({ a: { folder: '/w/a', updatedAt: T0, holds: true } }, { '/w/a': state(1) })
    board.settled('a')
    await vi.waitFor(() => expect(board.local('a')).toBe(true))
    expect(read).toHaveBeenCalledWith('/w/a')
    expect(pr).not.toHaveBeenCalled()
    expect(changed).toHaveBeenCalledWith('a')
  })

  it('shows a shared folder’s work on the latest session to change, and tells the one that lost it', async () => {
    const targets: Record<string, DeliveryTarget> = {
      old: { folder: '/w/shared', updatedAt: T0, holds: true },
      new: { folder: '/w/shared', updatedAt: T1, holds: true },
    }
    const { board, changed, read } = delivery(targets, { '/w/shared': state(2) })
    board.settled('old')
    await vi.waitFor(() => expect(board.local('old')).toBe(true))
    board.settled('new')
    await vi.waitFor(() => expect(board.local('new')).toBe(true))
    expect(board.local('old')).toBe(false)
    expect(changed).toHaveBeenCalledWith('old')
    // An older session read again does not take it back.
    board.settled('old')
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(board.local('new')).toBe(true)
    expect(board.local('old')).toBe(false)
  })

  it('keeps a shared folder’s work on the session that wrote it, not on later ones that changed nothing', async () => {
    // The real run: opencode wrote note.txt, then pi failed with a result nobody could vouch for, then codex was cancelled.
    const targets: Record<string, DeliveryTarget> = {
      writer: { folder: '/w/shared', updatedAt: T0, holds: true },
      failed: { folder: '/w/shared', updatedAt: T1, holds: false },
      cancelled: { folder: '/w/shared', updatedAt: T2, holds: false },
    }
    const { board, read } = delivery(targets, { '/w/shared': state(1) })
    for (const id of ['writer', 'failed', 'cancelled']) board.settled(id)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3))
    await new Promise(resolve => setTimeout(resolve, 10))
    const facts = (id: string, attended?: BoardFacts['attended']) => ({
      ...none,
      delivery: board.local(id),
      ...(attended ? { attended } : {}),
    })
    const writer = task('idle', { id: 'writer', runOutcome: 'completed' })
    const failed = task('failed', {
      id: 'failed',
      runId: 'run-pi',
      runOutcome: 'interrupted',
      runEnd: { reason: 'process-exited', at: T1, unknownResultCount: 1 },
    })
    const cancelled = task('cancelled', { id: 'cancelled', runOutcome: 'cancelled' })
    expect(boardPlace(writer, facts('writer')).group).toBe('deliver')
    expect(boardPlace(failed, facts('failed'))).toMatchObject({ group: 'attention', reason: 'unknown' })
    expect(boardPlace(failed, facts('failed', { settle: 'run-pi', opened: true, checked: true })).group).toBe('done')
    expect(boardPlace(cancelled, facts('cancelled')).group).toBe('done')
  })

  it('shows a shared folder’s work on no session when none of them changed files, and lets an undone writer go', async () => {
    const targets: Record<string, DeliveryTarget> = {
      a: { folder: '/w/shared', updatedAt: T0, holds: false },
      b: { folder: '/w/shared', updatedAt: T1, holds: true },
    }
    const { board, read } = delivery(targets, { '/w/shared': state(2) })
    board.settled('a')
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(board.local('a')).toBe(false)
    board.settled('b')
    await vi.waitFor(() => expect(board.local('b')).toBe(true))
    // Its turns were undone: it no longer holds the work, and nobody else takes it.
    targets.b = { folder: '/w/shared', updatedAt: T2, holds: false }
    board.settled('b')
    await vi.waitFor(() => expect(board.local('b')).toBe(false))
    expect(board.local('a')).toBe(false)
  })

  it('never lets a private session in the same folder move a visible one out of 可交付', async () => {
    const targets: Record<string, DeliveryTarget> = {
      visible: { folder: '/w/shared', updatedAt: T0, holds: true },
      private: { folder: '/w/shared', updatedAt: T1, holds: true, private: true },
    }
    const { board, changed } = delivery(targets, { '/w/shared': state(1) })
    board.settled('visible')
    await vi.waitFor(() => expect(board.local('visible')).toBe(true))
    board.settled('private')
    await vi.waitFor(() => expect(board.local('private')).toBe(true))
    expect(board.local('visible')).toBe(true)
    expect(changed).not.toHaveBeenCalledWith('visible', expect.anything())
    expect(changed.mock.calls.filter(([id]) => id === 'visible')).toHaveLength(1)
  })

  it('drops a session that is clean, unreadable or not eligible, and forgets one that is deleted', async () => {
    const { board } = delivery(
      {
        clean: { folder: '/w/clean', updatedAt: T0, holds: true },
        broken: { folder: '/w/broken', updatedAt: T0, holds: true },
        work: { folder: '/w/work', updatedAt: T0, holds: true },
      },
      { '/w/clean': state(0), '/w/work': state(0, 1) },
    )
    for (const id of ['clean', 'broken', 'private', 'work']) board.settled(id)
    await vi.waitFor(() => expect(board.local('work')).toBe(true))
    expect(board.local('clean')).toBe(false)
    expect(board.local('broken')).toBe(false)
    expect(board.local('private')).toBe(false)
    board.forget('work')
    expect(board.local('work')).toBe(false)
  })

  it('reads recent idle sessions at start, one per folder, newest first', async () => {
    const targets: Record<string, DeliveryTarget> = {
      a: { folder: '/w/one', updatedAt: T1, holds: true },
      b: { folder: '/w/one', updatedAt: T0, holds: true },
      c: { folder: '/w/two', updatedAt: T0, holds: true },
      old: { folder: '/w/three', updatedAt: '2026-10-01T00:00:00.000Z', holds: true },
    }
    const { board, read } = delivery(targets, { '/w/one': state(1), '/w/two': state(1), '/w/three': state(1) })
    const tasks = [
      task('idle', { id: 'a', updatedAt: T1 }),
      task('idle', { id: 'b', updatedAt: T0 }),
      task('idle', { id: 'c', updatedAt: T0 }),
      task('running', { id: 'r', updatedAt: T1 }),
      task('idle', { id: 'old', updatedAt: '2026-10-01T00:00:00.000Z' }),
    ]
    await board.warm(tasks, Date.parse(T2))
    await vi.waitFor(() => expect(board.local('c')).toBe(true))
    expect(board.local('a')).toBe(true)
    expect(board.local('b')).toBe(false)
    expect(read.mock.calls.map(([folder]) => folder).toSorted()).toEqual(['/w/one', '/w/two'])
  })

  it('keeps background reads to one at a time and out of the way of two device reads', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const reader = { read: vi.fn(async () => (await gate, { observedAt: T2, entries: [] })) } as unknown as WorkbenchDeliveryReader
    const board = new BoardDelivery({ log: vi.fn(), changed: vi.fn(), target: async () => ({ folder: '/w', updatedAt: T0, holds: true }) })
    cleanups.push(() => board.close())
    const first = board.take()!
    const second = board.take()!
    expect(board.take()).toBeUndefined()
    board.connect(reader)
    board.settled('a')
    board.settled('b')
    await Promise.resolve()
    expect(reader.read).not.toHaveBeenCalled()
    first()
    first()
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledTimes(1))
    second()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(reader.read).toHaveBeenCalledTimes(1)
    // A device still gets its place while a background read runs.
    expect(board.take()).toBeDefined()
    release()
  })

  it('takes a pull request’s state only from what a device or a delivery action read', async () => {
    const { board, changed } = delivery({}, {})
    expect(board.prState('a')).toBeUndefined()
    board.recordPr('a', 'merged')
    expect(board.prState('a')).toBe('merged')
    expect(changed).toHaveBeenCalledWith('a')
    await board.observe({
      sessionId: 'a',
      observedAt: T2,
      pr: {
        pr: { number: 1, url: 'https://github.com/o/r/pull/1', base: 'main', head: 'b', title: 't', state: 'open', draft: false },
        checks: [],
      },
    })
    expect(board.prState('a')).toBe('open')
  })
})

function driver(id: string): HarnessDriver {
  return {
    id,
    name: id,
    version: '1',
    create: () => {
      throw new Error('mounted through HarnessMount.create')
    },
  }
}

describe('every summary the hub hands out carries the board place', () => {
  async function fixture() {
    const dataDir = await mkdtemp(join(tmpdir(), 'latch-board-'))
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
    const tasks: TaskSummary[] = [
      task('failed', {
        id: 'fail-1',
        runEnd: { reason: 'process-exited', at: T1, unknownResults: [{ messageId: 'm', name: 'Bash' }] },
        // A driver's claims of Host metadata are dropped.
        tags: ['driver'],
        priority: 'high',
        board: { group: 'done' },
      }),
      // Fresh, so the Host does not call it silent.
      task('running', { id: 'run-1', live: live({ since: new Date().toISOString(), lastEventAt: new Date().toISOString() }) }),
    ]
    const approvals: Approval[] = []
    const bridge = {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      listTasks: vi.fn(async () => structuredClone(tasks)),
      detail: vi.fn(async (sessionId: string) => {
        const found = tasks.find(item => item.id === sessionId)
        if (!found) throw new AppError(404, 'task-not-found', 'missing')
        return { summary: structuredClone(found), messages: [], approvals: [], liveText: '', cursor: 1 }
      }),
      createTask: vi.fn(async () => ({ sessionId: `created-${randomUUID()}` })),
      prompt: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      approvals: vi.fn(() => structuredClone(approvals)),
      decide: vi.fn(async () => true),
      subscribe: () => () => {},
    } satisfies Bridge
    const board = vi.fn((summary: TaskSummary, record: { attended?: { settle: string; opened?: true; checked?: true }; pr: boolean }) =>
      boardPlace(summary, { ...none, ...(record.attended ? { attended: record.attended } : {}) }),
    )
    const hub = await HarnessHub.open({ dataDir, defaultId: () => 'fake', log: vi.fn(), board })
    cleanups.push(() => hub.close())
    await hub.attach(driver('fake'), { create: () => bridge, release: vi.fn(), kind: 'plugin' } as unknown as HarnessMount)
    return { hub, tasks, board, dataDir }
  }

  it('on the list, one summary, the detail, a meta change and a marker', async () => {
    const { hub } = await fixture()
    const listed = await hub.listTasks()
    expect(listed.map(item => [item.id, item.board?.group, item.board?.reason])).toEqual([
      ['fail-1', 'attention', 'unknown'],
      ['run-1', 'running', undefined],
    ])
    expect(listed[0]).not.toHaveProperty('tags')
    expect(listed[0]).not.toHaveProperty('priority')
    expect((await hub.listTasksProven()).tasks.every(item => item.board)).toBe(true)
    expect((await hub.summary('fail-1')).board).toMatchObject({ group: 'attention', reason: 'unknown', settle: 'run-1' })
    // The detail has the results themselves, not their count: the same group.
    expect((await hub.detail('fail-1')).summary.board).toMatchObject({ group: 'attention', reason: 'unknown' })
    expect((await hub.runSummary('fake', 'fail-1'))?.board?.reason).toBe('unknown')
    expect((await hub.unsandboxedTasks()).every(item => item.board)).toBe(true)
    const patched = await hub.updateMeta('fail-1', { tags: ['前端'], priority: 'low' })
    expect(patched).toMatchObject({ tags: ['前端'], priority: 'low', board: { group: 'attention' } })
    const checked = await hub.attend('fail-1', { settle: 'run-1', checked: true })
    expect(checked.board).toMatchObject({ group: 'attention', reason: 'failed' })
    const opened = await hub.attend('fail-1', { settle: 'run-1', opened: true })
    expect(opened.board?.group).toBe('done')
    expect(hub.attendedOf('fail-1')).toEqual({ settle: 'run-1', opened: true, checked: true })
    // A marker on another settlement replaces the old one.
    await hub.attend('fail-1', { settle: 'run-0', opened: true })
    expect(hub.attendedOf('fail-1')).toEqual({ settle: 'run-0', opened: true })
    const cleared = await hub.updateMeta('fail-1', { tags: null, priority: null })
    expect(cleared).not.toHaveProperty('tags')
    expect(cleared).not.toHaveProperty('priority')
  })

  it('keeps tags, priority and markers across a restart, and an older file without them loads as it is', async () => {
    const { hub, dataDir } = await fixture()
    await hub.updateMeta('fail-1', { tags: ['a', 'b'], priority: 'high' })
    await hub.attend('fail-1', { settle: 'run-1', opened: true })
    await hub.close()
    const file = JSON.parse(await readFile(join(dataDir, 'sessions-meta.json'), 'utf8')) as { sessions: Array<Record<string, unknown>> }
    expect(file.sessions.find(entry => entry.id === 'fail-1')).toMatchObject({
      tags: ['a', 'b'],
      priority: 'high',
      attended: { settle: 'run-1', opened: true },
    })
    const again = await HarnessHub.open({ dataDir, defaultId: () => 'fake', log: vi.fn() })
    cleanups.push(() => again.close())
    expect(again.attendedOf('fail-1')).toEqual({ settle: 'run-1', opened: true })
  })
})
