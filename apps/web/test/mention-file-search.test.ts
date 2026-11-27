// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { FileContext } from '@latch/protocol'
import { api, ApiError } from '../src/core/api.ts'
import { useMentionFileSearch } from '../src/hooks/useMentionFileSearch.ts'

vi.mock(import('../src/core/api.ts'), async original => ({ ...(await original()), api: vi.fn() }))
const search = vi.mocked(api)
const context: FileContext = { kind: 'workspace', workspaceId: 'work', harnessId: 'standard' }
const file = (name: string) => ({ root: 'main', path: name, name })

function picker() {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const root = createRoot(document.createElement('div'))
  let state!: ReturnType<typeof useMentionFileSearch>
  function Probe({ query, scope }: { query: string; scope?: FileContext }) {
    const result = useMentionFileSearch(scope, query)
    useLayoutEffect(() => {
      state = result
    })
    return null
  }
  return {
    state: () => state,
    update: async (query: string, scope?: FileContext) =>
      act(async () => root.render(createElement(Probe, { query, ...(scope && { scope }) }))),
    more: async () => act(async () => state.readMore(state.nextCursor)),
    close: () => act(() => root.unmount()),
  }
}

afterEach(() => {
  search.mockReset()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('opens immediately, appends a page once, and retries without losing loaded files', async () => {
  let fail!: (reason: Error) => void
  const next = new Promise<unknown>((_, reject) => {
    fail = reject
  })
  search.mockResolvedValueOnce({ files: [file('one')], truncated: false, nextCursor: 'more' }).mockReturnValueOnce(next)
  const list = picker()
  try {
    await list.update('', context)
    expect(search).toHaveBeenCalledExactlyOnceWith('workspaces/work/files/search', {
      method: 'POST',
      signal: expect.any(AbortSignal),
      body: { harnessId: 'standard', page: true, q: '', limit: 12 },
    })
    await list.more()
    await list.more()
    expect(search).toHaveBeenCalledTimes(2)
    expect(list.state()).toMatchObject({ loading: true, files: [file('one')] })
    await act(async () => fail(new ApiError(503, 'offline', 'offline')))
    expect(list.state()).toMatchObject({ loading: false, nextCursor: 'more', files: [file('one')] })
    expect(list.state().error).toBeTruthy()
    search.mockResolvedValueOnce({ files: [file('one'), file('two')], truncated: false })
    await list.more()
    expect(list.state().files).toEqual([file('one'), file('two')])
    expect(list.state().nextCursor).toBeUndefined()
  } finally {
    list.close()
  }
})

it('aborts the previous page and discards its late response when the search or project changes', async () => {
  let reply!: (data: unknown) => void
  const old = new Promise<unknown>(resolve => {
    reply = resolve
  })
  search.mockResolvedValueOnce({ files: [file('old')], truncated: false, nextCursor: 'more' }).mockReturnValueOnce(old)
  const list = picker()
  try {
    await list.update('', context)
    await list.more()
    const signal = search.mock.calls[1]![1]!.signal
    await list.update('abc', { kind: 'session', sessionId: 'new' })
    expect(signal?.aborted).toBe(true)
    expect(list.state().files).toEqual([])
    await act(async () => reply({ files: [file('stale')], truncated: false }))
    expect(search).toHaveBeenCalledTimes(2)
    search.mockResolvedValueOnce({ files: [file('new')], truncated: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(list.state().files).toEqual([file('new')])
    expect(search.mock.lastCall?.[0]).toBe('tasks/new/files/search')
    await list.update('')
    expect(list.state().files).toEqual([])
  } finally {
    list.close()
  }
})

it.each(['file-search-expired', 'file-roots-changed', 'file-folder-removed'])(
  'drops the old names on %s and retries from the first page',
  async code => {
    search
      .mockResolvedValueOnce({ files: [file('old')], truncated: true, nextCursor: 'expired' })
      .mockRejectedValueOnce(new ApiError(409, code, code))
      .mockResolvedValueOnce({ files: [file('old')], truncated: false })
    const list = picker()
    try {
      await list.update('', context)
      await list.more()
      expect(list.state().files).toEqual([])
      expect(list.state().nextCursor).toBeUndefined()
      await list.more()
      expect(search.mock.lastCall?.[1]?.body).not.toHaveProperty('cursor')
      expect(list.state().files).toEqual([file('old')])
    } finally {
      list.close()
    }
  },
)
