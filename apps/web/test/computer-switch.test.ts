// @vitest-environment happy-dom
import { act, createElement, useEffect, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { AppSnapshot, TaskSummary } from '@latch/protocol'
import { ComputerChip } from '../src/components/Computers.tsx'
import { useOpenedMark } from '../src/core/attend.ts'
import type { ComputerResult, ComputersView, LatchShell } from '../src/core/shell.ts'

const localId = 'a'.repeat(52)
const remoteId = 'b'.repeat(52)
const view: ComputersView = {
  computers: [
    { hostId: localId, name: 'studio', local: true, state: 'online' },
    { hostId: remoteId, name: 'build-mini', local: false, state: 'online' },
  ],
}
const snapshot: AppSnapshot = {
  instanceId: 'instance',
  hostName: 'studio',
  host: { hostId: localId, devMode: true, tls: null, presence: { status: 'available' } },
  device: {
    id: 'desktop',
    name: 'studio',
    status: 'active',
    listener: 'unix',
    scopes: ['view'],
    dataScope: 'work',
    fingerprint: '',
    createdAt: '',
    lastSeenAt: '',
    credentialExpiresAt: '',
    pairedBy: { method: 'lpc' },
    current: true,
    renewAfter: '',
  },
  tasks: [],
  approvals: [],
  demo: false,
}

it('keeps a failed switch open so the same control can retry it', async () => {
  let respond!: (result: ComputerResult) => void
  const reply = new Promise<ComputerResult>(resolve => {
    respond = resolve
  })
  const switchTo = vi.fn<(hostId: string) => Promise<ComputerResult>>().mockReturnValueOnce(reply).mockResolvedValue({ ok: true })
  const open = vi.fn(async () => ({ ok: true }) as const)
  const shell: LatchShell = {
    kind: 'electron',
    devMode: true,
    platform: 'darwin',
    computers: { list: async () => view, subscribe: () => () => {}, open, switchTo },
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.startsWith('(max-width:'),
    addEventListener() {},
    removeEventListener() {},
  }))
  window.latchShell = shell
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    act(() => {
      root.render(
        createElement(ComputerChip, {
          snapshot,
          view,
          connection: 'connected',
          transport: 'host.sock',
          links: {},
          trigger: (props, here) => createElement('button', { ...props, 'data-trigger': '' }, here.title),
        }),
      )
    })
    const trigger = container.querySelector<HTMLButtonElement>('button[data-trigger]')!
    act(() => trigger.click())
    const target = container.querySelector<HTMLButtonElement>(`[data-computer-row="${remoteId}"] > button`)!
    act(() => target.click())
    act(() => target.click())
    expect(switchTo).toHaveBeenCalledExactlyOnceWith(remoteId)
    expect(open).not.toHaveBeenCalled()
    expect(target.textContent).toContain('正在切换')
    expect(target.getAttribute('aria-disabled')).toBe('true')

    await act(async () => respond({ ok: false, error: 'offline', message: '' }))
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法连接到这台电脑')
    expect(target.getAttribute('aria-disabled')).toBeNull()

    await act(async () => target.click())
    expect(switchTo).toHaveBeenCalledTimes(2)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  } finally {
    act(() => root.unmount())
    container.remove()
    delete window.latchShell
    vi.unstubAllGlobals()
  }
})

function OpenedMark({ summary }: { summary: TaskSummary }) {
  useOpenedMark(summary, true, true)
  return null
}

function SwitchDuringCommit({ summary, report }: { summary: TaskSummary; report: (active: boolean) => void }) {
  useLayoutEffect(() => {
    if (summary.status === 'failed') report(false)
  }, [summary.status, report])
  useEffect(() => {
    if (summary.status === 'failed') report(true)
  }, [summary.status, report])
  return createElement(OpenedMark, { summary })
}

it('marks a visible failure opened only after its workspace is selected', async () => {
  let finishRead!: (value: boolean) => void
  const result = new Promise<boolean>(resolve => {
    finishRead = resolve
  })
  let reportActive!: (value: boolean) => void
  const unsubscribe = vi.fn()
  window.latchShell = {
    kind: 'electron',
    devMode: true,
    platform: 'darwin',
    computers: {
      list: async () => view,
      subscribe: () => () => {},
      open: async () => ({ ok: true }),
      isWorkspaceActive: () => result,
      subscribeWorkspaceActive: callback => {
        reportActive = callback
        return unsubscribe
      },
    },
  }
  const summary: TaskSummary = {
    id: 'session',
    harnessId: 'standard',
    title: 'Test failure',
    status: 'failed',
    updatedAt: '',
    board: { group: 'attention', reason: 'failed', settle: 'run-1' },
  }
  const receive = vi.fn(async () => Response.json({ summary }))
  const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', receive)
  const root = createRoot(document.createElement('div'))
  try {
    act(() => root.render(createElement(OpenedMark, { summary })))
    expect(receive).not.toHaveBeenCalled()

    act(() => reportActive(false))
    await act(async () => finishRead(true))
    expect(receive).not.toHaveBeenCalled()

    visible.mockReturnValue('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      reportActive(true)
    })
    expect(receive).not.toHaveBeenCalled()

    visible.mockReturnValue('visible')
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(receive).toHaveBeenCalledExactlyOnceWith(
      '/link/api/tasks/session/attend',
      expect.objectContaining({ method: 'POST', body: '{"settle":"run-1","opened":true}' }),
    )

    const report = (next: boolean) => reportActive(next)
    const update = (pending: TaskSummary) => root.render(createElement(SwitchDuringCommit, { summary: pending, report }))
    await act(async () => update({ ...summary, status: 'idle' }))
    receive.mockClear()
    await act(async () => update(summary))
    expect(receive).toHaveBeenCalledExactlyOnceWith(
      '/link/api/tasks/session/attend',
      expect.objectContaining({ method: 'POST', body: '{"settle":"run-1","opened":true}' }),
    )
  } finally {
    act(() => root.unmount())
    expect(unsubscribe).toHaveBeenCalledTimes(2)
    visible.mockRestore()
    delete window.latchShell
    vi.unstubAllGlobals()
  }
})
