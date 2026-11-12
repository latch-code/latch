import type { AppSnapshot, HarnessInfo, HistoryList, HistoryRow, HostCatalog, TaskSummary } from '@latch/protocol'
import { ApiError, ApiTimeoutError, errorMessage, isUncertain } from '../core/api.ts'
import { harnessName } from '../composerChoice.ts'

/**
 * 接入已有会话 (docs/HARNESSES.md#接入已有会话), as the page draws it: whether the new session offers it, the list's and the
 * preview's states, the Harness an import continues in, and an import whose answer may be unknown. Display only: the
 * Host checks every step again.
 */

/** A Harness of the project that lists its own earlier sessions, ready to do it. */
export interface HistorySource {
  harnessId: string
  label: string
  mark?: string | undefined
}

/**
 * The new session's entry. `hidden`: nothing to offer here (no saved project, no Harness that lists, a device that cannot
 * start sessions or a Host without it). `locked`: there is one, but this device cannot see private sessions, which an
 * imported one always is. `open`: the sources to list from.
 */
export type HistoryEntry = { kind: 'hidden' } | { kind: 'locked' } | { kind: 'open'; sources: HistorySource[] }

export function historyEntry(snapshot: Pick<AppSnapshot, 'catalog' | 'device'>, workspaceId: string | undefined): HistoryEntry {
  const catalog = snapshot.catalog
  if (!catalog || !workspaceId || workspaceId === 'default') return { kind: 'hidden' }
  if (!catalog.workspaces.some(project => project.id === workspaceId)) return { kind: 'hidden' }
  const scopes = Array.isArray(snapshot.device.scopes) ? snapshot.device.scopes : []
  if (!scopes.includes('run')) return { kind: 'hidden' }
  const sources = historySources(catalog)
  if (!sources.length) return { kind: 'hidden' }
  // The Host offers the feature only to a device that may see private sessions; the device's own word says why not.
  if (snapshot.device.dataScope !== 'all' || catalog.features?.historyImport !== 1) return { kind: 'locked' }
  return { kind: 'open', sources }
}

function historySources(catalog: Pick<HostCatalog, 'harnesses'>): HistorySource[] {
  return catalog.harnesses
    .filter(harness => harness.status === 'ready' && harness.history?.list === true)
    .map(harness => ({ harnessId: harness.id, label: harnessName(harness), mark: harness.capabilities.display.mark }))
}

/** A Harness an import can continue in: the source itself (native) or another that takes a text rebuild. */
export interface ImportTarget {
  harnessId: string
  label: string
  mark?: string | undefined
  mode: 'native' | 'text'
}

/** The source first, then every other ready Harness a rebuilt session can start on. Latch 内置 cannot wait for a first message yet. */
export function importTargets(catalog: Pick<HostCatalog, 'harnesses'>, sourceId: string): ImportTarget[] {
  const ready = catalog.harnesses.filter(harness => harness.status === 'ready')
  const source = ready.find(harness => harness.id === sourceId)
  const others = ready.filter(harness => harness.id !== sourceId && harness.history?.rebuild === true)
  return [...(source ? [source] : []), ...others].map((harness: HarnessInfo) => ({
    harnessId: harness.id,
    label: harnessName(harness),
    mark: harness.capabilities.display.mark,
    mode: harness.id === sourceId ? 'native' : 'text',
  }))
}

/**
 * A session brought in as it was whose Harness lost it (`harness-session-lost`): every ready Harness a text rebuild can
 * start on, its own first. All of them are text rebuilds.
 */
export function rebuildTargets(catalog: Pick<HostCatalog, 'harnesses'>, ownId: string | undefined): ImportTarget[] {
  return catalog.harnesses
    .filter(harness => harness.status === 'ready' && harness.history?.rebuild === true)
    .toSorted((a, b) => Number(b.id === ownId) - Number(a.id === ownId))
    .map(harness => ({
      harnessId: harness.id,
      label: harnessName(harness),
      mark: harness.capabilities.display.mark,
      mode: 'text' as const,
    }))
}

/** The session rebuilt as text from this one, if this device lists it. */
export function rebuiltFrom<T extends Pick<TaskSummary, 'id' | 'imported'>>(tasks: readonly T[], taskId: string): T | undefined {
  return tasks.find(task => task.imported?.fromTaskId === taskId)
}

// ---- The list ------------------------------------------------------------------------------------------------------

export type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; list: HistoryList }
  /** `code`: the Host's error code, for the views that say more than the message. */
  | { kind: 'failed'; message: string; code?: string | undefined }

