import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TaskDetail, WorkspaceInfo } from '@latch/protocol'
import { WorkspaceRecovery } from '../src/composer/WorkspaceRecovery.tsx'
import { recoveryMessage, recoveryWorkspaces, workspaceRecovery, type WorkspaceRecoveryInput } from '../src/composer/workspaceRecovery.ts'

const project: WorkspaceInfo = { id: 'target', name: 'New project', path: '/projects/new' }
const source = (): TaskDetail => ({
  summary: { id: 'old-task', title: 'Original', status: 'failed', updatedAt: '', workspaceId: 'removed', cwd: '/missing/old' },
  messages: [
    { id: 'user', role: 'user', text: 'Keep this history' },
    { id: 'answer', role: 'assistant', text: 'Settled answer', state: 'completed' },
  ],
  approvals: [],
  liveText: '',
  cursor: 1,
})
const input = (): WorkspaceRecoveryInput => ({
  source: source(),
  workspaces: [project],
  workspaceId: project.id,
  forkSupported: true,
  runGate: { allowed: true },
  local: true,
  phase: 'idle',
})

describe('workspace recovery', () => {
  it('prepares only the explicit project and settled boundary, without changing or copying the source', () => {
    const value = input()
    const before = structuredClone(value)
    expect(workspaceRecovery(value).intent).toEqual({ taskId: 'old-task', upToMessageId: 'answer', workspaceId: 'target' })
    expect(value).toEqual(before)
    expect(workspaceRecovery({ ...value, workspaceId: 'removed' }).intent).toBeUndefined()
    expect(workspaceRecovery({ ...value, workspaceId: undefined }).intent).toBeUndefined()
    expect(workspaceRecovery({ ...value, workspaces: [] }).blockedReason).toContain('没有可用项目')
  })

  it('never resets an unknown or busy submission into a new task', () => {
    for (const phase of ['unknown', 'busy'] as const) {
      const state = workspaceRecovery({ ...input(), phase })
      expect(state.intent).toBeUndefined()
      expect(state.blockedReason).toContain(phase === 'unknown' ? '原请求' : '原会话')
    }
    for (const status of ['running', 'waiting-approval'] as const)
      expect(workspaceRecovery({ ...input(), source: { ...source(), summary: { ...source().summary, status } } }).intent).toBeUndefined()
    expect(workspaceRecovery({ ...input(), source: { ...source(), activity: { phase: 'cancelling' } } }).intent).toBeUndefined()
  })

  it('uses actual Host support and the caller-supplied new-task permission gate', () => {
    expect(workspaceRecovery({ ...input(), forkSupported: false }).intent).toBeUndefined()
    const state = workspaceRecovery({ ...input(), runGate: { allowed: false, reason: 'Actual device or Harness gate' } })
    expect(state.intent).toBeUndefined()
    expect(state.blockedReason).toBe('Actual device or Harness gate')
  })

  it('retains only an ended assistant boundary before any unsettled prefix, including legacy historical messages', () => {
    const value = source()
    value.messages[1]!.state = undefined
    expect(recoveryMessage(value)).toBe('answer')
    value.messages.push(
      { id: 'later', role: 'user', text: 'Not settled', state: 'queued' },
      { id: 'partial', role: 'assistant', text: 'Partial', state: 'running' },
    )
    expect(recoveryMessage(value)).toBe('answer')
    value.messages[0]!.state = 'awaiting-approval'
    expect(recoveryMessage(value)).toBeUndefined()
    expect(workspaceRecovery({ ...input(), source: value }).intent).toBeUndefined()
    expect(recoveryMessage({ ...source(), messages: [{ id: 'only', role: 'user', text: 'No answer yet' }] })).toBeUndefined()
  })

  it('rechecks every target against availability, remote start and the actual Harness folder limit', () => {
    const workspaces: WorkspaceInfo[] = [
      project,
      { ...project, id: 'default' },
      { ...project, id: 'disabled', unavailable: 'Missing' },
      { ...project, id: 'folder-missing', folders: [{ id: 'a', path: '/a', unavailable: 'Missing' }] },
      { ...project, id: 'local', remoteStart: false },
      {
        ...project,
        id: 'two',
        folders: [
          { id: 'a', path: '/a' },
          { id: 'b', path: '/b' },
        ],
      },
    ]
    const value = { workspaces, local: false, harness: { name: 'Limited', projectFolders: { access: 'all' as const, max: 1 } } }
    expect(recoveryWorkspaces(value).map(item => item.id)).toEqual(['target'])
    expect(recoveryWorkspaces({ ...value, local: true }).map(item => item.id)).toEqual(['target', 'local'])
    expect(
      recoveryWorkspaces({ ...value, harness: { name: 'Primary', projectFolders: { access: 'primary' } } }).map(item => item.id),
    ).toEqual(['target', 'two'])
    expect(workspaceRecovery({ ...input(), workspaces: [{ ...project, unavailable: 'Removed after selection' }] }).intent).toBeUndefined()
  })

  it('explains history and draft retention and keeps the unavailable action readable', () => {
    const onFork = vi.fn()
    const render = (value: WorkspaceRecoveryInput) =>
      renderToStaticMarkup(
        createElement(WorkspaceRecovery, {
          ...value,
          onWorkspaceChange: vi.fn(),
          onFork,
        }),
      )
    const html = render(input())
    expect(html).toContain('找不到了')
    expect(html).toContain('在新会话中继续')
    expect(html).toContain('New project')
    const blocked = render({ ...input(), phase: 'unknown' })
    expect(blocked).toContain('aria-disabled="true"')
    expect(blocked).toContain('role="status"')
    expect(blocked).toContain('原请求')
    expect(onFork).not.toHaveBeenCalled()
  })

  it('escapes project text and exposes hidden direction characters instead of changing the visible target', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceRecovery, {
        ...input(),
        workspaces: [{ ...project, name: '<script>\u202Eproject' }],
        onWorkspaceChange() {},
        onFork() {},
      }),
    )
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('\u202E')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('\\u{202E}')
  })
})
