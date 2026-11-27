// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { ComputerSummary, WorkPostRemote } from '@latch/protocol'
import { RemoteWorkPostStatus } from '../src/board/RemoteWorkPost.tsx'
import type { ShellComputers } from '../src/core/shell.ts'

it('refreshes or retries the original post only on click and opens the completed result without resubmitting it', async () => {
  const computer: ComputerSummary = { hostId: 'linux', name: '工作站', local: false, state: 'online' }
  const remote: WorkPostRemote = {
    customAgentId: 'shortcut',
    hostId: 'linux',
    agentId: 'target',
    status: 'unknown',
    revision: 1,
    mentionId: 'reserved',
  }
  const ok = () => Promise.resolve({ ok: true } as const)
  const bridge: ShellComputers = {
    list: async () => ({ computers: [computer] }),
    subscribe: () => () => {},
    open: ok,
    delegateWorkPost: vi.fn(ok),
    retryWorkPost: vi.fn(async () => ({ ok: false, error: 'retry-expired', message: '' })),
    refreshWorkPost: vi.fn(ok),
    openWorkPost: vi.fn(ok),
  }
  const read = vi.fn(async () => {})
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const render = (changes: Partial<WorkPostRemote>, bound = true) =>
    act(() => {
      root.render(
        createElement(RemoteWorkPostStatus, {
          remote: { ...remote, ...changes },
          itemId: 'item',
          postId: 'post',
          bridge,
          bound,
          computer,
          read,
        }),
      )
    })
  const button = (name: string) => [...container.querySelectorAll('button')].find(row => row.textContent === name)
  try {
    render({})
    expect(bridge.retryWorkPost).not.toHaveBeenCalled()
    await act(async () => button('刷新状态')!.click())
    expect(bridge.refreshWorkPost).toHaveBeenCalledExactlyOnceWith('item', 'post')
    expect(bridge.retryWorkPost).not.toHaveBeenCalled()
    await act(async () => button('重试')!.click())
    expect(bridge.retryWorkPost).toHaveBeenCalledExactlyOnceWith('item', 'post')
    expect(container.textContent).toContain('七天')
    render({}, false)
    expect(button('重试')).toBeUndefined()
    render({ revision: 2, status: 'completed', sessionId: 'session', messageId: 'reply' }, false)
    expect(container.textContent).not.toContain('七天')
    expect(button('重试')).toBeUndefined()
    await act(async () => button('在 工作站 上查看结果')!.click())
    expect(bridge.openWorkPost).toHaveBeenCalledExactlyOnceWith('item', 'post')
    expect(bridge.delegateWorkPost).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(3)
  } finally {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
