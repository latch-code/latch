import { testHarness } from '@latch/testkit'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot, HostCatalog, TaskSummary } from '@latch/protocol'
import { ApiError, ApiTimeoutError } from '../src/core/api.ts'
import {
  historyEntry,
  importAttempt,
  importedMark,
  importOutcome,
  importTargets,
  listFailure,
  listView,
  previewFailure,
  rebuildTargets,
  rebuiltFrom,
  rowFolder,
  seedWaiting,
} from '../src/history/model.ts'

const codex = { ...testHarness('codex', { label: 'Codex' }), history: { list: true as const, rebuild: true as const } }
const fake = { ...testHarness('fake', { label: 'Fake' }), history: { rebuild: true as const } }
const builtin = testHarness('standard', { kind: 'builtin', label: 'Latch 内置' })

function snapshotWith(
  options: { harnesses?: HostCatalog['harnesses']; scope?: 'all' | 'work'; scopes?: string[]; feature?: boolean } = {},
): Pick<AppSnapshot, 'catalog' | 'device'> {
  return {
    catalog: {
      harnesses: options.harnesses ?? [codex, fake, builtin],
      workspaces: [
        { id: 'default', name: '无项目', path: '/home' },
        { id: 'shop', name: 'Shop', path: '/work/shop' },
      ],
      features: options.feature === false ? {} : { historyImport: 1 },
    } as unknown as HostCatalog,
    device: { scopes: options.scopes ?? ['view', 'run'], dataScope: options.scope ?? 'all' } as unknown as AppSnapshot['device'],
  }
}

describe('接入已有会话 on the new-session page', () => {
  it('offers the entry only in a saved project with a ready Harness that lists, to a device that can start sessions', () => {
    expect(historyEntry(snapshotWith(), 'shop')).toEqual({ kind: 'open', sources: [{ harnessId: 'codex', label: 'Codex', mark: 'codex' }] })
    expect(historyEntry(snapshotWith(), 'default').kind).toBe('hidden')
    expect(historyEntry(snapshotWith(), undefined).kind).toBe('hidden')
    expect(historyEntry(snapshotWith(), 'gone').kind).toBe('hidden')
    expect(historyEntry(snapshotWith({ harnesses: [fake, builtin] }), 'shop').kind).toBe('hidden')
    expect(historyEntry(snapshotWith({ harnesses: [{ ...codex, status: 'unavailable' }] }), 'shop').kind).toBe('hidden')
    expect(historyEntry(snapshotWith({ scopes: ['view'] }), 'shop').kind).toBe('hidden')
  })

  it('shows it locked to a device that cannot see private sessions, or that the Host did not offer it to', () => {
    expect(historyEntry(snapshotWith({ scope: 'work' }), 'shop').kind).toBe('locked')
    expect(historyEntry(snapshotWith({ feature: false }), 'shop').kind).toBe('locked')
  })

  it('continues in the source first, then in any other Harness that takes a text rebuild, never in Latch 内置', () => {
    expect(importTargets({ harnesses: [builtin, fake, codex] }, 'codex')).toEqual([
      { harnessId: 'codex', label: 'Codex', mark: 'codex', mode: 'native' },
      { harnessId: 'fake', label: 'Fake', mark: 'fake', mode: 'text' },
    ])
    expect(importTargets({ harnesses: [codex, { ...fake, status: 'unavailable' }] }, 'codex').map(target => target.harnessId)).toEqual([
      'codex',
    ])
  })
})

describe('the list', () => {
  const list = { rows: [{ handle: 'hh_1', title: 'A', subdir: '' }], otherFolders: 2, scanned: 3, truncated: false }

  it('says loading, empty, the rows with the other folders counted, and each failure for what it is', () => {
    expect(listView({ kind: 'loading' })).toEqual({ kind: 'loading' })
    expect(listView({ kind: 'ready', list: { ...list, rows: [] } })).toEqual({ kind: 'empty', otherFolders: 2 })
    expect(listView({ kind: 'ready', list })).toEqual({ kind: 'rows', rows: list.rows, otherFolders: 2, truncated: false })
    // Sessions left out for holding folder grants of their own are counted, with or without rows; none is no line.
    expect(listView({ kind: 'ready', list: { ...list, withheld: 3 } })).toMatchObject({ kind: 'rows', withheld: 3 })
    expect(listView({ kind: 'ready', list: { ...list, rows: [], withheld: 1 } })).toEqual({ kind: 'empty', otherFolders: 2, withheld: 1 })
    expect(listView({ kind: 'ready', list: { ...list, withheld: 0 } })).not.toHaveProperty('withheld')
    const refused = (code: string) => listFailure(new ApiError(409, code, '原文'))
    expect(listView(refused('history-not-supported'))).toEqual({ kind: 'not-supported' })
    expect(listView(refused('agent-auth-required'))).toEqual({ kind: 'login' })
    expect(listView(refused('harness-unavailable'))).toEqual({ kind: 'failed', message: '原文' })
    expect(listView(listFailure(new TypeError('fetch failed'))).kind).toBe('failed')
  })

  it('names the folder a row started in relative to the primary folder', () => {
    expect(rowFolder({ subdir: '' })).toBeUndefined()
    expect(rowFolder({ subdir: 'web' })).toBe('web/')
    expect(rowFolder({ subdir: 'web/app/' })).toBe('web/app/')
  })
})

