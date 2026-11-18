import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readPending, submissionRequest, writePending } from '../src/core/api.ts'
import { boardCounts } from '../src/sessions.ts'
import { useItemWrites, type ItemWrites } from '../src/board/itemWrites.ts'
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

  it('keeps a 新建 start on the board across a reload, without sending that choice', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key),
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    const input = { prompt: 'echo 新建', requestId: 'board-start', harnessId: 'fake', stay: true as const }
    writePending('pending', input)
    expect(readPending('pending')).toEqual(input)
    expect(submissionRequest(readPending('pending')!).body).not.toHaveProperty('stay')
    // Only a new session stays on the board, and only as `true`.
    values.set('pending', JSON.stringify({ ...input, sessionId: 'tsk_1' }))
    expect(readPending('pending')).toBeNull()
    values.set('pending', JSON.stringify({ ...input, stay: 'yes' }))
    expect(readPending('pending')).toBeNull()
  })

  it('titles a kept 待办 by the session-title rule, cut to 120 characters', () => {
    expect(itemTitle('> 引用\n修好登录\n第二行')).toBe('修好登录 第二行')
    expect(Array.from(itemTitle('长'.repeat(200))).length).toBe(120)
  })

  it('keeps the same start request when a card or row menu tries to change or delete the item', async () => {
    const fetcher = vi.fn<typeof fetch>()
    fetcher.mockRejectedValueOnce(new TypeError('No response')).mockRejectedValueOnce(new TypeError('No response'))
    fetcher.mockResolvedValueOnce(Response.json({}))
    vi.stubGlobal('fetch', fetcher)
    let writes: ItemWrites | undefined
    function BoardWrites() {
      writes = useItemWrites(async () => {})
      return null
    }
    renderToStaticMarkup(createElement(BoardWrites))
    const board = writes!
    const item = { id: ITEM, revision: 3 }
    expect(await board.start(item)).toMatchObject({ ok: false, unknown: true })
    expect(await board.patch(item, { priority: 'high' })).toMatchObject({ ok: false, blocked: true })
    expect(await board.remove(item)).toMatchObject({ ok: false, blocked: true })
    expect(fetcher).toHaveBeenCalledTimes(1)

    expect(await board.retry(ITEM)).toMatchObject({ ok: false, unknown: true })
    const calls = fetcher.mock.calls
    const original = calls[0]!
    expect(JSON.parse(original[1]!.body as string)).toMatchObject({ requestId: expect.any(String), baseRevision: 3 })
    expect(calls[1]?.[0]).toBe(original[0])
    expect(calls[1]?.[1]?.body).toBe(original[1]?.body)

    board.dismiss(ITEM)
    expect(await board.patch(item, { note: '跟进' })).toEqual({ ok: true })
    expect(calls[2]?.[1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ baseRevision: 3, note: '跟进' }) })
    expect(await board.retry(ITEM)).toEqual({ ok: false })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('notes only starts that the Host marked as outside, including after retry', async () => {
    const fetcher = vi.fn<typeof fetch>()
    fetcher
      .mockResolvedValueOnce(Response.json({ sessionId: 'joined' }, { status: 201 }))
      .mockRejectedValueOnce(new TypeError('No response'))
      .mockResolvedValueOnce(Response.json({ sessionId: 'outside', outside: 'item-full' }, { status: 201 }))
    vi.stubGlobal('fetch', fetcher)
    const startedOutside = vi.fn()
    let writes: ItemWrites | undefined
    function BoardWrites() {
      writes = useItemWrites(async () => {}, startedOutside)
      return null
    }
    renderToStaticMarkup(createElement(BoardWrites))
    const board = writes!
    const item = { id: ITEM, revision: 3 }
    expect(await board.start(item)).toEqual({ ok: true, sessionId: 'joined' })
    expect(await board.start(item)).toMatchObject({ ok: false, unknown: true })
    expect(startedOutside).not.toHaveBeenCalled()
    expect(await board.retry(ITEM)).toEqual({ ok: true, sessionId: 'outside' })
    expect(startedOutside).toHaveBeenCalledExactlyOnceWith(ITEM, 'outside')
    expect(fetcher.mock.calls[2]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body)
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
