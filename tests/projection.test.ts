import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiTimeoutError } from '../src/client/api.ts'
import { mergeTaskSnapshot, parseTaskState, ProjectionGuard } from '../src/client/projection.ts'
import type { AppSnapshot, CurrentDevice, HostView, TaskDetail } from '../src/shared/types.ts'

const device: CurrentDevice = {
  id: 'dev_owner', name: 'Owner', status: 'active', listener: 'loopback-tcp', scopes: ['view', 'run', 'approve:standard', 'admin'], dataScope: 'work',
  fingerprint: 'ABCD EFGH IJKL MNOP QRST', createdAt: '', lastSeenAt: '', credentialExpiresAt: '', pairedBy: { method: 'lpc' }, current: true, renewAfter: '',
}
const host: HostView = { hostId: 'h', devMode: true, presence: { status: 'available' }, tls: null, policy: { localMaxLevel: 'L2', remoteMaxLevel: 'L1', allowL3: true } }

function detail(id: string, revision: number, instanceId = 'host'): TaskDetail {
  return { summary: { id, title: id, status: 'running', updatedAt: '2026-01-01' }, messages: [], approvals: [], liveText: `${revision}`, cursor: 1, sync: { instanceId, revision } }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('authoritative stream projection', () => {
  it('rejects older revisions, old Host instances and old selection generations, including A → B → A', () => {
    const guard = new ProjectionGuard()
    guard.bind('host'); guard.select('A')
    const original = guard.capture()
    expect(guard.accept(original, detail('A', 20))).toBe(true)
    expect(guard.accept(original, detail('A', 19))).toBe(false)
    expect(guard.accept(original, detail('B', 30))).toBe(false)
    guard.select('B'); guard.select('A')
    expect(guard.accept(original, detail('A', 40))).toBe(false)
    const current = guard.capture()
    expect(guard.accept(current, detail('A', 40))).toBe(true)
    guard.bind('restarted')
    expect(guard.accept(current, detail('A', 50))).toBe(false)
    expect(guard.accept(guard.capture(), detail('A', 50))).toBe(false)
    expect(guard.accept(guard.capture(), detail('A', 1, 'restarted'))).toBe(true)
  })

  it('preserves the newer selected summary and approvals when an older full snapshot arrives', () => {
    const newest = detail('A', 20)
    newest.summary.status = 'waiting-approval'
    newest.approvals = [{ id: 'approval', sessionId: 'A', toolName: 'write', reason: 'write', requestedAt: 'today' }]
    const snapshot: AppSnapshot = { instanceId: 'host', revision: 10, device, host, tasks: [detail('A', 10).summary, detail('B', 10).summary], approvals: [], demo: false, hostName: 'node' }
    const merged = mergeTaskSnapshot(snapshot, newest)
    expect(merged.tasks.find(task => task.id === 'A')?.status).toBe('waiting-approval')
    expect(merged.tasks.find(task => task.id === 'B')).toEqual(snapshot.tasks[1])
    expect(merged.approvals).toEqual(newest.approvals)
    expect(mergeTaskSnapshot({ ...snapshot, revision: 30 }, newest).approvals).toEqual([])
  })

  it('never revives stale approval summaries when delayed SSE trails a newer HTTP snapshot', () => {
    const guard = new ProjectionGuard()
    guard.bind('host'); guard.select('A')
    const ticket = guard.capture()
    expect(guard.accept(ticket, detail('A', 19))).toBe(true)
    const delayed = detail('A', 20)
    delayed.summary.status = 'waiting-approval'
    delayed.approvals = [{ id: 'old', sessionId: 'A', toolName: 'write', reason: 'write', requestedAt: 'today' }]
    const summary = { ...detail('A', 30).summary, status: 'idle' as const }
    const snapshot: AppSnapshot = { instanceId: 'host', revision: 30, device, host, tasks: [summary], approvals: [], demo: false, hostName: 'node' }
    // The detail is newer than the previous detail, but older than the summary.
    expect(guard.accept(ticket, delayed, 'stream')).toBe(true)
    expect(mergeTaskSnapshot(snapshot, delayed)).toEqual(snapshot)
  })

  it('lets a streamed detail win equal-revision ties without a late HTTP snapshot or detail undoing it', () => {
    const guard = new ProjectionGuard()
    guard.bind('host'); guard.select('A')
    const ticket = guard.capture()
    const earlier = detail('A', 20)
    expect(guard.accept(ticket, earlier, 'http')).toBe(true)
    const streamed = { ...earlier, liveText: 'new streamed text' }
    streamed.approvals = [{ id: 'approval', sessionId: 'A', toolName: 'write', reason: 'write', requestedAt: 'today' }]
    expect(guard.accept(ticket, streamed, 'stream')).toBe(true)
    expect(guard.accept(ticket, earlier, 'http')).toBe(false)
    expect(guard.accept(ticket, earlier, 'stream')).toBe(false)
    const snapshot: AppSnapshot = { instanceId: 'host', revision: 20, device, host, tasks: [earlier.summary], approvals: [], demo: false, hostName: 'node' }
    expect(mergeTaskSnapshot(snapshot, streamed).approvals).toEqual(streamed.approvals)
    expect(mergeTaskSnapshot({ ...snapshot, revision: 21 }, streamed).approvals).toEqual([])
    guard.invalidate()
    expect(guard.accept(guard.capture(), earlier, 'http')).toBe(true)
    expect(guard.accept(ticket, streamed, 'stream')).toBe(false)
  })

  it('uses envelope revisions and rejects malformed or misrouted task-state payloads', () => {
    const event = { type: 'task-state', instanceId: 'host', revision: 12, sessionId: 'A', detail: detail('A', 2) }
    expect(parseTaskState(JSON.stringify(event))?.detail.sync?.revision).toBe(12)
    expect(parseTaskState(JSON.stringify({ ...event, sessionId: 'B' }))).toBeUndefined()
    expect(parseTaskState(JSON.stringify({ ...event, revision: -1 }))).toBeUndefined()
    expect(parseTaskState('broken')).toBeUndefined()
  })

  it('bounds API response-body waits and keeps a timed-out mutation outcome explicitly uncertain', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal!
      return { ok: true, status: 200, json: () => new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })) }
    }))
    const pending = api('tasks/A/cancel', { method: 'POST', timeoutMs: 200 })
    const rejected = expect(pending).rejects.toBeInstanceOf(ApiTimeoutError)
    await vi.advanceTimersByTimeAsync(200)
    await rejected
    expect(signal?.aborted).toBe(true)
    expect(new ApiTimeoutError().message).toContain('执行端可能仍在处理')
    expect(vi.getTimerCount()).toBe(0)
  })
})
