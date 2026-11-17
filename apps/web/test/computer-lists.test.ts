import { describe, expect, it } from 'vitest'
import type { ComputerSession, ComputerSummary } from '@latch/protocol'
import { otherComputerLists, startComputers } from '../src/core/computers.ts'

const A = 'a'.repeat(52),
  B = 'b'.repeat(52),
  C = 'c'.repeat(52)
const session = (taskId: string, at: number, project?: string): ComputerSession => ({
  taskId,
  title: taskId,
  status: 'idle',
  updatedAt: new Date(Date.UTC(2026, 10, 17, 8, at)).toISOString(),
  ...(project ? { project: { id: project, name: `项目 ${project}` } } : {}),
})
const here: ComputerSummary = { hostId: A, name: 'studio', local: true, state: 'online' }

describe('the unified list across computers', () => {
  it('groups each other computer’s sessions by project, newest first, 无项目 last, and never lists this page’s own Host', () => {
    const view = {
      computers: [
        here,
        {
          hostId: B,
          name: 'build-mini',
          local: false,
          state: 'online' as const,
          sessions: [session('old', 1, 'web'), session('loose', 9), session('new', 5, 'api'), session('newer', 7, 'web')],
        },
      ],
    }
    const lists = otherComputerLists(view, A)
    expect(lists).toHaveLength(1)
    expect(lists[0]).toMatchObject({ hostId: B, name: 'build-mini', live: true, count: 4, stateText: '在线', capped: false })
    const many = Array.from({ length: 60 }, (_, index) => session(`s${index}`, index % 50))
    expect(
      otherComputerLists({ computers: [here, { hostId: B, name: 'b', local: false, state: 'online', sessions: many }] }, A)[0]!.capped,
    ).toBe(true)
    expect(lists[0]!.projects.map(project => [project.name, project.sessions.map(item => item.taskId)])).toEqual([
      ['项目 web', ['newer', 'old']],
      ['项目 api', ['new']],
      ['无项目', ['loose']],
    ])
    // Two computers with a project of the same ID stay apart: each is grouped inside its own computer.
    const two = otherComputerLists(
      { computers: [...view.computers, { hostId: C, name: 'other', local: false, state: 'online', sessions: [session('x', 1, 'web')] }] },
      A,
    )
    expect(two.map(list => [list.hostId, list.projects.flatMap(project => project.sessions.map(item => item.taskId))])).toEqual([
      [B, ['newer', 'old', 'new', 'loose']],
      [C, ['x']],
    ])
    // Another computer's own window is that computer: it is never listed as "other" there (and gets no sessions anyway).
    expect(otherComputerLists(view, B)).toEqual([])
  })

  it('marks a computer that does not answer as not live, with its state, and keeps its last rows', () => {
    const lists = otherComputerLists(
      {
        computers: [
          here,
          {
            hostId: B,
            name: 'build-mini',
            local: false,
            state: 'offline',
            lastSeenAt: '2026-11-17T08:42:00Z',
            sessions: [session('s', 1)],
          },
          { hostId: C, name: 'never-read', local: false, state: 'connecting' },
        ],
      },
      A,
    )
    expect(lists[0]).toMatchObject({ live: false, count: 1 })
    expect(lists[0]!.stateText).toMatch(/^离线 · 上次在线 \d{2}:\d{2}$/u)
    expect(lists[1]).toMatchObject({ live: false, count: 0, projects: [] })
  })

  it('offers the computer choice only while more than one computer answers', () => {
    expect(startComputers(undefined)).toEqual([])
    expect(startComputers({ computers: [here] })).toEqual([])
    // Shown only while another computer answers; one that does not stays listed, not choosable.
    expect(startComputers({ computers: [here, { hostId: B, name: 'b', local: false, state: 'offline' }] })).toEqual([])
    expect(
      startComputers({
        computers: [
          here,
          { hostId: B, name: 'b', local: false, state: 'online' },
          { hostId: C, name: 'c', local: false, state: 'revoked' },
        ],
      }),
    ).toHaveLength(3)
  })
})