describe('the preview and the import', () => {
  it('reads a session open elsewhere as busy and offers no takeover', () => {
    expect(previewFailure(new ApiError(409, 'history-session-busy', '…'))).toEqual({ kind: 'busy' })
    expect(previewFailure(new ApiError(410, 'history-handle-expired', '…'))).toEqual({ kind: 'expired' })
    expect(previewFailure(new ApiError(409, 'workspace-unavailable', '找不到所选项目'))).toEqual({
      kind: 'failed',
      message: '找不到所选项目',
    })
  })

  it('sends a retry with the same requestId, and a new one for another preview or Harness', () => {
    let next = 0
    const id = () => `req-${++next}`
    const first = importAttempt(null, 'hp_a', 'codex', id)
    expect(first).toEqual({ requestId: 'req-1', source: 'hp_a', harnessId: 'codex' })
    expect(first.requestId).toBe('req-1')
    expect(importAttempt(first, 'hp_a', 'codex', id)).toBe(first)
    expect(importAttempt(first, 'hp_a', 'fake', id).requestId).toBe('req-2')
    expect(importAttempt(first, 'hp_b', 'codex', id).requestId).toBe('req-3')
  })

  it('opens the session an earlier import made, keeps an unanswered one unknown, and says a refusal', () => {
    expect(importOutcome(new ApiError(409, 'history-already-imported', '…', { taskId: 'task-1' }))).toEqual({
      kind: 'open',
      taskId: 'task-1',
    })
    expect(importOutcome(new ApiTimeoutError())).toEqual({ kind: 'unknown' })
    expect(importOutcome(new TypeError('fetch failed'))).toEqual({ kind: 'unknown' })
    expect(importOutcome(new ApiError(502, 'bad-gateway', '…'))).toEqual({ kind: 'unknown' })
    expect(importOutcome(new ApiError(409, 'history-session-busy', '…'))).toEqual({ kind: 'busy' })
    expect(importOutcome(new ApiError(410, 'history-handle-expired', '…'))).toEqual({ kind: 'expired' })
    expect(importOutcome(new ApiError(409, 'history-not-supported', 'Latch 内置 还不能按文字接入。'))).toEqual({
      kind: 'failed',
      message: 'Latch 内置 还不能按文字接入。',
    })
  })
})

describe('a session brought in', () => {
  it('is marked 已接入, and 按文字重建 when it was rebuilt as text', () => {
    expect(importedMark({}, 'Codex')).toBeUndefined()
    expect(importedMark({ imported: { from: 'codex', mode: 'native' } }, 'Codex')).toEqual({
      label: '已接入',
      detail: '从 Codex 接入 · 原样加载',
      rebuilt: false,
    })
    expect(importedMark({ imported: { from: 'codex', mode: 'text', prefixLength: 10 } }, undefined)).toMatchObject({
      label: '已接入 · 按文字重建',
      detail: '从 codex 接入 · 按文字重建，不是原样恢复',
      rebuilt: true,
    })
  })

  it('says the rebuilt text goes with the first message only while none was sent', () => {
    const text: Pick<TaskSummary, 'imported'> = { imported: { from: 'codex', mode: 'text', prefixLength: 120 } }
    expect(seedWaiting(text, [])).toBe(true)
    expect(seedWaiting(text, [{ role: 'user' }])).toBe(false)
    expect(seedWaiting({ imported: { from: 'codex', mode: 'text' } }, [])).toBe(false)
    expect(seedWaiting({ imported: { from: 'codex', mode: 'native' } }, [])).toBe(false)
  })
})

describe('a session its Harness lost', () => {
  it('rebuilds only as text, on any ready Harness that takes it, its own first', () => {
    expect(rebuildTargets({ harnesses: [fake, builtin, codex] }, 'codex')).toEqual([
      { harnessId: 'codex', label: 'Codex', mark: 'codex', mode: 'text' },
      { harnessId: 'fake', label: 'Fake', mark: 'fake', mode: 'text' },
    ])
    expect(rebuildTargets({ harnesses: [{ ...fake, status: 'unavailable' }, builtin] }, 'codex')).toEqual([])
  })

  it('finds the session rebuilt from it, which makes it read-only with a link', () => {
    const tasks = [
      { id: 'a', imported: { from: 'codex', mode: 'native' as const } },
      { id: 'b', imported: { from: 'codex', mode: 'text' as const, fromTaskId: 'a' } },
    ]
    expect(rebuiltFrom(tasks, 'a')?.id).toBe('b')
    expect(rebuiltFrom(tasks, 'b')).toBeUndefined()
  })
})
