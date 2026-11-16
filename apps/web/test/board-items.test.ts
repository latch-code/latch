import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPending, submissionRequest, writePending } from '../src/core/api.ts'
import { boardCounts } from '../src/sessions.ts'
import { itemTitle } from '../src/board/WorkBoardNew.tsx'

const ITEM = 'itm_AAAAAAAAAAAAAAAAAAAAAA'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('starting a 待办 from the board', () => {
  it('sends 开始 to the 待办 with the revision the person saw, and keeps it as sent for a retry', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key),
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    const input = { prompt: 'echo 开始', requestId: 'same-request', harnessId: 'fake', itemId: ITEM, itemRevision: 3 }
    writePending('pending', input)
    expect(readPending('pending')).toEqual(input)
    expect(submissionRequest(readPending('pending')!)).toEqual({
      path: `work/items/${ITEM}/start`,
      body: { prompt: 'echo 开始', requestId: 'same-request', mode: 'agent', harnessId: 'fake', baseRevision: 3 },
    })
    // A start without the revision it was bound to is never sent from storage.
    values.set('pending', JSON.stringify({ ...input, itemRevision: undefined }))
    expect(readPending('pending')).toBeNull()
    values.set('pending', JSON.stringify({ ...input, itemId: 'not-an-item' }))
    expect(readPending('pending')).toBeNull()
    expect(submissionRequest({ prompt: 'x', requestId: 'r' }).path).toBe('tasks')
  })

  it('titles a kept 待办 by the session-title rule, cut to 120 characters', () => {
    expect(itemTitle('> 引用\n修好登录\n第二行')).toBe('修好登录 第二行')
    expect(Array.from(itemTitle('长'.repeat(200))).length).toBe(120)
  })

  it('counts a 待办 once on the start screen, never its sessions', () => {
    const tasks = [
      { id: 'a', board: { group: 'running' as const, card: true as const } },
      { id: 'b', board: { group: 'attention' as const, card: true as const } },
      { id: 'c', board: { group: 'running' as const, card: true as const } },
    ]
    const items = [
      { sessionIds: ['a', 'b'], board: { group: 'attention' as const } },
      { sessionIds: [], board: { group: 'todo' as const } },
    ]
    expect(boardCounts(tasks, items)).toEqual({ attention: 1, running: 1, deliver: 0, done: 0 })
  })
})