/** What the list area shows. */
export type ListView =
  | { kind: 'loading' }
  | { kind: 'empty'; otherFolders: number }
  | { kind: 'rows'; rows: HistoryRow[]; otherFolders: number; truncated: boolean }
  | { kind: 'not-supported' }
  | { kind: 'login' }
  | { kind: 'failed'; message: string }

export function listFailure(error: unknown): ListState {
  return { kind: 'failed', message: errorMessage(error), code: error instanceof ApiError ? error.code : undefined }
}

export function listView(state: ListState): ListView {
  if (state.kind === 'loading') return { kind: 'loading' }
  if (state.kind === 'failed') {
    if (state.code === 'history-not-supported') return { kind: 'not-supported' }
    if (state.code === 'agent-auth-required') return { kind: 'login' }
    return { kind: 'failed', message: state.message }
  }
  const { rows, otherFolders, truncated } = state.list
  if (!rows.length) return { kind: 'empty', otherFolders }
  return { kind: 'rows', rows, otherFolders, truncated }
}

/** Where a row's session started, relative to the project's primary folder: nothing for the folder itself. */
export function rowFolder(row: Pick<HistoryRow, 'subdir'>): string | undefined {
  return row.subdir ? `${row.subdir.replace(/\/+$/u, '')}/` : undefined
}

// ---- The preview ---------------------------------------------------------------------------------------------------

export type PreviewFailure = { kind: 'busy' } | { kind: 'expired' } | { kind: 'failed'; message: string }

/** `history-session-busy`: the session is open elsewhere (a terminal, say). Latch never takes it over. */
export function previewFailure(error: unknown): PreviewFailure {
  if (error instanceof ApiError && error.code === 'history-session-busy') return { kind: 'busy' }
  if (error instanceof ApiError && error.code === 'history-handle-expired') return { kind: 'expired' }
  return { kind: 'failed', message: errorMessage(error) }
}

// ---- The import ----------------------------------------------------------------------------------------------------

/** One import as sent: a retry sends exactly this again, with the same `requestId`. `source`: the preview or the lost session. */
export interface ImportAttempt {
  requestId: string
  source: string
  harnessId: string
}

/** The request for this source and Harness: the unanswered one again when it matches, a new one otherwise. */
export function importAttempt(
  previous: ImportAttempt | null,
  source: string,
  harnessId: string,
  newId: () => string = () => crypto.randomUUID(),
): ImportAttempt {
  if (previous && previous.source === source && previous.harnessId === harnessId) return previous
  return { requestId: newId(), source, harnessId }
}

export type ImportOutcome =
  /** Brought in, or brought in before (`history-already-imported`): open that session. */
  | { kind: 'open'; taskId: string }
  /** No answer: the Host may have done it; retry with the same request. */
  | { kind: 'unknown' }
  /** The preview's process is gone: the request cannot be answered from it any more. */
  | { kind: 'expired' }
  | { kind: 'busy' }
  | { kind: 'failed'; message: string }

export function importOutcome(error: unknown): ImportOutcome {
  if (error instanceof ApiError) {
    if (error.code === 'history-already-imported' && typeof error.details.taskId === 'string')
      return { kind: 'open', taskId: error.details.taskId }
    if (error.code === 'history-session-busy') return { kind: 'busy' }
    if (error.code === 'history-handle-expired') return { kind: 'expired' }
  }
  if (error instanceof ApiTimeoutError || isUncertain(error)) return { kind: 'unknown' }
  return { kind: 'failed', message: errorMessage(error) }
}

// ---- The session ---------------------------------------------------------------------------------------------------

/** The header's mark of a session brought in: 「已接入」, and 「按文字重建」 when it was rebuilt as text. */
export function importedMark(
  summary: Pick<TaskSummary, 'imported'>,
  sourceLabel: string | undefined,
): { label: string; detail: string; rebuilt: boolean } | undefined {
  const imported = summary.imported
  if (!imported) return undefined
  const from = sourceLabel ?? imported.from
  return imported.mode === 'native'
    ? { label: '已接入', detail: `从 ${from} 接入 · 原样加载`, rebuilt: false }
    : { label: '已接入 · 按文字重建', detail: `从 ${from} 接入 · 按文字重建，不是原样恢复`, rebuilt: true }
}

/** A text rebuild whose rebuilt conversation still waits for the first message: sending it sends that text too. */
export function seedWaiting(summary: Pick<TaskSummary, 'imported'>, messages: ReadonlyArray<{ role: string }>): boolean {
  return (
    summary.imported?.mode === 'text' && summary.imported.prefixLength !== undefined && !messages.some(message => message.role === 'user')
  )
}
